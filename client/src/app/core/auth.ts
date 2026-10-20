import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Api, ApiError } from './api';
import type { Permission, SessionUser } from './models';
import { setOrgTimeZone } from '../shared/format';

/** Session state for the UI. Permissions shown here only shape navigation; the API enforces every action. */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly api = inject(Api);
  private readonly router = inject(Router);

  private readonly state = signal<SessionUser | null>(null);
  private loaded = false;
  // Guards run in parallel on the first navigation; they share one session request.
  private pending: Promise<SessionUser | null> | null = null;

  readonly user = this.state.asReadonly();
  readonly isSignedIn = computed(() => this.state() !== null);
  readonly isHr = computed(() => {
    const role = this.state()?.role;
    return role === 'HR_ADMIN' || role === 'SUPER_ADMIN';
  });

  /** Loads the session once per app start. Resolves to the user or null when signed out. */
  async load(force = false): Promise<SessionUser | null> {
    if (this.loaded && !force) return this.state();
    if (this.pending && !force) return this.pending;
    const request = this.fetchSession();
    this.pending = request;
    try {
      return await request;
    } finally {
      if (this.pending === request) this.pending = null;
    }
  }

  private async fetchSession(): Promise<SessionUser | null> {
    try {
      // `/auth/session` answers 200 with `user: null` when signed out, so visitors see no failed request.
      const { user } = await this.api.get<{ user: SessionUser | null }>('/auth/session');
      setOrgTimeZone(user?.organizationTimezone);
      this.state.set(user);
    } catch (err) {
      this.state.set(null);
      if (!(err instanceof ApiError) || err.status !== 401) throw err;
    } finally {
      this.loaded = true;
    }
    return this.state();
  }

  async login(email: string, password: string): Promise<void> {
    const { user } = await this.api.post<{ user: SessionUser }>('/auth/login', { email, password });
    setOrgTimeZone(user.organizationTimezone);
    this.state.set(user);
    this.loaded = true;
  }

  async logout(): Promise<void> {
    try {
      await this.api.post('/auth/logout');
    } finally {
      this.state.set(null);
      this.loaded = true;
      await this.router.navigateByUrl('/login');
    }
  }

  has(permission: Permission): boolean {
    return this.state()?.permissions.includes(permission) ?? false;
  }

  hasAny(...permissions: Permission[]): boolean {
    return permissions.some((p) => this.has(p));
  }
}
