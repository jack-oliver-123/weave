import { describe, expect, it, vi } from 'vitest';
import {
  authenticateRunnerSession,
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

  it('rejects an invalid signature before a control-plane Supervisor or Task can be created', () => {
    const fixture = sessionFixture();
    const createSupervisor = vi.fn();
    const openTask = vi.fn();
    const signature = fixture.input.supervisorProof.signature;
    const tamperedProof = {
      ...fixture.input.supervisorProof,
      signature: `${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`,
    };

    expect(() => {
      const session = authenticateRunnerSession({ ...fixture.input, supervisorProof: tamperedProof });
      createSupervisor(session);
      openTask();
    }).toThrow('RUNNER_HANDSHAKE_SIGNATURE_INVALID');
    expect(createSupervisor).not.toHaveBeenCalled();
    expect(openTask).not.toHaveBeenCalled();
  });

  it('rejects challenge reuse and mismatched session identities', () => {
    const fixture = sessionFixture();
    const reusedChallenge = 'reused-challenge-123456';
    expect(() => authenticateRunnerSession({
      ...fixture.input,
      hostProof: fixture.host.prove('host', reusedChallenge),
      supervisorProof: fixture.supervisor.prove('supervisor', reusedChallenge),
    })).toThrow('RUNNER_HANDSHAKE_CHALLENGE_REUSE');
    expect(() => authenticateRunnerSession({
      ...fixture.input,
      expectedRunnerIdentity: 'other-runner',
    })).toThrow('RUNNER_HANDSHAKE_IDENTITY_MISMATCH');
  });
});

function sessionFixture() {
  const host = new EphemeralRunnerIdentity('host-1');
  const supervisor = new EphemeralRunnerIdentity('runner-1');
  return {
    host,
    supervisor,
    input: {
      endpoint: {
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        transport: 'windows_named_pipe' as const,
        address: '\\\\.\\pipe\\weave-runner-session',
        ownerIdentity: 'user-1',
        access: 'current_user_only' as const,
        tcpListening: false as const,
      },
      expectedOwner: 'user-1',
      expectedHostIdentity: host.identity,
      expectedRunnerIdentity: supervisor.identity,
      hostProof: host.prove('host', 'supervisor-challenge-123456'),
      hostPublicKey: host.publicKey,
      supervisorProof: supervisor.prove('supervisor', 'host-challenge-1234567890'),
      supervisorPublicKey: supervisor.publicKey,
    },
  };
}
