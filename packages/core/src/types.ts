import type { GameMap, TerritoryId } from "./map.js";

export type PlayerId = number;
export type CardId = number;

export type CardSymbol = "infantry" | "cavalry" | "artillery" | "wild";

export interface Card {
  readonly id: CardId;
  /** null for the two wildcards. */
  readonly territory: TerritoryId | null;
  readonly symbol: CardSymbol;
}

export interface PlayerState {
  readonly id: PlayerId;
  alive: boolean;
  cards: CardId[];
  /** Troops still to place during the setup phases. */
  troopsToPlace: number;
  /** Set when the player takes at least one territory this turn (earns a card). */
  conqueredThisTurn: boolean;
}

export interface GameState {
  readonly map: GameMap;
  readonly cards: readonly Card[];
  readonly players: PlayerState[];
  /** owner[t] = PlayerId, or -1 while unclaimed. */
  owner: Int32Array;
  troops: Int32Array;
  deck: CardId[];
  discard: CardId[];
  /** How many sets have been redeemed in the whole game — drives the escalating bonus. */
  setsRedeemed: number;
  turn: number;
  currentPlayer: PlayerId;
  /** Finishing order, first eliminated first; the winner is appended last. */
  eliminationOrder: PlayerId[];
}

export function territoriesOf(state: GameState, p: PlayerId): TerritoryId[] {
  const out: TerritoryId[] = [];
  for (let t = 0; t < state.owner.length; t++) if (state.owner[t] === p) out.push(t);
  return out;
}

export function territoryCount(state: GameState, p: PlayerId): number {
  let n = 0;
  for (let t = 0; t < state.owner.length; t++) if (state.owner[t] === p) n++;
  return n;
}

export function continentsHeld(state: GameState, p: PlayerId): number[] {
  const out: number[] = [];
  for (const c of state.map.continents) {
    if (c.territories.every((t) => state.owner[t] === p)) out.push(c.id);
  }
  return out;
}

/** Standard reinforcement: floor(territories / 3), minimum 3, plus continent bonuses. */
export function troopIncome(state: GameState, p: PlayerId): number {
  const base = Math.max(3, Math.floor(territoryCount(state, p) / 3));
  let bonus = 0;
  for (const c of state.map.continents) {
    if (c.territories.every((t) => state.owner[t] === p)) bonus += c.bonus;
  }
  return base + bonus;
}

/** Escalating set bonus: 4, 6, 8, 10, 12, 15, then +5 each. */
export function setBonus(setsAlreadyRedeemed: number): number {
  const n = setsAlreadyRedeemed;
  if (n < 5) return 4 + 2 * n;
  return 15 + 5 * (n - 5);
}

/** Initial troops per player, by player count. */
export function startingTroops(playerCount: number): number {
  const table: Record<number, number> = { 2: 40, 3: 35, 4: 30, 5: 25, 6: 20 };
  const n = table[playerCount];
  if (n === undefined) throw new Error(`Unsupported player count: ${playerCount}`);
  return n;
}

export function buildDeck(map: GameMap): Card[] {
  const symbols: CardSymbol[] = ["infantry", "cavalry", "artillery"];
  const cards: Card[] = [];
  for (let t = 0; t < map.territoryCount; t++) {
    cards.push({ id: t, territory: t, symbol: symbols[t % 3]! });
  }
  cards.push({ id: map.territoryCount, territory: null, symbol: "wild" });
  cards.push({ id: map.territoryCount + 1, territory: null, symbol: "wild" });
  return cards;
}

/** Three cards form a set if all symbols match, all differ, or any wild is involved. */
export function isValidSet(cards: readonly Card[]): boolean {
  if (cards.length !== 3) return false;
  const wilds = cards.filter((c) => c.symbol === "wild").length;
  if (wilds > 0) return true;
  const [a, b, c] = cards as [Card, Card, Card];
  const allSame = a.symbol === b.symbol && b.symbol === c.symbol;
  const allDiff = a.symbol !== b.symbol && b.symbol !== c.symbol && a.symbol !== c.symbol;
  return allSame || allDiff;
}
