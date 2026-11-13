import type {
  Announcement,
  AttendanceCorrection,
  AttendancePunch,
  AttendanceRecord,
  AuditLog,
  Department,
  Designation,
  Employee,
  Holiday,
  LeaveRequest,
  LeaveType,
  Notification,
  Organization,
  PayrollAdjustment,
  PayrollEntry,
  PayrollRun,
  SalaryAssignment,
  User,
} from './schema';
import { Table, type Journal, type TableOptions } from './table';

// ---------------------------------------------------------------------------------------------------------------
// The whole PeopleHub database: one Table per entity, held in memory and saved to browser storage (see storage.ts).
// Each API request runs inside `transaction()`: if the handler throws, every change it made is undone, so a request
// either applies completely or not at all (like a SQL transaction).
// ---------------------------------------------------------------------------------------------------------------

export class Database implements Journal {
  private undo: (() => void)[] | null = null;
  private dirty = new Set<string>();
  private readonly registry: Table<never, never>[] = [];

  readonly organizations = this.table<Organization, 'legalName' | 'logoUrl'>('organizations', {
    defaults: () => ({ legalName: null, logoUrl: null }),
    updatedAt: true,
  });

  readonly users = this.table<
    User,
    'isActive' | 'tokenVersion' | 'failedLoginCount' | 'lockedUntil' | 'lastLoginAt' | 'passwordResetTokenHash' | 'passwordResetExpiresAt' | 'employeeId'
  >('users', {
    defaults: () => ({
      isActive: true,
      tokenVersion: 0,
      failedLoginCount: 0,
      lockedUntil: null,
      lastLoginAt: null,
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
      employeeId: null,
    }),
    unique: [['email'], ['employeeId']],
    updatedAt: true,
  });

  readonly notifications = this.table<Notification, 'link' | 'readAt'>('notifications', {
    defaults: () => ({ link: null, readAt: null }),
    index: ['userId'],
  });

  readonly departments = this.table<Department>('departments', {
    unique: [['organizationId', 'name'], ['organizationId', 'code']],
  });

  readonly designations = this.table<Designation>('designations', {
    unique: [['organizationId', 'title']],
  });

  readonly employees = this.table<
    Employee,
    | 'personalEmail' | 'phone' | 'photoUrl' | 'dateOfBirth' | 'exitDate' | 'status' | 'onboardingStatus' | 'employmentType'
    | 'workLocation' | 'managerId' | 'emergencyContactName' | 'emergencyContactPhone' | 'addressLine' | 'city' | 'state'
    | 'postalCode' | 'bankAccountNumber' | 'bankAccountLast4' | 'bankIfsc' | 'bankName' | 'panNumber' | 'panLast4'
  >('employees', {
    defaults: () => ({
      personalEmail: null,
      phone: null,
      photoUrl: null,
      dateOfBirth: null,
      exitDate: null,
      status: 'ACTIVE',
      onboardingStatus: 'PENDING',
      employmentType: 'FULL_TIME',
      workLocation: 'Head Office',
      managerId: null,
      emergencyContactName: null,
      emergencyContactPhone: null,
      addressLine: null,
      city: null,
      state: null,
      postalCode: null,
      bankAccountNumber: null,
      bankAccountLast4: null,
      bankIfsc: null,
      bankName: null,
      panNumber: null,
      panLast4: null,
    }),
    unique: [['organizationId', 'employeeCode'], ['organizationId', 'workEmail']],
    index: ['managerId'],
    updatedAt: true,
  });

  readonly salaryAssignments = this.table<
    SalaryAssignment,
    'hraPaise' | 'conveyancePaise' | 'specialPaise' | 'otherAllowancePaise' | 'pfApplicable' | 'esiApplicable' | 'professionalTaxPaise' | 'monthlyTdsPaise' | 'createdById'
  >('salaryAssignments', {
    defaults: () => ({
      hraPaise: 0,
      conveyancePaise: 0,
      specialPaise: 0,
      otherAllowancePaise: 0,
      pfApplicable: false,
      esiApplicable: false,
      professionalTaxPaise: 0,
      monthlyTdsPaise: 0,
      createdById: null,
    }),
    unique: [['employeeId', 'effectiveFrom']],
    index: ['employeeId'],
  });

  readonly attendanceRecords = this.table<
    AttendanceRecord,
    | 'checkInAt' | 'checkOutAt' | 'breakMinutes' | 'workedMinutes' | 'lateMinutes' | 'overtimeMinutes' | 'overtimeStatus'
    | 'overtimeApprovedMinutes' | 'overtimeReviewerId' | 'overtimeReviewedAt' | 'overtimeComment' | 'note'
  >('attendanceRecords', {
    defaults: () => ({
      checkInAt: null,
      checkOutAt: null,
      breakMinutes: 0,
      workedMinutes: 0,
      lateMinutes: 0,
      overtimeMinutes: 0,
      overtimeStatus: 'NONE',
      overtimeApprovedMinutes: 0,
      overtimeReviewerId: null,
      overtimeReviewedAt: null,
      overtimeComment: null,
      note: null,
    }),
    unique: [['employeeId', 'workDate']],
    index: ['employeeId', 'workDate'],
    updatedAt: true,
  });

  readonly attendancePunches = this.table<AttendancePunch, 'outAt' | 'autoClosed'>('attendancePunches', {
    defaults: () => ({ outAt: null, autoClosed: false }),
    index: ['employeeId', 'attendanceRecordId'],
  });

  readonly attendanceCorrections = this.table<
    AttendanceCorrection,
    'requestedCheckIn' | 'requestedCheckOut' | 'status' | 'reviewerId' | 'reviewComment' | 'reviewedAt'
  >('attendanceCorrections', {
    defaults: () => ({ requestedCheckIn: null, requestedCheckOut: null, status: 'PENDING', reviewerId: null, reviewComment: null, reviewedAt: null }),
    index: ['employeeId'],
  });

  readonly holidays = this.table<Holiday>('holidays', {
    unique: [['organizationId', 'holidayDate']],
  });

  readonly leaveTypes = this.table<LeaveType, 'isPaid' | 'accrual' | 'allowHalfDay' | 'carryForwardDays' | 'isActive'>('leaveTypes', {
    defaults: () => ({ isPaid: true, accrual: 'UPFRONT', allowHalfDay: true, carryForwardDays: 0, isActive: true }),
    unique: [['organizationId', 'code']],
  });

  readonly leaveRequests = this.table<
    LeaveRequest,
    'isHalfDay' | 'status' | 'deciderId' | 'decisionComment' | 'decidedAt' | 'cancelReason'
  >('leaveRequests', {
    defaults: () => ({ isHalfDay: false, status: 'PENDING', deciderId: null, decisionComment: null, decidedAt: null, cancelReason: null }),
    index: ['employeeId'],
    updatedAt: true,
  });

  readonly payrollRuns = this.table<
    PayrollRun,
    | 'status' | 'validatedAt' | 'approvedById' | 'approvedAt' | 'finalizedById' | 'finalizedAt' | 'totalGrossPaise'
    | 'totalDeductionsPaise' | 'totalNetPaise' | 'totalEmployerPaise'
  >('payrollRuns', {
    defaults: () => ({
      status: 'DRAFT',
      validatedAt: null,
      approvedById: null,
      approvedAt: null,
      finalizedById: null,
      finalizedAt: null,
      totalGrossPaise: 0,
      totalDeductionsPaise: 0,
      totalNetPaise: 0,
      totalEmployerPaise: 0,
    }),
    unique: [['organizationId', 'year', 'month']],
    updatedAt: true,
  });

  readonly payrollEntries = this.table<PayrollEntry, 'paymentStatus' | 'paidAt' | 'paymentReference'>('payrollEntries', {
    defaults: () => ({ paymentStatus: 'NOT_PAID', paidAt: null, paymentReference: null }),
    unique: [['payrollRunId', 'employeeId']],
    index: ['payrollRunId', 'employeeId'],
  });

  readonly payrollAdjustments = this.table<PayrollAdjustment>('payrollAdjustments', {
    index: ['employeeId'],
  });

  readonly announcements = this.table<Announcement, 'publishAt' | 'expiresAt' | 'audienceRole' | 'departmentId'>('announcements', {
    defaults: () => ({ publishAt: new Date().toISOString(), expiresAt: null, audienceRole: null, departmentId: null }),
  });

  readonly auditLogs = this.table<AuditLog, 'actorId' | 'actorEmail' | 'entityId' | 'summary' | 'ipAddress'>('auditLogs', {
    defaults: () => ({ actorId: null, actorEmail: null, entityId: null, summary: null, ipAddress: null }),
  });

  private table<T extends { id: string; createdAt: string }, D extends keyof T = never>(
    name: string,
    options: TableOptions<T, D>,
  ): Table<T, D> {
    const t = new Table<T, D>(name, options, this);
    this.registry.push(t as unknown as Table<never, never>);
    return t;
  }

  // -- Journal ------------------------------------------------------------------------------------------------

  record(undo: () => void): void {
    this.undo?.push(undo);
  }

  markDirty(table: string): void {
    this.dirty.add(table);
  }

  /**
   * Runs `work` as one unit. Changes are kept when it succeeds and undone when it throws, unless the error was
   * marked with `withChangesKept` (lib/errors.ts). Nested calls join the outer transaction.
   */
  async transaction<R>(work: () => R | Promise<R>): Promise<R> {
    if (this.undo) return work();
    this.undo = [];
    try {
      const result = await work();
      this.undo = null;
      return result;
    } catch (err) {
      const log = this.undo ?? [];
      this.undo = null;
      if (!(err as { keepChanges?: boolean } | null)?.keepChanges) {
        for (let i = log.length - 1; i >= 0; i--) log[i]();
      }
      throw err;
    }
  }

  // -- Snapshots for storage ----------------------------------------------------------------------------------

  /** Names of the tables changed since the last call, and clears the list. */
  takeDirty(): string[] {
    const names = [...this.dirty];
    this.dirty.clear();
    return names;
  }

  tableNames(): string[] {
    return this.registry.map((t) => t.name);
  }

  dump(names = this.tableNames()): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const t of this.registry) if (names.includes(t.name)) out[t.name] = t.all();
    return out;
  }

  restore(data: Record<string, unknown[]>): void {
    for (const t of this.registry) t.load((data[t.name] ?? []) as never[]);
    this.dirty.clear();
  }

  /** Empties every table. All of them count as changed, so the next save also clears them in storage. */
  clear(): void {
    for (const t of this.registry) t.load([]);
    for (const t of this.registry) this.dirty.add(t.name);
  }
}
