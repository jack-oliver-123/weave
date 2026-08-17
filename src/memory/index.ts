import type { ContextSnapshot, MemoryWriteRequest } from '../shared/types.js';

export interface MemoryLayer {
  getSnapshot(): Promise<ContextSnapshot>;
  write(request: MemoryWriteRequest): Promise<void>;
}

export class MemoryLayerStub implements MemoryLayer {
  getSnapshot(): Promise<ContextSnapshot> {
    throw new Error('not implemented');
  }

  write(_request: MemoryWriteRequest): Promise<void> {
    throw new Error('not implemented');
  }
}

export { InMemoryConversationStore } from './conversation-store.js';
export {
  InMemoryAuthorizedMemoryStore,
  type MemoryStore,
  type PersistedMemory,
} from './authorized-memory-store.js';
