import { prisma } from './prisma';

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
export async function notifyUsers(organizationId: string, userIds: (string | null | undefined)[], input: NotificationInput) {
  const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return;
  try {
    await prisma.notification.createMany({
      data: ids.map((userId) => ({ organizationId, userId, ...input })),
    });
  } catch (err) {
    console.error('[notify] could not create notifications', err);
  }
}

/** Sign-in account for an employee, if they have one. */
export async function userIdForEmployee(employeeId: string): Promise<string | null> {
  const user = await prisma.user.findUnique({ where: { employeeId }, select: { id: true, isActive: true } });
  return user?.isActive ? user.id : null;
}

/** Sign-in account of the employee's reporting manager, if any. */
export async function managerUserIdFor(employeeId: string): Promise<string | null> {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { managerId: true } });
  return emp?.managerId ? userIdForEmployee(emp.managerId) : null;
}

/** Active HR and Super Admin accounts in the organization. */
export async function hrUserIds(organizationId: string): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { organizationId, isActive: true, role: { in: ['HR_ADMIN', 'SUPER_ADMIN'] } },
    select: { id: true },
  });
  return users.map((u) => u.id);
}
