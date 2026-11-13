import type { Role } from '../db/schema';

// Permission matrix. The UI mirrors it only to shape navigation; every API route checks it again.
export const PERMISSIONS = [
  'employees:read', // directory and profile (scoped: HR = all, Manager = direct reports, Employee = self)
  'employees:write',
  'employees:sensitive', // bank and PAN in clear text
  'employees:export',
  'attendance:manage', // review corrections and edit any record
  'leave:manage', // configure leave types and see every request
  'payroll:read',
  'payroll:manage', // create runs, adjustments, validate
  'payroll:approve', // approve and finalize; separation of duties enforced in the service
  'payroll:bank-export',
  'org:manage', // holidays, departments, designations, announcements, org settings
  'audit:read',
  'reports:read', // company-wide analytics and report exports
  'roles:manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SUPER_ADMIN: PERMISSIONS,
  HR_ADMIN: [
    'employees:read',
    'employees:write',
    'employees:sensitive',
    'employees:export',
    'attendance:manage',
    'leave:manage',
    'payroll:read',
    'payroll:manage',
    'payroll:approve',
    'payroll:bank-export',
    'org:manage',
    'audit:read',
    'reports:read',
  ],
  MANAGER: ['employees:read'],
  EMPLOYEE: [],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}
