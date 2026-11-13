import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Title } from '@angular/platform-browser';
import { Api, ApiError } from '../../core/api';
import { Notify, applyFieldErrors } from '../../core/notify';
import { StateView } from '../../shared/ui';

interface Meta {
  departments: { id: string; name: string }[];
  designations: { id: string; title: string }[];
  managers: { id: string; name: string; employeeCode: string }[];
}

/** Create and edit form for an employee record. API validation errors are shown beside the fields. */
@Component({
  selector: 'ph-employee-form',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, RouterLink, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule, MatSelectModule, StateView],
  template: `
    <div class="page">
      <nav class="crumbs" aria-label="Breadcrumb"><a routerLink="/employees">Employees</a> / <span>{{ editing() ? 'Edit' : 'New employee' }}</span></nav>
      <header class="page-header">
        <div>
          <h1>{{ editing() ? 'Edit employee' : 'Add employee' }}</h1>
          <p>Fields marked * are required. Bank and PAN are added from the profile page after creation.</p>
        </div>
      </header>

      <ph-state [state]="state()" (retry)="load()" title="The form could not be prepared" message="Refresh the page to try again.">
        <form [formGroup]="form" (ngSubmit)="submit()" novalidate class="card" aria-label="Employee details">
          <h2 class="card-title">Identity and contact</h2>
          <div class="form-grid">
            <mat-form-field appearance="outline">
              <mat-label>First name *</mat-label>
              <input matInput formControlName="firstName" autocomplete="off" />
              @if (show('firstName')) { <mat-error>{{ err('firstName') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Last name *</mat-label>
              <input matInput formControlName="lastName" autocomplete="off" />
              @if (show('lastName')) { <mat-error>{{ err('lastName') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Work email *</mat-label>
              <input matInput type="email" formControlName="workEmail" autocomplete="off" />
              @if (show('workEmail')) { <mat-error>{{ err('workEmail') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Personal email</mat-label>
              <input matInput type="email" formControlName="personalEmail" autocomplete="off" />
              @if (show('personalEmail')) { <mat-error>{{ err('personalEmail') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Phone</mat-label>
              <input matInput type="tel" formControlName="phone" autocomplete="off" />
              @if (show('phone')) { <mat-error>{{ err('phone') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Date of birth</mat-label>
              <input matInput type="date" formControlName="dateOfBirth" />
              @if (show('dateOfBirth')) { <mat-error>{{ err('dateOfBirth') }}</mat-error> }
            </mat-form-field>
          </div>

          <h2 class="card-title section">Employment</h2>
          <div class="form-grid">
            <mat-form-field appearance="outline">
              <mat-label>Joining date *</mat-label>
              <input matInput type="date" formControlName="joiningDate" />
              @if (show('joiningDate')) { <mat-error>{{ err('joiningDate') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Employment type *</mat-label>
              <mat-select formControlName="employmentType">
                <mat-option value="FULL_TIME">Full time</mat-option>
                <mat-option value="PART_TIME">Part time</mat-option>
                <mat-option value="CONTRACT">Contract</mat-option>
                <mat-option value="INTERN">Intern</mat-option>
              </mat-select>
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Work location *</mat-label>
              <input matInput formControlName="workLocation" />
              @if (show('workLocation')) { <mat-error>{{ err('workLocation') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Department *</mat-label>
              <mat-select formControlName="departmentId">
                @for (d of meta().departments; track d.id) { <mat-option [value]="d.id">{{ d.name }}</mat-option> }
              </mat-select>
              @if (show('departmentId')) { <mat-error>{{ err('departmentId') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Designation *</mat-label>
              <mat-select formControlName="designationId">
                @for (d of meta().designations; track d.id) { <mat-option [value]="d.id">{{ d.title }}</mat-option> }
              </mat-select>
              @if (show('designationId')) { <mat-error>{{ err('designationId') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Reporting manager</mat-label>
              <mat-select formControlName="managerId">
                <mat-option [value]="null">No manager</mat-option>
                @for (m of meta().managers; track m.id) { <mat-option [value]="m.id">{{ m.name }} ({{ m.employeeCode }})</mat-option> }
              </mat-select>
            </mat-form-field>
            @if (!editing()) {
              <mat-form-field appearance="outline">
                <mat-label>Employee code</mat-label>
                <input matInput formControlName="employeeCode" autocomplete="off" />
                <mat-hint>Leave blank to generate one.</mat-hint>
                @if (show('employeeCode')) { <mat-error>{{ err('employeeCode') }}</mat-error> }
              </mat-form-field>
            }
          </div>

          <h2 class="card-title section">Emergency contact and address</h2>
          <div class="form-grid">
            <mat-form-field appearance="outline">
              <mat-label>Emergency contact name</mat-label>
              <input matInput formControlName="emergencyContactName" />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>Emergency contact phone</mat-label>
              <input matInput type="tel" formControlName="emergencyContactPhone" />
              @if (show('emergencyContactPhone')) { <mat-error>{{ err('emergencyContactPhone') }}</mat-error> }
            </mat-form-field>
            <mat-form-field appearance="outline" class="wide">
              <mat-label>Address</mat-label>
              <input matInput formControlName="addressLine" />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>City</mat-label>
              <input matInput formControlName="city" />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>State</mat-label>
              <input matInput formControlName="state" />
            </mat-form-field>
            <mat-form-field appearance="outline">
              <mat-label>PIN code</mat-label>
              <input matInput inputmode="numeric" formControlName="postalCode" />
              @if (show('postalCode')) { <mat-error>{{ err('postalCode') }}</mat-error> }
            </mat-form-field>
          </div>

          @if (!editing()) {
            <h2 class="card-title section">Sign-in account</h2>
            <div class="account">
              <mat-checkbox formControlName="createAccount">Create a sign-in account and send a welcome link</mat-checkbox>
              @if (form.controls.createAccount.value) {
                <mat-form-field appearance="outline">
                  <mat-label>Account role</mat-label>
                  <mat-select formControlName="accountRole">
                    <mat-option value="EMPLOYEE">Employee</mat-option>
                    <mat-option value="MANAGER">Manager</mat-option>
                  </mat-select>
                </mat-form-field>
              }
            </div>
          }

          <div class="actions">
            <a mat-button routerLink="/employees">Cancel</a>
            <button mat-flat-button color="primary" type="submit" [disabled]="saving()">{{ saving() ? 'Saving…' : editing() ? 'Save changes' : 'Create employee' }}</button>
          </div>
        </form>
      </ph-state>
    </div>
  `,
  styles: [
    `
      .crumbs { font-size: 13px; color: var(--ph-text-muted); }
      .crumbs a { color: var(--ph-primary); text-decoration: none; }
      .section { margin-top: 24px; }
      .wide { grid-column: span 2; }
      .account { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
      .actions { display: flex; justify-content: flex-end; gap: 12px; margin-top: 20px; flex-wrap: wrap; }
      @media (max-width: 640px) { .wide { grid-column: auto; } }
    `,
  ],
})
export class EmployeeForm implements OnInit {
  private readonly fb = inject(FormBuilder);
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly notify = inject(Notify);
  private readonly title = inject(Title);

  readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  readonly saving = signal(false);
  readonly meta = signal<Meta>({ departments: [], designations: [], managers: [] });
  readonly editing = signal(false);
  private employeeId: string | null = null;

  readonly form = this.fb.nonNullable.group({
    firstName: ['', [Validators.required, Validators.maxLength(60)]],
    lastName: ['', [Validators.required, Validators.maxLength(60)]],
    workEmail: ['', [Validators.required, Validators.email]],
    personalEmail: ['', [Validators.email]],
    phone: ['', [Validators.pattern(/^$|^[+0-9 ()-]{7,20}$/)]],
    dateOfBirth: [''],
    joiningDate: ['', [Validators.required]],
    employmentType: ['FULL_TIME', [Validators.required]],
    workLocation: ['Head Office', [Validators.required]],
    departmentId: ['', [Validators.required]],
    designationId: ['', [Validators.required]],
    managerId: [null as string | null],
    employeeCode: ['', [Validators.pattern(/^$|^[A-Za-z0-9-]{3,20}$/)]],
    emergencyContactName: [''],
    emergencyContactPhone: ['', [Validators.pattern(/^$|^[+0-9 ()-]{7,20}$/)]],
    addressLine: [''],
    city: [''],
    state: [''],
    postalCode: ['', [Validators.pattern(/^$|^\d{6}$/)]],
    createAccount: [true],
    accountRole: ['EMPLOYEE' as 'EMPLOYEE' | 'MANAGER'],
  });

  ngOnInit() {
    this.employeeId = this.route.snapshot.paramMap.get('id');
    this.editing.set(Boolean(this.employeeId));
    this.title.setTitle(this.editing() ? 'Edit employee | PeopleHub' : 'Add employee | PeopleHub');
    void this.load();
  }

  async load() {
    this.state.set('loading');
    try {
      this.meta.set(await this.api.get<Meta>('/employees/meta'));
      if (this.employeeId) {
        const e = await this.api.get<Record<string, unknown> & { department: { id: string }; designation: { id: string }; manager: { id: string } | null }>(`/employees/${this.employeeId}`);
        this.form.patchValue({
          firstName: e['firstName'] as string,
          lastName: e['lastName'] as string,
          workEmail: e['workEmail'] as string,
          personalEmail: (e['personalEmail'] as string) ?? '',
          phone: (e['phone'] as string) ?? '',
          dateOfBirth: (e['dateOfBirth'] as string) ?? '',
          joiningDate: e['joiningDate'] as string,
          employmentType: e['employmentType'] as string,
          workLocation: e['workLocation'] as string,
          departmentId: e.department.id,
          designationId: e.designation.id,
          managerId: e.manager?.id ?? null,
          emergencyContactName: (e['emergencyContactName'] as string) ?? '',
          emergencyContactPhone: (e['emergencyContactPhone'] as string) ?? '',
          addressLine: (e['addressLine'] as string) ?? '',
          city: (e['city'] as string) ?? '',
          state: (e['state'] as string) ?? '',
          postalCode: (e['postalCode'] as string) ?? '',
        });
        this.form.controls.workEmail.disable({ emitEvent: false });
      }
      this.state.set('ready');
    } catch {
      this.state.set('error');
    }
  }

  show(field: string): boolean {
    const c = this.form.get(field);
    return !!c && c.invalid && (c.touched || c.dirty);
  }

  err(field: string): string {
    const c = this.form.get(field);
    const e = c?.errors ?? {};
    if (e['server']) return String(e['server']);
    if (e['required']) return 'This field is required.';
    if (e['email']) return 'Enter a valid email address.';
    if (e['maxlength']) return 'This value is too long.';
    if (e['pattern']) return 'Check the format and try again.';
    return 'Please check this field.';
  }

  async submit() {
    this.form.markAllAsTouched();
    if (this.form.invalid) {
      this.notify.error('Please correct the highlighted fields.');
      return;
    }
    const raw = this.form.getRawValue();
    const clean = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === '' ? undefined : v]));
    this.saving.set(true);
    try {
      if (this.employeeId) {
        const { workEmail: _ignored, employeeCode: _c, createAccount: _a, accountRole: _r, ...editable } = clean;
        await this.api.patch(`/employees/${this.employeeId}`, editable);
        this.notify.success('Employee details saved.');
        await this.router.navigate(['/employees', this.employeeId]);
      } else {
        const created = await this.api.post<{ id: string; employeeCode: string; invited: boolean }>('/employees', clean);
        this.notify.success(
          created.invited
            ? `Employee ${created.employeeCode} created. A welcome link was sent to set the password.`
            : `Employee ${created.employeeCode} created.`,
        );
        await this.router.navigate(['/employees', created.id]);
      }
    } catch (err) {
      if (!applyFieldErrors(this.form, err)) {
        this.notify.error(err instanceof ApiError ? err.message : 'Could not save the employee. Please try again.');
      } else {
        this.notify.error('Please correct the highlighted fields.');
      }
    } finally {
      this.saving.set(false);
    }
  }
}
