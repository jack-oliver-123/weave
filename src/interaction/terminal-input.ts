const SGR_MOUSE_EVENT = /^(?:\u001b)?\[<(\d+);\d+;\d+[Mm]/;
const INCOMPLETE_SGR_MOUSE = /^(?:\u001b)?\[<(?:\d+)?(?:;\d*)?(?:;\d*)?$/;
const POSSIBLE_MOUSE_PREFIX = /^(?:\u001b)?\[</;

export interface DecodedTerminalInput {
  readonly text: string;
  readonly wheel: 'up' | 'down' | undefined;
}

export function decodeTerminalInput(input: string): DecodedTerminalInput {
  return decodeMouseEvents(input).decoded;
}

export class TerminalInputDecoder {
  private pendingMouse = '';

  decode(input: string): DecodedTerminalInput {
    const candidate = this.pendingMouse + input;
    this.pendingMouse = '';
    const result = decodeMouseEvents(candidate);
    if (result.incomplete) this.pendingMouse = result.remaining;
    return result.decoded;
  }

  reset(): void {
    this.pendingMouse = '';
  }
}

function decodeMouseEvents(input: string): {
  readonly decoded: DecodedTerminalInput;
  readonly incomplete: boolean;
  readonly remaining: string;
} {
  let remaining = input;
  let wheel: 'up' | 'down' | undefined;
  let match: RegExpExecArray | null;
  while ((match = SGR_MOUSE_EVENT.exec(remaining)) !== null) {
    const button = Number(match[1]);
    const baseButton = button % 4;
    if ((button & 64) !== 0 && baseButton <= 1) wheel = baseButton === 0 ? 'up' : 'down';
    remaining = remaining.slice(match[0].length);
  }

  if (INCOMPLETE_SGR_MOUSE.test(remaining)) {
    return { decoded: { text: '', wheel }, incomplete: true, remaining };
  }
  if (POSSIBLE_MOUSE_PREFIX.test(remaining)) {
    return { decoded: { text: '', wheel }, incomplete: false, remaining: '' };
  }
  return { decoded: { text: remaining, wheel }, incomplete: false, remaining: '' };
}
