import type { SafeError, TokenUsage, TurnEvent } from '../shared/types.js';

export type TranscriptPhase =
  | 'generating'
  | 'completed'
  | 'truncated'
  | 'refused'
  | 'cancelled'
  | 'error';

export interface TranscriptTurn {
  readonly turnId: string;
  readonly userText: string;
  readonly assistantText: string;
  readonly phase: TranscriptPhase;
  readonly startedAt: number;
  readonly durationMs?: number;
  readonly usage?: TokenUsage;
  readonly error?: SafeError;
}

export interface TuiState {
  readonly transcript: readonly TranscriptTurn[];
  readonly composer: string;
  readonly activeTurnId?: string;
  readonly streamStatus: 'idle' | 'waiting' | 'streaming';
}

export type TuiAction =
  | { readonly type: 'turn_event'; readonly event: TurnEvent }
  | { readonly type: 'set_composer'; readonly value: string }
  | { readonly type: 'clear_composer' };

export function initialTuiState(): TuiState {
  return { transcript: [], composer: '', streamStatus: 'idle' };
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  if (action.type === 'set_composer') return { ...state, composer: action.value };
  if (action.type === 'clear_composer') return { ...state, composer: '' };
  const event = action.event;

  if (event.type === 'turn_start') {
    return {
      ...state,
      transcript: [...state.transcript, {
        turnId: event.turnId,
        userText: event.userText,
        assistantText: '',
        phase: 'generating',
        startedAt: event.startedAt,
      }],
      composer: '',
      activeTurnId: event.turnId,
      streamStatus: 'waiting',
    };
  }

  if (state.activeTurnId !== event.turnId) return state;
  const index = state.transcript.findIndex((turn) => turn.turnId === event.turnId);
  if (index < 0) return state;

  if (event.type === 'text_delta') {
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({
        ...turn,
        assistantText: turn.assistantText + event.delta,
      })),
      streamStatus: 'streaming',
    };
  }

  if (event.type === 'turn_complete') {
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({
        ...turn,
        phase: event.status,
        durationMs: event.durationMs,
        ...(event.usage === undefined ? {} : { usage: event.usage }),
      })),
      activeTurnId: undefined,
      streamStatus: 'idle',
    };
  }

  if (event.type === 'turn_cancelled') {
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({ ...turn, phase: 'cancelled', durationMs: event.durationMs })),
      activeTurnId: undefined,
      streamStatus: 'idle',
    };
  }

  return {
    ...state,
    transcript: replaceTurn(state.transcript, index, (turn) => ({
      ...turn,
      phase: 'error',
      error: event.error,
      durationMs: event.durationMs,
    })),
    composer: event.restoreInput,
    activeTurnId: undefined,
    streamStatus: 'idle',
  };
}

export function selectElapsedMs(state: TuiState, now: number): number | undefined {
  if (state.activeTurnId === undefined) return undefined;
  const turn = state.transcript.find((candidate) => candidate.turnId === state.activeTurnId);
  return turn === undefined ? undefined : Math.max(0, now - turn.startedAt);
}

function replaceTurn(
  turns: readonly TranscriptTurn[],
  index: number,
  update: (turn: TranscriptTurn) => TranscriptTurn,
): readonly TranscriptTurn[] {
  return turns.map((turn, candidateIndex) => candidateIndex === index ? update(turn) : turn);
}
