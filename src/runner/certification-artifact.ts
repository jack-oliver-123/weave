import { createHash, createPublicKey, verify } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import type { CapabilityPrimitive } from '../security/domain.js';
import type { CertificationStatus, ProbeEvidence } from './capability-report.js';
import {
  WINDOWS_BACKEND_VERSION,
  windowsPlatformIdentity,
  type WindowsPlatformFacts,
} from './windows-backend.js';

const MAX_EVIDENCE_BYTES = 1024 * 1024;
const CAPABILITIES = new Set<CapabilityPrimitive>([
  'FilesystemRead', 'FilesystemWrite', 'ProcessSpawn', 'NetworkEgress',
  'CredentialUse', 'DataDisclose', 'MemoryPersist',
]);
const STATUSES = new Set<CertificationStatus>(['passed', 'failed', 'not_run', 'skipped', 'unknown', 'flaky']);

interface CertificationArtifact {
  readonly schemaVersion: 1;
  readonly commit: string;
  readonly generatedAt: string;
  readonly os: { readonly platform: string; readonly release: string; readonly version: string };
  readonly backend: string;
  readonly backendVersion: string;
  readonly probeVersion: string;
  readonly status: CertificationStatus;
  readonly capabilities: readonly CapabilityPrimitive[];
  readonly probes: readonly { readonly probeId: string; readonly status: CertificationStatus }[];
  readonly evidenceDigest: string;
  readonly signature: {
    readonly algorithm: 'ed25519';
    readonly keyId: string;
    readonly value: string;
  };
}

export type CertificationTrustStore = Readonly<Record<string, string>>;

export async function loadWindowsCertificationArtifact(
  path: string,
  facts: WindowsPlatformFacts,
  expectedCommit: string,
  trustedKeys: CertificationTrustStore,
  expectedBackendVersion = WINDOWS_BACKEND_VERSION,
): Promise<readonly ProbeEvidence[]> {
  return loadWindowsComponentCertificationArtifact(
    path,
    facts,
    expectedCommit,
    'windows-sandbox',
    expectedBackendVersion,
    trustedKeys,
  );
}

export async function loadWindowsComponentCertificationArtifact(
  path: string,
  facts: WindowsPlatformFacts,
  expectedCommit: string,
  expectedBackend: 'windows-sandbox' | 'windows-egress-broker' | 'windows-credential-manager',
  expectedBackendVersion: string,
  trustedKeys: CertificationTrustStore,
): Promise<readonly ProbeEvidence[]> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_EVIDENCE_BYTES) {
    throw new Error('CERTIFICATION_EVIDENCE_UNTRUSTED');
  }
  const parsed = parseArtifact(await readFile(path, 'utf8'));
  const unsigned: Record<string, unknown> = { ...parsed };
  delete unsigned.evidenceDigest;
  delete unsigned.signature;
  const digest = createHash('sha256').update(canonicalJson(unsigned)).digest('base64url');
  if (digest !== parsed.evidenceDigest) throw new Error('CERTIFICATION_EVIDENCE_DIGEST_MISMATCH');
  const trustedKey = trustedKeys[parsed.signature.keyId];
  if (trustedKey === undefined || !verifyCertificationSignature(unsigned, parsed.signature.value, trustedKey)) {
    throw new Error('CERTIFICATION_EVIDENCE_SIGNATURE_INVALID');
  }
  const build = Number.parseInt(parsed.os.release.split('.')[2] ?? '', 10);
  if (parsed.backend !== expectedBackend || parsed.backendVersion !== expectedBackendVersion
    || parsed.probeVersion !== '1' || parsed.os.platform !== 'win32'
    || build !== facts.build || parsed.commit !== expectedCommit) {
    throw new Error('CERTIFICATION_EVIDENCE_STALE');
  }
  assertCapabilityClaims(parsed);
  const os = windowsPlatformIdentity(facts);
  return Object.freeze(parsed.probes.map((probe) => Object.freeze({
    probeId: probe.probeId,
    status: parsed.status === 'passed' ? probe.status : 'failed',
    commit: parsed.commit,
    os,
    backend: parsed.backend,
    backendVersion: parsed.backendVersion,
    probeVersion: parsed.probeVersion,
    evidenceDigest: createHash('sha256').update(`${parsed.evidenceDigest}\0${probe.probeId}`).digest('base64url'),
  })));
}

function parseArtifact(source: string): CertificationArtifact {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('CERTIFICATION_EVIDENCE_INVALID'); }
  if (!record(value) || value.schemaVersion !== 1 || typeof value.commit !== 'string'
    || typeof value.generatedAt !== 'string' || !record(value.os)
    || typeof value.os.platform !== 'string' || typeof value.os.release !== 'string' || typeof value.os.version !== 'string'
    || typeof value.backend !== 'string' || typeof value.backendVersion !== 'string'
    || typeof value.probeVersion !== 'string' || !isStatus(value.status)
    || !Array.isArray(value.capabilities) || !value.capabilities.every(isCapability)
    || !Array.isArray(value.probes) || !value.probes.every((probe) => record(probe) && validProbeId(probe.probeId) && isStatus(probe.status))
    || typeof value.evidenceDigest !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.evidenceDigest)
    || !record(value.signature) || value.signature.algorithm !== 'ed25519'
    || typeof value.signature.keyId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(value.signature.keyId)
    || typeof value.signature.value !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(value.signature.value)) {
    throw new Error('CERTIFICATION_EVIDENCE_INVALID');
  }
  const probes = value.probes as Array<{ probeId: string; status: CertificationStatus }>;
  if (new Set(probes.map((probe) => probe.probeId)).size !== probes.length) throw new Error('CERTIFICATION_EVIDENCE_INVALID');
  return value as unknown as CertificationArtifact;
}

export function certificationTrustStoreFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): CertificationTrustStore {
  const keyId = environment.WEAVE_CERTIFICATION_KEY_ID ?? 'weave-certification-v1';
  const publicKey = environment.WEAVE_CERTIFICATION_PUBLIC_KEY;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || publicKey === undefined || publicKey.length === 0) {
    throw new Error('CERTIFICATION_TRUST_ANCHOR_MISSING');
  }
  return Object.freeze({ [keyId]: publicKey });
}

function verifyCertificationSignature(unsigned: Record<string, unknown>, signature: string, trustedKey: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(trustedKey, 'base64url'), format: 'der', type: 'spki' });
    return verify(null, signaturePayload(unsigned), key, Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

function signaturePayload(unsigned: Record<string, unknown>): Buffer {
  return Buffer.from(`weave-certification-signature:v1\0${canonicalJson(unsigned)}`, 'utf8');
}

function assertCapabilityClaims(artifact: CertificationArtifact): void {
  const probes = new Map(artifact.probes.map((probe) => [probe.probeId, probe.status]));
  const required = new Map<CapabilityPrimitive, readonly string[]>([
    ['FilesystemRead', ['windows_read_tools']],
    ['FilesystemWrite', ['windows_read_tools', 'windows_transactional_write']],
    ['ProcessSpawn', ['windows_structured_process', 'windows_bash']],
    ['NetworkEgress', ['windows_network_egress']],
    ['CredentialUse', ['windows_credential_manager']],
  ]);
  for (const capability of artifact.capabilities) {
    const claims = required.get(capability);
    if (claims !== undefined && claims.some((probe) => probes.get(probe) !== 'passed')) {
      throw new Error('CERTIFICATION_CAPABILITY_CLAIM_INVALID');
    }
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStatus(value: unknown): value is CertificationStatus {
  return typeof value === 'string' && STATUSES.has(value as CertificationStatus);
}

function isCapability(value: unknown): value is CapabilityPrimitive {
  return typeof value === 'string' && CAPABILITIES.has(value as CapabilityPrimitive);
}

function validProbeId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9_]{1,128}$/.test(value);
}
