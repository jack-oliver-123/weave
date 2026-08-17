import { createHash } from 'node:crypto';
import type { ToolCallRequest } from '../shared/types.js';
import { canonicalJson } from './digests.js';
import type { CapabilityRequirement, JsonValue, NormalizedAction } from './domain.js';
import { deepFreeze, SECURITY_SCHEMA_VERSION } from './domain.js';

export const ACTION_NORMALIZER_VERSION = 1 as const;

export function normalizeToolCall(call: ToolCallRequest, digest: string): NormalizedAction | undefined {
  const input = jsonValue(call.input);
  if (input === undefined) return undefined;
  const record = typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input)
    ? call.input as Record<string, unknown>
    : {};
  const path = typeof record.path === 'string' ? record.path : '.';
  let requirements: readonly CapabilityRequirement[];
  if (call.name === 'read_file' || call.name === 'glob' || call.name === 'grep') {
    requirements = [{ type: 'FilesystemRead', paths: [path] }];
  } else if (call.name === 'create_file' || call.name === 'edit_file') {
    requirements = [{ type: 'FilesystemWrite', paths: [path] }];
  } else if (call.name === 'bash') {
    if (typeof record.command !== 'string') return undefined;
    const cwd = typeof record.cwd === 'string' ? record.cwd : '.';
    requirements = [
      // Raw shell syntax can address any workspace-relative path regardless of cwd.
      { type: 'FilesystemRead', paths: ['.'] },
      { type: 'FilesystemWrite', paths: ['.'] },
      {
        type: 'ProcessSpawn', executable: 'bash', argv: ['--noprofile', '--norc', '-c', record.command],
        cwd, lifetime: record.lifetime === 'task' ? 'task' : 'action', rawShell: true,
      },
    ];
  } else if (call.name === 'remember') {
    if (typeof record.content !== 'string' || typeof record.purpose !== 'string') return undefined;
    const scope = record.scope === 'user' ? 'user' : 'project';
    requirements = [{
      type: 'MemoryPersist',
      contentDigest: computeDigest('memory-content', record.content),
      purpose: record.purpose,
      scope,
    }];
  } else {
    return undefined;
  }
  return deepFreeze({
    schemaVersion: SECURITY_SCHEMA_VERSION,
    actionId: call.callId,
    actionType: call.name,
    input,
    manifest: { schemaVersion: SECURITY_SCHEMA_VERSION, requirements },
    digest,
  });
}

export function summarizeToolCall(call: ToolCallRequest): string {
  const input = typeof call.input === 'object' && call.input !== null && !Array.isArray(call.input)
    ? call.input as Record<string, unknown>
    : {};
  if (call.name === 'bash') {
    return boundedSummary(`bash: ${boundedValue(safeSummaryValue(input.command), 120)} (cwd: ${boundedValue(safeSummaryValue(input.cwd ?? '.'), 40)})`);
  }
  if (call.name === 'read_file' || call.name === 'glob' || call.name === 'grep'
    || call.name === 'create_file' || call.name === 'edit_file') {
    return boundedSummary(`${call.name}: ${safeSummaryValue(input.path ?? '.')}`);
  }
  if (call.name === 'remember') {
    return boundedSummary(`remember: ${safeSummaryValue(input.purpose)} (${safeSummaryValue(input.scope ?? 'project')})`);
  }
  return boundedSummary(`tool: ${call.name}`);
}

export function executionActionDigest(call: ToolCallRequest): string {
  return computeDigest('execution-action', {
    normalizerVersion: ACTION_NORMALIZER_VERSION,
    name: call.name,
    input: call.input,
  });
}

export function executionCapabilityDigest(action: NormalizedAction): string {
  return computeDigest('execution-capability', {
    normalizerVersion: ACTION_NORMALIZER_VERSION,
    actionType: action.actionType,
    manifest: action.manifest,
  });
}

function computeDigest(domain: string, value: unknown): string {
  const output = createHash('sha256')
    .update(`weave-runner:v1:${domain}\0`, 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('base64url');
  return `${domain}:v1:${output}`;
}

function safeSummaryValue(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '<unspecified>';
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function boundedSummary(value: string): string {
  return value.length <= 180 ? value : `${value.slice(0, 177)}...`;
}

function boundedValue(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function jsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const items = value.map(jsonValue);
    return items.some((item) => item === undefined) ? undefined : items as readonly JsonValue[];
  }
  if (typeof value !== 'object') return undefined;
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = jsonValue(item);
    if (parsed === undefined) return undefined;
    result[key] = parsed;
  }
  return result;
}
