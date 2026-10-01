/**
 * Throttle state for one (action, key). Contains only timestamps (ms since
 * epoch); never credentials, tokens or other secrets.
 */
export interface AuthThrottleState {
  /** Times of counted failures, ascending. Never longer than the policy's `maxAttempts`. */
  readonly failures: readonly number[];
  /** When the current lockout started. Its end is derived from the policy. */
  readonly lockedAt?: number;
}

/** A stored state together with the version a later update must be based on. */
export interface AuthThrottleStoreEntry {
  readonly state: AuthThrottleState;
  /** Opaque, unique per write. Must never repeat for a key, even after expiry. */
  readonly version: number;
}

/**
 * Storage contract. State transitions are optimistic: the service reads an
 * entry, computes the next state, and writes it only if nobody else wrote in
 * between. This is the only atomicity a store has to provide, and it maps
 * directly onto Redis (a Lua script or WATCH/MULTI) and SQL (a conditional
 * UPDATE).
 *
 * Implementations must:
 * - treat expired entries as absent in every method;
 * - make `compareAndSet` and `delete(key, expectedVersion)` atomic with respect
 *   to all other writers on the same key, including other processes;
 * - assign a fresh, never-reused version on every successful write;
 * - throw on infrastructure failure rather than returning empty results.
 */
export interface AuthThrottleStore {
  get(key: string): Promise<AuthThrottleStoreEntry | undefined>;

  /**
   * Writes `state` only if the key's current version equals `expectedVersion`
   * (`undefined` means the key must not exist). `ttlMs` is how long the entry
   * stays relevant. Resolves `false` when the precondition failed.
   */
  compareAndSet(
    key: string,
    expectedVersion: number | undefined,
    state: AuthThrottleState,
    ttlMs: number,
  ): Promise<boolean>;

  /**
   * Removes the key. With `expectedVersion`, removes it only if that is still
   * the current version and resolves whether it did. Without it, removal is
   * unconditional and resolves `true`.
   */
  delete(key: string, expectedVersion?: number): Promise<boolean>;
}
