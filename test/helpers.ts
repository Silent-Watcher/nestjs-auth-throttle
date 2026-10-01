import { AuthThrottleService } from '../src/auth-throttle.service.js';
import type { AuthThrottleOptions } from '../src/auth-throttle.options.js';
import type { AuthThrottleStore } from '../src/auth-throttle.store.js';
import { FakeClock } from './fake-clock.js';
import { MemoryAuthThrottleStore } from '../src/memory-auth-throttle.store.js';

export function createHarness(options: AuthThrottleOptions = {}, store?: AuthThrottleStore) {
  const clock = new FakeClock();
  const memory = new MemoryAuthThrottleStore({ clock });
  const activeStore = store ?? memory;
  const service = new AuthThrottleService(options, activeStore, clock);
  return { service, clock, store: activeStore, memory };
}

/** Small, round numbers that make timeline assertions easy to read. */
export const TEST_POLICY = { maxAttempts: 3, window: 60, cooldown: 0, lockoutDuration: 120 };
