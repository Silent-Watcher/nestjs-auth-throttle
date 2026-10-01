import type { AuthThrottleClock } from './auth-throttle.types.js';

/** The only place in the package that reads real time. */
export const systemClock: AuthThrottleClock = { now: () => Date.now() };
