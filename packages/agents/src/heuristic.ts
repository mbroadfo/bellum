/**
 * A hand-written baseline strong enough to be worth beating.
 *
 * Every knob lives in `HeuristicWeights`, which makes this both the algorithmic
 * competitor and a second, cheap evolution target: a genome of 9 floats is a
 * useful control against a NEAT genome of a few hundred, and tells you whether
 * topology search is buying anything over parameter tuning.
 *
 * The strategy is the consensus one from the Lux Delux bot community: value
 * continents by bonus-per-border rather than raw bonus, stage troops in one
 * place rather than spreading them, and always take at least one territory per
 * turn for the card.
 */
import {
  type Agent,
  type AttackOption,
  type Move,
  type PlayerView,
  type Query,
  type TerritoryId,
  attackOptions,
  borderTerritories,
  myTerritories,
} from "@bellum/core";
import { findSets } from "./random.js";

export interface HeuristicWeights {
  /** Minimum win probability before a normal attack is worth it. */
  attackThreshold: number;
  /** Lower threshold while still hunting the first conquest of the turn (the card). */
  cardHuntThreshold: number;
  /** Weight on completing or defending a continent. */
  continentValue: number;
  /** Weight on hitting the current leader rather than the nearest target. */
  targetLeader: number;
  /** How much of a staging stack to keep in one place, 1 = all in one territory. */
  concentration: number;
  /** Weight on troops adjacent to a border when judging threat. */
  threatWeight: number;
  /** Prefer small continents when claiming. */
  claimCompactness: number;
  /** Willingness to press an attack that would eliminate a player. */
  eliminationBonus: number;
  /** Reserve kept behind when moving in after a conquest, as a fraction. */
  advanceFraction: number;
}

export const DEFAULT_WEIGHTS: HeuristicWeights = {
  attackThreshold: 0.62,
  cardHuntThreshold: 0.45,
  continentValue: 1.4,
  targetLeader: 0.8,
  concentration: 0.75,
  threatWeight: 1.0,
  claimCompactness: 1.2,
  eliminationBonus: 2.5,
  advanceFraction: 0.8,
};

export class HeuristicAgent implements Agent {
  readonly synchronous = true;
  private conqueredThisTurn = false;
  private lastTurn = -1;

  constructor(
    readonly name = "heuristic",
    private readonly w: HeuristicWeights = DEFAULT_WEIGHTS,
  ) {}

  act(query: Query, view: PlayerView): Move {
    if (view.turn !== this.lastTurn) {
      this.lastTurn = view.turn;
      this.conqueredThisTurn = false;
    }

    switch (query.type) {
      case "claim_territory":
        return { type: "claim_territory", territory: this.bestClaim(view, query.unclaimed) };

      case "place_initial_troop":
        return { type: "place_initial_troop", territory: this.bestStaging(view) };

      case "redeem_cards":
        return { type: "redeem_cards", sets: findSets(view, Infinity) };

      case "distribute_troops":
        return { type: "distribute_troops", distribution: this.distribute(view, query.total) };

      case "attack": {
        const choice = this.bestAttack(view);
        if (!choice) return { type: "attack_pass" };
        return {
          type: "attack",
          from: choice.from,
          to: choice.to,
          attackingTroops: Math.min(3, choice.attacking),
        };
      }

      case "defend":
        // Two dice is better than one whenever it is available: it wins more
        // pairwise comparisons than the extra exposure costs.
        return { type: "defend", defendingTroops: Math.min(2, view.troops[query.to]!) };

      case "troops_after_attack": {
        this.conqueredThisTurn = true;
        const stayBehind = this.isInterior(view, query.from) ? 0 : 1;
        const want = Math.floor((query.max - stayBehind) * this.w.advanceFraction);
        return { type: "troops_after_attack", troops: clamp(want, query.min, query.max) };
      }

      case "fortify":
        return this.fortify(view);
    }
  }

  // --- Territory valuation ---------------------------------------------------

  /** Bonus per border territory: what a continent is actually worth to hold. */
  private continentEfficiency(view: PlayerView, continentId: number): number {
    const c = view.map.continents[continentId]!;
    const borders = c.territories.filter((t) =>
      view.map.adjacency[t]!.some((n) => view.map.continentOf[n] !== continentId),
    ).length;
    return c.bonus / Math.max(1, borders) / Math.pow(c.territories.length, 1 / this.w.claimCompactness);
  }

  private bestClaim(view: PlayerView, unclaimed: readonly TerritoryId[]): TerritoryId {
    let best = unclaimed[0]!;
    let bestScore = -Infinity;
    for (const t of unclaimed) {
      const cid = view.map.continentOf[t]!;
      const c = view.map.continents[cid]!;
      const mine = c.territories.filter((x) => view.owner[x] === view.me).length;
      const theirs = c.territories.filter((x) => view.owner[x] !== view.me && view.owner[x] !== -1).length;
      const friendlyNeighbours = view.map.adjacency[t]!.filter((n) => view.owner[n] === view.me).length;

      const score =
        this.continentEfficiency(view, cid) * this.w.continentValue * 10 +
        mine * 1.5 -
        theirs * 1.2 +
        friendlyNeighbours * 0.9;

      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  private isInterior(view: PlayerView, t: TerritoryId): boolean {
    return view.map.adjacency[t]!.every((n) => view.owner[n] === view.me);
  }

  /** Enemy troops that can reach this territory next turn. */
  private threat(view: PlayerView, t: TerritoryId): number {
    let sum = 0;
    for (const n of view.map.adjacency[t]!) {
      if (view.owner[n] !== view.me) sum += view.troops[n]!;
    }
    return sum;
  }

  /** The border territory best worth pouring reinforcements into. */
  private bestStaging(view: PlayerView): TerritoryId {
    const borders = borderTerritories(view);
    const candidates = borders.length > 0 ? borders : myTerritories(view);
    let best = candidates[0]!;
    let bestScore = -Infinity;

    const leader = [...view.opponents].filter((o) => o.alive).sort((a, b) => b.territories - a.territories)[0];

    for (const t of candidates) {
      const cid = view.map.continentOf[t]!;
      const c = view.map.continents[cid]!;
      const mineInContinent = c.territories.filter((x) => view.owner[x] === view.me).length;
      const nearlyMine = mineInContinent / c.territories.length;

      const touchesLeader =
        leader !== undefined && view.map.adjacency[t]!.some((n) => view.owner[n] === leader.id) ? 1 : 0;

      const score =
        this.threat(view, t) * this.w.threatWeight +
        this.continentEfficiency(view, cid) * this.w.continentValue * 8 * nearlyMine +
        touchesLeader * this.w.targetLeader * 3 -
        view.troops[t]! * 0.35;

      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }

  private distribute(view: PlayerView, total: number): Record<number, number> {
    const primary = this.bestStaging(view);
    const stack = Math.max(1, Math.round(total * this.w.concentration));
    const distribution: Record<number, number> = { [primary]: Math.min(stack, total) };

    let left = total - (distribution[primary] ?? 0);
    if (left > 0) {
      // Spread the remainder over the most threatened other borders.
      const rest = borderTerritories(view)
        .filter((t) => t !== primary)
        .sort((a, b) => this.threat(view, b) - this.threat(view, a));
      if (rest.length === 0) {
        distribution[primary] = (distribution[primary] ?? 0) + left;
        left = 0;
      }
      for (let i = 0; left > 0 && i < rest.length; i++) {
        const t = rest[i]!;
        distribution[t] = (distribution[t] ?? 0) + 1;
        left--;
        if (i === rest.length - 1 && left > 0) i = -1; // wrap and keep going
      }
    }
    return distribution;
  }

  private bestAttack(view: PlayerView): AttackOption | null {
    const options = attackOptions(view);
    if (options.length === 0) return null;

    const threshold = this.conqueredThisTurn ? this.w.attackThreshold : this.w.cardHuntThreshold;
    const leader = [...view.opponents].filter((o) => o.alive).sort((a, b) => b.territories - a.territories)[0];

    let best: AttackOption | null = null;
    let bestScore = 0;

    for (const o of options) {
      if (o.winProb < threshold) continue;

      const targetOwner = view.owner[o.to]!;
      const cid = view.map.continentOf[o.to]!;
      const c = view.map.continents[cid]!;
      const otherMissing = c.territories.filter((x) => x !== o.to && view.owner[x] !== view.me).length;

      // Taking the last piece of a continent is worth far more than the first.
      const completes = otherMissing === 0 ? this.continentEfficiency(view, cid) * this.w.continentValue * 12 : 0;
      const victim = view.opponents.find((x) => x.id === targetOwner);
      const finishesThem = victim && victim.territories === 1 ? this.w.eliminationBonus * 4 : 0;
      const hitsLeader = leader && targetOwner === leader.id ? this.w.targetLeader * 2 : 0;

      const score = o.winProb * (3 + completes + finishesThem + hitsLeader) - o.defending * 0.05;
      if (score > bestScore) {
        bestScore = score;
        best = o;
      }
    }
    return best;
  }

  private fortify(view: PlayerView): Move {
    const mine = myTerritories(view);
    const interior = mine.filter((t) => view.troops[t]! > 1 && this.isInterior(view, t));
    if (interior.length === 0) return { type: "fortify_pass" };

    const from = interior.sort((a, b) => view.troops[b]! - view.troops[a]!)[0]!;

    // Nearest border reachable through my own territory, breadth first.
    const seen = new Set<TerritoryId>([from]);
    let frontier: TerritoryId[] = [from];
    let target: TerritoryId | null = null;
    let bestThreat = -1;

    while (frontier.length > 0 && target === null) {
      const next: TerritoryId[] = [];
      for (const t of frontier) {
        for (const n of view.map.adjacency[t]!) {
          if (view.owner[n] !== view.me || seen.has(n)) continue;
          seen.add(n);
          next.push(n);
          const threat = this.threat(view, n);
          if (threat > bestThreat) {
            bestThreat = threat;
            target = n;
          }
        }
      }
      if (target !== null) break;
      frontier = next;
    }

    if (target === null || target === from) return { type: "fortify_pass" };
    return { type: "fortify", from, to: target, troops: view.troops[from]! - 1 };
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
