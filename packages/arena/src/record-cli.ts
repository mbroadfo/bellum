/** `npx tsx packages/arena/src/record-cli.ts <out.json>` - capture one match to watch. */
import { writeFileSync } from "node:fs";
import { EARTH, Rng, observationSize } from "@bellum/core";
import { DEFAULT_WEIGHTS, HeuristicAgent, NeatAgent, type Policy, RandomAgent, policyOutputSize } from "@bellum/agents";
import { compressReplay, recordMatchSync } from "./replay.js";

function randomPolicy(seed: number, inputs: number, outputs: number, hidden = 24): Policy {
  const rng = new Rng(seed);
  const gauss = (): number => Math.sqrt(-2 * Math.log(Math.max(rng.next(), 1e-9))) * Math.cos(2 * Math.PI * rng.next());
  const w1 = Float32Array.from({ length: inputs * hidden }, () => gauss() * Math.sqrt(2 / inputs));
  const w2 = Float32Array.from({ length: hidden * outputs }, () => gauss() * Math.sqrt(2 / hidden));
  const h = new Float32Array(hidden);
  const out = new Float32Array(outputs);
  return (input) => {
    for (let j = 0; j < hidden; j++) {
      let s = 0;
      for (let i = 0; i < inputs; i++) s += input[i]! * w1[i * hidden + j]!;
      h[j] = Math.tanh(s);
    }
    for (let k = 0; k < outputs; k++) {
      let s = 0;
      for (let j = 0; j < hidden; j++) s += h[j]! * w2[j * outputs + k]!;
      out[k] = s;
    }
    return out;
  };
}

const agents = [
  new HeuristicAgent("Heuristic"),
  new HeuristicAgent("Aggro", { ...DEFAULT_WEIGHTS, attackThreshold: 0.42, cardHuntThreshold: 0.3, eliminationBonus: 4 }),
  new HeuristicAgent("Turtle", { ...DEFAULT_WEIGHTS, attackThreshold: 0.78, continentValue: 2.2, concentration: 0.9 }),
  new NeatAgent("NEAT-untrained", randomPolicy(42, observationSize(EARTH), policyOutputSize(EARTH.territoryCount))),
  new RandomAgent("Random", 7),
];

const seed = Number(process.argv[3] ?? 20260906);
const replay = recordMatchSync(agents, { seed, maxTurns: 400 });
const out = process.argv[2] ?? "replay.json";
const compact = compressReplay(replay);
writeFileSync(out, JSON.stringify(compact));
console.error(
  `${replay.frames.length} frames, ${replay.result.turns} turns, winner ${replay.result.winner} (${replay.agents[replay.result.winner ?? 0]}), ${(JSON.stringify(compact).length / 1024).toFixed(0)} KB compact`,
);
