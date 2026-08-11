import React from 'react';
import { Box, Text } from 'ink';
import type { ProfileSummary } from '../shared/types.js';
import type { TranscriptTurn, TuiState } from './tui-state.js';
import { visibleViewportLines, type ViewportState } from './viewport.js';
import { calculateLayout } from './layout.js';

const DOG = [' / \\__', '(    @\\___', ' /         O', '/   (_____/', '/_____/   U'];

export interface WeaveViewProps {
  readonly state: TuiState;
  readonly profile: ProfileSummary;
  readonly version: string;
  readonly cwd: string;
  readonly columns: number;
  readonly rows: number;
  readonly viewport: ViewportState;
  readonly cursor: number;
  readonly now?: number;
}

export function WeaveView(props: WeaveViewProps): React.JSX.Element {
  if (props.columns < 80 || props.rows < 24) {
    return <Box width={props.columns} height={props.rows} alignItems="center" justifyContent="center"><Text>终端窗口过小，请调整到至少 80×24。</Text></Box>;
  }

  const layout = calculateLayout(props.rows, props.state.composer);
  const { composerHeight, transcriptHeight } = layout;
  const transcriptLines = formatTranscript(props.state.transcript);
  const visible = visibleViewportLines(transcriptLines, transcriptHeight, props.viewport);
  const currentStatus = statusText(props.state, props.now ?? performance.now());

  return (
    <Box width={props.columns} height={props.rows} flexDirection="column" overflow="hidden">
      <Box height={layout.headerHeight} flexShrink={0} paddingX={1}>
        <Box width={16} flexDirection="column">{DOG.map((line) => <Text key={line} color="yellow">{line}</Text>)}</Box>
        <Box flexDirection="column">
          <Text bold>Weave v{props.version}</Text>
          <Text dimColor>{props.cwd}</Text>
          <Text>{props.profile.name}</Text>
        </Box>
      </Box>
      <Box height={transcriptHeight} flexShrink={0} flexDirection="column" overflow="hidden" paddingX={1}>
        {visible.map((line, index) => <Text key={`${index}:${line}`} wrap="truncate-end">{line.length === 0 ? ' ' : line}</Text>)}
      </Box>
      <Box height={composerHeight} flexShrink={0} borderStyle="single" borderColor="gray" paddingX={1} overflow="hidden" aria-role="textbox" aria-state={{ multiline: true }}>
        <Text color="green">&gt; </Text><Text>{renderComposer(props.state.composer, props.cursor)}</Text>
      </Box>
      <Box height={layout.statusHeight} flexShrink={0} justifyContent="space-between" paddingX={1}>
        <Text>{currentStatus}</Text>
        <Text dimColor>{props.profile.protocol} / {props.profile.model}</Text>
      </Box>
    </Box>
  );
}

export function formatTranscript(turns: readonly TranscriptTurn[]): string[] {
  const lines: string[] = [];
  for (const turn of turns) {
    lines.push(`> ${turn.userText}`);
    if (turn.assistantText.length > 0) lines.push(...turn.assistantText.split('\n').map((line, index) => `${index === 0 ? '● ' : '  '}${line}`));
    else lines.push(`● ${turn.phase === 'generating' ? '等待响应' : ''}`);
    if (turn.phase !== 'generating') lines.push(`  ${turnLabel(turn)}${formatDurationSuffix(turn.durationMs)}`);
    lines.push('');
  }
  return lines;
}

function renderComposer(value: string, cursor: number): string {
  return value.slice(0, cursor) + '█' + value.slice(cursor);
}

function statusText(state: TuiState, now: number): string {
  if (state.activeTurnId === undefined) return '就绪';
  const turn = state.transcript.find((candidate) => candidate.turnId === state.activeTurnId);
  if (turn === undefined) return '就绪';
  const elapsed = formatDuration(Math.max(0, now - turn.startedAt));
  return state.streamStatus === 'waiting' ? `等待响应 · ${elapsed}` : `生成中 · ${elapsed}`;
}

function turnLabel(turn: TranscriptTurn): string {
  if (turn.phase === 'completed') return '完成';
  if (turn.phase === 'truncated') return '已达到输出上限';
  if (turn.phase === 'refused') return '模型拒绝回答';
  if (turn.phase === 'cancelled') return '已中断';
  if (turn.phase === 'error') return turn.error?.message ?? '错误';
  return '生成中';
}

function formatDurationSuffix(durationMs?: number): string {
  return durationMs === undefined ? '' : ` · ${formatDuration(durationMs)}`;
}

function formatDuration(durationMs: number): string {
  return `${(durationMs / 1_000).toFixed(1)}s`;
}
