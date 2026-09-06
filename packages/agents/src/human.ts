/**
 * The human seat.
 *
 * A person is just another agent whose policy happens to be a UI. Everything a
 * touch interface needs to render a turn is enumerated by `affordances` below,
 * so the mobile client never has to know a single rule: it draws what it is
 * given, the player taps, and the engine validates. That is what keeps a single
 * interactive session cheap to onboard - no account, no lobby, no second rules
 * implementation on the client.
 *
 * `timeoutMs` exists because a live match with bots in it cannot wait forever
 * for someone who closed the tab. On timeout the fallback agent plays the turn.
 */
import type { Agent, Move, PlayerView, Query, TerritoryId } from "@bellum/core";
import { attackOptions, borderTerritories, myTerritories } from "@bellum/core";
import { HeuristicAgent } from "./heuristic.js";

/** Everything the UI may offer for the current question. */
export type Affordances =
  | { kind: "pick_territory"; prompt: string; choices: TerritoryId[] }
  | { kind: "distribute"; prompt: string; total: number; choices: TerritoryId[] }
  | { kind: "redeem"; prompt: string; hand: readonly number[]; mandatory: boolean }
  | {
      kind: "attack";
      prompt: string;
      options: { from: TerritoryId; to: TerritoryId; maxDice: number; winProb: number }[];
      canPass: boolean;
    }
  | { kind: "defend"; prompt: string; from: TerritoryId; to: TerritoryId; maxDice: number }
  | { kind: "slider"; prompt: string; min: number; max: number }
  | {
      kind: "fortify";
      prompt: string;
      options: { from: TerritoryId; to: TerritoryId; max: number }[];
      canPass: boolean;
    };

export function affordances(query: Query, view: PlayerView): Affordances {
  const name = (t: number): string => view.map.territoryNames[t]!;

  switch (query.type) {
    case "claim_territory":
      return { kind: "pick_territory", prompt: "Claim a territory", choices: [...query.unclaimed] };

    case "place_initial_troop":
      return {
        kind: "pick_territory",
        prompt: `Place a troop (${query.troopsRemaining} left)`,
        choices: myTerritories(view),
      };

    case "redeem_cards":
      return {
        kind: "redeem",
        prompt: query.cause === "forced" ? "You must trade down to 4 cards" : "Trade in cards?",
        hand: query.hand,
        mandatory: query.cause === "forced",
      };

    case "distribute_troops":
      return {
        kind: "distribute",
        prompt: `Deploy ${query.total} troops`,
        total: query.total,
        choices: borderTerritories(view).length ? borderTerritories(view) : myTerritories(view),
      };

    case "attack":
      return {
        kind: "attack",
        prompt: "Attack, or end your attack phase",
        options: attackOptions(view).map((o) => ({
          from: o.from,
          to: o.to,
          maxDice: Math.min(3, o.attacking),
          winProb: o.winProb,
        })),
        canPass: true,
      };

    case "defend":
      return {
        kind: "defend",
        prompt: `${name(query.from)} attacks ${name(query.to)} with ${query.attackingTroops}`,
        from: query.from,
        to: query.to,
        maxDice: Math.min(2, view.troops[query.to]!),
      };

    case "troops_after_attack":
      return {
        kind: "slider",
        prompt: `Move troops into ${name(query.to)}`,
        min: query.min,
        max: query.max,
      };

    case "fortify": {
      const options: { from: TerritoryId; to: TerritoryId; max: number }[] = [];
      for (const from of myTerritories(view)) {
        if (view.troops[from]! < 2) continue;
        for (const to of view.map.adjacency[from]!) {
          if (view.owner[to] === view.me) options.push({ from, to, max: view.troops[from]! - 1 });
        }
      }
      return { kind: "fortify", prompt: "Move troops, or skip", options, canPass: true };
    }
  }
}

export type UiPrompt = (query: Query, view: PlayerView, ui: Affordances) => Promise<Move>;

export class HumanAgent implements Agent {
  readonly synchronous = false;
  private readonly fallback: Agent;

  constructor(
    readonly name: string,
    private readonly prompt: UiPrompt,
    private readonly timeoutMs = 0,
  ) {
    this.fallback = new HeuristicAgent(`${name}-autopilot`);
  }

  async act(query: Query, view: PlayerView): Promise<Move> {
    const ui = affordances(query, view);
    const answer = this.prompt(query, view, ui);
    if (this.timeoutMs <= 0) return answer;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const bail = new Promise<Move>((resolve) => {
      timer = setTimeout(() => resolve(this.fallback.act(query, view) as Move), this.timeoutMs);
    });
    try {
      return await Promise.race([answer, bail]);
    } finally {
      clearTimeout(timer);
    }
  }
}
