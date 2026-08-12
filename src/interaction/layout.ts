import { cursorPosition, wrapDisplayText } from './display-width.js';

export interface LayoutMetrics {
  readonly headerHeight: number;
  readonly transcriptHeight: number;
  readonly queueHeight: number;
  readonly composerHeight: number;
  readonly statusHeight: number;
}

export interface ComposerViewport {
  readonly rows: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
  readonly hiddenAbove: boolean;
  readonly hiddenBelow: boolean;
}

export function calculateLayout(rows: number, composer: string, columns = 80, queueCount = 0): LayoutMetrics {
  const headerHeight = 5;
  const statusHeight = 1;
  const queueHeight = queueCount > 0 ? 1 : 0;
  const composerContentWidth = Math.max(1, columns - 6);
  const composerRows = Math.max(1, wrapDisplayText(composer, composerContentWidth).length);
  const composerHeight = Math.min(7, composerRows + 2);
  const transcriptHeight = Math.max(3, rows - headerHeight - queueHeight - composerHeight - statusHeight);
  return { headerHeight, transcriptHeight, queueHeight, composerHeight, statusHeight };
}

export function composerViewport(
  value: string,
  cursor: number,
  width: number,
  maxRows: number,
): ComposerViewport {
  const safeWidth = Math.max(1, width);
  const safeMaxRows = Math.max(1, maxRows);
  const wrapped = [...wrapDisplayText(value, safeWidth)];
  let position = cursorPosition(value, cursor, safeWidth);
  if (cursor === value.length && wrapped.at(-1)?.width === safeWidth && !value.endsWith('\n')) {
    wrapped.push({ text: '', start: value.length, end: value.length, width: 0 });
    position = { row: wrapped.length - 1, column: 0 };
  }
  const maximumStart = Math.max(0, wrapped.length - safeMaxRows);
  const start = Math.min(maximumStart, Math.max(0, position.row - Math.floor(safeMaxRows / 2)));
  const end = Math.min(wrapped.length, start + safeMaxRows);
  return {
    rows: wrapped.slice(start, end).map((line) => line.text),
    cursorRow: position.row - start,
    cursorColumn: position.column,
    hiddenAbove: start > 0,
    hiddenBelow: end < wrapped.length,
  };
}
