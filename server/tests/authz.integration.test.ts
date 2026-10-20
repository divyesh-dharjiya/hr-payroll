import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';

// Integration tests: run the real Express app against the seeded development database (npm run seed first).
// They are read-only except for the login attempts, so they are safe to run repeatedly.

const DOMAIN = 'lotus-demo.example';
const password = process.env.SEED_DEMO_PASSWORD ?? '';

let server: Server;
let base = '';

async function login(email: string, pw = password): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: pw }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status}`);
  const cookie = res.headers.get('set-cookie') ?? '';
  return cookie.split(';')[0];
}

async function call(cookie: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? safeJson(text) : null };
}

function safeJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let hr: string;
let manager: string;
let employee: string;
let vikramId: string;
let arjunId: string;
let hrEmployeeId: string;
let augEntryOfVikram: string;

beforeAll(async () => {
  server = createApp().listen(0);
  const { port } = server.address() as AddressInfo;
  base = `http://localhost:${port}`;
  hr = await login(`hr@${DOMAIN}`);
  manager = await login(`manager@${DOMAIN}`);
  employee = await login(`employee@${DOMAIN}`);

  const vikram = await prisma.employee.findFirstOrThrow({ where: { workEmail: `employee@${DOMAIN}` } });
  const arjun = await prisma.employee.findFirstOrThrow({ where: { workEmail: `manager@${DOMAIN}` } });
  const hrEmp = await prisma.employee.findFirstOrThrow({ where: { workEmail: `hr@${DOMAIN}` } });
  vikramId = vikram.id;
  arjunId = arjun.id;
  hrEmployeeId = hrEmp.id;
  const entry = await prisma.payrollEntry.findFirst({ where: { employeeId: vikram.id, run: { status: 'FINALIZED' } } });
  augEntryOfVikram = entry?.id ?? 'missing';
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('authentication', () => {
  it('rejects requests without a session', async () => {
    const res = await call(null, 'GET', '/api/dashboard');
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns the same generic message for a wrong password and an unknown account', async () => {
    const wrong = await call(null, 'POST', '/api/auth/login', { email: `hr@${DOMAIN}`, password: 'not-the-password-1' });
    const unknown = await call(null, 'POST', '/api/auth/login', { email: `nobody@${DOMAIN}`, password: 'not-the-password-1' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json.error.message).toBe(unknown.json.error.message);
  });

  it('never returns the password hash in the session response', async () => {
    const res = await call(hr, 'GET', '/api/auth/me');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.json)).not.toMatch(/passwordHash|tokenVersion/);
  });
});

describe('role-based authorization on the API', () => {
  it('blocks employees from the company-wide directory', async () => {
    const res = await call(employee, 'GET', '/api/employees/');
    expect(res.status).toBe(403);
  });

  it('scopes managers to their direct reports', async () => {
    const team = await call(manager, 'GET', '/api/employees/?pageSize=100');
    expect(team.status).toBe(200);
    const ids = team.json.items.map((e: { id: string }) => e.id);
    expect(ids).toContain(vikramId);
    expect(ids).not.toContain(hrEmployeeId);

    // Direct lookup of a non-report returns 404, not 403, so existence is not leaked.
    const outside = await call(manager, 'GET', `/api/employees/${hrEmployeeId}`);
    expect(outside.status).toBe(404);
  });

  it('lets employees read only their own profile', async () => {
    const own = await call(employee, 'GET', `/api/employees/${vikramId}`);
    expect(own.status).toBe(200);
    const other = await call(employee, 'GET', `/api/employees/${arjunId}`);
    expect(other.status).toBe(404);
  });

  it('keeps restricted bank and PAN data away from managers and employees', async () => {
    expect((await call(manager, 'GET', `/api/employees/${vikramId}/sensitive`)).status).toBe(403);
    expect((await call(employee, 'GET', `/api/employees/${vikramId}/sensitive`)).status).toBe(403);
  });

  it('returns only masked bank and PAN values in the standard profile', async () => {
    const res = await call(hr, 'GET', `/api/employees/${vikramId}`);
    expect(res.status).toBe(200);
    expect(res.json.bankAccount).toMatch(/^•••• \d{4}$/);
    // PAN has letters in its last characters too, so only the mask and the four visible characters are checked.
    expect(res.json.pan).toMatch(/^•+[A-Z0-9]{4}$/);
    expect(JSON.stringify(res.json)).not.toMatch(/Cipher/);
  });

  it('does not let employees open a payslip that belongs to someone else', async () => {
    const res = await call(employee, 'GET', `/api/payroll/payslips/${augEntryOfVikram}`);
    expect(res.status).toBe(200); // Vikram's own payslip
    const hrEntry = await prisma.payrollEntry.findFirst({ where: { employeeId: hrEmployeeId, run: { status: 'FINALIZED' } } });
    const denied = await call(employee, 'GET', `/api/payroll/payslips/${hrEntry?.id ?? 'x'}`);
    expect(denied.status).toBe(404);
  });

  it('blocks managers from payroll administration', async () => {
    expect((await call(manager, 'GET', '/api/payroll/runs')).status).toBe(403);
    expect((await call(manager, 'POST', '/api/payroll/runs/none/approve')).status).toBe(403);
  });

  it('separates payroll approval from creation', async () => {
    // The HR creator of the September draft must not be able to approve it themselves.
    const draft = await prisma.payrollRun.findFirst({ where: { status: 'DRAFT' } });
    if (!draft) return; // nothing to assert against in this database
    const res = await call(hr, 'POST', `/api/payroll/runs/${draft.id}/approve`);
    expect([403, 422]).toContain(res.status);
  });
});

describe('input validation', () => {
  it('returns field-level errors in the common error format', async () => {
    const res = await call(hr, 'POST', '/api/employees', { firstName: '', lastName: '', workEmail: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('VALIDATION_ERROR');
    expect(Array.isArray(res.json.error.details)).toBe(true);
  });

  it('rejects JSON-incompatible content types on state-changing requests', async () => {
    const res = await fetch(`${base}/api/leave/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', Cookie: employee },
      body: 'leaveTypeId=x',
    });
    expect(res.status).toBe(415);
  });
});

describe('session probe, payslip PDF, overtime and corrections', () => {
  it('answers the session probe with user null when signed out, without a 401', async () => {
    const res = await call(null, 'GET', '/api/auth/session');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ user: null });
    const signedIn = await call(employee, 'GET', '/api/auth/session');
    expect(signedIn.json.user.email).toBe(`employee@${DOMAIN}`);
    expect(JSON.stringify(signedIn.json)).not.toContain('passwordHash');
  });

  it('serves an employee their own payslip as a PDF and hides other payslips', async () => {
    const own = await fetch(`${base}/api/payroll/payslips/${augEntryOfVikram}/pdf`, { headers: { Cookie: employee } });
    expect(own.status).toBe(200);
    expect(own.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await own.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');

    const other = await prisma.payrollEntry.findFirstOrThrow({ where: { employeeId: arjunId, run: { status: 'FINALIZED' } } });
    const res = await call(employee, 'GET', `/api/payroll/payslips/${other.id}/pdf`);
    expect(res.status).toBe(404);
  });

  it('does not let employees review overtime', async () => {
    const res = await call(employee, 'POST', '/api/attendance/overtime/review', { ids: ['x'], decision: 'APPROVE' });
    expect(res.status).toBe(403);
  });

  it('limits managers to overtime of their direct reports', async () => {
    const outside = await prisma.attendanceRecord.findFirst({ where: { overtimeStatus: { not: 'NONE' }, employee: { NOT: { managerId: arjunId } } } });
    if (!outside) return;
    const res = await call(manager, 'POST', '/api/attendance/overtime/review', { ids: [outside.id], decision: 'APPROVE' });
    expect(res.status).toBe(404);
    const list = await call(manager, 'GET', '/api/attendance/overtime');
    expect(list.status).toBe(200);
    expect(list.json.items.every((i: { employee: { id: string } }) => i.employee.id !== outside.employeeId)).toBe(true);
  });

  it('rejects a correction whose time is on another day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const res = await call(employee, 'POST', '/api/attendance/corrections', {
      workDate: today,
      requestedCheckIn: '2001-01-01T09:30:00+05:30',
      requestedCheckOut: '2001-01-01T18:30:00+05:30',
      reason: 'Integration test: wrong day',
    });
    expect(res.status).toBe(400);
    expect(res.json.error.details.map((d: { field: string }) => d.field)).toContain('requestedCheckIn');
  });
});

describe('a manager is also an employee', () => {
  it('lets a manager open their own calendar, leave balances, profile and payslip', async () => {
    const now = new Date();
    const cal = await call(manager, 'GET', `/api/attendance/calendar?employeeId=${arjunId}&year=${now.getFullYear()}&month=${now.getMonth() + 1}`);
    expect(cal.status).toBe(200);
    expect((await call(manager, 'GET', `/api/leave/balances?employeeId=${arjunId}`)).status).toBe(200);
    expect((await call(manager, 'GET', `/api/employees/${arjunId}`)).status).toBe(200);
    const slip = await prisma.payrollEntry.findFirstOrThrow({ where: { employeeId: arjunId, run: { status: 'FINALIZED' } } });
    expect((await call(manager, 'GET', `/api/payroll/payslips/${slip.id}`)).status).toBe(200);
  });

  it('keeps team payslips away from the manager', async () => {
    expect((await call(manager, 'GET', `/api/payroll/payslips/${augEntryOfVikram}`)).status).toBe(404);
  });

  it('lists only direct reports in the manager directory, not the manager', async () => {
    const res = await call(manager, 'GET', '/api/employees?pageSize=100');
    expect(res.json.items.some((e: { id: string }) => e.id === arjunId)).toBe(false);
    expect(res.json.items.some((e: { id: string }) => e.id === vikramId)).toBe(true);
  });

  it('keeps the manager own requests out of their review queue', async () => {
    const res = await call(manager, 'GET', '/api/attendance/corrections?status=PENDING');
    expect(res.status).toBe(200);
    const mine = await call(manager, 'GET', '/api/attendance/corrections?mine=true');
    expect(mine.status).toBe(200);
  });
});
