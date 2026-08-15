import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadWindowsCertificationArtifact } from '../../../src/runner/certification-artifact.js';

const writer = resolve('scripts/write-certification-evidence.mjs');
const trusted = signingMaterial('trusted-key');
const facts = {
  platform: 'win32' as const,
  productName: 'Windows 11 Pro',
  build: Number.parseInt(release().split('.')[2] ?? '', 10),
  featureState: 'enabled' as const,
};

describe('certification artifact', () => {
  it('loads signed evidence for the current commit and OS build', async () => {
    const directory = await generate('FilesystemRead', 'windows_read_tools,process_identity');
    const evidence = await loadWindowsCertificationArtifact(
      join(directory, 'artifacts', 'certification', 'windows-sandbox.json'), facts, 'commit-1', trusted.store,
    );
    expect(evidence.map((item) => [item.probeId, item.status])).toEqual([
      ['windows_read_tools', 'passed'], ['process_identity', 'passed'],
    ]);
    expect(evidence.every((item) => item.os === `win32:build:${facts.build}`)).toBe(true);
  });

  it('rejects tampering, stale commits, and unsupported capability claims', async () => {
    const directory = await generate('FilesystemRead', 'windows_read_tools');
    const path = join(directory, 'artifacts', 'certification', 'windows-sandbox.json');
    await expect(loadWindowsCertificationArtifact(path, facts, 'other-commit', trusted.store)).rejects.toThrow('CERTIFICATION_EVIDENCE_STALE');

    const value = await readFile(path, 'utf8');
    await writeFile(path, value.replace('windows_read_tools', 'windows_read_toolx'), 'utf8');
    await expect(loadWindowsCertificationArtifact(path, facts, 'commit-1', trusted.store)).rejects.toThrow('CERTIFICATION_EVIDENCE_DIGEST_MISMATCH');

    const invalid = await generate('FilesystemWrite', 'windows_read_tools');
    await expect(loadWindowsCertificationArtifact(
      join(invalid, 'artifacts', 'certification', 'windows-sandbox.json'), facts, 'commit-1', trusted.store,
    )).rejects.toThrow('CERTIFICATION_CAPABILITY_CLAIM_INVALID');
  });

  it('rejects evidence signed by an untrusted key even when its digest is valid', async () => {
    const attacker = signingMaterial('attacker-key');
    const directory = await generate('FilesystemRead', 'windows_read_tools', attacker);
    await expect(loadWindowsCertificationArtifact(
      join(directory, 'artifacts', 'certification', 'windows-sandbox.json'), facts, 'commit-1', trusted.store,
    )).rejects.toThrow('CERTIFICATION_EVIDENCE_SIGNATURE_INVALID');
  });
});

async function generate(capabilities: string, probes: string, material = trusted): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'weave-cert-artifact-'));
  await promisify(execFile)(process.execPath, [writer, 'windows-sandbox', 'success', capabilities, probes], {
    cwd: directory,
    env: {
      ...process.env,
      GITHUB_SHA: 'commit-1',
      WEAVE_BACKEND_VERSION: 'windows-sandbox-cli-v1',
      WEAVE_CERTIFICATION_KEY_ID: material.keyId,
      WEAVE_CERTIFICATION_SIGNING_KEY: material.privateKey,
    },
  });
  return directory;
}

function signingMaterial(keyId: string) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const publicDer = publicKey.export({ format: 'der', type: 'spki' });
  return {
    keyId,
    privateKey: Buffer.from(privateDer).toString('base64url'),
    store: { [keyId]: Buffer.from(publicDer).toString('base64url') },
  } as const;
}
