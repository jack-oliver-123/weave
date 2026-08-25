import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  LINUX_REQUIRED_SANDBOX_PROBES,
  LinuxNamespaceBackend,
  WSL_REQUIRED_ESCAPE_PROBES,
} from '../src/runner/linux-backend.js';
import type { CertificationStatus } from '../src/runner/capability-report.js';

const platform = process.argv[2];
if (platform !== 'linux' && platform !== 'wsl2') {
  throw new Error('Usage: collect-linux-certification-probes <linux|wsl2>');
}

const required = platform === 'wsl2'
  ? [...LINUX_REQUIRED_SANDBOX_PROBES, ...WSL_REQUIRED_ESCAPE_PROBES]
  : LINUX_REQUIRED_SANDBOX_PROBES;
let statuses: ReadonlyMap<string, CertificationStatus> = new Map(
  required.map((probeId) => [probeId, 'unknown'] as const),
);
try {
  const backend = await LinuxNamespaceBackend.create({
    workspaceRoot: process.cwd(),
    platform,
    transactionRecovery: async () => true,
  });
  statuses = new Map(backend.report.evidence.map((item) => [item.probeId, item.status]));
} catch {
  // Unknown is the fail-closed result when the backend cannot produce a report.
}

const results = required.map((probeId) => ({ probeId, status: statuses.get(probeId) ?? 'unknown' }));
const outputDirectory = resolve('artifacts', 'certification');
await mkdir(outputDirectory, { recursive: true });
await writeFile(resolve(outputDirectory, `${platform}-probes.json`), `${JSON.stringify(results, null, 2)}\n`, 'utf8');
if (results.some((result) => result.status !== 'passed')) process.exitCode = 1;
