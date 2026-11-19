/**
 * REPOSITORY PATTERN: business logic depends on this interface only.
 * InMemoryRepository backs the unit tests and the console demo; SqliteRepository
 * (persistence/SqliteStore.ts) implements the same interface for the real application.
 */
export interface Repository<T extends { id: string }> {
  findById(id: string): T | undefined;
  findAll(): T[];
  save(entity: T): T;
  delete(id: string): boolean;
  count(): number;
}

export class InMemoryRepository<T extends { id: string }> implements Repository<T> {
  private readonly store = new Map<string, T>();

  findById(id: string): T | undefined { return this.store.get(id); }
  findAll(): T[] { return [...this.store.values()]; }
  save(entity: T): T { this.store.set(entity.id, entity); return entity; }
  delete(id: string): boolean { return this.store.delete(id); }
  count(): number { return this.store.size; }
}

/** Simple sequential ID generator: INC1001, INC1002... */
export class IdGenerator {
  private next: number;
  constructor(private readonly prefix: string, start = 1001) { this.next = start; }
  generate(): string { return `${this.prefix}${this.next++}`; }
  /** The ID the next generate() will return, without using it up. */
  peek(): string { return `${this.prefix}${this.next}`; }

  /** After loading from the database, continue numbering past the highest existing ID. */
  resumeAfter(existingIds: string[]): void {
    for (const id of existingIds) {
      if (!id.startsWith(this.prefix)) continue;
      const n = Number(id.slice(this.prefix.length));
      if (Number.isFinite(n) && n >= this.next) this.next = n + 1;
    }
  }
}
