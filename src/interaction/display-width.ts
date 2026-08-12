import stringWidth from 'string-width';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface GraphemeSegment {
  readonly segment: string;
  readonly index: number;
  readonly end: number;
  readonly width: number;
}

export interface WrappedDisplayLine {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly width: number;
}

export function graphemeSegments(value: string): readonly GraphemeSegment[] {
  return Array.from(segmenter.segment(value), (item) => ({
    segment: item.segment,
    index: item.index,
    end: item.index + item.segment.length,
    width: stringWidth(item.segment),
  }));
}

export function displayWidth(value: string): number {
  return stringWidth(value);
}

export function previousGraphemeBoundary(value: string, cursor: number): number {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  let previous = 0;
  for (const segment of graphemeSegments(value)) {
    if (segment.end >= safeCursor) return segment.index;
    previous = segment.end;
  }
  return previous;
}

export function nextGraphemeBoundary(value: string, cursor: number): number {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  for (const segment of graphemeSegments(value)) {
    if (segment.end > safeCursor) return segment.end;
  }
  return value.length;
}

export function normalizeGraphemeBoundary(value: string, cursor: number): number {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  if (safeCursor === 0 || safeCursor === value.length) return safeCursor;
  for (const segment of graphemeSegments(value)) {
    if (segment.index === safeCursor || segment.end === safeCursor) return safeCursor;
    if (segment.index < safeCursor && safeCursor < segment.end) return segment.index;
  }
  return safeCursor;
}

export function wrapDisplayText(value: string, width: number): readonly WrappedDisplayLine[] {
  const safeWidth = Math.max(1, width);
  const lines: WrappedDisplayLine[] = [];
  let lineText = '';
  let lineStart = 0;
  let lineEnd = 0;
  let lineWidth = 0;

  const flush = (emptyEnd = lineEnd) => {
    lines.push({ text: lineText, start: lineStart, end: emptyEnd, width: lineWidth });
    lineText = '';
    lineWidth = 0;
    lineStart = emptyEnd;
    lineEnd = emptyEnd;
  };

  for (const segment of graphemeSegments(value)) {
    if (segment.segment === '\n' || segment.segment === '\r' || segment.segment === '\r\n') {
      lineEnd = segment.index;
      flush(segment.end);
      continue;
    }
    if (lineText.length > 0 && lineWidth + segment.width > safeWidth) flush(segment.index);
    if (lineText.length === 0) lineStart = segment.index;
    lineText += segment.segment;
    lineWidth += segment.width;
    lineEnd = segment.end;
  }

  if (lineText.length > 0 || value.length === 0 || value.endsWith('\n')) flush(value.length);
  return lines;
}

export function cursorPosition(value: string, cursor: number, width: number): { readonly row: number; readonly column: number } {
  const boundary = normalizeGraphemeBoundary(value, cursor);
  const before = value.slice(0, boundary);
  const lines = wrapDisplayText(before, width);
  const row = Math.max(0, lines.length - 1);
  return { row, column: lines[row]?.width ?? 0 };
}

export function truncateDisplay(value: string, width: number, marker = '…'): string {
  const safeWidth = Math.max(0, width);
  if (displayWidth(value) <= safeWidth) return value;
  const markerWidth = displayWidth(marker);
  if (markerWidth > safeWidth) return '';
  let result = '';
  let used = 0;
  for (const segment of graphemeSegments(value)) {
    if (used + segment.width + markerWidth > safeWidth) break;
    result += segment.segment;
    used += segment.width;
  }
  return result + marker;
}
