import crypto from 'node:crypto';
import { env } from '../config/env';

// Field-level encryption for restricted employee data (bank account numbers, PAN).
// AES-256-GCM with a random 96-bit IV per value. Stored format: v1:<iv>:<tag>:<ciphertext> (base64).
const key = Buffer.from(env.DATA_ENCRYPTION_KEY, 'hex');

export function encryptField(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':');
}

export function decryptField(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(':');
  if (version !== 'v1') throw new Error('Unsupported ciphertext version');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** Returns only the last four characters of a sensitive identifier, for display. */
export function last4(value: string): string {
  return value.replace(/\s/g, '').slice(-4);
}

/** Random opaque token for password reset links. Only its SHA-256 hash is persisted. */
export function randomToken(): { token: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
