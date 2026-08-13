import type { Plan, SafeError, TokenUsage, TurnEvent } from '../shared/types.js';
import type { TaskDecision } from './task-input.js';

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
  readonly activities: readonly TranscriptActivity[];
  readonly modelTurnCount?: number;
  readonly toolCallCount?: number;
  readonly toolErrorCount?: number;
}

export type TranscriptActivity =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'plan'; readonly plan: Plan }
  | { readonly type: 'task'; readonly state: string; readonly summary: string; readonly runCount?: number; readonly totalIterations?: number }
  | {
      readonly type: 'tool'; readonly callId: string; readonly toolName: string;
      readonly status: 'queued' | 'running' | 'success' | 'error' | 'skipped';
      readonly summary: string; readonly errorCode?: string; readonly errorMessage?: string;
    };

export type TaskDisplayState =
  | { readonly mode: 'react'; readonly phase: 'idle' | 'running' | 'awaiting_input' | 'stopped' | 'cancelled' }
  | {
      readonly mode: 'plan';
      readonly phase: 'planning' | 'awaiting_approval' | 'executing' | 'awaiting_input' | 'stopped' | 'cancelled';
      readonly currentStep?: number;
      readonly totalSteps?: number;
      readonly resumePhase?: 'planning' | 'executing';
    };

export interface TuiState {
  readonly transcript: readonly TranscriptTurn[];
  readonly composer: string;
  readonly activeTurnId?: string;
  readonly streamStatus: 'idle' | 'waiting' | 'streaming';
  readonly queuedMessages: readonly string[];
  readonly queueStatus: 'active' | 'paused';
  readonly pendingSubmission?: string;
  readonly feedback?: string;
  readonly taskDecision?: TaskDecision;
  readonly selectedDecision: number;
  readonly taskDisplay: TaskDisplayState;
}

export type TuiAction =
  | { readonly type: 'turn_event'; readonly event: TurnEvent }
  | { readonly type: 'set_composer'; readonly value: string }
  | { readonly type: 'clear_composer' }
  | { readonly type: 'queue_message'; readonly value: string }
  | { readonly type: 'consume_queue' }
  | { readonly type: 'clear_pending_submission' }
  | { readonly type: 'undo_queue' }
  | { readonly type: 'set_feedback'; readonly value?: string }
  | { readonly type: 'select_decision'; readonly index: number }
  | { readonly type: 'clear_task_decision' };

export function initialTuiState(): TuiState {
  return {
    transcript: [], composer: '', streamStatus: 'idle', queuedMessages: [], queueStatus: 'active', selectedDecision: 0,
    taskDisplay: { mode: 'react', phase: 'idle' },
  };
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
  if (action.type === 'select_decision') return { ...state, selectedDecision: action.index };
  if (action.type === 'clear_task_decision') return { ...state, taskDecision: undefined, selectedDecision: 0 };
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
        activities: [],
      }],
      activeTurnId: event.turnId,
      streamStatus: 'waiting',
      taskDisplay: displayForTurnStart(state.taskDisplay, event),
    };
  }

  if (state.activeTurnId !== event.turnId) return state;
  const index = state.transcript.findIndex((turn) => turn.turnId === event.turnId);
  if (index < 0) return state;

  if (
    event.type === 'tool_call_queued'
    || event.type === 'tool_call_start'
    || event.type === 'tool_call_complete'
    || event.type === 'tool_call_skipped'
  ) {
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({
        ...turn,
        activities: updateToolActivity(turn.activities, event),
      })),
      streamStatus: 'streaming',
    };
  }

  if (event.type === 'text_delta') {
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({
        ...turn,
        assistantText: turn.assistantText + event.delta,
        activities: appendTextActivity(turn.activities, event.delta),
      })),
      streamStatus: 'streaming',
    };
  }

  if (event.type === 'plan_ready') {
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({ ...turn, activities: upsertPlan(turn.activities, event.plan) })),
      taskDecision: { kind: 'plan_approval', taskId: event.taskId, planId: event.plan.planId, version: event.plan.version },
      selectedDecision: 0,
      streamStatus: 'streaming',
      taskDisplay: { mode: 'plan', phase: 'awaiting_approval', totalSteps: event.plan.steps.length },
    };
  }

  if (event.type === 'plan_step') {
    const progress = planStepProgress(state, event);
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({ ...turn, activities: updatePlanStep(turn.activities, event) })),
      taskDecision: undefined,
      streamStatus: 'streaming',
      taskDisplay: {
        mode: 'plan', phase: 'executing',
        ...(progress.currentStep === undefined ? {} : { currentStep: progress.currentStep }),
        ...(progress.totalSteps === undefined ? {} : { totalSteps: progress.totalSteps }),
      },
    };
  }

  if (event.type === 'task_state') {
    const taskDecision = event.state === 'stopped' ? { kind: 'stopped' as const, taskId: event.taskId }
      : event.state === 'cancelled' ? cancelledDecision(state.taskDecision, event.taskId)
        : event.state === 'awaiting_approval' ? state.taskDecision : undefined;
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({
        ...turn,
        activities: [...turn.activities, { type: 'task', state: event.state, summary: event.summary,
          ...(event.runCount === undefined ? {} : { runCount: event.runCount }),
          ...(event.totalIterations === undefined ? {} : { totalIterations: event.totalIterations }) }],
      })),
      taskDecision,
      selectedDecision: 0,
      streamStatus: 'streaming',
      taskDisplay: displayForTaskState(state.taskDisplay, event.state),
    };
  }

  if (event.type === 'plan_revision') {
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({ ...turn, activities: [...turn.activities, { type: 'task', state: 'awaiting_revision', summary: `${event.reason}；建议：${event.suggestion}` }] })),
      taskDecision: { kind: 'plan_revision', taskId: event.taskId },
      selectedDecision: 0,
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
        ...(event.modelTurnCount === undefined ? {} : { modelTurnCount: event.modelTurnCount }),
        ...(event.toolCallCount === undefined ? {} : { toolCallCount: event.toolCallCount }),
        ...(event.toolErrorCount === undefined ? {} : { toolErrorCount: event.toolErrorCount }),
      })),
      activeTurnId: undefined,
      streamStatus: 'idle',
      queueStatus: event.status === 'completed' || state.queuedMessages.length === 0 ? state.queueStatus : 'paused',
      taskDisplay: displayAfterTurnComplete(state.taskDisplay, event.status),
    };
  }

  if (event.type === 'turn_cancelled') {
    return {
      ...state,
      transcript: replaceTurn(state.transcript, index, (turn) => ({ ...turn, phase: 'cancelled', durationMs: event.durationMs })),
      activeTurnId: undefined,
      streamStatus: 'idle',
      queueStatus: state.queuedMessages.length === 0 ? state.queueStatus : 'paused',
      taskDisplay: state.taskDisplay.mode === 'plan'
        ? { ...state.taskDisplay, phase: 'cancelled' }
        : { mode: 'react', phase: 'cancelled' },
    };
  }

  if (event.type !== 'turn_error') return state;

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

function upsertPlan(activities: readonly TranscriptActivity[], plan: Plan): readonly TranscriptActivity[] {
  const index = activities.findIndex((activity) => activity.type === 'plan' && activity.plan.planId === plan.planId);
  if (index < 0) return [...activities, { type: 'plan', plan }];
  return activities.map((activity, candidate) => candidate === index ? { type: 'plan', plan } : activity);
}

function updatePlanStep(activities: readonly TranscriptActivity[], event: Extract<TurnEvent, { type: 'plan_step' }>): readonly TranscriptActivity[] {
  return activities.map((activity) => {
    if (activity.type !== 'plan' || activity.plan.planId !== event.planId || activity.plan.version !== event.version) return activity;
    return { type: 'plan', plan: { ...activity.plan, steps: activity.plan.steps.map((step) => step.id !== event.stepId ? step : {
      ...step,
      status: event.status === 'running' ? 'in_progress' : event.status,
      ...(event.evidence === undefined ? {} : { evidence: event.evidence }),
      ...(event.reason === undefined ? {} : { statusReason: event.reason }),
    }) } };
  });
}

function cancelledDecision(previous: TaskDecision | undefined, taskId: string): TaskDecision {
  if (previous?.kind === 'plan_approval') return { kind: 'cancelled', taskId, planId: previous.planId, version: previous.version };
  return { kind: 'cancelled', taskId };
}

function displayForTurnStart(
  current: TaskDisplayState,
  event: Extract<TurnEvent, { type: 'turn_start' }>,
): TaskDisplayState {
  if (event.taskPhase === 'task_exit') return current;
  if (event.taskMode === 'plan') {
    const phase = event.taskPhase === 'plan_execute' ? 'executing' : 'planning';
    return current.mode === 'plan' ? { ...current, phase } : { mode: 'plan', phase };
  }
  if (event.taskMode === 'react') return { mode: 'react', phase: 'running' };
  return current.mode === 'react' && current.phase === 'idle' ? { mode: 'react', phase: 'running' } : current;
}

function displayForTaskState(
  current: TaskDisplayState,
  state: Extract<TurnEvent, { type: 'task_state' }>['state'],
): TaskDisplayState {
  if (state === 'exited') return { mode: 'react', phase: 'idle' };
  if (state === 'awaiting_approval') {
    return current.mode === 'plan' ? { ...current, phase: 'awaiting_approval' } : current;
  }
  const phase = state === 'awaiting_input' ? 'awaiting_input' : state;
  if (current.mode === 'plan') {
    return {
      ...current,
      phase,
      ...(phase === 'awaiting_input' ? { resumePhase: current.phase === 'planning' ? 'planning' as const : 'executing' as const } : {}),
    };
  }
  return { mode: 'react', phase };
}

function displayAfterTurnComplete(
  current: TaskDisplayState,
  status: Extract<TurnEvent, { type: 'turn_complete' }>['status'],
): TaskDisplayState {
  if (status !== 'completed') return current;
  if (current.mode === 'react') {
    return current.phase === 'running' ? { mode: 'react', phase: 'idle' } : current;
  }
  if (['planning', 'executing'].includes(current.phase)) return { mode: 'react', phase: 'idle' };
  return current;
}

function planStepProgress(
  state: TuiState,
  event: Extract<TurnEvent, { type: 'plan_step' }>,
): { readonly currentStep?: number; readonly totalSteps?: number } {
  for (const turn of state.transcript) {
    const activity = turn.activities.find((candidate) => candidate.type === 'plan'
      && candidate.plan.planId === event.planId && candidate.plan.version === event.version);
    if (activity?.type !== 'plan') continue;
    const index = activity.plan.steps.findIndex((step) => step.id === event.stepId);
    return { ...(index < 0 ? {} : { currentStep: index + 1 }), totalSteps: activity.plan.steps.length };
  }
  return {};
}

function appendTextActivity(activities: readonly TranscriptActivity[], delta: string): readonly TranscriptActivity[] {
  const last = activities.at(-1);
  if (last?.type === 'text') return [...activities.slice(0, -1), { type: 'text', text: last.text + delta }];
  return [...activities, { type: 'text', text: delta }];
}

function updateToolActivity(
  activities: readonly TranscriptActivity[],
  event: Extract<TurnEvent, { type: 'tool_call_queued' | 'tool_call_start' | 'tool_call_complete' | 'tool_call_skipped' }>,
): readonly TranscriptActivity[] {
  const status = event.type === 'tool_call_queued' ? 'queued'
    : event.type === 'tool_call_start' ? 'running'
      : event.type === 'tool_call_skipped' ? 'skipped'
        : 'isError' in event && event.isError ? 'error' : 'success';
  const activity: TranscriptActivity = {
    type: 'tool', callId: event.callId, toolName: event.toolName, status,
    summary: event.summary,
    ...('error' in event && event.error !== undefined ? { errorCode: event.error.code, errorMessage: event.error.message } : {}),
  };
  const index = activities.findIndex((item) => item.type === 'tool' && item.callId === event.callId);
  if (index < 0) return [...activities, activity];
  return activities.map((item, candidate) => candidate === index ? activity : item);
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
