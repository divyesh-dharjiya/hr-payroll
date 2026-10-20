import { env } from './config/env';
import { createApp } from './app';
import { prisma } from './lib/prisma';
import { completeDueExits } from './modules/employees/employees.service';

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`[peoplehub] API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Employees on notice become EXITED (and lose sign-in) once their last working day has passed.
const runExitJob = () =>
  completeDueExits().catch((err) => console.error('[peoplehub] could not complete due exits', err));
void runExitJob();
const exitTimer = setInterval(runExitJob, 60 * 60 * 1000);
exitTimer.unref();

// Graceful shutdown: finish in-flight requests, then release database connections.
const shutdown = () => {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
