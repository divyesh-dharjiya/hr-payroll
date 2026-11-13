// ---------------------------------------------------------------------------------------------------------------
// Where the database is saved. The browser build uses IndexedDB (no size limit worth worrying about for a company
// of this size, unlike localStorage's ~5 MB). Tests use the in-memory store.
//
// Each saved state carries a random revision id, also written to localStorage. Before handling a request the API
// compares it with the revision it loaded, so a change made in another tab is picked up instead of overwritten.
// ---------------------------------------------------------------------------------------------------------------

export interface StoredMeta {
  /** Bump SCHEMA_VERSION when the row shapes change; older saved data is then replaced by a fresh demo seed. */
  schemaVersion: number;
  revision: string;
  seededAt: string;
}

export interface DataStore {
  read(): Promise<{ meta: StoredMeta; tables: Record<string, unknown[]> } | null>;
  /** Saves the given tables (only the ones that changed) and the new meta record. */
  write(tables: Record<string, unknown[]>, meta: StoredMeta): Promise<void>;
  clear(): Promise<void>;
  /** The revision most recently saved by any tab, or null when unknown. */
  latestRevision(): string | null;
}

const DB_NAME = 'peoplehub';
const STORE = 'tables';
const META_KEY = '__meta__';
const REVISION_KEY = 'peoplehub.db.revision';

export class IndexedDbStore implements DataStore {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }

  async read() {
    const db = await this.open();
    return new Promise<{ meta: StoredMeta; tables: Record<string, unknown[]> } | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const keysReq = store.getAllKeys();
      const valuesReq = store.getAll();
      tx.oncomplete = () => {
        const keys = keysReq.result as string[];
        const values = valuesReq.result as unknown[];
        const metaIndex = keys.indexOf(META_KEY);
        if (metaIndex < 0) return resolve(null);
        const tables: Record<string, unknown[]> = {};
        keys.forEach((k, i) => {
          if (k !== META_KEY) tables[k] = values[i] as unknown[];
        });
        resolve({ meta: values[metaIndex] as StoredMeta, tables });
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  async write(tables: Record<string, unknown[]>, meta: StoredMeta) {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const [name, rows] of Object.entries(tables)) store.put(rows, name);
      store.put(meta, META_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error ?? new Error('Saving was aborted (storage may be full).'));
    });
    try {
      localStorage.setItem(REVISION_KEY, meta.revision);
    } catch {
      // Storage can be blocked (private mode); other tabs then simply do not sync.
    }
  }

  async clear() {
    const db = await this.open();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  latestRevision(): string | null {
    try {
      return localStorage.getItem(REVISION_KEY);
    } catch {
      return null;
    }
  }
}

/** Keeps everything in memory: used by the unit tests, and as a fallback when IndexedDB is unavailable. */
export class MemoryStore implements DataStore {
  private saved: { meta: StoredMeta; tables: Record<string, unknown[]> } | null = null;

  async read() {
    return this.saved ? { meta: this.saved.meta, tables: { ...this.saved.tables } } : null;
  }

  async write(tables: Record<string, unknown[]>, meta: StoredMeta) {
    this.saved = { meta, tables: { ...(this.saved?.tables ?? {}), ...tables } };
  }

  async clear() {
    this.saved = null;
  }

  latestRevision(): string | null {
    return this.saved?.meta.revision ?? null;
  }
}
