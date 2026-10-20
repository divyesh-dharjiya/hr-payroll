import 'dotenv/config';
import { z } from 'zod';

// All secrets come from environment variables. Startup fails fast when they are missing or weak.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  DATA_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'DATA_ENCRYPTION_KEY must be 64 hex characters (32 bytes)'),
  CLIENT_ORIGIN: z.string().default('http://localhost:4200'),
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  SEED_DEMO_PASSWORD: z.string().optional(),
  // Demo mode exposes one-click sign-in for the seeded demo accounts. Never enable it with real data.
  DEMO_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${details}`);
}

export const env = parsed.data;
export const isProduction = env.NODE_ENV === 'production';
/** Demo sign-in is available only when explicitly enabled and never in production. */
export const demoModeEnabled = env.DEMO_MODE && !isProduction && Boolean(env.SEED_DEMO_PASSWORD);
