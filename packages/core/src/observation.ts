/**
 * What an agent is allowed to see.
 *
 * Board position is public; hands are not. An agent gets its own cards in full
 * and only a count for everyone else, the same censoring the SYNCS engine
 * applies. That is what forces a card-counting bot to actually track the discard
 * pile rather than read it off the state object.
 */
import type { GameMap, TerritoryId } from "./map.js";
import { conquestProbability } from "./combat.js";
import type { CardId, GameState, PlayerId } from "./types.js";
import { continentsHeld, setBonus, territoryCount, troopIncome } from "./types.js";

export interface OpponentView {
  readonly id: PlayerId;
  readonly alive: boolean;
  readonly cardCount: number;
  readonly territories: number;
  readonly troops: number;
  readonly continents: readonly number[];
  /** What they would collect if their turn started now: the standard threat proxy. */
  readonly income: number;
}

export interface PlayerView {
  readonly map: GameMap;
  readonly me: PlayerId;
  readonly turn: number;
  readonly owner: Int32Array;
  readonly troops: Int32Array;
  readonly hand: readonly CardId[];
  readonly opponents: readonly OpponentView[];
  readonly setsRedeemed: number;
  /** Troops the next redeemed set is worth. */
  readonly nextSetBonus: number;
  readonly deckSize: number;
}

export function observe(state: GameState, me: PlayerId): PlayerView {
  const opponents: OpponentView[] = [];
  for (const p of state.players) {
    if (p.id === me) continue;
    let troops = 0;
    for (let t = 0; t < state.owner.length; t++) if (state.owner[t] === p.id) troops += state.troops[t]!;
    opponents.push({
      id: p.id,
      alive: p.alive,
      cardCount: p.cards.length,
      territories: territoryCount(state, p.id),
      troops,
      continents: continentsHeld(state, p.id),
      income: p.alive ? troopIncome(state, p.id) : 0,
    });
  }

  return {
    map: state.map,
    me,
    turn: state.turn,
    owner: state.owner,
    troops: state.troops,
    hand: [...state.players[me]!.cards],
    opponents,
    setsRedeemed: state.setsRedeemed,
    nextSetBonus: setBonus(state.setsRedeemed),
    deckSize: state.deck.length,
  };
}

// --- Helpers every agent paradigm needs -------------------------------------

export function myTerritories(v: PlayerView): TerritoryId[] {
  const out: TerritoryId[] = [];
  for (let t = 0; t < v.owner.length; t++) if (v.owner[t] === v.me) out.push(t);
  return out;
}

/** My territories that border at least one enemy: the only ones that matter. */
export function borderTerritories(v: PlayerView): TerritoryId[] {
  return myTerritories(v).filter((t) => v.map.adjacency[t]!.some((n) => v.owner[n] !== v.me));
}

export interface AttackOption {
  readonly from: TerritoryId;
  readonly to: TerritoryId;
  readonly attacking: number;
  readonly defending: number;
  /** Exact probability of clearing the target if pressed to the end. */
  readonly winProb: number;
}

export function attackOptions(v: PlayerView, minTroops = 2): AttackOption[] {
  const out: AttackOption[] = [];
  for (let from = 0; from < v.owner.length; from++) {
    if (v.owner[from] !== v.me) continue;
    const garrison = v.troops[from]!;
    if (garrison < minTroops) continue;
    for (const to of v.map.adjacency[from]!) {
      if (v.owner[to] === v.me) continue;
      const attacking = garrison - 1;
      const defending = v.troops[to]!;
      out.push({ from, to, attacking, defending, winProb: conquestProbability(attacking, defending) });
    }
  }
  return out;
}

/**
 * Fixed-length encoding, for gradient-free and gradient-based learners alike.
 *
 * Per territory: is-mine, is-enemy, is-neutral, troops/20, borderness. Then per
 * continent: fraction I hold, bonus/10, held-outright-by-one-enemy. Then a short
 * global tail. Holding this shape stable means a genome evolved on Earth can be
 * transplanted to another map of the same size, and it is the natural input to
 * the graph-convolution evaluator from arXiv:2009.06355, whose adjacency matrix
 * is exactly `v.map.adjacency`.
 */
export const FEATURES_PER_TERRITORY = 5;
export const FEATURES_PER_CONTINENT = 3;
export const GLOBAL_FEATURES = 5;

export function observationSize(map: GameMap): number {
  return (
    map.territoryCount * FEATURES_PER_TERRITORY +
    map.continents.length * FEATURES_PER_CONTINENT +
    GLOBAL_FEATURES
  );
}

export function encode(v: PlayerView, out?: Float32Array): Float32Array {
  const buf = out ?? new Float32Array(observationSize(v.map));
  let i = 0;

  let myTroops = 0;
  let allTroops = 0;
  for (let t = 0; t < v.map.territoryCount; t++) {
    const mine = v.owner[t] === v.me;
    const neutral = v.owner[t] === -1;
    const troops = v.troops[t]!;
    allTroops += troops;
    if (mine) myTroops += troops;

    let hostileNeighbours = 0;
    for (const n of v.map.adjacency[t]!) if (v.owner[n] !== v.owner[t]) hostileNeighbours++;

    buf[i++] = mine ? 1 : 0;
    buf[i++] = !mine && !neutral ? 1 : 0;
    buf[i++] = neutral ? 1 : 0;
    buf[i++] = Math.min(troops / 20, 1);
    buf[i++] = hostileNeighbours / v.map.adjacency[t]!.length;
  }

  for (const c of v.map.continents) {
    let mineCount = 0;
    const owners = new Set<number>();
    for (const t of c.territories) {
      if (v.owner[t] === v.me) mineCount++;
      owners.add(v.owner[t]!);
    }
    buf[i++] = mineCount / c.territories.length;
    buf[i++] = c.bonus / 10;
    buf[i++] = owners.size === 1 && !owners.has(v.me) ? 1 : 0;
  }

  const alive = v.opponents.filter((o) => o.alive).length + 1;
  buf[i++] = allTroops > 0 ? myTroops / allTroops : 0;
  buf[i++] = Math.min(v.hand.length / 5, 1);
  buf[i++] = Math.min(v.nextSetBonus / 30, 1);
  buf[i++] = alive / 6;
  buf[i++] = Math.min(v.turn / 100, 1);

  return buf;
}
