import { Router } from 'express';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { writeAudit } from '../../lib/audit';
import { toCsv } from '../../lib/csv';
import { dateOnly, eachDay, ymdOf } from '../../lib/time';
import { requireAuth, requirePermission, type AuthContext } from '../../middleware/auth';
import { dailyStatusesFor } from '../attendance/attendance.service';

export const reportsRouter = Router();

const MAX_RANGE_DAYS = 186;

const querySchema = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.'),
    departmentId: z.string().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'The end date must be on or after the start date.', path: ['to'] })
  .refine((q) => eachDay(q.from, q.to).length <= MAX_RANGE_DAYS, { message: `Choose a range of at most ${MAX_RANGE_DAYS} days.`, path: ['to'] });

type Query = z.infer<typeof querySchema>;

interface EmployeeAttendance {
  id: string;
  employeeCode: string;
  name: string;
  department: string;
  workingDays: number;
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  lateMinutes: number;
  overtimeHours: number;
  avgHoursPerDay: number;
}

interface LineTotal {
  code: string;
  label: string;
  amountPaise: number;
}

/** Builds every report section for the period from database records. */
async function buildReport(auth: AuthContext, q: Query) {
  const orgId = auth.organizationId;
  const from = dateOnly(q.from);
  const to = dateOnly(q.to);
  const deptFilter: Prisma.EmployeeWhereInput = q.departmentId ? { departmentId: q.departmentId } : {};

  // Employees employed at any point in the period.
  const employees = await prisma.employee.findMany({
    where: {
      organizationId: orgId,
      ...deptFilter,
      joiningDate: { lte: to },
      OR: [{ exitDate: null }, { exitDate: { gte: from } }],
    },
    select: {
      id: true,
      employeeCode: true,
      firstName: true,
      lastName: true,
      joiningDate: true,
      exitDate: true,
      employmentType: true,
      workLocation: true,
      department: { select: { id: true, name: true } },
    },
    orderBy: { employeeCode: 'asc' },
  });

  // -- Headcount (as of the end of the period) ----------------------------------------------------------------------
  const endYmd = q.to;
  const activeAtEnd = employees.filter((e) => ymdOf(e.joiningDate) <= endYmd && (!e.exitDate || ymdOf(e.exitDate) >= endYmd));
  const countBy = (key: (e: (typeof employees)[number]) => string) => {
    const map = new Map<string, number>();
    for (const e of activeAtEnd) map.set(key(e), (map.get(key(e)) ?? 0) + 1);
    return [...map.entries()].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
  };
  const joiners = employees.filter((e) => ymdOf(e.joiningDate) >= q.from && ymdOf(e.joiningDate) <= q.to);
  const exits = employees.filter((e) => e.exitDate && ymdOf(e.exitDate) >= q.from && ymdOf(e.exitDate) <= q.to);
  const person = (e: (typeof employees)[number]) => ({ id: e.id, employeeCode: e.employeeCode, name: `${e.firstName} ${e.lastName}`, department: e.department.name });

  // -- Attendance ---------------------------------------------------------------------------------------------------
  const perEmployee: EmployeeAttendance[] = [];
  const daily = new Map<string, { present: number; late: number; absent: number; onLeave: number }>();
  for (const day of eachDay(q.from, q.to)) daily.set(day, { present: 0, late: 0, absent: 0, onLeave: 0 });
  const deptAttendance = new Map<string, { working: number; absent: number }>();

  for (const e of employees) {
    const days = await dailyStatusesFor(e.id, q.from, q.to, orgId);
    let present = 0, late = 0, absent = 0, halfDay = 0, onLeave = 0, working = 0, lateMinutes = 0, overtime = 0, worked = 0;
    for (const d of days) {
      const bucket = daily.get(d.date)!;
      switch (d.status) {
        case 'PRESENT':
        case 'WFH':
          present++; working++; bucket.present++;
          break;
        case 'LATE':
          present++; late++; working++; bucket.present++; bucket.late++;
          break;
        case 'HALF_DAY':
          present++; halfDay++; working++; bucket.present++;
          break;
        case 'ABSENT':
          absent++; working++; bucket.absent++;
          break;
        case 'ON_LEAVE':
          onLeave++; working++; bucket.onLeave++;
          break;
        default:
          break;
      }
      lateMinutes += d.lateMinutes ?? 0;
      overtime += d.overtimeMinutes ?? 0;
      worked += d.workedMinutes ?? 0;
    }
    const dept = deptAttendance.get(e.department.name) ?? { working: 0, absent: 0 };
    dept.working += working;
    dept.absent += absent;
    deptAttendance.set(e.department.name, dept);
    perEmployee.push({
      ...person(e),
      workingDays: working,
      present,
      late,
      halfDay,
      absent,
      onLeave,
      lateMinutes,
      overtimeHours: Number((overtime / 60).toFixed(2)),
      avgHoursPerDay: present ? Number((worked / 60 / present).toFixed(2)) : 0,
    });
  }
  const sum = (k: 'workingDays' | 'present' | 'late' | 'absent' | 'onLeave' | 'lateMinutes' | 'overtimeHours') =>
    perEmployee.reduce((s, r) => s + r[k], 0);
  const workingDays = sum('workingDays');

  // -- Leave utilization ----------------------------------------------------------------------------------------------
  const leaveRows = await prisma.leaveRequest.findMany({
    where: {
      organizationId: orgId,
      startDate: { lte: to },
      endDate: { gte: from },
      employee: { organizationId: orgId, ...deptFilter },
    },
    select: { status: true, days: true, leaveType: { select: { code: true, name: true, isPaid: true } } },
  });
  const leaveByType = new Map<string, { code: string; name: string; isPaid: boolean; approvedDays: number; approvedRequests: number; pendingRequests: number; rejectedRequests: number }>();
  for (const r of leaveRows) {
    const t = leaveByType.get(r.leaveType.code) ?? { code: r.leaveType.code, name: r.leaveType.name, isPaid: r.leaveType.isPaid, approvedDays: 0, approvedRequests: 0, pendingRequests: 0, rejectedRequests: 0 };
    if (r.status === 'APPROVED' || r.status === 'CANCEL_REQUESTED') {
      t.approvedDays += Number(r.days);
      t.approvedRequests++;
    } else if (r.status === 'PENDING') t.pendingRequests++;
    else if (r.status === 'REJECTED') t.rejectedRequests++;
    leaveByType.set(r.leaveType.code, t);
  }

  // -- Payroll (finalized months that overlap the period) -------------------------------------------------------------
  const fromKey = Number(q.from.slice(0, 4)) * 100 + Number(q.from.slice(5, 7));
  const toKey = Number(q.to.slice(0, 4)) * 100 + Number(q.to.slice(5, 7));
  const runs = await prisma.payrollRun.findMany({
    where: { organizationId: orgId, status: 'FINALIZED' },
    select: { id: true, year: true, month: true, totalGrossPaise: true, totalNetPaise: true, totalDeductionsPaise: true, totalEmployerPaise: true },
    orderBy: [{ year: 'asc' }, { month: 'asc' }],
  });
  const inRange = runs.filter((r) => r.year * 100 + r.month >= fromKey && r.year * 100 + r.month <= toKey);
  const earnings = new Map<string, LineTotal>();
  const deductions = new Map<string, LineTotal>();
  const employer = new Map<string, LineTotal>();
  const add = (map: Map<string, LineTotal>, l: LineTotal) => {
    const key = `${l.code}:${l.label}`;
    const cur = map.get(key) ?? { code: l.code, label: l.label, amountPaise: 0 };
    cur.amountPaise += l.amountPaise;
    map.set(key, cur);
  };
  const monthly = [];
  const reconciliation = [];
  for (const run of inRange) {
    const entries = await prisma.payrollEntry.findMany({
      where: { payrollRunId: run.id, employee: deptFilter },
      select: { grossPaise: true, totalDeductionsPaise: true, netPaise: true, employerContribPaise: true, paymentStatus: true, snapshot: true },
    });
    let gross = 0, ded = 0, net = 0, emp = 0, paid = 0, unpaid = 0, paidCount = 0;
    for (const e of entries) {
      gross += e.grossPaise;
      ded += e.totalDeductionsPaise;
      net += e.netPaise;
      emp += e.employerContribPaise;
      if (e.paymentStatus === 'PAID') { paid += e.netPaise; paidCount++; } else unpaid += e.netPaise;
      const lines = (e.snapshot as unknown as { lines?: { earnings: LineTotal[]; deductions: LineTotal[]; employerContributions: LineTotal[] } }).lines;
      lines?.earnings.forEach((l) => add(earnings, l));
      lines?.deductions.forEach((l) => add(deductions, l));
      lines?.employerContributions.forEach((l) => add(employer, l));
    }
    const period = `${run.year}-${String(run.month).padStart(2, '0')}`;
    monthly.push({ period, employees: entries.length, grossPaise: gross, deductionsPaise: ded, netPaise: net, employerPaise: emp, costPaise: gross + emp });
    reconciliation.push({
      period,
      // Gross - deductions must equal net; for the whole company the entry totals must equal the stored run totals.
      formulaCheck: gross - ded === net,
      runTotalsMatch: q.departmentId ? null : gross === run.totalGrossPaise && net === run.totalNetPaise && ded === run.totalDeductionsPaise,
      paidPaise: paid,
      unpaidPaise: unpaid,
      paidCount,
      unpaidCount: entries.length - paidCount,
    });
  }

  return {
    period: { from: q.from, to: q.to, departmentId: q.departmentId ?? null },
    headcount: {
      activeAtEnd: activeAtEnd.length,
      byDepartment: countBy((e) => e.department.name),
      byEmploymentType: countBy((e) => e.employmentType),
      byLocation: countBy((e) => e.workLocation),
      joiners: joiners.map((e) => ({ ...person(e), date: ymdOf(e.joiningDate) })),
      exits: exits.map((e) => ({ ...person(e), date: e.exitDate ? ymdOf(e.exitDate) : null })),
    },
    attendance: {
      workingDays,
      presentDays: sum('present'),
      absentDays: sum('absent'),
      leaveDays: sum('onLeave'),
      lateArrivals: sum('late'),
      lateMinutes: sum('lateMinutes'),
      overtimeHours: Number(sum('overtimeHours').toFixed(2)),
      absenteeismRate: workingDays ? Number(((sum('absent') / workingDays) * 100).toFixed(1)) : 0,
      attendanceRate: workingDays ? Number(((sum('present') / workingDays) * 100).toFixed(1)) : 0,
      daily: [...daily.entries()].map(([date, v]) => ({ date, ...v })),
      byDepartment: [...deptAttendance.entries()].map(([department, v]) => ({
        department,
        workingDays: v.working,
        absentDays: v.absent,
        absenteeismRate: v.working ? Number(((v.absent / v.working) * 100).toFixed(1)) : 0,
      })),
      topLate: [...perEmployee].filter((r) => r.late > 0).sort((a, b) => b.late - a.late || b.lateMinutes - a.lateMinutes).slice(0, 5),
      topOvertime: [...perEmployee].filter((r) => r.overtimeHours > 0).sort((a, b) => b.overtimeHours - a.overtimeHours).slice(0, 5),
      employees: perEmployee,
    },
    leave: {
      byType: [...leaveByType.values()].sort((a, b) => b.approvedDays - a.approvedDays),
      totalApprovedDays: [...leaveByType.values()].reduce((s, t) => s + t.approvedDays, 0),
    },
    payroll: {
      monthly,
      totals: monthly.reduce(
        (t, m) => ({ grossPaise: t.grossPaise + m.grossPaise, deductionsPaise: t.deductionsPaise + m.deductionsPaise, netPaise: t.netPaise + m.netPaise, employerPaise: t.employerPaise + m.employerPaise }),
        { grossPaise: 0, deductionsPaise: 0, netPaise: 0, employerPaise: 0 },
      ),
      earnings: [...earnings.values()].sort((a, b) => b.amountPaise - a.amountPaise),
      deductions: [...deductions.values()].sort((a, b) => b.amountPaise - a.amountPaise),
      employerContributions: [...employer.values()],
      reconciliation,
    },
  };
}

reportsRouter.get('/overview', requirePermission('reports:read'), async (req, res) => {
  const q = querySchema.parse(req.query);
  res.json(await buildReport(requireAuth(req), q));
});

const csv = toCsv;
const rupees = (paise: number) => (paise / 100).toFixed(2);

reportsRouter.get('/export.csv', requirePermission('reports:read'), async (req, res) => {
  const auth = requireAuth(req);
  const type = z.enum(['headcount', 'attendance', 'leave', 'payroll']).parse(req.query.type);
  const q = querySchema.parse(req.query);
  const r = await buildReport(auth, q);
  let body: string;
  switch (type) {
    case 'headcount':
      body = csv(
        ['Section', 'Label', 'Count / Date', 'Employee code', 'Department'],
        [
          ...r.headcount.byDepartment.map((d) => ['Department', d.label, d.count, '', '']),
          ...r.headcount.byEmploymentType.map((d) => ['Employment type', d.label, d.count, '', '']),
          ...r.headcount.joiners.map((j) => ['Joiner', j.name, j.date, j.employeeCode, j.department]),
          ...r.headcount.exits.map((x) => ['Exit', x.name, x.date, x.employeeCode, x.department]),
        ],
      );
      break;
    case 'attendance':
      body = csv(
        ['Employee code', 'Name', 'Department', 'Working days', 'Present', 'Late', 'Half day', 'Absent', 'On leave', 'Late minutes', 'Overtime hours', 'Avg hours/day'],
        r.attendance.employees.map((e) => [e.employeeCode, e.name, e.department, e.workingDays, e.present, e.late, e.halfDay, e.absent, e.onLeave, e.lateMinutes, e.overtimeHours, e.avgHoursPerDay]),
      );
      break;
    case 'leave':
      body = csv(
        ['Code', 'Leave type', 'Paid', 'Approved days', 'Approved requests', 'Pending requests', 'Rejected requests'],
        r.leave.byType.map((t) => [t.code, t.name, t.isPaid ? 'Yes' : 'No', t.approvedDays, t.approvedRequests, t.pendingRequests, t.rejectedRequests]),
      );
      break;
    default:
      body = csv(
        ['Period', 'Employees', 'Gross (INR)', 'Deductions (INR)', 'Net (INR)', 'Employer contributions (INR)', 'Total cost (INR)', 'Gross - deductions = net', 'Paid (INR)', 'Unpaid (INR)'],
        r.payroll.monthly.map((m, i) => {
          const rec = r.payroll.reconciliation[i];
          return [m.period, m.employees, rupees(m.grossPaise), rupees(m.deductionsPaise), rupees(m.netPaise), rupees(m.employerPaise), rupees(m.costPaise), rec.formulaCheck ? 'OK' : 'MISMATCH', rupees(rec.paidPaise), rupees(rec.unpaidPaise)];
        }),
      );
  }
  await writeAudit(auth, auth.organizationId, { action: 'report.exported', entityType: 'Report', summary: { type, from: q.from, to: q.to } }, req);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${type}-report-${q.from}-to-${q.to}.csv"`);
  res.send(body);
});
