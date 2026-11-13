import { db } from './db';
import { seedDemoData } from './db/seed';
import { IndexedDbStore, MemoryStore, type DataStore, type StoredMeta } from './db/storage';
import { newId } from './lib/crypto';
import { AppError, errorBody, toErrorResponse } from './lib/errors';
import { Reply, Router, type ApiRequest } from './http/router';
import { authenticate } from './security/session';
import { completeDueExits } from './modules/employees/employees.service';
import { authRouter, publicAuthRouter } from './modules/auth/auth.routes';
import { employeesRouter } from './modules/employees/employees.routes';
import { attendanceRouter } from './modules/attendance/attendance.routes';
import { leaveRouter } from './modules/leave/leave.routes';
import { payrollRouter } from './modules/payroll/payroll.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { orgRouter } from './modules/org/org.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';

// ---------------------------------------------------------------------------------------------------------------
// PeopleHub's API, running inside the browser. The screens call `/api/...` through Angular's HttpClient as they
// would call a server; an interceptor (core/local-api.interceptor.ts) hands those calls to `LocalApi.handle`.
//
//  - Data lives in IndexedDB and is seeded with a fictional demo company on first use.
//  - Requests run one at a time, each as a transaction: a request that fails changes nothing.
//  - Every role and record-scope rule is checked here, exactly as the separate server used to.
//
// To move to a real backend later, remove the interceptor and serve the same endpoints from a server: the screens
// do not change.
// ---------------------------------------------------------------------------------------------------------------

/** Bump when the stored row shapes change; older saved data is then replaced by a fresh demo seed. */
export const SCHEMA_VERSION = 1;

const publicApi = new Router();
publicApi.use(publicAuthRouter);

const api = new Router();
for (const r of [authRouter, employeesRouter, attendanceRouter, leaveRouter, payrollRouter, dashboardRouter, orgRouter, reportsRouter, notificationsRouter]) {
  api.use(r);
}

export interface ApiCall {
  method: string;
  /** e.g. `/api/employees?page=2` */
  url: string;
  body?: unknown;
  /** Session token for this call. Leave out to use the browser's stored session (tests pass their own). */
  session?: string | null;
}

export interface ApiResult {
  status: number;
  /** JSON-compatible data, a string (CSV) or a Blob (PDF). */
  body: unknown;
  /** Set when the call signed in (a token) or out (null). */
  session?: string | null;
}

/** Where the browser keeps the signed-in session. */
export interface SessionStore {
  get(): string | null;
  set(token: string | null): void;
}

const SESSION_KEY = 'peoplehub.session';

const browserSessions: SessionStore = {
  get: () => {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  },
  set: (token) => {
    try {
      if (token) localStorage.setItem(SESSION_KEY, token);
      else localStorage.removeItem(SESSION_KEY);
    } catch {
      // Storage blocked: the session lasts until the tab closes.
    }
  },
};

export class MemorySessions implements SessionStore {
  private token: string | null = null;
  get() {
    return this.token;
  }
  set(token: string | null) {
    this.token = token;
  }
}

const EXIT_JOB_INTERVAL_MS = 60 * 60 * 1000;

export class LocalApi {
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private meta: StoredMeta | null = null;
  private lastExitJob = 0;

  constructor(
    private store: DataStore,
    private readonly sessions: SessionStore = new MemorySessions(),
  ) {}

  /** Handles one API call. Calls are queued, so each one sees the result of the previous one. */
  handle(call: ApiCall): Promise<ApiResult> {
    const result = this.queue.then(() => this.dispatch(call));
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async dispatch(call: ApiCall): Promise<ApiResult> {
    await (this.ready ??= this.load());
    await this.syncFromOtherTabs();
    await this.runScheduledJobs();

    const url = new URL(call.url, 'http://local');
    const path = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
    const method = call.method.toUpperCase();
    const session = call.session !== undefined ? call.session : this.sessions.get();
    let newSession: string | null | undefined;
    const req: ApiRequest = {
      method,
      path,
      params: {},
      query: Object.fromEntries(url.searchParams),
      // The body crosses the same JSON boundary it would over HTTP, so handlers never share objects with the UI.
      body: call.body === undefined || call.body === null ? null : JSON.parse(JSON.stringify(call.body)),
      auth: null,
      session,
      setSession: (token) => (newSession = token),
    };

    let result: ApiResult;
    try {
      const value = await db.transaction(async () => {
        const open = publicApi.match(method, path);
        if (open) return publicApi.run(open, req);
        req.auth = authenticate(session);
        const route = api.match(method, path);
        if (!route) throw AppError.notFound('Endpoint not found.');
        return api.run(route, req);
      });
      result = value instanceof Reply ? { status: value.status, body: toWire(value.body) } : { status: 200, body: toWire(value) };
    } catch (err) {
      newSession = undefined;
      result = toErrorResponse(err);
    }

    try {
      await this.save();
    } catch (err) {
      console.error('[local-api] could not save', err);
      result = { status: 500, body: errorBody('INTERNAL_ERROR', "Your change could not be saved in this browser's storage. Free up space or try another browser.") };
    }

    if (newSession !== undefined) {
      result.session = newSession;
      if (call.session === undefined) this.sessions.set(newSession);
    }
    return result;
  }

  /** Loads the saved database, or seeds the demo company on first use (and after a schema change). */
  private async load() {
    let saved: Awaited<ReturnType<DataStore['read']>> = null;
    try {
      saved = await this.store.read();
    } catch (err) {
      // IndexedDB can be unavailable (some private windows): keep the data in memory for this tab instead.
      console.warn('[local-api] browser storage is unavailable; changes will last until the tab closes', err);
      this.store = new MemoryStore();
    }
    if (saved && saved.meta.schemaVersion === SCHEMA_VERSION) {
      db.restore(saved.tables);
      this.meta = saved.meta;
      return;
    }
    await db.transaction(() => {
      db.clear();
      seedDemoData();
    });
    this.meta = { schemaVersion: SCHEMA_VERSION, revision: '', seededAt: new Date().toISOString() };
    await this.save();
  }

  /** Another tab saved newer data: reload it before handling this call, so its changes are not overwritten. */
  private async syncFromOtherTabs() {
    const latest = this.store.latestRevision();
    if (!latest || latest === this.meta?.revision) return;
    const saved = await this.store.read();
    if (saved && saved.meta.schemaVersion === SCHEMA_VERSION) {
      db.restore(saved.tables);
      this.meta = saved.meta;
    }
  }

  /** Employees on notice become EXITED once their last day has passed (checked at start, then hourly). */
  private async runScheduledJobs() {
    if (Date.now() - this.lastExitJob < EXIT_JOB_INTERVAL_MS) return;
    this.lastExitJob = Date.now();
    await db.transaction(() => completeDueExits());
  }

  private async save() {
    const changed = db.takeDirty();
    if (!changed.length || !this.meta) return;
    const meta: StoredMeta = { ...this.meta, revision: newId() };
    await this.store.write(db.dump(changed), meta);
    this.meta = meta;
  }
}

/** Response bodies cross a JSON boundary too; strings (CSV) and Blobs (PDF) pass through as files. */
function toWire(body: unknown): unknown {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string' || body instanceof Blob) return body;
  return JSON.parse(JSON.stringify(body));
}

/** The API used by the app: IndexedDB storage and the session kept in localStorage. */
export function createBrowserApi(): LocalApi {
  const store = typeof indexedDB === 'undefined' ? new MemoryStore() : new IndexedDbStore();
  return new LocalApi(store, browserSessions);
}
