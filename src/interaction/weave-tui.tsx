import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { render, useApp, useInput, usePaste, useStdout } from 'ink';
import type { AppPorts } from '../app.js';
import type { TurnEvent } from '../shared/types.js';
import { applyComposerKey, insertPaste, type ComposerState } from './composer-model.js';
import { handleCtrlC, initialCtrlCState } from './ctrl-c-state.js';
import { calculateLayout } from './layout.js';
import { TerminalInputDecoder } from './terminal-input.js';
import {
  disableMouseTracking,
  enableMouseTracking,
  enterAlternateScreen,
  leaveAlternateScreen,
} from './terminal-screen.js';
import { initialTuiState, reduceTuiState, type TuiAction } from './tui-state.js';
import { initialViewportState, reduceViewport } from './viewport.js';
import { formatTranscript, WeaveView } from './weave-view.js';
import { decisionAction, decisionOptions, parseTopLevelInput } from './task-input.js';

export interface WeaveTuiProps extends AppPorts {
  readonly columns?: number;
  readonly rows?: number;
}

export function WeaveTui(props: WeaveTuiProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, reactDispatch] = useReducer(reduceTuiState, undefined, initialTuiState);
  const [cursor, setCursor] = useState(0);
  const [viewport, dispatchViewport] = useReducer(reduceViewport, undefined, initialViewportState);
  const [terminalSize, setTerminalSize] = useState(() => readTerminalSize(stdout));
  const [now, setNow] = useState(() => performance.now());
  const stateRef = useRef(state);
  const composerRef = useRef<ComposerState>({ value: '', cursor: 0 });
  const ctrlCRef = useRef(initialCtrlCState());
  const submittingRef = useRef(false);
  const terminalInputRef = useRef(new TerminalInputDecoder());
  const previousLayoutRef = useRef({ columns: 0, height: 0, lineCount: 0 });

  const columns = props.columns ?? terminalSize.columns;
  const rows = props.rows ?? terminalSize.rows;
  const contentWidth = Math.max(1, columns - 2);
  const composerWidth = Math.max(1, columns - 6);
  const spinnerTick = state.streamStatus === 'waiting' ? Math.floor(now / 100) : -1;
  const transcriptRows = useMemo(
    () => formatTranscript(
      state.transcript, contentWidth, now, state.taskDecision, state.selectedDecision,
      state.pendingAuthorization, state.authorizationChoices, state.selectedAuthorizationItem,
    ),
    [contentWidth, state.transcript, state.taskDecision, state.selectedDecision, state.pendingAuthorization, state.authorizationChoices, state.selectedAuthorizationItem, spinnerTick],
  );
  const viewportHeight = calculateLayout(rows, state.composer, columns, state.queuedMessages.length).transcriptHeight;

  const dispatch = useCallback((action: TuiAction) => {
    stateRef.current = reduceTuiState(stateRef.current, action);
    reactDispatch(action);
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    const onResize = () => setTerminalSize(readTerminalSize(stdout));
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  useEffect(() => {
    composerRef.current = { value: state.composer, cursor: Math.min(cursor, state.composer.length) };
  }, [state.composer, cursor]);

  useEffect(() => {
    const previous = previousLayoutRef.current;
    const resized = previous.columns !== columns || previous.height !== viewportHeight;
    dispatchViewport({
      type: resized ? 'resize' : 'content',
      rows: transcriptRows,
      height: viewportHeight,
    });
    previousLayoutRef.current = { columns, height: viewportHeight, lineCount: transcriptRows.length };
  }, [columns, transcriptRows.length, viewportHeight]);

  useEffect(() => {
    if (state.activeTurnId === undefined) return;
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [state.activeTurnId]);

  const updateComposer = useCallback((next: ComposerState) => {
    composerRef.current = next;
    setCursor(next.cursor);
    dispatch({ type: 'set_composer', value: next.value });
  }, [dispatch]);

  const syncComposerFromState = useCallback((value: string) => {
    composerRef.current = { value, cursor: value.length };
    setCursor(value.length);
  }, []);

  const consumeTurns = useCallback(async (initialText: string) => {
    if (submittingRef.current) {
      dispatch({ type: 'queue_message', value: initialText });
      composerRef.current = { value: '', cursor: 0 };
      setCursor(0);
      return;
    }

    submittingRef.current = true;
    let nextText: string | undefined = initialText;
    try {
      while (nextText !== undefined) {
        const submittedText = nextText;
        nextText = undefined;
        let terminalStatus: 'completed' | 'truncated' | 'refused' | 'cancelled' | 'error' | undefined;
        try {
          const parsed = parseTopLevelInput(submittedText);
          if (!parsed.ok) {
            dispatch({ type: 'set_feedback', value: parsed.message });
            terminalStatus = 'error';
            continue;
          }
          for await (const event of props.conversation.submit({ mode: parsed.mode, content: parsed.content })) {
            dispatch({ type: 'turn_event', event });
            terminalStatus = terminalStatusOf(event) ?? terminalStatus;
            if (event.type === 'turn_error') syncComposerFromState(stateRef.current.composer);
          }
        } catch {
          updateComposer({ value: joinDrafts(submittedText, composerRef.current.value), cursor: submittedText.length + composerRef.current.value.length + (composerRef.current.value.length > 0 ? 2 : 0) });
          terminalStatus = 'error';
        }

        const snapshot = stateRef.current;
        if (terminalStatus === 'completed' && snapshot.queueStatus === 'active' && snapshot.queuedMessages.length > 0) {
          dispatch({ type: 'consume_queue' });
          nextText = stateRef.current.pendingSubmission;
          dispatch({ type: 'clear_pending_submission' });
        }
      }
    } finally {
      submittingRef.current = false;
    }
  }, [dispatch, props.conversation, syncComposerFromState, updateComposer]);

  const consumeAction = useCallback(async (action: import('../shared/types.js').TaskAction) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    dispatch({ type: 'clear_task_decision' });
    try {
      for await (const event of props.conversation.dispatch(action)) dispatch({ type: 'turn_event', event });
    } catch (error) {
      dispatch({ type: 'set_feedback', value: error instanceof Error ? error.message : '任务操作失败。' });
    } finally {
      submittingRef.current = false;
    }
  }, [dispatch, props.conversation]);

  const consumeAuthorization = useCallback(async () => {
    const snapshot = stateRef.current;
    const request = snapshot.pendingAuthorization;
    if (request === undefined) return;
    try {
      for await (const event of props.conversation.dispatch({
        type: 'resolve_authorization',
        taskId: request.taskId,
        runId: request.runId,
        authorizationRequestId: request.authorizationRequestId,
        authorizationEpoch: request.authorizationEpoch,
        decisions: request.items.map((item, index) => ({
          callId: item.callId,
          actionDigest: item.actionDigest,
          choice: snapshot.authorizationChoices[index] ?? 'allow_once',
        })),
      })) dispatch({ type: 'turn_event', event });
      dispatch({ type: 'clear_authorization' });
    } catch (error) {
      dispatch({ type: 'set_feedback', value: error instanceof Error ? error.message : '授权决定提交失败。' });
    }
  }, [dispatch, props.conversation]);

  const sendPausedQueue = useCallback(() => {
    const draft = composerRef.current.value;
    if (draft.trim().length > 0) dispatch({ type: 'queue_message', value: draft });
    composerRef.current = { value: '', cursor: 0 };
    setCursor(0);
    dispatch({ type: 'consume_queue' });
    const pending = stateRef.current.pendingSubmission;
    dispatch({ type: 'clear_pending_submission' });
    if (pending !== undefined) void consumeTurns(pending);
  }, [consumeTurns, dispatch]);

  usePaste((text) => updateComposer(insertPaste(composerRef.current, text)));

  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === '\u0003')) {
      const active = props.conversation.activeTurnId !== undefined;
      const result = handleCtrlC(ctrlCRef.current, performance.now(), active);
      ctrlCRef.current = result.state;
      if (result.action === 'exit') {
        exit();
      } else if (result.action === 'cancel') {
        props.conversation.cancel();
        if (stateRef.current.queuedMessages.length > 0) dispatch({ type: 'set_feedback', value: '队列将在中断后暂停' });
      } else {
        updateComposer({ value: '', cursor: 0 });
        if (stateRef.current.queuedMessages.length > 0) {
          dispatch({ type: 'set_feedback', value: `再按一次退出，将丢失 ${stateRef.current.queuedMessages.length} 条排队消息` });
        }
      }
      return;
    }

    if (key.ctrl && (input === 'z' || input === '\u001a')) {
      dispatch({ type: 'undo_queue' });
      syncComposerFromState(stateRef.current.composer);
      return;
    }

    const decoded = terminalInputRef.current.decode(input);
    if (decoded.wheel !== undefined) {
      if (decoded.wheel === 'up') {
        dispatchViewport({ type: 'scroll_up', lines: 3, rows: transcriptRows, height: viewportHeight });
      } else {
        dispatchViewport({ type: 'scroll_down', lines: 3, rows: transcriptRows, height: viewportHeight });
      }
      return;
    }
    if (decoded.text.length === 0 && input.length > 0) return;

    if (key.pageUp) {
      dispatchViewport({ type: 'scroll_up', lines: Math.max(1, viewportHeight - 1), rows: transcriptRows, height: viewportHeight });
      return;
    }
    if (key.pageDown) {
      dispatchViewport({ type: 'scroll_down', lines: Math.max(1, viewportHeight - 1), rows: transcriptRows, height: viewportHeight });
      return;
    }
    if (key.end && key.ctrl) {
      dispatchViewport({ type: 'bottom' });
      return;
    }

    if (key.return && !key.shift && stateRef.current.activeTurnId === undefined
      && stateRef.current.queueStatus === 'paused' && stateRef.current.queuedMessages.length > 0) {
      sendPausedQueue();
      return;
    }

    const authorization = stateRef.current.pendingAuthorization;
    if (authorization !== undefined) {
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1;
        dispatch({
          type: 'select_authorization_item',
          index: (stateRef.current.selectedAuthorizationItem + direction + authorization.items.length) % authorization.items.length,
        });
        return;
      }
      if (key.leftArrow || key.rightArrow) {
        const choices = ['allow_once', 'allow_for_task', 'deny', 'cancel'] as const;
        const current = stateRef.current.authorizationChoices[stateRef.current.selectedAuthorizationItem] ?? 'allow_once';
        const direction = key.leftArrow ? -1 : 1;
        dispatch({ type: 'set_authorization_choice', choice: choices[(choices.indexOf(current) + direction + choices.length) % choices.length]! });
        return;
      }
      if (key.return && !key.shift) {
        if (composerRef.current.value.length > 0) {
          dispatch({ type: 'set_feedback', value: '授权等待期间的草稿已保留，请先逐项提交授权决定。' });
          return;
        }
        void consumeAuthorization();
        return;
      }
    }

    const taskDecision = stateRef.current.taskDecision;
    if (taskDecision !== undefined && stateRef.current.activeTurnId === undefined && composerRef.current.value.length === 0) {
      const options = decisionOptions(taskDecision);
      if (key.upArrow || key.downArrow) {
        const direction = key.upArrow ? -1 : 1;
        dispatch({ type: 'select_decision', index: (stateRef.current.selectedDecision + direction + options.length) % options.length });
        return;
      }
      if (key.return && !key.shift) {
        if (taskDecision.kind === 'stopped' && stateRef.current.selectedDecision === 1) {
          dispatch({ type: 'set_feedback', value: '请输入补充要求。' });
          return;
        }
        void consumeAction(decisionAction(taskDecision, stateRef.current.selectedDecision));
        return;
      }
    }

    const busy = submittingRef.current || stateRef.current.activeTurnId !== undefined || props.conversation.activeTurnId !== undefined;
    const result = applyComposerKey(composerRef.current, decoded.text, key, true, composerWidth);
    if (result.submitted !== undefined) {
      composerRef.current = { value: '', cursor: 0 };
      setCursor(0);
      const parsedSubmission = parseTopLevelInput(result.submitted);
      if (busy && parsedSubmission.ok && parsedSubmission.mode === 'plan') {
        dispatch({ type: 'set_feedback', value: '当前任务尚未结束，不能创建新的 Plan。' });
        return;
      }
      if (taskDecision !== undefined && !busy) {
        dispatch({ type: 'set_composer', value: '' });
        void consumeAction(decisionAction(taskDecision, stateRef.current.selectedDecision, result.submitted));
      } else if (busy) {
        dispatch({ type: 'queue_message', value: result.submitted });
      } else {
        dispatch({ type: 'set_composer', value: '' });
        void consumeTurns(result.submitted);
      }
      return;
    }
    updateComposer(result.state);
  });

  return <WeaveView
    state={state}
    profile={props.profile}
    version={props.version}
    cwd={props.cwd}
    columns={columns}
    rows={rows}
    viewport={viewport}
    cursor={cursor}
    now={now}
    transcriptRows={transcriptRows}
  />;
}

export interface RunTuiOptions extends AppPorts {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

export async function runTui(options: RunTuiOptions): Promise<void> {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const stderr = options.stderr ?? process.stderr;
  enterAlternateScreen(stdout);
  enableMouseTracking(stdout);
  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(<WeaveTui {...options} />, {
      stdin,
      stdout,
      stderr,
      exitOnCtrlC: false,
      interactive: true,
      patchConsole: true,
      maxFps: 30,
      incrementalRendering: true,
      kittyKeyboard: { mode: 'auto' },
    });
    await instance.waitUntilExit();
  } finally {
    instance?.unmount();
    disableMouseTracking(stdout);
    leaveAlternateScreen(stdout);
  }
}

function terminalStatusOf(event: TurnEvent): 'completed' | 'truncated' | 'refused' | 'cancelled' | 'error' | undefined {
  if (event.type === 'turn_complete') return event.status;
  if (event.type === 'turn_cancelled') return 'cancelled';
  if (event.type === 'turn_error') return 'error';
  return undefined;
}

function joinDrafts(first: string, second: string): string {
  if (second.length === 0) return first;
  return `${first}\n\n${second}`;
}

function readTerminalSize(stdout: NodeJS.WriteStream): { columns: number; rows: number } {
  return { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
}
