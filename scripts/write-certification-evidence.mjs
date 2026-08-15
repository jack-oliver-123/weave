import { mkdir, writeFile } from 'node:fs/promises';
import { platform, release, version } from 'node:os';
import { createHash } from 'node:crypto';

const [backend, outcome, capabilitiesValue = '', probesValue = ''] = process.argv.slice(2);
if (!backend || !outcome) throw new Error('Usage: write-certification-evidence <backend> <outcome> [capabilities] [probes]');
const status = ({ success: 'passed', failure: 'failed', skipped: 'skipped', cancelled: 'unknown' })[outcome] ?? 'unknown';
const capabilities = capabilitiesValue === '' ? [] : capabilitiesValue.split(',').filter(Boolean);
const probes = probesValue === '' ? [] : probesValue.split(',').filter(Boolean).map((value) => {
  const [probeId, explicitStatus] = value.split('=', 2);
  const probeStatus = explicitStatus ?? status;
  if (!/^[a-z0-9_]{1,128}$/.test(probeId) || !['passed', 'failed', 'not_run', 'skipped', 'unknown', 'flaky'].includes(probeStatus)) {
    throw new Error(`Invalid probe result: ${value}`);
  }
  return { probeId, status: probeStatus };
});
const unsignedEvidence = {
  schemaVersion: 1,
  commit: process.env.GITHUB_SHA ?? 'working-tree',
  generatedAt: new Date().toISOString(),
  os: { platform: platform(), release: release(), version: version() },
  backend,
  backendVersion: process.env.WEAVE_BACKEND_VERSION ?? 'working-tree',
  probeVersion: '1',
  status,
  capabilities: status === 'passed' ? capabilities : [],
  probes,
};
const evidence = {
  ...unsignedEvidence,
  evidenceDigest: createHash('sha256').update(canonicalJson(unsignedEvidence)).digest('base64url'),
};
await mkdir('artifacts/certification', { recursive: true });
await writeFile(`artifacts/certification/${backend}.json`, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
