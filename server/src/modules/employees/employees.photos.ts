import type { Request } from 'express';
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { prisma } from '../../lib/prisma';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { requireAuth, type AuthContext } from '../../middleware/auth';
import { hasPermission } from '../../security/permissions';

// ---------------------------------------------------------------------------------------------------------------
// Profile photos. Upload rules:
//  - Only PNG, JPEG or WebP, at most 1.5 MB, verified by file signature (not just the declared type).
//  - Files get random names and are stored outside any public folder; they are served only to signed-in users of
//    the same organization, with nosniff and private caching.
//  - HR can change any photo in the organization; employees can change their own.
// ---------------------------------------------------------------------------------------------------------------

export const PHOTO_DIR = path.resolve(process.cwd(), 'uploads', 'photos');
const MAX_BYTES = 1.5 * 1024 * 1024;
const PUBLIC_PREFIX = '/api/files/photos/';

const SIGNATURES: Record<string, { ext: string; test: (b: Buffer) => boolean }> = {
  'image/png': { ext: 'png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/jpeg': { ext: 'jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/webp': { ext: 'webp', test: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP' },
};

const CONTENT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };

export const photoSchema = z.object({
  dataUrl: z.string().max(2_200_000, 'The image is too large. Use a file under 1.5 MB.'),
});

function canEditPhoto(auth: AuthContext, employeeId: string) {
  return hasPermission(auth.role, 'employees:write') || auth.employeeId === employeeId;
}

async function removeStoredFile(photoUrl: string | null) {
  if (!photoUrl?.startsWith(PUBLIC_PREFIX)) return;
  const name = path.basename(photoUrl);
  await unlink(path.join(PHOTO_DIR, name)).catch(() => undefined);
}

export async function setPhoto(auth: AuthContext, employeeId: string, dataUrl: string, req?: Request) {
  if (!canEditPhoto(auth, employeeId)) throw AppError.forbidden('You can only change your own photo.');
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, organizationId: auth.organizationId }, select: { id: true, photoUrl: true } });
  if (!emp) throw AppError.notFound('Employee not found.');

  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw AppError.badRequest('Upload a PNG, JPEG or WebP image.', [{ field: 'photo', message: 'Unsupported file type.' }]);
  const mime = match[1];
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw AppError.badRequest('Use an image under 1.5 MB.', [{ field: 'photo', message: 'File is too large.' }]);
  }
  const sig = SIGNATURES[mime];
  if (!sig.test(bytes)) throw AppError.badRequest('The file content does not match an image.', [{ field: 'photo', message: 'Invalid image file.' }]);

  await mkdir(PHOTO_DIR, { recursive: true });
  const name = `${randomBytes(16).toString('hex')}.${sig.ext}`;
  await writeFile(path.join(PHOTO_DIR, name), bytes, { flag: 'wx' });
  await prisma.employee.update({ where: { id: employeeId }, data: { photoUrl: `${PUBLIC_PREFIX}${name}` } });
  await removeStoredFile(emp.photoUrl);
  await writeAudit(auth, auth.organizationId, { action: 'employee.photo_updated', entityType: 'Employee', entityId: employeeId, summary: { bytes: bytes.length, type: mime } }, req);
  return { photoUrl: `${PUBLIC_PREFIX}${name}` };
}

export async function removePhoto(auth: AuthContext, employeeId: string, req?: Request) {
  if (!canEditPhoto(auth, employeeId)) throw AppError.forbidden('You can only change your own photo.');
  const emp = await prisma.employee.findFirst({ where: { id: employeeId, organizationId: auth.organizationId }, select: { photoUrl: true } });
  if (!emp) throw AppError.notFound('Employee not found.');
  await prisma.employee.update({ where: { id: employeeId }, data: { photoUrl: null } });
  await removeStoredFile(emp.photoUrl);
  await writeAudit(auth, auth.organizationId, { action: 'employee.photo_removed', entityType: 'Employee', entityId: employeeId }, req);
}

/** Serves stored photos to signed-in users of the organization that owns them. */
export const filesRouter = Router();

filesRouter.get('/photos/:name', async (req, res) => {
  const auth = requireAuth(req);
  const name = String(req.params.name);
  if (!/^[a-f0-9]{32}\.(png|jpg|webp)$/.test(name)) throw AppError.notFound('File not found.');
  const owner = await prisma.employee.findFirst({
    where: { organizationId: auth.organizationId, photoUrl: `${PUBLIC_PREFIX}${name}` },
    select: { id: true },
  });
  if (!owner) throw AppError.notFound('File not found.');
  const ext = name.split('.').pop() as string;
  res.setHeader('Content-Type', CONTENT_TYPES[ext]);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(path.join(PHOTO_DIR, name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});
