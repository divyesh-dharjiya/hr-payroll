// Development-only helper: runs a local PostgreSQL server from the `embedded-postgres` binaries
// so the app can be run without a system-wide PostgreSQL install.
// Use your own PostgreSQL (or Docker) instead by setting DATABASE_URL in server/.env.
// Credentials here are local-only defaults and are never used in production.
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', '.pgdata');
const port = Number(process.env.DEV_PG_PORT ?? 5433);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'peoplehub',
  password: 'peoplehub_dev_only',
  port,
  persistent: true,
});

if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
  await pg.initialise();
}
await pg.start();
try {
  await pg.createDatabase('peoplehub');
} catch {
  // Database already exists.
}
console.log(`[dev-db] PostgreSQL running on localhost:${port} (database: peoplehub)`);

const shutdown = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
