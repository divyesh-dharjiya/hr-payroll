import { db } from '../../db';
import { Router, noContent, requireAuth } from '../../http/router';

export const notificationsRouter = new Router('/notifications');

// Each user sees only their own notifications; every query is filtered by the session user id.
notificationsRouter.get('/', (req) => {
  const auth = requireAuth(req);
  const mine = db.notifications.by('userId', auth.userId);
  return {
    unread: mine.filter((n) => n.readAt === null).length,
    items: mine
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 30)
      .map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, readAt: n.readAt, createdAt: n.createdAt })),
  };
});

notificationsRouter.post('/:id/read', (req) => {
  const auth = requireAuth(req);
  const readAt = new Date().toISOString();
  db.notifications.updateWhere((n) => n.id === req.params['id'] && n.userId === auth.userId && n.readAt === null, { readAt });
  return noContent();
});

notificationsRouter.post('/read-all', (req) => {
  const auth = requireAuth(req);
  const readAt = new Date().toISOString();
  db.notifications.updateWhere((n) => n.userId === auth.userId && n.readAt === null, { readAt });
  return noContent();
});
