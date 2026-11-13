import { db } from '../db';

export interface NotificationInput {
  kind: string;
  title: string;
  body: string;
  link?: string;
}

/**
 * Creates in-app notifications. A failed notification must never undo the business action that triggered it,
 * so errors are logged and swallowed here.
 */
export function notifyUsers(organizationId: string, userIds: (string | null | undefined)[], input: NotificationInput): void {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  try {
    for (const userId of ids) db.notifications.insert({ organizationId, userId, ...input, link: input.link ?? null });
  } catch (err) {
    console.error('[notify] could not create notifications', err);
  }
}

/** Sign-in account for an employee, if they have one. */
export function userIdForEmployee(employeeId: string): string | null {
  const user = db.users.find((u) => u.employeeId === employeeId);
  return user?.isActive ? user.id : null;
}

/** Sign-in account of the employee's reporting manager, if any. */
export function managerUserIdFor(employeeId: string): string | null {
  const managerId = db.employees.get(employeeId)?.managerId;
  return managerId ? userIdForEmployee(managerId) : null;
}

/** Active HR and Super Admin accounts in the organization. */
export function hrUserIds(organizationId: string): string[] {
  return db.users
    .filter((u) => u.organizationId === organizationId && u.isActive && (u.role === 'HR_ADMIN' || u.role === 'SUPER_ADMIN'))
    .map((u) => u.id);
}
