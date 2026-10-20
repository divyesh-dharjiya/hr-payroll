import { Pipe, PipeTransform } from '@angular/core';

/** Integer paise -> "₹1,23,456.78" (Indian digit grouping). Money is never computed with floats in the UI. */
export function formatPaise(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return '—';
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const paisa = (abs % 100).toString().padStart(2, '0');
  const grouped = rupees.length <= 3 ? rupees : `${rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${rupees.slice(-3)}`;
  return `${negative ? '-' : ''}₹${grouped}.${paisa}`;
}

@Pipe({ name: 'paise', standalone: true })
export class PaisePipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return formatPaise(value);
  }
}

/** "YYYY-MM-DD" (calendar date) -> "19 Oct 2026". Parsed as a local calendar date, so no timezone shift. */
export function formatDate(ymd: string | null | undefined): string {
  if (!ymd) return '—';
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** ISO instant -> "19 Oct, 09:42" in the organization timezone (defaults to Asia/Kolkata). */
export function formatInstant(iso: string | null | undefined, timeZone = 'Asia/Kolkata'): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function formatTime(iso: string | null | undefined, timeZone = 'Asia/Kolkata'): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-IN', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function formatMinutes(minutes: number | null | undefined): string {
  if (!minutes) return '0h 00m';
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

export function monthName(month: number): string {
  return new Date(2000, month - 1, 1).toLocaleDateString('en-IN', { month: 'long' });
}

/** Today's calendar date (YYYY-MM-DD) in the given timezone. */
export function todayYmd(timeZone = 'Asia/Kolkata'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** Escapes a value for CSV output. */
export function csvEscape(value: unknown): string {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}
