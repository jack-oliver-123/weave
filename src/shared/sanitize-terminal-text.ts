import stripAnsi from 'strip-ansi';

const UNSAFE_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function sanitizeTerminalText(value: string): string {
  return stripAnsi(value).replace(UNSAFE_CONTROL_CHARACTERS, '');
}
