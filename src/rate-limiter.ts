/**
 * Simple token-bucket rate limiter.
 * Tracks calls within a sliding window and sleeps when budget is exhausted.
 */
export class RateLimiter {
  private timestamps: number[] = [];

  constructor(
    private maxPerWindow: number,
    private windowMs: number,
  ) {}

  async acquire(): Promise<void> {
    const now = Date.now();
    // Prune timestamps outside the window
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);

    if (this.timestamps.length >= this.maxPerWindow) {
      // Sleep until the oldest timestamp exits the window
      const sleepMs = this.timestamps[0] + this.windowMs - now + 10;
      await new Promise(resolve => setTimeout(resolve, sleepMs));
      return this.acquire(); // Re-check after sleeping
    }

    this.timestamps.push(now);
  }

  get remaining(): number {
    const now = Date.now();
    const active = this.timestamps.filter(t => now - t < this.windowMs).length;
    return Math.max(0, this.maxPerWindow - active);
  }
}
