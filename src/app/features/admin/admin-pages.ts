import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { Title } from '@angular/platform-browser';
import { Api, ApiError } from '../../core/api';
import { Auth } from '../../core/auth';
import { Notify, applyFieldErrors } from '../../core/notify';
import { StateView, confirmAction } from '../../shared/ui';
import { formatDate, formatInstant } from '../../shared/format';

// -- Holidays -----------------------------------------------------------------------------------------------------
interface Holiday {
  id: string;
  date: string;
  name: string;
}

@Component({
  selector: 'ph-holidays-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, StateView],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Company holidays</h1>
          <p>Holidays are excluded from leave day counts and from payroll absence.</p>
        </div>
        <div class="toolbar">
          <button mat-stroked-button type="button" (click)="shiftYear(-1)">{{ year() - 1 }}</button>
          <strong>{{ year() }}</strong>
          <button mat-stroked-button type="button" (click)="shiftYear(1)">{{ year() + 1 }}</button>
        </div>
      </header>

      <section class="card" aria-labelledby="add-h">
        <h2 id="add-h" class="card-title">Add a holiday</h2>
        <form [formGroup]="form" (ngSubmit)="add()" novalidate class="inline">
          <mat-form-field appearance="outline"><mat-label>Date</mat-label><input matInput type="date" formControlName="date" />
            @if (form.controls.date.invalid && form.controls.date.touched) { <mat-error>Choose a date.</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Name</mat-label><input matInput formControlName="name" />
            @if (form.controls.name.invalid && form.controls.name.touched) { <mat-error>Enter a name.</mat-error> }
          </mat-form-field>
          <button mat-flat-button color="primary" type="submit" [disabled]="busy()"><mat-icon>add</mat-icon> Add holiday</button>
        </form>
      </section>

      <section class="card">
        <ph-state [state]="state()" (retry)="load()" title="Holidays could not be loaded">
          <div class="table-wrap">
            <table class="data">
              <caption class="sr-only">Holidays for {{ year() }}</caption>
              <thead><tr><th scope="col">Date</th><th scope="col">Holiday</th>@if (canEdit()) {<th scope="col"><span class="sr-only">Actions</span></th>}</tr></thead>
              <tbody>
                @for (h of holidays(); track h.id) {
                  <tr>
                    <td>{{ formatDate(h.date) }}</td>
                    <td>{{ h.name }}</td>
                    @if (canEdit()) {
                      <td class="right"><button mat-button type="button" color="warn" (click)="remove(h)">Remove<span class="sr-only"> {{ h.name }}</span></button></td>
                    }
                  </tr>
                } @empty {
                  <tr><td [attr.colspan]="canEdit() ? 3 : 2" class="muted">No holidays recorded for {{ year() }}.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </ph-state>
      </section>
    </div>
  `,
  styles: [
    `
      .inline { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
      .inline mat-form-field { width: 220px; }
      .inline button { margin-top: 6px; }
      .muted { color: var(--ph-text-muted); }
      .right { text-align: right; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    `,
  ],
})
export class HolidaysPage implements OnInit {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);
  private readonly fb = inject(FormBuilder);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);
  private readonly title = inject(Title);
  readonly formatDate = formatDate;
  readonly year = signal(new Date().getFullYear());
  readonly holidays = signal<Holiday[]>([]);
  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly busy = signal(false);
  readonly canEdit = () => this.auth.has('org:manage');
  readonly form = this.fb.nonNullable.group({ date: ['', [Validators.required]], name: ['', [Validators.required, Validators.minLength(2)]] });

  ngOnInit() {
    this.title.setTitle('Holidays | PeopleHub');
    void this.load();
  }

  shiftYear(d: number) {
    this.year.set(this.year() + d);
    void this.load();
  }

  async load() {
    this.state.set('loading');
    try {
      this.holidays.set((await this.api.get<{ items: Holiday[] }>('/org/holidays', { year: this.year() })).items);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  async add() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.busy.set(true);
    const ok = await this.notify.run(() => this.api.post('/org/holidays', this.form.getRawValue()), 'Holiday added.');
    this.busy.set(false);
    if (ok !== undefined) {
      this.form.reset();
      await this.load();
    }
  }

  async remove(h: Holiday) {
    const confirmed = await confirmAction(this.dialog, { title: `Remove ${h.name}?`, message: `${formatDate(h.date)} will count as a working day again.`, confirmLabel: 'Remove', destructive: true });
    if (!confirmed) return;
    const ok = await this.notify.run(() => this.api.delete(`/org/holidays/${h.id}`), 'Holiday removed.');
    if (ok !== undefined) await this.load();
  }
}

// -- Announcements --------------------------------------------------------------------------------------------------
interface Announcement {
  id: string;
  title: string;
  body: string;
  publishAt: string;
  expiresAt: string | null;
  audienceRole: string | null;
  departmentId: string | null;
}

@Component({
  selector: 'ph-announcements-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, StateView],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Announcements</h1>
          <p>{{ canEdit() ? 'Publish company updates and target them by role or department.' : 'Updates from the company that apply to you.' }}</p>
        </div>
      </header>

      @if (canEdit()) {
        <section class="card" aria-labelledby="new-h">
          <h2 id="new-h" class="card-title">{{ editingId() ? 'Edit announcement' : 'New announcement' }}</h2>
          <form [formGroup]="form" (ngSubmit)="create()" novalidate class="grid-form">
            <mat-form-field appearance="outline" class="wide"><mat-label>Title</mat-label><input matInput formControlName="title" />
              @if (form.controls.title.invalid && form.controls.title.touched) { <mat-error>Give the announcement a title (at least 3 characters).</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline" class="wide"><mat-label>Message</mat-label><textarea matInput rows="3" formControlName="body"></textarea>
              @if (form.controls.body.invalid && form.controls.body.touched) { <mat-error>Write the message (at least 3 characters).</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Show from</mat-label><input matInput type="datetime-local" formControlName="publishAt" /><mat-hint>Leave blank to publish now</mat-hint></mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Hide after</mat-label><input matInput type="datetime-local" formControlName="expiresAt" />
              @if (form.controls.expiresAt.invalid) { <mat-error>Expiry must be after the publish time.</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Audience role</mat-label>
              <mat-select formControlName="audienceRole">
                <mat-option value="">Everyone</mat-option>
                <mat-option value="HR_ADMIN">HR admins</mat-option>
                <mat-option value="MANAGER">Managers</mat-option>
                <mat-option value="EMPLOYEE">Employees</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline"><mat-label>Department</mat-label>
              <mat-select formControlName="departmentId">
                <mat-option value="">All departments</mat-option>
                @for (d of departments(); track d.id) { <mat-option [value]="d.id">{{ d.name }}</mat-option> }
              </mat-select>
            </mat-form-field>
            <div class="submit">
              @if (editingId()) { <button mat-button type="button" (click)="cancelEdit()">Cancel</button> }
              <button mat-flat-button color="primary" type="submit" [disabled]="busy()">{{ editingId() ? 'Save changes' : 'Publish' }}</button>
            </div>
          </form>
        </section>
      }

      <section class="stack" aria-label="Announcements">
        <ph-state [state]="state()" (retry)="load()" title="Announcements could not be loaded">
          @for (a of items(); track a.id) {
            <article class="card post">
              <header>
                <h2>{{ a.title }}</h2>
                <span class="muted small">Published {{ instant(a.publishAt) }}@if (a.expiresAt) { · until {{ instant(a.expiresAt) }} }
                  @if (a.audienceRole) { · {{ audience(a.audienceRole) }} } @if (a.departmentId) { · department only }</span>
              </header>
              <p>{{ a.body }}</p>
              @if (canEdit()) {
                <div class="post-actions">
                  <button mat-button type="button" (click)="edit(a)"><mat-icon>edit</mat-icon>Edit<span class="sr-only"> {{ a.title }}</span></button>
                  <button mat-button type="button" color="warn" (click)="remove(a)"><mat-icon>delete</mat-icon>Delete<span class="sr-only"> {{ a.title }}</span></button>
                </div>
              }
            </article>
          } @empty {
            <div class="card muted">No announcements right now.</div>
          }
        </ph-state>
      </section>
    </div>
  `,
  styles: [
    `
      .grid-form { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 14px; }
      .wide { grid-column: 1 / -1; }
      .submit { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
      .post { animation: ph-fade-up 300ms var(--ph-ease) both; }
      .post-actions { display: flex; gap: 4px; }
      .stack { display: flex; flex-direction: column; gap: 12px; }
      .post h2 { margin: 0; font-size: 16px; }
      .post header { display: flex; flex-direction: column; gap: 2px; margin-bottom: 8px; }
      .post p { margin: 0 0 8px; white-space: pre-line; }
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      @media (max-width: 640px) { .grid-form { grid-template-columns: 1fr; } }
    `,
  ],
})
export class AnnouncementsPage implements OnInit {
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);
  private readonly fb = inject(FormBuilder);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);
  private readonly title = inject(Title);
  readonly items = signal<Announcement[]>([]);
  readonly departments = signal<{ id: string; name: string }[]>([]);
  readonly editingId = signal<string | null>(null);
  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly busy = signal(false);
  readonly canEdit = () => this.auth.has('org:manage');
  readonly instant = (iso: string) => formatInstant(iso);
  readonly form = this.fb.nonNullable.group({
    title: ['', [Validators.required, Validators.minLength(3)]],
    body: ['', [Validators.required, Validators.minLength(3)]],
    publishAt: [''],
    expiresAt: [''],
    audienceRole: [''],
    departmentId: [''],
  });

  ngOnInit() {
    this.title.setTitle('Announcements | PeopleHub');
    void this.load();
    if (this.canEdit()) {
      void this.api.get<{ items: { id: string; name: string }[] }>('/org/departments').then((r) => this.departments.set(r.items)).catch(() => undefined);
    }
  }

  audience(role: string) {
    return ({ HR_ADMIN: 'HR admins', MANAGER: 'Managers', EMPLOYEE: 'Employees' } as Record<string, string>)[role] ?? role;
  }

  async load() {
    this.state.set('loading');
    try {
      const query = this.canEdit() ? { all: 'true' } : undefined;
      this.items.set((await this.api.get<{ items: Announcement[] }>('/org/announcements', query)).items);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  async create() {
    this.form.markAllAsTouched();
    const v = this.form.getRawValue();
    if (v.expiresAt && v.publishAt && new Date(v.expiresAt) <= new Date(v.publishAt)) {
      this.form.controls.expiresAt.setErrors({ server: 'Expiry must be after the publish time.' });
      return;
    }
    if (this.form.invalid) return;
    this.busy.set(true);
    const body = {
      title: v.title,
      body: v.body,
      publishAt: v.publishAt ? new Date(v.publishAt).toISOString() : undefined,
      expiresAt: v.expiresAt ? new Date(v.expiresAt).toISOString() : null,
      audienceRole: v.audienceRole || null,
      departmentId: v.departmentId || null,
    };
    try {
      const id = this.editingId();
      if (id) await this.api.put(`/org/announcements/${id}`, body);
      else await this.api.post('/org/announcements', body);
      this.notify.success(id ? 'Announcement updated.' : 'Announcement published.');
      this.cancelEdit();
      await this.load();
    } catch (err) {
      if (!applyFieldErrors(this.form, err)) this.notify.error(err instanceof ApiError ? err.message : 'Could not publish.');
    } finally {
      this.busy.set(false);
    }
  }

  edit(a: Announcement) {
    // datetime-local inputs take local time without a zone.
    const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date(iso).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
    this.editingId.set(a.id);
    this.form.reset({ title: a.title, body: a.body, publishAt: local(a.publishAt), expiresAt: local(a.expiresAt), audienceRole: a.audienceRole ?? '', departmentId: a.departmentId ?? '' });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  cancelEdit() {
    this.editingId.set(null);
    this.form.reset({ title: '', body: '', publishAt: '', expiresAt: '', audienceRole: '', departmentId: '' });
  }

  async remove(a: Announcement) {
    const ok = await confirmAction(this.dialog, { title: `Delete "${a.title}"?`, message: 'Employees will no longer see it.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    const done = await this.notify.run(() => this.api.delete(`/org/announcements/${a.id}`), 'Announcement deleted.');
    if (done !== undefined) await this.load();
  }
}

// -- Organization settings, departments, designations --------------------------------------------------------------
interface Profile {
  name: string;
  legalName: string | null;
  timezone: string;
  weeklyOffDays: number[];
  financialYearStartMonth: number;
  shiftStart: string;
  shiftEnd: string;
  graceMinutes: number;
  standardBreakMinutes: number;
  breakDeductionAfterMinutes: number;
  pfEmployeeRateBps: number;
  pfEmployerRateBps: number;
  pfWageCeilingPaise: number;
  esiEmployeeRateBps: number;
  esiEmployerRateBps: number;
  esiGrossCeilingPaise: number;
  overtimeMultiplierBps: number;
  canEditIdentity: boolean;
}

@Component({
  selector: 'ph-organization-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatIconModule, MatInputModule, MatTabsModule, StateView],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Organization settings</h1>
          <p>Working hours, leave year, statutory rates and the company structure. Changes are recorded in the audit log.</p>
        </div>
      </header>
      <mat-tab-group animationDuration="0ms" aria-label="Settings sections">
        <mat-tab label="Attendance and calendar">
          <section class="card">
            <ph-state [state]="state()" (retry)="load()" title="Settings could not be loaded">
              @if (profile(); as p) {
                <form [formGroup]="form" (ngSubmit)="save()" novalidate class="grid-form">
                  <mat-form-field appearance="outline"><mat-label>Company name</mat-label><input matInput formControlName="name" [readonly]="!p.canEditIdentity" /><mat-hint>Super Admin only</mat-hint></mat-form-field>
                  <mat-form-field appearance="outline"><mat-label>Timezone (IANA)</mat-label><input matInput formControlName="timezone" [readonly]="!p.canEditIdentity" /><mat-hint>For example Asia/Kolkata</mat-hint>
                    @if (form.controls.timezone.invalid && form.controls.timezone.touched) { <mat-error>Enter a valid IANA timezone.</mat-error> }
                  </mat-form-field>
                  <mat-form-field appearance="outline"><mat-label>Shift start (HH:mm)</mat-label><input matInput formControlName="shiftStart" />
                    @if (form.controls.shiftStart.invalid && form.controls.shiftStart.touched) { <mat-error>Use 24-hour HH:mm.</mat-error> }
                  </mat-form-field>
                  <mat-form-field appearance="outline"><mat-label>Shift end (HH:mm)</mat-label><input matInput formControlName="shiftEnd" />
                    @if (form.controls.shiftEnd.invalid && form.controls.shiftEnd.touched) { <mat-error>Use 24-hour HH:mm.</mat-error> }
                  </mat-form-field>
                  <mat-form-field appearance="outline"><mat-label>Grace period (minutes)</mat-label><input matInput type="number" formControlName="graceMinutes" /><mat-hint>Late only after this grace</mat-hint></mat-form-field>
                  <mat-form-field appearance="outline"><mat-label>Standard break (minutes)</mat-label><input matInput type="number" formControlName="standardBreakMinutes" /></mat-form-field>
                  <mat-form-field appearance="outline"><mat-label>Deduct break after (minutes worked)</mat-label><input matInput type="number" formControlName="breakDeductionAfterMinutes" /></mat-form-field>
                  <mat-form-field appearance="outline"><mat-label>Financial year starts (month 1-12)</mat-label><input matInput type="number" formControlName="financialYearStartMonth" min="1" max="12" /></mat-form-field>
                  <mat-form-field appearance="outline"><mat-label>Overtime multiplier (bps, 0 = not paid)</mat-label><input matInput type="number" formControlName="overtimeMultiplierBps" /><mat-hint>15000 = 1.5x. Verify with your policy.</mat-hint></mat-form-field>
                  <div class="weekly">
                    <span class="lbl">Weekly offs</span>
                    @for (d of weekDays; track d.value) {
                      <mat-checkbox [checked]="p.weeklyOffDays.includes(d.value)" (change)="toggleOff(d.value, $event.checked)">{{ d.label }}</mat-checkbox>
                    }
                  </div>
                  <div class="submit"><button mat-flat-button color="primary" type="submit" [disabled]="saving()">Save settings</button></div>
                </form>
              }
            </ph-state>
          </section>
        </mat-tab>

        <mat-tab label="Payroll rules">
          <section class="card">
            <p class="muted">Rates are stored in basis points (1200 = 12%). Confirm all statutory rates, ceilings and eligibility with a qualified professional before relying on them.</p>
            <form [formGroup]="form" (ngSubmit)="save()" novalidate class="grid-form">
              <mat-form-field appearance="outline"><mat-label>PF employee rate (bps)</mat-label><input matInput type="number" formControlName="pfEmployeeRateBps" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>PF employer rate (bps)</mat-label><input matInput type="number" formControlName="pfEmployerRateBps" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>PF wage ceiling (paise)</mat-label><input matInput type="number" formControlName="pfWageCeilingPaise" /><mat-hint>1500000 = ₹15,000</mat-hint></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>ESI employee rate (bps)</mat-label><input matInput type="number" formControlName="esiEmployeeRateBps" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>ESI employer rate (bps)</mat-label><input matInput type="number" formControlName="esiEmployerRateBps" /></mat-form-field>
              <mat-form-field appearance="outline"><mat-label>ESI gross ceiling (paise)</mat-label><input matInput type="number" formControlName="esiGrossCeilingPaise" /><mat-hint>2100000 = ₹21,000</mat-hint></mat-form-field>
              <div class="submit"><button mat-flat-button color="primary" type="submit" [disabled]="saving()">Save payroll rules</button></div>
            </form>
          </section>
        </mat-tab>

        <mat-tab label="Departments and designations">
          <div class="grid grid-2">
            <section class="card">
              <h2 class="card-title">Departments</h2>
              <form [formGroup]="deptForm" (ngSubmit)="addDept()" class="inline" novalidate>
                <mat-form-field appearance="outline"><mat-label>Name</mat-label><input matInput formControlName="name" /></mat-form-field>
                <mat-form-field appearance="outline"><mat-label>Code</mat-label><input matInput formControlName="code" /></mat-form-field>
                <button mat-flat-button color="primary" type="submit">Add</button>
              </form>
              <div class="table-wrap">
                <table class="data">
                  <caption class="sr-only">Departments</caption>
                  <thead><tr><th scope="col">Name</th><th scope="col">Code</th><th scope="col" class="num">Employees</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    @for (d of departments(); track d.id) {
                      <tr><td>{{ d.name }}</td><td>{{ d.code }}</td><td class="num">{{ d.employeeCount }}</td><td><button mat-button type="button" color="warn" (click)="removeDept(d)">Delete<span class="sr-only"> {{ d.name }}</span></button></td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
            <section class="card">
              <h2 class="card-title">Designations</h2>
              <form [formGroup]="desigForm" (ngSubmit)="addDesig()" class="inline" novalidate>
                <mat-form-field appearance="outline"><mat-label>Title</mat-label><input matInput formControlName="title" /></mat-form-field>
                <button mat-flat-button color="primary" type="submit">Add</button>
              </form>
              <div class="table-wrap">
                <table class="data">
                  <caption class="sr-only">Designations</caption>
                  <thead><tr><th scope="col">Title</th><th scope="col"><span class="sr-only">Actions</span></th></tr></thead>
                  <tbody>
                    @for (d of designations(); track d.id) {
                      <tr><td>{{ d.title }}</td><td><button mat-button type="button" color="warn" (click)="removeDesig(d)">Delete<span class="sr-only"> {{ d.title }}</span></button></td></tr>
                    }
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </mat-tab>
      </mat-tab-group>
    </div>
  `,
  styles: [
    `
      .grid-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 0 14px; }
      .submit { grid-column: 1 / -1; display: flex; justify-content: flex-end; }
      .weekly { grid-column: 1 / -1; display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
      .lbl { font-weight: 600; font-size: 13px; }
      .inline { display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; margin-bottom: 12px; }
      .inline mat-form-field { width: 200px; }
      .inline button { margin-top: 6px; }
      .muted { color: var(--ph-text-muted); }
      .num { text-align: right; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      @media (max-width: 640px) { .inline mat-form-field { width: 100%; } }
    `,
  ],
})
export class OrganizationPage implements OnInit {
  private readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly fb = inject(FormBuilder);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);
  private readonly title = inject(Title);
  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly profile = signal<Profile | null>(null);
  readonly saving = signal(false);
  readonly departments = signal<{ id: string; name: string; code: string; employeeCount: number }[]>([]);
  readonly designations = signal<{ id: string; title: string }[]>([]);
  readonly weekDays = [
    { value: 0, label: 'Sun' }, { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
    { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' },
  ];
  private weeklyOffs: number[] = [0];

  readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(2)]],
    timezone: ['Asia/Kolkata', [Validators.required, Validators.pattern(/^[A-Za-z_]+\/[A-Za-z_\/+-]+$/)]],
    shiftStart: ['09:30', [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)]],
    shiftEnd: ['18:30', [Validators.required, Validators.pattern(/^([01]\d|2[0-3]):[0-5]\d$/)]],
    graceMinutes: [10, [Validators.required, Validators.min(0), Validators.max(120)]],
    standardBreakMinutes: [60, [Validators.required, Validators.min(0), Validators.max(240)]],
    breakDeductionAfterMinutes: [360, [Validators.required, Validators.min(0), Validators.max(720)]],
    financialYearStartMonth: [4, [Validators.required, Validators.min(1), Validators.max(12)]],
    overtimeMultiplierBps: [0, [Validators.required, Validators.min(0), Validators.max(30000)]],
    pfEmployeeRateBps: [1200, [Validators.required, Validators.min(0), Validators.max(2000)]],
    pfEmployerRateBps: [1200, [Validators.required, Validators.min(0), Validators.max(2000)]],
    pfWageCeilingPaise: [1500000, [Validators.required, Validators.min(0)]],
    esiEmployeeRateBps: [75, [Validators.required, Validators.min(0), Validators.max(2000)]],
    esiEmployerRateBps: [325, [Validators.required, Validators.min(0), Validators.max(2000)]],
    esiGrossCeilingPaise: [2100000, [Validators.required, Validators.min(0)]],
  });
  readonly deptForm = this.fb.nonNullable.group({ name: ['', [Validators.required, Validators.minLength(2)]], code: ['', [Validators.required, Validators.pattern(/^[A-Za-z]{2,6}$/)]] });
  readonly desigForm = this.fb.nonNullable.group({ title: ['', [Validators.required, Validators.minLength(2)]] });

  ngOnInit() {
    this.title.setTitle('Organization | PeopleHub');
    void this.load();
    void this.loadStructure();
  }

  async load() {
    this.state.set('loading');
    try {
      const p = await this.api.get<Profile>('/org/profile');
      this.profile.set(p);
      this.weeklyOffs = [...p.weeklyOffDays];
      this.form.patchValue({ ...p, name: p.name });
      if (!p.canEditIdentity) {
        this.form.controls.name.disable({ emitEvent: false });
        this.form.controls.timezone.disable({ emitEvent: false });
      }
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  async loadStructure() {
    try {
      const [d, s] = await Promise.all([
        this.api.get<{ items: { id: string; name: string; code: string; employeeCount: number }[] }>('/org/departments'),
        this.api.get<{ items: { id: string; title: string }[] }>('/org/designations'),
      ]);
      this.departments.set(d.items);
      this.designations.set(s.items);
    } catch {
      this.notify.error('Departments and designations could not be loaded.');
    }
  }

  toggleOff(day: number, on: boolean) {
    this.weeklyOffs = on ? [...new Set([...this.weeklyOffs, day])] : this.weeklyOffs.filter((d) => d !== day);
    const p = this.profile();
    if (p) this.profile.set({ ...p, weeklyOffDays: this.weeklyOffs });
  }

  async save() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.saving.set(true);
    const raw = this.form.getRawValue();
    try {
      await this.api.patch('/org/profile', { ...raw, weeklyOffDays: this.weeklyOffs });
      this.notify.success('Settings saved. Changes apply to new records and runs.');
      // The company name shows in the sidebar and dashboard, which read it from the session.
      await this.auth.load(true);
      await this.load();
    } catch (err) {
      if (!applyFieldErrors(this.form, err)) this.notify.error(err instanceof ApiError ? err.message : 'Could not save settings.');
    } finally {
      this.saving.set(false);
    }
  }

  async addDept() {
    this.deptForm.markAllAsTouched();
    if (this.deptForm.invalid) return;
    const ok = await this.notify.run(() => this.api.post('/org/departments', this.deptForm.getRawValue()), 'Department added.');
    if (ok !== undefined) {
      this.deptForm.reset();
      await this.loadStructure();
    }
  }

  async removeDept(d: { id: string; name: string; employeeCount: number }) {
    const ok = await confirmAction(this.dialog, { title: `Delete ${d.name}?`, message: 'Departments with employees cannot be deleted. Move employees first.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    const done = await this.notify.run(() => this.api.delete(`/org/departments/${d.id}`), 'Department deleted.');
    if (done !== undefined) await this.loadStructure();
  }

  async addDesig() {
    this.desigForm.markAllAsTouched();
    if (this.desigForm.invalid) return;
    const ok = await this.notify.run(() => this.api.post('/org/designations', this.desigForm.getRawValue()), 'Designation added.');
    if (ok !== undefined) {
      this.desigForm.reset();
      await this.loadStructure();
    }
  }

  async removeDesig(d: { id: string; title: string }) {
    const ok = await confirmAction(this.dialog, { title: `Delete ${d.title}?`, message: 'Designations held by employees cannot be deleted.', confirmLabel: 'Delete', destructive: true });
    if (!ok) return;
    const done = await this.notify.run(() => this.api.delete(`/org/designations/${d.id}`), 'Designation deleted.');
    if (done !== undefined) await this.loadStructure();
  }
}

// -- Audit log -------------------------------------------------------------------------------------------------------
interface AuditItem {
  id: string;
  actor: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

@Component({
  selector: 'ph-audit-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatSelectModule, StateView],
  template: `
    <div class="page">
      <header class="page-header">
        <div>
          <h1>Audit log</h1>
          <p>Who did what, and when, for sensitive actions. Passwords, tokens and full bank or PAN values are never recorded.</p>
        </div>
      </header>
      <section class="card">
        <form [formGroup]="filters" class="inline" novalidate aria-label="Filter audit log">
          <mat-form-field appearance="outline"><mat-label>Action contains</mat-label><input matInput formControlName="action" /></mat-form-field>
          <mat-form-field appearance="outline"><mat-label>Record type</mat-label>
            <mat-select formControlName="entityType">
              <mat-option value="">All types</mat-option>
              @for (t of entityTypes; track t) { <mat-option [value]="t">{{ t }}</mat-option> }
            </mat-select>
          </mat-form-field>
          <button mat-stroked-button type="button" (click)="apply()"><mat-icon>filter_alt</mat-icon> Apply</button>
        </form>
        <ph-state [state]="state()" (retry)="load()" title="Audit log could not be loaded">
          <div class="table-wrap">
            <table class="data">
              <caption class="sr-only">Audit events, newest first</caption>
              <thead><tr><th scope="col">When</th><th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Record</th><th scope="col">Change summary</th></tr></thead>
              <tbody>
                @for (i of items(); track i.id) {
                  <tr>
                    <td>{{ instant(i.createdAt) }}</td>
                    <td>{{ i.actor ?? 'System' }}</td>
                    <td><code>{{ i.action }}</code></td>
                    <td>{{ i.entityType }} @if (i.entityId) { <span class="muted small">{{ i.entityId.slice(0, 10) }}…</span> }</td>
                    <td class="small">{{ summary(i.summary) }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="5" class="muted">No events match these filters.</td></tr>
                }
              </tbody>
            </table>
          </div>
        </ph-state>
        <nav class="pager" aria-label="Audit pages">
          <button mat-stroked-button type="button" [disabled]="page() <= 1" (click)="go(page() - 1)">Previous</button>
          <span>Page {{ page() }} of {{ totalPages() }}</span>
          <button mat-stroked-button type="button" [disabled]="page() >= totalPages()" (click)="go(page() + 1)">Next</button>
        </nav>
      </section>
    </div>
  `,
  styles: [
    `
      .inline { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-start; margin-bottom: 12px; }
      .inline mat-form-field { width: 220px; }
      .inline button { margin-top: 6px; }
      .muted { color: var(--ph-text-muted); }
      .small { font-size: 12px; }
      code { font-size: 12px; background: var(--ph-surface-muted); padding: 1px 6px; border-radius: 6px; }
      .pager { display: flex; justify-content: center; gap: 12px; align-items: center; margin-top: 14px; }
      .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    `,
  ],
})
export class AuditPage implements OnInit {
  private readonly api = inject(Api);
  private readonly fb = inject(FormBuilder);
  private readonly title = inject(Title);
  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly items = signal<AuditItem[]>([]);
  readonly page = signal(1);
  readonly totalPages = signal(1);
  readonly entityTypes = ['Employee', 'PayrollRun', 'PayrollEntry', 'LeaveRequest', 'AttendanceRecord', 'AttendanceCorrection', 'Organization', 'User', 'Holiday', 'Announcement'];
  readonly instant = (iso: string) => formatInstant(iso);
  readonly filters = this.fb.nonNullable.group({ action: [''], entityType: [''] });

  ngOnInit() {
    this.title.setTitle('Audit log | PeopleHub');
    void this.load();
  }

  apply() {
    this.page.set(1);
    void this.load();
  }

  go(p: number) {
    this.page.set(p);
    void this.load();
  }

  summary(s: Record<string, unknown> | null): string {
    if (!s) return '—';
    return Object.entries(s)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
      .join(' · ')
      .slice(0, 180);
  }

  async load() {
    this.state.set('loading');
    try {
      const f = this.filters.getRawValue();
      const res = await this.api.get<{ items: AuditItem[]; totalPages: number }>('/org/audit-logs', {
        page: this.page(),
        pageSize: 25,
        action: f.action || undefined,
        entityType: f.entityType || undefined,
      });
      this.items.set(res.items);
      this.totalPages.set(res.totalPages);
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }
}

export { formatDate };
