import type { NormalizedAction } from '../security/domain.js';

const KIB = 1024;
const MIB = 1024 * KIB;
const GIB = 1024 * MIB;

export interface HostResources { readonly cpuCores: number; readonly memoryBytes: number }

export interface ResourceBudget {
  readonly cpuCores: number;
  readonly memoryBytes: number;
  readonly pids: number;
  readonly actionTimeoutMs: number;
  readonly taskProcessTimeoutMs: number;
  readonly diskBytes: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly batchOutputBytes: number;
  readonly networkBytes: number;
}

export type ResourceBudgetOverride = Partial<ResourceBudget>;

export interface ActionSandboxProfile extends ResourceBudget {
  readonly filesystemRead: readonly string[];
  readonly filesystemWrite: readonly string[];
  readonly networkEnabled: boolean;
  readonly environment: Readonly<Record<string, never>>;
  readonly controlChannelVisible: false;
  readonly ticketVisible: false;
}

export const RESOURCE_HARD_LIMITS: ResourceBudget = Object.freeze({
  cpuCores: 8, memoryBytes: 16 * GIB, pids: 512, actionTimeoutMs: 600_000,
  taskProcessTimeoutMs: 4 * 60 * 60_000, diskBytes: 32 * GIB,
  stdoutBytes: 64 * KIB, stderrBytes: 64 * KIB, batchOutputBytes: 512 * KIB,
  networkBytes: 4 * GIB,
});

export function defaultResourceBudget(host: HostResources): ResourceBudget {
  validateHost(host);
  return Object.freeze({
    cpuCores: Math.min(host.cpuCores * 0.5, 4),
    memoryBytes: Math.min(host.memoryBytes * 0.5, 4 * GIB),
    pids: 128, actionTimeoutMs: 120_000, taskProcessTimeoutMs: 60 * 60_000,
    diskBytes: 4 * GIB, stdoutBytes: 64 * KIB, stderrBytes: 64 * KIB,
    batchOutputBytes: 512 * KIB, networkBytes: 512 * MIB,
  });
}

export function resolveResourceBudget(
  host: HostResources,
  user: ResourceBudgetOverride = {},
  project: ResourceBudgetOverride = {},
): ResourceBudget {
  const base = { ...defaultResourceBudget(host), ...user };
  validateBudget(base);
  for (const [key, value] of Object.entries(project) as [keyof ResourceBudget, number][]) {
    if (value > base[key]) throw new TypeError(`Project resource policy may only tighten ${key}`);
  }
  const resolved = { ...base, ...project };
  validateBudget(resolved);
  return Object.freeze(resolved);
}

export function deriveActionSandboxProfile(action: NormalizedAction, budget: ResourceBudget): ActionSandboxProfile {
  const read = new Set<string>();
  const write = new Set<string>();
  let networkEnabled = false;
  for (const requirement of action.manifest.requirements) {
    if (requirement.type === 'FilesystemRead') requirement.paths.forEach((path) => read.add(path));
    else if (requirement.type === 'FilesystemWrite') requirement.paths.forEach((path) => write.add(path));
    else if (requirement.type === 'NetworkEgress') networkEnabled = true;
  }
  return Object.freeze({
    ...budget,
    filesystemRead: Object.freeze([...read]),
    filesystemWrite: Object.freeze([...write]),
    networkEnabled,
    environment: Object.freeze({}),
    controlChannelVisible: false,
    ticketVisible: false,
  });
}

function validateHost(host: HostResources): void {
  if (!Number.isFinite(host.cpuCores) || host.cpuCores <= 0 || !Number.isFinite(host.memoryBytes) || host.memoryBytes <= 0) {
    throw new TypeError('Host resource report is invalid');
  }
}

function validateBudget(budget: ResourceBudget): void {
  for (const [key, hard] of Object.entries(RESOURCE_HARD_LIMITS) as [keyof ResourceBudget, number][]) {
    const value = budget[key];
    if (!Number.isFinite(value) || value <= 0 || value > hard) throw new TypeError(`Resource budget exceeds product limit: ${key}`);
  }
}
