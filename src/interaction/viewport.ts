export interface KeyedViewportRow {
  readonly key: string;
}

export interface ViewportState {
  readonly follow: boolean;
  readonly offsetFromBottom: number;
  readonly unreadRows: number;
  readonly lineCount: number;
  readonly anchorKey?: string;
}

export type ViewportAction =
  | { readonly type: 'scroll_up'; readonly lines: number; readonly rows: readonly KeyedViewportRow[]; readonly height: number }
  | { readonly type: 'scroll_down'; readonly lines: number; readonly rows: readonly KeyedViewportRow[]; readonly height: number }
  | { readonly type: 'bottom' }
  | { readonly type: 'content'; readonly rows: readonly KeyedViewportRow[]; readonly height: number }
  | { readonly type: 'resize'; readonly rows: readonly KeyedViewportRow[]; readonly height: number };

export function initialViewportState(): ViewportState {
  return { follow: true, offsetFromBottom: 0, unreadRows: 0, lineCount: 0 };
}

export function reduceViewport(state: ViewportState, action: ViewportAction): ViewportState {
  if (action.type === 'bottom') {
    return { ...state, follow: true, offsetFromBottom: 0, unreadRows: 0, anchorKey: undefined };
  }
  if (action.type === 'scroll_up') {
    return moveViewport(state, action.rows, action.height, -Math.max(1, action.lines));
  }
  if (action.type === 'scroll_down') {
    return moveViewport(state, action.rows, action.height, Math.max(1, action.lines));
  }

  const rows = action.rows;
  if (state.follow) {
    return { ...state, lineCount: rows.length, unreadRows: 0 };
  }
  const start = anchorStart(state, rows, action.height);
  const maximumStart = Math.max(0, rows.length - Math.max(1, action.height));
  const clampedStart = Math.min(maximumStart, start);
  const follow = clampedStart >= maximumStart;
  return {
    follow,
    offsetFromBottom: follow ? 0 : offsetForStart(rows.length, action.height, clampedStart),
    unreadRows: follow
      ? 0
      : state.unreadRows + (action.type === 'content' ? Math.max(0, rows.length - state.lineCount) : 0),
    lineCount: rows.length,
    anchorKey: follow ? undefined : rows[clampedStart]?.key,
  };
}

export function visibleViewportLines<T extends KeyedViewportRow>(
  lines: readonly T[],
  height: number,
  state: ViewportState,
): readonly T[] {
  const safeHeight = Math.max(1, height);
  if (!state.follow && state.anchorKey !== undefined) {
    const anchorIndex = lines.findIndex((line) => line.key === state.anchorKey);
    if (anchorIndex >= 0) return lines.slice(anchorIndex, anchorIndex + safeHeight);
  }
  const end = Math.max(0, lines.length - state.offsetFromBottom);
  const start = Math.max(0, end - safeHeight);
  return lines.slice(start, end);
}

function moveViewport(
  state: ViewportState,
  rows: readonly KeyedViewportRow[],
  height: number,
  delta: number,
): ViewportState {
  const safeHeight = Math.max(1, height);
  const maximumStart = Math.max(0, rows.length - safeHeight);
  const currentStart = state.follow ? maximumStart : anchorStart(state, rows, safeHeight);
  const start = Math.max(0, Math.min(maximumStart, currentStart + delta));
  const follow = start >= maximumStart;
  return {
    follow,
    offsetFromBottom: follow ? 0 : offsetForStart(rows.length, safeHeight, start),
    unreadRows: follow ? 0 : state.unreadRows,
    lineCount: rows.length,
    anchorKey: follow ? undefined : rows[start]?.key,
  };
}

function anchorStart(state: ViewportState, rows: readonly KeyedViewportRow[], height: number): number {
  if (state.anchorKey !== undefined) {
    const anchorIndex = rows.findIndex((row) => row.key === state.anchorKey);
    if (anchorIndex >= 0) return anchorIndex;
  }
  return Math.max(0, rows.length - Math.max(1, height) - state.offsetFromBottom);
}

function offsetForStart(lineCount: number, height: number, start: number): number {
  return Math.max(0, lineCount - Math.min(lineCount, start + Math.max(1, height)));
}
