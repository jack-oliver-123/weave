export const SECURITY_SCHEMA_VERSION = 1 as const;

export type DataClassification = 'ordinary' | 'sensitive' | 'credential';
export type PermissionMode = 'read_only' | 'supervised' | 'autonomous';
export type CapabilityPrimitive =
  | 'FilesystemRead'
  | 'FilesystemWrite'
  | 'ProcessSpawn'
  | 'NetworkEgress'
  | 'CredentialUse'
  | 'DataDisclose'
  | 'MemoryPersist';

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type CapabilityRequirement =
  | { readonly type: 'FilesystemRead'; readonly paths: readonly string[] }
  | { readonly type: 'FilesystemWrite'; readonly paths: readonly string[] }
  | {
      readonly type: 'ProcessSpawn';
      readonly executable: string;
      readonly argv: readonly string[];
      readonly cwd: string;
      readonly lifetime: 'action' | 'task';
      readonly rawShell: boolean;
    }
  | { readonly type: 'NetworkEgress'; readonly scheme: 'http' | 'https'; readonly host: string; readonly port: number }
  | { readonly type: 'CredentialUse'; readonly reference: string; readonly targetOrigin: string }
  | {
      readonly type: 'DataDisclose';
      readonly contentDigest: string;
      readonly classification: DataClassification;
      readonly purpose: string;
      readonly destination: 'model' | 'terminal' | 'history' | 'file' | 'network' | 'audit';
    }
  | { readonly type: 'MemoryPersist'; readonly contentDigest: string; readonly purpose: string; readonly scope: 'project' | 'user' };

export interface CapabilityManifest {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly requirements: readonly CapabilityRequirement[];
}

export interface NormalizedAction {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly actionId: string;
  readonly actionType: string;
  readonly input: JsonValue;
  readonly manifest: CapabilityManifest;
  readonly digest: string;
}

export interface ProvenanceEnvelope {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly envelopeId: string;
  readonly source: {
    readonly kind: 'user' | 'project' | 'history' | 'memory' | 'tool' | 'model' | 'runtime' | 'external';
    readonly reference: string;
  };
  readonly classification: DataClassification;
  readonly contentDigest: string;
  readonly purpose: string;
  readonly contentRef: string;
}

interface GatewayRequestBase {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly taskId: string;
  readonly runId: string;
  readonly requestId: string;
}

export type GatewayRequest =
  | (GatewayRequestBase & { readonly type: 'model_exchange'; readonly modelExchangeRef: string })
  | (GatewayRequestBase & { readonly type: 'action_batch'; readonly proposalBatchRef: string });

interface GatewayEventBase {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly taskId: string;
  readonly runId: string;
}

export type GatewayEvent =
  | (GatewayEventBase & { readonly type: 'text_delta'; readonly delta: string })
  | (GatewayEventBase & {
      readonly type: 'proposal_batch';
      readonly proposalBatchRef: string;
      readonly actions: readonly { readonly actionId: string; readonly actionDigest: string; readonly summary: string }[];
    })
  | (GatewayEventBase & {
      readonly type: 'authorization_requested';
      readonly requestId: string;
      readonly authorizationEpoch: number;
      readonly actionDigests: readonly string[];
    })
  | (GatewayEventBase & {
      readonly type: 'action_batch_result';
      readonly results: readonly { readonly callId: string; readonly actionDigest: string; readonly isError: boolean; readonly resultRef: string }[];
    })
  | (GatewayEventBase & { readonly type: 'security_integrity_failure'; readonly failure: SecurityIntegrityFailure });

interface AuthorizationGrantBase {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly grantId: string;
  readonly taskId: string;
  readonly authorizationEpoch: number;
  readonly actionDigest: string;
  readonly expiresAt: number;
}

export type AuthorizationGrant =
  | (AuthorizationGrantBase & { readonly type: 'one_time'; readonly callId: string })
  | (AuthorizationGrantBase & { readonly type: 'task_scoped'; readonly scopeDigest: string });

export interface CapabilityTicket {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly ticketId: string;
  readonly runnerId: string;
  readonly sandboxId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly callId: string;
  readonly actionDigest: string;
  readonly capabilityDigest: string;
  readonly policyVersion: string;
  readonly revocationVersion: number;
  readonly authorizationEpoch: number;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly signature: string;
}

export interface DeniedResult {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly type: 'denied_result';
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, JsonValue>>;
}

export interface SecurityIntegrityFailure {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly type: 'security_integrity_failure';
  readonly code: string;
  readonly message: string;
  readonly effectsMayHaveOccurred: boolean;
}

export type GatewayFailure = DeniedResult | SecurityIntegrityFailure;

export class SecuritySchemaError extends TypeError {
  constructor(readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'SecuritySchemaError';
  }
}

export function parseCapabilityManifest(value: unknown): CapabilityManifest {
  const record = exactRecord(value, '$', ['schemaVersion', 'requirements']);
  schemaVersion(record.schemaVersion, '$.schemaVersion');
  const requirements = array(record.requirements, '$.requirements').map((item, index) => parseCapability(item, `$.requirements[${index}]`));
  return deepFreeze({ schemaVersion: SECURITY_SCHEMA_VERSION, requirements });
}

export function parseNormalizedAction(value: unknown): NormalizedAction {
  const record = exactRecord(value, '$', ['schemaVersion', 'actionId', 'actionType', 'input', 'manifest', 'digest']);
  schemaVersion(record.schemaVersion, '$.schemaVersion');
  return deepFreeze({
    schemaVersion: SECURITY_SCHEMA_VERSION,
    actionId: nonEmptyString(record.actionId, '$.actionId'),
    actionType: nonEmptyString(record.actionType, '$.actionType'),
    input: parseJsonValue(record.input, '$.input'),
    manifest: parseCapabilityManifest(record.manifest),
    digest: nonEmptyString(record.digest, '$.digest'),
  });
}

export function parseProvenanceEnvelope(value: unknown): ProvenanceEnvelope {
  const record = exactRecord(value, '$', ['schemaVersion', 'envelopeId', 'source', 'classification', 'contentDigest', 'purpose', 'contentRef']);
  schemaVersion(record.schemaVersion, '$.schemaVersion');
  const source = exactRecord(record.source, '$.source', ['kind', 'reference']);
  return deepFreeze({
    schemaVersion: SECURITY_SCHEMA_VERSION,
    envelopeId: nonEmptyString(record.envelopeId, '$.envelopeId'),
    source: {
      kind: enumValue(source.kind, '$.source.kind', ['user', 'project', 'history', 'memory', 'tool', 'model', 'runtime', 'external']),
      reference: nonEmptyString(source.reference, '$.source.reference'),
    },
    classification: classification(record.classification, '$.classification'),
    contentDigest: nonEmptyString(record.contentDigest, '$.contentDigest'),
    purpose: nonEmptyString(record.purpose, '$.purpose'),
    contentRef: nonEmptyString(record.contentRef, '$.contentRef'),
  });
}

export function parseGatewayRequest(value: unknown): GatewayRequest {
  const base = recordValue(value, '$');
  const type = enumValue(base.type, '$.type', ['model_exchange', 'action_batch']);
  const specific = type === 'model_exchange' ? 'modelExchangeRef' : 'proposalBatchRef';
  const record = exactRecord(value, '$', ['schemaVersion', 'type', 'taskId', 'runId', 'requestId', specific]);
  schemaVersion(record.schemaVersion, '$.schemaVersion');
  const common = {
    schemaVersion: SECURITY_SCHEMA_VERSION,
    taskId: nonEmptyString(record.taskId, '$.taskId'),
    runId: nonEmptyString(record.runId, '$.runId'),
    requestId: nonEmptyString(record.requestId, '$.requestId'),
  } as const;
  return type === 'model_exchange'
    ? deepFreeze({ ...common, type, modelExchangeRef: nonEmptyString(record.modelExchangeRef, '$.modelExchangeRef') })
    : deepFreeze({ ...common, type, proposalBatchRef: nonEmptyString(record.proposalBatchRef, '$.proposalBatchRef') });
}

export function parseGatewayEvent(value: unknown): GatewayEvent {
  const base = recordValue(value, '$');
  const type = enumValue(base.type, '$.type', ['text_delta', 'proposal_batch', 'authorization_requested', 'action_batch_result', 'security_integrity_failure']);
  const common = parseEventBase(base);
  if (type === 'text_delta') {
    const record = exactRecord(value, '$', ['schemaVersion', 'type', 'taskId', 'runId', 'delta']);
    return deepFreeze({ ...common, type, delta: stringValue(record.delta, '$.delta') });
  }
  if (type === 'proposal_batch') {
    const record = exactRecord(value, '$', ['schemaVersion', 'type', 'taskId', 'runId', 'proposalBatchRef', 'actions']);
    const actions = array(record.actions, '$.actions').map((item, index) => {
      const action = exactRecord(item, `$.actions[${index}]`, ['actionId', 'actionDigest', 'summary']);
      return {
        actionId: nonEmptyString(action.actionId, `$.actions[${index}].actionId`),
        actionDigest: nonEmptyString(action.actionDigest, `$.actions[${index}].actionDigest`),
        summary: stringValue(action.summary, `$.actions[${index}].summary`),
      };
    });
    return deepFreeze({ ...common, type, proposalBatchRef: nonEmptyString(record.proposalBatchRef, '$.proposalBatchRef'), actions });
  }
  if (type === 'authorization_requested') {
    const record = exactRecord(value, '$', ['schemaVersion', 'type', 'taskId', 'runId', 'requestId', 'authorizationEpoch', 'actionDigests']);
    return deepFreeze({
      ...common,
      type,
      requestId: nonEmptyString(record.requestId, '$.requestId'),
      authorizationEpoch: nonNegativeInteger(record.authorizationEpoch, '$.authorizationEpoch'),
      actionDigests: stringArray(record.actionDigests, '$.actionDigests'),
    });
  }
  if (type === 'action_batch_result') {
    const record = exactRecord(value, '$', ['schemaVersion', 'type', 'taskId', 'runId', 'results']);
    const results = array(record.results, '$.results').map((item, index) => {
      const result = exactRecord(item, `$.results[${index}]`, ['callId', 'actionDigest', 'isError', 'resultRef']);
      return {
        callId: nonEmptyString(result.callId, `$.results[${index}].callId`),
        actionDigest: nonEmptyString(result.actionDigest, `$.results[${index}].actionDigest`),
        isError: booleanValue(result.isError, `$.results[${index}].isError`),
        resultRef: nonEmptyString(result.resultRef, `$.results[${index}].resultRef`),
      };
    });
    return deepFreeze({ ...common, type, results });
  }
  const record = exactRecord(value, '$', ['schemaVersion', 'type', 'taskId', 'runId', 'failure']);
  const failure = parseGatewayFailure(record.failure);
  if (failure.type !== 'security_integrity_failure') throw new SecuritySchemaError('$.failure.type', 'must be security_integrity_failure');
  return deepFreeze({ ...common, type, failure });
}

export function parseAuthorizationGrant(value: unknown): AuthorizationGrant {
  const base = recordValue(value, '$');
  const type = enumValue(base.type, '$.type', ['one_time', 'task_scoped']);
  const specific = type === 'one_time' ? 'callId' : 'scopeDigest';
  const record = exactRecord(value, '$', ['schemaVersion', 'type', 'grantId', 'taskId', 'authorizationEpoch', 'actionDigest', specific, 'expiresAt']);
  schemaVersion(record.schemaVersion, '$.schemaVersion');
  const common = {
    schemaVersion: SECURITY_SCHEMA_VERSION,
    grantId: nonEmptyString(record.grantId, '$.grantId'),
    taskId: nonEmptyString(record.taskId, '$.taskId'),
    authorizationEpoch: nonNegativeInteger(record.authorizationEpoch, '$.authorizationEpoch'),
    actionDigest: nonEmptyString(record.actionDigest, '$.actionDigest'),
    expiresAt: finiteNumber(record.expiresAt, '$.expiresAt'),
  } as const;
  return type === 'one_time'
    ? deepFreeze({ ...common, type, callId: nonEmptyString(record.callId, '$.callId') })
    : deepFreeze({ ...common, type, scopeDigest: nonEmptyString(record.scopeDigest, '$.scopeDigest') });
}

export function parseCapabilityTicket(value: unknown): CapabilityTicket {
  const keys = ['schemaVersion', 'ticketId', 'runnerId', 'sandboxId', 'taskId', 'runId', 'callId', 'actionDigest', 'capabilityDigest', 'policyVersion', 'revocationVersion', 'authorizationEpoch', 'nonce', 'issuedAt', 'expiresAt', 'signature'] as const;
  const record = exactRecord(value, '$', keys);
  schemaVersion(record.schemaVersion, '$.schemaVersion');
  return deepFreeze({
    schemaVersion: SECURITY_SCHEMA_VERSION,
    ticketId: nonEmptyString(record.ticketId, '$.ticketId'),
    runnerId: nonEmptyString(record.runnerId, '$.runnerId'),
    sandboxId: nonEmptyString(record.sandboxId, '$.sandboxId'),
    taskId: nonEmptyString(record.taskId, '$.taskId'),
    runId: nonEmptyString(record.runId, '$.runId'),
    callId: nonEmptyString(record.callId, '$.callId'),
    actionDigest: nonEmptyString(record.actionDigest, '$.actionDigest'),
    capabilityDigest: nonEmptyString(record.capabilityDigest, '$.capabilityDigest'),
    policyVersion: nonEmptyString(record.policyVersion, '$.policyVersion'),
    revocationVersion: nonNegativeInteger(record.revocationVersion, '$.revocationVersion'),
    authorizationEpoch: nonNegativeInteger(record.authorizationEpoch, '$.authorizationEpoch'),
    nonce: nonEmptyString(record.nonce, '$.nonce'),
    issuedAt: finiteNumber(record.issuedAt, '$.issuedAt'),
    expiresAt: finiteNumber(record.expiresAt, '$.expiresAt'),
    signature: nonEmptyString(record.signature, '$.signature'),
  });
}

export function parseGatewayFailure(value: unknown): GatewayFailure {
  const base = recordValue(value, '$');
  const type = enumValue(base.type, '$.type', ['denied_result', 'security_integrity_failure']);
  if (type === 'denied_result') {
    const allowed = base.details === undefined
      ? ['schemaVersion', 'type', 'code', 'message', 'retryable']
      : ['schemaVersion', 'type', 'code', 'message', 'retryable', 'details'];
    const record = exactRecord(value, '$', allowed);
    schemaVersion(record.schemaVersion, '$.schemaVersion');
    const details = record.details === undefined ? undefined : parseStringRecord(record.details, '$.details');
    return deepFreeze({
      schemaVersion: SECURITY_SCHEMA_VERSION,
      type,
      code: nonEmptyString(record.code, '$.code'),
      message: stringValue(record.message, '$.message'),
      retryable: booleanValue(record.retryable, '$.retryable'),
      ...(details === undefined ? {} : { details }),
    });
  }
  const record = exactRecord(value, '$', ['schemaVersion', 'type', 'code', 'message', 'effectsMayHaveOccurred']);
  schemaVersion(record.schemaVersion, '$.schemaVersion');
  return deepFreeze({
    schemaVersion: SECURITY_SCHEMA_VERSION,
    type,
    code: nonEmptyString(record.code, '$.code'),
    message: stringValue(record.message, '$.message'),
    effectsMayHaveOccurred: booleanValue(record.effectsMayHaveOccurred, '$.effectsMayHaveOccurred'),
  });
}

function parseCapability(value: unknown, path: string): CapabilityRequirement {
  const base = recordValue(value, path);
  const type = enumValue(base.type, `${path}.type`, ['FilesystemRead', 'FilesystemWrite', 'ProcessSpawn', 'NetworkEgress', 'CredentialUse', 'DataDisclose', 'MemoryPersist']);
  if (type === 'FilesystemRead' || type === 'FilesystemWrite') {
    const record = exactRecord(value, path, ['type', 'paths']);
    return deepFreeze({ type, paths: stringArray(record.paths, `${path}.paths`) });
  }
  if (type === 'ProcessSpawn') {
    const record = exactRecord(value, path, ['type', 'executable', 'argv', 'cwd', 'lifetime', 'rawShell']);
    return deepFreeze({
      type,
      executable: nonEmptyString(record.executable, `${path}.executable`),
      argv: stringArray(record.argv, `${path}.argv`),
      cwd: nonEmptyString(record.cwd, `${path}.cwd`),
      lifetime: enumValue(record.lifetime, `${path}.lifetime`, ['action', 'task']),
      rawShell: booleanValue(record.rawShell, `${path}.rawShell`),
    });
  }
  if (type === 'NetworkEgress') {
    const record = exactRecord(value, path, ['type', 'scheme', 'host', 'port']);
    const port = nonNegativeInteger(record.port, `${path}.port`);
    if (port < 1 || port > 65_535) throw new SecuritySchemaError(`${path}.port`, 'must be between 1 and 65535');
    return deepFreeze({ type, scheme: enumValue(record.scheme, `${path}.scheme`, ['http', 'https']), host: nonEmptyString(record.host, `${path}.host`), port });
  }
  if (type === 'CredentialUse') {
    const record = exactRecord(value, path, ['type', 'reference', 'targetOrigin']);
    return deepFreeze({ type, reference: nonEmptyString(record.reference, `${path}.reference`), targetOrigin: nonEmptyString(record.targetOrigin, `${path}.targetOrigin`) });
  }
  if (type === 'DataDisclose') {
    const record = exactRecord(value, path, ['type', 'contentDigest', 'classification', 'purpose', 'destination']);
    return deepFreeze({
      type,
      contentDigest: nonEmptyString(record.contentDigest, `${path}.contentDigest`),
      classification: classification(record.classification, `${path}.classification`),
      purpose: nonEmptyString(record.purpose, `${path}.purpose`),
      destination: enumValue(record.destination, `${path}.destination`, ['model', 'terminal', 'history', 'file', 'network', 'audit']),
    });
  }
  const record = exactRecord(value, path, ['type', 'contentDigest', 'purpose', 'scope']);
  return deepFreeze({
    type,
    contentDigest: nonEmptyString(record.contentDigest, `${path}.contentDigest`),
    purpose: nonEmptyString(record.purpose, `${path}.purpose`),
    scope: enumValue(record.scope, `${path}.scope`, ['project', 'user']),
  });
}

function parseEventBase(record: Readonly<Record<string, unknown>>): GatewayEventBase {
  schemaVersion(record.schemaVersion, '$.schemaVersion');
  return {
    schemaVersion: SECURITY_SCHEMA_VERSION,
    taskId: nonEmptyString(record.taskId, '$.taskId'),
    runId: nonEmptyString(record.runId, '$.runId'),
  };
}

function parseJsonValue(value: unknown, path: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return finiteNumber(value, path);
  if (Array.isArray(value)) return value.map((item, index) => parseJsonValue(item, `${path}[${index}]`));
  const record = recordValue(value, path);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, parseJsonValue(item, `${path}.${key}`)]));
}

function parseStringRecord(value: unknown, path: string): Readonly<Record<string, JsonValue>> {
  const record = recordValue(value, path);
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, parseJsonValue(item, `${path}.${key}`)]));
}

function classification(value: unknown, path: string): DataClassification {
  return enumValue(value, path, ['ordinary', 'sensitive', 'credential']);
}

function schemaVersion(value: unknown, path: string): asserts value is typeof SECURITY_SCHEMA_VERSION {
  if (value !== SECURITY_SCHEMA_VERSION) throw new SecuritySchemaError(path, `unsupported schema version ${String(value)}`);
}

function exactRecord(value: unknown, path: string, allowedKeys: readonly string[]): Readonly<Record<string, unknown>> {
  const record = recordValue(value, path);
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new SecuritySchemaError(`${path}.${key}`, 'unknown field');
  }
  for (const key of allowedKeys) {
    if (!(key in record)) throw new SecuritySchemaError(`${path}.${key}`, 'required field is missing');
  }
  return record;
}

function recordValue(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SecuritySchemaError(path, 'must be an object');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new SecuritySchemaError(path, 'must be a plain object');
  return value as Readonly<Record<string, unknown>>;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new SecuritySchemaError(path, 'must be an array');
  return value;
}

function stringArray(value: unknown, path: string): readonly string[] {
  return array(value, path).map((item, index) => nonEmptyString(item, `${path}[${index}]`));
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new SecuritySchemaError(path, 'must be a string');
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const parsed = stringValue(value, path);
  if (parsed.length === 0) throw new SecuritySchemaError(path, 'must not be empty');
  return parsed;
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new SecuritySchemaError(path, 'must be a finite number');
  return value;
}

function nonNegativeInteger(value: unknown, path: string): number {
  const parsed = finiteNumber(value, path);
  if (!Number.isInteger(parsed) || parsed < 0) throw new SecuritySchemaError(path, 'must be a non-negative integer');
  return parsed;
}

function booleanValue(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new SecuritySchemaError(path, 'must be a boolean');
  return value;
}

function enumValue<const T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new SecuritySchemaError(path, `must be one of ${allowed.join(', ')}`);
  return value as T;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
