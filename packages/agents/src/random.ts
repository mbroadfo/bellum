/**
 * The floor of the ladder. Every legal answer is equally likely.
 *
 * Its real job is to be a correctness oracle: run a few thousand random-vs-random
 * games and any rule the engine gets wrong surfaces as a thrown IllegalMoveError
 * or a game that never ends.
 */
import {
  type Agent,
  type Move,
  type PlayerView,
  type Query,
  Rng,
  attackOptions,
  myTerritories,
} from "@bellum/core";

export class RandomAgent implements Agent {
  readonly synchronous = true;
  private rng: Rng;

  constructor(
    readonly name = "random",
    seed = 1,
  ) {
    this.rng = new Rng(seed);
  }

  act(query: Query, view: PlayerView): Move {
    const pick = <T>(xs: readonly T[]): T => xs[this.rng.int(xs.length)]!;

    switch (query.type) {
      case "claim_territory":
        return { type: "claim_territory", territory: pick(query.unclaimed) };

      case "place_initial_troop":
        return { type: "place_initial_troop", territory: pick(myTerritories(view)) };

      case "redeem_cards": {
        const sets = findSets(view, query.cause === "forced" ? Infinity : 1);
        return { type: "redeem_cards", sets };
      }

      case "distribute_troops": {
        const mine = myTerritories(view);
        const distribution: Record<number, number> = {};
        for (let i = 0; i < query.total; i++) {
          const t = pick(mine);
          distribution[t] = (distribution[t] ?? 0) + 1;
        }
        return { type: "distribute_troops", distribution };
      }

      case "attack": {
        const options = attackOptions(view);
        if (options.length === 0 || this.rng.next() < 0.3) return { type: "attack_pass" };
        const o = pick(options);
        return { type: "attack", from: o.from, to: o.to, attackingTroops: Math.min(3, o.attacking) };
      }

      case "defend":
        return { type: "defend", defendingTroops: Math.min(2, view.troops[query.to]!) };

      case "troops_after_attack":
        return { type: "troops_after_attack", troops: query.min + this.rng.int(query.max - query.min + 1) };

      case "fortify": {
        const mine = myTerritories(view);
        const sources = mine.filter((t) => view.troops[t]! > 1);
        if (sources.length === 0) return { type: "fortify_pass" };
        const from = pick(sources);
        const reachable = mine.filter((t) => t !== from && view.map.adjacency[from]!.includes(t));
        if (reachable.length === 0) return { type: "fortify_pass" };
        return {
          type: "fortify",
          from,
          to: pick(reachable),
          troops: 1 + this.rng.int(view.troops[from]! - 1),
        };
      }
    }
  }
}

/** Greedily pull as many valid sets out of the hand as allowed. */
export function findSets(view: PlayerView, maxSets: number): [number, number, number][] {
  const hand = [...view.hand];
  const sets: [number, number, number][] = [];
  const symbolOf = (id: number): string => (id >= view.map.territoryCount ? "wild" : ["infantry", "cavalry", "artillery"][id % 3]!);

  while (sets.length < maxSets && hand.length >= 3) {
    const found = takeOneSet(hand, symbolOf);
    if (!found) break;
    sets.push(found);
  }
  return sets;
}

function takeOneSet(hand: number[], symbolOf: (id: number) => string): [number, number, number] | null {
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      for (let k = j + 1; k < hand.length; k++) {
        const s = [symbolOf(hand[i]!), symbolOf(hand[j]!), symbolOf(hand[k]!)];
        const wild = s.filter((x) => x === "wild").length > 0;
        const same = s[0] === s[1] && s[1] === s[2];
        const diff = s[0] !== s[1] && s[1] !== s[2] && s[0] !== s[2];
        if (wild || same || diff) {
          const set: [number, number, number] = [hand[i]!, hand[j]!, hand[k]!];
          hand.splice(k, 1);
          hand.splice(j, 1);
          hand.splice(i, 1);
          return set;
        }
      }
    }
  }
  return null;
}
