import type { PendingAction } from './controller.ts';

/** Supplied by the authenticated host, never inferred from conversation or tool arguments. */
export interface Principal {
  subject: string;
  tenant?: string;
}

export interface AccessDecision {
  allowed: boolean;
  reason: string;
}

/** The application must check authoritative ownership/ACL data on every invocation. */
export interface UncertainOperation {
  id: string;
  tool: string;
  input: unknown;
  reason: string;
  status: 'unknown' | 'applied' | 'not_applied';
}
export interface AccessControl {
  principal: Principal;
  /** Check the authoritative system; never retry an ambiguous write based on a model guess. */
  reconcile?(operation: Readonly<UncertainOperation>, principal: Readonly<Principal>, signal: AbortSignal):
    { status: 'unknown' | 'applied' | 'not_applied'; result?: unknown } |
    PromiseLike<{ status: 'unknown' | 'applied' | 'not_applied'; result?: unknown }>;
  authorize(action: Readonly<PendingAction>, principal: Readonly<Principal>, signal: AbortSignal):
    AccessDecision | PromiseLike<AccessDecision>;
}
