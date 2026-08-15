import type {
  ChatMessage,
  AuthorizationDecisionItem,
  AuthorizationRequestView,
  EnvironmentContext,
  LlmProtocol,
  MessageContent,
  ModelExchangeInput,
  ModelExchangeResponse,
  RuntimeStateContext,
  ToolExecutionBatch,
  ToolExecutionHooks,
  ToolDefinitionScope,
  ToolCallResult,
  ToolDefinition,
} from '../shared/types.js';
import type { DataClassification, GatewayRequest, NormalizedAction, PermissionMode } from './domain.js';
import type { CapabilityTicket } from './domain.js';
import { deepFreeze, parseGatewayRequest, SECURITY_SCHEMA_VERSION } from './domain.js';
import { InputGuard, OutputGuard } from './data-guards.js';
import { createSecurityDigestKey, SecurityDigests } from './digests.js';
import {
  AuthorizationEvaluator,
  CommandRiskCheck,
  PendingAuthorization,
  PermissionCancelledError,
  SecurityIntegrityFailureError,
  TaskAuthorizationState,
  TaskDenialMemory,
  type PermissionRule,
} from './authorization.js';
import { PathCapabilityBoundary } from './path-boundary.js';
import { SecureContextLedger } from './secure-context.js';
import type { SecurityAuditParticipant, SecurityAuditRecord, SecurityAuditTaskResource } from './audit.js';
import { SecurityInternalResourceRegistry } from './internal-resources.js';
import { executionActionDigest, executionCapabilityDigest, normalizeToolCall } from './action-normalizer.js';
import { CapabilityTicketIssuer } from './tickets.js';

export interface OpenActionTaskInput {
  readonly schemaVersion: typeof SECURITY_SCHEMA_VERSION;
  readonly taskId: string;
  readonly policySnapshotId: string;
  readonly permissionMode: PermissionMode;
  readonly modelDestination: {
    readonly profile: string;
    readonly protocol: LlmProtocol;
    readonly model: string;
    readonly origin: string;
    readonly credentialRef: string;
  };
  readonly pathBoundary: {
    readonly readRoots: readonly string[];
    readonly writeRoots: readonly string[];
  };
  readonly workspaceRoot?: string;
  readonly securityInternalRoots?: readonly string[];
  readonly ticketVerificationKey?: string;
  readonly permissionRules?: readonly PermissionRule[];
  readonly authorizationEpoch: number;
  readonly toolsEnabled: boolean;
  readonly modelContext?: {
    readonly messages: readonly ChatMessage[];
    readonly currentUserInput?: string;
    readonly maxTokens: number;
    readonly environment?: EnvironmentContext;
  };
}

export type TaskCloseReason = 'completed' | 'cancelled' | 'failed' | 'security_integrity_failure';

export interface TaskLifecycleResource {
  close(reason: TaskCloseReason): Promise<void>;
}

export interface TaskLifecycleParticipant {
  openTask(input: OpenActionTaskInput): Promise<TaskLifecycleResource>;
}

export interface ActionRunnerTaskResource extends TaskLifecycleResource {
  readonly securityContext?: { readonly runnerId: string; readonly sandboxId: string };
  definitions(scope: ToolDefinitionScope): readonly ToolDefinition[];
  execute(
    calls: readonly import('../shared/types.js').ToolCallRequest[],
    signal: AbortSignal,
    previousCalls?: number,
    hooks?: ToolExecutionHooks,
  ): Promise<ToolExecutionBatch>;
  executeAuthorized?(
    actions: readonly {
      readonly call: import('../shared/types.js').ToolCallRequest;
      readonly issueTicket: () => CapabilityTicket;
    }[],
    signal: AbortSignal,
    previousCalls?: number,
    hooks?: ToolExecutionHooks,
  ): Promise<ToolExecutionBatch>;
}

export interface ActionRunnerParticipant {
  openTask(input: OpenActionTaskInput, audit?: SecurityAuditTaskResource): Promise<ActionRunnerTaskResource>;
}

export interface ModelProviderTaskResource extends TaskLifecycleResource {
  exchange(input: ModelExchangeInput, signal: AbortSignal): Promise<ModelExchangeResponse>;
}

export interface ModelProviderParticipant {
  openTask(input: OpenActionTaskInput): Promise<ModelProviderTaskResource>;
}

export interface PrepareModelExchangeInput {
  readonly runId: string;
  readonly iteration: number;
  readonly runtime: RuntimeStateContext;
  readonly businessTools?: readonly ToolDefinition[];
  readonly controlTools?: readonly ToolDefinition[];
  readonly tools?: readonly ToolDefinition[];
}

export interface SafeProposalAction {
  readonly callId: string;
  readonly toolName: string;
  readonly actionDigest: string;
  readonly kind: 'business' | 'control';
  readonly summary: string;
}

export interface ActionModelExchangeResponse extends Omit<ModelExchangeResponse, 'calls'> {
  readonly proposalBatch?: {
    readonly proposalBatchRef: string;
    readonly actions: readonly SafeProposalAction[];
  };
}

export type ActionBatchOutcome =
  | { readonly kind: 'business'; readonly actions: readonly SafeProposalAction[]; readonly batch: ToolExecutionBatch }
  | { readonly kind: 'control'; readonly calls: readonly import('../shared/types.js').ToolCallRequest[] }
  | { readonly kind: 'invalid'; readonly results: readonly ToolCallResult[] };

export interface ActionBatchHooks {
  readonly onStart?: (action: Pick<SafeProposalAction, 'callId' | 'toolName'>) => void;
  readonly onAuthorizationRequested?: (request: AuthorizationRequestView) => void;
}

export interface ActionTask {
  readonly taskId: string;
  readonly sessionId: string;
  capabilities(): { readonly tools: readonly string[]; readonly openedAt: number };
  definitions(scope: ToolDefinitionScope): readonly ToolDefinition[];
  prepareModelExchange(input: PrepareModelExchangeInput): Extract<GatewayRequest, { type: 'model_exchange' }>;
  performModelExchange(
    request: Extract<GatewayRequest, { type: 'model_exchange' }>,
    signal: AbortSignal,
  ): Promise<ActionModelExchangeResponse>;
  prepareActionBatch(runId: string, proposalBatchRef: string): Extract<GatewayRequest, { type: 'action_batch' }>;
  performActionBatch(
    request: Extract<GatewayRequest, { type: 'action_batch' }>,
    signal: AbortSignal,
    previousCalls?: number,
    hooks?: ActionBatchHooks,
  ): Promise<ActionBatchOutcome>;
  resolveAuthorization(input: {
    readonly taskId: string;
    readonly runId: string;
    readonly authorizationRequestId: string;
    readonly authorizationEpoch: number;
    readonly decisions: readonly AuthorizationDecisionItem[];
  }): void;
  appendResults(
    results: readonly ToolCallResult[],
    runId?: string,
    hooks?: ActionBatchHooks,
    signal?: AbortSignal,
  ): Promise<readonly ToolCallResult[]>;
  appendUserInput(content: string): void;
  close(reason: TaskCloseReason): Promise<void>;
}

export interface ActionGateway {
  openTask(input: OpenActionTaskInput): Promise<ActionTask>;
}

export interface ActionGatewayDependencies {
  readonly provider: ModelProviderParticipant;
  readonly runner: ActionRunnerParticipant;
  readonly audit: SecurityAuditParticipant;
  readonly createId: () => string;
  readonly now: () => number;
}

export class ActionTaskClosedError extends Error {
  constructor(taskId: string) {
    super(`Action Task ${taskId} is closed`);
    this.name = 'ActionTaskClosedError';
  }
}

export class ActionGatewayImpl implements ActionGateway {
  private readonly activeTaskIds = new Set<string>();
  private readonly ticketIssuer = new CapabilityTicketIssuer();

  constructor(private readonly dependencies: ActionGatewayDependencies) {}

  async openTask(input: OpenActionTaskInput): Promise<ActionTask> {
    validateOpenInput(input);
    if (this.activeTaskIds.has(input.taskId)) throw new Error(`TASK_ALREADY_OPEN: ${input.taskId}`);

    const snapshot = freezeOpenInput({ ...input, ticketVerificationKey: this.ticketIssuer.publicKey });
    const resources: TaskLifecycleResource[] = [];
    this.activeTaskIds.add(snapshot.taskId);
    try {
      const provider = await this.dependencies.provider.openTask(snapshot);
      resources.push(provider);
      const audit = await this.dependencies.audit.openTask(snapshot);
      resources.push(audit);
      const runner = await this.dependencies.runner.openTask(snapshot, audit);
      resources.push(runner);
      if (snapshot.toolsEnabled && runner.definitions('all').length === 0) {
        throw new Error('SANDBOX_UNAVAILABLE: 当前没有已认证的工具能力切片');
      }
      return new ActionTaskImpl(
        snapshot.taskId,
        this.dependencies.createId(),
        this.dependencies.now(),
        this.dependencies.now,
        snapshot,
        provider,
        runner,
        audit,
        this.ticketIssuer,
        this.dependencies.createId,
        resources,
        () => this.activeTaskIds.delete(snapshot.taskId),
      );
    } catch (error) {
      this.activeTaskIds.delete(snapshot.taskId);
      await closeResources(resources, 'failed');
      throw error;
    }
  }
}

class ActionTaskImpl implements ActionTask {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private readonly report: { readonly tools: readonly string[]; readonly openedAt: number };
  private readonly ledger: SecureContextLedger;
  private readonly digests = new SecurityDigests(createSecurityDigestKey());
  private readonly inputGuard = new InputGuard();
  private readonly outputGuard = new OutputGuard();
  private readonly availableDefinitions: readonly ToolDefinition[];
  private readonly authorization: TaskAuthorizationState;
  private readonly denialMemory = new TaskDenialMemory();
  private readonly riskCheck = new CommandRiskCheck();
  private readonly evaluator = new AuthorizationEvaluator();
  private readonly pathBoundary: PathCapabilityBoundary;
  private readonly internalResources: SecurityInternalResourceRegistry;
  private pendingAuthorization: PendingAuthorization | undefined;
  private readonly pendingExchanges = new Map<string, PrepareModelExchangeInput>();
  private readonly proposalBatches = new Map<string, {
    readonly runId: string;
    readonly iteration: number;
    readonly requestId: string;
    readonly authorizationEpoch: number;
    readonly expiresAt: number;
    readonly proposalDigest: string;
    readonly allowedToolNames: readonly string[];
    readonly calls: readonly import('../shared/types.js').ToolCallRequest[];
    readonly actions: readonly SafeProposalAction[];
  }>();

  constructor(
    readonly taskId: string,
    readonly sessionId: string,
    openedAt: number,
    private readonly now: () => number,
    private readonly snapshot: OpenActionTaskInput,
    private readonly provider: ModelProviderTaskResource,
    private readonly runner: ActionRunnerTaskResource,
    private readonly audit: SecurityAuditTaskResource,
    private readonly ticketIssuer: CapabilityTicketIssuer,
    private readonly createId: () => string,
    private readonly resources: readonly TaskLifecycleResource[],
    private readonly onClosed: () => void,
  ) {
    this.authorization = new TaskAuthorizationState(taskId, snapshot.authorizationEpoch, createId, this.now);
    this.pathBoundary = new PathCapabilityBoundary({
      workspaceRoot: snapshot.workspaceRoot ?? process.cwd(),
      readRoots: snapshot.pathBoundary.readRoots,
      writeRoots: snapshot.pathBoundary.writeRoots,
    });
    this.internalResources = new SecurityInternalResourceRegistry(snapshot.securityInternalRoots ?? []);
    this.availableDefinitions = deepFreeze(snapshot.toolsEnabled
      ? structuredClone(runner.definitions('all'))
      : []);
    this.report = deepFreeze({ tools: this.availableDefinitions.map((tool) => tool.name), openedAt });
    this.ledger = new SecureContextLedger({
      taskId,
      digests: this.digests,
      createId,
    });
    for (const [index, message] of (snapshot.modelContext?.messages ?? []).entries()) {
      const classification = this.inputGuard.classifyOptionalContext(serializeMessage(message));
      const historyMessage: ChatMessage = {
        role: 'user',
        content: JSON.stringify({
          kind: 'public_transcript',
          sourceRole: message.role,
          trust: 'untrusted_context',
          content: message.content,
        }),
      };
      this.ledger.acceptMessage({
        message: historyMessage,
        source: { kind: 'history', reference: `public-transcript:${index}` },
        classification,
        purpose: 'public_transcript_context',
        destinations: classification === 'ordinary' ? ['model'] : [],
        required: false,
      });
    }
    if (snapshot.modelContext?.currentUserInput !== undefined) {
      this.acceptCurrentUserInput(snapshot.modelContext.currentUserInput);
    }
  }

  capabilities(): { readonly tools: readonly string[]; readonly openedAt: number } {
    this.assertOpen();
    return this.report;
  }

  definitions(scope: ToolDefinitionScope): readonly ToolDefinition[] {
    this.assertOpen();
    if (scope === 'none') return [];
    const readOnly = scope === 'read_only' || this.snapshot.permissionMode === 'read_only';
    const definitions = readOnly
      ? this.availableDefinitions.filter((tool) => tool.executionMode === 'read_shared')
      : this.availableDefinitions;
    return deepFreeze(structuredClone(definitions));
  }

  prepareModelExchange(input: PrepareModelExchangeInput): Extract<GatewayRequest, { type: 'model_exchange' }> {
    this.assertOpen();
    if (this.snapshot.modelContext === undefined) throw new Error('MODEL_EXCHANGE_UNAVAILABLE: Task 缺少模型上下文');
    if (!Number.isInteger(input.iteration) || input.iteration < 1) throw new TypeError('iteration must be a positive integer');
    if (input.runId.length === 0) throw new TypeError('runId must not be empty');
    const requestId = this.createId();
    const modelExchangeRef = this.createId();
    const available = new Map(this.definitions('all').map((tool) => [tool.name, tool]));
    const businessTools = (input.businessTools ?? [])
      .map((tool) => available.get(tool.name))
      .filter((tool): tool is ToolDefinition => tool !== undefined);
    this.pendingExchanges.set(modelExchangeRef, deepFreeze({
      ...input,
      businessTools,
      controlTools: [...(input.controlTools ?? input.tools ?? [])],
    }));
    return deepFreeze({
      schemaVersion: SECURITY_SCHEMA_VERSION,
      type: 'model_exchange',
      taskId: this.taskId,
      runId: input.runId,
      requestId,
      modelExchangeRef,
    });
  }

  async performModelExchange(
    input: Extract<GatewayRequest, { type: 'model_exchange' }>,
    signal: AbortSignal,
  ): Promise<ActionModelExchangeResponse> {
    this.assertOpen();
    const request = parseGatewayRequest(input);
    if (request.type !== 'model_exchange' || request.taskId !== this.taskId) {
      throw new Error('MODEL_EXCHANGE_REF_INVALID: 请求不属于当前 Task');
    }
    const pending = this.pendingExchanges.get(request.modelExchangeRef);
    if (pending === undefined || pending.runId !== request.runId) {
      throw new Error('MODEL_EXCHANGE_REF_INVALID: 引用不存在、已消费或绑定不匹配');
    }
    this.pendingExchanges.delete(request.modelExchangeRef);
    const context = this.snapshot.modelContext;
    if (context === undefined) throw new Error('MODEL_EXCHANGE_UNAVAILABLE: Task 缺少模型上下文');
    const response = await this.provider.exchange({
      destination: {
        profile: this.snapshot.modelDestination.profile,
        protocol: this.snapshot.modelDestination.protocol,
        model: this.snapshot.modelDestination.model,
        origin: this.snapshot.modelDestination.origin,
      },
      runtime: pending.runtime,
      ...(context.environment === undefined ? {} : { environment: context.environment }),
      tools: [...(pending.businessTools ?? []), ...(pending.controlTools ?? pending.tools ?? [])],
      messages: this.ledger.messagesFor('model'),
      maxTokens: context.maxTokens,
    }, signal);
    const blocks: readonly MessageContent[] = [
      ...(response.text === '' ? [] : [{ type: 'text' as const, text: response.text }]),
      ...response.calls.map((call) => ({ type: 'tool_call' as const, call })),
    ];
    if (blocks.length > 0) {
      const message: ChatMessage = { role: 'assistant', content: structuredClone(blocks) };
      const classification = this.outputGuard.guardComplete(serializeMessage(message));
      this.ledger.acceptMessage({
        message,
        source: { kind: 'model', reference: request.requestId },
        classification,
        purpose: 'model_response',
        destinations: ['model'],
        required: false,
      });
    }
    if (response.calls.length === 0) {
      return deepFreeze({ text: response.text, completion: response.completion, audit: response.audit });
    }
    const controlNames = new Set((pending.controlTools ?? pending.tools ?? []).map((tool) => tool.name));
    const allowedToolNames = [
      ...(pending.businessTools ?? []).map((tool) => tool.name),
      ...controlNames,
    ];
    const actions = response.calls.map((call): SafeProposalAction => deepFreeze({
      callId: call.callId,
      toolName: call.name,
      actionDigest: this.digests.action({ name: call.name, input: call.input }),
      kind: controlNames.has(call.name) ? 'control' : 'business',
      summary: `调用 ${call.name}`,
    }));
    const proposalBatchRef = this.createId();
    this.proposalBatches.set(proposalBatchRef, deepFreeze({
      runId: request.runId,
      iteration: pending.iteration,
      requestId: request.requestId,
      authorizationEpoch: this.authorization.authorizationEpoch,
      expiresAt: this.now() + 60_000,
      proposalDigest: this.digests.action(response.calls),
      allowedToolNames,
      calls: structuredClone(response.calls),
      actions,
    }));
    return deepFreeze({
      text: response.text,
      completion: response.completion,
      audit: response.audit,
      proposalBatch: { proposalBatchRef, actions },
    });
  }

  prepareActionBatch(runId: string, proposalBatchRef: string): Extract<GatewayRequest, { type: 'action_batch' }> {
    this.assertOpen();
    if (runId.length === 0 || proposalBatchRef.length === 0) throw new TypeError('Action batch binding must not be empty');
    return deepFreeze({
      schemaVersion: SECURITY_SCHEMA_VERSION,
      type: 'action_batch',
      taskId: this.taskId,
      runId,
      requestId: this.createId(),
      proposalBatchRef,
    });
  }

  async performActionBatch(
    input: Extract<GatewayRequest, { type: 'action_batch' }>,
    signal: AbortSignal,
    previousCalls = 0,
    hooks: ActionBatchHooks = {},
  ): Promise<ActionBatchOutcome> {
    this.assertOpen();
    const request = parseGatewayRequest(input);
    if (request.type !== 'action_batch' || request.taskId !== this.taskId) throw new Error('PROPOSAL_BATCH_REF_INVALID: 请求不属于当前 Task');
    const proposal = this.proposalBatches.get(request.proposalBatchRef);
    if (
      proposal === undefined
      || proposal.runId !== request.runId
      || proposal.authorizationEpoch !== this.authorization.authorizationEpoch
      || proposal.expiresAt < this.now()
      || proposal.proposalDigest !== this.digests.action(proposal.calls)
    ) {
      throw new Error('PROPOSAL_BATCH_REF_INVALID: 引用不存在、已消费或绑定不匹配');
    }
    this.proposalBatches.delete(request.proposalBatchRef);
    const allowedToolNames = new Set(proposal.allowedToolNames);
    const knownToolNames = new Set(this.availableDefinitions.map((definition) => definition.name));
    const controls = proposal.actions.filter((action) => action.kind === 'control');
    const business = proposal.actions.filter((action) => action.kind === 'business');
    if (controls.length > 0 && (business.length > 0 || controls.length !== 1)) {
      const results = proposal.calls.map((call) => gatewayErrorResult(call, 'MIXED_CONTROL_CALLS', '业务工具与控制工具不得混用，且一次只能调用一个控制工具。'));
      const terminalResults = await this.appendResults(results, request.runId, hooks, signal);
      return deepFreeze({ kind: 'invalid', results: terminalResults });
    }
    if (business.length > 32) {
      const results = proposal.calls.map((call) => gatewayErrorResult(call, 'TOOL_BATCH_LIMIT_EXCEEDED', '单个模型响应最多允许 32 个业务工具调用。'));
      const terminalResults = await this.appendResults(results, request.runId, hooks, signal);
      return deepFreeze({ kind: 'invalid', results: terminalResults });
    }
    if (controls.length === 1) return deepFreeze({ kind: 'control', calls: structuredClone(proposal.calls) });
    const normalized = proposal.calls.map((call) => allowedToolNames.has(call.name)
      ? normalizeToolCall(
        call,
        proposal.actions.find((action) => action.callId === call.callId)?.actionDigest ?? this.digests.action({ name: call.name, input: call.input }),
      )
      : undefined);
    const denied = new Map<string, ToolCallResult>();
    const decisions = await Promise.all(normalized.map(async (action, index) => {
      const call = proposal.calls[index]!;
      if (action === undefined) return undefined;
      let pathAssessment: import('./authorization.js').PathBoundaryAssessment | undefined;
      const internalAssessment = this.internalResources.assess(action);
      if (!internalAssessment.allowed) pathAssessment = internalAssessment;
      for (const requirement of action.manifest.requirements) {
        if (pathAssessment !== undefined) break;
        if (requirement.type !== 'FilesystemRead' && requirement.type !== 'FilesystemWrite') continue;
        for (const path of requirement.paths) {
          const assessment = await this.pathBoundary.check(requirement.type === 'FilesystemRead' ? 'read' : 'write', path);
          if (!assessment.allowed) { pathAssessment = assessment; break; }
        }
        if (pathAssessment !== undefined) break;
      }
      if (this.denialMemory.contains(action.digest)) {
        return { action, call, effect: 'deny' as const, code: 'PREVIOUSLY_DENIED', risks: [] as readonly string[] };
      }
      if (this.authorization.hasGrant(call.callId, action.digest, action.digest)) {
        return { action, call, effect: 'allow' as const, code: 'TASK_GRANT', risks: [] as readonly string[] };
      }
      const evaluated = this.evaluator.evaluate({
        action,
        mode: this.snapshot.permissionMode,
        rules: this.snapshot.permissionRules,
        commandRisk: this.riskCheck.evaluate(action, this.snapshot.workspaceRoot ?? process.cwd()),
        ...(pathAssessment === undefined ? {} : { pathBoundary: pathAssessment }),
      });
      return {
        action, call, effect: evaluated.effect, code: evaluated.code, risks: evaluated.risks,
        matchedRuleIds: evaluated.matchedRuleIds,
      };
    }));
    let invalidToolSeen = false;
    for (const [index, item] of decisions.entries()) {
      if (item !== undefined && !invalidToolSeen) continue;
      const call = proposal.calls[index]!;
      if (!invalidToolSeen) {
        invalidToolSeen = true;
        const known = knownToolNames.has(call.name);
        denied.set(call.callId, gatewayErrorResult(
          call,
          known ? 'TOOL_NOT_AVAILABLE' : 'UNKNOWN_TOOL',
          known ? '该工具不在当前 Task 的最小能力集合中。' : '请求的工具不存在。',
        ));
      } else {
        denied.set(call.callId, gatewayErrorResult(call, 'PRIOR_WRITE_FAILED', '前序未知工具形成写入屏障，本调用未执行。'));
      }
    }
    const userChoices = new Map<string, AuthorizationDecisionItem['choice']>();
    const ask = decisions.filter((item): item is NonNullable<typeof item> => item?.effect === 'ask');
    if (ask.length > 0) {
      if (this.pendingAuthorization !== undefined) throw new Error('AUTHORIZATION_ALREADY_PENDING');
      const authorizationRequest: AuthorizationRequestView = deepFreeze({
        taskId: this.taskId,
        runId: request.runId,
        authorizationRequestId: this.createId(),
        authorizationEpoch: this.authorization.authorizationEpoch,
        items: ask.map((item) => ({
          callId: item.call.callId,
          actionDigest: item.action.digest,
          toolName: item.call.name,
          summary: `授权 ${item.call.name}`,
          capabilityTypes: item.action.manifest.requirements.map((requirement) => requirement.type),
          risks: item.risks,
        })),
      });
      const pending = new PendingAuthorization(authorizationRequest);
      this.pendingAuthorization = pending;
      hooks.onAuthorizationRequested?.(authorizationRequest);
      let resolutions: readonly AuthorizationDecisionItem[];
      try {
        resolutions = await pending.wait(signal);
      } finally {
        if (this.pendingAuthorization === pending) this.pendingAuthorization = undefined;
      }
      this.authorization.resolveHitl();
      const resolutionByDigest = new Map(resolutions.map((item) => [item.actionDigest, item.choice]));
      for (const item of ask) {
        const choice = resolutionByDigest.get(item.action.digest)!;
        userChoices.set(item.action.digest, choice);
      }
      try {
        await this.audit.append(ask.map((item) => {
          const choice = userChoices.get(item.action.digest)!;
          return this.auditRecord({
            phase: 'hitl', runId: request.runId, callId: item.call.callId,
            actionId: item.action.actionId, actionDigest: item.action.digest,
            actionSummary: `Authorization ${item.call.name}`,
            capabilityTypes: item.action.manifest.requirements.map((requirement) => requirement.type),
            risks: item.risks, ruleIds: item.matchedRuleIds,
            permissionMode: this.snapshot.permissionMode,
            userDecision: choice,
            outcome: choice === 'deny' || choice === 'cancel' ? 'denied' : 'allowed',
          });
        }));
      } catch {
        this.authorization.revoke();
        throw new SecurityIntegrityFailureError('HITL_AUDIT_FAILED', 'Authorization decision audit failed before execution');
      }
      for (const item of ask) {
        const choice = userChoices.get(item.action.digest)!;
        if (choice === 'cancel') throw new PermissionCancelledError();
        if (choice === 'deny') {
          this.denialMemory.record(item.action.digest, 'deny');
          denied.set(item.call.callId, gatewayErrorResult(item.call, 'PERMISSION_DENIED', '用户拒绝了该动作。'));
        } else if (choice === 'allow_once') {
          this.authorization.grantOnce(item.call.callId, item.action.digest);
          this.authorization.hasGrant(item.call.callId, item.action.digest);
        } else {
          this.authorization.grantForTask(item.action.digest, item.action.digest);
        }
      }
    }
    for (const item of decisions) {
      if (item?.effect === 'deny') denied.set(item.call.callId, gatewayErrorResult(item.call, item.code, '动作未通过授权预检。'));
    }
    try {
      await this.audit.append(proposal.calls.map((call, index) => {
        const item = decisions[index];
        const safeAction = proposal.actions[index];
        const error = denied.get(call.callId)?.content.error;
        return this.auditRecord({
          phase: 'preflight', runId: request.runId, callId: call.callId,
          actionId: item?.action.actionId,
          actionDigest: item?.action.digest ?? safeAction?.actionDigest,
          actionSummary: safeAction?.summary ?? `调用 ${call.name}`,
          capabilityTypes: item?.action.manifest.requirements.map((requirement) => requirement.type),
          risks: item?.risks,
          ruleIds: item?.matchedRuleIds,
          permissionMode: this.snapshot.permissionMode,
          userDecision: item === undefined ? 'not_required' : userChoices.get(item.action.digest) ?? 'not_required',
          outcome: error === undefined ? 'allowed' : 'denied',
          errorCategory: error?.code,
        });
      }));
    } catch {
      this.authorization.revoke();
      throw new SecurityIntegrityFailureError('PREFLIGHT_AUDIT_FAILED', '执行前安全审计无法持久化，Task 已终止。');
    }
    const allowedCalls = proposal.calls.filter((call) => !denied.has(call.callId));
    const byCallId = new Map(proposal.actions.map((action) => [action.callId, action]));
    const executed = allowedCalls.length === 0 ? {
      results: [] as readonly ToolCallResult[],
      totalCalls: previousCalls + denied.size,
      businessToolLimitReached: false,
    } : this.runner.executeAuthorized === undefined
      ? await this.runner.execute(allowedCalls, signal, previousCalls + denied.size, {
        onStart: (call) => {
          const action = byCallId.get(call.callId);
          if (action !== undefined) hooks.onStart?.({ callId: action.callId, toolName: action.toolName });
        },
      })
      : await this.runner.executeAuthorized(allowedCalls.map((call) => {
        const context = this.runner.securityContext;
        if (context === undefined) throw new SecurityIntegrityFailureError('RUNNER_IDENTITY_MISSING', 'Secure Runner identity is unavailable');
        const actionDigest = executionActionDigest(call);
        const normalizedAction = normalizeToolCall(call, actionDigest);
        if (normalizedAction === undefined) throw new SecurityIntegrityFailureError('TICKET_NORMALIZATION_FAILED', 'Authorized action cannot be normalized for ticketing');
        return {
          call,
          issueTicket: () => {
            const issuedAt = this.now();
            return this.ticketIssuer.issue({
              ticketId: this.createId(), runnerId: context.runnerId, sandboxId: context.sandboxId,
              taskId: this.taskId, runId: request.runId, callId: call.callId,
              actionDigest, capabilityDigest: executionCapabilityDigest(normalizedAction),
              policyVersion: this.snapshot.policySnapshotId,
              revocationVersion: this.authorization.currentRevocationVersion,
              authorizationEpoch: this.authorization.authorizationEpoch,
              nonce: this.createId(), issuedAt, expiresAt: issuedAt + 60_000,
            });
          },
        };
      }), signal, previousCalls + denied.size, {
      onStart: (call) => {
        const action = byCallId.get(call.callId);
        if (action !== undefined) hooks.onStart?.({ callId: action.callId, toolName: action.toolName });
      },
    });
    const executedByCallId = new Map(executed.results.map((result) => [result.callId, result]));
    const results = proposal.calls.map((call) => denied.get(call.callId) ?? executedByCallId.get(call.callId)!)
      .filter((result): result is ToolCallResult => result !== undefined);
    const batch = {
      results,
      totalCalls: executed.totalCalls,
      businessToolLimitReached: executed.businessToolLimitReached,
    };
    try {
      await this.audit.append(results.map((result) => {
        const safeAction = byCallId.get(result.callId);
        return this.auditRecord({
          phase: 'outcome', runId: request.runId, callId: result.callId,
          actionDigest: safeAction?.actionDigest,
          actionSummary: safeAction?.summary ?? `调用 ${result.toolName}`,
          outcome: result.isError ? 'failed' : 'succeeded',
          errorCategory: result.content.error?.code,
        });
      }));
    } catch {
      this.authorization.revoke();
      throw new SecurityIntegrityFailureError(
        'OUTCOME_AUDIT_FAILED',
        allowedCalls.length > 0
          ? '动作效果可能已经发生，但结果审计失败且结果未释放。'
          : '结果审计失败，结果未释放。',
        allowedCalls.length > 0,
      );
    }
    const terminalResults = await this.appendResults(results, request.runId, hooks, signal);
    return deepFreeze({ kind: 'business', actions: business, batch: { ...batch, results: terminalResults } });
  }

  resolveAuthorization(input: Parameters<ActionTask['resolveAuthorization']>[0]): void {
    this.assertOpen();
    const pending = this.pendingAuthorization;
    if (pending === undefined) throw new Error('STALE_AUTHORIZATION_REQUEST');
    pending.resolve(input);
  }

  async appendResults(
    results: readonly ToolCallResult[],
    runId = 'internal',
    hooks: ActionBatchHooks = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<readonly ToolCallResult[]> {
    this.assertOpen();
    if (results.length === 0) return [];
    const message: ChatMessage = {
      role: 'tool',
      content: structuredClone(results.map((result) => ({ type: 'tool_result' as const, result }))),
    };
    const serialized = serializeMessage(message);
    const classification = this.inputGuard.classifyOptionalContext(serialized);
    if (classification === 'credential') this.outputGuard.guardComplete(serialized);
    const sourceReference = results.map((result) => result.callId).join(',');
    const contentDigest = this.digests.content(message);
    const modelDisclosure = this.createDisclosureAction(contentDigest, classification, sourceReference, 'model');
    const terminalDisclosure = this.createDisclosureAction(contentDigest, classification, sourceReference, 'terminal');
    const modelDisclosed = await this.authorizeDisclosure(modelDisclosure, classification, runId, hooks, signal);
    const terminalDisclosed = await this.authorizeDisclosure(terminalDisclosure, classification, runId, hooks, signal);
    if (modelDisclosed || terminalDisclosed) this.outputGuard.guardComplete(serialized, true);
    this.ledger.acceptMessage({
      message,
      source: { kind: 'tool', reference: sourceReference },
      classification,
      purpose: 'tool_result',
      destinations: modelDisclosed ? ['model'] : [],
      required: false,
    });
    if (!modelDisclosed) {
      this.ledger.acceptMessage({
        message: disclosureDeniedResult(results),
        source: { kind: 'runtime', reference: 'data-disclose-policy' },
        classification: 'ordinary',
        purpose: 'tool_result_disclosure_denied',
        destinations: ['model'],
        required: false,
      });
    }
    return terminalDisclosed ? deepFreeze(structuredClone(results)) : disclosureDeniedResults(results, 'terminal');
  }

  private createDisclosureAction(
    contentDigest: string,
    classification: DataClassification,
    sourceReference: string,
    destination: 'model' | 'terminal',
  ): NormalizedAction {
    const input = {
      contentDigest,
      sourceReference,
      classification,
      purpose: 'tool_result',
      destination,
    } as const;
    return deepFreeze({
      schemaVersion: SECURITY_SCHEMA_VERSION,
      actionId: `disclosure:${this.createId()}`,
      actionType: 'data_disclose',
      input,
      manifest: {
        schemaVersion: SECURITY_SCHEMA_VERSION,
        requirements: [{
          type: 'DataDisclose',
          contentDigest,
          classification,
          purpose: 'tool_result',
          destination,
        }],
      },
      digest: this.digests.action(input),
    });
  }

  private async authorizeDisclosure(
    action: NormalizedAction,
    classification: DataClassification,
    runId: string,
    hooks: ActionBatchHooks,
    signal: AbortSignal,
  ): Promise<boolean> {
    const destination = (action.manifest.requirements[0] as Extract<
      NormalizedAction['manifest']['requirements'][number], { type: 'DataDisclose' }
    >).destination;
    let effect: 'allow' | 'ask' | 'deny';
    let code: string;
    let risks: readonly string[] = [];
    let matchedRuleIds: readonly string[] = [];
    let userDecision: AuthorizationDecisionItem['choice'] | 'not_required' = 'not_required';

    if (this.denialMemory.contains(action.digest)) {
      effect = 'deny';
      code = 'PREVIOUSLY_DENIED';
    } else if (this.authorization.hasGrant(action.actionId, action.digest, action.digest)) {
      effect = 'allow';
      code = 'TASK_GRANT';
    } else {
      const evaluated = this.evaluator.evaluate({
        action,
        mode: this.snapshot.permissionMode,
        rules: this.snapshot.permissionRules,
        commandRisk: { schemaVersion: 1, ruleVersion: '1', verdict: 'clear', risks: [] },
      });
      effect = evaluated.effect;
      code = evaluated.code;
      risks = evaluated.risks;
      matchedRuleIds = evaluated.matchedRuleIds;
    }

    if (effect === 'ask') {
      if (hooks.onAuthorizationRequested === undefined) {
        effect = 'deny';
        code = 'DATA_DISCLOSURE_AUTHORIZATION_REQUIRED';
      } else {
        if (this.pendingAuthorization !== undefined) throw new Error('AUTHORIZATION_ALREADY_PENDING');
        const request: AuthorizationRequestView = deepFreeze({
          taskId: this.taskId,
          runId,
          authorizationRequestId: this.createId(),
          authorizationEpoch: this.authorization.authorizationEpoch,
          items: [{
            callId: action.actionId,
            actionDigest: action.digest,
            toolName: 'data_disclose',
            summary: `授权工具结果披露到${destination === 'model' ? '模型' : '终端'}`,
            capabilityTypes: ['DataDisclose'],
            risks,
          }],
        });
        const pending = new PendingAuthorization(request);
        this.pendingAuthorization = pending;
        hooks.onAuthorizationRequested(request);
        let resolution!: AuthorizationDecisionItem;
        try {
          [resolution] = await pending.wait(signal);
        } finally {
          if (this.pendingAuthorization === pending) this.pendingAuthorization = undefined;
        }
        this.authorization.resolveHitl();
        userDecision = resolution!.choice;
        try {
          await this.audit.append([this.auditRecord({
            phase: 'hitl',
            runId,
            callId: action.actionId,
            actionId: action.actionId,
            actionDigest: action.digest,
            actionSummary: `Authorize tool result disclosure to ${destination}`,
            capabilityTypes: ['DataDisclose'],
            classification,
            risks,
            ruleIds: matchedRuleIds,
            permissionMode: this.snapshot.permissionMode,
            userDecision,
            outcome: userDecision === 'allow_once' || userDecision === 'allow_for_task' ? 'allowed' : 'denied',
          })]);
        } catch {
          this.authorization.revoke();
          throw new SecurityIntegrityFailureError('HITL_AUDIT_FAILED', 'Disclosure authorization audit failed before release');
        }
        if (userDecision === 'cancel') throw new PermissionCancelledError();
        if (userDecision === 'deny') {
          this.denialMemory.record(action.digest, 'deny');
          effect = 'deny';
          code = 'PERMISSION_DENIED';
        } else {
          effect = 'allow';
          code = 'AUTHORIZED_FOR_DISCLOSURE';
          if (userDecision === 'allow_once') this.authorization.grantOnce(action.actionId, action.digest);
          else this.authorization.grantForTask(action.digest, action.digest);
        }
      }
    }

    try {
      await this.audit.append([this.auditRecord({
        phase: 'preflight',
        runId,
        callId: action.actionId,
        actionId: action.actionId,
        actionDigest: action.digest,
        actionSummary: `Disclose tool result to ${destination}`,
        capabilityTypes: ['DataDisclose'],
        classification,
        risks,
        ruleIds: matchedRuleIds,
        permissionMode: this.snapshot.permissionMode,
        userDecision,
        outcome: effect === 'allow' ? 'allowed' : 'denied',
        ...(effect === 'allow' ? {} : { errorCategory: code }),
      })]);
    } catch {
      this.authorization.revoke();
      throw new SecurityIntegrityFailureError('DISCLOSURE_AUDIT_FAILED', 'Disclosure audit failed before result release');
    }
    return effect === 'allow';
  }

  appendUserInput(content: string): void {
    this.assertOpen();
    if (content.length === 0) throw new TypeError('User input must not be empty');
    this.authorization.advanceForNaturalLanguage();
    this.acceptCurrentUserInput(content);
  }

  close(reason: TaskCloseReason): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.pendingExchanges.clear();
    this.proposalBatches.clear();
    this.pendingAuthorization?.cancel(new Error('PERMISSION_CANCELLED'));
    this.pendingAuthorization = undefined;
    this.authorization.close();
    this.ledger.destroy();
    this.closePromise = closeResources(this.resources, reason).finally(this.onClosed);
    return this.closePromise;
  }

  private assertOpen(): void {
    if (this.closed) throw new ActionTaskClosedError(this.taskId);
  }

  private auditRecord(record: Omit<SecurityAuditRecord, 'schemaVersion' | 'eventId' | 'occurredAt' | 'taskId'>): SecurityAuditRecord {
    return deepFreeze({
      schemaVersion: 1,
      eventId: `audit-event:${this.createId()}`,
      occurredAt: this.now(),
      taskId: this.taskId,
      ...record,
    });
  }

  private acceptCurrentUserInput(content: string): void {
    const classification = this.inputGuard.classifyCurrentInput(content);
    this.ledger.acceptMessage({
      message: { role: 'user', content },
      source: { kind: 'user', reference: this.createId() },
      classification,
      purpose: 'current_user_input',
      destinations: classification === 'ordinary' ? ['model'] : [],
      required: true,
    });
  }
}

async function closeResources(resources: readonly TaskLifecycleResource[], reason: TaskCloseReason): Promise<void> {
  const results = await Promise.allSettled([...resources].reverse().map((resource) => resource.close(reason)));
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to close Action Task resources');
}

function validateOpenInput(input: OpenActionTaskInput): void {
  if (input.schemaVersion !== SECURITY_SCHEMA_VERSION) throw new TypeError('Unsupported Action Task schema version');
  for (const [name, value] of [
    ['taskId', input.taskId],
    ['policySnapshotId', input.policySnapshotId],
    ['profile', input.modelDestination.profile],
    ['model', input.modelDestination.model],
    ['origin', input.modelDestination.origin],
    ['credentialRef', input.modelDestination.credentialRef],
  ] as const) {
    if (value.length === 0) throw new TypeError(`${name} must not be empty`);
  }
  if (!Number.isInteger(input.authorizationEpoch) || input.authorizationEpoch < 0) throw new TypeError('authorizationEpoch must be a non-negative integer');
  if (input.modelContext !== undefined && (!Number.isInteger(input.modelContext.maxTokens) || input.modelContext.maxTokens <= 0)) {
    throw new TypeError('modelContext.maxTokens must be a positive integer');
  }
}

function freezeOpenInput(input: OpenActionTaskInput): OpenActionTaskInput {
  return deepFreeze({
    ...input,
    modelDestination: { ...input.modelDestination },
    pathBoundary: {
      readRoots: [...input.pathBoundary.readRoots],
      writeRoots: [...input.pathBoundary.writeRoots],
    },
    ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
    ...(input.securityInternalRoots === undefined ? {} : { securityInternalRoots: [...input.securityInternalRoots] }),
    ...(input.ticketVerificationKey === undefined ? {} : { ticketVerificationKey: input.ticketVerificationKey }),
    ...(input.permissionRules === undefined ? {} : { permissionRules: structuredClone(input.permissionRules) }),
    ...(input.modelContext === undefined ? {} : {
      modelContext: {
        messages: structuredClone(input.modelContext.messages),
        ...(input.modelContext.currentUserInput === undefined ? {} : { currentUserInput: input.modelContext.currentUserInput }),
        maxTokens: input.modelContext.maxTokens,
        ...(input.modelContext.environment === undefined ? {} : {
          environment: structuredClone(input.modelContext.environment),
        }),
      },
    }),
  });
}

function serializeMessage(message: ChatMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

function disclosureDeniedResult(results: readonly ToolCallResult[]): ChatMessage {
  return {
    role: 'tool',
    content: disclosureDeniedResults(results, 'model').map((result) => ({
      type: 'tool_result' as const,
      result,
    })),
  };
}

function disclosureDeniedResults(
  results: readonly ToolCallResult[],
  destination: 'model' | 'terminal',
): readonly ToolCallResult[] {
  const target = destination === 'model' ? '模型' : '终端';
  return deepFreeze(results.map((result) => ({
    callId: result.callId,
    providerCallId: result.providerCallId,
    toolName: result.toolName,
    isError: true,
    content: {
      summary: `工具结果未获准披露给${target}。`,
      error: { code: 'DATA_DISCLOSURE_DENIED', message: '该结果需要独立数据披露授权。', retryable: false },
    },
  })));
}

function gatewayErrorResult(
  call: import('../shared/types.js').ToolCallRequest,
  code: string,
  message: string,
): ToolCallResult {
  return {
    callId: call.callId,
    providerCallId: call.providerCallId,
    toolName: call.name,
    isError: true,
    content: { summary: message, error: { code, message, retryable: false } },
  };
}
