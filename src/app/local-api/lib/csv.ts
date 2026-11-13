// CSV helpers shared by every export.
//
// Spreadsheet apps run a cell that starts with = + - @ (or a tab / carriage return) as a formula, so a name such as
// `=HYPERLINK(...)` typed into a form could execute when HR opens an export ("CSV injection"). Such cells are
// prefixed with an apostrophe. Plain numbers and phone numbers (for example -250.00 or +91 98100 00000) are kept.

const FORMULA_START = /^[=+\-@\t\r]/;
const NUMBER_LIKE = /^[+-]?[\d\s().-]+$/;

export function csvCell(value: unknown): string {
  let text = String(value ?? '');
  if (FORMULA_START.test(text) && !NUMBER_LIKE.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(',');
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [csvRow(header), ...rows.map(csvRow)].join('\n');
}
