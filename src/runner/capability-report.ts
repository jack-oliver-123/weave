import type { CapabilityPrimitive } from '../security/domain.js';

export type CertificationStatus = 'passed' | 'failed' | 'not_run' | 'skipped' | 'unknown' | 'flaky';

export interface ProbeEvidence {
  readonly probeId: string;
  readonly status: CertificationStatus;
  readonly commit: string;
  readonly os: string;
  readonly backend: string;
  readonly backendVersion: string;
  readonly probeVersion: string;
  readonly evidenceDigest: string;
}

export interface CapabilityReport {
  readonly schemaVersion: 1;
  readonly runnerId: string;
  readonly backend: string;
  readonly backendVersion: string;
  readonly capabilities: readonly CapabilityPrimitive[];
  readonly evidence: readonly ProbeEvidence[];
}

export const REQUIRED_SANDBOX_PROBES = Object.freeze([
  'process_identity', 'host_paths_hidden', 'raw_network_blocked', 'environment_cleared',
  'devices_hidden', 'privilege_escalation_blocked', 'resource_limits', 'process_tree_cleanup',
  'control_ipc_hidden', 'brokers_hidden',
] as const);

export function buildCapabilityReport(input: {
  readonly runnerId: string;
  readonly backend: string;
  readonly backendVersion: string;
  readonly requestedCapabilities: readonly CapabilityPrimitive[];
  readonly evidence: readonly ProbeEvidence[];
}): CapabilityReport {
  const byId = new Map(input.evidence.map((item) => [item.probeId, item]));
  const certified = REQUIRED_SANDBOX_PROBES.every((probe) => byId.get(probe)?.status === 'passed');
  return Object.freeze({
    schemaVersion: 1,
    runnerId: input.runnerId,
    backend: input.backend,
    backendVersion: input.backendVersion,
    capabilities: Object.freeze(certified ? [...new Set(input.requestedCapabilities)] : []),
    evidence: Object.freeze(input.evidence.map((item) => Object.freeze({ ...item }))),
  });
}
