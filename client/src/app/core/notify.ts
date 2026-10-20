import { Injectable, inject } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ApiError } from './api';

/**
 * Toasts for user actions. `run` shows a success message only after the request resolves, and shows the server's
 * message on failure. It never reports success for a failed operation.
 */
@Injectable({ providedIn: 'root' })
export class Notify {
  private readonly snack = inject(MatSnackBar);

  success(message: string): void {
    this.snack.open(message, 'Dismiss', { duration: 4000, politeness: 'polite' });
  }

  error(message: string): void {
    this.snack.open(message, 'Dismiss', { duration: 7000, politeness: 'assertive' });
  }

  async run<T>(action: () => Promise<T>, successMessage?: string): Promise<T | undefined> {
    try {
      const result = await action();
      if (successMessage) this.success(successMessage);
      return result;
    } catch (err) {
      this.error(err instanceof ApiError ? err.message : 'Something went wrong. Please try again.');
      return undefined;
    }
  }
}

/** Maps server field errors onto form controls, so messages sit next to the fields they describe. */
export function applyFieldErrors(form: { get(path: string): { setErrors(e: Record<string, unknown> | null): void } | null }, err: unknown): boolean {
  if (!(err instanceof ApiError) || err.fields.length === 0) return false;
  for (const f of err.fields) {
    form.get(f.field)?.setErrors({ server: f.message });
  }
  return true;
}
