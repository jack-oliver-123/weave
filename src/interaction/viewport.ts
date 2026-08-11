export interface ViewportState {
  readonly follow: boolean;
  readonly offsetFromBottom: number;
}

export type ViewportAction =
  | { readonly type: 'scroll_up'; readonly lines: number; readonly lineCount: number; readonly height: number }
  | { readonly type: 'scroll_down'; readonly lines: number }
  | { readonly type: 'bottom' }
  | { readonly type: 'content'; readonly lineCount: number; readonly height: number }
  | { readonly type: 'resize'; readonly lineCount: number; readonly height: number };

export function initialViewportState(): ViewportState {
  return { follow: true, offsetFromBottom: 0 };
}

export function reduceViewport(state: ViewportState, action: ViewportAction): ViewportState {
  if (action.type === 'bottom') return initialViewportState();
  if (action.type === 'scroll_down') {
    const offsetFromBottom = Math.max(0, state.offsetFromBottom - action.lines);
    return { follow: offsetFromBottom === 0, offsetFromBottom };
  }
  if (action.type === 'scroll_up') {
    const maximum = Math.max(0, action.lineCount - action.height);
    const offsetFromBottom = Math.min(maximum, state.offsetFromBottom + Math.max(1, action.lines));
    return { follow: offsetFromBottom === 0, offsetFromBottom };
  }
  if (action.type === 'content') {
    if (state.follow) return state;
    const maximum = Math.max(0, action.lineCount - action.height);
    return { follow: false, offsetFromBottom: Math.min(maximum, state.offsetFromBottom + 1) };
  }
  const maximum = Math.max(0, action.lineCount - action.height);
  const offsetFromBottom = Math.min(maximum, state.offsetFromBottom);
  return { follow: offsetFromBottom === 0, offsetFromBottom };
}

export function visibleViewportLines(
  lines: readonly string[],
  height: number,
  state: ViewportState,
): readonly string[] {
  const safeHeight = Math.max(1, height);
  const end = Math.max(0, lines.length - state.offsetFromBottom);
  const start = Math.max(0, end - safeHeight);
  return lines.slice(start, end);
}
