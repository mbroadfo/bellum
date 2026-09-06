/**
 * The neuroevolution seat.
 *
 * This is deliberately not a NEAT implementation. It is the fixed contract a
 * NEAT implementation has to satisfy, so the evolution library stays swappable:
 * feed it a `Policy`, which is any pure function from the observation vector to
 * an output vector, and it plays legal Risk.
 *
 * Output layout, length `territoryCount + 4`:
 *   [0 .. T-1]  a desirability score per territory, reused for claiming,
 *               reinforcing, choosing attack targets, and fortifying
 *   [T + 0]     attack appetite, squashed to a win-probability threshold
 *   [T + 1]     concentration, how much of the income goes on one territory
 *   [T + 2]     advance fraction after a conquest
 *   [T + 3]     unused, reserved so adding a head later does not shift indices
 *
 * Keeping one score-per-territory head rather than a head per decision is what
 * makes the genome map-shaped instead of phase-shaped, which is the property the
 * graph-convolution work (arXiv:2009.06355) found mattered.
 */
import {
  type Agent,
  type Move,
  type PlayerView,
  type Query,
  attackOptions,
  borderTerritories,
  encode,
  myTerritories,
  observationSize,
} from "@bellum/core";
import { findSets } from "./random.js";

export type Policy = (input: Float32Array) => Float32Array;

export function policyOutputSize(territoryCount: number): number {
  return territoryCount + 4;
}

export class NeatAgent implements Agent {
  readonly synchronous = true;
  private buf: Float32Array | null = null;

  constructor(
    readonly name: string,
    private readonly policy: Policy,
  ) {}

  private run(view: PlayerView): Float32Array {
    this.buf ??= new Float32Array(observationSize(view.map));
    const out = this.policy(encode(view, this.buf));
    const want = policyOutputSize(view.map.territoryCount);
    if (out.length !== want) {
      throw new Error(`policy "${this.name}" returned ${out.length} outputs, expected ${want}`);
    }
    return out;
  }

  private argmax(scores: Float32Array, over: readonly number[]): number {
    let best = over[0]!;
    let bestScore = -Infinity;
    for (const t of over) {
      const s = scores[t]!;
      if (s > bestScore) {
        bestScore = s;
        best = t;
      }
    }
    return best;
  }

  act(query: Query, view: PlayerView): Move {
    const T = view.map.territoryCount;

    switch (query.type) {
      case "claim_territory": {
        const out = this.run(view);
        return { type: "claim_territory", territory: this.argmax(out, query.unclaimed) };
      }

      case "place_initial_troop": {
        const out = this.run(view);
        return { type: "place_initial_troop", territory: this.argmax(out, myTerritories(view)) };
      }

      case "redeem_cards":
        // Always cashing is close to optimal under an escalating bonus, so this
        // is not left to evolution: it would only waste genome capacity.
        return { type: "redeem_cards", sets: findSets(view, Infinity) };

      case "distribute_troops": {
        const out = this.run(view);
        const mine = myTerritories(view);
        const borders = borderTerritories(view);
        const pool = borders.length > 0 ? borders : mine;

        const concentration = sigmoid(out[T + 1]!);
        const primary = this.argmax(out, pool);
        const onPrimary = Math.max(1, Math.min(query.total, Math.round(query.total * concentration)));

        const distribution: Record<number, number> = { [primary]: onPrimary };
        let left = query.total - onPrimary;
        const rest = pool.filter((t) => t !== primary).sort((a, b) => out[b]! - out[a]!);
        for (let i = 0; left > 0; i = (i + 1) % Math.max(1, rest.length)) {
          const t = rest[i] ?? primary;
          distribution[t] = (distribution[t] ?? 0) + 1;
          left--;
        }
        return { type: "distribute_troops", distribution };
      }

      case "attack": {
        const out = this.run(view);
        const threshold = sigmoid(out[T]!);
        const options = attackOptions(view).filter((o) => o.winProb >= threshold);
        if (options.length === 0) return { type: "attack_pass" };

        let best = options[0]!;
        let bestScore = -Infinity;
        for (const o of options) {
          const score = out[o.to]! * o.winProb;
          if (score > bestScore) {
            bestScore = score;
            best = o;
          }
        }
        return { type: "attack", from: best.from, to: best.to, attackingTroops: Math.min(3, best.attacking) };
      }

      case "defend":
        return { type: "defend", defendingTroops: Math.min(2, view.troops[query.to]!) };

      case "troops_after_attack": {
        const out = this.run(view);
        const frac = sigmoid(out[T + 2]!);
        const want = Math.round(query.min + (query.max - query.min) * frac);
        return { type: "troops_after_attack", troops: Math.max(query.min, Math.min(query.max, want)) };
      }

      case "fortify": {
        const out = this.run(view);
        const mine = myTerritories(view);
        const sources = mine.filter((t) => view.troops[t]! > 1);
        if (sources.length === 0) return { type: "fortify_pass" };

        // Only same-component moves are legal, so restrict to direct neighbours:
        // cheap, always legal, and loses little against a full connectivity search.
        let bestFrom = -1;
        let bestTo = -1;
        let bestScore = -Infinity;
        for (const from of sources) {
          for (const to of view.map.adjacency[from]!) {
            if (view.owner[to] !== view.me) continue;
            const score = out[to]! - out[from]!;
            if (score > bestScore) {
              bestScore = score;
              bestFrom = from;
              bestTo = to;
            }
          }
        }
        if (bestFrom < 0 || bestScore <= 0) return { type: "fortify_pass" };
        return { type: "fortify", from: bestFrom, to: bestTo, troops: view.troops[bestFrom]! - 1 };
      }
    }
  }
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
