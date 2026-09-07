/**
 * Browser bundle: the real engine, not a recording.
 *
 * The page runs actual matches by pumping the same generator the batch runner
 * pumps. Nothing here is a viewer-side reimplementation of the rules, and no
 * replay file is involved - which is why "turbo" can be honest about speed
 * rather than being a fast playback of something precomputed.
 */
export { EARTH, playGame, observe, territoryCount, Rng, observationSize } from "@bellum/core";
export type { GameState, Move, Query, Record_ } from "@bellum/core";
export {
  DEFAULT_WEIGHTS,
  HeuristicAgent,
  NeatAgent,
  RandomAgent,
  policyOutputSize,
  type Policy,
} from "@bellum/agents";
export { conservative, newRating, updateRatings } from "@bellum/arena";
