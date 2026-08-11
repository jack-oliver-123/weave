export interface DisabledThinking {
  readonly type: 'disabled';
}

export interface DisabledReasoning {
  readonly effort: 'none';
}

export const DISABLED_THINKING: DisabledThinking = Object.freeze({ type: 'disabled' });

export function deepSeekThinkingExtension(baseUrl: string): { readonly thinking?: DisabledThinking } {
  return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com'
    ? { thinking: DISABLED_THINKING }
    : {};
}

export function deepSeekResponsesReasoningExtension(baseUrl: string): { readonly reasoning?: DisabledReasoning } {
  return new URL(baseUrl).hostname.toLowerCase() === 'api.deepseek.com'
    ? { reasoning: Object.freeze({ effort: 'none' }) }
    : {};
}
