// Shared money helpers.
//
// Amounts entered on the request forms are stored as display strings that
// carry thousands separators and sometimes a currency symbol (e.g. "3,434"
// or "$1,200.50"). Passing those straight to Number() yields NaN, which is
// how the dreaded "USD NaN" ends up on approval screens. parseAmount strips
// everything that isn't a digit, decimal point or minus sign first.

export function parseAmount(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value == null) return 0;
  const cleaned = String(value).replace(/[^0-9.-]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

// Format a money value FOR A TEXT INPUT while the user is still typing.
//
// Unlike formatAmount, this must never destroy an in-progress decimal: a naive
// parseFloat().toLocaleString() on every keystroke drops the trailing "." and
// trailing zeros, so "12.50" collapses to "12" and cents can never be entered.
// This keeps the integer part comma-grouped while preserving the decimal part
// exactly as typed (up to 2 digits), including a lone trailing dot.
export function formatMoneyInput(value: unknown): string {
  let cleaned = String(value ?? '').replace(/[^0-9.]/g, '');
  // Collapse to a single decimal point (keep the first).
  const firstDot = cleaned.indexOf('.');
  if (firstDot !== -1) {
    cleaned = cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');
  }
  if (cleaned === '') return '';
  if (cleaned === '.') return '0.';
  const [intPart, decPart] = cleaned.split('.');
  const intFormatted = intPart ? Number(intPart).toLocaleString('en-US') : '';
  if (decPart !== undefined) {
    return `${intFormatted || '0'}.${decPart.slice(0, 2)}`;
  }
  return intFormatted;
}

// Format an amount (string or number) as a currency string. Falls back to a
// plain "<currency> <number>" when the currency code isn't ISO-recognised
// (e.g. "ZWG"/"ZiG" which some runtimes reject).
export function formatAmount(value: unknown, currency = 'USD'): string {
  const n = parseAmount(value);
  try {
    return n.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 2 });
  } catch {
    return `${currency} ${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  }
}
