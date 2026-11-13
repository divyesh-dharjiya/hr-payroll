/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeAll, describe, expect, it } from 'vitest';
import { LocalApi } from './index';
import { db } from './db';
import { MemoryStore } from './db/storage';
import { DEMO_DOMAIN, DEMO_PASSWORD } from './db/seed';
import { sha256, hashPassword, verifyPassword } from './lib/crypto';
import { todayIn } from './lib/time';

// Integration tests: the real API, seeded with the demo company, in memory. They cover authentication, role and
// record scope, restricted data, payslip ownership, separation of duties and validation, as the server tests did.

const store = new MemoryStore();
const api = new LocalApi(store);

async function login(email: string, password = DEMO_PASSWORD): Promise<string> {
  const res = await api.handle({ method: 'POST', url: '/api/auth/login', body: { email, password }, session: null });
  if (res.status !== 200 || !res.session) throw new Error(`login failed for ${email}: ${res.status}`);
  return res.session;
}

async function call(session: string | null, method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await api.handle({ method, url, body, session });
  return { status: res.status, json: res.body };
}

let hr: string;
let superAdmin: string;
let manager: string;
let employee: string;
let vikramId: string;
let arjunId: string;
let hrEmployeeId: string;
let vikramPayslip: string;

const finalizedEntryOf = (employeeId: string) =>
  db.payrollEntries.by('employeeId', employeeId).find((e) => db.payrollRuns.get(e.payrollRunId)?.status === 'FINALIZED')!.id;

beforeAll(async () => {
  hr = await login(`hr@${DEMO_DOMAIN}`);
  superAdmin = await login(`superadmin@${DEMO_DOMAIN}`);
  manager = await login(`manager@${DEMO_DOMAIN}`);
  employee = await login(`employee@${DEMO_DOMAIN}`);
  vikramId = db.employees.find((e) => e.workEmail === `employee@${DEMO_DOMAIN}`)!.id;
  arjunId = db.employees.find((e) => e.workEmail === `manager@${DEMO_DOMAIN}`)!.id;
  hrEmployeeId = db.employees.find((e) => e.workEmail === `hr@${DEMO_DOMAIN}`)!.id;
  vikramPayslip = finalizedEntryOf(vikramId);
});

describe('demo data', () => {
  it('seeds the fictional company with history, payroll and pending work', () => {
    expect(db.employees.size).toBe(22);
    expect(db.attendanceRecords.size).toBeGreaterThan(1500);
    expect(db.payrollRuns.all().map((r) => r.status).sort()).toEqual(['DRAFT', 'FINALIZED', 'FINALIZED', 'FINALIZED']);
    expect(db.leaveRequests.count((l) => l.status === 'PENDING')).toBe(2);
  });

  it('lists the four demo accounts with the demo password', async () => {
    const res = await call(null, 'GET', '/api/auth/demo-accounts');
    expect(res.status).toBe(200);
    expect(res.json.password).toBe(DEMO_PASSWORD);
    expect(res.json.accounts.map((a: { role: string }) => a.role)).toEqual(['SUPER_ADMIN', 'HR_ADMIN', 'MANAGER', 'EMPLOYEE']);
  });

  it('saves to storage and loads the same data in a new API instance (a new tab)', async () => {
    const saved = await store.read();
    expect(saved?.tables['employees']).toHaveLength(22);
    const tab2 = new LocalApi(store);
    const res = await tab2.handle({ method: 'GET', url: '/api/auth/session', session: employee });
    expect(res.body).toMatchObject({ user: { email: `employee@${DEMO_DOMAIN}` } });
  });
});

describe('authentication', () => {
  it('rejects requests without a session', async () => {
    const res = await call(null, 'GET', '/api/dashboard');
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the same generic message for a wrong password and an unknown account', async () => {
    const wrong = await call(null, 'POST', '/api/auth/login', { email: `hr@${DEMO_DOMAIN}`, password: 'not-the-password-1' });
    const unknown = await call(null, 'POST', '/api/auth/login', { email: `nobody@${DEMO_DOMAIN}`, password: 'not-the-password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error.message).toBe(unknown.json.error.message);
  });

  it('counts failed sign-ins even though the request fails', async () => {
    const before = db.users.find((u) => u.email === `superadmin@${DEMO_DOMAIN}`)!.failedLoginCount;
    await call(null, 'POST', '/api/auth/login', { email: `superadmin@${DEMO_DOMAIN}`, password: 'wrong-password-123' });
    expect(db.users.find((u) => u.email === `superadmin@${DEMO_DOMAIN}`)!.failedLoginCount).toBe(before + 1);
  });

  it('never returns the password hash in the session response', async () => {
    const res = await call(hr, 'GET', '/api/auth/me');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).not.toMatch(/passwordHash|tokenVersion/);
  });

  it('answers the session probe with user null when signed out, without a 401', async () => {
    const res = await call(null, 'GET', '/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ user: null });
    const signedIn = await call(employee, 'GET', '/api/auth/session');
    expect(signedIn.json.user.email).toBe(`employee@${DEMO_DOMAIN}`);
  });

  it('revokes the session on sign-out', async () => {
    const session = await login(`hr@${DEMO_DOMAIN}`);
    expect((await call(session, 'POST', '/api/auth/logout')).status).toBe(204);
    expect((await call(session, 'GET', '/api/auth/me')).status).toBe(401);
    hr = await login(`hr@${DEMO_DOMAIN}`);
  });
});

describe('role-based authorization', () => {
  it('blocks employees from the company-wide directory', async () => {
    expect((await call(employee, 'GET', '/api/employees/')).status).toBe(403);
  });

  it('scopes managers to their direct reports', async () => {
    const team = await call(manager, 'GET', '/api/employees/?pageSize=100');
    expect(team.status).toBe(200);
    const ids = team.json.items.map((e: { id: string }) => e.id);
    expect(ids).toContain(vikramId);
    expect(ids).not.toContain(hrEmployeeId);
    expect(ids).not.toContain(arjunId);
    // Direct lookup of a non-report returns 404, not 403, so existence is not leaked.
    expect((await call(manager, 'GET', `/api/employees/${hrEmployeeId}`)).status).toBe(404);
  });

  it('lets employees read only their own profile', async () => {
    expect((await call(employee, 'GET', `/api/employees/${vikramId}`)).status).toBe(200);
    expect((await call(employee, 'GET', `/api/employees/${arjunId}`)).status).toBe(404);
  });

  it('keeps restricted bank and PAN data away from managers and employees', async () => {
    expect((await call(manager, 'GET', `/api/employees/${vikramId}/sensitive`)).status).toBe(403);
    expect((await call(employee, 'GET', `/api/employees/${vikramId}/sensitive`)).status).toBe(403);
  });

  it('returns only masked bank and PAN values in the profile, and audits a reveal', async () => {
    const res = await call(hr, 'GET', `/api/employees/${vikramId}`);
    expect(res.json.bankAccount).toMatch(/^•••• \d{4}$/);
    expect(res.json.pan).toMatch(/^•+[A-Z0-9]{4}$/);
    expect(JSON.stringify(res.json)).not.toMatch(/bankAccountNumber|panNumber/);
    const audits = db.auditLogs.count((a) => a.action === 'employee.sensitive_viewed');
    const reveal = await call(hr, 'GET', `/api/employees/${vikramId}/sensitive`);
    expect(reveal.json.bankAccount).toMatch(/^\d{6,18}$/);
    expect(db.auditLogs.count((a) => a.action === 'employee.sensitive_viewed')).toBe(audits + 1);
  });

  it('does not let employees open a payslip that belongs to someone else', async () => {
    expect((await call(employee, 'GET', `/api/payroll/payslips/${vikramPayslip}`)).status).toBe(200);
    expect((await call(employee, 'GET', `/api/payroll/payslips/${finalizedEntryOf(hrEmployeeId)}`)).status).toBe(404);
  });

  it('blocks managers from payroll administration', async () => {
    expect((await call(manager, 'GET', '/api/payroll/runs')).status).toBe(403);
    expect((await call(manager, 'POST', '/api/payroll/runs/none/approve')).status).toBe(403);
  });

  it('does not let employees review overtime', async () => {
    expect((await call(employee, 'POST', '/api/attendance/overtime/review', { ids: ['x'], decision: 'APPROVE' })).status).toBe(403);
  });

  it('limits managers to overtime of their direct reports', async () => {
    const outside = db.attendanceRecords.find((r) => r.overtimeStatus !== 'NONE' && db.employees.get(r.employeeId)?.managerId !== arjunId);
    expect(outside).toBeDefined();
    expect((await call(manager, 'POST', '/api/attendance/overtime/review', { ids: [outside!.id], decision: 'APPROVE' })).status).toBe(404);
    const list = await call(manager, 'GET', '/api/attendance/overtime');
    expect(list.json.items.every((i: { employee: { id: string } }) => i.employee.id !== outside!.employeeId)).toBe(true);
  });
});

describe('a manager is also an employee', () => {
  it('lets a manager open their own calendar, leave balances, profile and payslip', async () => {
    const now = new Date();
    expect((await call(manager, 'GET', `/api/attendance/calendar?employeeId=${arjunId}&year=${now.getFullYear()}&month=${now.getMonth() + 1}`)).status).toBe(200);
    expect((await call(manager, 'GET', `/api/leave/balances?employeeId=${arjunId}`)).status).toBe(200);
    expect((await call(manager, 'GET', `/api/employees/${arjunId}`)).status).toBe(200);
    expect((await call(manager, 'GET', `/api/payroll/payslips/${finalizedEntryOf(arjunId)}`)).status).toBe(200);
  });

  it('keeps team payslips away from the manager', async () => {
    expect((await call(manager, 'GET', `/api/payroll/payslips/${vikramPayslip}`)).status).toBe(404);
  });

  it('keeps the manager own requests out of their review queue', async () => {
    expect((await call(manager, 'GET', '/api/attendance/corrections?status=PENDING')).status).toBe(200);
    expect((await call(manager, 'GET', '/api/attendance/corrections?mine=true')).status).toBe(200);
  });
});

describe('validation and transactions', () => {
  it('returns field-level errors in the common error format', async () => {
    const res = await call(hr, 'POST', '/api/employees', { firstName: '', lastName: '', workEmail: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.json.error.details)).toBe(true);
  });

  it('rejects a correction whose time is on another day', async () => {
    const res = await call(employee, 'POST', '/api/attendance/corrections', {
      workDate: todayIn('Asia/Kolkata'),
      requestedCheckIn: '2001-01-01T09:30:00+05:30',
      requestedCheckOut: '2001-01-01T18:30:00+05:30',
      reason: 'Test: wrong day',
    });
    expect(res.status).toBe(400);
    expect(res.json.error.details.map((d: { field: string }) => d.field)).toContain('requestedCheckIn');
  });

  it('undoes every change of a transaction that fails', async () => {
    const holidays = db.holidays.size;
    const audits = db.auditLogs.size;
    const org = db.organizations.all()[0];
    await expect(
      db.transaction(() => {
        db.holidays.insert({ organizationId: org.id, holidayDate: '2099-01-01', name: 'Test' });
        db.auditLogs.insert({ organizationId: org.id, action: 'test', entityType: 'Holiday' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(db.holidays.size).toBe(holidays);
    expect(db.auditLogs.size).toBe(audits);
  });

  it('rejects duplicates of a unique key with 409', async () => {
    expect((await call(hr, 'POST', '/api/org/departments', { name: 'Research', code: 'RND' })).status).toBe(201);
    expect((await call(hr, 'POST', '/api/org/departments', { name: 'Research', code: 'RES' })).status).toBe(409);
    expect(db.departments.count((d) => d.name === 'Research')).toBe(1);
  });

  it('returns 404 for unknown endpoints', async () => {
    expect((await call(hr, 'GET', '/api/nothing-here')).status).toBe(404);
  });
});

describe('workflows', () => {
  it('runs a leave request from request to approval and updates the balance', async () => {
    const types = await call(employee, 'GET', '/api/leave/types');
    const sick = types.json.items.find((t: { code: string }) => t.code === 'SL');
    const before = (await call(employee, 'GET', '/api/leave/balances')).json.items.find((b: { code: string }) => b.code === 'SL');
    // A working day about three weeks ahead (not a Sunday).
    let day = new Date(Date.now() + 21 * 86_400_000);
    if (day.getUTCDay() === 0) day = new Date(day.getTime() + 86_400_000);
    const ymd = day.toISOString().slice(0, 10);
    const created = await call(employee, 'POST', '/api/leave/requests', { leaveTypeId: sick.id, startDate: ymd, endDate: ymd, isHalfDay: false, reason: 'Medical appointment' });
    expect(created.status).toBe(201);
    expect((await call(employee, 'POST', `/api/leave/requests/${created.json.id}/decision`, { decision: 'APPROVE' })).status).toBe(403);
    expect((await call(manager, 'POST', `/api/leave/requests/${created.json.id}/decision`, { decision: 'APPROVE' })).status).toBe(200);
    const after = (await call(employee, 'GET', '/api/leave/balances')).json.items.find((b: { code: string }) => b.code === 'SL');
    expect(after.used).toBe(before.used + (created.json.days as number));
    const inbox = await call(employee, 'GET', '/api/notifications');
    expect(inbox.json.items[0].kind).toBe('leave.approved');
  });

  it('separates payroll approval from creation', async () => {
    const draft = db.payrollRuns.find((r) => r.status === 'DRAFT')!;
    const validated = await call(hr, 'POST', `/api/payroll/runs/${draft.id}/validate`);
    expect(validated.status).toBe(200);
    expect((await call(hr, 'POST', `/api/payroll/runs/${draft.id}/approve`)).status).toBe(403);
    expect((await call(superAdmin, 'POST', `/api/payroll/runs/${draft.id}/approve`)).status).toBe(200);
    expect((await call(superAdmin, 'POST', `/api/payroll/runs/${draft.id}/finalize`)).status).toBe(200);
    expect((await call(superAdmin, 'POST', `/api/payroll/runs/${draft.id}/finalize`)).status).toBe(422);
  });

  it('serves an employee their own payslip as a PDF and hides other payslips', async () => {
    const own = await call(employee, 'GET', `/api/payroll/payslips/${vikramPayslip}/pdf`);
    expect(own.status).toBe(200);
    const blob = own.json as Blob;
    expect(blob.type).toBe('application/pdf');
    expect(new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()).subarray(0, 5))).toBe('%PDF-');
    expect((await call(employee, 'GET', `/api/payroll/payslips/${finalizedEntryOf(arjunId)}/pdf`)).status).toBe(404);
  });

  it('exports CSV without bank or PAN columns', async () => {
    const csv = await call(hr, 'GET', '/api/employees/export.csv');
    expect(csv.status).toBe(200);
    expect(typeof csv.json).toBe('string');
    expect(csv.json).toMatch(/^"Employee Code","First Name"/);
    expect(csv.json).not.toMatch(/9000\d{6}/);
  });
});

describe('reset demo data', () => {
  it('replaces every change with a fresh demo company and signs the browser out', async () => {
    await call(hr, 'POST', '/api/org/holidays', { date: '2099-12-31', name: 'Only before the reset' });
    const res = await api.handle({ method: 'POST', url: '/api/auth/demo-reset', session: hr });
    expect(res.status).toBe(204);
    expect(res.session).toBeNull();
    expect(db.holidays.count((h) => h.name === 'Only before the reset')).toBe(0);
    expect(db.employees.size).toBe(22);
    // Sessions from before the reset no longer match any user.
    expect((await call(hr, 'GET', '/api/auth/me')).status).toBe(401);
    expect((await store.read())?.tables['holidays']?.some((h) => (h as { name: string }).name === 'Only before the reset')).toBe(false);
  });
});

describe('password hashing', () => {
  it('computes standard SHA-256', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('verifies only the right password, with a random salt per hash', () => {
    const a = hashPassword('correct horse 1');
    expect(verifyPassword('correct horse 1', a)).toBe(true);
    expect(verifyPassword('correct horse 2', a)).toBe(false);
    expect(hashPassword('correct horse 1')).not.toBe(a);
  });
});
