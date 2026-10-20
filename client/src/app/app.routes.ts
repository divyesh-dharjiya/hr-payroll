import { Routes } from '@angular/router';
import { authGuard, guestGuard, permissionGuard } from './core/guards';

// Every feature is lazy-loaded, so the first screen downloads only the code it needs.
export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'PeopleHub | HR, attendance, leave and payroll software for Indian SMEs',
    loadComponent: () => import('./features/landing/landing').then((m) => m.LandingPage),
  },
  {
    path: 'login',
    canActivate: [guestGuard],
    title: 'Sign in | PeopleHub',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.LoginPage),
  },
  {
    path: 'forgot-password',
    canActivate: [guestGuard],
    title: 'Reset password | PeopleHub',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.ForgotPasswordPage),
  },
  {
    path: 'reset-password',
    canActivate: [guestGuard],
    title: 'Choose a new password | PeopleHub',
    loadComponent: () => import('./features/auth/auth-pages').then((m) => m.ResetPasswordPage),
  },
  {
    path: '',
    // Lazy: the signed-in shell (menus, dialogs, notifications) is not downloaded for the public pages.
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    canActivate: [authGuard],
    children: [
      {
        path: 'dashboard',
        title: 'Dashboard | PeopleHub',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.Dashboard),
      },
      {
        path: 'employees',
        canActivate: [permissionGuard('employees:read')],
        title: 'Employees | PeopleHub',
        loadComponent: () => import('./features/employees/employee-list').then((m) => m.EmployeeList),
      },
      {
        path: 'employees/new',
        canActivate: [permissionGuard('employees:write')],
        title: 'Add employee | PeopleHub',
        loadComponent: () => import('./features/employees/employee-form').then((m) => m.EmployeeForm),
      },
      {
        path: 'employees/import',
        canActivate: [permissionGuard('employees:write')],
        title: 'Import employees | PeopleHub',
        loadComponent: () => import('./features/employees/employee-import').then((m) => m.EmployeeImport),
      },
      {
        path: 'employees/:id',
        title: 'Employee profile | PeopleHub',
        loadComponent: () => import('./features/employees/employee-detail').then((m) => m.EmployeeDetailPage),
      },
      {
        path: 'employees/:id/edit',
        canActivate: [permissionGuard('employees:write')],
        title: 'Edit employee | PeopleHub',
        loadComponent: () => import('./features/employees/employee-form').then((m) => m.EmployeeForm),
      },
      {
        path: 'attendance',
        title: 'Attendance | PeopleHub',
        loadComponent: () => import('./features/attendance/attendance-page').then((m) => m.AttendancePage),
      },
      {
        path: 'leave',
        title: 'Leave | PeopleHub',
        loadComponent: () => import('./features/leave/leave-page').then((m) => m.LeavePage),
      },
      {
        path: 'payroll',
        canActivate: [permissionGuard('payroll:read')],
        title: 'Payroll | PeopleHub',
        loadComponent: () => import('./features/payroll/payroll-page').then((m) => m.PayrollPage),
      },
      {
        path: 'payroll/:id',
        canActivate: [permissionGuard('payroll:read')],
        title: 'Payroll run | PeopleHub',
        loadComponent: () => import('./features/payroll/payroll-run-page').then((m) => m.PayrollRunPage),
      },
      {
        path: 'payslips',
        title: 'My payslips | PeopleHub',
        loadComponent: () => import('./features/payroll/payslip-pages').then((m) => m.MyPayslipsPage),
      },
      {
        path: 'payslips/:id',
        title: 'Payslip | PeopleHub',
        loadComponent: () => import('./features/payroll/payslip-pages').then((m) => m.PayslipPage),
      },
      {
        path: 'reports',
        canActivate: [permissionGuard('reports:read')],
        title: 'Reports | PeopleHub',
        loadComponent: () => import('./features/reports/reports-page').then((m) => m.ReportsPage),
      },
      {
        path: 'admin/holidays',
        title: 'Holidays | PeopleHub',
        loadComponent: () => import('./features/admin/admin-pages').then((m) => m.HolidaysPage),
      },
      {
        path: 'admin/announcements',
        title: 'Announcements | PeopleHub',
        loadComponent: () => import('./features/admin/admin-pages').then((m) => m.AnnouncementsPage),
      },
      {
        path: 'admin/organization',
        canActivate: [permissionGuard('org:manage')],
        title: 'Organization | PeopleHub',
        loadComponent: () => import('./features/admin/admin-pages').then((m) => m.OrganizationPage),
      },
      {
        path: 'admin/audit',
        canActivate: [permissionGuard('audit:read')],
        title: 'Audit log | PeopleHub',
        loadComponent: () => import('./features/admin/admin-pages').then((m) => m.AuditPage),
      },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
