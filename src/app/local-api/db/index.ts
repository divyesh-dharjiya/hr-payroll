import { Database } from './database';

/** The single database instance every service reads and writes (like a shared Prisma client). */
export const db = new Database();

export type { Database } from './database';
