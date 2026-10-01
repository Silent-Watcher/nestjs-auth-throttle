import { Inject, Injectable } from '@nestjs/common';
import {
  AuthThrottleError,
  AuthThrottleStoreError,
  InvalidAuthThrottleConfigError,
} from './auth-throttle.errors.js';
import type { AuthThrottleOptions } from './auth-throttle.options.js';
import {
  createPolicyResolver,
  type AuthThrottlePolicy,
  type AuthThrottlePolicyResolver,
} from './auth-throttle.policy.js';
import {
  EMPTY_STATE,
  applyFailure,
  describeState,
  isEmptyState,
  normalizeState,
  stateTtlMs,
} from './auth-throttle.state.js';
import type {
  AuthThrottleState,
  AuthThrottleStore,
  AuthThrottleStoreEntry,
} from './auth-throttle.store.js';
import {
  AUTH_THROTTLE_CLOCK,
  AUTH_THROTTLE_OPTIONS,
  AUTH_THROTTLE_STORE,
} from './auth-throttle.tokens.js';
import type {
  AuthThrottleClock,
  AuthThrottleResult,
  AuthThrottleStatus,
  AuthThrottleTarget,
} from './auth-throttle.types.js';
import { assertValidAction, assertValidKey } from './auth-throttle.validation.js';

/** How often a read-modify-write is retried after losing a race. */
const MAX_UPDATE_ATTEMPTS = 16;

interface Outcome {
  /** State to persist; `undefined` leaves storage untouched. */
  readonly next: AuthThrottleState | undefined;
  readonly status: (now: number) => AuthThrottleStatus;
}

@Injectable()
export class AuthThrottleService {
  private readonly policyFor: AuthThrottlePolicyResolver;

  constructor(
    @Inject(AUTH_THROTTLE_OPTIONS) options: AuthThrottleOptions,
    @Inject(AUTH_THROTTLE_STORE) private readonly store: AuthThrottleStore,
    @Inject(AUTH_THROTTLE_CLOCK) private readonly clock: AuthThrottleClock,
  ) {
    if (typeof options !== 'object' || options === null) {
      throw new InvalidAuthThrottleConfigError('Auth throttle options must be an object.');
    }
    for (const method of ['get', 'compareAndSet', 'delete'] as const) {
      if (typeof (store as Partial<AuthThrottleStore> | undefined)?.[method] !== 'function') {
        throw new InvalidAuthThrottleConfigError(
          `Auth throttle store must implement ${method}().`,
        );
      }
    }
    if (typeof (clock as Partial<AuthThrottleClock> | undefined)?.now !== 'function') {
      throw new InvalidAuthThrottleConfigError('Auth throttle clock must implement now().');
    }
    this.policyFor = createPolicyResolver(options);
  }

  /**
   * Reports whether an attempt may proceed. Does not change state. Call it
   * before verifying credentials.
   */
  async check(target: AuthThrottleTarget): Promise<AuthThrottleResult> {
    return toResult(await this.getStatus(target));
  }

  /** Detailed read-only view of the current state. */
  async getStatus(target: AuthThrottleTarget): Promise<AuthThrottleStatus> {
    const { storeKey, policy } = this.resolve(target);
    const entry = await this.read(storeKey);
    const now = this.clock.now();
    return describeState(normalizeState(entry?.state, policy, now), policy, now);
  }

  /**
   * Records a failed attempt and returns the resulting state. The failure that
   * reaches `maxAttempts` starts the lockout (`reason: 'locked'`). While a
   * lockout is active, further failures change nothing.
   */
  async recordFailure(target: AuthThrottleTarget): Promise<AuthThrottleResult> {
    const { storeKey, policy } = this.resolve(target);
    const status = await this.update(storeKey, policy, (state, now) => {
      const next = applyFailure(state, policy, now);
      return {
        next: next === state ? undefined : next,
        status: (at) => describeState(next, policy, at),
      };
    });
    return toResult(status);
  }

  /**
   * Records a successful attempt. With `resetOnSuccess` (the default) this
   * clears recorded failures. It never lifts an active lockout: only `reset`
   * does, so a request that skipped `check` cannot bypass a lockout.
   */
  async recordSuccess(target: AuthThrottleTarget): Promise<AuthThrottleResult> {
    const { storeKey, policy } = this.resolve(target);
    const status = await this.update(storeKey, policy, (state) => {
      if (!policy.resetOnSuccess || state.lockedAt !== undefined) {
        return { next: undefined, status: (at) => describeState(state, policy, at) };
      }
      return { next: EMPTY_STATE, status: (at) => describeState(EMPTY_STATE, policy, at) };
    });
    return toResult(status);
  }

  /** Unconditionally clears all throttle state for the target, including a lockout. */
  async reset(target: AuthThrottleTarget): Promise<void> {
    const { storeKey } = this.resolve(target);
    try {
      await this.store.delete(storeKey);
    } catch (error) {
      throw storeFailure(error);
    }
  }

  private resolve(target: AuthThrottleTarget): { storeKey: string; policy: AuthThrottlePolicy } {
    if (typeof target !== 'object' || target === null) {
      throw new TypeError('A throttle target { action, key } is required.');
    }
    assertValidAction(target.action);
    assertValidKey(target.key);
    // Actions cannot contain ':', so the composite key is unambiguous.
    return { storeKey: `${target.action}:${target.key}`, policy: this.policyFor(target.action) };
  }

  private async read(storeKey: string): Promise<AuthThrottleStoreEntry | undefined> {
    let entry: unknown;
    try {
      entry = await this.store.get(storeKey);
    } catch (error) {
      throw storeFailure(error);
    }
    return entry === undefined ? undefined : parseEntry(entry);
  }

  /**
   * Optimistic read-modify-write. The store only accepts the write if nobody
   * else wrote since the read, so concurrent failures are never lost; a loser
   * simply re-reads and recomputes.
   */
  private async update(
    storeKey: string,
    policy: AuthThrottlePolicy,
    transition: (state: AuthThrottleState, now: number) => Outcome,
  ): Promise<AuthThrottleStatus> {
    for (let attempt = 0; attempt < MAX_UPDATE_ATTEMPTS; attempt++) {
      const entry = await this.read(storeKey);
      const now = this.clock.now();
      const state = normalizeState(entry?.state, policy, now);
      const outcome = transition(state, now);

      if (outcome.next === undefined) return outcome.status(now);

      let written: boolean;
      try {
        if (isEmptyState(outcome.next)) {
          written = entry === undefined ? true : await this.store.delete(storeKey, entry.version);
        } else {
          written = await this.store.compareAndSet(
            storeKey,
            entry?.version,
            outcome.next,
            stateTtlMs(outcome.next, policy, now),
          );
        }
      } catch (error) {
        throw storeFailure(error);
      }
      if (written) return outcome.status(now);
    }
    throw new AuthThrottleStoreError(
      'Could not update throttle state: too many concurrent writers for the same key.',
    );
  }
}

function toResult(status: AuthThrottleStatus): AuthThrottleResult {
  if (status.state === 'allowed') {
    return {
      allowed: true,
      failedAttempts: status.failedAttempts,
      remainingAttempts: status.remainingAttempts,
    };
  }
  return {
    allowed: false,
    reason: status.state,
    retryAfter: status.retryAfter,
    failedAttempts: status.failedAttempts,
    remainingAttempts: status.remainingAttempts,
  };
}

function storeFailure(error: unknown): AuthThrottleError {
  if (error instanceof AuthThrottleError) return error;
  // The key is deliberately left out of the message: it may identify a person.
  return new AuthThrottleStoreError('Auth throttle store operation failed.', { cause: error });
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Never trust what a store returns: malformed state must not become "allowed". */
function parseEntry(raw: unknown): AuthThrottleStoreEntry {
  const malformed = (): never => {
    throw new AuthThrottleStoreError('Auth throttle store returned malformed state.');
  };
  if (typeof raw !== 'object' || raw === null) return malformed();
  const { state, version } = raw as { state?: unknown; version?: unknown };
  if (!isFiniteNumber(version)) return malformed();
  if (typeof state !== 'object' || state === null) return malformed();
  const { failures, lockedAt } = state as { failures?: unknown; lockedAt?: unknown };
  if (!Array.isArray(failures) || !failures.every(isFiniteNumber)) return malformed();
  if (lockedAt !== undefined && !isFiniteNumber(lockedAt)) return malformed();
  const sorted = [...(failures as number[])].sort((a, b) => a - b);
  return {
    version,
    state: lockedAt === undefined ? { failures: sorted } : { failures: sorted, lockedAt },
  };
}
