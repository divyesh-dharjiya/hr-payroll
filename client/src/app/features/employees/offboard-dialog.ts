import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';

export interface OffboardResult {
  exitDate: string;
  reason: string;
}

/** Offboarding is an explicit, confirmed action: it ends active employment and disables sign-in. */
@Component({
  selector: 'ph-offboard-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule],
  template: `
    <h2 mat-dialog-title>Offboard {{ data.name }}?</h2>
    <form [formGroup]="form" (ngSubmit)="confirm()" novalidate>
      <mat-dialog-content>
        <p>This sets the employee to exited, disables their sign-in and revokes active sessions. Payroll and attendance history are kept.</p>
        <mat-form-field appearance="outline">
          <mat-label>Last working day</mat-label>
          <input matInput type="date" formControlName="exitDate" required />
          @if (form.controls.exitDate.invalid && form.controls.exitDate.touched) {
            <mat-error>Choose the last working day.</mat-error>
          }
        </mat-form-field>
        <mat-form-field appearance="outline">
          <mat-label>Reason</mat-label>
          <textarea matInput formControlName="reason" rows="3" required></textarea>
          @if (form.controls.reason.invalid && form.controls.reason.touched) {
            <mat-error>Add a short reason (at least 3 characters).</mat-error>
          }
        </mat-form-field>
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button mat-button type="button" [mat-dialog-close]="null">Cancel</button>
        <button mat-flat-button color="warn" type="submit">Offboard employee</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class OffboardDialog {
  readonly data = inject<{ name: string }>(MAT_DIALOG_DATA);
  private readonly ref = inject<MatDialogRef<OffboardDialog, OffboardResult>>(MatDialogRef);
  private readonly fb = inject(FormBuilder);

  readonly form = this.fb.nonNullable.group({
    exitDate: ['', [Validators.required, Validators.pattern(/^\d{4}-\d{2}-\d{2}$/)]],
    reason: ['', [Validators.required, Validators.minLength(3), Validators.maxLength(300)]],
  });

  confirm() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    this.ref.close(this.form.getRawValue());
  }
}
