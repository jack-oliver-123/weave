import { TextDecoder } from 'node:util';
import { ToolError } from './errors.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

export function decodeUtf8(buffer: Buffer): { text: string; bom: boolean } {
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  try {
    const text = decoder.decode(bom ? buffer.subarray(3) : buffer);
    if (text.includes('\0')) throw new Error('binary');
    return { text, bom };
  } catch {
    throw new ToolError('INVALID_UTF8', '文件不是有效 UTF-8 文本。', false);
  }
}

export function encodeUtf8(text: string, bom = false): Buffer {
  const content = Buffer.from(text, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), content]) : content;
}

export function sliceLines(text: string, startLine = 1, lineCount?: number): {
  content: string; startLine: number; endLine: number; totalLines: number;
} {
  const lines = text.match(/.*?(?:\r\n|\n|\r|$)/g)?.filter((line, index, all) => line.length > 0 || index < all.length - 1) ?? [];
  const totalLines = text.length === 0 ? 0 : lines.length;
  if (!Number.isInteger(startLine) || startLine < 1) throw new ToolError('INVALID_ARGUMENT', 'startLine 必须是正整数。', false);
  if (lineCount !== undefined && (!Number.isInteger(lineCount) || lineCount < 1)) {
    throw new ToolError('INVALID_ARGUMENT', 'lineCount 必须是正整数。', false);
  }
  const selected = lines.slice(startLine - 1, lineCount === undefined ? undefined : startLine - 1 + lineCount);
  return {
    content: selected.join(''), startLine,
    endLine: selected.length === 0 ? Math.min(startLine - 1, totalLines) : startLine + selected.length - 1,
    totalLines,
  };
}
