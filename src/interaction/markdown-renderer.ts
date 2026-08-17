import { highlight, supportsLanguage, type Theme } from 'cli-highlight';
import type {
  List,
  ListItem,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import { sanitizeTerminalText } from '../shared/sanitize-terminal-text.js';
import { displayWidth, wrapDisplayText } from './display-width.js';
import {
  plainRow,
  rowText,
  wrapStyledSpans,
  type DisplayRow,
  type StyledSpan,
  type TextStyle,
} from './display-row.js';

export { rowText } from './display-row.js';
export type { DisplayRow, StyledSpan, TextStyle } from './display-row.js';

export interface MarkdownRenderOptions {
  readonly width: number;
  readonly final: boolean;
  readonly color?: boolean;
  readonly keyPrefix?: string;
}

export interface SemanticBlock {
  readonly anchor: string;
  readonly kind: RootContent['type'];
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly rows: readonly DisplayRow[];
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);
const SGR_SEQUENCE = /\u001b\[[0-9;]*m/g;
const stableParseCache = new Map<string, Root>();
const INTERNAL_HIGHLIGHT_THEME: Theme = {
  keyword: sgrColor(36), built_in: sgrColor(35), type: sgrColor(35), literal: sgrColor(33),
  number: sgrColor(32), regexp: sgrColor(32), string: sgrColor(32), subst: sgrColor(36),
  symbol: sgrColor(33), class: sgrColor(35), function: sgrColor(36), title: sgrColor(36),
  params: sgrColor(33), comment: sgrColor(90), doctag: sgrColor(90), meta: sgrColor(35),
  'meta-keyword': sgrColor(36), 'meta-string': sgrColor(32), section: sgrColor(36),
  tag: sgrColor(36), name: sgrColor(36), 'builtin-name': sgrColor(35), attr: sgrColor(33),
  attribute: sgrColor(33), variable: sgrColor(33), bullet: sgrColor(36), code: sgrColor(32),
  emphasis: sgrColor(33), strong: sgrColor(33), formula: sgrColor(35), link: sgrColor(36),
  quote: sgrColor(90), 'selector-tag': sgrColor(36), 'selector-id': sgrColor(33),
  'selector-class': sgrColor(33), 'selector-attr': sgrColor(33), 'selector-pseudo': sgrColor(35),
  'template-tag': sgrColor(36), 'template-variable': sgrColor(33), addition: sgrColor(32),
  deletion: sgrColor(31),
};
const MAX_STABLE_CACHE_ENTRIES = 64;

export function renderMarkdown(source: string, options: MarkdownRenderOptions): readonly DisplayRow[] {
  const safeSource = sanitizeTerminalText(source);
  const width = Math.max(1, options.width);
  const keyPrefix = options.keyPrefix ?? 'md';
  try {
    const unstableStart = options.final ? undefined : findUnstableTailStart(safeSource);
    if (unstableStart === undefined) return renderAst(parseMarkdown(safeSource), width, keyPrefix, options.color);

    const stableSource = safeSource.slice(0, unstableStart).replace(/\n+$/, '');
    const unstableSource = safeSource.slice(unstableStart);
    const stableRows = stableSource.length === 0 ? [] : renderAst(parseStableMarkdown(stableSource), width, keyPrefix, options.color);
    const unstableRows = wrapStyledSpans([{ text: unstableSource }], width, `${keyPrefix}:pending`);
    return joinSections([stableRows, unstableRows], keyPrefix);
  } catch {
    return wrapStyledSpans([{ text: safeSource }], width, `${keyPrefix}:fallback`);
  }
}

function parseMarkdown(source: string): Root {
  return markdownParser.parse(source) as Root;
}

function parseStableMarkdown(source: string): Root {
  const cached = stableParseCache.get(source);
  if (cached !== undefined) return cached;
  const parsed = parseMarkdown(source);
  stableParseCache.set(source, parsed);
  if (stableParseCache.size > MAX_STABLE_CACHE_ENTRIES) {
    const oldest = stableParseCache.keys().next().value as string | undefined;
    if (oldest !== undefined) stableParseCache.delete(oldest);
  }
  return parsed;
}

function renderAst(root: Root, width: number, keyPrefix: string, color?: boolean): readonly DisplayRow[] {
  const blocks = root.children.map((node, index) => createSemanticBlock(node, index, width, keyPrefix, color));
  return joinSections(blocks.map((block) => block.rows), keyPrefix);
}

function createSemanticBlock(
  node: RootContent,
  fallback: number,
  width: number,
  keyPrefix: string,
  color?: boolean,
): SemanticBlock {
  const sourceStart = node.position?.start.offset ?? fallback;
  const sourceEnd = node.position?.end.offset ?? sourceStart;
  const anchor = `${keyPrefix}:${node.type}:${sourceStart}`;
  return {
    anchor,
    kind: node.type,
    sourceStart,
    sourceEnd,
    rows: renderBlock(node, width, anchor, color),
  };
}

function renderBlock(node: RootContent, width: number, key: string, color?: boolean): readonly DisplayRow[] {
  switch (node.type) {
    case 'paragraph':
      return wrapStyledSpans(inlineSpans(node.children), width, key);
    case 'heading':
      return wrapStyledSpans(applyStyle(inlineSpans(node.children), { bold: true, color: node.depth <= 2 ? 'cyan' : 'blue' }), width, key);
    case 'thematicBreak':
      return [plainRow(key, '─'.repeat(Math.max(1, width)), { dimColor: true })];
    case 'blockquote': {
      const inner = joinSections(node.children.map((child, index) => renderBlock(child, Math.max(1, width - 2), `${key}:quote:${index}`, color)), `${key}:quote`);
      return inner.map((row, index) => ({
        key: `${key}:${index}`,
        spans: [{ text: '│ ', style: { color: 'cyan', dimColor: true } }, ...row.spans],
      }));
    }
    case 'list':
      return renderList(node, width, key, color);
    case 'table':
      return renderTable(node, width, key);
    case 'code':
      return renderCode(node.value, node.lang ?? undefined, width, key, color);
    case 'html':
      return wrapStyledSpans([{ text: node.value }], width, key);
    case 'definition':
      return [];
    default:
      return renderUnknownBlock(node, width, key);
  }
}

function renderList(list: List, width: number, key: string, color?: boolean, depth = 0): readonly DisplayRow[] {
  const rows: DisplayRow[] = [];
  const start = list.start ?? 1;
  list.children.forEach((item, itemIndex) => {
    const marker = item.checked === true
      ? '☑ '
      : item.checked === false
        ? '☐ '
        : list.ordered === true
          ? `${start + itemIndex}. `
          : '• ';
    const indent = '  '.repeat(depth);
    const prefix = `${indent}${marker}`;
    const continuation = ' '.repeat(displayWidth(prefix));
    const [first, ...remaining] = item.children;
    if (first?.type === 'paragraph') {
      rows.push(...wrapStyledSpans(
        inlineSpans(first.children),
        width,
        `${key}:${itemIndex}:text`,
        [{ text: prefix, style: { color: 'green' } }],
        [{ text: continuation }],
      ));
    } else if (first !== undefined) {
      const nestedRows = renderListItemBlock(first, Math.max(1, width - displayWidth(prefix)), `${key}:${itemIndex}:first`, color, depth);
      rows.push(...nestedRows.map((row, index) => ({
        key: `${key}:${itemIndex}:first:${index}`,
        spans: [{ text: index === 0 ? prefix : continuation }, ...row.spans],
      })));
    }
    for (const [childIndex, child] of remaining.entries()) {
      rows.push(...renderListItemBlock(child, width, `${key}:${itemIndex}:${childIndex}`, color, depth + 1));
    }
  });
  return rows;
}

function renderListItemBlock(
  node: ListItem['children'][number],
  width: number,
  key: string,
  color: boolean | undefined,
  depth: number,
): readonly DisplayRow[] {
  if (node.type === 'list') return renderList(node, width, key, color, depth);
  return renderBlock(node, width, key, color);
}

function renderTable(table: Table, width: number, key: string): readonly DisplayRow[] {
  const [headerRow, ...bodyRows] = table.children;
  if (headerRow === undefined) return [];
  const headers = headerRow.children.map((cell) => inlinePlainText(cell.children));
  const values = bodyRows.map((row) => row.children.map((cell) => inlinePlainText(cell.children)));
  const columnWidths = headers.map((header, index) => Math.max(
    displayWidth(header),
    ...values.map((row) => displayWidth(row[index] ?? '')),
  ));
  const requiredWidth = columnWidths.reduce((sum, cellWidth) => sum + cellWidth, 0) + Math.max(0, columnWidths.length - 1) * 3;

  if (requiredWidth <= width) {
    const aligned = [headers, ...values].map((row, rowIndex) => plainRow(
      `${key}:${rowIndex}`,
      row.map((cell, index) => padDisplay(cell ?? '', columnWidths[index] ?? 0)).join(' │ '),
      rowIndex === 0 ? { bold: true, color: 'cyan' } : undefined,
    ));
    if (aligned.length > 1) aligned.splice(1, 0, plainRow(`${key}:separator`, columnWidths.map((cellWidth) => '─'.repeat(cellWidth)).join('─┼─'), { dimColor: true }));
    return aligned;
  }

  const rows: DisplayRow[] = [];
  values.forEach((record, recordIndex) => {
    headers.forEach((header, columnIndex) => {
      rows.push(...wrapStyledSpans(
        [{ text: `${header}：`, style: { bold: true, color: 'cyan' } }, { text: record[columnIndex] ?? '' }],
        width,
        `${key}:${recordIndex}:${columnIndex}`,
      ));
    });
    if (recordIndex < values.length - 1) rows.push(plainRow(`${key}:${recordIndex}:blank`, ''));
  });
  return rows;
}

function renderCode(value: string, language: string | undefined, width: number, key: string, color?: boolean): readonly DisplayRow[] {
  const rows: DisplayRow[] = [];
  if (language !== undefined && language.length > 0) rows.push(plainRow(`${key}:language`, language, { dimColor: true, color: 'cyan' }));
  const contentWidth = Math.max(1, width - 2);
  const logicalLines = value.split('\n');
  logicalLines.forEach((line, lineIndex) => {
    const wrapped = wrapDisplayText(line, contentWidth);
    wrapped.forEach((visualLine, visualIndex) => {
      const prefix = visualIndex === 0 ? '  ' : '↪ ';
      const highlighted = highlightCode(visualLine.text, language, color);
      rows.push({
        key: `${key}:code:${lineIndex}:${visualIndex}`,
        spans: [
          { text: prefix, style: { dimColor: visualIndex > 0, color: visualIndex > 0 ? 'gray' : undefined } },
          { text: highlighted, style: highlighted === visualLine.text ? undefined : { ansi: true } },
        ],
      });
    });
  });
  return rows;
}

function highlightCode(value: string, language: string | undefined, color?: boolean): string {
  const allowColor = color ?? (process.stdout.isTTY === true && process.env['NO_COLOR'] === undefined);
  if (!allowColor || language === undefined || !supportsLanguage(language)) return value;
  try {
    const result = highlight(value, { language, ignoreIllegals: true, theme: INTERNAL_HIGHLIGHT_THEME });
    const withoutSgr = result.replace(SGR_SEQUENCE, '');
    return withoutSgr.includes('\u001b') ? value : result;
  } catch {
    return value;
  }
}

function sgrColor(code: number): (value: string) => string {
  return (value) => `\u001b[${code}m${value}\u001b[39m`;
}

function inlineSpans(nodes: readonly PhrasingContent[], inherited: TextStyle = {}): readonly StyledSpan[] {
  const result: StyledSpan[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        result.push({ text: node.value, ...(Object.keys(inherited).length === 0 ? {} : { style: inherited }) });
        break;
      case 'strong':
        result.push(...inlineSpans(node.children, { ...inherited, bold: true }));
        break;
      case 'emphasis':
        result.push(...inlineSpans(node.children, { ...inherited, italic: true }));
        break;
      case 'delete':
        result.push(...inlineSpans(node.children, { ...inherited, strikethrough: true }));
        break;
      case 'inlineCode':
        result.push({ text: node.value, style: { ...inherited, color: 'yellow' } });
        break;
      case 'link':
        result.push(...inlineSpans(node.children, { ...inherited, underline: true, color: 'blue' }));
        result.push({ text: ` (${node.url})`, style: { ...inherited, dimColor: true } });
        break;
      case 'break':
        result.push({ text: '\n' });
        break;
      case 'image':
        result.push({ text: `[图片：${node.alt ?? ''}] (${node.url})`, style: { ...inherited, dimColor: true } });
        break;
      case 'html':
        result.push({ text: node.value, ...(Object.keys(inherited).length === 0 ? {} : { style: inherited }) });
        break;
      case 'footnoteReference':
        result.push({ text: `[^${node.label ?? node.identifier}]`, style: { ...inherited, dimColor: true } });
        break;
      case 'linkReference':
        result.push(...inlineSpans(node.children, inherited));
        break;
      case 'imageReference':
        result.push({ text: `[图片：${node.alt ?? ''}]`, style: { ...inherited, dimColor: true } });
        break;
      default:
        break;
    }
  }
  return result;
}

function applyStyle(spans: readonly StyledSpan[], style: TextStyle): readonly StyledSpan[] {
  return spans.map((span) => ({ ...span, style: { ...span.style, ...style } }));
}

function inlinePlainText(nodes: readonly PhrasingContent[]): string {
  return inlineSpans(nodes).map((span) => span.text).join('');
}

function renderUnknownBlock(node: RootContent, width: number, key: string): readonly DisplayRow[] {
  const maybeValue = 'value' in node && typeof node.value === 'string' ? node.value : '';
  return wrapStyledSpans([{ text: maybeValue }], width, key);
}

function joinSections(sections: readonly (readonly DisplayRow[])[], keyPrefix: string): readonly DisplayRow[] {
  const rows: DisplayRow[] = [];
  for (const section of sections) {
    if (section.length === 0) continue;
    if (rows.length > 0 && rowText(rows.at(-1) ?? plainRow('', '')).length > 0) rows.push(plainRow(`${keyPrefix}:blank:${rows.length}`, ''));
    rows.push(...section);
  }
  return rows;
}

function padDisplay(value: string, width: number): string {
  return value + ' '.repeat(Math.max(0, width - displayWidth(value)));
}

function findUnstableTailStart(source: string): number | undefined {
  const fenceStart = findUnclosedFence(source);
  if (fenceStart !== undefined) return fenceStart;
  const paragraphStart = Math.max(0, source.lastIndexOf('\n\n') + 2);
  const tail = source.slice(paragraphStart);
  if (unescapedCount(tail, '**') % 2 === 1) return paragraphStart;
  if (unescapedCount(tail, '~~') % 2 === 1) return paragraphStart;
  if (unescapedCount(tail, '`') % 2 === 1) return paragraphStart;
  const openBracket = tail.lastIndexOf('[');
  const closeLink = tail.lastIndexOf(')');
  if (openBracket > closeLink && (tail.includes('](') || tail.indexOf(']', openBracket) < 0)) return paragraphStart;
  return undefined;
}

function findUnclosedFence(source: string): number | undefined {
  const lines = source.split(/(?<=\n)/);
  let offset = 0;
  let open: { marker: string; length: number; start: number } | undefined;
  for (const line of lines) {
    const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (match?.[1] !== undefined) {
      const marker = match[1][0] ?? '';
      if (open === undefined) open = { marker, length: match[1].length, start: offset };
      else if (marker === open.marker && match[1].length >= open.length) open = undefined;
    }
    offset += line.length;
  }
  return open?.start;
}

function unescapedCount(value: string, marker: string): number {
  let count = 0;
  let index = 0;
  while ((index = value.indexOf(marker, index)) >= 0) {
    if (index === 0 || value[index - 1] !== '\\') count += 1;
    index += marker.length;
  }
  return count;
}
