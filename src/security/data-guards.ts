import type { LlmProtocol } from '../shared/types.js';
import type { DataClassification } from './domain.js';

const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\b(?:ghp|github_pat|sk)_[A-Za-z0-9_-]{20,}\b/u,
  /\bAKIA[A-Z0-9]{16}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/iu,
  /\b(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^\s,;]{12,}/iu,
];
const SENSITIVE_PATTERNS = [/WEAVE_SENSITIVE:/u];

export class CredentialDataBlockedError extends Error {
  readonly safeError = Object.freeze({ code: 'CREDENTIAL_DATA_BLOCKED', message: '凭据内容已被安全守卫阻断。', retryable: false });
  constructor() { super('CREDENTIAL_DATA_BLOCKED: 检测到凭据内容'); this.name = 'CredentialDataBlockedError'; }
}

export class SensitiveDataAuthorizationRequiredError extends Error {
  readonly safeError = Object.freeze({ code: 'SENSITIVE_DATA_AUTHORIZATION_REQUIRED', message: '敏感内容需要独立披露授权。', retryable: false });
  constructor() { super('SENSITIVE_DATA_AUTHORIZATION_REQUIRED: 敏感内容需要独立披露授权'); this.name = 'SensitiveDataAuthorizationRequiredError'; }
}

export class InputGuard {
  classifyCurrentInput(content: string): DataClassification {
    const classification = classifyText(content);
    if (classification === 'credential') throw new CredentialDataBlockedError();
    return classification;
  }

  classifyOptionalContext(content: string): DataClassification {
    return classifyText(content);
  }
}

interface ModelDestination {
  readonly profile: string;
  readonly protocol: LlmProtocol;
  readonly model: string;
  readonly origin: string;
}

export class FinalInputGuard {
  assertAllowed(input: {
    readonly expectedDestination: ModelDestination;
    readonly actualDestination: ModelDestination;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Uint8Array;
    readonly authorizedSensitiveValues: readonly string[];
  }): void {
    if (!sameDestination(input.expectedDestination, input.actualDestination)) {
      throw new Error('MODEL_DESTINATION_MISMATCH: 最终模型目的地与 Task 固定值不匹配');
    }
    const serialized = `${Object.entries(input.headers).map(([key, value]) => `${key}:${value}`).join('\n')}\n${new TextDecoder('utf-8', { fatal: true }).decode(input.body)}`;
    if (classifyText(serialized) === 'credential') throw new CredentialDataBlockedError();
    let remaining = serialized;
    for (const authorized of input.authorizedSensitiveValues) remaining = remaining.replaceAll(authorized, '');
    if (classifyText(remaining) === 'sensitive') throw new SensitiveDataAuthorizationRequiredError();
  }
}

export interface OutputGuardOptions {
  readonly overlapCharacters?: number;
  readonly classify?: (content: string) => DataClassification;
}

export class OutputGuard {
  private readonly overlapCharacters: number;
  private readonly classify: (content: string) => DataClassification;

  constructor(options: OutputGuardOptions = {}) {
    this.overlapCharacters = options.overlapCharacters ?? 64;
    if (!Number.isInteger(this.overlapCharacters) || this.overlapCharacters < 1) throw new TypeError('overlapCharacters must be a positive integer');
    this.classify = options.classify ?? classifyText;
  }

  async *guard(chunks: AsyncIterable<string>): AsyncGenerator<string> {
    let buffer = '';
    for await (const chunk of chunks) {
      const combined = buffer + chunk;
      const classification = this.classify(combined);
      if (classification === 'credential') throw new CredentialDataBlockedError();
      if (classification === 'sensitive') throw new SensitiveDataAuthorizationRequiredError();
      const releaseLength = Math.max(0, combined.length - this.overlapCharacters);
      if (releaseLength > 0) yield combined.slice(0, releaseLength);
      buffer = combined.slice(releaseLength);
    }
    const classification = this.classify(buffer);
    if (classification === 'credential') throw new CredentialDataBlockedError();
    if (classification === 'sensitive') throw new SensitiveDataAuthorizationRequiredError();
    if (buffer.length > 0) yield buffer;
  }

  guardComplete(content: string, authorizedSensitive = false): DataClassification {
    const classification = this.classify(content);
    if (classification === 'credential') throw new CredentialDataBlockedError();
    if (classification === 'sensitive' && !authorizedSensitive) throw new SensitiveDataAuthorizationRequiredError();
    return classification;
  }
}

export function classifyText(content: string): DataClassification {
  if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(content))) return 'credential';
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(content))) return 'sensitive';
  return 'ordinary';
}

function sameDestination(left: ModelDestination, right: ModelDestination): boolean {
  return left.profile === right.profile
    && left.protocol === right.protocol
    && left.model === right.model
    && normalizeOrigin(left.origin) === normalizeOrigin(right.origin);
}

function normalizeOrigin(value: string): string {
  try { return new URL(value).origin; } catch { return ''; }
}
