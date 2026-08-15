export interface PersistedMemory {
  readonly content: string;
  readonly purpose: string;
  readonly scope: 'project' | 'user';
  readonly persistedAt: number;
}

export interface MemoryStore {
  persist(memory: PersistedMemory): Promise<void>;
  list(scope?: 'project' | 'user'): Promise<readonly PersistedMemory[]>;
}

export class InMemoryAuthorizedMemoryStore implements MemoryStore {
  private readonly values: PersistedMemory[] = [];

  async persist(memory: PersistedMemory): Promise<void> {
    this.values.push(Object.freeze(structuredClone(memory)));
  }

  async list(scope?: 'project' | 'user'): Promise<readonly PersistedMemory[]> {
    return structuredClone(scope === undefined ? this.values : this.values.filter((item) => item.scope === scope));
  }
}
