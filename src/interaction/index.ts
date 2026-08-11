import type { UserTurn, AgentEvent } from '../shared/types.js';

export interface InteractionLayer {
  start(): Promise<void>;
  submitTurn(turn: UserTurn): void;
  onEvent(handler: (event: AgentEvent) => void): void;
}

export class InteractionLayerStub implements InteractionLayer {
  start(): Promise<void> {
    throw new Error('not implemented');
  }

  submitTurn(_turn: UserTurn): void {
    throw new Error('not implemented');
  }

  onEvent(_handler: (event: AgentEvent) => void): void {
    throw new Error('not implemented');
  }
}

export { WeaveTui, runTui } from './weave-tui.js';
