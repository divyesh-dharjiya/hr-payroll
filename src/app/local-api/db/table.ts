import { UniqueConstraintError } from '../lib/errors';
import { newId } from '../lib/crypto';

// ---------------------------------------------------------------------------------------------------------------
// One in-memory table. Rows are frozen, so they can only change through insert / update / delete, which keep the
// unique keys, the lookup indexes, the dirty flag (for saving) and the undo log (for rolling back a failed request).
// ---------------------------------------------------------------------------------------------------------------

type Auto = 'id' | 'createdAt' | 'updatedAt';

/** An `undefined` value means "not given" (as in Prisma): it never overwrites a default or a stored value. */
function withoutUndefined<T extends object>(data: T): Partial<T> {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** What `insert` needs: every column except those with a default or filled in automatically. */
export type Insert<T, D extends keyof T> = Omit<T, D | Auto> & Partial<Pick<T, Extract<D | Auto, keyof T>>>;

export interface Journal {
  /** Records how to undo a change made during the current request. */
  record(undo: () => void): void;
  markDirty(table: string): void;
}

export interface TableOptions<T, D extends keyof T> {
  /** Column defaults, like DEFAULT in SQL. */
  defaults?: () => Pick<T, D>;
  /** Unique keys, like a UNIQUE index. Rows with a null in the key are not checked (as in SQL). */
  unique?: (keyof T & string)[][];
  /** Columns that `by()` looks up often. */
  index?: (keyof T & string)[];
  /** The rows have an `updatedAt` column, stamped on every insert and update. */
  updatedAt?: boolean;
}

export class Table<T extends { id: string; createdAt: string }, D extends keyof T = never> {
  private rows = new Map<string, T>();
  private uniques = new Map<string, Map<string, string>>();
  private indexes = new Map<string, Map<unknown, Set<string>>>();

  constructor(
    readonly name: string,
    private readonly options: TableOptions<T, D>,
    private readonly journal: Journal,
  ) {
    for (const key of options.unique ?? []) this.uniques.set(key.join('+'), new Map());
    for (const column of options.index ?? []) this.indexes.set(column, new Map());
  }

  get size(): number {
    return this.rows.size;
  }

  all(): T[] {
    return [...this.rows.values()];
  }

  get(id: string | null | undefined): T | undefined {
    return id ? this.rows.get(id) : undefined;
  }

  find(predicate: (row: T) => boolean): T | undefined {
    for (const row of this.rows.values()) if (predicate(row)) return row;
    return undefined;
  }

  filter(predicate: (row: T) => boolean): T[] {
    const out: T[] = [];
    for (const row of this.rows.values()) if (predicate(row)) out.push(row);
    return out;
  }

  count(predicate?: (row: T) => boolean): number {
    if (!predicate) return this.rows.size;
    let n = 0;
    for (const row of this.rows.values()) if (predicate(row)) n++;
    return n;
  }

  /** Rows whose `column` equals `value`, using the column's index when it has one. */
  by<K extends keyof T & string>(column: K, value: T[K]): T[] {
    const index = this.indexes.get(column);
    if (!index) return this.filter((r) => r[column] === value);
    return [...(index.get(value) ?? [])].map((id) => this.rows.get(id)!);
  }

  insert(data: Insert<T, D>): T {
    const now = new Date().toISOString();
    const row = Object.freeze({
      ...this.options.defaults?.(),
      id: newId(),
      createdAt: now,
      ...(this.options.updatedAt ? { updatedAt: now } : {}),
      ...withoutUndefined(data),
    }) as unknown as T;
    if (this.rows.has(row.id)) throw new UniqueConstraintError(this.name, ['id']);
    this.assertUnique(row);
    this.put(row);
    this.journal.record(() => this.remove(row.id));
    return row;
  }

  update(id: string, patch: Partial<T>): T {
    const before = this.rows.get(id);
    if (!before) throw new Error(`${this.name}: no row ${id}`);
    const after = Object.freeze({
      ...before,
      ...withoutUndefined(patch),
      id,
      ...(this.options.updatedAt ? { updatedAt: new Date().toISOString() } : {}),
    }) as T;
    this.assertUnique(after, id);
    this.remove(id);
    this.put(after);
    this.journal.record(() => {
      this.remove(id);
      this.put(before);
    });
    return after;
  }

  /** Updates every matching row and returns how many changed, like `UPDATE ... WHERE`. */
  updateWhere(predicate: (row: T) => boolean, patch: Partial<T> | ((row: T) => Partial<T>)): number {
    const targets = this.filter(predicate);
    for (const row of targets) this.update(row.id, typeof patch === 'function' ? patch(row) : patch);
    return targets.length;
  }

  delete(id: string): boolean {
    const before = this.rows.get(id);
    if (!before) return false;
    this.remove(id);
    this.journal.record(() => this.put(before));
    return true;
  }

  deleteWhere(predicate: (row: T) => boolean): number {
    const targets = this.filter(predicate);
    for (const row of targets) this.delete(row.id);
    return targets.length;
  }

  /** Replaces the whole table (loading from storage or seeding). Not journaled. */
  load(rows: T[]): void {
    this.rows.clear();
    for (const map of this.uniques.values()) map.clear();
    for (const map of this.indexes.values()) map.clear();
    for (const row of rows) this.put(Object.freeze({ ...row }));
  }

  private uniqueValue(row: T, key: string[]): string | null {
    const values = key.map((k) => (row as Record<string, unknown>)[k]);
    if (values.some((v) => v === null || v === undefined)) return null;
    return JSON.stringify(values);
  }

  private assertUnique(row: T, exceptId?: string): void {
    for (const key of this.options.unique ?? []) {
      const value = this.uniqueValue(row, key);
      if (value === null) continue;
      const owner = this.uniques.get(key.join('+'))!.get(value);
      if (owner && owner !== exceptId) throw new UniqueConstraintError(this.name, key);
    }
  }

  private put(row: T): void {
    this.rows.set(row.id, row);
    for (const key of this.options.unique ?? []) {
      const value = this.uniqueValue(row, key);
      if (value !== null) this.uniques.get(key.join('+'))!.set(value, row.id);
    }
    for (const [column, index] of this.indexes) {
      const value = (row as Record<string, unknown>)[column];
      let ids = index.get(value);
      if (!ids) index.set(value, (ids = new Set()));
      ids.add(row.id);
    }
    this.journal.markDirty(this.name);
  }

  private remove(id: string): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.delete(id);
    for (const key of this.options.unique ?? []) {
      const value = this.uniqueValue(row, key);
      if (value !== null) this.uniques.get(key.join('+'))!.delete(value);
    }
    for (const [column, index] of this.indexes) index.get((row as Record<string, unknown>)[column])?.delete(id);
    this.journal.markDirty(this.name);
  }
}
