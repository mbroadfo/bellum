/**
 * Skill ratings for free-for-all games.
 *
 * Elo is a two-player model. In a six-player game it has no principled way to
 * say how much beating four opponents at once is worth, and it cannot express
 * "this bot has only played three games, do not trust its number yet" - which is
 * exactly the question a ladder mixing an expensive LLM (dozens of games) with a
 * NEAT population (millions) has to answer.
 *
 * So: TrueSkill, with the standard pairwise approximation. Each finishing order
 * is decomposed into the pairs it implies and every pair updated in sequence.
 * That is not the full factor-graph message passing of the original paper, but
 * it converges to the same ordering and is a hundred lines instead of a
 * thousand. Leaderboards are sorted by the conservative estimate mu - 3*sigma,
 * so an unproven agent has to actually play before it can top the table.
 */

export interface Rating {
  /** Believed skill. */
  mu: number;
  /** Uncertainty about that belief. */
  sigma: number;
}

export interface TrueSkillConfig {
  readonly mu: number;
  readonly sigma: number;
  /** Performance noise per game: how much a single result should move things. */
  readonly beta: number;
  /** Added back each game so a long-idle agent's rating can move again. */
  readonly tau: number;
}

export const DEFAULT_CONFIG: TrueSkillConfig = {
  mu: 25,
  sigma: 25 / 3,
  beta: 25 / 6,
  tau: 25 / 300,
};

export function newRating(config: TrueSkillConfig = DEFAULT_CONFIG): Rating {
  return { mu: config.mu, sigma: config.sigma };
}

/** What to sort a leaderboard by: skill discounted by how unsure we are. */
export function conservative(r: Rating): number {
  return r.mu - 3 * r.sigma;
}

function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/** Normal CDF via erf; Abramowitz and Stegun 7.1.26, good to ~1e-7. */
function cdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

/** Mean of the truncated Gaussian: how surprising the result was. */
function vWin(t: number): number {
  const denom = cdf(t);
  // Far out in the tail the ratio underflows; the asymptote is -t.
  return denom < 1e-10 ? -t : pdf(t) / denom;
}

function wWin(t: number): number {
  const v = vWin(t);
  const w = v * (v + t);
  return w > 0 && w < 1 ? w : 1;
}

/**
 * Update ratings from one finished game.
 *
 * @param ranking player indices into `ratings`, best first, no ties.
 */
export function updateRatings(
  ratings: Rating[],
  ranking: readonly number[],
  config: TrueSkillConfig = DEFAULT_CONFIG,
): void {
  for (const i of ranking) {
    const r = ratings[i]!;
    r.sigma = Math.sqrt(r.sigma * r.sigma + config.tau * config.tau);
  }

  for (let a = 0; a < ranking.length; a++) {
    for (let b = a + 1; b < ranking.length; b++) {
      const winner = ratings[ranking[a]!]!;
      const loser = ratings[ranking[b]!]!;

      const c2 = 2 * config.beta * config.beta + winner.sigma * winner.sigma + loser.sigma * loser.sigma;
      const c = Math.sqrt(c2);
      const t = (winner.mu - loser.mu) / c;

      const v = vWin(t);
      const w = wWin(t);

      winner.mu += (winner.sigma * winner.sigma / c) * v;
      loser.mu -= (loser.sigma * loser.sigma / c) * v;

      winner.sigma *= Math.sqrt(Math.max(1 - (winner.sigma * winner.sigma / c2) * w, 1e-4));
      loser.sigma *= Math.sqrt(Math.max(1 - (loser.sigma * loser.sigma / c2) * w, 1e-4));
    }
  }
}
