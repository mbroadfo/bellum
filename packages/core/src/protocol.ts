/**
 * The wire protocol between engine and agent.
 *
 * The engine is a referee that asks exactly one question at a time and accepts
 * exactly one answer. Every agent paradigm — heuristic, LLM, neuroevolved,
 * human — implements the same eight answers, which is what lets them share a
 * single ladder. The taxonomy follows the SYNCS Bot Battle engine, which is the
 * best-specified Risk action vocabulary in the open, so bots written against
 * that spec port over with little friction.
 */
import type { TerritoryId } from "./map.js";
import type { CardId, PlayerId } from "./types.js";

export type QueryType =
  | "claim_territory"
  | "place_initial_troop"
  | "redeem_cards"
  | "distribute_troops"
  | "attack"
  | "defend"
  | "troops_after_attack"
  | "fortify";

interface BaseQuery {
  readonly type: QueryType;
  readonly player: PlayerId;
}

export interface QueryClaimTerritory extends BaseQuery {
  readonly type: "claim_territory";
  readonly unclaimed: readonly TerritoryId[];
}

export interface QueryPlaceInitialTroop extends BaseQuery {
  readonly type: "place_initial_troop";
  readonly troopsRemaining: number;
}

/**
 * `cause` is "forced" when the player crossed the 5-card ceiling by eliminating
 * somebody mid-turn and must redeem down before continuing.
 */
export interface QueryRedeemCards extends BaseQuery {
  readonly type: "redeem_cards";
  readonly cause: "turn_started" | "forced";
  readonly hand: readonly CardId[];
}

export interface QueryDistributeTroops extends BaseQuery {
  readonly type: "distribute_troops";
  readonly cause: "turn_started" | "forced";
  readonly total: number;
}

export interface QueryAttack extends BaseQuery {
  readonly type: "attack";
}

export interface QueryDefend extends BaseQuery {
  readonly type: "defend";
  readonly from: TerritoryId;
  readonly to: TerritoryId;
  readonly attackingTroops: number;
}

export interface QueryTroopsAfterAttack extends BaseQuery {
  readonly type: "troops_after_attack";
  readonly from: TerritoryId;
  readonly to: TerritoryId;
  readonly min: number;
  readonly max: number;
}

export interface QueryFortify extends BaseQuery {
  readonly type: "fortify";
}

export type Query =
  | QueryClaimTerritory
  | QueryPlaceInitialTroop
  | QueryRedeemCards
  | QueryDistributeTroops
  | QueryAttack
  | QueryDefend
  | QueryTroopsAfterAttack
  | QueryFortify;

// --- Moves -----------------------------------------------------------------

export interface MoveClaimTerritory {
  readonly type: "claim_territory";
  readonly territory: TerritoryId;
}

export interface MovePlaceInitialTroop {
  readonly type: "place_initial_troop";
  readonly territory: TerritoryId;
}

/** `sets` is a list of card triples; an empty list declines (illegal when forced). */
export interface MoveRedeemCards {
  readonly type: "redeem_cards";
  readonly sets: readonly (readonly [CardId, CardId, CardId])[];
}

/** `distribution[t]` troops onto territory t; must sum to the query's total. */
export interface MoveDistributeTroops {
  readonly type: "distribute_troops";
  readonly distribution: Readonly<Record<TerritoryId, number>>;
}

export interface MoveAttack {
  readonly type: "attack";
  readonly from: TerritoryId;
  readonly to: TerritoryId;
  /** 1..3, and strictly fewer than the troops standing in `from`. */
  readonly attackingTroops: number;
}

export interface MoveAttackPass {
  readonly type: "attack_pass";
}

export interface MoveDefend {
  readonly type: "defend";
  /** 1..2, and no more than the troops standing in the defending territory. */
  readonly defendingTroops: number;
}

export interface MoveTroopsAfterAttack {
  readonly type: "troops_after_attack";
  readonly troops: number;
}

export interface MoveFortify {
  readonly type: "fortify";
  readonly from: TerritoryId;
  readonly to: TerritoryId;
  readonly troops: number;
}

export interface MoveFortifyPass {
  readonly type: "fortify_pass";
}

export type Move =
  | MoveClaimTerritory
  | MovePlaceInitialTroop
  | MoveRedeemCards
  | MoveDistributeTroops
  | MoveAttack
  | MoveAttackPass
  | MoveDefend
  | MoveTroopsAfterAttack
  | MoveFortify
  | MoveFortifyPass;

/** Maps each query to the move types that may legally answer it. */
export type MoveFor<Q extends Query> = Q extends QueryClaimTerritory
  ? MoveClaimTerritory
  : Q extends QueryPlaceInitialTroop
    ? MovePlaceInitialTroop
    : Q extends QueryRedeemCards
      ? MoveRedeemCards
      : Q extends QueryDistributeTroops
        ? MoveDistributeTroops
        : Q extends QueryAttack
          ? MoveAttack | MoveAttackPass
          : Q extends QueryDefend
            ? MoveDefend
            : Q extends QueryTroopsAfterAttack
              ? MoveTroopsAfterAttack
              : Q extends QueryFortify
                ? MoveFortify | MoveFortifyPass
                : never;

// --- Records (the replay log) ----------------------------------------------

export type Record_ =
  | { type: "game_start"; players: PlayerId[]; seed: number; map: string }
  | { type: "territory_claimed"; player: PlayerId; territory: TerritoryId }
  | { type: "initial_troop_placed"; player: PlayerId; territory: TerritoryId }
  | { type: "turn_start"; turn: number; player: PlayerId; income: number }
  | { type: "cards_redeemed"; player: PlayerId; sets: number; troops: number }
  | { type: "troops_distributed"; player: PlayerId; distribution: Record<TerritoryId, number> }
  | {
      type: "attack";
      player: PlayerId;
      from: TerritoryId;
      to: TerritoryId;
      attackerDice: number[];
      defenderDice: number[];
      attackerLosses: number;
      defenderLosses: number;
      conquered: boolean;
    }
  | { type: "troops_moved_after_attack"; player: PlayerId; from: TerritoryId; to: TerritoryId; troops: number }
  | { type: "card_drawn"; player: PlayerId; card: CardId }
  | { type: "deck_shuffled" }
  | { type: "player_eliminated"; player: PlayerId; by: PlayerId; cardsTransferred: number }
  | { type: "fortified"; player: PlayerId; from: TerritoryId; to: TerritoryId; troops: number }
  | { type: "attack_pass"; player: PlayerId }
  | { type: "fortify_pass"; player: PlayerId }
  | { type: "game_end"; winner: PlayerId | null; reason: "conquest" | "turn_limit"; turns: number };
