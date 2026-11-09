// Injectable clock. Every time-based rule (OTP expiry, rate limits, token expiry) reads time
// from a Clock so tests can move time without waiting.

export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

/** Manually driven clock for tests. */
export class FakeClock implements Clock {
  constructor(private t: number = Date.UTC(2026, 10, 6, 12, 0, 0)) {}

  now(): number {
    return this.t;
  }

  advance(ms: number): void {
    this.t += ms;
  }

  set(t: number): void {
    this.t = t;
  }
}
