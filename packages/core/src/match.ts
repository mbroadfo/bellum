/**
 * Drivers that pump the engine generator with agent answers.
 *
 * Two entry points, one rule set. `runMatch` awaits and is what a live match
 * server or an LLM tournament uses. `runMatchSync` refuses to await and is what
 * a neuroevolution fitness loop uses, where a single stray Promise across a
 * million games is the difference between minutes and hours.
 */
import { type Agent, isPromise } from "./agent.js";
import { type GameOptions, type GameResult, playGame } from "./engine.js";
import { observe } from "./observation.js";
import type { Move, Record_ } from "./protocol.js";
import type { GameState } from "./types.js";

export interface MatchOptions extends Omit<GameOptions, "playerCount" | "onRecord"> {
  /** Keep the full record log on the result. Off by default: batch runs do not want it. */
  readonly recordLog?: boolean;
  readonly onRecord?: (r: Record_) => void;
}

export interface MatchResult extends GameResult {
  readonly log: readonly Record_[];
  readonly agentNames: readonly string[];
}

interface Harness {
  game: Generator<import("./protocol.js").Query, GameResult, Move>;
  stateRef: { current: GameState | null };
  log: Record_[];
}

function setup(agents: readonly Agent[], opts: MatchOptions): Harness {
  const log: Record_[] = [];
  const listeners = agents.filter((a) => a.onRecord);
  // A caller may supply its own ref to watch the board evolve, as the replay
  // exporter does; otherwise the driver just needs one for observations.
  const stateRef = opts.stateRef ?? { current: null as GameState | null };

  const game = playGame({
    ...opts,
    playerCount: agents.length,
    stateRef,
    onRecord: (r) => {
      if (opts.recordLog) log.push(r);
      opts.onRecord?.(r);
      for (const a of listeners) a.onRecord!(r);
    },
  });

  return { game, stateRef, log };
}

function announceStart(agents: readonly Agent[], stateRef: { current: GameState | null }): void {
  const state = stateRef.current;
  if (!state) return;
  for (let i = 0; i < agents.length; i++) agents[i]!.onGameStart?.(i, observe(state, i));
}

export async function runMatch(agents: readonly Agent[], opts: MatchOptions): Promise<MatchResult> {
  const { game, stateRef, log } = setup(agents, opts);

  let step = game.next();
  announceStart(agents, stateRef);

  while (!step.done) {
    const query = step.value;
    const agent = agents[query.player]!;
    const answer = agent.act(query, observe(stateRef.current!, query.player));
    const move: Move = isPromise(answer) ? await answer : answer;
    step = game.next(move);
  }

  const result = step.value;
  for (const a of agents) a.onGameEnd?.(result);
  return { ...result, log, agentNames: agents.map((a) => a.name) };
}

export function runMatchSync(agents: readonly Agent[], opts: MatchOptions): MatchResult {
  const { game, stateRef, log } = setup(agents, opts);

  let step = game.next();
  announceStart(agents, stateRef);

  while (!step.done) {
    const query = step.value;
    const agent = agents[query.player]!;
    const answer = agent.act(query, observe(stateRef.current!, query.player));
    if (isPromise(answer)) {
      throw new Error(`agent "${agent.name}" returned a Promise on the synchronous path`);
    }
    step = game.next(answer);
  }

  const result = step.value;
  for (const a of agents) a.onGameEnd?.(result);
  return { ...result, log, agentNames: agents.map((a) => a.name) };
}
