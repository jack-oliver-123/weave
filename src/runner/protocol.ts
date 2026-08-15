import { generateKeyPairSync, sign, verify, createPublicKey, type KeyObject } from 'node:crypto';

export const RUNNER_PROTOCOL_VERSION = 1 as const;

export interface LocalIpcEndpoint {
  readonly protocolVersion: typeof RUNNER_PROTOCOL_VERSION;
  readonly transport: 'unix_socket' | 'windows_named_pipe';
  readonly address: string;
  readonly ownerIdentity: string;
  readonly access: 'current_user_only';
  readonly tcpListening: false;
}

export interface RunnerHandshakeProof {
  readonly protocolVersion: typeof RUNNER_PROTOCOL_VERSION;
  readonly role: 'host' | 'supervisor';
  readonly identity: string;
  readonly challenge: string;
  readonly signature: string;
}

export interface AuthenticatedRunnerSession {
  readonly protocolVersion: typeof RUNNER_PROTOCOL_VERSION;
  readonly endpoint: LocalIpcEndpoint;
  readonly hostIdentity: string;
  readonly runnerIdentity: string;
}

export class EphemeralRunnerIdentity {
  readonly #privateKey: KeyObject;
  readonly publicKey: string;

  constructor(readonly identity: string) {
    if (identity.length === 0) throw new TypeError('Runner identity must not be empty');
    const pair = generateKeyPairSync('ed25519');
    this.#privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  }

  prove(role: RunnerHandshakeProof['role'], challenge: string): RunnerHandshakeProof {
    if (challenge.length < 16) throw new TypeError('Handshake challenge is too short');
    const payload = handshakePayload(role, this.identity, challenge);
    return Object.freeze({
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      role,
      identity: this.identity,
      challenge,
      signature: sign(null, payload, this.#privateKey).toString('base64url'),
    });
  }
}

export function validateLocalIpcEndpoint(endpoint: LocalIpcEndpoint, expectedOwner: string): LocalIpcEndpoint {
  if (endpoint.protocolVersion !== RUNNER_PROTOCOL_VERSION) throw new Error('RUNNER_PROTOCOL_VERSION_MISMATCH');
  if (endpoint.ownerIdentity !== expectedOwner || endpoint.access !== 'current_user_only') throw new Error('RUNNER_IPC_ACCESS_DENIED');
  if (endpoint.tcpListening !== false || /^(?:tcp|https?):/i.test(endpoint.address)) throw new Error('RUNNER_TCP_CONTROL_CHANNEL_FORBIDDEN');
  if (endpoint.transport === 'windows_named_pipe') {
    if (!/^\\\\\.\\pipe\\weave-[A-Za-z0-9._-]+$/.test(endpoint.address)) throw new Error('RUNNER_IPC_ADDRESS_INVALID');
  } else if (!endpoint.address.startsWith('/')) {
    throw new Error('RUNNER_IPC_ADDRESS_INVALID');
  }
  return Object.freeze({ ...endpoint });
}

export function verifyRunnerHandshake(
  proof: RunnerHandshakeProof,
  expected: { readonly role: RunnerHandshakeProof['role']; readonly identity: string; readonly challenge: string; readonly publicKey: string },
): void {
  if (
    proof.protocolVersion !== RUNNER_PROTOCOL_VERSION
    || proof.role !== expected.role
    || proof.identity !== expected.identity
    || proof.challenge !== expected.challenge
  ) throw new Error('RUNNER_HANDSHAKE_IDENTITY_MISMATCH');
  const publicKey = createPublicKey({ key: Buffer.from(expected.publicKey, 'base64url'), type: 'spki', format: 'der' });
  if (!verify(null, handshakePayload(proof.role, proof.identity, proof.challenge), publicKey, Buffer.from(proof.signature, 'base64url'))) {
    throw new Error('RUNNER_HANDSHAKE_SIGNATURE_INVALID');
  }
}

export function authenticateRunnerSession(input: {
  readonly endpoint: LocalIpcEndpoint;
  readonly expectedOwner: string;
  readonly expectedHostIdentity: string;
  readonly expectedRunnerIdentity: string;
  readonly hostProof: RunnerHandshakeProof;
  readonly hostPublicKey: string;
  readonly supervisorProof: RunnerHandshakeProof;
  readonly supervisorPublicKey: string;
}): AuthenticatedRunnerSession {
  const endpoint = validateLocalIpcEndpoint(input.endpoint, input.expectedOwner);
  verifyRunnerHandshake(input.hostProof, {
    role: 'host', identity: input.expectedHostIdentity, challenge: input.hostProof.challenge, publicKey: input.hostPublicKey,
  });
  verifyRunnerHandshake(input.supervisorProof, {
    role: 'supervisor', identity: input.expectedRunnerIdentity,
    challenge: input.supervisorProof.challenge, publicKey: input.supervisorPublicKey,
  });
  if (input.hostProof.challenge === input.supervisorProof.challenge) throw new Error('RUNNER_HANDSHAKE_CHALLENGE_REUSE');
  return Object.freeze({
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    endpoint,
    hostIdentity: input.hostProof.identity,
    runnerIdentity: input.supervisorProof.identity,
  });
}

function handshakePayload(role: string, identity: string, challenge: string): Buffer {
  return Buffer.from(`weave-runner-handshake:v1\0${role}\0${identity}\0${challenge}`, 'utf8');
}
