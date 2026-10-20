import type { Request } from 'express';
import { prisma } from './prisma';
import type { AuthContext } from '../middleware/auth';

type Json = Record<string, unknown>;

// Keys that must never reach the audit trail, even when a caller passes them by mistake.
const SENSITIVE_KEY = /password|token|hash|secret|cipher|bankAccount|^pan(Cipher|Last4)?$/i;

/** Removes secrets and full bank/PAN values from a change summary before it is persisted. */
export function redact(input: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_KEY.test(key)) {
      out[key] = '[redacted]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = redact(value as Json);
    } else {
      out[key] = value;
    }
  }
  return out;
}

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary?: Json;
}

/**
 * Records a sensitive operation. Pass the actor's auth context, or null for system and anonymous actions
 * (for example failed logins), so every record still identifies the organization and the event.
 */
export async function writeAudit(
  actor: AuthContext | null,
  organizationId: string,
  entry: AuditEntry,
  req?: Request,
  client: Pick<typeof prisma, 'auditLog'> = prisma,
) {
  await client.auditLog.create({
    data: {
      organizationId,
      actorId: actor?.userId ?? null,
      actorEmail: actor?.email ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      summary: entry.summary ? (redact(entry.summary) as object) : undefined,
      ipAddress: req?.ip ?? null,
    },
  });
}

/** Computes which top-level fields changed between two records, without storing their values. */
export function changedFields(before: Json, after: Json): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
}
