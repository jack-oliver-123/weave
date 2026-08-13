import React, { useMemo } from 'react';
import { Box, Text, useCursor } from 'ink';
import type { ProfileSummary } from '../shared/types.js';
import { prefixRows, wrapStyledSpans, type DisplayRow, type StyledSpan } from './display-row.js';
import { displayWidth, truncateDisplay } from './display-width.js';
import { composerViewport, calculateLayout } from './layout.js';
import { renderMarkdown } from './markdown-renderer.js';
import type { TranscriptTurn, TuiState } from './tui-state.js';
import { decisionOptions } from './task-input.js';
import { visibleViewportLines, type ViewportState } from './viewport.js';

const DOG = [' / \\__', '(    @\\___', ' /         O', '/   (_____/', '/_____/   U'];
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
  readonly transcriptRows?: readonly DisplayRow[];
}

export function WeaveView(props: WeaveViewProps): React.JSX.Element {
  const { setCursorPosition } = useCursor();
  const now = props.now ?? performance.now();
  const spinnerTick = props.state.streamStatus === 'waiting' ? Math.floor(now / 100) : -1;
  const tooSmall = props.columns < 80 || props.rows < 24;
  const contentWidth = Math.max(1, props.columns - 2);
  const layout = calculateLayout(props.rows, props.state.composer, props.columns, props.state.queuedMessages.length);
  const transcriptRows = useMemo(
    () => props.transcriptRows ?? formatTranscript(props.state.transcript, contentWidth, now, props.state.taskDecision, props.state.selectedDecision),
    [contentWidth, props.state.transcript, props.state.taskDecision, props.state.selectedDecision, props.transcriptRows, spinnerTick],
  );
  const visible = visibleViewportLines(transcriptRows, layout.transcriptHeight, props.viewport);
  const composer = composerViewport(
    props.state.composer,
    props.cursor,
    Math.max(1, props.columns - 6),
    Math.max(1, layout.composerHeight - 2),
  );

  if (tooSmall) {
    setCursorPosition(undefined);
    return <Box width={props.columns} height={props.rows} alignItems="center" justifyContent="center"><Text>终端窗口过小，请调整到至少 80×24。</Text></Box>;
  }

  setCursorPosition({
    x: 4 + composer.cursorColumn,
    // Ink positions from the virtual row after its frame, so the requested row
    // must be one past the desired visual cell in full-height terminal layouts.
    y: layout.headerHeight + layout.transcriptHeight + layout.queueHeight + 2 + composer.cursorRow,
  });

  return (
    <Box width={props.columns} height={props.rows} flexDirection="column" overflow="hidden">
      <Box height={layout.headerHeight} flexShrink={0} paddingX={1} overflow="hidden">
        <Box width={16} flexDirection="column">{DOG.map((line) => <Text key={line} color="yellow">{line}</Text>)}</Box>
        <Box flexDirection="column" overflow="hidden">
          <Text bold>Weave v{props.version}</Text>
          <Text dimColor wrap="truncate-end">{props.cwd}</Text>
          <Text>{props.profile.name}</Text>
        </Box>
      </Box>
      <Box height={layout.transcriptHeight} flexShrink={0} flexDirection="column" overflow="hidden" paddingX={1}>
        {visible.map((row) => <StyledRow key={row.key} row={row} />)}
      </Box>
      {layout.queueHeight > 0 ? (
        <Box height={1} flexShrink={0} paddingX={1} overflow="hidden">
          <Text color={props.state.queueStatus === 'paused' ? 'yellow' : 'cyan'} wrap="truncate-end">{queueSummary(props.state, contentWidth)}</Text>
        </Box>
      ) : null}
      <Box height={layout.composerHeight} flexShrink={0} borderStyle="single" borderColor="gray" paddingX={1} overflow="hidden" flexDirection="column" aria-role="textbox" aria-state={{ multiline: true }}>
        {composer.rows.map((line, index) => (
          <Text key={`${index}:${line}`} wrap="truncate-end">
            <Text color="green">{composerPrefix(composer, index)}</Text>{line.length === 0 ? ' ' : line}
          </Text>
        ))}
      </Box>
      <Box height={layout.statusHeight} flexShrink={0} justifyContent="space-between" paddingX={1} overflow="hidden">
        <Text wrap="truncate-end">{statusText(props.state, props.viewport, now)}</Text>
        <Text dimColor wrap="truncate-end">{props.profile.protocol} / {props.profile.model}</Text>
      </Box>
    </Box>
  );
}

export function formatTranscript(turns: readonly TranscriptTurn[], width = 78, now = performance.now(), decision?: import('./task-input.js').TaskDecision, selectedDecision = 0): readonly DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const turn of turns) {
    rows.push(...wrapStyledSpans(
      [{ text: turn.userText }],
      width,
      `${turn.turnId}:user`,
      [{ text: '> ', style: { color: 'green' } }],
      [{ text: '  ' }],
    ));

    if (turn.activities.length > 0) {
      turn.activities.forEach((activity, activityIndex) => {
        if (activity.type === 'tool') {
          rows.push({
            key: `${turn.turnId}:tool:${activity.callId}`,
            spans: [{ text: `  ${toolMarker(activity.status)} ${activity.toolName} · ${toolSummary(activity)}`, style: toolStyle(activity.status) }],
          });
          return;
        }
        if (activity.type === 'plan') {
          rows.push(...planRows(turn.turnId, activity.plan, width, activityIndex));
          return;
        }
        if (activity.type === 'task') {
          const stats = activity.runCount === undefined ? '' : ` · 累计 ${activity.runCount} 次运行 / ${activity.totalIterations ?? 0} 次迭代`;
          rows.push({ key: `${turn.turnId}:task:${activityIndex}`, spans: [{ text: `  ${activity.summary}${stats}`, style: { color: 'yellow' } }] });
          return;
        }
        const answerRows = renderMarkdown(activity.text, {
          width: Math.max(1, width - 2), final: turn.phase !== 'generating',
          keyPrefix: `${turn.turnId}:assistant:${activityIndex}`,
        });
        rows.push(...prefixRows(answerRows, [{ text: '● ', style: { color: 'cyan' } }], [{ text: '  ' }], `${turn.turnId}:answer:${activityIndex}`));
      });
    } else if (turn.assistantText.length > 0) {
      const answerRows = renderMarkdown(turn.assistantText, { width: Math.max(1, width - 2), final: turn.phase !== 'generating', keyPrefix: `${turn.turnId}:assistant` });
      rows.push(...prefixRows(answerRows, [{ text: '● ', style: { color: 'cyan' } }], [{ text: '  ' }], `${turn.turnId}:answer`));
    } else {
      rows.push({
        key: `${turn.turnId}:waiting`,
        spans: [{ text: `● ${turn.phase === 'generating' ? `${spinnerFrame(now)} 等待响应` : ''}`, style: { color: 'cyan' } }],
      });
    }

    if (turn.phase !== 'generating') {
      rows.push({
        key: `${turn.turnId}:status`,
        spans: [{ text: `  ${turnLabel(turn)}${formatStats(turn)}${formatDurationSuffix(turn.durationMs)}`, style: { dimColor: true } }],
      });
    }
    rows.push({ key: `${turn.turnId}:blank`, spans: [{ text: '' }] });
  }
  if (decision !== undefined) {
    rows.push({ key: 'task-decision', spans: decisionOptions(decision).flatMap((option, index) => [
      { text: `${index === selectedDecision ? '> ' : '  '}${option}`, style: index === selectedDecision ? { color: 'cyan', bold: true } : { dimColor: true } },
      ...(index === decisionOptions(decision).length - 1 ? [] : [{ text: '   ' }]),
    ]) });
  }
  return rows;
}

function planRows(turnId: string, plan: import('../shared/types.js').Plan, width: number, activityIndex: number): readonly DisplayRow[] {
  const lines = [
    `计划 v${plan.version}：${plan.goal}`,
    `任务标准：${plan.successCriteria.join('；')}`,
    ...plan.steps.map((step, index) => {
      const dependencies = step.dependencies.length === 0 ? '无' : step.dependencies.join(', ');
      const evidence = step.evidence.length === 0 ? '' : `；证据：${step.evidence.join('；')}`;
      return `${index + 1}. [${step.status}] ${step.description}；依赖：${dependencies}；标准：${step.successCriteria.join('；')}${evidence}`;
    }),
  ];
  return lines.flatMap((line, index) => wrapStyledSpans(
    [{ text: line, style: index === 0 ? { bold: true, color: 'cyan' } : undefined }],
    width,
    `${turnId}:plan:${activityIndex}:${index}`,
    [{ text: index === 0 ? '◆ ' : '  ' }],
    [{ text: '  ' }],
  ));
}

function toolMarker(status: Extract<TranscriptTurn['activities'][number], { type: 'tool' }>['status']): string {
  if (status === 'queued') return '○';
  if (status === 'running') return '◐';
  if (status === 'success') return '✓';
  if (status === 'skipped') return '↷';
  return '×';
}

function toolSummary(activity: Extract<TranscriptTurn['activities'][number], { type: 'tool' }>): string {
  if (activity.errorCode !== undefined) return `${activity.summary} (${activity.errorCode})`;
  return activity.summary;
}

function toolStyle(status: Extract<TranscriptTurn['activities'][number], { type: 'tool' }>['status']): StyledSpan['style'] {
  if (status === 'success') return { color: 'green' };
  if (status === 'error') return { color: 'red' };
  if (status === 'skipped') return { color: 'yellow' };
  return { dimColor: true };
}

function formatStats(turn: TranscriptTurn): string {
  if (turn.modelTurnCount === undefined) return '';
  return ` · ${turn.modelTurnCount} 回合 · ${turn.toolCallCount ?? 0} 工具${(turn.toolErrorCount ?? 0) > 0 ? ` · ${turn.toolErrorCount} 错误` : ''}`;
}

function spinnerFrame(now: number): string {
  return SPINNER_FRAMES[Math.floor(Math.max(0, now) / 100) % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
}

function StyledRow({ row }: { readonly row: DisplayRow }): React.JSX.Element {
  return (
    <Text wrap="truncate-end">
      {row.spans.length === 0 ? ' ' : row.spans.map((span, index) => <StyledText key={`${index}:${span.text}`} span={span} />)}
    </Text>
  );
}

function StyledText({ span }: { readonly span: StyledSpan }): React.JSX.Element {
  if (span.style?.ansi === true) return <Text>{span.text}</Text>;
  return (
    <Text
      bold={span.style?.bold}
      italic={span.style?.italic}
      strikethrough={span.style?.strikethrough}
      underline={span.style?.underline}
      dimColor={span.style?.dimColor}
      color={span.style?.color}
    >{span.text.length === 0 ? ' ' : span.text}</Text>
  );
}

function composerPrefix(viewport: ReturnType<typeof composerViewport>, index: number): string {
  if (index === 0 && viewport.hiddenAbove) return '↑ ';
  if (index === viewport.rows.length - 1 && viewport.hiddenBelow) return '↓ ';
  return index === viewport.cursorRow ? '> ' : '  ';
}

function queueSummary(state: TuiState, width: number): string {
  const latest = state.queuedMessages.at(-1) ?? '';
  const prefix = state.queueStatus === 'paused' ? `队列已暂停 · ${state.queuedMessages.length} 条 · ` : `已排队 ${state.queuedMessages.length} 条 · 最新：`;
  return prefix + truncateDisplay(latest.replace(/\s+/g, ' '), Math.max(1, width - displayWidth(prefix)));
}

function statusText(state: TuiState, viewport: ViewportState, now: number): string {
  const mode = taskModeText(state);
  if (!viewport.follow) return `${mode} · 正在查看上文 · 新增 ${viewport.unreadRows} 行 · Ctrl+End 返回底部`;
  if (state.feedback?.startsWith('再按一次退出')) return `${mode} · ${state.feedback}`;
  if (state.queueStatus === 'paused' && state.queuedMessages.length > 0) return `${mode} · 队列已暂停 · Enter 继续发送`;
  if (state.activeTurnId !== undefined) {
    const turn = state.transcript.find((candidate) => candidate.turnId === state.activeTurnId);
    if (turn !== undefined) {
      const elapsed = formatDuration(Math.max(0, now - turn.startedAt));
      return state.streamStatus === 'waiting' ? `${mode} · 等待响应 · ${elapsed}` : `${mode} · 生成中 · ${elapsed}`;
    }
  }
  return state.feedback === undefined ? mode : `${mode} · ${state.feedback}`;
}

function taskModeText(state: TuiState): string {
  const display = state.taskDisplay;
  if (display.mode === 'react') {
    if (display.phase === 'running') return 'ReAct · 运行中';
    if (display.phase === 'awaiting_input') return 'ReAct · 等待输入';
    if (display.phase === 'stopped') return 'ReAct · 已停止';
    if (display.phase === 'cancelled') return 'ReAct · 已取消';
    return 'ReAct · 就绪';
  }
  if (display.phase === 'planning') return 'Plan · 规划中';
  if (display.phase === 'awaiting_approval') return 'Plan · 待确认';
  if (display.phase === 'awaiting_input') return 'Plan · 等待输入';
  if (display.phase === 'stopped') return 'Plan · 已停止';
  if (display.phase === 'cancelled') return 'Plan · 已取消';
  if (display.currentStep !== undefined && display.totalSteps !== undefined) {
    return `Plan · 执行 ${display.currentStep}/${display.totalSteps}`;
  }
  return 'Plan · 执行中';
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
