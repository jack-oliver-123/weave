export interface CtrlCState {
  readonly exitDeadline?: number;
}

export type CtrlCAction = 'cancel' | 'clear' | 'exit';

export function initialCtrlCState(): CtrlCState {
  return {};
}

export function handleCtrlC(
  state: CtrlCState,
  now: number,
  hasActiveTurn: boolean,
): { readonly state: CtrlCState; readonly action: CtrlCAction } {
  if (state.exitDeadline !== undefined && now <= state.exitDeadline) {
    return { state: {}, action: 'exit' };
  }
  return {
    state: { exitDeadline: now + 2_000 },
    action: hasActiveTurn ? 'cancel' : 'clear',
  };
}
