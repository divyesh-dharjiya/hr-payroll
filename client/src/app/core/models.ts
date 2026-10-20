// Types mirror the API responses. They describe what the server sends; the server stays the source of truth.

export type Role = 'SUPER_ADMIN' | 'HR_ADMIN' | 'MANAGER' | 'EMPLOYEE';

export type Permission =
  | 'employees:read'
  | 'employees:write'
  | 'employees:sensitive'
  | 'employees:export'
  | 'attendance:manage'
  | 'leave:manage'
  | 'payroll:read'
  | 'payroll:manage'
  | 'payroll:approve'
  | 'payroll:bank-export'
  | 'org:manage'
  | 'audit:read'
  | 'reports:read'
  | 'roles:manage';

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  employeeId: string | null;
  organizationId: string;
  photoUrl: string | null;
  title: string | null;
  permissions: Permission[];
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type AttendanceStatus = 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' | 'ON_LEAVE' | 'HOLIDAY' | 'WEEKLY_OFF' | 'WFH' | 'NOT_EMPLOYED' | 'FUTURE';

export interface AttendanceRecordView {
  id: string;
  workDate: string;
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  breakMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
}

export type LeaveStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'CANCEL_REQUESTED';

export interface PayrollEntryRow {
  id: string;
  employee: { id: string; employeeCode: string; name: string; department: string };
  paidDays: number;
  lopDays: number;
  grossPaise: number;
  totalDeductionsPaise: number;
  netPaise: number;
  employerContribPaise: number;
  paymentStatus: 'NOT_PAID' | 'PAID';
  paymentReference: string | null;
  paidAt: string | null;
  exceptions: { code: string; message: string; severity: 'error' | 'warning' }[];
}

export type PayrollStatus = 'DRAFT' | 'VALIDATED' | 'APPROVED' | 'FINALIZED';
