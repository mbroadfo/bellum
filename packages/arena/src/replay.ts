/**
 * Turns a match into something watchable.
 *
 * The record stream alone is not enough for a viewer: reconstructing the board
 * from it would mean a second implementation of the rules living in the client,
 * which is the exact duplication this project is built to avoid. So the exporter
 * snapshots the real board next to each interesting record and ships frames. The
 * client stays a renderer that knows no rules at all.
 *
 * Frames are keyed short and coordinates are dropped to integers because a long
 * game runs to thousands of frames and this has to load on a phone.
 */
import { type Agent, type GameState, type Record_, runMatch, runMatchSync } from "@bellum/core";
import { EARTH, type GameMap } from "@bellum/core";

export interface ReplayFrame {
  /** Turn number. */
  t: number;
  /** The player who acted. */
  p: number;
  /** Owner per territory. */
  o: number[];
  /** Troops per territory. */
  u: number[];
  /** Short caption for the event that produced this frame. */
  e: string;
  /** Event kind, for styling: turn, deploy, attack, conquer, eliminate, end. */
  k: string;
  /** Territories to highlight, usually [from, to]. */
  h?: number[];
}

export interface Replay {
  map: {
    name: string;
    names: readonly string[];
    adjacency: readonly (readonly number[])[];
    layout: readonly (readonly number[])[];
    continents: { name: string; bonus: number; territories: readonly number[] }[];
    continentOf: readonly number[];
  };
  agents: string[];
  seed: number;
  frames: ReplayFrame[];
  result: { winner: number | null; ranking: readonly number[]; turns: number; reason: string };
}

function serializeMap(map: GameMap): Replay["map"] {
  return {
    name: map.name,
    names: map.territoryNames,
    adjacency: map.adjacency,
    layout: map.layout.map(([x, y]) => [Math.round(x!), Math.round(y!)]),
    continents: map.continents.map((c) => ({ name: c.name, bonus: c.bonus, territories: c.territories })),
    continentOf: map.continentOf,
  };
}

interface Capture {
  frames: ReplayFrame[];
  stateRef: { current: GameState | null };
  onRecord: (r: Record_) => void;
}

/**
 * Not every record earns a frame. Individual dice rolls in a long grind are
 * noise; what a viewer wants is the shape of the game, so only records that move
 * a border or start a turn are captured.
 */
function makeCapture(map: GameMap): Capture {
  const frames: ReplayFrame[] = [];
  const stateRef: { current: GameState | null } = { current: null };
  const name = (t: number): string => map.territoryNames[t]!;

  const snap = (turn: number, player: number, kind: string, caption: string, highlight?: number[]): void => {
    const s = stateRef.current;
    if (!s) return;
    const frame: ReplayFrame = {
      t: turn,
      p: player,
      o: Array.from(s.owner),
      u: Array.from(s.troops),
      e: caption,
      k: kind,
    };
    if (highlight) frame.h = highlight;
    frames.push(frame);
  };

  let turn = 0;
  let current = 0;

  const onRecord = (r: Record_): void => {
    switch (r.type) {
      case "turn_start":
        turn = r.turn;
        current = r.player;
        snap(turn, r.player, "turn", `P${r.player} collects ${r.income}`);
        break;

      case "troops_distributed": {
        const total = Object.values(r.distribution).reduce((a, b) => a + b, 0);
        const where = Object.keys(r.distribution).map(Number);
        snap(turn, r.player, "deploy", `P${r.player} deploys ${total}`, where.slice(0, 4));
        break;
      }

      case "cards_redeemed":
        snap(turn, r.player, "deploy", `P${r.player} trades ${r.sets} set(s) for ${r.troops}`);
        break;

      case "troops_moved_after_attack":
        snap(turn, r.player, "conquer", `P${r.player} takes ${name(r.to)}`, [r.from, r.to]);
        break;

      case "attack":
        // Only failed assaults get their own frame; successful ones are covered
        // by the conquest frame that immediately follows.
        if (!r.conquered) {
          snap(
            turn,
            r.player,
            "attack",
            `P${r.player}: ${name(r.from)} to ${name(r.to)}, -${r.attackerLosses}/-${r.defenderLosses}`,
            [r.from, r.to],
          );
        }
        break;

      case "player_eliminated":
        snap(turn, r.by, "eliminate", `P${r.by} eliminates P${r.player}`);
        break;

      case "game_end":
        snap(turn, r.winner ?? current, "end", r.winner !== null ? `P${r.winner} wins` : "Turn limit");
        break;

      default:
        break;
    }
  };

  return { frames, stateRef, onRecord };
}

export interface RecordOptions {
  readonly seed: number;
  readonly maxTurns?: number;
  readonly map?: GameMap;
}

export function recordMatchSync(agents: readonly Agent[], opts: RecordOptions): Replay {
  const map = opts.map ?? EARTH;
  const cap = makeCapture(map);
  const result = runMatchSync(agents, { ...opts, map, stateRef: cap.stateRef, onRecord: cap.onRecord });
  return finish(map, agents, opts.seed, cap, result);
}

export async function recordMatch(agents: readonly Agent[], opts: RecordOptions): Promise<Replay> {
  const map = opts.map ?? EARTH;
  const cap = makeCapture(map);
  const result = await runMatch(agents, { ...opts, map, stateRef: cap.stateRef, onRecord: cap.onRecord });
  return finish(map, agents, opts.seed, cap, result);
}

/**
 * Delta-encoded replay: every frame after the first carries only the territories
 * that changed, as a flat [index, owner, troops, ...] run. A typical frame moves
 * one or two territories, so this is roughly a twentieth of the full form, which
 * is the difference between a viewer that opens instantly on a phone and one
 * that does not.
 */
export interface CompactReplay extends Omit<Replay, "frames"> {
  format: "delta-1";
  base: { o: number[]; u: number[] };
  frames: { t: number; p: number; e: string; k: string; h?: number[]; d: number[] }[];
}

export function compressReplay(replay: Replay): CompactReplay {
  const first = replay.frames[0];
  const size = replay.map.names.length;
  const prevO = first ? [...first.o] : new Array<number>(size).fill(-1);
  const prevU = first ? [...first.u] : new Array<number>(size).fill(0);

  const frames = replay.frames.map((f, i) => {
    const d: number[] = [];
    if (i > 0) {
      for (let t = 0; t < size; t++) {
        if (f.o[t] !== prevO[t] || f.u[t] !== prevU[t]) {
          d.push(t, f.o[t]!, f.u[t]!);
          prevO[t] = f.o[t]!;
          prevU[t] = f.u[t]!;
        }
      }
    }
    const out: CompactReplay["frames"][number] = { t: f.t, p: f.p, e: f.e, k: f.k, d };
    if (f.h) out.h = f.h;
    return out;
  });

  return {
    format: "delta-1",
    map: replay.map,
    agents: replay.agents,
    seed: replay.seed,
    base: { o: first ? [...first.o] : prevO, u: first ? [...first.u] : prevU },
    frames,
    result: replay.result,
  };
}

function finish(
  map: GameMap,
  agents: readonly Agent[],
  seed: number,
  cap: Capture,
  result: { winner: number | null; ranking: readonly number[]; turns: number; reason: string },
): Replay {
  return {
    map: serializeMap(map),
    agents: agents.map((a) => a.name),
    seed,
    frames: cap.frames,
    result: { winner: result.winner, ranking: result.ranking, turns: result.turns, reason: result.reason },
  };
}
