import type { AuthThrottleClock } from '../src/auth-throttle.types.js';

/** Deterministic clock: time only moves when a test advances it. */
export class FakeClock implements AuthThrottleClock {
  constructor(private current = 1_000_000) {}
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
  advanceSeconds(seconds: number): void {
    this.current += seconds * 1000;
  }
}
