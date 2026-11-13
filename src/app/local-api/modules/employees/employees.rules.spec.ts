import { describe, expect, it } from 'vitest';
import { createsReportingCycle, exitStatusFor, nextEmployeeCodeFrom } from './employees.rules';
import { csvCell, toCsv } from '../../lib/csv';

describe('employee codes', () => {
  it('continues after the highest generated code, not after the head count', () => {
    // 3 employees, but EMP-0007 exists (typed by hand): counting would produce EMP-0004 and later collide.
    expect(nextEmployeeCodeFrom(['EMP-0001', 'EMP-0007', 'CONTRACT-12'])).toBe('EMP-0008');
  });

  it('starts at EMP-0001 for an empty organization', () => {
    expect(nextEmployeeCodeFrom([])).toBe('EMP-0001');
  });
});

describe('reporting cycles', () => {
  const managers: Record<string, string | null> = { a: null, b: 'a', c: 'b' };
  const managerOf = (id: string) => managers[id] ?? null;

  it('rejects a manager who already reports to the employee', () => {
    // a <- b <- c: making a report to c closes the loop.
    expect(createsReportingCycle('a', 'c', managerOf)).toBe(true);
  });

  it('allows an ordinary reporting line', () => {
    expect(createsReportingCycle('c', 'a', managerOf)).toBe(false);
    expect(createsReportingCycle('c', null, managerOf)).toBe(false);
  });
});

describe('offboarding status', () => {
  it('keeps the employee on notice through the exit date', () => {
    expect(exitStatusFor('2026-10-31', '2026-10-20')).toBe('ON_NOTICE');
    expect(exitStatusFor('2026-10-20', '2026-10-20')).toBe('ON_NOTICE');
  });

  it('exits the employee once the exit date has passed', () => {
    expect(exitStatusFor('2026-10-19', '2026-10-20')).toBe('EXITED');
  });
});

describe('CSV export cells', () => {
  it('neutralizes values a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe('"\'=HYPERLINK(""http://x"")"');
    expect(csvCell('@SUM(A1)')).toBe('"\'@SUM(A1)"');
  });

  it('keeps numbers and phone numbers as they are', () => {
    expect(csvCell('+91 98100 00000')).toBe('"+91 98100 00000"');
    expect(csvCell('-250.00')).toBe('"-250.00"');
    expect(csvCell(null)).toBe('""');
  });

  it('builds a header and rows', () => {
    expect(toCsv(['A', 'B'], [[1, 'x']])).toBe('"A","B"\n"1","x"');
  });
});
