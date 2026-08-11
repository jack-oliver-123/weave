import type { UserTurn, AgentEvent, ContextSnapshot } from '../shared/types.js';

export interface EngineLayer {
  runLoop(turn: UserTurn, context: ContextSnapshot): AsyncIterable<AgentEvent>;
}

export class EngineLayerStub implements EngineLayer {
  // eslint-disable-next-line require-yield
  async *runLoop(_turn: UserTurn, _context: ContextSnapshot): AsyncIterable<AgentEvent> {
    throw new Error('not implemented');
  }
}

export { ConversationManager, ConversationBusyError, ConversationInputError } from './conversation-manager.js';
export { createLlmClient } from './llm/index.js';
