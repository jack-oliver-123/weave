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
  let serverReady!: Promise<void>;
  const server = createServer((socket) => {
    serverReady = acceptAuthenticatedConnection(socket, input, serverState);
  });
  await listen(server, input.endpoint.address);
  if (input.endpoint.transport === 'unix_socket') await chmod(input.endpoint.address, 0o600);
  server.unref();

  const socket = createConnection(input.endpoint.address);
  await onceConnected(socket);
  const hostChallenge = randomUUID();
  writeLine(socket, {
    type: 'host_hello',
    identity: input.hostIdentity.identity,
    publicKey: input.hostIdentity.publicKey,
    challenge: hostChallenge,
  });
  const challenge = await readLine(socket) as {
    type: 'supervisor_challenge';
    identity: string;
    publicKey: string;
    challenge: string;
    proof: ReturnType<EphemeralRunnerIdentity['prove']>;
  };
  if (challenge.type !== 'supervisor_challenge') throw new Error('RUNNER_HANDSHAKE_PROTOCOL_ERROR');
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
  const ready = await readLine(socket) as { type: string };
  if (ready.type !== 'ready') throw new Error('RUNNER_HANDSHAKE_PROTOCOL_ERROR');
  await serverReady;

  const peer = new RpcPeer(socket);
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
      }) as { taskRef: string };
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
      return await this.peer.request('execute', { taskRef, operationId, request }) as ToolCallResult;
    } finally {
      signal.removeEventListener('abort', abort);
      this.workerStartHooks.delete(operationId);
    }
  }

  async closeTask(taskRef: string, reason: string): Promise<void> {
    const result = await this.peer.request('close_task', { taskRef, reason }) as { auditRef: string };
    this.audits.delete(result.auditRef);
  }

  async appendAudit(params: unknown): Promise<void> {
    const value = params as { auditRef: string; records: readonly SecurityAuditRecord[] };
    const audit = this.audits.get(value.auditRef);
    if (audit === undefined) throw new Error('RUNNER_AUDIT_CHANNEL_INVALID');
    await audit.append(value.records);
  }

  workerStarted(params: unknown): void {
    const operationId = (params as { operationId?: unknown }).operationId;
    if (typeof operationId === 'string') this.workerStartHooks.get(operationId)?.();
  }

  async dispose(): Promise<void> {
    this.peer.close();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error === undefined ? resolve() : reject(error)));
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
      const value = params as { auditRef: string; input: Omit<SupervisorTaskInput, 'audit'> };
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
      const value = params as { taskRef: string; operationId: string; request: AuthorizedActionRequest };
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
      const value = params as { taskRef: string; reason: string };
      const entry = this.tasks.get(value.taskRef);
      if (entry === undefined) throw new Error('RUNNER_TASK_REF_INVALID');
      this.tasks.delete(value.taskRef);
      await entry.task.close(value.reason);
      return { auditRef: entry.auditRef };
    });
    peer.onEvent('cancel', (params) => {
      const operationId = (params as { operationId?: unknown }).operationId;
      if (typeof operationId === 'string') this.operations.get(operationId)?.abort(new Error('TURN_CANCELLED'));
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
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(reason: unknown): void }>();
  private readonly handlers = new Map<string, RpcHandler>();
  private readonly events = new Map<string, (params: unknown) => void>();
  private buffer = '';
  private disconnected = false;

  constructor(private readonly socket: Socket, private readonly onDisconnect?: () => void) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('error', (error) => this.fail(error));
    socket.on('close', () => this.fail(new Error('RUNNER_CONTROL_CHANNEL_CLOSED')));
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      writeLine(this.socket, { id, method, params });
    });
  }

  notify(event: string, params: unknown): void { writeLine(this.socket, { event, params }); }
  handle(method: string, handler: RpcHandler): void { this.handlers.set(method, handler); }
  onEvent(event: string, handler: (params: unknown) => void): void { this.events.set(event, handler); }
  close(): void { this.socket.destroy(); }

  private receive(chunk: string): void {
    this.buffer += chunk;
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) void this.dispatch(JSON.parse(line) as RpcEnvelope);
    }
  }

  private async dispatch(message: RpcEnvelope): Promise<void> {
    if ('replyTo' in message) {
      const pending = this.pending.get(message.replyTo);
      if (pending === undefined) return;
      this.pending.delete(message.replyTo);
      if (message.error === undefined) pending.resolve(message.result);
      else pending.reject(deserializeError(message.error));
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
      writeLine(this.socket, { replyTo: message.id, error: serializeError(error) });
    }
  }

  private fail(error: Error): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.onDisconnect?.();
    const failure = error instanceof SecurityIntegrityFailureError
      ? error
      : new SecurityIntegrityFailureError(
        'RUNNER_CONTROL_CHANNEL_LOST',
        'Runner control channel closed unexpectedly',
        this.pending.size > 0,
      );
    for (const pending of this.pending.values()) pending.reject(failure);
    this.pending.clear();
  }
}

async function acceptAuthenticatedConnection(
  socket: Socket,
  input: OpenRunnerControlChannelInput,
  state: RunnerControlServer,
): Promise<void> {
  const hello = await readLine(socket) as { type: string; identity: string; publicKey: string; challenge: string };
  if (
    hello.type !== 'host_hello'
    || hello.identity !== input.hostIdentity.identity
    || hello.publicKey !== input.hostIdentity.publicKey
  ) throw new Error('RUNNER_HANDSHAKE_IDENTITY_MISMATCH');
  const supervisorChallenge = randomUUID();
  const supervisorProof = input.supervisorIdentity.prove('supervisor', hello.challenge);
  writeLine(socket, {
    type: 'supervisor_challenge',
    identity: input.supervisorIdentity.identity,
    publicKey: input.supervisorIdentity.publicKey,
    challenge: supervisorChallenge,
    proof: supervisorProof,
  });
  const response = await readLine(socket) as { type: string; proof: ReturnType<EphemeralRunnerIdentity['prove']> };
  if (response.type !== 'host_proof') throw new Error('RUNNER_HANDSHAKE_PROTOCOL_ERROR');
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
  writeLine(socket, { type: 'ready' });
  state.attach(new RpcPeer(socket, () => { void state.failClosed(); }));
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => { server.off('error', reject); resolve(); });
  });
}

function onceConnected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
}

function writeLine(socket: Socket, value: unknown): void { socket.write(`${JSON.stringify(value)}\n`); }

function readLine(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      cleanup();
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { socket.off('data', onData); socket.off('error', onError); };
    socket.on('data', onData);
    socket.on('error', onError);
  });
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
