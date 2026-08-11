import type { ChatMessage, ConversationStore } from '../shared/types.js';

export class InMemoryConversationStore implements ConversationStore {
  private readonly messages: ChatMessage[] = [];

  getMessages(): readonly ChatMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  commitTurn(user: ChatMessage, assistant: ChatMessage): void {
    if (user.role !== 'user' || assistant.role !== 'assistant') {
      throw new TypeError('conversation turn roles are invalid');
    }
    this.messages.push({ ...user }, { ...assistant });
  }
}
