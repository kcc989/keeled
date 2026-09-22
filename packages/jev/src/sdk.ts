export interface SdkBoundaryValue {}

/** Adapt values whose concrete shape is enforced by the TypeSafe SDK contract. */
export function sdkValue<T>(value: SdkBoundaryValue): T {
  // SAFETY: the SDK owns and validates this response or request shape at its API boundary.
  return value as T;
}

// Parse the untrusted SDK error body at the network boundary.
/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */

export function isTokenLimit(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('status' in error) || error.status !== 400 || !('body' in error))
    return false;
  const body = error.body;

  if (typeof body !== 'object' || body === null || !('detail' in body)) return false;
  const detail = body.detail;

  return (
    typeof detail === 'object' &&
    detail !== null &&
    'error_type' in detail &&
    detail.error_type === 'max_tokens_exceeded'
  );
}

/* oxlint-enable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof */
