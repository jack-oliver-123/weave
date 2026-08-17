import type { ResolvedProfile } from '../../config/index.js';
import type { LlmClient } from '../../shared/types.js';
import type { ProviderCredentialBroker } from '../../security/index.js';
import { AnthropicMessagesClient } from './anthropic.js';
import { OpenAIChatCompletionsClient } from './openai-chat.js';
import { OpenAIResponsesClient } from './openai-responses.js';

export function createLlmClient(profile: ResolvedProfile, credentialBroker?: ProviderCredentialBroker): LlmClient {
  switch (profile.protocol) {
    case 'anthropic-messages':
      return new AnthropicMessagesClient(profile, { credentialBroker });
    case 'openai-chat-completions':
      return new OpenAIChatCompletionsClient(profile, { credentialBroker });
    case 'openai-responses':
      return new OpenAIResponsesClient(profile, { credentialBroker });
  }
}
