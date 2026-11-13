// Demo data: a fictional company ("Lotus Technologies Pvt Ltd") with realistic-looking but entirely invented data.
// No real personal, bank or tax identifiers are used. Bank and PAN values are synthetic test numbers.
//
// The API seeds this automatically the first time the app opens in a browser, and again from "Reset demo data" on
// the sign-in page. Demo logins (password: DEMO_PASSWORD below):
//   superadmin@lotus-demo.example  - Super Admin
//   hr@lotus-demo.example          - HR Admin
//   manager@lotus-demo.example     - Manager (Engineering)
//   employee@lotus-demo.example    - Employee (Engineering)
import { db } from './index';
import type { AttendanceRecord, AttendanceStatus, OvertimeStatus, Role } from './schema';
import type { Insert } from './table';
import { hashPassword, last4 } from '../lib/crypto';
import { addDays, eachDay, todayIn, weekdayOf, zonedTimeToUtc } from '../lib/time';
import { OVERTIME_MIN_CLAIM_MINUTES, summarizeDay, type AttendanceRules } from '../modules/attendance/attendance.rules';
import { addAdjustment, approveRun, createRun, finalizeRun, markPayment, recalculateRun, validateRun } from '../modules/payroll/payroll.service';
import type { AuthContext } from '../security/session';

export const DEMO_DOMAIN = 'lotus-demo.example';
/** Password of every demo account. The company is fictional and its data never leaves this browser. */
export const DEMO_PASSWORD = 'PeopleHub@2026';
const TIMEZONE = 'Asia/Kolkata';
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n: number) => String(n).padStart(2, '0');

interface RosterEntry {
  code: string;
  first: string;
  last: string;
  dept: 'ENG' | 'HR' | 'SAL' | 'FIN' | 'OPS';
  title: string;
  manager?: string; // employee code
  joining: string;
  exit?: string;
  gross: number; // monthly gross, INR
  role?: Role;
  email?: string;
  esi?: boolean;
  ptRupees?: number;
  tdsRupees?: number;
  revision?: { from: string; gross: number };
}

const DEPARTMENTS = [
  { name: 'Engineering', code: 'ENG' },
  { name: 'Human Resources', code: 'HR' },
  { name: 'Sales', code: 'SAL' },
  { name: 'Finance', code: 'FIN' },
  { name: 'Operations', code: 'OPS' },
];
const DESIGNATIONS = [
  'HR Manager', 'HR Executive', 'Engineering Manager', 'Senior Software Engineer', 'Software Engineer', 'QA Engineer',
  'Sales Manager', 'Sales Executive', 'Accounts Executive', 'Operations Executive',
];

// Deterministic pseudo-random generator so every seed produces the same attendance history.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/**
 * Fills the (empty) database with the demo company. Every date is relative to `now`, so the data never goes stale:
 * about six months of attendance up to today, finalized payroll for earlier months, a draft for last month and
 * pending requests ahead.
 */
export function seedDemoData(now = new Date()): void {
  const TODAY = todayIn(TIMEZONE, now);
  const THIS_YEAR = Number(TODAY.slice(0, 4));
  /** The month `offset` months from the current one: its year, month (1-12) and a date helper for a day in it. */
  const monthAt = (offset: number) => {
    const base = new Date(Date.UTC(Number(TODAY.slice(0, 4)), Number(TODAY.slice(5, 7)) - 1 + offset, 1));
    const year = base.getUTCFullYear();
    const month = base.getUTCMonth() + 1;
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { year, month, day: (d: number) => `${year}-${pad2(month)}-${pad2(Math.min(d, last))}`, last: `${year}-${pad2(month)}-${pad2(last)}` };
  };
  const HISTORY_FROM = monthAt(-5).day(1);

  const ROSTER: RosterEntry[] = [
    { code: 'EMP-0001', first: 'Priya', last: 'Sharma', dept: 'HR', title: 'HR Manager', joining: '2019-06-03', gross: 180000, role: 'HR_ADMIN', email: `hr@${DEMO_DOMAIN}`, ptRupees: 200 },
    { code: 'EMP-0002', first: 'Arjun', last: 'Mehta', dept: 'ENG', title: 'Engineering Manager', joining: '2020-02-17', gross: 240000, role: 'MANAGER', email: `manager@${DEMO_DOMAIN}`, ptRupees: 200, tdsRupees: 8000 },
    { code: 'EMP-0003', first: 'Kavya', last: 'Nair', dept: 'SAL', title: 'Sales Manager', joining: '2021-01-11', gross: 150000, ptRupees: 200, tdsRupees: 2500 },
    { code: 'EMP-0004', first: 'Rohan', last: 'Verma', dept: 'HR', title: 'HR Executive', manager: 'EMP-0001', joining: '2022-07-04', gross: 45000, esi: false, ptRupees: 200 },
    { code: 'EMP-0005', first: 'Ananya', last: 'Iyer', dept: 'ENG', title: 'Senior Software Engineer', manager: 'EMP-0002', joining: '2021-09-20', gross: 150000, ptRupees: 200, tdsRupees: 2500, revision: { from: monthAt(-3).day(1), gross: 165000 } },
    { code: 'EMP-0006', first: 'Vikram', last: 'Singh', dept: 'ENG', title: 'Software Engineer', manager: 'EMP-0002', joining: '2023-03-06', gross: 95000, email: `employee@${DEMO_DOMAIN}`, ptRupees: 200, revision: { from: monthAt(-3).day(1), gross: 105000 } },
    { code: 'EMP-0007', first: 'Sneha', last: 'Patil', dept: 'ENG', title: 'Software Engineer', manager: 'EMP-0002', joining: '2023-08-14', gross: 85000, ptRupees: 200 },
    { code: 'EMP-0008', first: 'Karthik', last: 'Reddy', dept: 'ENG', title: 'Software Engineer', manager: 'EMP-0002', joining: '2024-01-22', gross: 70000 },
    { code: 'EMP-0009', first: 'Meera', last: 'Joshi', dept: 'ENG', title: 'QA Engineer', manager: 'EMP-0002', joining: '2024-04-01', gross: 65000 },
    { code: 'EMP-0010', first: 'Aditya', last: 'Kulkarni', dept: 'ENG', title: 'Senior Software Engineer', manager: 'EMP-0002', joining: '2022-11-09', gross: 140000, ptRupees: 200 },
    { code: 'EMP-0011', first: 'Ishaan', last: 'Gupta', dept: 'ENG', title: 'Software Engineer', manager: 'EMP-0002', joining: '2025-02-10', gross: 72000 },
    { code: 'EMP-0012', first: 'Dev', last: 'Malhotra', dept: 'SAL', title: 'Sales Executive', manager: 'EMP-0003', joining: '2024-06-17', gross: 48000 },
    { code: 'EMP-0013', first: 'Riya', last: 'Chopra', dept: 'SAL', title: 'Sales Executive', manager: 'EMP-0003', joining: '2024-10-01', gross: 52000 },
    { code: 'EMP-0014', first: 'Sameer', last: 'Khan', dept: 'SAL', title: 'Sales Executive', manager: 'EMP-0003', joining: '2025-05-12', gross: 50000 },
    { code: 'EMP-0015', first: 'Neha', last: 'Agarwal', dept: 'SAL', title: 'Sales Executive', manager: 'EMP-0003', joining: '2025-09-01', gross: 50000 },
    { code: 'EMP-0016', first: 'Tanmay', last: 'Desai', dept: 'FIN', title: 'Accounts Executive', joining: '2020-10-05', gross: 78000, ptRupees: 200 },
    { code: 'EMP-0017', first: 'Pooja', last: 'Rao', dept: 'FIN', title: 'Accounts Executive', manager: 'EMP-0016', joining: '2023-05-02', gross: 60000 },
    { code: 'EMP-0018', first: 'Nikhil', last: 'Bose', dept: 'OPS', title: 'Operations Executive', joining: '2022-03-21', gross: 19500, esi: true },
    { code: 'EMP-0019', first: 'Fatima', last: 'Sheikh', dept: 'OPS', title: 'Operations Executive', manager: 'EMP-0018', joining: '2024-08-19', gross: 18500, esi: true },
    { code: 'EMP-0020', first: 'Rahul', last: 'Pandey', dept: 'ENG', title: 'Software Engineer', manager: 'EMP-0002', joining: '2023-10-16', exit: monthAt(-3).last, gross: 88000 },
    { code: 'EMP-0021', first: 'Ritu', last: 'Saxena', dept: 'OPS', title: 'Operations Executive', manager: 'EMP-0018', joining: monthAt(-1).day(14), gross: 40000 },
    { code: 'EMP-0022', first: 'Gaurav', last: 'Bhatia', dept: 'SAL', title: 'Sales Executive', manager: 'EMP-0003', joining: monthAt(-8).day(2), gross: 46000 },
  ];

  // National holidays on fixed dates, for last year, this year and next year.
  const HOLIDAYS: [string, string][] = [THIS_YEAR - 1, THIS_YEAR, THIS_YEAR + 1].flatMap((y): [string, string][] => [
    [`${y}-01-26`, 'Republic Day'],
    [`${y}-05-01`, 'Labour Day'],
    [`${y}-08-15`, 'Independence Day'],
    [`${y}-10-02`, 'Gandhi Jayanti'],
    [`${y}-12-25`, 'Christmas Day'],
  ]);
  const HOLIDAY_SET = new Set(HOLIDAYS.map(([d]) => d));
  const isWorkingDay = (ymd: string) => weekdayOf(ymd) !== 0 && !HOLIDAY_SET.has(ymd);
  /** The given day, or the next working day after it. */
  const workingDayFrom = (ymd: string) => {
    let d = ymd;
    while (!isWorkingDay(d)) d = addDays(d, 1);
    return d;
  };
  /** The given day, or the last working day before it. */
  const workingDayBefore = (ymd: string) => {
    let d = ymd;
    while (!isWorkingDay(d)) d = addDays(d, -1);
    return d;
  };

  const org = db.organizations.insert({
    name: 'Lotus Technologies Pvt Ltd',
    legalName: 'Lotus Technologies Private Limited (fictional)',
    timezone: TIMEZONE,
    currency: 'INR',
    weeklyOffDays: [0],
    financialYearStartMonth: 4,
    shiftStart: '09:30',
    shiftEnd: '18:30',
    graceMinutes: 10,
    standardBreakMinutes: 60,
    breakDeductionAfterMinutes: 360,
    pfEmployeeRateBps: 1200,
    pfEmployerRateBps: 1200,
    pfWageCeilingPaise: 1_500_000,
    esiEmployeeRateBps: 75,
    esiEmployerRateBps: 325,
    esiGrossCeilingPaise: 2_100_000,
    // Approved overtime is paid at 1.5x. Only minutes a manager or HR approved reach payroll.
    overtimeMultiplierBps: 15000,
  });
  const orgId = org.id;
  const rules: AttendanceRules = {
    timezone: org.timezone,
    shiftStart: org.shiftStart,
    shiftEnd: org.shiftEnd,
    graceMinutes: org.graceMinutes,
    standardBreakMinutes: org.standardBreakMinutes,
    breakDeductionAfterMinutes: org.breakDeductionAfterMinutes,
  };

  const deptIds = new Map(DEPARTMENTS.map((d) => [d.code, db.departments.insert({ organizationId: orgId, name: d.name, code: d.code }).id]));
  const desigIds = new Map(DESIGNATIONS.map((title) => [title, db.designations.insert({ organizationId: orgId, title }).id]));

  // Employees (managers first so reporting lines can reference them).
  const empIds = new Map<string, string>();
  ROSTER.forEach((r, index) => {
    const n = Number(r.code.slice(-2));
    const account = `9000${String(100000 + index * 97)}`;
    const pan = `ZZZZZ${String(1000 + index).slice(-4)}Z`;
    const emp = db.employees.insert({
      organizationId: orgId,
      employeeCode: r.code,
      firstName: r.first,
      lastName: r.last,
      workEmail: r.email ?? `${r.first.toLowerCase()}.${r.last.toLowerCase()}@${DEMO_DOMAIN}`,
      personalEmail: `${r.first.toLowerCase()}.personal@example.org`,
      phone: `+91 98${String(10000000 + n * 7919).slice(0, 8)}`,
      dateOfBirth: `${1985 + (n % 15)}-0${1 + (n % 9)}-1${Number(r.code.slice(-1)) % 9}`,
      joiningDate: r.joining,
      exitDate: r.exit ?? null,
      status: r.exit ? 'EXITED' : 'ACTIVE',
      onboardingStatus: 'COMPLETE',
      employmentType: r.code === 'EMP-0022' ? 'CONTRACT' : 'FULL_TIME',
      workLocation: r.dept === 'OPS' ? 'Pune Plant' : 'Head Office, Bengaluru',
      departmentId: deptIds.get(r.dept)!,
      designationId: desigIds.get(r.title)!,
      managerId: r.manager ? (empIds.get(r.manager) ?? null) : null,
      emergencyContactName: `${r.first} (family contact)`,
      emergencyContactPhone: '+91 90000 00000',
      addressLine: '42 Demo Residency, Sample Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560001',
      bankAccountNumber: account,
      bankAccountLast4: last4(account),
      bankIfsc: 'DEMO0001234',
      bankName: 'Demo Bank (synthetic)',
      panNumber: pan,
      panLast4: last4(pan),
    });
    empIds.set(r.code, emp.id);
  });

  // Sign-in accounts. All demo accounts share one hash of the demo password.
  const passwordHash = hashPassword(DEMO_PASSWORD);
  type DemoUser = { id: string; role: Role; email: string; name: string; employeeId: string | null };
  const users = new Map<string, DemoUser>();
  const addUser = (key: string, data: { email: string; name: string; role: Role; employeeId: string | null; isActive?: boolean }) => {
    const u = db.users.insert({ organizationId: orgId, passwordHash, ...data });
    users.set(key, { id: u.id, role: u.role, email: u.email, name: u.name, employeeId: u.employeeId });
  };
  addUser('super', { email: `superadmin@${DEMO_DOMAIN}`, name: 'Super Admin (Demo)', role: 'SUPER_ADMIN', employeeId: null });
  for (const r of ROSTER.filter((x) => x.role)) {
    addUser(r.code, { email: r.email!, name: `${r.first} ${r.last}`, role: r.role!, employeeId: empIds.get(r.code)!, isActive: !r.exit });
  }
  const vikram = ROSTER.find((r) => r.code === 'EMP-0006')!;
  addUser(vikram.code, { email: vikram.email!, name: `${vikram.first} ${vikram.last}`, role: 'EMPLOYEE', employeeId: empIds.get(vikram.code)! });

  // Salary structures: an initial assignment at joining (or a year back), plus revisions for some employees.
  const salaryFloor = monthAt(-12).day(1);
  for (const r of ROSTER) {
    const createSalary = (effectiveFrom: string, gross: number) => {
      const basic = Math.round(gross * 0.4);
      const hra = Math.round(basic * 0.5);
      const conveyance = 1600;
      const special = gross - basic - hra - conveyance;
      db.salaryAssignments.insert({
        organizationId: orgId,
        employeeId: empIds.get(r.code)!,
        effectiveFrom,
        basicPaise: basic * 100,
        hraPaise: hra * 100,
        conveyancePaise: conveyance * 100,
        specialPaise: special * 100,
        pfApplicable: true,
        // ESI applies only when flagged AND the gross is within the ceiling (the engine enforces the ceiling).
        esiApplicable: Boolean(r.esi),
        professionalTaxPaise: (r.ptRupees ?? 0) * 100,
        monthlyTdsPaise: (r.tdsRupees ?? 0) * 100,
      });
    };
    createSalary(r.joining < salaryFloor ? salaryFloor : r.joining, r.gross);
    if (r.revision) createSalary(r.revision.from, r.revision.gross);
  }

  for (const [holidayDate, name] of HOLIDAYS) db.holidays.insert({ organizationId: orgId, holidayDate, name });

  const leaveTypes = {
    CL: db.leaveTypes.insert({ organizationId: orgId, code: 'CL', name: 'Casual Leave', isPaid: true, annualQuotaDays: 8, accrual: 'UPFRONT', allowHalfDay: true, carryForwardDays: 0 }),
    SL: db.leaveTypes.insert({ organizationId: orgId, code: 'SL', name: 'Sick Leave', isPaid: true, annualQuotaDays: 6, accrual: 'UPFRONT', allowHalfDay: true, carryForwardDays: 0 }),
    EL: db.leaveTypes.insert({ organizationId: orgId, code: 'EL', name: 'Earned / Privilege Leave', isPaid: true, annualQuotaDays: 15, accrual: 'MONTHLY', allowHalfDay: true, carryForwardDays: 5 }),
    LWP: db.leaveTypes.insert({ organizationId: orgId, code: 'LWP', name: 'Leave Without Pay', isPaid: false, annualQuotaDays: 0, accrual: 'UPFRONT', allowHalfDay: true, carryForwardDays: 0 }),
  };

  // Leave requests (historical and pending). Approved leave is excluded from attendance generation below.
  const span = (start: string, workingDays: number) => {
    const from = workingDayFrom(start);
    let to = from;
    for (let i = 1; i < workingDays; i++) to = workingDayFrom(addDays(to, 1));
    return { from, to };
  };
  const recentLeave = span(addDays(TODAY, -16), 3);
  const approvedLeaves: { emp: string; from: string; to: string; type: keyof typeof leaveTypes; half?: boolean }[] = [
    { emp: 'EMP-0006', ...span(monthAt(-2).day(7), 2), type: 'CL' },
    { emp: 'EMP-0007', ...span(monthAt(-3).day(18), 1), type: 'SL' },
    { emp: 'EMP-0008', from: recentLeave.from, to: recentLeave.to < TODAY ? recentLeave.to : workingDayBefore(addDays(TODAY, -1)), type: 'EL' },
    { emp: 'EMP-0012', ...span(monthAt(-3).day(24), 1), type: 'CL', half: true },
  ];
  const leaveDaysFor = (from: string, to: string, half?: boolean) => (half ? 0.5 : eachDay(from, to).filter(isWorkingDay).length);
  const decidedBefore = (ymd: string) => new Date(Date.parse(`${addDays(ymd, -5)}T10:00:00Z`)).toISOString();
  const arjunUserId = users.get('EMP-0002')?.id ?? null;
  for (const l of approvedLeaves) {
    db.leaveRequests.insert({
      organizationId: orgId,
      employeeId: empIds.get(l.emp)!,
      leaveTypeId: leaveTypes[l.type].id,
      startDate: l.from,
      endDate: l.to,
      isHalfDay: Boolean(l.half),
      days: leaveDaysFor(l.from, l.to, l.half),
      reason: 'Planned personal commitment (demo data).',
      status: 'APPROVED',
      deciderId: arjunUserId,
      decisionComment: 'Approved. Enjoy the break.',
      decidedAt: decidedBefore(l.from),
    });
  }
  const rejected = span(monthAt(-1).day(21), 2);
  db.leaveRequests.insert({
    organizationId: orgId,
    employeeId: empIds.get('EMP-0011')!,
    leaveTypeId: leaveTypes.LWP.id,
    startDate: rejected.from,
    endDate: rejected.to,
    days: leaveDaysFor(rejected.from, rejected.to),
    reason: 'Family travel not covered by balances.',
    status: 'REJECTED',
    deciderId: arjunUserId,
    decisionComment: 'Please coordinate with the sprint lead before unpaid leave.',
    decidedAt: decidedBefore(rejected.from),
  });
  // Pending requests that managers can act on during the demo.
  const pendingAnanya = span(addDays(TODAY, 6), 2);
  const pendingDev = workingDayFrom(addDays(TODAY, 2));
  db.leaveRequests.insert({
    organizationId: orgId,
    employeeId: empIds.get('EMP-0005')!,
    leaveTypeId: leaveTypes.CL.id,
    startDate: pendingAnanya.from,
    endDate: pendingAnanya.to,
    days: leaveDaysFor(pendingAnanya.from, pendingAnanya.to),
    reason: 'Family function in Chennai.',
  });
  db.leaveRequests.insert({
    organizationId: orgId,
    employeeId: empIds.get('EMP-0012')!,
    leaveTypeId: leaveTypes.CL.id,
    startDate: pendingDev,
    endDate: pendingDev,
    isHalfDay: true,
    days: 0.5,
    reason: 'Afternoon dental appointment.',
  });

  // Approved leave ranges used to exclude days from generated attendance.
  const leaveDays = new Map<string, Set<string>>();
  for (const l of approvedLeaves) {
    const set = leaveDays.get(l.emp) ?? new Set<string>();
    eachDay(l.from, l.to).forEach((d) => set.add(d));
    leaveDays.set(l.emp, set);
  }

  // Attendance history: about six months up to today, as punch sessions. Today's sessions run up to the current time
  // (later sessions are left out, a session still in progress stays open). The demo employee has no punches today
  // so the demo can punch in live.
  // A typical day: morning session, lunch break, afternoon session, sometimes a short tea break in between.
  // Day totals are computed with the same summarizeDay() rules the app uses.
  const nowMinutes = (() => {
    const [h, m] = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now).split(':').map(Number);
    return h * 60 + m;
  })();
  const at = (day: string, minutesOfDay: number) => zonedTimeToUtc(day, `${pad2(Math.floor(minutesOfDay / 60))}:${pad2(minutesOfDay % 60)}`, TIMEZONE);
  const atIst = (ymd: string, hhmm: string) => zonedTimeToUtc(ymd, hhmm, TIMEZONE).toISOString();

  // Overtime claims: older days were already reviewed (most approved, a few rejected); the last few working days
  // are waiting for a decision so the approval queue has something to show.
  const reviewCutoff = workingDayBefore(addDays(TODAY, -4));
  const overtimeReview = (day: string, minutes: number, roll: number): Pick<AttendanceRecord, 'overtimeStatus' | 'overtimeApprovedMinutes' | 'overtimeReviewedAt' | 'overtimeComment'> => {
    const none = { overtimeApprovedMinutes: 0, overtimeReviewedAt: null, overtimeComment: null };
    if (minutes < OVERTIME_MIN_CLAIM_MINUTES) return { overtimeStatus: 'NONE', ...none };
    if (day > reviewCutoff) return { overtimeStatus: 'PENDING', ...none };
    const reviewedAt = atIst(addDays(day, 2), '10:00');
    if (roll < 0.1) {
      return { overtimeStatus: 'REJECTED' as OvertimeStatus, overtimeApprovedMinutes: 0, overtimeReviewedAt: reviewedAt, overtimeComment: 'Not agreed in advance with the team lead.' };
    }
    return { overtimeStatus: 'APPROVED', overtimeApprovedMinutes: minutes, overtimeReviewedAt: reviewedAt, overtimeComment: null };
  };

  let recordCount = 0;
  let punchCount = 0;
  for (const r of ROSTER) {
    const employeeId = empIds.get(r.code)!;
    const rand = rng(Number(r.code.slice(-4)) * 7919 + 13);
    for (const day of eachDay(HISTORY_FROM, TODAY)) {
      if (day < r.joining || (r.exit && day > r.exit)) continue;
      if (!isWorkingDay(day)) continue;
      if (leaveDays.get(r.code)?.has(day)) continue;
      const isToday = day === TODAY;
      if (isToday && r.code === 'EMP-0006') continue; // the demo employee punches in live
      const roll = rand();
      if (roll < 0.05) continue; // absent: no record, inferred as ABSENT

      const start = 9 * 60 + 30 + (roll < 0.15 ? 10 + Math.floor(rand() * 40) : Math.floor(rand() * 25) - 15);
      let sessions: [number, number | null][] = [];
      if (roll > 0.97) {
        sessions.push([start, 13 * 60]); // half day: leaves at lunch
      } else {
        const lunchOut = 13 * 60 + Math.floor(rand() * 20);
        const lunchIn = lunchOut + 30 + Math.floor(rand() * 30);
        // Most days end around shift end; about one in five runs an hour or more late (overtime to approve).
        const end = 18 * 60 + 30 + (rand() < 0.2 ? 55 + Math.floor(rand() * 60) : Math.floor(rand() * 25));
        sessions.push([start, lunchOut]);
        if (rand() < 0.35) {
          const teaOut = 16 * 60 + Math.floor(rand() * 20);
          sessions.push([lunchIn, teaOut], [teaOut + 10 + Math.floor(rand() * 10), end]);
        } else {
          sessions.push([lunchIn, end]);
        }
      }
      if (isToday) {
        // Only what has happened so far today: later sessions are dropped, the current one stays open.
        sessions = sessions
          .filter(([a]) => a <= nowMinutes)
          .map(([a, b]): [number, number | null] => [a, b !== null && b <= nowMinutes ? b : null]);
        if (!sessions.length) continue;
      }
      const dayPunches = sessions.map(([a, b]) => ({ inAt: at(day, a), outAt: b === null ? null : at(day, b) }));
      const s = summarizeDay(dayPunches, day, rules);
      const status: AttendanceStatus = s.isHalfDay ? 'HALF_DAY' : roll > 0.9 && roll < 0.97 ? 'WFH' : s.status;
      const record: Insert<AttendanceRecord, never> = {
        organizationId: orgId,
        employeeId,
        workDate: day,
        status,
        checkInAt: s.firstInAt?.toISOString() ?? null,
        checkOutAt: s.lastOutAt?.toISOString() ?? null,
        breakMinutes: s.breakMinutes,
        workedMinutes: s.workedMinutes,
        lateMinutes: s.lateMinutes,
        overtimeMinutes: s.overtimeMinutes,
        overtimeReviewerId: null,
        note: null,
        ...overtimeReview(day, s.overtimeMinutes, rand()),
      };
      const recordId = db.attendanceRecords.insert(record).id;
      recordCount++;
      for (const p of dayPunches) {
        db.attendancePunches.insert({ organizationId: orgId, employeeId, attendanceRecordId: recordId, inAt: p.inAt.toISOString(), outAt: p.outAt?.toISOString() ?? null });
        punchCount++;
      }
    }
  }

  // Announcements
  const lastHoliday = [...HOLIDAYS].reverse().find(([d]) => d < TODAY)!;
  const nextHoliday = HOLIDAYS.find(([d]) => d > TODAY)!;
  const fmtDay = (ymd: string) => `${Number(ymd.slice(8, 10))} ${MONTH_NAMES[Number(ymd.slice(5, 7)) - 1]}`;
  const author = users.get('EMP-0001')?.id ?? users.get('super')!.id;
  db.announcements.insert({
    organizationId: orgId,
    title: `Office closed on ${fmtDay(lastHoliday[0])}`,
    body: `The office remains closed for ${lastHoliday[1]}. Plan deliveries accordingly.`,
    publishAt: atIst(addDays(lastHoliday[0], -7), '10:00'),
    expiresAt: atIst(addDays(lastHoliday[0], 1), '00:00'),
    createdById: author,
  });
  db.announcements.insert({
    organizationId: orgId,
    title: `${nextHoliday[1]} on ${fmtDay(nextHoliday[0])}`,
    body: `The office is closed for ${nextHoliday[1]}. Payroll and leave approvals move to the next working day.`,
    publishAt: atIst(addDays(TODAY, -3), '09:00'),
    createdById: author,
  });
  db.announcements.insert({
    organizationId: orgId,
    title: 'Performance review window opens',
    body: 'Self-assessments open this month. HR will share the calendar with managers.',
    publishAt: atIst(addDays(TODAY, -12), '09:00'),
    audienceRole: 'MANAGER',
    createdById: author,
  });
  db.announcements.insert({
    organizationId: orgId,
    title: 'Engineering all-hands on Friday',
    body: 'Demo sprint and roadmap review at 4 PM in the main hall.',
    publishAt: atIst(addDays(TODAY, -5), '09:00'),
    departmentId: deptIds.get('ENG')!,
    createdById: author,
  });

  // Payroll history, run through the real workflow (create -> validate -> approve -> finalize) for the three months
  // before last month, and a draft for last month. Actors are HR (creator) and Super Admin (approver).
  const ctx = (u: DemoUser): AuthContext => ({ userId: u.id, organizationId: orgId, role: u.role, email: u.email, name: u.name, employeeId: u.employeeId });
  const hrCtx = ctx(users.get('EMP-0001')!);
  const superCtx = ctx(users.get('super')!);

  const bonusMonth = monthAt(-2);
  addAdjustment(hrCtx, { employeeId: empIds.get('EMP-0005')!, year: bonusMonth.year, month: bonusMonth.month, kind: 'EARNING', label: 'Performance bonus (quarterly)', amountPaise: 1_500_000 });
  addAdjustment(hrCtx, { employeeId: empIds.get('EMP-0013')!, year: bonusMonth.year, month: bonusMonth.month, kind: 'DEDUCTION', label: 'Canteen recovery', amountPaise: 50_000 });

  for (const offset of [-4, -3, -2]) {
    const m = monthAt(offset);
    const run = createRun(hrCtx, m.year, m.month);
    validateRun(hrCtx, run.id);
    approveRun(superCtx, run.id);
    finalizeRun(superCtx, run.id);
    // Older months are fully paid; the latest finalized month is half paid so recording a payment can be demoed.
    db.payrollEntries
      .by('payrollRunId', run.id)
      .sort((a, b) => a.id.localeCompare(b.id))
      .forEach((e, i) => {
        if (offset < -2 || i % 2 === 0) markPayment(superCtx, e.id, `UTR${m.year}${pad2(m.month)}${100000 + i * 17}`);
      });
  }
  // Notifications from older runs are already read; only the latest payslip is new.
  const readAt = now.toISOString();
  db.notifications.updateWhere((n) => n.kind === 'payroll.payslip_ready' || n.kind === 'payroll.validated', { readAt });
  db.notifications.updateWhere((n) => n.kind === 'payroll.payslip_ready' && n.body.includes(`${bonusMonth.month}/${bonusMonth.year}`), { readAt: null });

  const draftMonth = monthAt(-1);
  const draft = createRun(hrCtx, draftMonth.year, draftMonth.month);
  recalculateRun(hrCtx, draft.id);

  // Sample in-app notifications for the demo inboxes. Finalizing the runs above already sent "payslip ready" ones.
  const vikramLeave = approvedLeaves[0];
  const notes = [
    { userId: users.get('EMP-0002')!.id, kind: 'leave.requested', title: 'Leave request to review', body: `Ananya Iyer requested 2 day(s) of Casual Leave from ${pendingAnanya.from}.`, link: '/leave', readAt: null },
    { userId: hrCtx.userId, kind: 'leave.requested', title: 'Leave request to review', body: `Dev Malhotra requested a half day of Casual Leave on ${pendingDev}.`, link: '/leave', readAt: null },
    { userId: hrCtx.userId, kind: 'payroll.draft', title: `${MONTH_NAMES[draftMonth.month - 1]} payroll is in draft`, body: 'Review the draft, then validate it so another approver can approve it.', link: `/payroll/${draft.id}`, readAt: null },
    { userId: users.get('EMP-0006')!.id, kind: 'leave.approved', title: 'Leave approved', body: `Your Casual Leave from ${vikramLeave.from} was approved by Arjun Mehta.`, link: '/leave', readAt: decidedBefore(vikramLeave.from) },
  ];
  for (const n of notes) db.notifications.insert({ organizationId: orgId, ...n });

  // The payroll workflow above wrote audit entries as HR and Super Admin; they stay as realistic history.
  console.info(`[PeopleHub] demo data ready: ${ROSTER.length} employees, ${recordCount} attendance days, ${punchCount} punches.`);
}
