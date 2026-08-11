import type { ResolvedProfile } from '../../config/index.js';
import type { LlmClient } from '../../shared/types.js';
import { AnthropicMessagesClient } from './anthropic.js';
import { OpenAIChatCompletionsClient } from './openai-chat.js';
import { OpenAIResponsesClient } from './openai-responses.js';

export function createLlmClient(profile: ResolvedProfile): LlmClient {
  switch (profile.protocol) {
    case 'anthropic-messages':
      return new AnthropicMessagesClient(profile);
    case 'openai-chat-completions':
      return new OpenAIChatCompletionsClient(profile);
    case 'openai-responses':
      return new OpenAIResponsesClient(profile);
  }
}
