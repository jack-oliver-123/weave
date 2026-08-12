import { displayWidth, graphemeSegments } from './display-width.js';

export interface TextStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly strikethrough?: boolean;
  readonly underline?: boolean;
  readonly dimColor?: boolean;
  readonly color?: 'blue' | 'cyan' | 'gray' | 'green' | 'magenta' | 'red' | 'white' | 'yellow';
  readonly ansi?: boolean;
}

export interface StyledSpan {
  readonly text: string;
  readonly style?: TextStyle;
}

export interface DisplayRow {
  readonly key: string;
  readonly spans: readonly StyledSpan[];
}

interface StyledGrapheme {
  readonly text: string;
  readonly width: number;
  readonly style?: TextStyle;
}

export function rowText(row: DisplayRow): string {
  return row.spans.map((span) => span.text).join('');
}

export function rowWidth(row: DisplayRow): number {
  return displayWidth(rowText(row));
}

export function plainRow(key: string, text: string, style?: TextStyle): DisplayRow {
  return { key, spans: [{ text, ...(style === undefined ? {} : { style }) }] };
}

export function wrapStyledSpans(
  spans: readonly StyledSpan[],
  width: number,
  keyPrefix: string,
  firstPrefix: readonly StyledSpan[] = [],
  continuationPrefix: readonly StyledSpan[] = firstPrefix,
): readonly DisplayRow[] {
  const safeWidth = Math.max(1, width);
  const content = toStyledGraphemes(spans);
  const rows: DisplayRow[] = [];
  let index = 0;

  const createRow = (prefix: readonly StyledSpan[]) => {
    const rowSpans: StyledSpan[] = [...prefix];
    let used = displayWidth(prefix.map((span) => span.text).join(''));
    while (index < content.length) {
      const item = content[index];
      if (item?.text === '\n') {
        index += 1;
        break;
      }
      if (item === undefined) break;
      if (rowSpans.length > prefix.length && used + item.width > safeWidth) break;
      if (rowSpans.length === prefix.length && used + item.width > safeWidth && used > 0) break;
      appendSpan(rowSpans, item.text, item.style);
      used += item.width;
      index += 1;
      if (used >= safeWidth) break;
    }
    rows.push({ key: `${keyPrefix}:${rows.length}`, spans: rowSpans.length === 0 ? [{ text: '' }] : rowSpans });
  };

  if (content.length === 0) createRow(firstPrefix);
  while (index < content.length) createRow(rows.length === 0 ? firstPrefix : continuationPrefix);
  if (content.at(-1)?.text === '\n') createRow(continuationPrefix);
  return rows;
}

export function prefixRows(
  rows: readonly DisplayRow[],
  firstPrefix: readonly StyledSpan[],
  continuationPrefix: readonly StyledSpan[],
  keyPrefix: string,
): readonly DisplayRow[] {
  return rows.map((row, index) => ({
    key: `${keyPrefix}:${row.key}`,
    spans: [...(index === 0 ? firstPrefix : continuationPrefix), ...row.spans],
  }));
}

function toStyledGraphemes(spans: readonly StyledSpan[]): StyledGrapheme[] {
  const result: StyledGrapheme[] = [];
  for (const span of spans) {
    if (span.style?.ansi === true) {
      result.push({ text: span.text, width: displayWidth(span.text), style: span.style });
      continue;
    }
    for (const segment of graphemeSegments(span.text)) {
      result.push({ text: segment.segment, width: segment.width, ...(span.style === undefined ? {} : { style: span.style }) });
    }
  }
  return result;
}

function appendSpan(spans: StyledSpan[], text: string, style?: TextStyle): void {
  const previous = spans.at(-1);
  if (previous !== undefined && sameStyle(previous.style, style)) {
    spans[spans.length - 1] = { ...previous, text: previous.text + text };
    return;
  }
  spans.push({ text, ...(style === undefined ? {} : { style }) });
}

function sameStyle(left?: TextStyle, right?: TextStyle): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
}
