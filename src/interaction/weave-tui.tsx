import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { render, useApp, useInput, usePaste, useStdout } from 'ink';
import type { AppPorts } from '../app.js';
import { applyComposerKey, insertPaste, type ComposerState } from './composer-model.js';
import { handleCtrlC, initialCtrlCState } from './ctrl-c-state.js';
import { formatTranscript, WeaveView } from './weave-view.js';
import { initialTuiState, reduceTuiState } from './tui-state.js';
import { initialViewportState, reduceViewport } from './viewport.js';
import { calculateLayout } from './layout.js';
import { enterAlternateScreen, leaveAlternateScreen } from './terminal-screen.js';

export interface WeaveTuiProps extends AppPorts {
  readonly columns?: number;
  readonly rows?: number;
}

export function WeaveTui(props: WeaveTuiProps): React.JSX.Element {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [state, dispatch] = useReducer(reduceTuiState, undefined, initialTuiState);
  const [cursor, setCursor] = useState(0);
  const [viewport, dispatchViewport] = useReducer(reduceViewport, undefined, initialViewportState);
  const [terminalSize, setTerminalSize] = useState(() => readTerminalSize(stdout));
  const [now, setNow] = useState(() => performance.now());
  const composerRef = useRef<ComposerState>({ value: '', cursor: 0 });
  const ctrlCRef = useRef(initialCtrlCState());
  const submittingRef = useRef(false);

  const columns = props.columns ?? terminalSize.columns;
  const rows = props.rows ?? terminalSize.rows;
  const transcriptLines = useMemo(() => formatTranscript(state.transcript), [state.transcript]);
  const viewportHeight = calculateLayout(rows, state.composer).transcriptHeight;

  useEffect(() => {
    const onResize = () => setTerminalSize(readTerminalSize(stdout));
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  useEffect(() => {
    composerRef.current = { value: state.composer, cursor: Math.min(cursor, state.composer.length) };
  }, [state.composer, cursor]);

  useEffect(() => {
    dispatchViewport({ type: 'content', lineCount: transcriptLines.length, height: viewportHeight });
  }, [transcriptLines.length, viewportHeight]);

  useEffect(() => {
    if (state.activeTurnId === undefined) return;
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [state.activeTurnId]);

  const updateComposer = (next: ComposerState) => {
    composerRef.current = next;
    setCursor(next.cursor);
    dispatch({ type: 'set_composer', value: next.value });
  };

  const consumeTurn = async (text: string) => {
    submittingRef.current = true;
    try {
      for await (const event of props.conversation.submit({ content: text })) {
        dispatch({ type: 'turn_event', event });
        if (event.type === 'turn_error') {
          composerRef.current = { value: event.restoreInput, cursor: event.restoreInput.length };
          setCursor(event.restoreInput.length);
        }
      }
    } catch {
      updateComposer({ value: text, cursor: text.length });
    } finally {
      submittingRef.current = false;
    }
  };

  usePaste((text) => updateComposer(insertPaste(composerRef.current, text)));

  useInput((input, key) => {
    if (key.ctrl && (input === 'c' || input === '\u0003')) {
      const result = handleCtrlC(ctrlCRef.current, performance.now(), props.conversation.activeTurnId !== undefined);
      ctrlCRef.current = result.state;
      if (result.action === 'exit') {
        exit();
      } else if (result.action === 'cancel') {
        props.conversation.cancel();
      } else {
        updateComposer({ value: '', cursor: 0 });
      }
      return;
    }
    if (key.pageUp) {
      dispatchViewport({ type: 'scroll_up', lines: Math.max(1, viewportHeight - 1), lineCount: transcriptLines.length, height: viewportHeight });
      return;
    }
    if (key.pageDown) {
      dispatchViewport({ type: 'scroll_down', lines: Math.max(1, viewportHeight - 1) });
      return;
    }
    if (key.end && key.ctrl) {
      dispatchViewport({ type: 'bottom' });
      return;
    }

    const result = applyComposerKey(composerRef.current, input, key, !submittingRef.current && props.conversation.activeTurnId === undefined);
    updateComposer(result.state);
    if (result.submitted !== undefined) void consumeTurn(result.submitted);
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
  const instance = render(<WeaveTui {...options} />, {
    stdin,
    stdout,
    stderr,
    exitOnCtrlC: false,
    interactive: true,
    patchConsole: true,
  });
  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
    leaveAlternateScreen(stdout);
  }
}

function readTerminalSize(stdout: NodeJS.WriteStream): { columns: number; rows: number } {
  return { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
}
