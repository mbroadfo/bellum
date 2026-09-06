/**
 * The one interface every paradigm implements.
 *
 * `act` may return a Move or a Promise of one. That single union is the whole
 * trick behind the two clocks: a heuristic or a neuroevolved net answers
 * synchronously and the batch runner never touches the microtask queue, while an
 * LLM or a waiting human returns a Promise and the same runner awaits it. No
 * agent needs to know which clock it is on.
 */
import type { Move, Query, Record_ } from "./protocol.js";
import type { PlayerView } from "./observation.js";
import type { GameResult } from "./engine.js";
import type { PlayerId } from "./types.js";

export type MaybePromise<T> = T | Promise<T>;

export interface Agent {
  readonly name: string;
  /**
   * True when `act` never returns a Promise. The batch runner checks this to
   * take a fully synchronous path; getting it wrong is caught at runtime.
   */
  readonly synchronous?: boolean;

  act(query: Query, view: PlayerView): MaybePromise<Move>;

  /** Called once before the first query, for per-game scratch state. */
  onGameStart?(me: PlayerId, view: PlayerView): void;
  /**
   * Every public record, in order. This is how a bot tracks the discard pile or
   * remembers who attacked it: the engine will not hand it hidden state.
   */
  onRecord?(record: Record_): void;
  onGameEnd?(result: GameResult): void;
}

export function isPromise<T>(x: MaybePromise<T>): x is Promise<T> {
  return typeof (x as Promise<T>)?.then === "function";
}
