const ENTER_ALTERNATE_SCREEN = '\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l';
const LEAVE_ALTERNATE_SCREEN = '\u001b[?25h\u001b[?1049l';
const ENABLE_MOUSE_TRACKING = '\u001b[?1000h\u001b[?1006h';
const DISABLE_MOUSE_TRACKING = '\u001b[?1006l\u001b[?1000l';

export function enterAlternateScreen(stdout: Pick<NodeJS.WriteStream, 'write'>): void {
  stdout.write(ENTER_ALTERNATE_SCREEN);
}

export function leaveAlternateScreen(stdout: Pick<NodeJS.WriteStream, 'write'>): void {
  stdout.write(LEAVE_ALTERNATE_SCREEN);
}

export function enableMouseTracking(stdout: Pick<NodeJS.WriteStream, 'write'>): void {
  stdout.write(ENABLE_MOUSE_TRACKING);
}

export function disableMouseTracking(stdout: Pick<NodeJS.WriteStream, 'write'>): void {
  stdout.write(DISABLE_MOUSE_TRACKING);
}
