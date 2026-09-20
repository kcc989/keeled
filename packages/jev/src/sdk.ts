export interface SdkBoundaryValue {}

/** Adapt values whose concrete shape is enforced by the TypeSafe SDK contract. */
export function sdkValue<T>(value: SdkBoundaryValue): T {
  // SAFETY: the SDK owns and validates this response or request shape at its API boundary.
  return value as T;
}
