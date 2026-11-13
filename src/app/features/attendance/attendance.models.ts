import type { Tone } from '../../shared/ui';
import { formatTime } from '../../shared/format';

// Shapes returned by /api/attendance and the display helpers shared by the attendance components.

export type LoadState = 'loading' | 'ready' | 'error';

export interface CalendarDay {
  date: string;
  status: string;
  workedMinutes?: number;
  lateMinutes?: number;
  overtimeMinutes?: number;
  overtimeApprovedMinutes?: number;
  overtimeStatus?: OvertimeStatus;
  leave?: { leaveTypeCode: string; isPaid: boolean; days: number };
}

export interface Calendar {
  employee: { id: string; name: string };
  year: number;
  month: number;
  days: CalendarDay[];
  totals: { workedMinutes: number; lateMinutes: number; overtimeMinutes: number; overtimeApprovedMinutes: number };
  counts: Record<string, number>;
}

export interface SummaryRow {
  employee: { id: string; employeeCode: string; name: string };
  present: number;
  late: number;
  halfDay: number;
  absent: number;
  onLeave: number;
  workedHours: number;
  overtimeHours: number;
}

export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface Correction {
  id: string;
  employee: { name: string; employeeCode: string };
  workDate: string;
  requestedCheckIn: string | null;
  requestedCheckOut: string | null;
  reason: string;
  status: ReviewStatus;
  reviewComment: string | null;
  createdAt: string;
}

export type OvertimeStatus = 'NONE' | ReviewStatus;

export interface OvertimeItem {
  id: string;
  employee: { id: string; name: string; employeeCode: string };
  workDate: string;
  checkInAt: string | null;
  checkOutAt: string | null;
  workedMinutes: number;
  overtimeMinutes: number;
  approvedMinutes: number;
  status: ReviewStatus;
  comment: string | null;
  isOwn: boolean;
}

export const DAY_STATUS: Record<string, { label: string; tone: Tone }> = {
  PRESENT: { label: 'Present', tone: 'ok' },
  LATE: { label: 'Late', tone: 'warn' },
  HALF_DAY: { label: 'Half day', tone: 'warn' },
  WFH: { label: 'WFH', tone: 'info' },
  ABSENT: { label: 'Absent', tone: 'bad' },
  ON_LEAVE: { label: 'Leave', tone: 'info' },
  HOLIDAY: { label: 'Holiday', tone: 'neutral' },
  WEEKLY_OFF: { label: 'Week off', tone: 'neutral' },
  NOT_EMPLOYED: { label: '—', tone: 'neutral' },
  FUTURE: { label: '', tone: 'neutral' },
};

export function dayStatusView(status: string): { label: string; tone: Tone } {
  return DAY_STATUS[status] ?? { label: status, tone: 'neutral' };
}

const REVIEW_LABEL: Record<ReviewStatus, string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected' };
const REVIEW_TONE: Record<ReviewStatus, Tone> = { PENDING: 'warn', APPROVED: 'ok', REJECTED: 'bad' };

export function reviewLabel(s: ReviewStatus): string {
  return REVIEW_LABEL[s];
}

export function reviewTone(s: ReviewStatus): Tone {
  return REVIEW_TONE[s];
}

/** "09:42" in the organization timezone, or a dash. */
export function clock(iso: string | null): string {
  return iso ? formatTime(iso) : '—';
}
