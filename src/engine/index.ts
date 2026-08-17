import type { UserTurn, AgentEvent, ContextSnapshot } from '../shared/types.js';

export interface EngineLayer {
  runLoop(turn: UserTurn, context: ContextSnapshot): AsyncIterable<AgentEvent>;
}

export class EngineLayerStub implements EngineLayer {
  async *runLoop(_turn: UserTurn, _context: ContextSnapshot): AsyncIterable<AgentEvent> {
    throw new Error('not implemented');
  }
}

export { ConversationManager, ConversationBusyError, ConversationInputError } from './conversation-manager.js';
export { createLlmClient } from './llm/index.js';
export { AgentLoop, type AgentRunInput, type AgentRunKind } from './agent-loop.js';
export { buildRuntimeState, type PromptContext, type PromptMode } from './prompt-builder.js';
export { assemblePrompt, buildPromptCompletionAudit, buildStableSystemPrompt, buildSystemReminder, capabilityChangeFragment } from './prompt-assembly.js';
export { createEnvironmentContext } from './prompt-environment.js';
export { ControlToolCatalog, type AgentPhase, type ControlToolName } from './control-tools.js';
export { PlanSession, PlanStateError, type PlanSessionState } from './plan-session.js';
export { AgentTaskSession, TaskStateError, type AgentTaskState } from './task-session.js';
export { PlanValidationError, validatePlanSubmission } from './plan.js';
