import { db } from '../../db';
import type { Employee } from '../../db/schema';
import { addDays, eachDay, todayIn, weekdayOf } from '../../lib/time';
import { Router, requireAuth } from '../../http/router';
import type { AuthContext } from '../../security/session';
import { balancesFor } from '../leave/leave.service';
import { getToday, loadRules } from '../attendance/attendance.service';
import { fullName } from '../employees/employees.service';
import { visibleAnnouncements } from '../org/org.routes';

export const dashboardRouter = new Router('/dashboard');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const PRESENT_STATUSES = ['PRESENT', 'LATE', 'HALF_DAY', 'WFH'];

/** Single entry point: returns the dashboard that matches the caller's role and data scope. */
dashboardRouter.get('/', (req) => {
  const auth = requireAuth(req);
  const rules = loadRules(auth.organizationId);
  const today = todayIn(rules.timezone);
  if (auth.role === 'HR_ADMIN' || auth.role === 'SUPER_ADMIN') {
    return { view: 'hr', ...hrDashboard(auth.organizationId, today, rules.weeklyOffDays) };
  }
  if (auth.role === 'MANAGER') return { view: 'manager', ...managerDashboard(auth, today) };
  return { view: 'employee', ...employeeDashboard(auth, today) };
});

dashboardRouter.get('/announcements', (req) => ({ items: announcementsFor(requireAuth(req)) }));

function announcementsFor(auth: Pick<AuthContext, 'organizationId' | 'role' | 'employeeId'>) {
  return visibleAnnouncements(auth, 5).map((a) => ({ id: a.id, title: a.title, body: a.body, publishAt: a.publishAt, expiresAt: a.expiresAt }));
}

/** Upcoming birthdays and work anniversaries within `days` days from today (calendar match, year-agnostic). */
function upcomingEvents(rows: Employee[], today: string, days: number) {
  const window = eachDay(today, addDays(today, days));
  const md = (ymd: string) => ymd.slice(5);
  const birthdays: { id: string; name: string; date: string; designation: string; photoUrl: string | null }[] = [];
  const anniversaries: { id: string; name: string; date: string; years: number; designation: string; photoUrl: string | null }[] = [];
  for (const r of rows) {
    const name = fullName(r);
    const designation = db.designations.get(r.designationId)?.title ?? '';
    if (r.dateOfBirth) {
      const hit = window.find((d) => md(d) === md(r.dateOfBirth!));
      if (hit) birthdays.push({ id: r.id, name, date: hit, designation, photoUrl: r.photoUrl });
    }
    const hit = window.find((d) => md(d) === md(r.joiningDate));
    if (hit) {
      const years = Number(hit.slice(0, 4)) - Number(r.joiningDate.slice(0, 4));
      if (years > 0) anniversaries.push({ id: r.id, name, date: hit, years, designation, photoUrl: r.photoUrl });
    }
  }
  const byDate = (a: { date: string }, b: { date: string }) => a.date.localeCompare(b.date);
  return { birthdays: birthdays.sort(byDate), anniversaries: anniversaries.sort(byDate) };
}

function hrDashboard(orgId: string, today: string, weeklyOffDays: number[]) {
  const period = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
  const inOrg = (r: { organizationId: string }) => r.organizationId === orgId;
  const employed = db.employees.filter((e) => inOrg(e) && e.status !== 'EXITED');

  const activeCount = employed.filter((e) => e.status === 'ACTIVE').length;
  const totalCount = employed.length;
  const todayRecords = db.attendanceRecords.by('workDate', today).filter(inOrg);
  const onLeaveIds = new Set(
    db.leaveRequests.filter((l) => inOrg(l) && l.status === 'APPROVED' && l.startDate <= today && l.endDate >= today).map((l) => l.employeeId),
  );
  const pendingLeave = db.leaveRequests.count((l) => inOrg(l) && l.status === 'PENDING');
  const pendingCorrections = db.attendanceCorrections.count((c) => inOrg(c) && c.status === 'PENDING');
  const pendingOvertime = db.attendanceRecords.count((r) => inOrg(r) && r.overtimeStatus === 'PENDING');
  const runs = db.payrollRuns.filter(inOrg).sort((a, b) => b.year * 100 + b.month - (a.year * 100 + a.month));
  // The most recent run, whatever its status: payroll for a month is usually run after it ends.
  const currentRun = runs.find((r) => r.year * 100 + r.month <= period.year * 100 + period.month);
  const recentRuns = runs.filter((r) => r.status === 'FINALIZED').slice(0, 6);
  const activities = db.auditLogs
    .filter(inOrg)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8);
  const missingBank = db.employees.count((e) => inOrg(e) && e.status === 'ACTIVE' && !e.bankAccountNumber);
  const holidayToday = db.holidays.find((h) => inOrg(h) && h.holidayDate === today);

  const present = todayRecords.filter((r) => PRESENT_STATUSES.includes(r.status) && r.checkInAt).length;
  const late = todayRecords.filter((r) => r.status === 'LATE').length;
  const isWorkingDay = !holidayToday && !weeklyOffDays.includes(weekdayOf(today));
  const onLeave = onLeaveIds.size;
  // Everyone still employed (active or on notice) is expected at work.
  const notCheckedIn = isWorkingDay ? Math.max(0, totalCount - present - onLeave) : 0;

  const events = upcomingEvents(employed, today, 30);
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
      pendingOvertime,
      employeesMissingBankDetails: missingBank,
    },
    today: { date: today, isWorkingDay, holiday: holidayToday?.name ?? null },
    payroll: currentRun
      ? {
          period: { year: currentRun.year, month: currentRun.month },
          status: currentRun.status,
          grossPaise: currentRun.totalGrossPaise,
          employerPaise: currentRun.totalEmployerPaise,
          expensePaise: currentRun.totalGrossPaise + currentRun.totalEmployerPaise,
        }
      : { period, status: null, grossPaise: 0, employerPaise: 0, expensePaise: 0 },
    departmentDistribution: db.departments
      .filter(inOrg)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({ id: d.id, name: d.name, count: employed.filter((e) => e.departmentId === d.id).length })),
    attendanceTrend: trendLast14(orgId, today),
    payrollTrend,
    birthdays: events.birthdays,
    anniversaries: events.anniversaries,
    recentActivity: activities.map((a) => ({ id: a.id, action: a.action, actor: a.actorEmail, entityType: a.entityType, at: a.createdAt })),
    pendingTasks: [
      ...(pendingLeave > 0 ? [{ key: 'leave', label: `${pendingLeave} leave request(s) waiting for decision`, href: '/leave' }] : []),
      ...(pendingCorrections > 0 ? [{ key: 'corrections', label: `${pendingCorrections} attendance correction(s) to review`, href: '/attendance' }] : []),
      ...(pendingOvertime > 0 ? [{ key: 'overtime', label: `${pendingOvertime} day(s) of overtime to approve`, href: '/attendance' }] : []),
      ...(missingBank > 0 ? [{ key: 'bank', label: `${missingBank} active employee(s) without bank details`, href: '/employees' }] : []),
      ...(currentRun && currentRun.status !== 'FINALIZED'
        ? [{ key: 'payroll', label: `Payroll for ${MONTHS[currentRun.month - 1]} ${currentRun.year} is ${currentRun.status.toLowerCase()}`, href: '/payroll' }]
        : []),
    ],
    announcements: announcementsFor({ organizationId: orgId, role: 'HR_ADMIN', employeeId: null }),
  };
}

/** Attendance trend for the last 14 days: present-type counts from attendance records. */
function trendLast14(orgId: string, today: string) {
  return eachDay(addDays(today, -13), today).map((date) => {
    const rows = db.attendanceRecords.by('workDate', date).filter((r) => r.organizationId === orgId);
    return {
      date,
      present: rows.filter((r) => ['PRESENT', 'WFH', 'HALF_DAY'].includes(r.status)).length,
      late: rows.filter((r) => r.status === 'LATE').length,
    };
  });
}

function managerDashboard(auth: AuthContext, today: string) {
  const orgId = auth.organizationId;
  const inTeam = (e: Employee | undefined) => Boolean(e && e.organizationId === orgId && e.managerId === auth.employeeId && auth.employeeId && e.status !== 'EXITED');
  const teamOf = (employeeId: string) => inTeam(db.employees.get(employeeId));
  const in14 = addDays(today, 14);

  const team = db.employees.filter(inTeam).sort((a, b) => a.firstName.localeCompare(b.firstName));
  const teamToday = db.attendanceRecords.by('workDate', today).filter((r) => teamOf(r.employeeId));
  const pendingApprovals = db.leaveRequests
    .filter((l) => l.organizationId === orgId && l.status === 'PENDING' && teamOf(l.employeeId))
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 20);
  const upcomingAbsences = db.leaveRequests
    .filter((l) => l.organizationId === orgId && l.status === 'APPROVED' && l.startDate <= in14 && l.endDate >= today && teamOf(l.employeeId))
    .sort((a, b) => a.startDate.localeCompare(b.startDate))
    .slice(0, 20);
  const pendingOvertime = db.attendanceRecords.count((r) => r.organizationId === orgId && r.overtimeStatus === 'PENDING' && teamOf(r.employeeId));
  const pendingCorrections = db.attendanceCorrections.count((c) => c.organizationId === orgId && c.status === 'PENDING' && teamOf(c.employeeId));

  const present = teamToday.filter((r) => r.checkInAt).length;
  const late = teamToday.filter((r) => r.status === 'LATE').length;
  const onLeave = upcomingAbsences.filter((l) => l.startDate <= today && l.endDate >= today).length;
  const leaveCode = (id: string) => db.leaveTypes.get(id)?.code ?? '';
  const nameOf = (employeeId: string) => fullName(db.employees.get(employeeId)!);
  return {
    kpis: {
      teamSize: team.length,
      presentToday: present,
      lateToday: late,
      onLeaveToday: onLeave,
      notCheckedIn: Math.max(0, team.length - present - onLeave),
      pendingApprovals: pendingApprovals.length,
      pendingOvertime,
      pendingCorrections,
    },
    team: team.map((t) => ({
      id: t.id,
      employeeCode: t.employeeCode,
      name: fullName(t),
      photoUrl: t.photoUrl,
      status: t.status,
      designation: db.designations.get(t.designationId)?.title ?? '',
      department: db.departments.get(t.departmentId)?.name ?? '',
      email: t.workEmail,
      phone: t.phone,
    })),
    pendingApprovals: pendingApprovals.map((p) => ({ id: p.id, employee: nameOf(p.employeeId), leaveType: leaveCode(p.leaveTypeId), startDate: p.startDate, endDate: p.endDate, days: p.days })),
    upcomingAbsences: upcomingAbsences.map((l) => ({ id: l.id, employee: nameOf(l.employeeId), leaveType: leaveCode(l.leaveTypeId), startDate: l.startDate, endDate: l.endDate })),
    announcements: announcementsFor(auth),
  };
}

function employeeDashboard(auth: AuthContext, today: string) {
  const orgId = auth.organizationId;
  if (!auth.employeeId) {
    return { profile: null, message: 'Your account is not linked to an employee profile yet. Contact HR.', announcements: announcementsFor(auth) };
  }
  const profile = db.employees.get(auth.employeeId)!;
  const manager = db.employees.get(profile.managerId);
  const in60 = addDays(today, 60);
  const holidays = db.holidays
    .filter((h) => h.organizationId === orgId && h.holidayDate >= today && h.holidayDate <= in60)
    .sort((a, b) => a.holidayDate.localeCompare(b.holidayDate))
    .slice(0, 6);
  const payslips = db.payrollEntries
    .by('employeeId', auth.employeeId)
    .map((e) => ({ e, run: db.payrollRuns.get(e.payrollRunId)! }))
    .filter(({ run }) => run?.status === 'FINALIZED')
    .sort((a, b) => b.run.year * 100 + b.run.month - (a.run.year * 100 + a.run.month))
    .slice(0, 3)
    .map(({ e, run }) => ({ id: e.id, period: `${run.year}-${String(run.month).padStart(2, '0')}`, netPaise: e.netPaise, paymentStatus: e.paymentStatus }));
  return {
    profile: {
      name: fullName(profile),
      employeeCode: profile.employeeCode,
      designation: db.designations.get(profile.designationId)?.title ?? '',
      department: db.departments.get(profile.departmentId)?.name ?? '',
      manager: manager ? fullName(manager) : null,
      location: profile.workLocation,
      joiningDate: profile.joiningDate,
    },
    attendance: getToday(auth),
    leaveBalances: balancesFor(auth).items,
    upcomingHolidays: holidays.map((h) => ({ date: h.holidayDate, name: h.name })),
    recentPayslips: payslips,
    announcements: announcementsFor(auth),
  };
}
