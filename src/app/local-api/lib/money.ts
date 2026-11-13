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

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(n: number): string {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? `-${ONES[n % 10]}` : ''}`;
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : '', rest ? belowHundred(rest) : ''].filter(Boolean).join(' ');
}

/** Whole rupees in words with Indian grouping (crore, lakh, thousand), e.g. 150000 -> "One Lakh Fifty Thousand". */
function integerInWords(n: number): string {
  if (n === 0) return 'Zero';
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  return [
    crore ? `${integerInWords(crore)} Crore` : '',
    lakh ? `${belowHundred(lakh)} Lakh` : '',
    thousand ? `${belowHundred(thousand)} Thousand` : '',
    rest ? belowThousand(rest) : '',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Amount in words as printed on payslips: 12345650 paise -> "Rupees One Lakh Twenty-Three Thousand ... and Fifty Paise Only". */
export function rupeesInWords(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100);
  const p = abs % 100;
  const words = `Rupees ${integerInWords(rupees)}${p ? ` and ${belowHundred(p)} Paise` : ''} Only`;
  return negative ? `Minus ${words}` : words;
}
