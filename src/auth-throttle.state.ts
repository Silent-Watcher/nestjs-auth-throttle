import type { AuthThrottlePolicy } from './auth-throttle.policy.js';
import type { AuthThrottleState } from './auth-throttle.store.js';
import type { AuthThrottleStatus } from './auth-throttle.types.js';

/**
 * Pure state transition logic. Nothing here touches storage or the clock.
 *
 * The stored state holds only timestamps; every threshold, window and
 * duration comes from the policy at evaluation time. A policy change
 * therefore applies immediately to existing state:
 * - raising `maxAttempts` gives keys with unlocked failures more headroom;
 * - lowering it below the stored failure count locks the key (from its latest
 *   failure) the next time it is evaluated;
 * - `window` / `cooldown` / `lockoutDuration` are re-applied to stored
 *   timestamps, so a shorter value releases keys sooner and a longer one holds
 *   them longer (an existing lockout also follows the new `lockoutDuration`).
 */

export const EMPTY_STATE: AuthThrottleState = Object.freeze({ failures: Object.freeze([]) });

export function isEmptyState(state: AuthThrottleState): boolean {
  return state.failures.length === 0 && state.lockedAt === undefined;
}

/**
 * Brings stored state up to date for `now`: clamps timestamps from the future
 * (clock skew between instances), drops expired failures, derives a lockout if
 * the limit is already reached, and forgets a finished lockout entirely.
 */
export function normalizeState(
  stored: AuthThrottleState | undefined,
  policy: AuthThrottlePolicy,
  now: number,
): AuthThrottleState {
  if (stored === undefined) return EMPTY_STATE;

  const windowMs = policy.window * 1000;
  const lockoutMs = policy.lockoutDuration * 1000;
  const clamped = stored.failures.map((at) => Math.min(at, now));
  let lockedAt = stored.lockedAt === undefined ? undefined : Math.min(stored.lockedAt, now);
  let failures = clamped;

  if (lockedAt === undefined) {
    failures = clamped.filter((at) => now - at < windowMs);
    if (failures.length >= policy.maxAttempts) {
      lockedAt = failures[failures.length - 1];
    }
  }
  if (failures.length > policy.maxAttempts) {
    failures = failures.slice(failures.length - policy.maxAttempts);
  }

  if (lockedAt !== undefined) {
    if (now >= lockedAt + lockoutMs) return EMPTY_STATE; // lockout over: start from zero
    return { failures, lockedAt };
  }
  if (failures.length === 0) return EMPTY_STATE;
  return { failures };
}

/** Describes normalized state. */
export function describeState(
  state: AuthThrottleState,
  policy: AuthThrottlePolicy,
  now: number,
): AuthThrottleStatus {
  const failedAttempts = state.failures.length;
  const base = { failedAttempts, maxAttempts: policy.maxAttempts };

  if (state.lockedAt !== undefined) {
    const blockedUntil = state.lockedAt + policy.lockoutDuration * 1000;
    return { ...base, state: 'locked', remainingAttempts: 0, ...blocked(blockedUntil, now) };
  }

  const last = state.failures[failedAttempts - 1];
  if (policy.cooldown > 0 && last !== undefined) {
    const blockedUntil = last + policy.cooldown * 1000;
    if (now < blockedUntil) {
      return {
        ...base,
        state: 'cooldown',
        remainingAttempts: Math.max(0, policy.maxAttempts - failedAttempts),
        ...blocked(blockedUntil, now),
      };
    }
  }

  return {
    ...base,
    state: 'allowed',
    remainingAttempts: Math.max(0, policy.maxAttempts - failedAttempts),
    retryAfter: 0,
  };
}

function blocked(blockedUntil: number, now: number): { retryAfter: number; blockedUntil: number } {
  return { retryAfter: Math.max(1, Math.ceil((blockedUntil - now) / 1000)), blockedUntil };
}

/**
 * Records a failure on normalized state. A failure while locked changes
 * nothing: it neither extends the lockout (that would let an attacker keep a
 * victim locked out forever) nor adds to the count. Failures during cooldown
 * do count, so parallel guesses cannot dodge the limit.
 */
export function applyFailure(
  state: AuthThrottleState,
  policy: AuthThrottlePolicy,
  now: number,
): AuthThrottleState {
  if (state.lockedAt !== undefined) return state;
  const failures = [...state.failures, now].slice(-policy.maxAttempts);
  return failures.length >= policy.maxAttempts ? { failures, lockedAt: now } : { failures };
}

/** How long the store should keep this (non-empty) state, in milliseconds. */
export function stateTtlMs(
  state: AuthThrottleState,
  policy: AuthThrottlePolicy,
  now: number,
): number {
  const end =
    state.lockedAt !== undefined
      ? state.lockedAt + policy.lockoutDuration * 1000
      : (state.failures[state.failures.length - 1] ?? now) + policy.window * 1000;
  return Math.max(1, Math.ceil(end - now));
}
