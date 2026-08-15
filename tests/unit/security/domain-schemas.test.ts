import { describe, expect, it } from 'vitest';
import {
  SecuritySchemaError,
  parseAuthorizationGrant,
  parseCapabilityManifest,
  parseCapabilityTicket,
  parseGatewayEvent,
  parseGatewayFailure,
  parseGatewayRequest,
  parseNormalizedAction,
  parseProvenanceEnvelope,
} from '../../../src/security/index.js';

const manifest = {
  schemaVersion: 1,
  requirements: [{ type: 'FilesystemRead', paths: ['src/app.ts'] }],
} as const;

const validCases = [
  ['manifest', parseCapabilityManifest, manifest],
  ['action', parseNormalizedAction, {
    schemaVersion: 1, actionId: 'action-1', actionType: 'read_file',
    input: { path: 'src/app.ts' }, manifest, digest: 'action-digest',
  }],
  ['provenance', parseProvenanceEnvelope, {
    schemaVersion: 1, envelopeId: 'envelope-1', source: { kind: 'user', reference: 'turn-1' },
    classification: 'ordinary', contentDigest: 'content-digest', purpose: 'task_input', contentRef: 'content-1',
  }],
  ['request', parseGatewayRequest, {
    schemaVersion: 1, type: 'model_exchange', taskId: 'task-1', runId: 'run-1', requestId: 'request-1',
    modelExchangeRef: 'exchange-1',
  }],
  ['action batch request', parseGatewayRequest, {
    schemaVersion: 1, type: 'action_batch', taskId: 'task-1', runId: 'run-1', requestId: 'request-2',
    proposalBatchRef: 'batch-1',
  }],
  ['event', parseGatewayEvent, {
    schemaVersion: 1, type: 'text_delta', taskId: 'task-1', runId: 'run-1', delta: '安全文本',
  }],
  ['proposal event', parseGatewayEvent, {
    schemaVersion: 1, type: 'proposal_batch', taskId: 'task-1', runId: 'run-1', proposalBatchRef: 'batch-1',
    actions: [{ actionId: 'action-1', actionDigest: 'action-digest', summary: '读取文件' }],
  }],
  ['authorization event', parseGatewayEvent, {
    schemaVersion: 1, type: 'authorization_requested', taskId: 'task-1', runId: 'run-1', requestId: 'authorization-1',
    authorizationEpoch: 1, actionDigests: ['action-digest'],
  }],
  ['result event', parseGatewayEvent, {
    schemaVersion: 1, type: 'action_batch_result', taskId: 'task-1', runId: 'run-1',
    results: [{ callId: 'call-1', actionDigest: 'action-digest', isError: false, resultRef: 'result-1' }],
  }],
  ['integrity event', parseGatewayEvent, {
    schemaVersion: 1, type: 'security_integrity_failure', taskId: 'task-1', runId: 'run-1',
    failure: {
      schemaVersion: 1, type: 'security_integrity_failure', code: 'TICKET_REPLAYED',
      message: '检测到票据重放', effectsMayHaveOccurred: false,
    },
  }],
  ['grant', parseAuthorizationGrant, {
    schemaVersion: 1, type: 'one_time', grantId: 'grant-1', taskId: 'task-1', authorizationEpoch: 1,
    actionDigest: 'action-digest', callId: 'call-1', expiresAt: 1_700_000_001_000,
  }],
  ['task grant', parseAuthorizationGrant, {
    schemaVersion: 1, type: 'task_scoped', grantId: 'grant-2', taskId: 'task-1', authorizationEpoch: 1,
    actionDigest: 'action-digest', scopeDigest: 'scope-digest', expiresAt: 1_700_000_001_000,
  }],
  ['ticket', parseCapabilityTicket, {
    schemaVersion: 1, ticketId: 'ticket-1', runnerId: 'runner-1', sandboxId: 'sandbox-1', taskId: 'task-1',
    runId: 'run-1', callId: 'call-1', actionDigest: 'action-digest', capabilityDigest: 'capability-digest',
    policyVersion: 'policy-1', revocationVersion: 1, authorizationEpoch: 1, nonce: 'nonce-1',
    issuedAt: 1_700_000_000_000, expiresAt: 1_700_000_001_000, signature: 'signature',
  }],
  ['denied failure', parseGatewayFailure, {
    schemaVersion: 1, type: 'denied_result', code: 'PERMISSION_DENIED', message: '权限不足', retryable: false,
  }],
  ['integrity failure', parseGatewayFailure, {
    schemaVersion: 1, type: 'security_integrity_failure', code: 'TICKET_REPLAYED',
    message: '检测到票据重放', effectsMayHaveOccurred: false,
  }],
] as const;

describe('security domain schemas', () => {
  it.each(validCases)('accepts and deeply freezes a valid %s', (_name, parse, value) => {
    const parsed = parse(value);
    expect(parsed).toEqual(value);
    expect(Object.isFrozen(parsed)).toBe(true);
    const nested = Object.values(parsed).find((item) => typeof item === 'object' && item !== null);
    expect(nested === undefined || Object.isFrozen(nested)).toBe(true);
  });

  it.each(validCases)('rejects unknown versions for %s', (_name, parse, value) => {
    expect(() => parse({ ...value, schemaVersion: 2 })).toThrow(SecuritySchemaError);
  });

  it.each(validCases)('rejects unknown fields for %s', (_name, parse, value) => {
    expect(() => parse({ ...value, unexpected: true })).toThrow(SecuritySchemaError);
  });

  it('accepts every closed capability primitive and rejects unknown capability fields', () => {
    const requirements = [
      { type: 'FilesystemRead', paths: ['src'] },
      { type: 'FilesystemWrite', paths: ['src/app.ts'] },
      { type: 'ProcessSpawn', executable: '/usr/bin/node', argv: ['--version'], cwd: '.', lifetime: 'action', rawShell: false },
      { type: 'NetworkEgress', scheme: 'https', host: 'example.com', port: 443 },
      { type: 'CredentialUse', reference: 'credential:provider', targetOrigin: 'https://example.com' },
      { type: 'DataDisclose', contentDigest: 'digest', classification: 'sensitive', purpose: 'answer', destination: 'terminal' },
      { type: 'MemoryPersist', contentDigest: 'digest', purpose: 'project_fact', scope: 'project' },
    ];

    const parsed = parseCapabilityManifest({ schemaVersion: 1, requirements });
    expect(parsed.requirements).toHaveLength(7);
    expect(Object.isFrozen(parsed.requirements[0])).toBe(true);
    expect(() => parseCapabilityManifest({
      schemaVersion: 1,
      requirements: [{ type: 'FilesystemRead', paths: ['src'], network: true }],
    })).toThrow(SecuritySchemaError);
  });
});
