/**
 * The ladder.
 *
 * One entrant list, one rating table, three paradigms in the same seats. The
 * runner picks the synchronous path automatically when every agent in a match
 * declares itself synchronous, which is what lets a NEAT fitness sweep and an
 * LLM exhibition share this file rather than forking it.
 *
 * An illegal move is a result, not a crash: the offender is ranked last for that
 * game, the violation is counted, and the ladder keeps going. A bot that cheats
 * its way to a good rating is worse than one that loses honestly, so the
 * violation count is reported next to the rating rather than buried.
 */
import { IllegalMoveError, type Agent, type MatchResult, runMatch, runMatchSync } from "@bellum/core";
import { DEFAULT_CONFIG, type Rating, type TrueSkillConfig, conservative, newRating, updateRatings } from "./rating.js";

export type Paradigm = "algorithmic" | "llm" | "neat" | "human" | "baseline";

export interface Entrant {
  readonly name: string;
  readonly paradigm: Paradigm;
  /** A fresh agent per game, so per-game scratch state cannot leak between matches. */
  create(seat: number, gameSeed: number): Agent;
}

export interface TournamentOptions {
  readonly entrants: readonly Entrant[];
  readonly games: number;
  readonly playersPerGame?: number;
  readonly seed?: number;
  readonly maxTurns?: number;
  readonly config?: TrueSkillConfig;
  readonly onGame?: (index: number, result: MatchResult | null, seats: readonly Entrant[]) => void;
}

export interface Standing {
  readonly name: string;
  readonly paradigm: Paradigm;
  readonly rating: Rating;
  readonly score: number;
  readonly games: number;
  readonly wins: number;
  readonly winRate: number;
  readonly avgRank: number;
  readonly violations: number;
  readonly avgTurns: number;
}

export async function runTournament(opts: TournamentOptions): Promise<Standing[]> {
  const {
    entrants,
    games,
    playersPerGame = Math.min(6, Math.max(2, entrants.length)),
    seed = 1,
    maxTurns = 400,
    config = DEFAULT_CONFIG,
  } = opts;

  if (entrants.length < playersPerGame) {
    throw new Error(`need at least ${playersPerGame} entrants, got ${entrants.length}`);
  }

  const ratings = entrants.map(() => newRating(config));
  const stats = entrants.map(() => ({ games: 0, wins: 0, rankSum: 0, violations: 0, turnSum: 0 }));

  for (let g = 0; g < games; g++) {
    const gameSeed = seed * 1_000_003 + g;
    // Rotate the entrant list so seats and matchups both vary without an RNG.
    const seats: Entrant[] = [];
    const indices: number[] = [];
    for (let s = 0; s < playersPerGame; s++) {
      const idx = (g * playersPerGame + s) % entrants.length;
      indices.push(idx);
      seats.push(entrants[idx]!);
    }

    const agents = seats.map((e, s) => e.create(s, gameSeed));
    const allSync = agents.every((a) => a.synchronous === true);

    let result: MatchResult | null = null;
    let ranking: number[];

    try {
      result = allSync
        ? runMatchSync(agents, { seed: gameSeed, maxTurns })
        : await runMatch(agents, { seed: gameSeed, maxTurns });
      ranking = result.ranking.map((seat) => indices[seat]!);
    } catch (err) {
      if (!(err instanceof IllegalMoveError)) throw err;
      const offender = indices[err.player]!;
      stats[offender]!.violations++;
      // Everyone else keeps their seat order; the offender drops to last.
      ranking = indices.filter((i) => i !== offender).concat(offender);
    }

    updateRatings(ratings, ranking, config);

    for (let rank = 0; rank < ranking.length; rank++) {
      const e = stats[ranking[rank]!]!;
      e.games++;
      e.rankSum += rank + 1;
      e.turnSum += result?.turns ?? maxTurns;
      if (rank === 0 && result?.winner !== null) e.wins++;
    }

    opts.onGame?.(g, result, seats);
  }

  return entrants
    .map((e, i) => {
      const s = stats[i]!;
      return {
        name: e.name,
        paradigm: e.paradigm,
        rating: ratings[i]!,
        score: conservative(ratings[i]!),
        games: s.games,
        wins: s.wins,
        winRate: s.games ? s.wins / s.games : 0,
        avgRank: s.games ? s.rankSum / s.games : 0,
        violations: s.violations,
        avgTurns: s.games ? s.turnSum / s.games : 0,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function formatStandings(standings: readonly Standing[]): string {
  const head = ["#", "agent", "kind", "score", "mu", "sigma", "games", "win%", "avg rank", "illegal"];
  const rows = standings.map((s, i) => [
    String(i + 1),
    s.name,
    s.paradigm,
    s.score.toFixed(2),
    s.rating.mu.toFixed(2),
    s.rating.sigma.toFixed(2),
    String(s.games),
    (s.winRate * 100).toFixed(1),
    s.avgRank.toFixed(2),
    String(s.violations),
  ]);

  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const line = (cells: string[]): string => cells.map((v, c) => v.padEnd(widths[c]!)).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}
