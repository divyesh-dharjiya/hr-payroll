import { Router } from 'express';
import { prisma } from '../../lib/prisma';
import { requireAuth } from '../../middleware/auth';

export const notificationsRouter = Router();

// Each user sees only their own notifications; every query is filtered by the session user id.
notificationsRouter.get('/', async (req, res) => {
  const auth = requireAuth(req);
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where: { userId: auth.userId },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: { id: true, kind: true, title: true, body: true, link: true, readAt: true, createdAt: true },
    }),
    prisma.notification.count({ where: { userId: auth.userId, readAt: null } }),
  ]);
  res.json({
    unread,
    items: items.map((n) => ({ ...n, readAt: n.readAt?.toISOString() ?? null, createdAt: n.createdAt.toISOString() })),
  });
});

notificationsRouter.post('/:id/read', async (req, res) => {
  const auth = requireAuth(req);
  await prisma.notification.updateMany({
    where: { id: req.params.id as string, userId: auth.userId, readAt: null },
    data: { readAt: new Date() },
  });
  res.status(204).end();
});

notificationsRouter.post('/read-all', async (req, res) => {
  const auth = requireAuth(req);
  await prisma.notification.updateMany({ where: { userId: auth.userId, readAt: null }, data: { readAt: new Date() } });
  res.status(204).end();
});
