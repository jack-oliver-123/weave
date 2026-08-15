import type {
  CapabilityPrimitive,
  CapabilityRequirement,
  NormalizedAction,
  PermissionMode,
} from './domain.js';
import type {
  AuthorizationDecisionItem,
  AuthorizationRequestView,
} from '../shared/types.js';

export type AuthorizationEffect = 'allow' | 'ask' | 'deny' | 'no_match';

export class SecurityIntegrityFailureError extends Error {
  constructor(readonly code: string, message: string, readonly effectsMayHaveOccurred = false) {
    super(message);
    this.name = 'SecurityIntegrityFailureError';
  }
}

export class PermissionCancelledError extends Error {
  constructor(message = 'Authorization was cancelled by the user') {
    super(message);
    this.name = 'PermissionCancelledError';
  }
}

export interface PermissionRuleTarget {
  readonly actionType?: string;
  readonly capability?: CapabilityPrimitive;
  readonly pathPrefix?: string;
  readonly executable?: string;
  readonly host?: string;
  readonly destination?: Extract<CapabilityRequirement, { type: 'DataDisclose' }>['destination'];
  readonly rawShell?: boolean;
}

export interface PermissionRule {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly effect: Exclude<AuthorizationEffect, 'no_match'>;
  readonly target: PermissionRuleTarget;
  readonly source: 'user' | 'project';
}

export interface CommandRiskAssessment {
  readonly schemaVersion: 1;
  readonly ruleVersion: '1';
  readonly verdict: 'clear' | 'risk' | 'hard_deny';
  readonly code?: string;
  readonly risks: readonly string[];
}

export interface PathBoundaryAssessment {
  readonly allowed: boolean;
  readonly code?: string;
  readonly message?: string;
}

export interface AuthorizationDecision {
  readonly effect: Exclude<AuthorizationEffect, 'no_match'>;
  readonly code: string;
  readonly actionDigest: string;
  readonly capabilityEffects: readonly AuthorizationEffect[];
  readonly matchedRuleIds: readonly string[];
  readonly risks: readonly string[];
  readonly layer: 'command_risk' | 'path_boundary' | 'permission_rules' | 'permission_mode' | 'confirmation';
  readonly evaluatedLayers: readonly AuthorizationDecision['layer'][];
}

const EFFECT_RANK: Readonly<Record<AuthorizationEffect, number>> = {
  no_match: 0,
  allow: 1,
  ask: 2,
  deny: 3,
};

const HARD_DENY_PATTERNS: readonly [RegExp, string][] = [
  [/(?:^|[\s":])(?:sudo|doas|runas|pkexec)(?:\s|$)/i, 'PRIVILEGE_ESCALATION'],
  [/(?:\\\\\.\\|\\\.\\pipe|\/dev\/(?:mem|kmem|sd[a-z]|nvme)|\/proc\/\d+\/(?:mem|fd)|\/var\/run\/docker\.sock)/i, 'HOST_DEVICE_OR_IPC'],
  [/(?:\.ssh|\.aws|\.azure|keychain|credential\s+manager|security\.yaml|audit(?:\/|\\)|capability[-_ ]?ticket)/i, 'HOST_SECURITY_RESOURCE'],
  [/(?:api[_-]?key|access[_-]?token|password|secret).*(?:print|echo|cat|type)|(?:print|echo|cat|type).*(?:api[_-]?key|access[_-]?token|password|secret)/i, 'CREDENTIAL_DISCLOSURE'],
  [/(?:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}|fork\s*bomb|while\s*\(true\)|while\s+true\s*;\s*do\s+.*&)/i, 'RESOURCE_BOMB'],
  [/(?:rm\s+-[^\n]*r[^\n]*f\s+(?:\/|~|[a-z]:\\)(?:\s|$)|remove-item\s+(?:\/|~|[a-z]:\\)[^\n]*-recurse|rmdir\s+\/s\s+(?:[a-z]:\\|\\\\))/i, 'CATASTROPHIC_DELETE'],
];

const RISK_PATTERNS: readonly [RegExp, string][] = [
  [/(?:curl|wget|invoke-webrequest|fetch)\b/i, 'NETWORK_TOOL'],
  [/(?:bash|sh|cmd(?:\.exe)?|powershell|pwsh)\b/i, 'RAW_SHELL'],
  [/(?:rm|del|remove-item|rmdir)\b/i, 'DESTRUCTIVE_OPERATION'],
];

export class CommandRiskCheck {
  evaluate(action: NormalizedAction, workspaceRoot?: string): CommandRiskAssessment {
    const serialized = `${action.actionType}\n${JSON.stringify(action.input)}`;
    if (destructiveSandboxWorkspaceRoot(action)
      || (workspaceRoot !== undefined && destructiveWorkspaceRoot(serialized, workspaceRoot))) {
      return riskAssessment('hard_deny', ['WORKSPACE_ROOT_DELETE'], 'WORKSPACE_ROOT_DELETE');
    }
    for (const [pattern, code] of HARD_DENY_PATTERNS) {
      if (pattern.test(serialized)) return riskAssessment('hard_deny', [code], code);
    }
    const risks = RISK_PATTERNS.filter(([pattern]) => pattern.test(serialized)).map(([, code]) => code);
    return risks.length === 0 ? riskAssessment('clear', []) : riskAssessment('risk', risks);
  }
}

export interface AuthorizationEvaluationInput {
  readonly action: NormalizedAction;
  readonly mode: PermissionMode;
  readonly rules?: readonly PermissionRule[];
  readonly commandRisk?: CommandRiskAssessment;
  readonly pathBoundary?: PathBoundaryAssessment;
}

export class AuthorizationEvaluator {
  evaluate(input: AuthorizationEvaluationInput): AuthorizationDecision {
    const risk = input.commandRisk ?? riskAssessment('clear', []);
    if (risk.verdict === 'hard_deny') {
      return decision(input.action, 'deny', risk.code ?? 'BUILT_IN_HARD_DENY', [], [], risk.risks, 'command_risk');
    }
    if (input.pathBoundary?.allowed === false) {
      return decision(input.action, 'deny', input.pathBoundary.code ?? 'PATH_OUTSIDE_BOUNDARY', [], [], risk.risks, 'path_boundary');
    }

    const rules = input.rules ?? [];
    if (rules.some((rule) => rule.source === 'project' && rule.effect === 'allow')) {
      return decision(input.action, 'deny', 'INVALID_PROJECT_ALLOW', [], [], risk.risks, 'permission_rules');
    }
    const actionRules = rules.filter((rule) => matchesAction(rule, input.action));
    const restrictiveActionEffect = mergeEffects(actionRules
      .filter((rule) => rule.effect !== 'allow')
      .map((rule) => rule.effect));
    if (restrictiveActionEffect === 'deny' || restrictiveActionEffect === 'ask') {
      return decision(
        input.action,
        restrictiveActionEffect,
        restrictiveActionEffect === 'deny' ? 'PERMISSION_RULE_DENIED' : 'PERMISSION_RULE_CONFIRMATION_REQUIRED',
        input.action.manifest.requirements.map(() => restrictiveActionEffect),
        actionRules.map((rule) => rule.id),
        risk.risks,
        'permission_rules',
      );
    }

    const matchedRuleIds = new Set<string>();
    const capabilityEffects = input.action.manifest.requirements.map((requirement): AuthorizationEffect => {
      const matching = actionRules.filter((rule) => matchesRequirement(rule.target, requirement));
      for (const rule of matching) matchedRuleIds.add(rule.id);
      const ruleEffect = mergeEffects(matching.map((rule) => rule.effect));
      if (ruleEffect !== 'no_match') return ruleEffect;
      return permissionModeEffect(input.mode, requirement);
    });
    const merged = mergeEffects(capabilityEffects);
    const riskAdjusted = risk.verdict === 'risk' && merged === 'allow' ? 'ask' : merged;
    const effect = riskAdjusted === 'no_match' ? 'deny' : riskAdjusted;
    const layer = matchedRuleIds.size > 0 ? 'permission_rules' : 'permission_mode';
    return decision(
      input.action,
      effect,
      effect === 'allow' ? 'AUTHORIZED_FOR_TICKETING'
        : effect === 'ask' ? 'AUTHORIZATION_CONFIRMATION_REQUIRED'
          : 'PERMISSION_DENIED',
      capabilityEffects,
      [...matchedRuleIds],
      risk.risks,
      effect === 'ask' ? 'confirmation' : layer,
    );
  }
}

export interface BatchPreflightResult {
  readonly decisions: readonly AuthorizationDecision[];
  readonly ask: readonly AuthorizationDecision[];
  readonly allowed: readonly AuthorizationDecision[];
  readonly denied: readonly AuthorizationDecision[];
}

export class BatchAuthorizationPreflight {
  constructor(private readonly evaluator = new AuthorizationEvaluator()) {}

  evaluate(inputs: readonly AuthorizationEvaluationInput[]): BatchPreflightResult {
    const decisions = inputs.map((input) => this.evaluator.evaluate(input));
    return Object.freeze({
      decisions: Object.freeze(decisions),
      ask: Object.freeze(decisions.filter((item) => item.effect === 'ask')),
      allowed: Object.freeze(decisions.filter((item) => item.effect === 'allow')),
      denied: Object.freeze(decisions.filter((item) => item.effect === 'deny')),
    });
  }

  async perform<T>(
    inputs: readonly AuthorizationEvaluationInput[],
    audit: (decisions: readonly AuthorizationDecision[]) => Promise<void>,
    execute: (allowed: readonly AuthorizationDecision[]) => Promise<T>,
  ): Promise<{ readonly preflight: BatchPreflightResult; readonly execution?: T }> {
    const preflight = this.evaluate(inputs);
    if (preflight.ask.length > 0) return { preflight };
    await audit(preflight.decisions);
    const execution = await execute(preflight.allowed);
    return { preflight, execution };
  }
}

export interface TaskGrant {
  readonly grantId: string;
  readonly type: 'one_time' | 'task_scoped';
  readonly taskId: string;
  readonly authorizationEpoch: number;
  readonly actionDigest: string;
  readonly callId?: string;
  readonly scopeDigest?: string;
  readonly expiresAt: number;
}

export interface PreparedCapabilityTicket {
  readonly ticketId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly callId: string;
  readonly actionDigest: string;
  readonly authorizationEpoch: number;
  readonly expiresAt: number;
  readonly revocationVersion: number;
}

export class TaskAuthorizationState {
  private currentEpoch: number;
  private revocationVersion = 0;
  private readonly grants = new Map<string, TaskGrant>();
  private readonly tickets = new Map<string, PreparedCapabilityTicket>();
  private readonly consumedTickets = new Set<string>();

  constructor(
    readonly taskId: string,
    initialEpoch: number,
    private readonly createId: () => string,
    private readonly now: () => number,
  ) {
    if (!Number.isInteger(initialEpoch) || initialEpoch < 0) throw new TypeError('initialEpoch must be a non-negative integer');
    this.currentEpoch = initialEpoch;
  }

  get authorizationEpoch(): number { return this.currentEpoch; }
  get currentRevocationVersion(): number { return this.revocationVersion; }

  grantOnce(callId: string, actionDigest: string, ttlMs = 60_000): TaskGrant {
    return this.addGrant({
      grantId: this.createId(), type: 'one_time', taskId: this.taskId,
      authorizationEpoch: this.currentEpoch, actionDigest, callId, expiresAt: this.now() + ttlMs,
    });
  }

  grantForTask(actionDigest: string, scopeDigest: string, ttlMs = 60 * 60_000): TaskGrant {
    return this.addGrant({
      grantId: this.createId(), type: 'task_scoped', taskId: this.taskId,
      authorizationEpoch: this.currentEpoch, actionDigest, scopeDigest, expiresAt: this.now() + ttlMs,
    });
  }

  hasGrant(callId: string, actionDigest: string, scopeDigest?: string): boolean {
    for (const [id, grant] of this.grants) {
      if (grant.authorizationEpoch !== this.currentEpoch || grant.expiresAt < this.now()) {
        this.grants.delete(id);
        continue;
      }
      if (grant.actionDigest !== actionDigest) continue;
      if (grant.type === 'one_time' && grant.callId === callId) {
        this.grants.delete(id);
        return true;
      }
      if (grant.type === 'task_scoped' && grant.scopeDigest === scopeDigest) return true;
    }
    return false;
  }

  issueTicket(runId: string, callId: string, actionDigest: string, ttlMs = 30_000): PreparedCapabilityTicket {
    const ticket = Object.freeze({
      ticketId: this.createId(), taskId: this.taskId, runId, callId, actionDigest,
      authorizationEpoch: this.currentEpoch, expiresAt: this.now() + ttlMs,
      revocationVersion: this.revocationVersion,
    });
    this.tickets.set(ticket.ticketId, ticket);
    return ticket;
  }

  consumeTicket(ticketId: string): PreparedCapabilityTicket {
    if (this.consumedTickets.has(ticketId)) throw new Error('SECURITY_INTEGRITY_FAILURE: TICKET_REPLAY');
    const ticket = this.tickets.get(ticketId);
    if (
      ticket === undefined
      || ticket.authorizationEpoch !== this.currentEpoch
      || ticket.revocationVersion !== this.revocationVersion
      || ticket.expiresAt < this.now()
    ) throw new Error('TICKET_INVALID_OR_EXPIRED');
    this.tickets.delete(ticketId);
    this.consumedTickets.add(ticketId);
    return ticket;
  }

  advanceForNaturalLanguage(): number {
    this.currentEpoch += 1;
    this.grants.clear();
    this.tickets.clear();
    return this.currentEpoch;
  }

  resolveHitl(): number { return this.currentEpoch; }

  revoke(): void {
    this.revocationVersion += 1;
    this.grants.clear();
    this.tickets.clear();
  }

  close(): void {
    this.revoke();
    this.consumedTickets.clear();
  }

  private addGrant(grant: TaskGrant): TaskGrant {
    const frozen = Object.freeze(grant);
    this.grants.set(frozen.grantId, frozen);
    return frozen;
  }
}

export class TaskDenialMemory {
  private readonly denied = new Set<string>();

  record(actionDigest: string, resolution: 'deny' | 'cancel'): void {
    if (resolution === 'deny') this.denied.add(actionDigest);
  }

  contains(actionDigest: string): boolean { return this.denied.has(actionDigest); }
  clear(): void { this.denied.clear(); }
}

export class PendingAuthorization {
  private settled = false;
  private readonly promise: Promise<readonly AuthorizationDecisionItem[]>;
  private resolvePromise!: (decisions: readonly AuthorizationDecisionItem[]) => void;
  private rejectPromise!: (reason: unknown) => void;

  constructor(readonly request: AuthorizationRequestView) {
    this.promise = new Promise((resolve, reject) => {
      this.resolvePromise = resolve;
      this.rejectPromise = reject;
    });
  }

  wait(signal: AbortSignal): Promise<readonly AuthorizationDecisionItem[]> {
    if (signal.aborted) {
      this.cancel(signal.reason ?? new Error('PERMISSION_CANCELLED'));
      return this.promise;
    }
    signal.addEventListener('abort', () => this.cancel(signal.reason ?? new Error('PERMISSION_CANCELLED')), { once: true });
    return this.promise;
  }

  resolve(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly authorizationRequestId: string;
    readonly authorizationEpoch: number;
    readonly decisions: readonly AuthorizationDecisionItem[];
  }): void {
    if (this.settled) throw new Error('STALE_AUTHORIZATION_REQUEST');
    if (
      input.taskId !== this.request.taskId
      || input.runId !== this.request.runId
      || input.authorizationRequestId !== this.request.authorizationRequestId
      || input.authorizationEpoch !== this.request.authorizationEpoch
    ) throw new Error('STALE_AUTHORIZATION_REQUEST');
    const expected = new Map<string, string>();
    for (const item of this.request.items) {
      if (expected.has(item.callId)) throw new Error('AUTHORIZATION_REQUEST_INVALID');
      expected.set(item.callId, item.actionDigest);
    }
    const received = new Set<string>();
    for (const decision of input.decisions) {
      if (!isAuthorizationChoice(decision.choice)) throw new Error('AUTHORIZATION_DECISION_INVALID');
      if (received.has(decision.callId) || expected.get(decision.callId) !== decision.actionDigest) {
        throw new Error('AUTHORIZATION_DECISIONS_INCOMPLETE');
      }
      received.add(decision.callId);
    }
    if (received.size !== expected.size) throw new Error('AUTHORIZATION_DECISIONS_INCOMPLETE');
    this.settled = true;
    this.resolvePromise(Object.freeze(input.decisions.map((decision) => Object.freeze({ ...decision }))));
  }

  cancel(reason: unknown = new Error('PERMISSION_CANCELLED')): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectPromise(reason);
  }
}

function isAuthorizationChoice(value: unknown): value is AuthorizationDecisionItem['choice'] {
  return value === 'allow_once' || value === 'allow_for_task' || value === 'deny' || value === 'cancel';
}

export function mergeEffects(effects: readonly AuthorizationEffect[]): AuthorizationEffect {
  return effects.reduce<AuthorizationEffect>((current, effect) => (
    EFFECT_RANK[effect] > EFFECT_RANK[current] ? effect : current
  ), 'no_match');
}

export function permissionModeEffect(mode: PermissionMode, requirement: CapabilityRequirement): Exclude<AuthorizationEffect, 'no_match'> {
  if (requirement.type === 'FilesystemRead') return 'allow';
  if (requirement.type === 'DataDisclose') {
    if (requirement.classification === 'credential') return 'deny';
    if (requirement.classification === 'sensitive') return 'ask';
    return requirement.destination === 'model' || requirement.destination === 'terminal' ? 'allow' : 'ask';
  }
  if (mode === 'read_only') return 'deny';
  if (mode === 'supervised') return 'ask';
  if (requirement.type === 'FilesystemWrite') return 'allow';
  if (requirement.type === 'ProcessSpawn') return requirement.rawShell || requirement.lifetime === 'task' ? 'ask' : 'allow';
  return 'ask';
}

function matchesAction(rule: PermissionRule, action: NormalizedAction): boolean {
  return rule.target.actionType === undefined || rule.target.actionType === action.actionType;
}

function matchesRequirement(target: PermissionRuleTarget, requirement: CapabilityRequirement): boolean {
  if (target.capability === undefined || target.capability !== requirement.type) return false;
  if (target.pathPrefix !== undefined) {
    if (requirement.type !== 'FilesystemRead' && requirement.type !== 'FilesystemWrite') return false;
    if (!requirement.paths.every((path) => path === target.pathPrefix || path.startsWith(`${target.pathPrefix}/`))) return false;
  }
  if (target.executable !== undefined && (requirement.type !== 'ProcessSpawn' || requirement.executable !== target.executable)) return false;
  if (target.rawShell !== undefined && (requirement.type !== 'ProcessSpawn' || requirement.rawShell !== target.rawShell)) return false;
  if (target.host !== undefined && (requirement.type !== 'NetworkEgress' || requirement.host !== target.host)) return false;
  if (target.destination !== undefined && (requirement.type !== 'DataDisclose' || requirement.destination !== target.destination)) return false;
  return true;
}

function decision(
  action: NormalizedAction,
  effect: Exclude<AuthorizationEffect, 'no_match'>,
  code: string,
  capabilityEffects: readonly AuthorizationEffect[],
  matchedRuleIds: readonly string[],
  risks: readonly string[],
  layer: AuthorizationDecision['layer'],
): AuthorizationDecision {
  return Object.freeze({
    effect, code, actionDigest: action.digest,
    capabilityEffects: Object.freeze([...capabilityEffects]),
    matchedRuleIds: Object.freeze([...matchedRuleIds]),
    risks: Object.freeze([...risks]),
    layer,
    evaluatedLayers: Object.freeze(evaluatedLayersFor(layer, effect)),
  });
}

function evaluatedLayersFor(
  layer: AuthorizationDecision['layer'],
  effect: AuthorizationDecision['effect'],
): AuthorizationDecision['layer'][] {
  const layers: AuthorizationDecision['layer'][] = ['command_risk'];
  if (layer === 'command_risk') return layers;
  layers.push('path_boundary');
  if (layer === 'path_boundary') return layers;
  layers.push('permission_rules');
  if (layer === 'permission_rules' && effect === 'deny') return layers;
  layers.push('permission_mode');
  if (effect === 'deny') return layers;
  layers.push('confirmation');
  return layers;
}

function destructiveWorkspaceRoot(serialized: string, workspaceRoot: string): boolean {
  const escaped = workspaceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:rm|rmdir|remove-item|del)[^\\n]*["']?${escaped}["']?(?:[\\s"'}]|$)`, 'i').test(serialized);
}

function destructiveSandboxWorkspaceRoot(action: NormalizedAction): boolean {
  if (action.actionType !== 'bash' || typeof action.input !== 'object' || action.input === null || Array.isArray(action.input)) {
    return false;
  }
  const input = action.input as Readonly<Record<string, import('./domain.js').JsonValue>>;
  const command = input.command;
  if (typeof command !== 'string') return false;
  if (deletesCompleteTarget(command, '/workspace') || deletesCompleteTarget(command, 'C:\\Weave\\Cow')) return true;
  const cwd = typeof input.cwd === 'string' ? input.cwd.replaceAll('\\', '/') : '.';
  return (cwd === '.' || cwd === '/workspace' || /^c:\/weave\/cow\/?$/i.test(cwd))
    && deletesCompleteTarget(command, '.');
}

function deletesCompleteTarget(command: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = target === '.' ? '' : '(?:[\\\\/])?';
  const operand = `["']?${escaped}${suffix}["']?(?=\\s|$|[;&|])`;
  const recursiveRm = new RegExp(`\\brm\\b(?=[^\\r\\n]*(?:-[^\\s]*r|--recursive))(?=[^\\r\\n]*(?:-[^\\s]*f|--force))[^\\r\\n]*?(?:\\s|^)(?:--\\s+)?${operand}`, 'i');
  const removeItem = new RegExp(`\\bremove-item\\b(?=[^\\r\\n]*-(?:recurse|r))(?=[^\\r\\n]*-(?:force|fo))[^\\r\\n]*?(?:\\s|^)${operand}`, 'i');
  const recursiveRmdir = new RegExp(`\\brmdir\\b(?=[^\\r\\n]*(?:/s|-[^\\s]*r))[^\\r\\n]*?(?:\\s|^)${operand}`, 'i');
  return recursiveRm.test(command) || removeItem.test(command) || recursiveRmdir.test(command);
}

function riskAssessment(
  verdict: CommandRiskAssessment['verdict'],
  risks: readonly string[],
  code?: string,
): CommandRiskAssessment {
  return Object.freeze({
    schemaVersion: 1,
    ruleVersion: '1',
    verdict,
    ...(code === undefined ? {} : { code }),
    risks: Object.freeze([...risks]),
  });
}
