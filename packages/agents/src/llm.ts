/**
 * The language-model seat.
 *
 * Provider-agnostic on purpose: hand it a `complete` function and it plays. That
 * keeps API keys, retries, and rate limits outside the arena, and makes an
 * offline replay of a recorded model transcript a drop-in `complete`.
 *
 * A model will occasionally emit something illegal. Forfeiting the whole match
 * for it would make the ladder measure JSON discipline rather than strategy, so
 * a bad answer falls back to the heuristic seat and is counted. A ladder entry
 * with a high repair rate is reporting a real weakness, visibly, rather than
 * hiding it.
 */
import type { Agent, Move, PlayerView, Query } from "@bellum/core";
import { attackOptions } from "@bellum/core";
import { HeuristicAgent } from "./heuristic.js";

export type Completion = (prompt: string, system: string) => Promise<string>;

export interface LlmAgentOptions {
  readonly name: string;
  readonly complete: Completion;
  /** Answers for it when the model returns something unusable. */
  readonly fallback?: Agent;
  /** Extra strategic instruction, appended to the system prompt. */
  readonly persona?: string;
}

const SYSTEM = `You are playing Risk. You will be given the board and one question.
Reply with a single JSON object and nothing else - no prose, no code fence.
The required shape is given with each question. Invalid JSON loses you the move.`;

export class LlmAgent implements Agent {
  readonly synchronous = false;
  private readonly fallback: Agent;
  /** How many times the model's answer had to be replaced. Report this. */
  repairs = 0;
  calls = 0;

  constructor(private readonly opts: LlmAgentOptions) {
    this.fallback = opts.fallback ?? new HeuristicAgent(`${opts.name}-fallback`);
  }

  get name(): string {
    return this.opts.name;
  }

  async act(query: Query, view: PlayerView): Promise<Move> {
    this.calls++;
    try {
      const system = this.opts.persona ? `${SYSTEM}\n\n${this.opts.persona}` : SYSTEM;
      const raw = await this.opts.complete(renderPrompt(query, view), system);
      const move = parseMove(raw, query);
      if (move) return move;
    } catch {
      // Network failure, timeout, refusal: all handled the same way.
    }
    this.repairs++;
    return this.fallback.act(query, view) as Move;
  }
}

/** Compact board rendering. Names, not ids, because models reason better on names. */
export function renderPrompt(query: Query, view: PlayerView): string {
  const n = (t: number): string => view.map.territoryNames[t]!;
  const lines: string[] = [];

  lines.push(`You are player ${view.me}. Turn ${view.turn}.`);
  lines.push("");
  lines.push("YOUR TERRITORIES (troops):");
  const mine: string[] = [];
  for (let t = 0; t < view.map.territoryCount; t++) {
    if (view.owner[t] === view.me) mine.push(`${n(t)} [${t}]:${view.troops[t]}`);
  }
  lines.push(mine.join(", ") || "(none)");

  lines.push("");
  lines.push("OPPONENTS:");
  for (const o of view.opponents) {
    if (!o.alive) continue;
    lines.push(
      `  player ${o.id}: ${o.territories} territories, ${o.troops} troops, ${o.cardCount} cards, income ${o.income}` +
        (o.continents.length ? `, holds ${o.continents.map((c) => view.map.continents[c]!.name).join("/")}` : ""),
    );
  }

  lines.push("");
  lines.push(`Your hand: ${view.hand.length} cards. Next set is worth ${view.nextSetBonus} troops.`);
  lines.push("");
  lines.push(question(query, view));
  return lines.join("\n");
}

function question(query: Query, view: PlayerView): string {
  const n = (t: number): string => view.map.territoryNames[t]!;

  switch (query.type) {
    case "claim_territory":
      return `QUESTION: claim one unclaimed territory.
Options: ${query.unclaimed.map((t) => `${n(t)} [${t}]`).join(", ")}
Reply: {"territory": <id>}`;

    case "place_initial_troop":
      return `QUESTION: place one troop on a territory you own. ${query.troopsRemaining} left to place.
Reply: {"territory": <id>}`;

    case "redeem_cards":
      return `QUESTION: redeem card sets. Your cards: [${query.hand.join(", ")}]. ${
        query.cause === "forced" ? "You MUST redeem down to fewer than 5 cards." : "Optional."
      }
Reply: {"sets": [[<id>,<id>,<id>], ...]}  (use [] to decline)`;

    case "distribute_troops":
      return `QUESTION: place exactly ${query.total} troops across territories you own.
Reply: {"distribution": {"<territoryId>": <count>, ...}}  (counts must sum to ${query.total})`;

    case "attack": {
      const opts = attackOptions(view)
        .sort((a, b) => b.winProb - a.winProb)
        .slice(0, 12)
        .map(
          (o) =>
            `${n(o.from)}[${o.from}](${view.troops[o.from]}) -> ${n(o.to)}[${o.to}](${o.defending}), win ${(o.winProb * 100).toFixed(0)}%`,
        );
      return `QUESTION: attack, or pass to end your attack phase.
Best options: ${opts.length ? opts.join("; ") : "none"}
Reply: {"from": <id>, "to": <id>, "attackingTroops": 1|2|3}  or  {"pass": true}`;
    }

    case "defend":
      return `QUESTION: ${n(query.from)} is attacking ${n(query.to)} with ${query.attackingTroops} dice.
You have ${view.troops[query.to]} troops there.
Reply: {"defendingTroops": 1|2}`;

    case "troops_after_attack":
      return `QUESTION: you took ${n(query.to)} from ${n(query.from)}. Move between ${query.min} and ${query.max} troops in.
Reply: {"troops": <count>}`;

    case "fortify":
      return `QUESTION: optionally move troops between two connected territories you own.
Reply: {"from": <id>, "to": <id>, "troops": <count>}  or  {"pass": true}`;
  }
}

/** Tolerant parse: models like to wrap JSON in prose or a fence. */
export function parseMove(raw: string, query: Query): Move | null {
  const json = extractJson(raw);
  if (!json) return null;

  let o: Record<string, unknown>;
  try {
    o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }

  const num = (k: string): number | null => (typeof o[k] === "number" ? (o[k] as number) : null);

  switch (query.type) {
    case "claim_territory": {
      const t = num("territory");
      return t !== null ? { type: "claim_territory", territory: t } : null;
    }
    case "place_initial_troop": {
      const t = num("territory");
      return t !== null ? { type: "place_initial_troop", territory: t } : null;
    }
    case "redeem_cards": {
      const sets = o["sets"];
      if (!Array.isArray(sets)) return null;
      const parsed = sets.filter((s): s is [number, number, number] => Array.isArray(s) && s.length === 3);
      return { type: "redeem_cards", sets: parsed };
    }
    case "distribute_troops": {
      const d = o["distribution"];
      if (typeof d !== "object" || d === null) return null;
      const distribution: Record<number, number> = {};
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
        if (typeof v !== "number") return null;
        distribution[Number(k)] = Math.round(v);
      }
      return { type: "distribute_troops", distribution };
    }
    case "attack": {
      if (o["pass"] === true) return { type: "attack_pass" };
      const from = num("from");
      const to = num("to");
      const a = num("attackingTroops");
      return from !== null && to !== null && a !== null
        ? { type: "attack", from, to, attackingTroops: a }
        : null;
    }
    case "defend": {
      const d = num("defendingTroops");
      return d !== null ? { type: "defend", defendingTroops: d } : null;
    }
    case "troops_after_attack": {
      const t = num("troops");
      return t !== null ? { type: "troops_after_attack", troops: t } : null;
    }
    case "fortify": {
      if (o["pass"] === true) return { type: "fortify_pass" };
      const from = num("from");
      const to = num("to");
      const t = num("troops");
      return from !== null && to !== null && t !== null ? { type: "fortify", from, to, troops: t } : null;
    }
  }
}

function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  return start >= 0 && end > start ? raw.slice(start, end + 1) : null;
}
