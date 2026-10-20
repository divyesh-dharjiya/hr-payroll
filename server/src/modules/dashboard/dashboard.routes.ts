import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { dateOnly, todayIn, ymdOf, eachDay } from '../../lib/time';
import { requireAuth, type AuthContext } from '../../middleware/auth';
import { balancesFor } from '../leave/leave.service';
import { getToday, loadRules } from '../attendance/attendance.service';

export const dashboardRouter = Router();

const PRESENT_STATUSES = ['PRESENT', 'LATE', 'HALF_DAY', 'WFH'] as const;

/** Single entry point: returns the dashboard that matches the caller's role and data scope. */
dashboardRouter.get('/', async (req, res) => {
  const auth = requireAuth(req);
  const rules = await loadRules(auth.organizationId);
  const today = todayIn(rules.timezone);
  if (auth.role === 'HR_ADMIN' || auth.role === 'SUPER_ADMIN') {
    return res.json({ view: 'hr', ...(await hrDashboard(auth.organizationId, today, rules.weeklyOffDays)) });
  }
  if (auth.role === 'MANAGER') {
    return res.json({ view: 'manager', ...(await managerDashboard(auth, today)) });
  }
  return res.json({ view: 'employee', ...(await employeeDashboard(auth, today)) });
});

dashboardRouter.get('/announcements', async (req, res) => {
  const auth = requireAuth(req);
  res.json({ items: await visibleAnnouncements(auth, 5) });
});

async function visibleAnnouncements(auth: Pick<AuthContext, 'organizationId' | 'role' | 'employeeId'>, take: number) {
  const now = new Date();
  const me = auth.employeeId ? await prisma.employee.findUnique({ where: { id: auth.employeeId }, select: { departmentId: true } }) : null;
  const rows = await prisma.announcement.findMany({
    where: {
      organizationId: auth.organizationId,
      publishAt: { lte: now },
      AND: [
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        { OR: [{ audienceRole: null }, { audienceRole: auth.role as never }] },
        { OR: [{ departmentId: null }, ...(me ? [{ departmentId: me.departmentId }] : [])] },
      ],
    },
    orderBy: { publishAt: 'desc' },
    take,
    select: { id: true, title: true, body: true, publishAt: true, expiresAt: true },
  });
  return rows.map((a) => ({ ...a, publishAt: a.publishAt.toISOString(), expiresAt: a.expiresAt?.toISOString() ?? null }));
}

/** Upcoming birthdays and work anniversaries within `days` days from today (calendar match, year-agnostic). */
function upcomingEvents(
  rows: { id: string; firstName: string; lastName: string; photoUrl: string | null; dateOfBirth: Date | null; joiningDate: Date; designation: { title: string } }[],
  today: string,
  days: number,
) {
  const window = eachDay(today, ymdOf(new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000)));
  const md = (ymd: string) => ymd.slice(5);
  const birthdays: { id: string; name: string; date: string; designation: string; photoUrl: string | null }[] = [];
  const anniversaries: { id: string; name: string; date: string; years: number; designation: string; photoUrl: string | null }[] = [];
  for (const r of rows) {
    const name = `${r.firstName} ${r.lastName}`;
    if (r.dateOfBirth) {
      const hit = window.find((d) => md(d) === ymdOf(r.dateOfBirth!).slice(5));
      if (hit) birthdays.push({ id: r.id, name, date: hit, designation: r.designation.title, photoUrl: r.photoUrl });
    }
    const joinYmd = ymdOf(r.joiningDate);
    const hit = window.find((d) => md(d) === joinYmd.slice(5));
    if (hit) {
      const years = Number(hit.slice(0, 4)) - Number(joinYmd.slice(0, 4));
      if (years > 0) anniversaries.push({ id: r.id, name, date: hit, years, designation: r.designation.title, photoUrl: r.photoUrl });
    }
  }
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  return { birthdays: birthdays.sort(byDate), anniversaries: anniversaries.sort(byDate) };
}

async function hrDashboard(orgId: string, today: string, weeklyOffDays: number[]) {
  const todayDate = dateOnly(today);
  const period = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };

  const [activeCount, totalCount, todayRecords, approvedLeaveToday, pendingLeave, pendingCorrections, dept, employeesForEvents, currentRun, recentRuns, attendanceTrend, activities, missingBank, announcements, holidayToday] = await Promise.all([
    prisma.employee.count({ where: { organizationId: orgId, status: 'ACTIVE' } }),
    prisma.employee.count({ where: { organizationId: orgId, status: { not: 'EXITED' } } }),
    prisma.attendanceRecord.findMany({
      where: { organizationId: orgId, workDate: todayDate },
      select: { status: true, checkInAt: true, employeeId: true, lateMinutes: true },
    }),
    prisma.leaveRequest.findMany({
      where: { organizationId: orgId, status: 'APPROVED', startDate: { lte: todayDate }, endDate: { gte: todayDate } },
      select: { employeeId: true },
      distinct: ['employeeId'],
    }),
    prisma.leaveRequest.count({ where: { organizationId: orgId, status: 'PENDING' } }),
    prisma.attendanceCorrection.count({ where: { organizationId: orgId, status: 'PENDING' } }),
    prisma.department.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, _count: { select: { employees: { where: { status: { not: 'EXITED' } } } } } },
    }),
    prisma.employee.findMany({
      where: { organizationId: orgId, status: { not: 'EXITED' } },
      select: { id: true, firstName: true, lastName: true, photoUrl: true, dateOfBirth: true, joiningDate: true, designation: { select: { title: true } } },
    }),
    prisma.payrollRun.findUnique({
      where: { organizationId_year_month: { organizationId: orgId, ...period } },
      select: { status: true, totalGrossPaise: true, totalEmployerPaise: true, totalNetPaise: true },
    }),
    prisma.payrollRun.findMany({
      where: { organizationId: orgId, status: 'FINALIZED' },
      orderBy: [{ year: 'desc' }, { month: 'desc' }],
      take: 6,
      select: { year: true, month: true, totalGrossPaise: true, totalNetPaise: true, totalEmployerPaise: true },
    }),
    trendLast14(orgId, today),
    prisma.auditLog.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'desc' }, take: 8, select: { id: true, action: true, actorEmail: true, entityType: true, createdAt: true } }),
    prisma.employee.count({ where: { organizationId: orgId, status: 'ACTIVE', bankAccountCipher: null } }),
    visibleAnnouncements({ organizationId: orgId, role: 'HR_ADMIN', employeeId: null }, 5),
    prisma.holiday.findFirst({ where: { organizationId: orgId, holidayDate: todayDate }, select: { name: true } }),
  ]);
  const present = todayRecords.filter((r) => PRESENT_STATUSES.includes(r.status as (typeof PRESENT_STATUSES)[number]) && r.checkInAt).length;
  const late = todayRecords.filter((r) => r.status === 'LATE').length;
  const leaveIds = new Set(approvedLeaveToday.map((l) => l.employeeId));
  const isWorkingDay = !holidayToday && !weeklyOffDays.includes(new Date(`${today}T00:00:00Z`).getUTCDay());
  const onLeave = leaveIds.size;
  const notCheckedIn = isWorkingDay ? Math.max(0, activeCount - present - onLeave) : 0;

  const events = upcomingEvents(employeesForEvents, today, 30);

  const payrollTrend = recentRuns
    .slice()
    .reverse()
    .map((r) => ({ period: `${r.year}-${String(r.month).padStart(2, '0')}`, grossPaise: r.totalGrossPaise, netPaise: r.totalNetPaise }));

  return {
    kpis: {
      totalEmployees: totalCount,
      activeEmployees: activeCount,
      presentToday: present,
      lateToday: late,
      onLeaveToday: onLeave,
      absentToday: notCheckedIn,
      pendingLeaveRequests: pendingLeave,
      pendingCorrections,
      employeesMissingBankDetails: missingBank,
    },
    today: { date: today, isWorkingDay, holiday: holidayToday?.name ?? null },
    payroll: currentRun
      ? { period, status: currentRun.status, grossPaise: currentRun.totalGrossPaise, employerPaise: currentRun.totalEmployerPaise, expensePaise: currentRun.totalGrossPaise + currentRun.totalEmployerPaise }
      : { period, status: null, grossPaise: 0, employerPaise: 0, expensePaise: 0 },
    departmentDistribution: dept.map((d) => ({ id: d.id, name: d.name, count: d._count.employees })),
    attendanceTrend,
    payrollTrend,
    birthdays: events.birthdays,
    anniversaries: events.anniversaries,
    recentActivity: activities.map((a) => ({ id: a.id, action: a.action, actor: a.actorEmail, entityType: a.entityType, at: a.createdAt.toISOString() })),
    pendingTasks: [
      ...(pendingLeave > 0 ? [{ key: 'leave', label: `${pendingLeave} leave request(s) waiting for decision`, href: '/leave' }] : []),
      ...(pendingCorrections > 0 ? [{ key: 'corrections', label: `${pendingCorrections} attendance correction(s) to review`, href: '/attendance' }] : []),
      ...(missingBank > 0 ? [{ key: 'bank', label: `${missingBank} active employee(s) without bank details`, href: '/employees' }] : []),
      ...(currentRun && currentRun.status !== 'FINALIZED' ? [{ key: 'payroll', label: `Payroll for this month is ${currentRun.status.toLowerCase()}`, href: '/payroll' }] : []),
    ],
    announcements,
  };
}

/** Attendance trend for the last 14 days: present-type counts and absences inferred from records. */
async function trendLast14(orgId: string, today: string) {
  const from = ymdOf(new Date(Date.parse(`${today}T00:00:00Z`) - 13 * 86_400_000));
  const rows = await prisma.attendanceRecord.groupBy({
    by: ['workDate', 'status'],
    where: { organizationId: orgId, workDate: { gte: dateOnly(from), lte: dateOnly(today) } },
    _count: { _all: true },
  });
  const days = eachDay(from, today);
  return days.map((d) => {
    const mine = rows.filter((r) => ymdOf(r.workDate) === d);
    const sum = (statuses: string[]) => mine.filter((r) => statuses.includes(r.status)).reduce((s, r) => s + r._count._all, 0);
    return { date: d, present: sum(['PRESENT', 'WFH', 'HALF_DAY']), late: sum(['LATE']) };
  });
}

async function managerDashboard(auth: AuthContext, today: string) {
  const orgId = auth.organizationId;
  const teamWhere = { organizationId: orgId, managerId: auth.employeeId ?? '__none__', status: { not: 'EXITED' as const } };
  const todayDate = dateOnly(today);
  const in14 = dateOnly(ymdOf(new Date(Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000)));

  const [team, teamToday, pendingApprovals, upcomingAbsences] = await Promise.all([
    prisma.employee.findMany({
      where: teamWhere,
      orderBy: { firstName: 'asc' },
      select: { id: true, employeeCode: true, firstName: true, lastName: true, photoUrl: true, status: true, workEmail: true, phone: true, designation: { select: { title: true } }, department: { select: { name: true } } },
    }),
    prisma.attendanceRecord.findMany({
      where: { workDate: todayDate, employee: teamWhere },
      select: { employeeId: true, status: true, checkInAt: true },
    }),
    prisma.leaveRequest.findMany({
      where: { organizationId: orgId, status: 'PENDING', employee: teamWhere },
      orderBy: { startDate: 'asc' },
      take: 20,
      include: { employee: { select: { firstName: true, lastName: true } }, leaveType: { select: { code: true } } },
    }),
    prisma.leaveRequest.findMany({
      where: { organizationId: orgId, status: 'APPROVED', startDate: { lte: in14 }, endDate: { gte: todayDate }, employee: teamWhere },
      orderBy: { startDate: 'asc' },
      take: 20,
      include: { employee: { select: { firstName: true, lastName: true } }, leaveType: { select: { code: true } } },
    }),
  ]);

  const present = teamToday.filter((r) => r.checkInAt).length;
  const late = teamToday.filter((r) => r.status === 'LATE').length;
  const onLeave = upcomingAbsences.filter((l) => ymdOf(l.startDate) <= today && ymdOf(l.endDate) >= today).length;
  return {
    kpis: {
      teamSize: team.length,
      presentToday: present,
      lateToday: late,
      onLeaveToday: onLeave,
      notCheckedIn: Math.max(0, team.length - present - onLeave),
      pendingApprovals: pendingApprovals.length,
    },
    team: team.map((t) => ({ id: t.id, employeeCode: t.employeeCode, name: `${t.firstName} ${t.lastName}`, photoUrl: t.photoUrl, status: t.status, designation: t.designation.title, department: t.department.name, email: t.workEmail, phone: t.phone })),
    pendingApprovals: pendingApprovals.map((p) => ({ id: p.id, employee: `${p.employee.firstName} ${p.employee.lastName}`, leaveType: p.leaveType.code, startDate: ymdOf(p.startDate), endDate: ymdOf(p.endDate), days: Number(p.days) })),
    upcomingAbsences: upcomingAbsences.map((l) => ({ id: l.id, employee: `${l.employee.firstName} ${l.employee.lastName}`, leaveType: l.leaveType.code, startDate: ymdOf(l.startDate), endDate: ymdOf(l.endDate) })),
    announcements: await visibleAnnouncements(auth, 5),
  };
}

async function employeeDashboard(auth: AuthContext, today: string) {
  const orgId = auth.organizationId;
  if (!auth.employeeId) {
    return { profile: null, message: 'Your account is not linked to an employee profile yet. Contact HR.', announcements: await visibleAnnouncements(auth, 5) };
  }
  const employeeId = auth.employeeId;
  const [profile, attendance, balances, holidays, payslips, announcements] = await Promise.all([
    prisma.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: { employeeCode: true, firstName: true, lastName: true, workEmail: true, joiningDate: true, workLocation: true, designation: { select: { title: true } }, department: { select: { name: true } }, manager: { select: { firstName: true, lastName: true } } },
    }),
    getToday(auth),
    balancesFor(auth),
    prisma.holiday.findMany({
      where: { organizationId: orgId, holidayDate: { gte: dateOnly(today), lte: dateOnly(ymdOf(new Date(Date.parse(`${today}T00:00:00Z`) + 60 * 86_400_000))) } },
      orderBy: { holidayDate: 'asc' },
      take: 6,
      select: { holidayDate: true, name: true },
    }),
    prisma.payrollEntry.findMany({
      where: { employeeId, run: { status: 'FINALIZED' } },
      orderBy: { run: { year: 'desc' } },
      take: 6,
      include: { run: { select: { year: true, month: true } } },
    }).then((rows) =>
      rows
        .sort((a, b) => b.run.year * 100 + b.run.month - (a.run.year * 100 + a.run.month))
        .slice(0, 3)
        .map((e) => ({ id: e.id, period: `${e.run.year}-${String(e.run.month).padStart(2, '0')}`, netPaise: e.netPaise, paymentStatus: e.paymentStatus })),
    ),
    visibleAnnouncements(auth, 5),
  ]);
  return {
    profile: {
      name: `${profile.firstName} ${profile.lastName}`,
      employeeCode: profile.employeeCode,
      designation: profile.designation.title,
      department: profile.department.name,
      manager: profile.manager ? `${profile.manager.firstName} ${profile.manager.lastName}` : null,
      location: profile.workLocation,
      joiningDate: ymdOf(profile.joiningDate),
    },
    attendance,
    leaveBalances: balances.items,
    upcomingHolidays: holidays.map((h) => ({ date: ymdOf(h.holidayDate), name: h.name })),
    recentPayslips: payslips,
    announcements,
  };
}
