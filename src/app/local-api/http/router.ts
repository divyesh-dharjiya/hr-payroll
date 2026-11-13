import { AppError } from '../lib/errors';
import { hasPermission, type Permission } from '../security/permissions';
import type { AuthContext } from '../security/session';

// ---------------------------------------------------------------------------------------------------------------
// A small Express-style router. Routes are matched by method and path (`/employees/:id`); guards run before the
// handler, and the handler returns the response body (200) or a `Reply` for another status or a file.
// ---------------------------------------------------------------------------------------------------------------

export interface ApiRequest {
  method: string;
  /** Path without the `/api` prefix, e.g. `/employees/abc`. */
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  /** The signed-in user on protected routes; null on public routes. */
  auth: AuthContext | null;
  /** The session token sent with the request. */
  session: string | null;
  /** Signs the browser in (a token) or out (null). Used by the auth routes. */
  setSession(token: string | null): void;
}

export class Reply {
  constructor(
    readonly status: number,
    readonly body: unknown = null,
  ) {}
}

export const created = (body: unknown) => new Reply(201, body);
export const accepted = (body: unknown) => new Reply(202, body);
export const noContent = () => new Reply(204, null);

export type Guard = (req: ApiRequest) => void;
export type Handler = (req: ApiRequest) => unknown;

interface Route {
  method: string;
  segments: string[];
  guards: Guard[];
  handler: Handler;
}

export class Router {
  private readonly routes: Route[] = [];

  constructor(private readonly prefix = '') {}

  get(path: string, ...stack: [...Guard[], Handler]) {
    this.add('GET', path, stack);
  }
  post(path: string, ...stack: [...Guard[], Handler]) {
    this.add('POST', path, stack);
  }
  put(path: string, ...stack: [...Guard[], Handler]) {
    this.add('PUT', path, stack);
  }
  patch(path: string, ...stack: [...Guard[], Handler]) {
    this.add('PATCH', path, stack);
  }
  delete(path: string, ...stack: [...Guard[], Handler]) {
    this.add('DELETE', path, stack);
  }

  /** Adds every route of another router (a feature module) to this one. */
  use(other: Router) {
    this.routes.push(...other.routes);
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    const parts = splitPath(path);
    for (const route of this.routes) {
      if (route.method !== method || route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = route.segments.every((seg, i) => {
        if (seg.startsWith(':')) {
          params[seg.slice(1)] = decodeURIComponent(parts[i]);
          return true;
        }
        return seg === parts[i];
      });
      if (ok) return { route, params };
    }
    return null;
  }

  async run(match: { route: Route; params: Record<string, string> }, req: ApiRequest): Promise<unknown> {
    req.params = match.params;
    for (const guard of match.route.guards) guard(req);
    return match.route.handler(req);
  }

  private add(method: string, path: string, stack: (Guard | Handler)[]) {
    const handler = stack[stack.length - 1] as Handler;
    const guards = stack.slice(0, -1) as Guard[];
    this.routes.push({ method, segments: splitPath(`${this.prefix}${path}`), guards, handler });
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/** The signed-in user. Protected routes always have one; this narrows the type. */
export function requireAuth(req: ApiRequest): AuthContext {
  if (!req.auth) throw AppError.unauthenticated();
  return req.auth;
}

/** Guard: the caller's role must have every listed permission. */
export function requirePermission(...permissions: Permission[]): Guard {
  return (req) => {
    const auth = requireAuth(req);
    if (!permissions.every((p) => hasPermission(auth.role, p))) throw AppError.forbidden();
  };
}
