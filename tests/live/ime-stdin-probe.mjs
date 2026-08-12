import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const logDirectory = resolve('.weave');
const tuiModes = process.argv.includes('--tui-modes');
const logPath = resolve(logDirectory, tuiModes ? 'ime-probe-tui-modes.log' : 'ime-probe.log');
mkdirSync(logDirectory, { recursive: true });
writeFileSync(logPath, `probe started ${new Date().toISOString()}\n`, 'utf8');

process.stdin.setEncoding('utf8');
process.stdin.setRawMode(true);
process.stdin.resume();
if (tuiModes) process.stdout.write('\u001b[?1049h\u001b[2J\u001b[H\u001b[?1000h\u001b[?1006h\u001b[?2004h');
process.stdout.write('请用中文输入法输入“你好”并按空格选词。完成后按 Ctrl+C。\n> ');

function restoreTerminal() {
  if (process.stdin.isRaw) process.stdin.setRawMode(false);
  if (tuiModes) process.stdout.write('\u001b[?2004l\u001b[?1006l\u001b[?1000l\u001b[?1049l');
}

process.stdin.on('data', (value) => {
  const text = String(value);
  if (text === '\u0003') {
    restoreTerminal();
    process.stdin.pause();
    process.stdout.write(`\n探针已结束，日志：${logPath}\n`);
    return;
  }
  const record = `${new Date().toISOString()} text=${JSON.stringify(text)} hex=${Buffer.from(text).toString('hex')}\n`;
  appendFileSync(logPath, record, 'utf8');
  process.stdout.write(`\n${record}> `);
});

process.once('exit', restoreTerminal);
