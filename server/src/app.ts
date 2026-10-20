import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { errorBody, errorHandler } from './lib/errors';
import { authenticate } from './middleware/auth';
import { authRouter } from './modules/auth/auth.routes';
import { employeesRouter } from './modules/employees/employees.routes';
import { attendanceRouter } from './modules/attendance/attendance.routes';
import { leaveRouter } from './modules/leave/leave.routes';
import { payrollRouter } from './modules/payroll/payroll.routes';
import { dashboardRouter } from './modules/dashboard/dashboard.routes';
import { orgRouter } from './modules/org/org.routes';
import { reportsRouter } from './modules/reports/reports.routes';
import { notificationsRouter } from './modules/notifications/notifications.routes';
import { filesRouter } from './modules/employees/employees.photos';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cors({ origin: env.CLIENT_ORIGIN, credentials: true }));
  app.use(cookieParser());
  // 3 MB covers a 1.5 MB photo after base64 encoding; the photo service enforces the real size limit.
  app.use(express.json({ limit: '3mb' }));

  // CSRF defence in depth: state-changing requests must be JSON (cross-site forms cannot send that content type
  // without a CORS preflight, which only CLIENT_ORIGIN passes). Combined with SameSite=Lax cookies.
  app.use((req, res, next) => {
    const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
    const hasBody = req.headers['content-length'] && req.headers['content-length'] !== '0';
    if (mutating && hasBody && !req.is('application/json')) {
      return res.status(415).json(errorBody('VALIDATION_ERROR', 'Requests must use application/json.'));
    }
    next();
  });

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', authRouter);

  const api = express.Router();
  api.use(authenticate);
  api.use('/employees', employeesRouter);
  api.use('/attendance', attendanceRouter);
  api.use('/leave', leaveRouter);
  api.use('/payroll', payrollRouter);
  api.use('/dashboard', dashboardRouter);
  api.use('/org', orgRouter);
  api.use('/reports', reportsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/files', filesRouter);
  app.use('/api', api);

  app.use('/api', (_req, res) => {
    res.status(404).json(errorBody('NOT_FOUND', 'Endpoint not found.'));
  });

  app.use(errorHandler);
  return app;
}
