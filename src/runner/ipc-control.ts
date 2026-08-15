import { chmod, unlink } from 'node:fs/promises';
import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { SecurityAuditRecord, SecurityAuditTaskResource } from '../security/audit.js';
import { SecurityIntegrityFailureError } from '../security/authorization.js';
import type { ToolCallResult } from '../shared/types.js';
import type { RunnerSupervisorControl, SupervisorTaskControl } from './action-runner.js';
import {
  authenticateRunnerSession,
  type AuthenticatedRunnerSession,
  type EphemeralRunnerIdentity,
  type LocalIpcEndpoint,
  type RunnerHandshakeProof,
  verifyRunnerHandshake,
} from './protocol.js';
import type { AuthorizedActionRequest, RunnerSupervisor, SupervisorTaskInput } from './supervisor.js';

interface RpcRequest { readonly id: string; readonly method: string; readonly params: unknown }
interface RpcResponse { readonly replyTo: string; readonly result?: unknown; readonly error?: SerializedError }
interface RpcEvent { readonly event: string; readonly params: unknown }
type RpcEnvelope = RpcRequest | RpcResponse | RpcEvent;

interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly effectsMayHaveOccurred?: boolean;
}

type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export const MAX_RUNNER_IPC_FRAME_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const RPC_TIMEOUT_MS = 30_000;

export interface OpenRunnerControlChannelInput {
  readonly endpoint: LocalIpcEndpoint;
  readonly expectedOwner: string;
  readonly hostIdentity: EphemeralRunnerIdentity;
  readonly supervisorIdentity: EphemeralRunnerIdentity;
  readonly createSupervisor: (session: AuthenticatedRunnerSession) => RunnerSupervisor;
}

export interface IpcRunnerSupervisorControl extends RunnerSupervisorControl {
  dispose(): Promise<void>;
}

export async function openRunnerControlChannel(input: OpenRunnerControlChannelInput): Promise<IpcRunnerSupervisorControl> {
  const serverState = new RunnerControlServer(input.createSupervisor);
  let accepted = false;
  let resolveServerReady!: () => void;
  let rejectServerReady!: (reason: unknown) => void;
  const serverReady = new Promise<void>((resolve, reject) => {
    resolveServerReady = resolve;
    rejectServerReady = reject;
  });
  const server = createServer((socket) => {
    if (accepted) { socket.destroy(); return; }
    accepted = true;
    void acceptAuthenticatedConnection(socket, input, serverState, server).then(resolveServerReady, rejectServerReady);
  });
  await listen(server, input.endpoint);
  if (input.endpoint.transport === 'unix_socket') await chmod(input.endpoint.address, 0o600);
  server.unref();

  const socket = createConnection(input.endpoint.address);
  const frames = new FramedSocket(socket);
  try {
    await onceConnected(socket);
    const hostChallenge = randomUUID();
    writeLine(socket, {
      type: 'host_hello',
      identity: input.hostIdentity.identity,
      publicKey: input.hostIdentity.publicKey,
      challenge: hostChallenge,
    });
    const challenge = parseSupervisorChallenge(await frames.read());
    verifyRunnerHandshake(challenge.proof, {
      role: 'supervisor',
      identity: input.supervisorIdentity.identity,
      challenge: hostChallenge,
      publicKey: input.supervisorIdentity.publicKey,
    });
    writeLine(socket, {
      type: 'host_proof',
      proof: input.hostIdentity.prove('host', challenge.challenge),
    });
    parseReady(await frames.read());
    await serverReady;
  } catch (error) {
    frames.close();
    if (server.listening) server.close();
    void serverReady.catch(() => undefined);
    throw error;
  }

  const peer = new RpcPeer(socket, undefined, frames);
  const control = new IpcRunnerSupervisor(peer, input.supervisorIdentity.identity, server, input.endpoint);
  peer.handle('audit_append', async (params) => control.appendAudit(params));
  peer.onEvent('worker_start', (params) => control.workerStarted(params));
  socket.unref();
  return control;
}

class IpcRunnerSupervisor implements IpcRunnerSupervisorControl {
  private readonly audits = new Map<string, SecurityAuditTaskResource>();
  private readonly workerStartHooks = new Map<string, () => void>();

  constructor(
    private readonly peer: RpcPeer,
    readonly runnerId: string,
    private readonly server: Server,
    private readonly endpoint: LocalIpcEndpoint,
  ) {}

  async openTask(input: SupervisorTaskInput): Promise<SupervisorTaskControl> {
    const auditRef = randomUUID();
    this.audits.set(auditRef, input.audit);
    try {
      const result = await this.peer.request('open_task', {
        auditRef,
        input: { ...input, audit: undefined },
      }, parseTaskRef);
      return new IpcSupervisorTask(this, result.taskRef);
    } catch (error) {
      this.audits.delete(auditRef);
      throw error;
    }
  }

  async execute(
    taskRef: string,
    request: AuthorizedActionRequest,
    signal: AbortSignal,
    onWorkerStart?: () => void,
  ): Promise<ToolCallResult> {
    const operationId = randomUUID();
    if (onWorkerStart !== undefined) this.workerStartHooks.set(operationId, onWorkerStart);
    const abort = () => this.peer.notify('cancel', { operationId });
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    try {
      return await this.peer.request('execute', { taskRef, operationId, request }, (value) => parseToolCallResult(value, request.call));
    } finally {
      signal.removeEventListener('abort', abort);
      this.workerStartHooks.delete(operationId);
    }
  }

  async closeTask(taskRef: string, reason: string): Promise<void> {
    const result = await this.peer.request('close_task', { taskRef, reason }, parseAuditRef);
    this.audits.delete(result.auditRef);
  }

  async appendAudit(params: unknown): Promise<void> {
    const value = parseAuditAppendParams(params);
    const audit = this.audits.get(value.auditRef);
    if (audit === undefined) throw new Error('RUNNER_AUDIT_CHANNEL_INVALID');
    await audit.append(value.records);
  }

  workerStarted(params: unknown): void {
    const operationId = parseOperationId(params).operationId;
    this.workerStartHooks.get(operationId)?.();
  }

  async dispose(): Promise<void> {
    this.peer.close();
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => this.server.close((error) => error === undefined ? resolve() : reject(error)));
    }
    if (this.endpoint.transport === 'unix_socket') await unlink(this.endpoint.address).catch(() => undefined);
  }
}

class IpcSupervisorTask implements SupervisorTaskControl {
  constructor(private readonly owner: IpcRunnerSupervisor, private readonly taskRef: string) {}

  execute(request: AuthorizedActionRequest, signal: AbortSignal, onWorkerStart?: () => void): Promise<ToolCallResult> {
    return this.owner.execute(this.taskRef, request, signal, onWorkerStart);
  }

  close(reason: string): Promise<void> {
    return this.owner.closeTask(this.taskRef, reason);
  }
}

class RunnerControlServer {
  private supervisor: RunnerSupervisor | undefined;
  private readonly tasks = new Map<string, { task: Awaited<ReturnType<RunnerSupervisor['openTask']>>; auditRef: string }>();
  private readonly operations = new Map<string, AbortController>();
  private failClosedPromise: Promise<void> | undefined;

  constructor(private readonly createSupervisor: OpenRunnerControlChannelInput['createSupervisor']) {}

  authenticate(session: AuthenticatedRunnerSession): void {
    if (this.supervisor !== undefined) throw new Error('RUNNER_CONTROL_ALREADY_AUTHENTICATED');
    this.supervisor = this.createSupervisor(session);
  }

  attach(peer: RpcPeer): void {
    peer.handle('open_task', async (params) => {
      const value = parseOpenTaskParams(params);
      const supervisor = this.requireSupervisor();
      const audit: SecurityAuditTaskResource = {
        append: async (records) => { await peer.request('audit_append', { auditRef: value.auditRef, records }); },
        close: async () => undefined,
      };
      const task = await supervisor.openTask({ ...value.input, audit });
      const taskRef = randomUUID();
      this.tasks.set(taskRef, { task, auditRef: value.auditRef });
      return { taskRef };
    });
    peer.handle('execute', async (params) => {
      const value = parseExecuteParams(params);
      const entry = this.tasks.get(value.taskRef);
      if (entry === undefined) throw new Error('RUNNER_TASK_REF_INVALID');
      const controller = new AbortController();
      this.operations.set(value.operationId, controller);
      try {
        return await entry.task.execute(value.request, controller.signal, () => {
          peer.notify('worker_start', { operationId: value.operationId });
        });
      } finally {
        this.operations.delete(value.operationId);
      }
    });
    peer.handle('close_task', async (params) => {
      const value = parseCloseTaskParams(params);
      const entry = this.tasks.get(value.taskRef);
      if (entry === undefined) throw new Error('RUNNER_TASK_REF_INVALID');
      this.tasks.delete(value.taskRef);
      await entry.task.close(value.reason);
      return { auditRef: entry.auditRef };
    });
    peer.onEvent('cancel', (params) => {
      const operationId = parseOperationId(params).operationId;
      this.operations.get(operationId)?.abort(new Error('TURN_CANCELLED'));
    });
  }

  failClosed(): Promise<void> {
    if (this.failClosedPromise !== undefined) return this.failClosedPromise;
    for (const controller of this.operations.values()) {
      controller.abort(new SecurityIntegrityFailureError(
        'RUNNER_CONTROL_CHANNEL_LOST',
        'Runner control channel was lost while an action was active',
        true,
      ));
    }
    this.operations.clear();
    const tasks = [...this.tasks.values()];
    this.tasks.clear();
    this.failClosedPromise = Promise.allSettled(
      tasks.map(({ task }) => task.close('security_integrity_failure')),
    ).then(() => undefined);
    return this.failClosedPromise;
  }

  private requireSupervisor(): RunnerSupervisor {
    if (this.supervisor === undefined) throw new Error('RUNNER_CONTROL_NOT_AUTHENTICATED');
    return this.supervisor;
  }
}

class RpcPeer {
  private readonly pending = new Map<string, {
    resolve(value: unknown): void;
    reject(reason: unknown): void;
    timer: ReturnType<typeof setTimeout>;
    validate(value: unknown): unknown;
  }>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly events = new Map<string, (params: unknown) => void>();
  private disconnected = false;

  constructor(
    private readonly socket: Socket,
    private readonly onDisconnect?: () => void,
    private readonly frames = new FramedSocket(socket),
  ) {
    frames.start(
      (frame) => {
        let message: RpcEnvelope;
        try { message = parseRunnerRpcEnvelope(frame); }
        catch (error) { this.fail(controlProtocolError(error)); return; }
        void this.dispatch(message).catch((error: unknown) => this.fail(controlProtocolError(error)));
      },
      (error) => this.fail(error),
    );
  }

  request<T = unknown>(method: string, params: unknown, validate: (value: unknown) => T = (value) => value as T): Promise<T> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new SecurityIntegrityFailureError(
          'RUNNER_CONTROL_RPC_TIMEOUT',
          'Runner control request timed out with an unknown outcome',
          true,
        ));
      }, RPC_TIMEOUT_MS);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer, validate });
      writeLine(this.socket, { id, method, params });
    });
  }

  notify(event: string, params: unknown): void { writeLine(this.socket, { event, params }); }
  handle(method: string, handler: RpcHandler): void { this.handlers.set(method, handler); }
  onEvent(event: string, handler: (params: unknown) => void): void { this.events.set(event, handler); }
  close(): void {
    this.fail(new SecurityIntegrityFailureError(
      'RUNNER_CONTROL_CHANNEL_LOST',
      'Runner control channel was closed',
      this.pending.size > 0,
    ));
  }

  private async dispatch(message: RpcEnvelope): Promise<void> {
    if ('replyTo' in message) {
      const pending = this.pending.get(message.replyTo);
      if (pending === undefined) return;
      this.pending.delete(message.replyTo);
      clearTimeout(pending.timer);
      if (message.error === undefined) {
        try { pending.resolve(pending.validate(message.result)); }
        catch (error) {
          pending.reject(error);
          this.fail(rpcSchemaError(error));
        }
      } else pending.reject(deserializeError(message.error));
      return;
    }
    if ('event' in message) {
      this.events.get(message.event)?.(message.params);
      return;
    }
    const handler = this.handlers.get(message.method);
    if (handler === undefined) {
      writeLine(this.socket, { replyTo: message.id, error: serializeError(new Error('RUNNER_RPC_METHOD_UNKNOWN')) });
      return;
    }
    try {
      writeLine(this.socket, { replyTo: message.id, result: await handler(message.params) });
    } catch (error) {
      if (error instanceof RunnerIpcSchemaError) throw error;
      writeLine(this.socket, { replyTo: message.id, error: serializeError(error) });
    }
  }

  private fail(error: Error): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.frames.close();
    this.onDisconnect?.();
    const failure = error instanceof SecurityIntegrityFailureError
      ? error
      : new SecurityIntegrityFailureError(
        'RUNNER_CONTROL_CHANNEL_LOST',
        'Runner control channel closed unexpectedly',
        this.pending.size > 0,
      );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(failure);
    }
    this.pending.clear();
  }
}

async function acceptAuthenticatedConnection(
  socket: Socket,
  input: OpenRunnerControlChannelInput,
  state: RunnerControlServer,
  server: Server,
): Promise<void> {
  const frames = new FramedSocket(socket);
  try {
    const hello = parseHostHello(await frames.read());
    if (hello.identity !== input.hostIdentity.identity || hello.publicKey !== input.hostIdentity.publicKey) {
      throw new Error('RUNNER_HANDSHAKE_IDENTITY_MISMATCH');
    }
    const supervisorChallenge = randomUUID();
    const supervisorProof = input.supervisorIdentity.prove('supervisor', hello.challenge);
    writeLine(socket, {
      type: 'supervisor_challenge',
      identity: input.supervisorIdentity.identity,
      publicKey: input.supervisorIdentity.publicKey,
      challenge: supervisorChallenge,
      proof: supervisorProof,
    });
    const response = parseHostProof(await frames.read());
    verifyRunnerHandshake(response.proof, {
      role: 'host',
      identity: input.hostIdentity.identity,
      challenge: supervisorChallenge,
      publicKey: input.hostIdentity.publicKey,
    });
    const session = authenticateRunnerSession({
      endpoint: input.endpoint,
      expectedOwner: input.expectedOwner,
      expectedHostIdentity: input.hostIdentity.identity,
      expectedRunnerIdentity: input.supervisorIdentity.identity,
      hostProof: response.proof,
      hostPublicKey: input.hostIdentity.publicKey,
      supervisorProof,
      supervisorPublicKey: input.supervisorIdentity.publicKey,
    });
    state.authenticate(session);
    server.close();
    writeLine(socket, { type: 'ready' });
    state.attach(new RpcPeer(socket, () => { void state.failClosed(); }, frames));
  } catch (error) {
    frames.close();
    throw error;
  }
}

function listen(server: Server, endpoint: LocalIpcEndpoint): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const options = endpoint.transport === 'windows_named_pipe'
      ? { path: endpoint.address, readableAll: false, writableAll: false, exclusive: true }
      : { path: endpoint.address, exclusive: true };
    server.listen(options, () => { server.off('error', reject); resolve(); });
  });
}

function onceConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

function writeLine(socket: Socket, value: unknown): void { socket.write(`${JSON.stringify(value)}\n`); }

export class BoundedJsonFrameDecoder {
  private buffer = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = MAX_RUNNER_IPC_FRAME_BYTES) {
    if (!Number.isInteger(maxFrameBytes) || maxFrameBytes < 1) throw new TypeError('maxFrameBytes must be a positive integer');
  }

  push(chunk: Buffer): readonly unknown[] {
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
    const frames: unknown[] = [];
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.buffer.length > this.maxFrameBytes) throw new Error('RUNNER_IPC_FRAME_TOO_LARGE');
        return frames;
      }
      if (newline === 0) throw new Error('RUNNER_IPC_FRAME_INVALID');
      if (newline > this.maxFrameBytes) throw new Error('RUNNER_IPC_FRAME_TOO_LARGE');
      const encoded = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      let source: string;
      try { source = new TextDecoder('utf-8', { fatal: true }).decode(encoded); }
      catch { throw new Error('RUNNER_IPC_FRAME_INVALID_UTF8'); }
      try { frames.push(JSON.parse(source)); }
      catch { throw new Error('RUNNER_IPC_FRAME_INVALID_JSON'); }
    }
  }
}

class FramedSocket {
  private readonly decoder = new BoundedJsonFrameDecoder();
  private readonly queued: unknown[] = [];
  private waiter: { resolve(value: unknown): void; reject(reason: unknown): void; timer: ReturnType<typeof setTimeout> } | undefined;
  private frameHandler: ((frame: unknown) => void) | undefined;
  private failureHandler: ((error: Error) => void) | undefined;
  private closed = false;

  constructor(private readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of this.decoder.push(chunk)) this.deliver(frame);
      } catch (error) {
        this.fail(protocolError(error));
      }
    });
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('RUNNER_CONTROL_CHANNEL_CLOSED')));
  }

  read(timeoutMs = HANDSHAKE_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('RUNNER_CONTROL_CHANNEL_CLOSED'));
    if (this.frameHandler !== undefined || this.waiter !== undefined) return Promise.reject(new Error('RUNNER_IPC_READER_STATE_INVALID'));
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error('RUNNER_IPC_FRAME_TIMEOUT')), timeoutMs);
      timer.unref();
      this.waiter = { resolve, reject, timer };
    });
  }

  start(handler: (frame: unknown) => void, onFailure: (error: Error) => void): void {
    if (this.frameHandler !== undefined || this.waiter !== undefined) throw new Error('RUNNER_IPC_READER_STATE_INVALID');
    this.frameHandler = handler;
    this.failureHandler = onFailure;
    for (const frame of this.queued.splice(0)) handler(frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter !== undefined) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(new Error('RUNNER_CONTROL_CHANNEL_CLOSED'));
      this.waiter = undefined;
    }
    this.socket.destroy();
  }

  private deliver(frame: unknown): void {
    if (this.frameHandler !== undefined) { this.frameHandler(frame); return; }
    if (this.waiter !== undefined) {
      const waiter = this.waiter;
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
      return;
    }
    if (this.queued.length >= 32) throw new Error('RUNNER_IPC_FRAME_QUEUE_EXCEEDED');
    this.queued.push(frame);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter !== undefined) {
      clearTimeout(this.waiter.timer);
      this.waiter.reject(error);
      this.waiter = undefined;
    }
    this.failureHandler?.(error);
    this.socket.destroy();
  }
}

class RunnerIpcSchemaError extends Error {
  constructor() { super('RUNNER_RPC_SCHEMA_INVALID'); this.name = 'RunnerIpcSchemaError'; }
}

function parseTaskRef(value: unknown): { taskRef: string } {
  const result = rpcRecord(value, ['taskRef']);
  return { taskRef: rpcText(result.taskRef) };
}

function parseAuditRef(value: unknown): { auditRef: string } {
  const result = rpcRecord(value, ['auditRef']);
  return { auditRef: rpcText(result.auditRef) };
}

function parseOperationId(value: unknown): { operationId: string } {
  const result = rpcRecord(value, ['operationId']);
  return { operationId: rpcText(result.operationId) };
}

function parseAuditAppendParams(value: unknown): { auditRef: string; records: readonly SecurityAuditRecord[] } {
  const params = rpcRecord(value, ['auditRef', 'records']);
  if (!Array.isArray(params.records) || !params.records.every(isRecord)) throw new RunnerIpcSchemaError();
  return { auditRef: rpcText(params.auditRef), records: structuredClone(params.records) as unknown as SecurityAuditRecord[] };
}

function parseOpenTaskParams(value: unknown): { auditRef: string; input: Omit<SupervisorTaskInput, 'audit'> } {
  const params = rpcRecord(value, ['auditRef', 'input']);
  if (!isRecord(params.input)) throw new RunnerIpcSchemaError();
  return { auditRef: rpcText(params.auditRef), input: structuredClone(params.input) as Omit<SupervisorTaskInput, 'audit'> };
}

function parseExecuteParams(value: unknown): { taskRef: string; operationId: string; request: AuthorizedActionRequest } {
  const params = rpcRecord(value, ['taskRef', 'operationId', 'request']);
  if (!isRecord(params.request) || !isRecord(params.request.ticket) || !isRecord(params.request.call)) {
    throw new RunnerIpcSchemaError();
  }
  return {
    taskRef: rpcText(params.taskRef),
    operationId: rpcText(params.operationId),
    request: structuredClone(params.request) as unknown as AuthorizedActionRequest,
  };
}

function parseCloseTaskParams(value: unknown): { taskRef: string; reason: string } {
  const params = rpcRecord(value, ['taskRef', 'reason']);
  return { taskRef: rpcText(params.taskRef), reason: rpcText(params.reason) };
}

function parseToolCallResult(value: unknown, expected?: AuthorizedActionRequest['call']): ToolCallResult {
  const result = rpcRecord(value, ['callId', 'providerCallId', 'toolName', 'isError', 'content']);
  if (typeof result.isError !== 'boolean') throw new RunnerIpcSchemaError();
  const content = rpcRecord(result.content, ['summary', 'data', 'error'], ['data', 'error']);
  const parsed: ToolCallResult = {
    callId: rpcText(result.callId),
    providerCallId: rpcText(result.providerCallId),
    toolName: rpcText(result.toolName),
    isError: result.isError,
    content: {
      summary: rpcText(content.summary),
      ...(Object.hasOwn(content, 'data') ? { data: structuredClone(content.data) } : {}),
      ...(content.error === undefined ? {} : { error: parseToolError(content.error) }),
    },
  };
  if (expected !== undefined && (parsed.callId !== expected.callId
    || parsed.providerCallId !== expected.providerCallId || parsed.toolName !== expected.name)) {
    throw new RunnerIpcSchemaError();
  }
  return Object.freeze(parsed);
}

function parseToolError(value: unknown): NonNullable<ToolCallResult['content']['error']> {
  const error = rpcRecord(value, ['code', 'message', 'retryable', 'details'], ['details']);
  if (typeof error.retryable !== 'boolean' || (error.details !== undefined && !isRecord(error.details))) {
    throw new RunnerIpcSchemaError();
  }
  return {
    code: rpcText(error.code), message: rpcText(error.message), retryable: error.retryable,
    ...(error.details === undefined ? {} : { details: structuredClone(error.details) }),
  };
}

function rpcRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  try { return exactRecord(value, keys, optional); } catch { throw new RunnerIpcSchemaError(); }
}

function rpcText(value: unknown): string {
  try { return requiredText(value); } catch { throw new RunnerIpcSchemaError(); }
}

function rpcSchemaError(error: unknown): SecurityIntegrityFailureError {
  return new SecurityIntegrityFailureError(
    'RUNNER_CONTROL_PROTOCOL_ERROR',
    error instanceof Error ? error.message : 'Runner control protocol validation failed',
    true,
  );
}

function controlProtocolError(error: unknown): Error {
  return error instanceof RunnerIpcSchemaError ? rpcSchemaError(error) : protocolError(error);
}

function parseHostHello(value: unknown): { identity: string; publicKey: string; challenge: string } {
  const message = exactRecord(value, ['type', 'identity', 'publicKey', 'challenge']);
  if (message.type !== 'host_hello') throw new Error('RUNNER_HANDSHAKE_PROTOCOL_ERROR');
  return {
    identity: requiredText(message.identity),
    publicKey: requiredText(message.publicKey),
    challenge: requiredText(message.challenge),
  };
}

function parseSupervisorChallenge(value: unknown): {
  identity: string;
  publicKey: string;
  challenge: string;
  proof: RunnerHandshakeProof;
} {
  const message = exactRecord(value, ['type', 'identity', 'publicKey', 'challenge', 'proof']);
  if (message.type !== 'supervisor_challenge') throw new Error('RUNNER_HANDSHAKE_PROTOCOL_ERROR');
  return {
    identity: requiredText(message.identity),
    publicKey: requiredText(message.publicKey),
    challenge: requiredText(message.challenge),
    proof: parseHandshakeProof(message.proof),
  };
}

function parseHostProof(value: unknown): { proof: RunnerHandshakeProof } {
  const message = exactRecord(value, ['type', 'proof']);
  if (message.type !== 'host_proof') throw new Error('RUNNER_HANDSHAKE_PROTOCOL_ERROR');
  return { proof: parseHandshakeProof(message.proof) };
}

function parseReady(value: unknown): void {
  const message = exactRecord(value, ['type']);
  if (message.type !== 'ready') throw new Error('RUNNER_HANDSHAKE_PROTOCOL_ERROR');
}

function parseHandshakeProof(value: unknown): RunnerHandshakeProof {
  const proof = exactRecord(value, ['protocolVersion', 'role', 'identity', 'challenge', 'signature']);
  if (proof.protocolVersion !== 1 || (proof.role !== 'host' && proof.role !== 'supervisor')) {
    throw new Error('RUNNER_HANDSHAKE_PROTOCOL_ERROR');
  }
  return {
    protocolVersion: 1,
    role: proof.role,
    identity: requiredText(proof.identity),
    challenge: requiredText(proof.challenge),
    signature: requiredText(proof.signature),
  };
}

export function parseRunnerRpcEnvelope(value: unknown): RpcEnvelope {
  if (!isRecord(value)) throw new Error('RUNNER_RPC_SCHEMA_INVALID');
  if (Object.hasOwn(value, 'replyTo')) {
    const message = exactRecord(value, ['replyTo', 'result', 'error'], ['result', 'error']);
    const response: RpcResponse = { replyTo: requiredText(message.replyTo) };
    if (message.error !== undefined) return { ...response, error: parseSerializedError(message.error) };
    return Object.hasOwn(message, 'result') ? { ...response, result: message.result } : response;
  }
  if (Object.hasOwn(value, 'event')) {
    const message = exactRecord(value, ['event', 'params']);
    return { event: requiredText(message.event), params: message.params };
  }
  const message = exactRecord(value, ['id', 'method', 'params']);
  return { id: requiredText(message.id), method: requiredText(message.method), params: message.params };
}

function parseSerializedError(value: unknown): SerializedError {
  const error = exactRecord(value, ['name', 'message', 'code', 'effectsMayHaveOccurred'], ['code', 'effectsMayHaveOccurred']);
  if (error.effectsMayHaveOccurred !== undefined && typeof error.effectsMayHaveOccurred !== 'boolean') {
    throw new Error('RUNNER_RPC_SCHEMA_INVALID');
  }
  return {
    name: requiredText(error.name),
    message: requiredText(error.message),
    ...(error.code === undefined ? {} : { code: requiredText(error.code) }),
    ...(error.effectsMayHaveOccurred === undefined ? {} : { effectsMayHaveOccurred: error.effectsMayHaveOccurred }),
  };
}

function exactRecord(value: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('RUNNER_IPC_SCHEMA_INVALID');
  const allowed = new Set(keys);
  const optionalKeys = new Set(optional);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('RUNNER_IPC_SCHEMA_INVALID');
  if (keys.some((key) => !optionalKeys.has(key) && !Object.hasOwn(value, key))) throw new Error('RUNNER_IPC_SCHEMA_INVALID');
  return value;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw new Error('RUNNER_IPC_SCHEMA_INVALID');
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolError(error: unknown): Error {
  return error instanceof Error ? error : new Error('RUNNER_IPC_PROTOCOL_ERROR');
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof SecurityIntegrityFailureError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      effectsMayHaveOccurred: error.effectsMayHaveOccurred,
    };
  }
  return { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : 'Runner control request failed' };
}

function deserializeError(error: SerializedError): Error {
  if (error.name === 'SecurityIntegrityFailureError' && error.code !== undefined) {
    return new SecurityIntegrityFailureError(error.code, error.message, error.effectsMayHaveOccurred ?? false);
  }
  const restored = new Error(error.message);
  restored.name = error.name;
  return restored;
}
