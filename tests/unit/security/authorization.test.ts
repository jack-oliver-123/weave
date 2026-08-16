import { describe, expect, it, vi } from 'vitest';
import {
  AuthorizationEvaluator,
  BatchAuthorizationPreflight,
  CommandRiskCheck,
  TaskAuthorizationState,
  TaskDenialMemory,
  mergeEffects,
  permissionModeEffect,
  type PermissionRule,
} from '../../../src/security/index.js';
import type {
  CapabilityRequirement,
  JsonValue,
  NormalizedAction,
  PermissionMode,
} from '../../../src/security/index.js';

const requirement = {
  read: { type: 'FilesystemRead', paths: ['src'] },
  write: { type: 'FilesystemWrite', paths: ['src/a.ts'] },
  process: { type: 'ProcessSpawn', executable: 'node', argv: ['test.js'], cwd: '.', lifetime: 'action', rawShell: false },
  taskProcess: { type: 'ProcessSpawn', executable: 'node', argv: ['server.js'], cwd: '.', lifetime: 'task', rawShell: false },
  shell: { type: 'ProcessSpawn', executable: 'bash', argv: ['-c', 'echo ok'], cwd: '.', lifetime: 'action', rawShell: true },
  network: { type: 'NetworkEgress', scheme: 'https', host: 'example.com', port: 443 },
  credential: { type: 'CredentialUse', reference: 'credential:test', targetOrigin: 'https://example.com' },
  memory: { type: 'MemoryPersist', contentDigest: 'content', purpose: 'remember', scope: 'project' },
  ordinaryModel: { type: 'DataDisclose', contentDigest: 'content', classification: 'ordinary', purpose: 'answer', destination: 'model' },
  sensitiveModel: { type: 'DataDisclose', contentDigest: 'content', classification: 'sensitive', purpose: 'answer', destination: 'model' },
  credentialModel: { type: 'DataDisclose', contentDigest: 'content', classification: 'credential', purpose: 'answer', destination: 'model' },
} as const satisfies Record<string, CapabilityRequirement>;

describe('command risk and five-layer authorization', () => {
  it.each([
    ['workspace root deletion', { command: 'rm -rf /repo' }, '/repo', 'WORKSPACE_ROOT_DELETE'],
    ['sandbox workspace deletion', { command: 'rm -rf /workspace' }, undefined, 'WORKSPACE_ROOT_DELETE'],
    ['Windows sandbox workspace deletion', { command: 'Remove-Item -Recurse -Force C:\\Weave\\Cow' }, undefined, 'WORKSPACE_ROOT_DELETE'],
    ['current working directory deletion', { command: 'rm -rf .', cwd: '.' }, undefined, 'WORKSPACE_ROOT_DELETE'],
    ['host credential resource', { command: 'cat ~/.ssh/id_rsa' }, undefined, 'HOST_SECURITY_RESOURCE'],
    ['device IPC', { command: 'cat /dev/mem' }, undefined, 'HOST_DEVICE_OR_IPC'],
    ['privilege escalation', { command: 'sudo chmod 777 /etc' }, undefined, 'PRIVILEGE_ESCALATION'],
    ['credential disclosure', { command: 'echo API_KEY secret' }, undefined, 'CREDENTIAL_DISCLOSURE'],
    ['resource bomb', { command: ':(){ :|:& };:' }, undefined, 'RESOURCE_BOMB'],
  ])('hard-denies %s', (_name, input, workspaceRoot, code) => {
    expect(new CommandRiskCheck().evaluate(action('bash', [requirement.shell], input), workspaceRoot)).toMatchObject({
      verdict: 'hard_deny', code,
    });
  });

  it('marks ordinary high risk as ask instead of a hard denial', () => {
    const risk = new CommandRiskCheck().evaluate(action('bash', [requirement.shell], { command: 'curl https://example.com' }));
    expect(risk).toEqual({ schemaVersion: 1, ruleVersion: '1', verdict: 'risk', risks: ['NETWORK_TOOL', 'RAW_SHELL'] });
    expect(new AuthorizationEvaluator().evaluate({ action: action('bash', [requirement.shell]), mode: 'autonomous', commandRisk: risk }))
      .toMatchObject({ effect: 'ask', layer: 'confirmation' });
  });

  it('hard denial and path denial cannot be overridden by rules or mode', () => {
    const allowWrite = rule('allow-write', 'allow', 'FilesystemWrite');
    const evaluator = new AuthorizationEvaluator();
    expect(evaluator.evaluate({
      action: action('edit_file', [requirement.write]), mode: 'autonomous', rules: [allowWrite],
      commandRisk: { schemaVersion: 1, ruleVersion: '1', verdict: 'hard_deny', code: 'HOST_SECURITY_RESOURCE', risks: [] },
    })).toMatchObject({ effect: 'deny', layer: 'command_risk' });
    expect(evaluator.evaluate({
      action: action('edit_file', [requirement.write]), mode: 'autonomous', rules: [allowWrite],
      pathBoundary: { allowed: false, code: 'PATH_OUTSIDE_BOUNDARY' },
    })).toMatchObject({ effect: 'deny', layer: 'path_boundary' });
  });

  it('uses the fixed five-layer order and short-circuits only at a stronger boundary', () => {
    const evaluator = new AuthorizationEvaluator();
    expect(evaluator.evaluate({ action: action('edit_file', [requirement.write]), mode: 'supervised' }).evaluatedLayers)
      .toEqual(['command_risk', 'path_boundary', 'permission_rules', 'permission_mode', 'confirmation']);
    expect(evaluator.evaluate({
      action: action('edit_file', [requirement.write]),
      mode: 'autonomous',
      commandRisk: { schemaVersion: 1, ruleVersion: '1', verdict: 'hard_deny', code: 'HARD_DENY', risks: [] },
    }).evaluatedLayers).toEqual(['command_risk']);
    expect(evaluator.evaluate({
      action: action('edit_file', [requirement.write]),
      mode: 'autonomous',
      pathBoundary: { allowed: false },
    }).evaluatedLayers).toEqual(['command_risk', 'path_boundary']);
  });

  it('merges rules without order semantics and requires per-capability allow coverage', () => {
    expect(mergeEffects(['allow', 'deny', 'ask'])).toBe('deny');
    expect(mergeEffects(['ask', 'allow'])).toBe('ask');
    const processAllow = rule('process', 'allow', 'ProcessSpawn');
    const actionWithNetwork = action('run_process', [requirement.process, requirement.network]);
    const supervised = new AuthorizationEvaluator().evaluate({ action: actionWithNetwork, mode: 'supervised', rules: [processAllow] });
    expect(supervised).toMatchObject({ effect: 'ask', capabilityEffects: ['allow', 'ask'] });

    const networkAllow = rule('network', 'allow', 'NetworkEgress');
    const covered = new AuthorizationEvaluator().evaluate({ action: actionWithNetwork, mode: 'read_only', rules: [networkAllow, processAllow] });
    expect(covered).toMatchObject({ effect: 'allow', capabilityEffects: ['allow', 'allow'], code: 'AUTHORIZED_FOR_TICKETING' });
  });

  it('implements the complete three-mode capability matrix without full_access', () => {
    const modes = ['read_only', 'supervised', 'autonomous'] as const satisfies readonly PermissionMode[];
    expect(modes).not.toContain('full_access');
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.read))).toEqual(['allow', 'allow', 'allow']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.write))).toEqual(['deny', 'ask', 'allow']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.process))).toEqual(['deny', 'ask', 'allow']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.shell))).toEqual(['deny', 'ask', 'ask']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.network))).toEqual(['deny', 'ask', 'ask']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.credential))).toEqual(['deny', 'ask', 'ask']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.memory))).toEqual(['deny', 'ask', 'ask']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.ordinaryModel))).toEqual(['allow', 'allow', 'allow']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.sensitiveModel))).toEqual(['ask', 'ask', 'ask']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.credentialModel))).toEqual(['deny', 'deny', 'deny']);
    expect(modes.map((mode) => permissionModeEffect(mode, requirement.taskProcess))).toEqual(['deny', 'ask', 'ask']);
  });

  it('covers allow, ask, deny, and no-match combinations without allowing application execution', () => {
    const evaluator = new AuthorizationEvaluator();
    const write = action('edit_file', [requirement.write]);
    const effects = ['allow', 'ask', 'deny'] as const;
    for (const effect of effects) {
      const result = evaluator.evaluate({ action: write, mode: 'read_only', rules: [rule(effect, effect, 'FilesystemWrite')] });
      expect(result.effect).toBe(effect);
      if (effect === 'allow') expect(result.code).toBe('AUTHORIZED_FOR_TICKETING');
    }
    expect(evaluator.evaluate({ action: write, mode: 'read_only', rules: [] })).toMatchObject({
      effect: 'deny', capabilityEffects: ['deny'],
    });
    expect(evaluator.evaluate({
      action: write,
      mode: 'autonomous',
      rules: [{ ...rule('forged-project', 'allow', 'FilesystemWrite'), source: 'project' }],
    })).toMatchObject({ effect: 'deny', code: 'INVALID_PROJECT_ALLOW' });
  });

  it('preflights the whole batch before any external execution can begin', async () => {
    const audit = vi.fn();
    const execute = vi.fn();
    const result = await new BatchAuthorizationPreflight().perform([
      { action: action('read_file', [requirement.read], {}, 'read'), mode: 'supervised' },
      { action: action('edit_file', [requirement.write], {}, 'write'), mode: 'supervised' },
      { action: action('bash', [requirement.shell], {}, 'shell'), mode: 'read_only' },
    ], audit, execute);
    expect(audit).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result.preflight.allowed.map((item) => item.actionDigest)).toEqual(['read']);
    expect(result.preflight.ask.map((item) => item.actionDigest)).toEqual(['write']);
    expect(result.preflight.denied.map((item) => item.actionDigest)).toEqual(['shell']);
  });

  it('keeps Runner at zero calls when durable pre-execution audit fails', async () => {
    const audit = vi.fn(async () => { throw new Error('AUDIT_WRITE_FAILED'); });
    const execute = vi.fn();
    await expect(new BatchAuthorizationPreflight().perform([
      { action: action('read_file', [requirement.read]), mode: 'read_only' },
    ], audit, execute)).rejects.toThrow('AUDIT_WRITE_FAILED');
    expect(audit).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('task authorization state', () => {
  it('keeps grants narrow, issues per-call tickets, advances only on natural language, and revokes immediately', () => {
    let id = 0; let now = 100;
    const state = new TaskAuthorizationState('task-1', 4, () => `id-${++id}`, () => now);
    state.grantOnce('call-1', 'action-a');
    expect(state.hasGrant('call-2', 'action-a')).toBe(false);
    expect(state.hasGrant('call-1', 'action-a')).toBe(true);
    expect(state.hasGrant('call-1', 'action-a')).toBe(false);
    state.grantForTask('action-b', 'scope-b');
    expect(state.hasGrant('other', 'action-b', 'scope-b')).toBe(true);

    const first = state.issueTicket('run-1', 'call-1', 'action-a');
    const second = state.issueTicket('run-1', 'call-2', 'action-b');
    expect(first.ticketId).not.toBe(second.ticketId);
    expect(state.consumeTicket(first.ticketId)).toBe(first);
    expect(() => state.consumeTicket(first.ticketId)).toThrow('TICKET_REPLAY');
    expect(state.resolveHitl()).toBe(4);

    expect(state.advanceForNaturalLanguage()).toBe(5);
    expect(() => state.consumeTicket(second.ticketId)).toThrow('TICKET_INVALID_OR_EXPIRED');
    const third = state.issueTicket('run-2', 'call-3', 'action-c');
    state.revoke();
    expect(state.currentRevocationVersion).toBe(1);
    expect(() => state.consumeTicket(third.ticketId)).toThrow('TICKET_INVALID_OR_EXPIRED');
    now += 61_000;
  });

  it('expires one-time grants, task grants, and prepared tickets after their exact TTL boundary', () => {
    let id = 0; let now = 100;
    const state = new TaskAuthorizationState('task-1', 1, () => `ttl-id-${++id}`, () => now);
    state.grantOnce('boundary-call', 'boundary-action', 10);
    state.grantOnce('expired-call', 'expired-action', 10);
    state.grantForTask('task-action', 'task-scope', 10);
    const boundaryTicket = state.issueTicket('run-1', 'boundary-call', 'boundary-action', 10);
    const expiredTicket = state.issueTicket('run-1', 'expired-call', 'expired-action', 10);

    now = 110;
    expect(state.hasGrant('boundary-call', 'boundary-action')).toBe(true);
    expect(state.hasGrant('other-call', 'task-action', 'task-scope')).toBe(true);
    expect(state.consumeTicket(boundaryTicket.ticketId)).toBe(boundaryTicket);

    now = 111;
    expect(state.hasGrant('expired-call', 'expired-action')).toBe(false);
    expect(state.hasGrant('other-call', 'task-action', 'task-scope')).toBe(false);
    expect(() => state.consumeTicket(expiredTicket.ticketId)).toThrow('TICKET_INVALID_OR_EXPIRED');
  });

  it('remembers explicit denial by digest but not cancellation or changed parameters', () => {
    const memory = new TaskDenialMemory();
    memory.record('same-action', 'deny');
    memory.record('cancelled-action', 'cancel');
    expect(memory.contains('same-action')).toBe(true);
    expect(memory.contains('changed-action')).toBe(false);
    expect(memory.contains('cancelled-action')).toBe(false);
  });
});

function action(
  actionType: string,
  requirements: readonly CapabilityRequirement[],
  input: JsonValue = {},
  digest = `digest-${actionType}`,
): NormalizedAction {
  return {
    schemaVersion: 1,
    actionId: `action-${actionType}`,
    actionType,
    input,
    manifest: { schemaVersion: 1, requirements },
    digest,
  };
}

function rule(
  id: string,
  effect: PermissionRule['effect'],
  capability: PermissionRule['target']['capability'],
): PermissionRule {
  return { schemaVersion: 1, id, effect, source: 'user', target: { capability } };
}
