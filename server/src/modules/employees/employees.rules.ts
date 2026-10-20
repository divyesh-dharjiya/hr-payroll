// ---------------------------------------------------------------------------------------------------------------
// Employee rules (pure functions, unit-tested in tests/employees.rules.test.ts)
//
//  - Generated employee codes continue after the highest existing EMP-#### number, so codes typed by hand or left
//    behind by exits never collide with the next generated one.
//  - A reporting line may not loop back on itself (A reports to B, B reports to A).
//  - The exit date is the last working day. Offboarding with an exit date of today or later puts the employee on
//    notice; they become EXITED (and lose sign-in) once that day has passed. A past exit date exits them at once.
// ---------------------------------------------------------------------------------------------------------------

const GENERATED_CODE = /^EMP-(\d+)$/i;

/** Next generated code after the highest EMP-#### code in use (EMP-0001 when there is none). */
export function nextEmployeeCodeFrom(existingCodes: Iterable<string>): string {
  let max = 0;
  for (const code of existingCodes) {
    const m = GENERATED_CODE.exec(code);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `EMP-${String(max + 1).padStart(4, '0')}`;
}

/**
 * True when making `employeeId` report to `newManagerId` would create a loop. `managerOf` returns the current
 * manager of an employee (or null). The walk stops after `limit` steps as a guard against existing bad data.
 */
export function createsReportingCycle(
  employeeId: string,
  newManagerId: string | null | undefined,
  managerOf: (id: string) => string | null | undefined,
  limit = 1000,
): boolean {
  let current = newManagerId ?? null;
  for (let i = 0; current && i < limit; i++) {
    if (current === employeeId) return true;
    current = managerOf(current) ?? null;
  }
  return false;
}

export type ExitOutcome = 'EXITED' | 'ON_NOTICE';

/** Status after offboarding: on notice through the exit date, exited once it has passed. */
export function exitStatusFor(exitDate: string, today: string): ExitOutcome {
  return exitDate < today ? 'EXITED' : 'ON_NOTICE';
}
