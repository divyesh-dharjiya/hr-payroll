import { z } from 'zod';

const optionalText = (max = 200) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v === '' ? undefined : v));

const phone = z
  .string()
  .trim()
  .regex(/^[+0-9 ()-]{7,20}$/, 'Enter a valid phone number.')
  .optional()
  .or(z.literal('').transform(() => undefined));

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format.')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), 'Enter a real calendar date.');

export const employmentTypeSchema = z.enum(['FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN']);

const baseEmployeeFields = {
  firstName: z.string().trim().min(1, 'First name is required.').max(60),
  lastName: z.string().trim().min(1, 'Last name is required.').max(60),
  workEmail: z.string().trim().toLowerCase().email('Enter a valid work email.').max(160),
  personalEmail: z.string().trim().toLowerCase().email('Enter a valid personal email.').optional().or(z.literal('').transform(() => undefined)),
  phone,
  dateOfBirth: isoDate.optional(),
  joiningDate: isoDate,
  employmentType: employmentTypeSchema.default('FULL_TIME'),
  workLocation: z.string().trim().min(1).max(100).default('Head Office'),
  departmentId: z.string().min(1, 'Choose a department.'),
  designationId: z.string().min(1, 'Choose a designation.'),
  managerId: z.string().min(1).nullable().optional(),
  emergencyContactName: optionalText(100),
  emergencyContactPhone: phone,
  addressLine: optionalText(200),
  city: optionalText(100),
  state: optionalText(100),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Enter a 6-digit PIN code.')
    .optional()
    .or(z.literal('').transform(() => undefined)),
};

export const createEmployeeSchema = z.object({
  ...baseEmployeeFields,
  employeeCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{3,20}$/, 'Use 3-20 letters, digits or hyphens.')
    .optional(),
  createAccount: z.boolean().default(true),
  accountRole: z.enum(['EMPLOYEE', 'MANAGER']).default('EMPLOYEE'),
});

export const updateEmployeeSchema = z
  .object({
    ...baseEmployeeFields,
    status: z.enum(['ACTIVE', 'ON_NOTICE']).optional(),
    onboardingStatus: z.enum(['PENDING', 'IN_PROGRESS', 'COMPLETE']).optional(),
  })
  .partial();

export const bankDetailsSchema = z.object({
  accountNumber: z
    .string()
    .trim()
    .regex(/^\d{6,18}$/, 'Account numbers are 6 to 18 digits.'),
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC code (for example HDFC0001234).'),
  bankName: z.string().trim().min(2).max(100),
  pan: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{5}[0-9]{4}[A-Z]$/, 'Enter a valid PAN (for example ABCDE1234F).'),
});

export const offboardSchema = z.object({
  exitDate: isoDate,
  reason: z.string().trim().min(3).max(300),
});

export const salarySchema = z.object({
  effectiveFrom: isoDate,
  basic: z.string().regex(/^\d+(\.\d{1,2})?$/, 'Enter an amount such as 25000 or 25000.50'),
  hra: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
  conveyance: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
  special: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
  otherAllowance: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
  pfApplicable: z.boolean().default(false),
  esiApplicable: z.boolean().default(false),
  professionalTax: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
  monthlyTds: z.string().regex(/^\d+(\.\d{1,2})?$/).default('0'),
});

export const listQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  departmentId: z.string().optional(),
  status: z.enum(['ACTIVE', 'ON_NOTICE', 'EXITED']).optional(),
  employmentType: employmentTypeSchema.optional(),
  sort: z.enum(['name', 'code', 'joiningDate', 'department']).default('name'),
  dir: z.enum(['asc', 'desc']).default('asc'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const importRowSchema = z.object({
  employeeCode: z.string().trim().optional(),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  workEmail: z.string().trim().toLowerCase().email(),
  joiningDate: isoDate,
  departmentName: z.string().trim().min(1),
  designationTitle: z.string().trim().min(1),
  employmentType: employmentTypeSchema.default('FULL_TIME'),
  managerEmail: z.string().trim().toLowerCase().email().optional().or(z.literal('').transform(() => undefined)),
  phone: z.string().trim().optional(),
});

export type CreateEmployeeInput = z.infer<typeof createEmployeeSchema>;
export type BankDetailsInput = z.infer<typeof bankDetailsSchema>;
export type ImportRowData = z.infer<typeof importRowSchema>;
export type UpdateEmployeeInput = z.infer<typeof updateEmployeeSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type SalaryInputDto = z.infer<typeof salarySchema>;
