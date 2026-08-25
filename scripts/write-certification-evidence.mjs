import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { platform, release, version } from 'node:os';
import { createHash, createPrivateKey, sign } from 'node:crypto';

const arguments_ = process.argv.slice(2);
const [backend, outcome, capabilitiesValue = ''] = arguments_;
if (!backend || !outcome) throw new Error('Usage: write-certification-evidence <backend> <outcome> [capabilities] [probes] [--probe-results <path>]');
const status = ({ success: 'passed', failure: 'failed', skipped: 'skipped', cancelled: 'unknown' })[outcome] ?? 'unknown';
const capabilities = capabilitiesValue === '' ? [] : capabilitiesValue.split(',').filter(Boolean);
const resultsFlag = arguments_.indexOf('--probe-results', 3);
const probesValue = resultsFlag < 0 ? (arguments_[3] ?? '') : '';
const probes = resultsFlag < 0 ? parseProbeValues(probesValue, status) : await readProbeResults(arguments_[resultsFlag + 1]);
const unsignedEvidence = {
  schemaVersion: 1,
  commit: process.env.GITHUB_SHA ?? 'working-tree',
  generatedAt: new Date().toISOString(),
  os: { platform: platform(), release: release(), version: version() },
  backend,
  backendVersion: process.env.WEAVE_BACKEND_VERSION ?? 'working-tree',
  probeVersion: process.env.WEAVE_PROBE_VERSION ?? '1',
  status,
  capabilities: status === 'passed' ? capabilities : [],
  probes,
};
const keyId = process.env.WEAVE_CERTIFICATION_KEY_ID ?? 'weave-certification-v1';
const signingKey = process.env.WEAVE_CERTIFICATION_SIGNING_KEY;
if (!/^[A-Za-z0-9._-]{1,64}$/.test(keyId) || !signingKey) {
  throw new Error('A trusted WEAVE_CERTIFICATION_SIGNING_KEY and valid WEAVE_CERTIFICATION_KEY_ID are required');
}
const privateKey = createPrivateKey({ key: Buffer.from(signingKey, 'base64url'), format: 'der', type: 'pkcs8' });
const canonicalEvidence = canonicalJson(unsignedEvidence);
const evidence = {
  ...unsignedEvidence,
  evidenceDigest: createHash('sha256').update(canonicalEvidence).digest('base64url'),
  signature: {
    algorithm: 'ed25519',
    keyId,
    value: sign(null, Buffer.from(`weave-certification-signature:v1\0${canonicalEvidence}`, 'utf8'), privateKey).toString('base64url'),
  },
};
await mkdir('artifacts/certification', { recursive: true });
await writeFile(`artifacts/certification/${backend}.json`, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

function parseProbeValues(value, defaultStatus) {
  return value === '' ? [] : value.split(',').filter(Boolean).map((item) => {
    const [probeId, explicitStatus] = item.split('=', 2);
    return validatedProbe(probeId, explicitStatus ?? defaultStatus);
  });
}

async function readProbeResults(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('A probe results path is required');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
    throw new Error('Probe results file is untrusted');
  }
  let parsed;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('Probe results file is invalid'); }
  if (!Array.isArray(parsed)) throw new Error('Probe results file is invalid');
  const results = parsed.map((item) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error('Probe results file is invalid');
    return validatedProbe(item.probeId, item.status);
  });
  if (new Set(results.map((item) => item.probeId)).size !== results.length) throw new Error('Probe results file is invalid');
  return results;
}

function validatedProbe(probeId, probeStatus) {
  if (!/^[a-z0-9_]{1,128}$/.test(probeId) || !['passed', 'failed', 'not_run', 'skipped', 'unknown', 'flaky'].includes(probeStatus)) {
    throw new Error(`Invalid probe result: ${String(probeId)}`);
  }
  return { probeId, status: probeStatus };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
