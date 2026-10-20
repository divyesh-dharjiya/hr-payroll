// Decimal-safe money helpers.
//
// Policy:
//  - All amounts are integer paise (1 INR = 100 paise). No floating point is used for stored or summed money.
//  - Proportional amounts (percentages, prorations) use BigInt intermediates and round HALF-UP (away from zero
//    for positive amounts) to the nearest paisa.
//  - Rates are expressed in basis points (bps): 1200 bps = 12.00%.

/** Computes round(a * b / c) with half-up rounding, using exact integer arithmetic. Inputs must be integers. */
export function mulDivRound(a: number, b: number, c: number): number {
  if (!Number.isInteger(a) || !Number.isInteger(b) || !Number.isInteger(c)) {
    throw new RangeError('mulDivRound expects integer inputs');
  }
  if (c === 0) throw new RangeError('Division by zero');
  const numerator = BigInt(a) * BigInt(b);
  const denominator = BigInt(c);
  const negative = numerator < 0n !== denominator < 0n;
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = denominator < 0n ? -denominator : denominator;
  const rounded = (absNum * 2n + absDen) / (absDen * 2n);
  const result = negative ? -rounded : rounded;
  return Number(result);
}

/** Applies a basis-point rate to a paise amount with half-up rounding. */
export function applyBps(amountPaise: number, bps: number): number {
  return mulDivRound(amountPaise, bps, 10_000);
}

/** Formats paise as a human-readable INR string using Indian digit grouping, e.g. 1234567 -> "₹12,345.67". */
export function formatInr(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const paisa = abs % 100;
  // Indian grouping: last three digits, then groups of two (12,34,567).
  const digits = rupees.toString();
  const grouped =
    digits.length <= 3
      ? digits
      : `${digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${digits.slice(-3)}`;
  return `${negative ? '-' : ''}₹${grouped}.${paisa.toString().padStart(2, '0')}`;
}

/** Converts a rupee amount given as a decimal string (e.g. "45000.50") into integer paise, without float drift. */
export function rupeesToPaise(value: string): number {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new RangeError(`Invalid rupee amount: ${value}`);
  const [, sign, whole, frac = ''] = match;
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return sign ? -paise : paise;
}
