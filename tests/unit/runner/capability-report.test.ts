import { describe, expect, it } from 'vitest';
import { buildCapabilityReport, REQUIRED_SANDBOX_PROBES, type CertificationStatus } from '../../../src/runner/index.js';

describe('Sandbox Capability Report', () => {
  it('publishes requested capabilities only when every required negative probe passed', () => {
    const report = buildCapabilityReport({
      runnerId: 'runner-1', backend: 'fake', backendVersion: '1', requestedCapabilities: ['FilesystemRead'],
      evidence: REQUIRED_SANDBOX_PROBES.map(evidence),
    });
    expect(report.capabilities).toEqual(['FilesystemRead']);
    expect(report.evidence).toHaveLength(REQUIRED_SANDBOX_PROBES.length);
  });

  it.each<CertificationStatus>(['failed', 'not_run', 'skipped', 'unknown', 'flaky'])('removes capabilities when one probe is %s', (status) => {
    const all = REQUIRED_SANDBOX_PROBES.map(evidence);
    const report = buildCapabilityReport({
      runnerId: 'runner-1', backend: 'fake', backendVersion: '1', requestedCapabilities: ['FilesystemRead'],
      evidence: all.map((item, index) => index === 0 ? { ...item, status } : item),
    });
    expect(report.capabilities).toEqual([]);
  });

  it('removes capabilities when required evidence is missing', () => {
    const report = buildCapabilityReport({
      runnerId: 'runner-1', backend: 'fake', backendVersion: '1', requestedCapabilities: ['FilesystemRead'],
      evidence: REQUIRED_SANDBOX_PROBES.slice(1).map(evidence),
    });
    expect(report.capabilities).toEqual([]);
  });
});

function evidence(probeId: string) {
  return {
    probeId, status: 'passed' as const, commit: 'commit-1', os: 'test-os', backend: 'fake', backendVersion: '1',
    probeVersion: '1', evidenceDigest: `evidence:${probeId}`,
  };
}
