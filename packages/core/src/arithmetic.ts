export interface Decimal { coefficient: bigint; scale: number }
/** Parse exact finite decimal input. No implicit rounding or domain-specific units. */
export function decimal(value: unknown): Decimal {
  if (typeof value === 'number' && Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error('Use a decimal string for values outside the safe number range.');
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
  if ((typeof value !== 'number' && typeof value !== 'string') || !match || String(value).length > 200) {
    throw new Error('Expected a finite decimal with at most 200 characters.');
  }
  return { coefficient: BigInt(`${match[1]}${match[2]}${match[3] ?? ''}`), scale: match[3]?.length ?? 0 };
}
export function decimalText(coefficient: bigint, scale: number): string {
  const sign = coefficient < 0n ? '-' : '';
  const digits = (coefficient < 0n ? -coefficient : coefficient).toString().padStart(scale + 1, '0');
  if (scale === 0) return sign + digits;
  return sign + digits.slice(0, -scale) + '.' + digits.slice(-scale);
}
export function calculateDecimals(operation: 'sum' | 'difference' | 'compare' | 'product', values: readonly unknown[]): string | number {
  if (values.length === 0 || values.length > 1000) throw new Error('Expected 1–1000 operands.');
  const parsed = values.map(decimal);
  if (operation === 'product') return decimalText(parsed.reduce((a, b) => a * b.coefficient, 1n), parsed.reduce((a, b) => a + b.scale, 0));
  const scale = Math.max(...parsed.map(value => value.scale));
  const numbers = parsed.map(value => value.coefficient * 10n ** BigInt(scale - value.scale));
  if (operation === 'sum') return decimalText(numbers.reduce((a, b) => a + b, 0n), scale);
  if (numbers.length !== 2) throw new Error('Difference and compare require exactly two operands.');
  const difference = numbers[0]! - numbers[1]!;
  return operation === 'compare' ? (difference < 0n ? -1 : difference > 0n ? 1 : 0) : decimalText(difference, scale);
}
