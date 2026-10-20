import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Title } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Api, ApiError } from '../../core/api';
import { Auth } from '../../core/auth';
import { Notify } from '../../core/notify';
import { Theme } from '../../core/theme';
import type { Role } from '../../core/models';
import { Avatar } from '../../shared/avatar';
import { ProductMockup } from '../../shared/product-mockup';

interface DemoAccount {
  email: string;
  name: string;
  role: Role;
  title: string;
}

const ROLE_META: Record<Role, { label: string; icon: string; blurb: string }> = {
  SUPER_ADMIN: { label: 'Super Admin', icon: 'shield_person', blurb: 'Everything, including company settings' },
  HR_ADMIN: { label: 'HR Admin', icon: 'badge', blurb: 'People, payroll, reports and policies' },
  MANAGER: { label: 'Manager', icon: 'supervisor_account', blurb: 'Team attendance and leave approvals' },
  EMPLOYEE: { label: 'Employee', icon: 'person', blurb: 'Check in, leave and own payslips' },
};

/** Shared chrome for the signed-out pages: brand panel on the left, form on the right. */
const AUTH_CHROME = `
  :host { display: block; min-height: 100vh; background: var(--ph-bg); }
  .auth-wrap { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); }
  .auth-hero { position: relative; overflow: hidden; background: linear-gradient(155deg, #312e81 0%, #4338ca 40%, #4f46e5 70%, #0284c7 100%); color: #fff; padding: 40px 48px; display: flex; flex-direction: column; justify-content: space-between; gap: 24px; }
  .auth-hero::before { content: ''; position: absolute; width: 520px; height: 520px; right: -160px; top: -160px; border-radius: 50%; background: radial-gradient(closest-side, rgba(255,255,255,0.18), transparent); }
  .auth-hero::after { content: ''; position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,0.12) 1px, transparent 1px); background-size: 22px 22px; mask-image: linear-gradient(180deg, transparent, #000 40%, transparent); pointer-events: none; }
  .hero-top { display: flex; align-items: center; justify-content: space-between; position: relative; z-index: 1; }
  .brand { display: flex; align-items: center; gap: 10px; font-weight: 750; font-size: 18px; color: #fff; text-decoration: none; }
  .logo { width: 36px; height: 36px; border-radius: 10px; background: rgba(255,255,255,0.16); display: grid; place-items: center; border: 1px solid rgba(255,255,255,0.25); }
  .hero-copy { position: relative; z-index: 1; max-width: 520px; }
  .hero-copy h1 { font-size: clamp(28px, 3vw, 38px); line-height: 1.12; letter-spacing: -0.03em; margin: 0 0 12px; }
  .hero-copy p { margin: 0; opacity: 0.88; font-size: 15.5px; }
  .hero-visual { position: relative; z-index: 1; --ph-surface: #ffffff; --ph-surface-muted: #f8f9fc; --ph-surface-raised: #ffffff; --ph-border: #e4e7ec; --ph-border-strong: #d0d5dd; --ph-text: #101828; --ph-text-muted: #475467; --ph-text-subtle: #667085; color: var(--ph-text); }
  .hero-foot { position: relative; z-index: 1; font-size: 12px; opacity: 0.75; }
  .auth-panel { display: flex; align-items: center; justify-content: center; padding: 40px 24px; position: relative; }
  .theme-btn { position: absolute; top: 16px; right: 16px; }
  .auth-card { width: 100%; max-width: 460px; animation: ph-fade-up 520ms var(--ph-ease) both; }
  .auth-card h2 { margin: 0 0 6px; font-size: 28px; letter-spacing: -0.03em; }
  .sub { color: var(--ph-text-muted); margin: 0 0 24px; }
  .stack { display: flex; flex-direction: column; gap: 4px; }
  .link { color: var(--ph-primary); font-weight: 600; text-decoration: none; }
  .link:hover { text-decoration: underline; }
  .submit { width: 100%; height: 48px !important; border-radius: 12px !important; font-size: 15px !important; }
  @media (max-width: 960px) { .auth-wrap { grid-template-columns: 1fr; } .auth-hero { display: none; } }
`;

@Component({
  selector: 'ph-login',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatProgressSpinnerModule, Avatar, ProductMockup],
  template: `
    <div class="auth-wrap">
      <section class="auth-hero" aria-label="About PeopleHub">
        <div class="hero-top">
          <a class="brand" routerLink="/">
            <span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32" width="20" height="20"><path d="M8 24V8h9a6 6 0 0 1 0 12h-5" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="23.5" cy="23.5" r="2.5" fill="#a5f3fc"/></svg></span>
            PeopleHub
          </a>
        </div>
        <div class="hero-copy">
          <h1>Welcome to the workspace your whole team shares.</h1>
          <p>Attendance, leave and payroll stay in sync, approvals reach the right person, and every sensitive change leaves a trail.</p>
        </div>
        <ph-product-mockup class="hero-visual" [compact]="true" />
        <p class="hero-foot">Demo company with fictional people and figures. No real personal or financial data.</p>
      </section>

      <main class="auth-panel" id="main">
        <button mat-icon-button type="button" class="theme-btn" (click)="theme.toggle()" [attr.aria-label]="theme.isDark() ? 'Switch to light theme' : 'Switch to dark theme'">
          <mat-icon>{{ theme.isDark() ? 'light_mode' : 'dark_mode' }}</mat-icon>
        </button>
        <div class="auth-card">
          <h2>Sign in</h2>
          <p class="sub">{{ demo().length ? 'Choose a demo role to sign in instantly, or use your email.' : 'Use your work email to continue.' }}</p>

          @if (demo().length) {
            <section class="roles" aria-label="Demo roles">
              @for (a of demo(); track a.email) {
                <button
                  type="button"
                  class="role"
                  [class.active]="selected() === a.email"
                  [disabled]="busy()"
                  (click)="signInAs(a)"
                  [attr.aria-label]="'Sign in as ' + meta(a.role).label + ', ' + a.name"
                >
                  <ph-avatar [name]="a.name" [size]="40" />
                  <span class="role-text">
                    <span class="role-name"><mat-icon aria-hidden="true">{{ meta(a.role).icon }}</mat-icon>{{ meta(a.role).label }}</span>
                    <span class="role-person">{{ a.name }}</span>
                    <span class="role-blurb">{{ meta(a.role).blurb }}</span>
                  </span>
                  @if (selected() === a.email && busy()) {
                    <mat-spinner diameter="20" aria-label="Signing in"></mat-spinner>
                  } @else {
                    <mat-icon class="go" aria-hidden="true">arrow_forward</mat-icon>
                  }
                </button>
              }
            </section>
            <div class="divider" role="separator"><span>or sign in with email</span></div>
          }

          <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
            <div class="stack">
              <mat-form-field appearance="outline">
                <mat-label>Work email</mat-label>
                <mat-icon matPrefix aria-hidden="true">mail</mat-icon>
                <input matInput type="email" formControlName="email" autocomplete="username" required />
                @if (form.controls.email.touched && form.controls.email.hasError('email')) { <mat-error>Enter a valid email address.</mat-error> }
                @if (form.controls.email.touched && form.controls.email.hasError('required')) { <mat-error>Enter your work email.</mat-error> }
              </mat-form-field>
              <mat-form-field appearance="outline">
                <mat-label>Password</mat-label>
                <mat-icon matPrefix aria-hidden="true">lock</mat-icon>
                <input matInput [type]="showPassword() ? 'text' : 'password'" formControlName="password" autocomplete="current-password" required />
                <button mat-icon-button matSuffix type="button" (click)="showPassword.set(!showPassword())" [attr.aria-label]="showPassword() ? 'Hide password' : 'Show password'">
                  <mat-icon>{{ showPassword() ? 'visibility_off' : 'visibility' }}</mat-icon>
                </button>
                @if (form.controls.password.touched && form.controls.password.hasError('required')) { <mat-error>Enter your password.</mat-error> }
              </mat-form-field>
            </div>

            @if (error()) {
              <p role="alert" class="alert"><mat-icon aria-hidden="true">error</mat-icon>{{ error() }}</p>
            }

            <button mat-flat-button color="primary" type="submit" class="submit" [disabled]="busy()">
              {{ busy() ? 'Signing in…' : 'Sign in' }}
            </button>
          </form>

          <p class="links">
            <a class="link" routerLink="/forgot-password">Forgot password?</a>
            <a class="link" routerLink="/">About PeopleHub</a>
          </p>
          @if (demo().length) {
            <p class="demo-note"><mat-icon aria-hidden="true">info</mat-icon> Demo mode is on. One-click sign-in exists only for the fictional demo company and is disabled in production.</p>
          }
        </div>
      </main>
    </div>
  `,
  styles: [
    AUTH_CHROME,
    `
      .roles { display: grid; gap: 10px; margin-bottom: 18px; }
      .role { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 40px 1fr 24px; gap: 14px; align-items: center; padding: 12px 14px; border-radius: 14px; border: 1px solid var(--ph-border); background: var(--ph-surface); box-shadow: var(--ph-shadow-sm); transition: transform var(--ph-dur) var(--ph-ease), box-shadow var(--ph-dur) var(--ph-ease), border-color var(--ph-dur) var(--ph-ease); }
      .role:hover:not(:disabled) { transform: translateY(-2px); box-shadow: var(--ph-shadow-md); border-color: var(--ph-primary); }
      .role:focus-visible { outline: 2px solid var(--ph-primary); outline-offset: 2px; }
      .role.active { border-color: var(--ph-primary); background: var(--ph-primary-soft); }
      .role:disabled { cursor: progress; opacity: 0.75; }
      .role-text { display: flex; flex-direction: column; min-width: 0; }
      .role-name { display: flex; align-items: center; gap: 6px; font-weight: 700; font-size: 14px; }
      .role-name mat-icon { font-size: 17px; width: 17px; height: 17px; color: var(--ph-primary); }
      .role-person { font-size: 12.5px; color: var(--ph-text); }
      .role-blurb { font-size: 12px; color: var(--ph-text-subtle); }
      .go { color: var(--ph-text-subtle); transition: transform var(--ph-dur) var(--ph-ease), color var(--ph-dur); }
      .role:hover .go { transform: translateX(3px); color: var(--ph-primary); }
      .divider { display: flex; align-items: center; gap: 12px; color: var(--ph-text-subtle); font-size: 12px; margin: 6px 0 18px; }
      .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--ph-border); }
      .alert { display: flex; gap: 8px; align-items: center; color: var(--ph-danger); background: var(--ph-danger-soft); padding: 10px 12px; border-radius: 10px; margin: 0 0 14px; font-size: 13px; }
      .alert mat-icon { font-size: 18px; width: 18px; height: 18px; }
      .links { display: flex; justify-content: space-between; margin: 16px 0 0; }
      .demo-note { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--ph-text-subtle); margin: 22px 0 0; }
      .demo-note mat-icon { font-size: 16px; width: 16px; height: 16px; flex: none; margin-top: 1px; }
    `,
  ],
})
export class LoginPage implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly titleSvc = inject(Title);
  readonly theme = inject(Theme);

  readonly demo = signal<DemoAccount[]>([]);
  private demoPassword = '';
  readonly selected = signal<string | null>(null);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly showPassword = signal(false);

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  ngOnInit() {
    this.titleSvc.setTitle('Sign in | PeopleHub');
    void this.loadDemo();
  }

  meta(role: Role) {
    return ROLE_META[role];
  }

  /** Demo accounts are offered only when the server runs in demo mode; otherwise the endpoint returns 404. */
  private async loadDemo() {
    try {
      const res = await this.api.get<{ password: string; accounts: DemoAccount[] }>('/auth/demo-accounts');
      this.demoPassword = res.password;
      this.demo.set(res.accounts);
    } catch {
      this.demo.set([]);
    }
  }

  /** Fills the form visibly (so the user sees what is used) and signs in. */
  async signInAs(account: DemoAccount) {
    if (this.busy()) return;
    this.selected.set(account.email);
    this.busy.set(true);
    this.error.set(null);
    this.form.reset({ email: '', password: '' });
    await this.typeInto('email', account.email);
    await this.typeInto('password', this.demoPassword);
    this.busy.set(false);
    await this.submit();
  }

  private async typeInto(control: 'email' | 'password', value: string) {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      this.form.controls[control].setValue(value);
      return;
    }
    const delay = Math.max(8, Math.min(28, 520 / value.length));
    for (let i = 1; i <= value.length; i++) {
      this.form.controls[control].setValue(value.slice(0, i));
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  async submit() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.auth.login(this.form.getRawValue().email, this.form.getRawValue().password);
      const returnUrl = this.route.snapshot.queryParamMap.get('returnUrl');
      await this.router.navigateByUrl(returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : '/dashboard');
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.');
      this.form.controls.password.reset('');
      this.selected.set(null);
    } finally {
      this.busy.set(false);
    }
  }
}

@Component({
  selector: 'ph-forgot-password',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule],
  template: `
    <div class="auth-wrap single">
      <main class="auth-panel" id="main">
        <div class="auth-card card">
          <span class="badge-icon" aria-hidden="true"><mat-icon>key</mat-icon></span>
          <h2>Reset your password</h2>
          @if (sent()) {
            <p class="sub" role="status">If an account exists for that email, a reset link is on its way. It expires in 30 minutes.</p>
            <a mat-stroked-button routerLink="/login">Back to sign in</a>
          } @else {
            <p class="sub">Enter your work email and we'll send a reset link.</p>
            <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
              <mat-form-field appearance="outline">
                <mat-label>Work email</mat-label>
                <mat-icon matPrefix aria-hidden="true">mail</mat-icon>
                <input matInput type="email" formControlName="email" autocomplete="username" />
                @if (form.controls.email.touched && form.invalid) { <mat-error>Enter a valid email address.</mat-error> }
              </mat-form-field>
              <button mat-flat-button color="primary" type="submit" class="submit" [disabled]="busy()">Send reset link</button>
            </form>
            <p style="margin-top:16px"><a class="link" routerLink="/login">Back to sign in</a></p>
          }
        </div>
      </main>
    </div>
  `,
  styles: [AUTH_CHROME, `.single { grid-template-columns: 1fr; } .card { padding: 32px; } .badge-icon { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; background: var(--ph-primary-soft); color: var(--ph-primary); margin-bottom: 16px; }`],
})
export class ForgotPasswordPage {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  readonly busy = signal(false);
  readonly sent = signal(false);
  readonly form = this.fb.nonNullable.group({ email: ['', [Validators.required, Validators.email]] });

  async submit() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.busy.set(true);
    const ok = await this.notify.run(() => this.api.post('/auth/forgot-password', { email: this.form.getRawValue().email }));
    this.busy.set(false);
    if (ok !== undefined) this.sent.set(true);
  }
}

@Component({
  selector: 'ph-reset-password',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule],
  template: `
    <div class="auth-wrap single">
      <main class="auth-panel" id="main">
        <div class="auth-card card">
          <span class="badge-icon" aria-hidden="true"><mat-icon>lock_reset</mat-icon></span>
          <h2>Choose a new password</h2>
          @if (done()) {
            <p class="sub" role="status">Your password has been updated. You can sign in now.</p>
            <a mat-flat-button color="primary" routerLink="/login">Go to sign in</a>
          } @else {
            <p class="sub">At least 10 characters, with a letter and a number.</p>
            <form [formGroup]="form" (ngSubmit)="submit()" novalidate>
              <mat-form-field appearance="outline">
                <mat-label>New password</mat-label>
                <mat-icon matPrefix aria-hidden="true">lock</mat-icon>
                <input matInput type="password" formControlName="password" autocomplete="new-password" />
                @if (form.controls.password.touched && form.controls.password.invalid) { <mat-error>Use at least 10 characters with a letter and a number.</mat-error> }
              </mat-form-field>
              @if (error()) { <p role="alert" class="field-error">{{ error() }}</p> }
              <button mat-flat-button color="primary" type="submit" class="submit" [disabled]="busy()">Update password</button>
            </form>
          }
        </div>
      </main>
    </div>
  `,
  styles: [AUTH_CHROME, `.single { grid-template-columns: 1fr; } .card { padding: 32px; } .badge-icon { width: 48px; height: 48px; border-radius: 14px; display: grid; place-items: center; background: var(--ph-primary-soft); color: var(--ph-primary); margin-bottom: 16px; }`],
})
export class ResetPasswordPage {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly notify = inject(Notify);
  readonly busy = signal(false);
  readonly done = signal(false);
  readonly error = signal<string | null>(null);
  readonly form = this.fb.nonNullable.group({
    password: ['', [Validators.required, Validators.minLength(10), Validators.pattern(/^(?=.*[A-Za-z])(?=.*\d).+$/)]],
  });

  async submit() {
    this.form.markAllAsTouched();
    const token = this.route.snapshot.queryParamMap.get('token');
    if (this.form.invalid || !token) {
      this.error.set(token ? null : 'This reset link is missing its token. Request a new link.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.post('/auth/reset-password', { token, password: this.form.getRawValue().password });
      this.done.set(true);
      this.notify.success('Password updated.');
    } catch (err) {
      this.error.set(err instanceof ApiError ? err.message : 'Could not reset the password.');
    } finally {
      this.busy.set(false);
    }
  }
}
