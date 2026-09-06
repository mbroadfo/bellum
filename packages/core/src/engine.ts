/**
 * The referee.
 *
 * `playGame` is a generator: it yields a Query and is resumed with a Move. That
 * one choice is what buys the two clocks. A batch runner drives it in a tight
 * synchronous loop with no allocation beyond the moves themselves; a live match
 * server awaits an LLM or a human between `next()` calls. Same rules, same
 * validation, same replay log, no second implementation to keep in sync.
 *
 * Every illegal move throws. The arena decides whether that means forfeit, ban,
 * or a substituted default: the engine never silently repairs a bad move,
 * because a bot that quietly gets away with an illegal attack is a bot whose
 * ladder rating is a lie.
 */
import { rollBattle } from "./combat.js";
import { EARTH, type GameMap, type TerritoryId } from "./map.js";
import type {
  Move,
  MoveAttack,
  MoveAttackPass,
  MoveClaimTerritory,
  MoveDistributeTroops,
  MoveDefend,
  MoveFortify,
  MoveFortifyPass,
  MovePlaceInitialTroop,
  MoveRedeemCards,
  MoveTroopsAfterAttack,
  Query,
  Record_,
} from "./protocol.js";
import { Rng } from "./rng.js";
import type { Card, CardId, GameState, PlayerId, PlayerState } from "./types.js";
import { buildDeck, isValidSet, setBonus, startingTroops, territoryCount, troopIncome } from "./types.js";

export class IllegalMoveError extends Error {
  constructor(
    readonly player: PlayerId,
    readonly query: Query,
    readonly move: Move | undefined,
    reason: string,
  ) {
    super(`player ${player} answered ${query.type} illegally: ${reason}`);
    this.name = "IllegalMoveError";
  }
}

export interface GameOptions {
  readonly playerCount: number;
  readonly seed: number;
  readonly map?: GameMap;
  /**
   * Games between weak bots can stalemate forever. The cap keeps a batch of a
   * million evaluations bounded; a run that hits it is scored on territory.
   */
  readonly maxTurns?: number;
  /** Called for every record, in order. Omit it and no log is built. */
  readonly onRecord?: (r: Record_) => void;
  /**
   * Filled in with the live state before the first query is yielded, so a driver
   * can build each agent's censored view without the engine paying for an
   * observation on every query. Never hand this to an agent.
   */
  readonly stateRef?: { current: GameState | null };
}

export interface GameResult {
  readonly winner: PlayerId | null;
  /** Best first. A conquest winner leads; the rest are reverse elimination order. */
  readonly ranking: readonly PlayerId[];
  readonly turns: number;
  readonly reason: "conquest" | "turn_limit";
  readonly finalState: GameState;
}

function newState(map: GameMap, playerCount: number, rng: Rng): GameState {
  const cards = buildDeck(map);
  const players: PlayerState[] = [];
  for (let i = 0; i < playerCount; i++) {
    players.push({ id: i, alive: true, cards: [], troopsToPlace: startingTroops(playerCount), conqueredThisTurn: false });
  }
  return {
    map,
    cards,
    players,
    owner: new Int32Array(map.territoryCount).fill(-1),
    troops: new Int32Array(map.territoryCount),
    deck: rng.shuffle(cards.map((c) => c.id)),
    discard: [],
    setsRedeemed: 0,
    turn: 0,
    currentPlayer: 0,
    eliminationOrder: [],
  };
}

/** Can `to` be reached from `from` through territories the player owns? */
function connected(state: GameState, p: PlayerId, from: TerritoryId, to: TerritoryId): boolean {
  if (from === to) return false;
  const seen = new Uint8Array(state.map.territoryCount);
  const stack: TerritoryId[] = [from];
  seen[from] = 1;
  while (stack.length) {
    const t = stack.pop()!;
    for (const n of state.map.adjacency[t]!) {
      if (seen[n] || state.owner[n] !== p) continue;
      if (n === to) return true;
      seen[n] = 1;
      stack.push(n);
    }
  }
  return false;
}

export function* playGame(opts: GameOptions): Generator<Query, GameResult, Move> {
  const map = opts.map ?? EARTH;
  const maxTurns = opts.maxTurns ?? 500;
  const rng = new Rng(opts.seed);
  const state = newState(map, opts.playerCount, rng);
  if (opts.stateRef) opts.stateRef.current = state;
  const emit = opts.onRecord ?? (() => {});
  const cardById = (id: CardId): Card => state.cards[id]!;

  emit({ type: "game_start", players: state.players.map((p) => p.id), seed: opts.seed, map: map.name });

  const expect = <T extends Move>(q: Query, move: Move, ...types: T["type"][]): T => {
    if (!types.includes(move?.type as T["type"])) {
      throw new IllegalMoveError(q.player, q, move, `expected one of ${types.join("|")}, got ${move?.type}`);
    }
    return move as T;
  };

  const drawCard = (p: PlayerState): void => {
    if (state.deck.length === 0) {
      if (state.discard.length === 0) return;
      state.deck = rng.shuffle(state.discard);
      state.discard = [];
      emit({ type: "deck_shuffled" });
    }
    const card = state.deck.pop()!;
    p.cards.push(card);
    emit({ type: "card_drawn", player: p.id, card });
  };

  // --- Setup: claim, then reinforce -----------------------------------------

  let seat = 0;
  const nextSeat = (): PlayerId => {
    do {
      seat = (seat + 1) % state.players.length;
    } while (!state.players[seat]!.alive);
    return seat;
  };

  let unclaimed = map.territoryCount;
  while (unclaimed > 0) {
    const p = state.players[seat]!;
    const free: TerritoryId[] = [];
    for (let t = 0; t < map.territoryCount; t++) if (state.owner[t] === -1) free.push(t);

    const q: Query = { type: "claim_territory", player: p.id, unclaimed: free };
    const m = expect<MoveClaimTerritory>(q, yield q, "claim_territory");
    if (state.owner[m.territory] !== -1) {
      throw new IllegalMoveError(p.id, q, m, `territory ${m.territory} is already claimed`);
    }
    state.owner[m.territory] = p.id;
    state.troops[m.territory] = 1;
    p.troopsToPlace--;
    unclaimed--;
    emit({ type: "territory_claimed", player: p.id, territory: m.territory });
    nextSeat();
  }

  while (state.players.some((p) => p.troopsToPlace > 0)) {
    const p = state.players[seat]!;
    if (p.troopsToPlace > 0) {
      const q: Query = { type: "place_initial_troop", player: p.id, troopsRemaining: p.troopsToPlace };
      const m = expect<MovePlaceInitialTroop>(q, yield q, "place_initial_troop");
      if (state.owner[m.territory] !== p.id) {
        throw new IllegalMoveError(p.id, q, m, `territory ${m.territory} is not yours`);
      }
      state.troops[m.territory] = state.troops[m.territory]! + 1;
      p.troopsToPlace--;
      emit({ type: "initial_troop_placed", player: p.id, territory: m.territory });
    }
    nextSeat();
  }

  // --- Shared sub-routines used both at turn start and after an elimination ---

  /** Yields a redeem query, validates, returns the troops earned. */
  function* doRedeem(p: PlayerState, cause: "turn_started" | "forced"): Generator<Query, number, Move> {
    const q: Query = { type: "redeem_cards", player: p.id, cause, hand: [...p.cards] };
    const m = expect<MoveRedeemCards>(q, yield q, "redeem_cards");

    const used = new Set<CardId>();
    let troops = 0;
    for (const set of m.sets) {
      if (set.length !== 3) throw new IllegalMoveError(p.id, q, m, "a set must be exactly three cards");
      for (const id of set) {
        if (!p.cards.includes(id)) throw new IllegalMoveError(p.id, q, m, `card ${id} is not in hand`);
        if (used.has(id)) throw new IllegalMoveError(p.id, q, m, `card ${id} used in two sets`);
        used.add(id);
      }
      if (!isValidSet(set.map(cardById))) throw new IllegalMoveError(p.id, q, m, `cards ${set.join(",")} are not a set`);
      troops += setBonus(state.setsRedeemed);
      state.setsRedeemed++;
    }

    const remaining = p.cards.length - used.size;
    if (remaining >= 5) {
      throw new IllegalMoveError(p.id, q, m, `must redeem down below five cards, ${remaining} left`);
    }

    if (used.size > 0) {
      p.cards = p.cards.filter((id) => !used.has(id));
      state.discard.push(...used);
      emit({ type: "cards_redeemed", player: p.id, sets: m.sets.length, troops });
    }
    return troops;
  }

  /** Yields a distribute query and validates the placement. */
  function* doDistribute(p: PlayerState, total: number, cause: "turn_started" | "forced"): Generator<Query, void, Move> {
    if (total <= 0) return;
    const q: Query = { type: "distribute_troops", player: p.id, cause, total };
    const m = expect<MoveDistributeTroops>(q, yield q, "distribute_troops");

    let sum = 0;
    for (const [key, count] of Object.entries(m.distribution)) {
      const t = Number(key);
      if (!Number.isInteger(count) || count < 0) throw new IllegalMoveError(p.id, q, m, `bad count ${count} on ${t}`);
      if (count === 0) continue;
      if (state.owner[t] !== p.id) throw new IllegalMoveError(p.id, q, m, `territory ${t} is not yours`);
      sum += count;
    }
    if (sum !== total) throw new IllegalMoveError(p.id, q, m, `distributed ${sum} of ${total} troops`);

    for (const [key, count] of Object.entries(m.distribution)) {
      state.troops[Number(key)] = state.troops[Number(key)]! + count;
    }
    emit({ type: "troops_distributed", player: p.id, distribution: m.distribution });
  }

  // --- Main loop -------------------------------------------------------------

  seat = 0;
  let winner: PlayerId | null = null;
  let reason: "conquest" | "turn_limit" = "turn_limit";

  outer: while (state.turn < maxTurns) {
    const p = state.players[seat]!;
    if (!p.alive) {
      nextSeat();
      continue;
    }

    state.turn++;
    state.currentPlayer = p.id;
    p.conqueredThisTurn = false;

    const income = troopIncome(state, p.id);
    emit({ type: "turn_start", turn: state.turn, player: p.id, income });

    const bonus = yield* doRedeem(p, "turn_started");
    yield* doDistribute(p, income + bonus, "turn_started");

    // Attack phase.
    for (;;) {
      const qa: Query = { type: "attack", player: p.id };
      const ma = expect<MoveAttack | MoveAttackPass>(qa, yield qa, "attack", "attack_pass");
      if (ma.type === "attack_pass") {
        emit({ type: "attack_pass", player: p.id });
        break;
      }

      const { from, to, attackingTroops } = ma;
      if (state.owner[from] !== p.id) throw new IllegalMoveError(p.id, qa, ma, `${from} is not yours`);
      if (state.owner[to] === p.id) throw new IllegalMoveError(p.id, qa, ma, `${to} is already yours`);
      if (!map.adjacency[from]!.includes(to)) throw new IllegalMoveError(p.id, qa, ma, `${from} does not border ${to}`);
      const maxDice = Math.min(3, state.troops[from]! - 1);
      if (attackingTroops < 1 || attackingTroops > maxDice) {
        throw new IllegalMoveError(p.id, qa, ma, `cannot attack with ${attackingTroops} from ${state.troops[from]}`);
      }

      const defenderId = state.owner[to]!;
      const qd: Query = { type: "defend", player: defenderId, from, to, attackingTroops };
      const md = expect<MoveDefend>(qd, yield qd, "defend");
      const maxDefence = Math.min(2, state.troops[to]!);
      if (md.defendingTroops < 1 || md.defendingTroops > maxDefence) {
        throw new IllegalMoveError(defenderId, qd, md, `cannot defend with ${md.defendingTroops} from ${state.troops[to]}`);
      }

      const outcome = rollBattle(rng, attackingTroops, md.defendingTroops);
      state.troops[from] = state.troops[from]! - outcome.attackerLosses;
      state.troops[to] = state.troops[to]! - outcome.defenderLosses;
      const conquered = state.troops[to] === 0;
      emit({
        type: "attack",
        player: p.id,
        from,
        to,
        attackerDice: outcome.attackerDice,
        defenderDice: outcome.defenderDice,
        attackerLosses: outcome.attackerLosses,
        defenderLosses: outcome.defenderLosses,
        conquered,
      });

      if (!conquered) continue;

      state.owner[to] = p.id;
      p.conqueredThisTurn = true;

      const qm: Query = {
        type: "troops_after_attack",
        player: p.id,
        from,
        to,
        min: attackingTroops,
        max: state.troops[from]! - 1,
      };
      const mm = expect<MoveTroopsAfterAttack>(qm, yield qm, "troops_after_attack");
      if (mm.troops < qm.min || mm.troops > qm.max) {
        throw new IllegalMoveError(p.id, qm, mm, `must move ${qm.min}..${qm.max}, got ${mm.troops}`);
      }
      state.troops[from] = state.troops[from]! - mm.troops;
      state.troops[to] = mm.troops;
      emit({ type: "troops_moved_after_attack", player: p.id, from, to, troops: mm.troops });

      // Did that finish somebody off?
      const defender = state.players[defenderId]!;
      if (defender.alive && territoryCount(state, defenderId) === 0) {
        defender.alive = false;
        state.eliminationOrder.push(defenderId);
        const taken = defender.cards.length;
        p.cards.push(...defender.cards);
        defender.cards = [];
        emit({ type: "player_eliminated", player: defenderId, by: p.id, cardsTransferred: taken });

        // Inheriting a hand can push you over the ceiling; cash out on the spot.
        while (p.cards.length >= 6) {
          const forced = yield* doRedeem(p, "forced");
          yield* doDistribute(p, forced, "forced");
        }
      }

      if (territoryCount(state, p.id) === map.territoryCount) {
        winner = p.id;
        reason = "conquest";
        break outer;
      }
    }

    // Fortify phase.
    const qf: Query = { type: "fortify", player: p.id };
    const mf = expect<MoveFortify | MoveFortifyPass>(qf, yield qf, "fortify", "fortify_pass");
    if (mf.type === "fortify_pass") {
      emit({ type: "fortify_pass", player: p.id });
    } else {
      if (state.owner[mf.from] !== p.id || state.owner[mf.to] !== p.id) {
        throw new IllegalMoveError(p.id, qf, mf, "both territories must be yours");
      }
      if (mf.troops < 1 || mf.troops > state.troops[mf.from]! - 1) {
        throw new IllegalMoveError(p.id, qf, mf, `cannot move ${mf.troops} from ${state.troops[mf.from]}`);
      }
      if (!connected(state, p.id, mf.from, mf.to)) {
        throw new IllegalMoveError(p.id, qf, mf, `${mf.from} and ${mf.to} are not connected through your territory`);
      }
      state.troops[mf.from] = state.troops[mf.from]! - mf.troops;
      state.troops[mf.to] = state.troops[mf.to]! + mf.troops;
      emit({ type: "fortified", player: p.id, from: mf.from, to: mf.to, troops: mf.troops });
    }

    if (p.conqueredThisTurn) drawCard(p);

    if (state.players.filter((x) => x.alive).length === 1) {
      winner = state.players.find((x) => x.alive)!.id;
      reason = "conquest";
      break;
    }

    nextSeat();
  }

  // Survivors outrank the fallen; among survivors, territory decides.
  const survivors = state.players
    .filter((p) => p.alive && p.id !== winner)
    .sort((a, b) => territoryCount(state, b.id) - territoryCount(state, a.id))
    .map((p) => p.id);
  const ranking = [
    ...(winner !== null ? [winner] : []),
    ...survivors,
    ...[...state.eliminationOrder].reverse(),
  ];

  emit({ type: "game_end", winner, reason, turns: state.turn });
  return { winner, ranking, turns: state.turn, reason, finalState: state };
}
