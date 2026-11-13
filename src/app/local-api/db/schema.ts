// PeopleHub data model, stored in the browser.
// Conventions:
//  - Every company-owned row carries `organizationId` (multi-tenant ready) and is always filtered by it.
//  - Money is stored as integer paise (1 INR = 100 paise). Never use floats for money.
//  - Calendar dates (attendance day, leave day, holiday) are `Ymd` strings; instants are ISO-8601 UTC strings.

/** Calendar date, YYYY-MM-DD. */
export type Ymd = string;
/** Instant, ISO-8601 in UTC (`Date.prototype.toISOString`). */
export type Instant = string;

export type Role = 'SUPER_ADMIN' | 'HR_ADMIN' | 'MANAGER' | 'EMPLOYEE';
export type EmployeeStatus = 'ACTIVE' | 'ON_NOTICE' | 'EXITED';
export type EmploymentType = 'FULL_TIME' | 'PART_TIME' | 'CONTRACT' | 'INTERN';
export type OnboardingStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETE';
export type AttendanceStatus = 'PRESENT' | 'LATE' | 'HALF_DAY' | 'ABSENT' | 'ON_LEAVE' | 'HOLIDAY' | 'WEEKLY_OFF' | 'WFH';
// Overtime is paid only after a manager or HR approves it (see attendance.rules.ts: overtimeAfterRecalc).
export type OvertimeStatus = 'NONE' | 'PENDING' | 'APPROVED' | 'REJECTED';
export type CorrectionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type LeaveAccrual = 'UPFRONT' | 'MONTHLY';
export type LeaveRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'CANCEL_REQUESTED';
export type PayrollStatus = 'DRAFT' | 'VALIDATED' | 'APPROVED' | 'FINALIZED';
export type PaymentStatus = 'NOT_PAID' | 'PAID';
export type AdjustmentKind = 'EARNING' | 'DEDUCTION';

export interface Organization {
  id: string;
  name: string;
  legalName: string | null;
  logoUrl: string | null;
  timezone: string;
  currency: string;
  /** 0 = Sunday ... 6 = Saturday */
  weeklyOffDays: number[];
  financialYearStartMonth: number;
  /** HH:mm in the organization timezone. */
  shiftStart: string;
  shiftEnd: string;
  graceMinutes: number;
  standardBreakMinutes: number;
  breakDeductionAfterMinutes: number;
  // Payroll rule configuration (rates are basis points: 1200 = 12.00%)
  pfEmployeeRateBps: number;
  pfEmployerRateBps: number;
  pfWageCeilingPaise: number;
  esiEmployeeRateBps: number;
  esiEmployerRateBps: number;
  esiGrossCeilingPaise: number;
  /** 0 = overtime not paid until configured. */
  overtimeMultiplierBps: number;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface User {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
  isActive: boolean;
  /** Changes on sign-out and password reset, which revokes earlier sessions. */
  tokenVersion: number;
  failedLoginCount: number;
  lockedUntil: Instant | null;
  lastLoginAt: Instant | null;
  passwordResetTokenHash: string | null;
  passwordResetExpiresAt: Instant | null;
  employeeId: string | null;
  createdAt: Instant;
  updatedAt: Instant;
}

/** In-app notifications (leave decisions, approvals waiting, payslips ready). Delivered to one user each. */
export interface Notification {
  id: string;
  organizationId: string;
  userId: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  readAt: Instant | null;
  createdAt: Instant;
}

export interface Department {
  id: string;
  organizationId: string;
  name: string;
  code: string;
  createdAt: Instant;
}

export interface Designation {
  id: string;
  organizationId: string;
  title: string;
  createdAt: Instant;
}

export interface Employee {
  id: string;
  organizationId: string;
  employeeCode: string;
  firstName: string;
  lastName: string;
  workEmail: string;
  personalEmail: string | null;
  phone: string | null;
  /** A `data:` URL of the resized profile photo, or null for the generated avatar. */
  photoUrl: string | null;
  dateOfBirth: Ymd | null;
  joiningDate: Ymd;
  /** The last working day. */
  exitDate: Ymd | null;
  status: EmployeeStatus;
  onboardingStatus: OnboardingStatus;
  employmentType: EmploymentType;
  workLocation: string;
  departmentId: string;
  designationId: string;
  managerId: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  addressLine: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  // Restricted fields: only the last four characters are ever shown, except through the audited reveal endpoint.
  bankAccountNumber: string | null;
  bankAccountLast4: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  panNumber: string | null;
  panLast4: string | null;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface SalaryAssignment {
  id: string;
  organizationId: string;
  employeeId: string;
  effectiveFrom: Ymd;
  basicPaise: number;
  hraPaise: number;
  conveyancePaise: number;
  specialPaise: number;
  otherAllowancePaise: number;
  // Eligibility flags are explicit: nothing is assumed applicable.
  pfApplicable: boolean;
  esiApplicable: boolean;
  professionalTaxPaise: number;
  /** Entered by HR from the employee's tax computation (no statutory slabs are hardcoded). */
  monthlyTdsPaise: number;
  createdById: string | null;
  createdAt: Instant;
}

export interface AttendanceRecord {
  id: string;
  organizationId: string;
  employeeId: string;
  workDate: Ymd;
  status: AttendanceStatus;
  checkInAt: Instant | null;
  checkOutAt: Instant | null;
  breakMinutes: number;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  // Overtime approval: only approved minutes are paid. Minutes may be approved in part.
  overtimeStatus: OvertimeStatus;
  overtimeApprovedMinutes: number;
  overtimeReviewerId: string | null;
  overtimeReviewedAt: Instant | null;
  overtimeComment: string | null;
  note: string | null;
  createdAt: Instant;
  updatedAt: Instant;
}

/** One punch-in / punch-out session. A day can have many; the AttendanceRecord holds the day's totals. */
export interface AttendancePunch {
  id: string;
  organizationId: string;
  employeeId: string;
  attendanceRecordId: string;
  inAt: Instant;
  outAt: Instant | null;
  /** Set when an unclosed session from an earlier day was closed automatically at that day's shift end. */
  autoClosed: boolean;
  createdAt: Instant;
}

export interface AttendanceCorrection {
  id: string;
  organizationId: string;
  employeeId: string;
  workDate: Ymd;
  requestedCheckIn: Instant | null;
  requestedCheckOut: Instant | null;
  reason: string;
  status: CorrectionStatus;
  reviewerId: string | null;
  reviewComment: string | null;
  reviewedAt: Instant | null;
  createdAt: Instant;
}

export interface Holiday {
  id: string;
  organizationId: string;
  holidayDate: Ymd;
  name: string;
  createdAt: Instant;
}

export interface LeaveType {
  id: string;
  organizationId: string;
  code: string;
  name: string;
  isPaid: boolean;
  annualQuotaDays: number;
  accrual: LeaveAccrual;
  allowHalfDay: boolean;
  carryForwardDays: number;
  isActive: boolean;
  createdAt: Instant;
}

export interface LeaveRequest {
  id: string;
  organizationId: string;
  employeeId: string;
  leaveTypeId: string;
  startDate: Ymd;
  endDate: Ymd;
  isHalfDay: boolean;
  days: number;
  reason: string;
  status: LeaveRequestStatus;
  deciderId: string | null;
  decisionComment: string | null;
  decidedAt: Instant | null;
  cancelReason: string | null;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface PayrollRun {
  id: string;
  organizationId: string;
  year: number;
  month: number;
  status: PayrollStatus;
  createdById: string;
  validatedAt: Instant | null;
  approvedById: string | null;
  approvedAt: Instant | null;
  finalizedById: string | null;
  finalizedAt: Instant | null;
  totalGrossPaise: number;
  totalDeductionsPaise: number;
  totalNetPaise: number;
  totalEmployerPaise: number;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface PayrollEntry {
  id: string;
  organizationId: string;
  payrollRunId: string;
  employeeId: string;
  paidDays: number;
  lopDays: number;
  grossPaise: number;
  totalDeductionsPaise: number;
  netPaise: number;
  employerContribPaise: number;
  /** Snapshot of inputs and computed lines, frozen once the run is finalized. */
  snapshot: PayrollSnapshot;
  paymentStatus: PaymentStatus;
  paidAt: Instant | null;
  paymentReference: string | null;
  createdAt: Instant;
}

export interface PayrollLineSnapshot {
  code: string;
  label: string;
  amountPaise: number;
}

export interface PayrollSnapshot {
  version: 1;
  calculatedAt: Instant;
  period: { year: number; month: number; daysInMonth: number };
  rules: Record<string, number>;
  inputs: Record<string, unknown>;
  lines: { earnings: PayrollLineSnapshot[]; deductions: PayrollLineSnapshot[]; employerContributions: PayrollLineSnapshot[] };
  exceptions: { code: string; message: string; severity: 'error' | 'warning' }[];
}

export interface PayrollAdjustment {
  id: string;
  organizationId: string;
  employeeId: string;
  year: number;
  month: number;
  kind: AdjustmentKind;
  label: string;
  amountPaise: number;
  createdById: string;
  createdAt: Instant;
}

export interface Announcement {
  id: string;
  organizationId: string;
  title: string;
  body: string;
  publishAt: Instant;
  expiresAt: Instant | null;
  audienceRole: Role | null;
  departmentId: string | null;
  createdById: string;
  createdAt: Instant;
}

export interface AuditLog {
  id: string;
  organizationId: string;
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: Instant;
}
