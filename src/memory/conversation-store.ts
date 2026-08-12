import type { ChatMessage, ConversationStore } from '../shared/types.js';

export class InMemoryConversationStore implements ConversationStore {
  private readonly messages: ChatMessage[] = [];

  getMessages(): readonly ChatMessage[] {
    return structuredClone(this.messages);
  }

  appendMessages(messages: readonly ChatMessage[]): void {
    for (const message of messages) validateMessage(message);
    this.messages.push(...structuredClone(messages));
  }

  commitTurn(user: ChatMessage, assistant: ChatMessage): void {
    if (user.role !== 'user' || assistant.role !== 'assistant') {
      throw new TypeError('conversation turn roles are invalid');
    }
    this.appendMessages([user, assistant]);
  }
}

function validateMessage(message: ChatMessage): void {
  if (!['user', 'assistant', 'tool'].includes(message.role)) throw new TypeError('conversation message role is invalid');
  if (message.role === 'tool' && typeof message.content === 'string') throw new TypeError('tool message requires content blocks');
}
