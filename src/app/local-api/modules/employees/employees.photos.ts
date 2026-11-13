import { z } from 'zod';
import { db } from '../../db';
import { AppError } from '../../lib/errors';
import { writeAudit } from '../../lib/audit';
import { hasPermission } from '../../security/permissions';
import type { AuthContext } from '../../security/session';

// ---------------------------------------------------------------------------------------------------------------
// Profile photos. Upload rules:
//  - Only PNG, JPEG or WebP, at most 1.5 MB, verified by file signature (not just the declared type).
//  - The screen resizes photos to 400 x 400 before upload, so the stored data URL stays small (about 30 KB).
//  - HR can change any photo in the organization; employees can change their own.
// ---------------------------------------------------------------------------------------------------------------

const MAX_BYTES = 1.5 * 1024 * 1024;

const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((v, i) => b[i] === v),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP',
};

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

export const photoSchema = z.object({
  dataUrl: z.string().max(2_200_000, 'The image is too large. Use a file under 1.5 MB.'),
});

function canEditPhoto(auth: AuthContext, employeeId: string) {
  return hasPermission(auth.role, 'employees:write') || auth.employeeId === employeeId;
}

function employeeInOrg(auth: AuthContext, employeeId: string) {
  const emp = db.employees.get(employeeId);
  if (!emp || emp.organizationId !== auth.organizationId) throw AppError.notFound('Employee not found.');
  return emp;
}

export function setPhoto(auth: AuthContext, employeeId: string, dataUrl: string) {
  if (!canEditPhoto(auth, employeeId)) throw AppError.forbidden('You can only change your own photo.');
  employeeInOrg(auth, employeeId);

  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw AppError.badRequest('Upload a PNG, JPEG or WebP image.', [{ field: 'photo', message: 'Unsupported file type.' }]);
  const mime = match[1];
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0));
  } catch {
    throw AppError.badRequest('The file content does not match an image.', [{ field: 'photo', message: 'Invalid image file.' }]);
  }
  if (bytes.length === 0 || bytes.length > MAX_BYTES) {
    throw AppError.badRequest('Use an image under 1.5 MB.', [{ field: 'photo', message: 'File is too large.' }]);
  }
  if (!SIGNATURES[mime](bytes)) throw AppError.badRequest('The file content does not match an image.', [{ field: 'photo', message: 'Invalid image file.' }]);

  db.employees.update(employeeId, { photoUrl: dataUrl });
  writeAudit(auth, auth.organizationId, { action: 'employee.photo_updated', entityType: 'Employee', entityId: employeeId, summary: { bytes: bytes.length, type: mime } });
  return { photoUrl: dataUrl };
}

export function removePhoto(auth: AuthContext, employeeId: string) {
  if (!canEditPhoto(auth, employeeId)) throw AppError.forbidden('You can only change your own photo.');
  employeeInOrg(auth, employeeId);
  db.employees.update(employeeId, { photoUrl: null });
  writeAudit(auth, auth.organizationId, { action: 'employee.photo_removed', entityType: 'Employee', entityId: employeeId });
}
