import { describe, expect, it } from 'vitest';
import {
  EphemeralRunnerIdentity,
  RUNNER_PROTOCOL_VERSION,
  validateLocalIpcEndpoint,
  verifyRunnerHandshake,
} from '../../../src/runner/index.js';

describe('Runner local control protocol', () => {
  it('accepts only current-user local IPC and never TCP', () => {
    const endpoint = {
      protocolVersion: RUNNER_PROTOCOL_VERSION,
      transport: 'windows_named_pipe' as const,
      address: '\\\\.\\pipe\\weave-runner-1',
      ownerIdentity: 'user-1', access: 'current_user_only' as const, tcpListening: false as const,
    };
    expect(validateLocalIpcEndpoint(endpoint, 'user-1')).toEqual(endpoint);
    expect(() => validateLocalIpcEndpoint({ ...endpoint, address: 'tcp://127.0.0.1:9000' }, 'user-1'))
      .toThrow('TCP_CONTROL_CHANNEL_FORBIDDEN');
    expect(() => validateLocalIpcEndpoint(endpoint, 'user-2')).toThrow('IPC_ACCESS_DENIED');
  });

  it('mutually verifies host and supervisor identity challenges', () => {
    const host = new EphemeralRunnerIdentity('host-1');
    const supervisor = new EphemeralRunnerIdentity('runner-1');
    const hostChallenge = 'host-challenge-1234567890';
    const supervisorChallenge = 'supervisor-challenge-123456';
    const hostProof = host.prove('host', supervisorChallenge);
    const supervisorProof = supervisor.prove('supervisor', hostChallenge);
    expect(() => verifyRunnerHandshake(hostProof, {
      role: 'host', identity: 'host-1', challenge: supervisorChallenge, publicKey: host.publicKey,
    })).not.toThrow();
    expect(() => verifyRunnerHandshake(supervisorProof, {
      role: 'supervisor', identity: 'runner-1', challenge: hostChallenge, publicKey: supervisor.publicKey,
    })).not.toThrow();
    expect(() => verifyRunnerHandshake({ ...supervisorProof, challenge: 'tampered-challenge-1234' }, {
      role: 'supervisor', identity: 'runner-1', challenge: hostChallenge, publicKey: supervisor.publicKey,
    })).toThrow('HANDSHAKE_IDENTITY_MISMATCH');
  });
});
