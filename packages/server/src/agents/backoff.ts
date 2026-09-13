/**
 * Retry policy for provider calls.
 *
 * A flat single retry is not enough: rate limits want the server's own `Retry-After`, overload
 * wants a longer sleep than a transient socket error, and everything wants jitter so a burst of
 * parallel sub-agents does not retry in lockstep. Every retry path is bounded — an unbounded
 * recovery loop is how an agent harness burns a month of budget overnight.
 */

export const MAX_PROVIDER_ATTEMPTS = 4;

export interface BackoffInput {
  /** 1 for the first retry. */
  attempt: number;
  status?: number;
  /** Seconds, from a `Retry-After` header when the provider sent one. */
  retryAfterSeconds?: number | null;
}

/** Delay before the next attempt, in milliseconds. */
export function backoffMs({ attempt, status, retryAfterSeconds }: BackoffInput, random: () => number = Math.random): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * 1000, 60_000);
  // Overload (529) recovers more slowly than a transient network blip, so start it higher.
  const base = status === 529 ? 4000 : status === 429 ? 2000 : 1000;
  const exponential = Math.min(base * 2 ** (attempt - 1), 32_000);
  // Full jitter: spreads a fan-out of sub-agents instead of re-colliding on the same boundary.
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/** Whether another attempt is worth making. */
export function shouldRetry(attempt: number, retryable: boolean, max = MAX_PROVIDER_ATTEMPTS): boolean {
  return retryable && attempt < max;
}
