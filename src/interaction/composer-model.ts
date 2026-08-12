import { nextGraphemeBoundary, previousGraphemeBoundary, wrapDisplayText } from './display-width.js';

export interface ComposerState {
  readonly value: string;
  readonly cursor: number;
}

export interface ComposerKey {
  readonly return?: boolean;
  readonly shift?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly home?: boolean;
  readonly end?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
}

export interface ComposerResult {
  readonly state: ComposerState;
  readonly submitted?: string;
}

export function applyComposerKey(
  state: ComposerState,
  input: string,
  key: ComposerKey,
  canSubmit: boolean,
  displayColumns = Number.MAX_SAFE_INTEGER,
): ComposerResult {
  if (key.return === true) {
    if (key.shift === true) return { state: insertText(state, '\n') };
    if (canSubmit && state.value.trim().length > 0) {
      return { state: { value: '', cursor: 0 }, submitted: state.value };
    }
    return { state };
  }
  if (key.leftArrow === true) return { state: { ...state, cursor: previousGraphemeBoundary(state.value, state.cursor) } };
  if (key.rightArrow === true) return { state: { ...state, cursor: nextGraphemeBoundary(state.value, state.cursor) } };
  if (key.upArrow === true) return { state: { ...state, cursor: moveVertical(state.value, state.cursor, displayColumns, -1) } };
  if (key.downArrow === true) return { state: { ...state, cursor: moveVertical(state.value, state.cursor, displayColumns, 1) } };
  if (key.home === true) return { state: { ...state, cursor: visualLineBoundary(state.value, state.cursor, displayColumns, 'start') } };
  if (key.end === true) return { state: { ...state, cursor: visualLineBoundary(state.value, state.cursor, displayColumns, 'end') } };
  if (key.backspace === true && state.cursor > 0) {
    const previous = previousGraphemeBoundary(state.value, state.cursor);
    return { state: { value: state.value.slice(0, previous) + state.value.slice(state.cursor), cursor: previous } };
  }
  if (key.delete === true && state.cursor < state.value.length) {
    const next = nextGraphemeBoundary(state.value, state.cursor);
    return { state: { value: state.value.slice(0, state.cursor) + state.value.slice(next), cursor: state.cursor } };
  }
  if (input.length > 0) return { state: insertText(state, input) };
  return { state };
}

export function insertPaste(state: ComposerState, text: string): ComposerState {
  return insertText(state, text);
}

function insertText(state: ComposerState, text: string): ComposerState {
  return {
    value: state.value.slice(0, state.cursor) + text + state.value.slice(state.cursor),
    cursor: state.cursor + text.length,
  };
}

function visualLineBoundary(value: string, cursor: number, width: number, boundary: 'start' | 'end'): number {
  const lines = wrapDisplayText(value, width);
  const row = findCursorRow(lines, cursor);
  const line = lines[row];
  if (line === undefined) return cursor;
  if (boundary === 'start') return line.start;
  return lineContentEnd(value, line.start, line.end);
}

function moveVertical(value: string, cursor: number, width: number, direction: -1 | 1): number {
  const lines = wrapDisplayText(value, width);
  const currentRow = findCursorRow(lines, cursor);
  const target = lines[currentRow + direction];
  const current = lines[currentRow];
  if (target === undefined || current === undefined) return cursor;
  const desiredColumn = displayColumn(value.slice(current.start, cursor));
  return indexAtColumn(value, target.start, target.end, desiredColumn);
}

function findCursorRow(lines: readonly { start: number; end: number }[], cursor: number): number {
  const index = lines.findIndex((line, row) => line.start <= cursor && (cursor < line.end || row === lines.length - 1));
  return index < 0 ? Math.max(0, lines.length - 1) : index;
}

function displayColumn(value: string): number {
  return wrapDisplayText(value, Number.MAX_SAFE_INTEGER)[0]?.width ?? 0;
}

function indexAtColumn(value: string, start: number, end: number, column: number): number {
  let index = start;
  const contentEnd = lineContentEnd(value, start, end);
  while (index < contentEnd) {
    const next = nextGraphemeBoundary(value, index);
    if (displayColumn(value.slice(start, next)) > column) break;
    index = next;
  }
  return index;
}

function lineContentEnd(value: string, start: number, end: number): number {
  if (end <= start) return end;
  if (value[end - 1] === '\n') return end > start + 1 && value[end - 2] === '\r' ? end - 2 : end - 1;
  return value[end - 1] === '\r' ? end - 1 : end;
}
