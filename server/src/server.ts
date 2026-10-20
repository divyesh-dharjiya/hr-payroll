import { env } from './config/env';
import { createApp } from './app';
import { prisma } from './lib/prisma';

const app = createApp();
const server = app.listen(env.PORT, () => {
  console.log(`[peoplehub] API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
});

// Graceful shutdown: finish in-flight requests, then release database connections.
const shutdown = () => {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
