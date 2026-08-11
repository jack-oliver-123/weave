export interface ComposerState {
  readonly value: string;
  readonly cursor: number;
}

export interface ComposerKey {
  readonly return?: boolean;
  readonly shift?: boolean;
  readonly leftArrow?: boolean;
  readonly rightArrow?: boolean;
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
): ComposerResult {
  if (key.return === true) {
    if (key.shift === true) return { state: insertText(state, '\n') };
    if (canSubmit && state.value.trim().length > 0) {
      return { state: { value: '', cursor: 0 }, submitted: state.value };
    }
    return { state };
  }
  if (key.leftArrow === true) return { state: { ...state, cursor: Math.max(0, state.cursor - 1) } };
  if (key.rightArrow === true) return { state: { ...state, cursor: Math.min(state.value.length, state.cursor + 1) } };
  if (key.home === true) return { state: { ...state, cursor: lineStart(state.value, state.cursor) } };
  if (key.end === true) return { state: { ...state, cursor: lineEnd(state.value, state.cursor) } };
  if (key.backspace === true && state.cursor > 0) {
    return { state: { value: state.value.slice(0, state.cursor - 1) + state.value.slice(state.cursor), cursor: state.cursor - 1 } };
  }
  if (key.delete === true && state.cursor < state.value.length) {
    return { state: { value: state.value.slice(0, state.cursor) + state.value.slice(state.cursor + 1), cursor: state.cursor } };
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

function lineStart(value: string, cursor: number): number {
  const precedingNewline = value.lastIndexOf('\n', Math.max(0, cursor - 1));
  return precedingNewline + 1;
}

function lineEnd(value: string, cursor: number): number {
  const followingNewline = value.indexOf('\n', cursor);
  return followingNewline < 0 ? value.length : followingNewline;
}
