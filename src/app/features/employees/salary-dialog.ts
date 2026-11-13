import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { formatPaise } from '../../shared/format';
import { toSignal } from '@angular/core/rxjs-interop';

export interface SalaryInput {
  effectiveFrom: string;
  basic: string;
  hra: string;
  conveyance: string;
  special: string;
  otherAllowance: string;
  pfApplicable: boolean;
  esiApplicable: boolean;
  professionalTax: string;
  monthlyTds: string;
}

const AMOUNT = /^\d+(\.\d{1,2})?$/;

/**
 * Salary structure entry. Amounts are rupees with up to two decimals, converted to paise by the API.
 * PF/ESI flags and TDS are explicit inputs: nothing is assumed applicable.
 */
@Component({
  selector: 'ph-salary-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatCheckboxModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Salary revision for {{ data.name }}</h2>
    <form [formGroup]="form" (ngSubmit)="save()" novalidate>
      <mat-dialog-content>
        <p class="muted">Previous structures are kept. Payroll uses the structure effective on or before each period.</p>
        <div class="form-grid">
          <mat-form-field appearance="outline">
            <mat-label>Effective from</mat-label>
            <input matInput type="date" formControlName="effectiveFrom" required />
            @if (form.controls.effectiveFrom.invalid && form.controls.effectiveFrom.touched) {
              <mat-error>Choose the effective date.</mat-error>
            }
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Basic (₹ per month)</mat-label>
            <input matInput inputmode="decimal" formControlName="basic" required />
            @if (form.controls.basic.invalid && form.controls.basic.touched) {
              <mat-error>Enter an amount such as 25000 or 25000.50.</mat-error>
            }
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>HRA (₹)</mat-label>
            <input matInput inputmode="decimal" formControlName="hra" />
            @if (form.controls.hra.invalid && form.controls.hra.touched) { <mat-error>Enter a valid amount.</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Conveyance (₹)</mat-label>
            <input matInput inputmode="decimal" formControlName="conveyance" />
            @if (form.controls.conveyance.invalid && form.controls.conveyance.touched) { <mat-error>Enter a valid amount.</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Special allowance (₹)</mat-label>
            <input matInput inputmode="decimal" formControlName="special" />
            @if (form.controls.special.invalid && form.controls.special.touched) { <mat-error>Enter a valid amount.</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Other allowance (₹)</mat-label>
            <input matInput inputmode="decimal" formControlName="otherAllowance" />
            @if (form.controls.otherAllowance.invalid && form.controls.otherAllowance.touched) { <mat-error>Enter a valid amount.</mat-error> }
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>Professional tax (₹ per month)</mat-label>
            <input matInput inputmode="decimal" formControlName="professionalTax" />
            <mat-hint>Set per state rules. Verify before use.</mat-hint>
          </mat-form-field>
          <mat-form-field appearance="outline">
            <mat-label>TDS (₹ per month)</mat-label>
            <input matInput inputmode="decimal" formControlName="monthlyTds" />
            <mat-hint>From a verified tax computation.</mat-hint>
          </mat-form-field>
        </div>
        <div class="flags">
          <mat-checkbox formControlName="pfApplicable">PF applicable</mat-checkbox>
          <mat-checkbox formControlName="esiApplicable">ESI applicable (only applies within the ESI ceiling)</mat-checkbox>
        </div>
        <p class="total" aria-live="polite">Gross monthly: <strong>{{ gross() }}</strong></p>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button color="primary" type="submit">Save structure</button>
      </mat-dialog-actions>
    </form>
  `,
  styles: [
    `
      .muted { color: var(--ph-text-muted); margin-top: 0; }
      .flags { display: flex; gap: 20px; flex-wrap: wrap; margin: 4px 0 8px; }
      .total { font-size: 15px; }
    `,
  ],
})
export class SalaryDialog {
  readonly data = inject<{ name: string }>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<SalaryDialog, SalaryInput>>(MatDialogRef);
  private readonly fb = inject(FormBuilder);

  readonly form = this.fb.nonNullable.group({
    effectiveFrom: ['', [Validators.required, Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],
    basic: ['', [Validators.required, Validators.pattern(AMOUNT)]],
    hra: ['0', [Validators.pattern(AMOUNT)]],
    conveyance: ['0', [Validators.pattern(AMOUNT)]],
    special: ['0', [Validators.pattern(AMOUNT)]],
    otherAllowance: ['0', [Validators.pattern(AMOUNT)]],
    professionalTax: ['0', [Validators.pattern(AMOUNT)]],
    monthlyTds: ['0', [Validators.pattern(AMOUNT)]],
    pfApplicable: [true],
    esiApplicable: [false],
  });

  private readonly values = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });

  readonly gross = computed(() => {
    const v = this.values();
    const sum = ['basic', 'hra', 'conveyance', 'special', 'otherAllowance'].reduce((s, k) => s + (Number((v as Record<string, unknown>)[k]) || 0), 0);
    return formatPaise(Math.round(sum * 100));
  });

  save() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.ref.close(this.form.getRawValue());
  }
}
