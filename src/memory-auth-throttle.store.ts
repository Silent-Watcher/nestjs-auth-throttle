import type {
  AuthThrottleState,
  AuthThrottleStore,
  AuthThrottleStoreEntry,
} from './auth-throttle.store.js';
import type { AuthThrottleClock } from './auth-throttle.types.js';
import { InvalidAuthThrottleConfigError } from './auth-throttle.errors.js';

export interface MemoryAuthThrottleStoreOptions {
  /** Time source used for expiry. Defaults to the system clock. */
  readonly clock?: AuthThrottleClock;
  /**
   * Upper bound on stored keys. When it is reached, expired entries are swept
   * first; if the store is still full, the least recently written entry is
   * evicted. Defaults to 10 000.
   */
  readonly maxEntries?: number;
  /** Run an expiry sweep after this many write operations. Defaults to 500. */
  readonly sweepEvery?: number;
}

interface Slot {
  readonly state: AuthThrottleState;
  readonly version: number;
  readonly expiresAt: number;
}

export const DEFAULT_MEMORY_STORE_MAX_ENTRIES = 10_000;
const DEFAULT_SWEEP_EVERY = 500;

/**
 * In-process store for development, tests and single-instance apps.
 *
 * Guarantees: every method body runs synchronously, so `compareAndSet` and
 * `delete` are atomic within one process. State is NOT shared between
 * processes or instances and is lost on restart, so limits are per-process
 * and a restart clears every lockout. Use a distributed store in production.
 *
 * Memory is bounded: expired entries are treated as absent on read, removed
 * opportunistically (no timers), swept every `sweepEvery` writes, and the
 * total is capped at `maxEntries`.
 */
export class MemoryAuthThrottleStore implements AuthThrottleStore {
  private readonly slots = new Map<string, Slot>();
  private readonly clock: AuthThrottleClock;
  private readonly maxEntries: number;
  private readonly sweepEvery: number;
  private version = 0;
  private writesSinceSweep = 0;

  constructor(options: MemoryAuthThrottleStoreOptions = {}) {
    const { maxEntries = DEFAULT_MEMORY_STORE_MAX_ENTRIES, sweepEvery = DEFAULT_SWEEP_EVERY } =
      options;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new InvalidAuthThrottleConfigError('maxEntries must be a positive integer.');
    }
    if (!Number.isInteger(sweepEvery) || sweepEvery < 1) {
      throw new InvalidAuthThrottleConfigError('sweepEvery must be a positive integer.');
    }
    this.clock = options.clock ?? { now: () => Date.now() };
    this.maxEntries = maxEntries;
    this.sweepEvery = sweepEvery;
  }

  /** Number of entries currently held, including expired ones not yet removed. */
  get size(): number {
    return this.slots.size;
  }

  async get(key: string): Promise<AuthThrottleStoreEntry | undefined> {
    const slot = this.live(key);
    return slot === undefined ? undefined : { state: slot.state, version: slot.version };
  }

  async compareAndSet(
    key: string,
    expectedVersion: number | undefined,
    state: AuthThrottleState,
    ttlMs: number,
  ): Promise<boolean> {
    const now = this.clock.now();
    const current = this.live(key, now);
    if (current?.version !== expectedVersion) return false;

    this.maybeSweep(now);
    // Re-insert so Map order reflects write recency (used for eviction).
    this.slots.delete(key);
    if (this.slots.size >= this.maxEntries) this.makeRoom(now);
    this.slots.set(key, { state, version: ++this.version, expiresAt: now + ttlMs });
    return true;
  }

  async delete(key: string, expectedVersion?: number): Promise<boolean> {
    if (expectedVersion === undefined) {
      this.slots.delete(key);
      return true;
    }
    const current = this.live(key);
    if (current?.version !== expectedVersion) return false;
    this.slots.delete(key);
    return true;
  }

  private live(key: string, now = this.clock.now()): Slot | undefined {
    const slot = this.slots.get(key);
    if (slot === undefined) return undefined;
    if (slot.expiresAt <= now) {
      this.slots.delete(key);
      return undefined;
    }
    return slot;
  }

  private maybeSweep(now: number): void {
    if (++this.writesSinceSweep < this.sweepEvery) return;
    this.sweep(now);
  }

  private sweep(now: number): void {
    this.writesSinceSweep = 0;
    for (const [key, slot] of this.slots) {
      if (slot.expiresAt <= now) this.slots.delete(key);
    }
  }

  private makeRoom(now: number): void {
    this.sweep(now);
    while (this.slots.size >= this.maxEntries) {
      const oldest = this.slots.keys().next();
      if (oldest.done === true) return;
      this.slots.delete(oldest.value);
    }
  }
}
