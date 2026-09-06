/**
 * Seedable RNG. Every source of chance in the engine flows through this, so a
 * (seed, agent-policy) pair reproduces a match exactly — required for replays,
 * for debugging a bot's blunder, and for paired-seed evaluation in the arena
 * (same dice, different bots, so noise cancels).
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    // Avoid the zero fixed point of the mulberry32 state.
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** A single six-sided die, 1..6. */
  d6(): number {
    return this.int(6) + 1;
  }

  /** Fisher-Yates, in place. */
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [xs[i], xs[j]] = [xs[j] as T, xs[i] as T];
    }
    return xs;
  }

  /** Snapshot/restore, so a search agent can fork the engine without drift. */
  getState(): number {
    return this.s;
  }

  setState(s: number): void {
    this.s = s >>> 0;
  }
}
