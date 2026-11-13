import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Title } from '@angular/platform-browser';
import { Avatar } from '../../shared/avatar';
import { prepareProfilePhoto } from '../../shared/image';
import { Api, ApiError } from '../../core/api';
import { Auth } from '../../core/auth';
import { Notify, applyFieldErrors } from '../../core/notify';
import { StateView, StatusBadge, type Tone } from '../../shared/ui';
import { firstValueFrom } from 'rxjs';
import { formatDate, formatPaise } from '../../shared/format';
import { SalaryDialog, type SalaryInput } from './salary-dialog';
import { OffboardDialog, type OffboardResult } from './offboard-dialog';

interface EmployeeDetail {
  id: string;
  employeeCode: string;
  name: string;
  firstName: string;
  lastName: string;
  photoUrl: string | null;
  workEmail: string;
  personalEmail: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  joiningDate: string;
  exitDate: string | null;
  status: 'ACTIVE' | 'ON_NOTICE' | 'EXITED';
  onboardingStatus: string;
  employmentType: string;
  workLocation: string;
  department: { id: string; name: string };
  designation: { id: string; title: string };
  manager: { id: string; name: string } | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  bankAccount: string | null;
  bankName: string | null;
  bankIfsc: string | null;
  pan: string | null;
  account: { role: string; isActive: boolean; lastLoginAt: string | null } | null;
  directReports: { id: string; firstName: string; lastName: string; employeeCode: string }[];
  currentSalary: {
    effectiveFrom: string;
    basicPaise: number;
    hraPaise: number;
    conveyancePaise: number;
    specialPaise: number;
    otherAllowancePaise: number;
    pfApplicable: boolean;
    esiApplicable: boolean;
    professionalTaxPaise: number;
    monthlyTdsPaise: number;
  } | null;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'Active', tone: 'ok' },
  ON_NOTICE: { label: 'On notice', tone: 'warn' },
  EXITED: { label: 'Exited', tone: 'neutral' },
};

@Component({
  selector: 'ph-employee-detail',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MatButtonModule, MatFormFieldModule, MatIconModule, MatInputModule, MatTabsModule, MatTooltipModule, StateView, StatusBadge, Avatar],
  template: `
    <div class="page">
      <nav aria-label="Breadcrumb" class="crumbs"><a routerLink="/employees">Employees</a> / <span>{{ employee()?.name ?? 'Profile' }}</span></nav>

      <ph-state [state]="state()" (retry)="load()" title="Profile could not be loaded" message="This record may not exist, or you may not have access to it.">
        @if (employee(); as e) {
          <header class="card head">
            <div class="who">
              <div class="photo">
                <ph-avatar [name]="e.name" [photoUrl]="e.photoUrl" [size]="88" [ring]="true" />
                @if (canEditPhoto()) {
                  <label class="photo-btn" [class.busy]="uploading()" matTooltip="Change photo">
                    <input type="file" accept="image/png,image/jpeg,image/webp" (change)="onPhoto($event)" [disabled]="uploading()" aria-label="Upload a profile photo" />
                    <mat-icon aria-hidden="true">{{ uploading() ? 'hourglass_top' : 'photo_camera' }}</mat-icon>
                  </label>
                }
              </div>
              <div>
                <h1>{{ e.name }}</h1>
                <p class="muted">{{ e.designation.title }} · {{ e.department.name }} · {{ e.employeeCode }}</p>
                <ph-status-badge [label]="statusOf(e.status).label" [tone]="statusOf(e.status).tone" />
                @if (canEditPhoto() && e.photoUrl) {
                  <div><button mat-button type="button" class="remove-photo" (click)="removePhoto()" [disabled]="uploading()">Remove photo</button></div>
                }
              </div>
            </div>
            <div class="toolbar">
              @if (auth.has('employees:write') && e.status !== 'EXITED') {
                <a mat-stroked-button [routerLink]="['/employees', e.id, 'edit']"><mat-icon>edit</mat-icon> Edit</a>
                <button mat-stroked-button type="button" (click)="offboard()"><mat-icon>logout</mat-icon> Offboard</button>
              }
              @if (auth.has('payroll:manage') && e.status !== 'EXITED') {
                <button mat-stroked-button type="button" (click)="addSalary()"><mat-icon>currency_rupee</mat-icon> Salary revision</button>
              }
            </div>
          </header>

          <mat-tab-group animationDuration="0ms" class="tabs" [selectedIndex]="0" aria-label="Employee information">
            <mat-tab label="Personal and contact">
              <section class="card" aria-labelledby="personal-title">
                <h2 id="personal-title" class="card-title">Personal and contact</h2>
                <dl class="facts">
                  <div><dt>Work email</dt><dd>{{ e.workEmail }}</dd></div>
                  <div><dt>Personal email</dt><dd>{{ e.personalEmail ?? '—' }}</dd></div>
                  <div><dt>Phone</dt><dd>{{ e.phone ?? '—' }}</dd></div>
                  <div><dt>Date of birth</dt><dd>{{ formatDate(e.dateOfBirth) }}</dd></div>
                  <div><dt>Address</dt><dd>{{ addressLine(e) }}</dd></div>
                  <div><dt>Emergency contact</dt><dd>{{ e.emergencyContactName ?? '—' }} {{ e.emergencyContactPhone ? '· ' + e.emergencyContactPhone : '' }}</dd></div>
                </dl>
              </section>
            </mat-tab>

            <mat-tab label="Employment">
              <section class="card" aria-labelledby="employment-title">
                <h2 id="employment-title" class="card-title">Employment</h2>
                <dl class="facts">
                  <div><dt>Joined</dt><dd>{{ formatDate(e.joiningDate) }}</dd></div>
                  <div><dt>Employment type</dt><dd>{{ typeLabel(e.employmentType) }}</dd></div>
                  <div><dt>Work location</dt><dd>{{ e.workLocation }}</dd></div>
                  <div><dt>Reporting manager</dt><dd>@if (e.manager; as m) { <a [routerLink]="['/employees', m.id]">{{ m.name }}</a> } @else { — }</dd></div>
                  <div><dt>Onboarding</dt><dd>{{ onboardingLabel(e.onboardingStatus) }}</dd></div>
                  @if (e.exitDate) {
                    <div><dt>Exit date</dt><dd>{{ formatDate(e.exitDate) }}</dd></div>
                  }
                  @if (e.account; as acc) {
                    <div><dt>Sign-in role</dt><dd>{{ roleLabel(acc.role) }} · {{ acc.isActive ? 'Can sign in' : 'Sign-in disabled' }}</dd></div>
                  }
                </dl>
                @if (e.directReports.length) {
                  <h3 class="sub-title">Direct reports</h3>
                  <ul class="plain">
                    @for (r of e.directReports; track r.id) {
                      <li><a [routerLink]="['/employees', r.id]">{{ r.firstName }} {{ r.lastName }}</a> <span class="muted">{{ r.employeeCode }}</span></li>
                    }
                  </ul>
                }
              </section>
            </mat-tab>

            @if (auth.hasAny('employees:sensitive', 'payroll:read')) {
              <mat-tab label="Bank and tax IDs">
                <section class="card" aria-labelledby="bank-title">
                  <h2 id="bank-title" class="card-title">Bank and tax identifiers</h2>
                  <p class="muted">Shown masked. Revealing these values is recorded in the audit log.</p>
                  <dl class="facts">
                    <div><dt>Bank</dt><dd>{{ e.bankName ?? '—' }}</dd></div>
                    <div><dt>IFSC</dt><dd>{{ e.bankIfsc ?? '—' }}</dd></div>
                    <div><dt>Account</dt><dd>{{ revealed() ? (revealed()!.bankAccount ?? '—') : (e.bankAccount ?? '—') }}</dd></div>
                    <div><dt>PAN</dt><dd>{{ revealed() ? (revealed()!.pan ?? '—') : (e.pan ?? '—') }}</dd></div>
                  </dl>
                  @if (auth.has('employees:sensitive') && !revealed()) {
                    <button mat-stroked-button type="button" (click)="reveal()"><mat-icon>visibility</mat-icon> Reveal full values</button>
                  }
                  @if (auth.has('employees:sensitive')) {
                    <form class="bank-form" [formGroup]="bankForm" (ngSubmit)="saveBank()" novalidate aria-label="Update bank and PAN">
                      <h3 class="sub-title">Update bank and PAN</h3>
                      <div class="form-grid">
                        <mat-form-field appearance="outline">
                          <mat-label>Account number</mat-label>
                          <input matInput formControlName="accountNumber" autocomplete="off" inputmode="numeric" />
                          @if (bankForm.controls.accountNumber.invalid && bankForm.controls.accountNumber.touched) {
                            <mat-error>{{ errorFor(bankForm.controls.accountNumber) }}</mat-error>
                          }
                        </mat-form-field>
                        <mat-form-field appearance="outline">
                          <mat-label>IFSC</mat-label>
                          <input matInput formControlName="ifsc" autocomplete="off" />
                          @if (bankForm.controls.ifsc.invalid && bankForm.controls.ifsc.touched) {
                            <mat-error>{{ errorFor(bankForm.controls.ifsc) }}</mat-error>
                          }
                        </mat-form-field>
                        <mat-form-field appearance="outline">
                          <mat-label>Bank name</mat-label>
                          <input matInput formControlName="bankName" />
                          @if (bankForm.controls.bankName.invalid && bankForm.controls.bankName.touched) {
                            <mat-error>{{ errorFor(bankForm.controls.bankName) }}</mat-error>
                          }
                        </mat-form-field>
                        <mat-form-field appearance="outline">
                          <mat-label>PAN</mat-label>
                          <input matInput formControlName="pan" autocomplete="off" />
                          @if (bankForm.controls.pan.invalid && bankForm.controls.pan.touched) {
                            <mat-error>{{ errorFor(bankForm.controls.pan) }}</mat-error>
                          }
                        </mat-form-field>
                      </div>
                      <button mat-flat-button color="primary" type="submit" [disabled]="savingBank()">Save bank and PAN</button>
                    </form>
                  }
                </section>
              </mat-tab>
            }

            @if (auth.has('payroll:read')) {
              <mat-tab label="Salary">
                <section class="card" aria-labelledby="salary-title">
                  <h2 id="salary-title" class="card-title">Current salary structure</h2>
                  @if (e.currentSalary; as s) {
                    <dl class="facts">
                      <div><dt>Effective from</dt><dd>{{ formatDate(s.effectiveFrom) }}</dd></div>
                      <div><dt>Basic</dt><dd>{{ paise(s.basicPaise) }}</dd></div>
                      <div><dt>HRA</dt><dd>{{ paise(s.hraPaise) }}</dd></div>
                      <div><dt>Conveyance</dt><dd>{{ paise(s.conveyancePaise) }}</dd></div>
                      <div><dt>Special</dt><dd>{{ paise(s.specialPaise) }}</dd></div>
                      <div><dt>Other</dt><dd>{{ paise(s.otherAllowancePaise) }}</dd></div>
                      <div><dt>PF applicable</dt><dd>{{ s.pfApplicable ? 'Yes' : 'No' }}</dd></div>
                      <div><dt>ESI applicable</dt><dd>{{ s.esiApplicable ? 'Yes' : 'No' }}</dd></div>
                      <div><dt>Professional tax (monthly)</dt><dd>{{ paise(s.professionalTaxPaise) }}</dd></div>
                      <div><dt>TDS (monthly, from HR's tax computation)</dt><dd>{{ paise(s.monthlyTdsPaise) }}</dd></div>
                    </dl>
                  } @else {
                    <p class="muted">No salary structure has been assigned yet.</p>
                  }
                  <h3 class="sub-title">History</h3>
                  <ul class="plain">
                    @for (h of salaryHistory(); track h.id) {
                      <li>{{ formatDate(h.effectiveFrom) }} · Basic {{ paise(h.basicPaise) }}</li>
                    } @empty {
                      <li class="muted">No revisions recorded.</li>
                    }
                  </ul>
                </section>
              </mat-tab>
            }
          </mat-tab-group>
        }
      </ph-state>
    </div>
  `,
  styles: [
    `
      .crumbs { font-size: 13px; color: var(--ph-text-muted); }
      .crumbs a { color: var(--ph-primary); text-decoration: none; }
      .head { display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap; }
      .head h1 { margin: 0 0 2px; font-size: 22px; }
      .who { display: flex; gap: 14px; align-items: center; }
      .photo { position: relative; }
      .photo-btn { position: absolute; right: -2px; bottom: -2px; width: 34px; height: 34px; border-radius: 50%; display: grid; place-items: center; background: var(--ph-primary); color: #fff; cursor: pointer; box-shadow: var(--ph-shadow-md); border: 3px solid var(--ph-surface); transition: transform var(--ph-dur-fast) var(--ph-ease); }
      .photo-btn:hover { transform: scale(1.08); }
      .photo-btn:focus-within { outline: 2px solid var(--ph-primary); outline-offset: 2px; }
      .photo-btn input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
      .photo-btn mat-icon { font-size: 17px; width: 17px; height: 17px; }
      .photo-btn.busy { cursor: progress; }
      .remove-photo { margin-top: 4px; }
      .muted { color: var(--ph-text-muted); }
      .facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 14px 24px; margin: 0; }
      .facts dt { font-size: 12px; color: var(--ph-text-muted); }
      .facts dd { margin: 2px 0 0; font-weight: 500; overflow-wrap: anywhere; }
      .sub-title { font-size: 13px; margin: 20px 0 8px; }
      .plain { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
      .plain a { color: var(--ph-primary); }
      .tabs { margin-top: 4px; }
      .bank-form { margin-top: 18px; padding-top: 12px; border-top: 1px dashed var(--ph-border); }
      .bank-form button { margin-top: 8px; }
    `,
  ],
})
export class EmployeeDetailPage implements OnInit {
  readonly auth = inject(Auth);
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly notify = inject(Notify);
  private readonly dialog = inject(MatDialog);
  private readonly fb = inject(FormBuilder);
  private readonly title = inject(Title);

  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly employee = signal<EmployeeDetail | null>(null);
  readonly revealed = signal<{ bankAccount: string | null; pan: string | null } | null>(null);
  readonly salaryHistory = signal<{ id: string; effectiveFrom: string; basicPaise: number }[]>([]);
  readonly savingBank = signal(false);
  readonly uploading = signal(false);
  readonly formatDate = formatDate;
  readonly paise = formatPaise;

  /** HR can change anyone's photo; employees can change their own (the API enforces the same rule). */
  canEditPhoto(): boolean {
    const e = this.employee();
    return !!e && e.status !== 'EXITED' && (this.auth.has('employees:write') || this.auth.user()?.employeeId === e.id);
  }

  async removePhoto() {
    this.uploading.set(true);
    const ok = await this.notify.run(() => this.api.delete(`/employees/${this.id}/photo`), 'Profile photo removed.');
    this.uploading.set(false);
    if (ok !== undefined) {
      this.employee.update((e) => (e ? { ...e, photoUrl: null } : e));
      if (this.auth.user()?.employeeId === this.id) await this.auth.load(true);
    }
  }

  async onPhoto(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.uploading.set(true);
    try {
      const dataUrl = await prepareProfilePhoto(file);
      const res = await this.api.put<{ photoUrl: string }>(`/employees/${this.id}/photo`, { dataUrl });
      this.employee.update((e) => (e ? { ...e, photoUrl: res.photoUrl } : e));
      if (this.auth.user()?.employeeId === this.id) await this.auth.load(true);
      this.notify.success('Profile photo updated.');
    } catch (err) {
      this.notify.error(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Could not upload the photo.');
    } finally {
      this.uploading.set(false);
    }
  }

  readonly bankForm = this.fb.nonNullable.group({
    accountNumber: ['', [Validators.required, Validators.pattern(/^\d{6,18}$/)]],
    ifsc: ['', [Validators.required, Validators.pattern(/^[A-Z]{4}0[A-Z0-9]{6}$/)]],
    bankName: ['', [Validators.required, Validators.minLength(2)]],
    pan: ['', [Validators.required, Validators.pattern(/^[A-Z]{5}[0-9]{4}[A-Z]$/)]],
  });

  ngOnInit() {
    void this.load();
  }

  private get id(): string {
    return this.route.snapshot.paramMap.get('id') ?? '';
  }

  async load() {
    this.state.set('loading');
    try {
      const e = await this.api.get<EmployeeDetail>(`/employees/${this.id}`);
      this.employee.set(e);
      this.title.setTitle(`${e.name} | Employees | PeopleHub`);
      this.bankForm.patchValue({ bankName: e.bankName ?? '', ifsc: e.bankIfsc ?? '' });
      if (this.auth.has('payroll:read')) {
        this.salaryHistory.set((await this.api.get<{ items: { id: string; effectiveFrom: string; basicPaise: number }[] }>(`/employees/${this.id}/salary-history`)).items);
      }
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  async reveal() {
    const values = await this.notify.run(() => this.api.get<{ bankAccount: string | null; pan: string | null }>(`/employees/${this.id}/sensitive`));
    if (values) this.revealed.set(values);
  }

  async saveBank() {
    this.bankForm.markAllAsTouched();
    if (this.bankForm.invalid) return;
    this.savingBank.set(true);
    const v = this.bankForm.getRawValue();
    try {
      await this.api.put(`/employees/${this.id}/bank-details`, {
        accountNumber: v.accountNumber,
        ifsc: v.ifsc.toUpperCase(),
        bankName: v.bankName,
        pan: v.pan.toUpperCase(),
      });
      this.notify.success('Bank and PAN details saved.');
      this.bankForm.patchValue({ accountNumber: '', pan: '' });
      this.revealed.set(null);
      await this.load();
    } catch (err) {
      if (!applyFieldErrors(this.bankForm, err)) this.notify.error(err instanceof ApiError ? err.message : 'Could not save bank details.');
    } finally {
      this.savingBank.set(false);
    }
  }

  async offboard() {
    const e = this.employee();
    if (!e) return;
    const result = await firstValueFrom(this.dialog.open<OffboardDialog, { name: string }, OffboardResult>(OffboardDialog, { data: { name: e.name }, width: 'min(480px, 94vw)' }).afterClosed());
    if (!result) return;
    const ok = await this.notify.run(() => this.api.post(`/employees/${e.id}/offboard`, result), `${e.name} has been offboarded and sign-in is disabled.`);
    if (ok !== undefined) await this.load();
  }

  async addSalary() {
    const e = this.employee();
    if (!e) return;
    const value = await firstValueFrom(this.dialog.open<SalaryDialog, { name: string }, SalaryInput>(SalaryDialog, { data: { name: e.name }, width: 'min(640px, 94vw)' }).afterClosed());
    if (!value) return;
    const ok = await this.notify.run(() => this.api.post(`/employees/${e.id}/salary`, value), 'Salary structure saved. The change is recorded in the audit log.');
    if (ok !== undefined) await this.load();
  }

  statusOf(s: EmployeeDetail['status']) {
    return STATUS[s] ?? { label: s, tone: 'neutral' as Tone };
  }

  typeLabel(t: string) {
    return ({ FULL_TIME: 'Full time', PART_TIME: 'Part time', CONTRACT: 'Contract', INTERN: 'Intern' } as Record<string, string>)[t] ?? t;
  }

  onboardingLabel(s: string) {
    return ({ PENDING: 'Pending', IN_PROGRESS: 'In progress', COMPLETE: 'Complete' } as Record<string, string>)[s] ?? s;
  }

  roleLabel(r: string) {
    return ({ SUPER_ADMIN: 'Super Admin', HR_ADMIN: 'HR Admin', MANAGER: 'Manager', EMPLOYEE: 'Employee' } as Record<string, string>)[r] ?? r;
  }

  addressLine(e: EmployeeDetail): string {
    const parts = [e.addressLine, e.city, e.state, e.postalCode].filter(Boolean);
    return parts.length ? parts.join(', ') : '—';
  }

  initials(name: string) {
    return name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  }

  errorFor(control: { errors: Record<string, unknown> | null }): string {
    const e = control.errors ?? {};
    if (e['server']) return String(e['server']);
    if (e['pattern']) return 'Check the format and try again.';
    return 'This field is required.';
  }
}
