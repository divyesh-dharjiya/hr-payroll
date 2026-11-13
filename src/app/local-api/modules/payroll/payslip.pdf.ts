import { rupeesInWords } from '../../lib/money';

// ---------------------------------------------------------------------------------------------------------------
// Payslip PDF. Rendered in the browser from the same payload as the on-screen payslip (finalized snapshot only),
// so the file and the page always agree. Uses the built-in Helvetica fonts: amounts are written as
// "INR 1,23,456.00" because the standard PDF fonts have no rupee sign. PDFKit (about 1 MB) is loaded only when a
// PDF is first downloaded.
// ---------------------------------------------------------------------------------------------------------------

interface Line {
  code: string;
  label: string;
  amountPaise: number;
}

export interface PayslipForPdf {
  organization: { name: string; legalName: string | null };
  period: { year: number; month: number };
  employee: { employeeCode: string; name: string; department: string; designation: string; joiningDate: string; bankAccount: string | null };
  paidDays: number;
  lopDays: number;
  paymentStatus: 'PAID' | 'NOT_PAID';
  paidAt: string | null;
  lines: { earnings: Line[]; deductions: Line[]; employerContributions: Line[] } | null;
  totals: { grossPaise: number; deductionsPaise: number; netPaise: number; employerContribPaise: number };
  ytd: { gross: number; deductions: number; net: number };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const INK = '#101828';
const MUTED = '#475467';
const RULE = '#d0d5dd';
const BRAND = '#4338ca';

/** INR with Indian digit grouping, e.g. 12345650 paise -> "1,23,456.50". */
export function inr(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const digits = Math.floor(abs / 100).toString();
  const grouped = digits.length <= 3 ? digits : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
  return `${negative ? '-' : ''}${grouped}.${String(abs % 100).padStart(2, '0')}`;
}

function formatDay(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${String(d).padStart(2, '0')} ${MONTHS[m - 1].slice(0, 3)} ${y}`;
}

export async function renderPayslipPdf(slip: PayslipForPdf): Promise<Blob> {
  const { default: PDFDocument } = await import('pdfkit/js/pdfkit.standalone');
  const period = `${MONTHS[slip.period.month - 1]} ${slip.period.year}`;
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: `Payslip ${period} - ${slip.employee.name}`, Author: slip.organization.name, Subject: 'Payslip' },
  });
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  doc.on('data', (c: Uint8Array<ArrayBuffer>) => chunks.push(c));
  const done = new Promise<Blob>((resolve, reject) => {
    doc.on('end', () => resolve(new Blob(chunks, { type: 'application/pdf' })));
    doc.on('error', reject);
  });

  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const rule = (y: number) => doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.7).strokeColor(RULE).stroke();

  // Header
  doc.rect(left, 48, 6, 40).fill(BRAND);
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text(slip.organization.name, left + 16, 50, { width: width - 200 });
  if (slip.organization.legalName) doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(slip.organization.legalName, left + 16, 70, { width: width - 200 });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(INK).text('Payslip', left, 50, { width, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(period, left, 68, { width, align: 'right' });
  rule(100);

  // Employee details, two columns
  const details: [string, string][] = [
    ['Employee', slip.employee.name],
    ['Employee ID', slip.employee.employeeCode],
    ['Department', slip.employee.department],
    ['Designation', slip.employee.designation],
    ['Date of joining', formatDay(slip.employee.joiningDate)],
    ['Bank account', slip.employee.bankAccount ?? '-'],
    ['Paid days', String(slip.paidDays)],
    ['Loss of pay days', String(slip.lopDays)],
  ];
  let y = 114;
  const colW = width / 2;
  details.forEach(([label, value], i) => {
    const x = left + (i % 2) * colW;
    const rowY = y + Math.floor(i / 2) * 32;
    doc.font('Helvetica').fontSize(8.5).fillColor(MUTED).text(label.toUpperCase(), x, rowY, { width: colW - 12, characterSpacing: 0.4 });
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(INK).text(value.replace(/•/g, '*'), x, rowY + 11, { width: colW - 12 });
  });
  y += Math.ceil(details.length / 2) * 32 + 6;
  rule(y);

  // Earnings and deductions side by side
  const tableTop = y + 14;
  const gap = 24;
  const tw = (width - gap) / 2;
  const table = (x: number, title: string, lines: Line[], totalLabel: string, total: number) => {
    let ty = tableTop;
    doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND).text(title.toUpperCase(), x, ty, { width: tw, characterSpacing: 0.5 });
    ty += 18;
    doc.font('Helvetica').fontSize(10).fillColor(INK);
    if (!lines.length) {
      doc.fillColor(MUTED).text('None', x, ty, { width: tw });
      ty += 16;
    }
    for (const l of lines) {
      const h = doc.heightOfString(l.label, { width: tw - 100 });
      doc.fillColor(INK).text(l.label, x, ty, { width: tw - 100 });
      doc.text(inr(l.amountPaise), x + tw - 100, ty, { width: 100, align: 'right' });
      ty += Math.max(16, h + 4);
    }
    return { bottom: ty, totalLabel, total, x };
  };
  const lines = slip.lines ?? { earnings: [], deductions: [], employerContributions: [] };
  const a = table(left, 'Earnings', lines.earnings, 'Gross earnings', slip.totals.grossPaise);
  const b = table(left + tw + gap, 'Deductions', lines.deductions, 'Total deductions', slip.totals.deductionsPaise);
  const totalsY = Math.max(a.bottom, b.bottom) + 4;
  for (const t of [a, b]) {
    doc.moveTo(t.x, totalsY).lineTo(t.x + tw, totalsY).lineWidth(0.7).strokeColor(RULE).stroke();
    doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(t.totalLabel, t.x, totalsY + 6, { width: tw - 100 });
    doc.text(inr(t.total), t.x + tw - 100, totalsY + 6, { width: 100, align: 'right' });
  }

  // Net pay
  y = totalsY + 34;
  doc.roundedRect(left, y, width, 58, 6).fill('#eef2ff');
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('NET PAY (INR)', left + 14, y + 10, { characterSpacing: 0.5 });
  doc.fillColor(INK).font('Helvetica-Bold').fontSize(18).text(inr(slip.totals.netPaise), left + 14, y + 22);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(rupeesInWords(slip.totals.netPaise), left + width / 2 - 20, y + 14, { width: width / 2 + 6, align: 'right' });
  const payment = slip.paymentStatus === 'PAID' ? `Paid${slip.paidAt ? ` on ${formatDay(slip.paidAt.slice(0, 10))}` : ''}` : 'Payment pending';
  doc.font('Helvetica-Bold').fontSize(9).fillColor(slip.paymentStatus === 'PAID' ? '#067647' : MUTED).text(payment, left + width / 2 - 20, y + 38, { width: width / 2 + 6, align: 'right' });

  // Employer contributions and year to date
  y += 76;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(BRAND).text('EMPLOYER CONTRIBUTIONS', left, y, { width: tw, characterSpacing: 0.5 });
  doc.text('YEAR TO DATE (FINANCIAL YEAR)', left + tw + gap, y, { width: tw, characterSpacing: 0.5 });
  let ey = y + 18;
  doc.font('Helvetica').fontSize(10).fillColor(INK);
  if (!lines.employerContributions.length) {
    doc.fillColor(MUTED).text('None', left, ey);
    ey += 16;
  }
  for (const l of lines.employerContributions) {
    doc.fillColor(INK).text(l.label, left, ey, { width: tw - 100 });
    doc.text(inr(l.amountPaise), left + tw - 100, ey, { width: 100, align: 'right' });
    ey += 16;
  }
  let yy = y + 18;
  for (const [label, value] of [['Gross', slip.ytd.gross], ['Deductions', slip.ytd.deductions], ['Net', slip.ytd.net]] as const) {
    doc.fillColor(INK).text(label, left + tw + gap, yy, { width: tw - 100 });
    doc.text(inr(value), left + tw + gap + tw - 100, yy, { width: 100, align: 'right' });
    yy += 16;
  }

  // Footer
  const footY = doc.page.height - doc.page.margins.bottom - 30;
  rule(footY);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
    'This is a computer-generated payslip from the finalized payroll record and does not need a signature. Statutory amounts follow the configured company rules.',
    left,
    footY + 8,
    { width },
  );

  doc.end();
  return done;
}
