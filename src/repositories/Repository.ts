import { PersistenceException } from "../exceptions/errors";

/**
 * REPOSITORY PATTERN: business logic depends on this interface only.
 * InMemoryRepository is used for tests/demo; a SupabaseRepository implementing
 * the same interface plugs in for production without touching any service.
 */
export interface Repository<T extends { id: string }> {
  findById(id: string): T | undefined;
  findAll(): T[];
  save(entity: T): T;
  delete(id: string): boolean;
  count(): number;
}

export class InMemoryRepository<T extends { id: string }> implements Repository<T> {
  protected readonly store = new Map<string, T>();
  private failNext = false;

  findById(id: string): T | undefined {
    this.guard();
    return this.store.get(id);
  }

  findAll(): T[] {
    this.guard();
    return [...this.store.values()];
  }

  save(entity: T): T {
    this.guard();
    this.store.set(entity.id, entity);
    return entity;
  }

  delete(id: string): boolean {
    this.guard();
    return this.store.delete(id);
  }

  count(): number {
    return this.store.size;
  }

  /** Test hook to simulate a database outage. */
  simulateFailureOnNextCall(): void {
    this.failNext = true;
  }

  private guard(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new PersistenceException("Database unavailable");
    }
  }
}

/** Simple sequential ID generator: INC1001, INC1002... */
export class IdGenerator {
  private next: number;
  constructor(private readonly prefix: string, start = 1001) { this.next = start; }
  generate(): string { return `${this.prefix}${this.next++}`; }

  /** After loading from the database, continue numbering past the highest existing ID. */
  resumeAfter(existingIds: string[]): void {
    for (const id of existingIds) {
      if (!id.startsWith(this.prefix)) continue;
      const n = Number(id.slice(this.prefix.length));
      if (Number.isFinite(n) && n >= this.next) this.next = n + 1;
    }
  }
}
