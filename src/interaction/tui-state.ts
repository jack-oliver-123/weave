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
  readonly queuedMessages: readonly string[];
  readonly queueStatus: 'active' | 'paused';
  readonly pendingSubmission?: string;
  readonly feedback?: string;
}

export type TuiAction =
  | { readonly type: 'turn_event'; readonly event: TurnEvent }
  | { readonly type: 'set_composer'; readonly value: string }
  | { readonly type: 'clear_composer' }
  | { readonly type: 'queue_message'; readonly value: string }
  | { readonly type: 'consume_queue' }
  | { readonly type: 'clear_pending_submission' }
  | { readonly type: 'undo_queue' }
  | { readonly type: 'set_feedback'; readonly value?: string };

export function initialTuiState(): TuiState {
  return { transcript: [], composer: '', streamStatus: 'idle', queuedMessages: [], queueStatus: 'active' };
}

export function reduceTuiState(state: TuiState, action: TuiAction): TuiState {
  if (action.type === 'set_composer') return { ...state, composer: action.value };
  if (action.type === 'clear_composer') return { ...state, composer: '' };
  if (action.type === 'queue_message') {
    if (action.value.trim().length === 0) return state;
    return {
      ...state,
      queuedMessages: [...state.queuedMessages, action.value],
      composer: '',
      feedback: `已排队 ${state.queuedMessages.length + 1} 条`,
    };
  }
  if (action.type === 'consume_queue') {
    if (state.queuedMessages.length === 0) return state;
    return {
      ...state,
      queuedMessages: [],
      queueStatus: 'active',
      pendingSubmission: state.queuedMessages.join('\n\n'),
      feedback: undefined,
    };
  }
  if (action.type === 'clear_pending_submission') return { ...state, pendingSubmission: undefined };
  if (action.type === 'undo_queue') {
    const restored = state.queuedMessages.at(-1);
    if (restored === undefined) return state;
    return {
      ...state,
      queuedMessages: state.queuedMessages.slice(0, -1),
      composer: joinDrafts(restored, state.composer),
      feedback: '已撤回最后一条排队消息',
    };
  }
  if (action.type === 'set_feedback') return { ...state, feedback: action.value };
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
      queueStatus: event.status === 'completed' || state.queuedMessages.length === 0 ? state.queueStatus : 'paused',
    };
  }

  if (event.type === 'turn_cancelled') {
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({ ...turn, phase: 'cancelled', durationMs: event.durationMs })),
      activeTurnId: undefined,
      streamStatus: 'idle',
      queueStatus: state.queuedMessages.length === 0 ? state.queueStatus : 'paused',
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
    composer: joinDrafts(event.restoreInput, state.composer),
    activeTurnId: undefined,
    streamStatus: 'idle',
    queueStatus: state.queuedMessages.length === 0 ? state.queueStatus : 'paused',
  };
}

function joinDrafts(first: string, second: string): string {
  if (first.length === 0) return second;
  if (second.length === 0) return first;
  return `${first}\n\n${second}`;
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
