/**
 * `npm run arena` - a smoke ladder across all three paradigms.
 *
 * The NEAT entrant here is a fixed random-weight network, not an evolved one. It
 * is in the table on purpose: it is the control that tells you what "learned
 * nothing" scores, so the first real evolved genome has a number to beat.
 */
import { EARTH, Rng, observationSize } from "@bellum/core";
import { DEFAULT_WEIGHTS, HeuristicAgent, NeatAgent, type Policy, RandomAgent, policyOutputSize } from "@bellum/agents";
import { type Entrant, formatStandings, runTournament } from "./tournament.js";

/** A dense single-hidden-layer net with fixed random weights. */
function randomPolicy(seed: number, inputs: number, outputs: number, hidden = 24): Policy {
  const rng = new Rng(seed);
  const gauss = (): number => {
    const u = Math.max(rng.next(), 1e-9);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng.next());
  };
  const w1 = Float32Array.from({ length: inputs * hidden }, () => gauss() * Math.sqrt(2 / inputs));
  const w2 = Float32Array.from({ length: hidden * outputs }, () => gauss() * Math.sqrt(2 / hidden));
  const h = new Float32Array(hidden);
  const out = new Float32Array(outputs);

  return (input: Float32Array): Float32Array => {
    h.fill(0);
    for (let j = 0; j < hidden; j++) {
      let sum = 0;
      for (let i = 0; i < inputs; i++) sum += input[i]! * w1[i * hidden + j]!;
      h[j] = Math.tanh(sum);
    }
    out.fill(0);
    for (let k = 0; k < outputs; k++) {
      let sum = 0;
      for (let j = 0; j < hidden; j++) sum += h[j]! * w2[j * outputs + k]!;
      out[k] = sum;
    }
    return out;
  };
}

const inputs = observationSize(EARTH);
const outputs = policyOutputSize(EARTH.territoryCount);

const entrants: Entrant[] = [
  { name: "random", paradigm: "baseline", create: (seat, seed) => new RandomAgent("random", seed + seat) },
  { name: "random-2", paradigm: "baseline", create: (seat, seed) => new RandomAgent("random-2", seed * 7 + seat) },
  { name: "heuristic", paradigm: "algorithmic", create: () => new HeuristicAgent("heuristic") },
  {
    name: "heuristic-aggro",
    paradigm: "algorithmic",
    create: () =>
      new HeuristicAgent("heuristic-aggro", {
        ...DEFAULT_WEIGHTS,
        attackThreshold: 0.42,
        cardHuntThreshold: 0.3,
        eliminationBonus: 4,
      }),
  },
  {
    name: "heuristic-turtle",
    paradigm: "algorithmic",
    create: () =>
      new HeuristicAgent("heuristic-turtle", {
        ...DEFAULT_WEIGHTS,
        attackThreshold: 0.78,
        continentValue: 2.2,
        concentration: 0.9,
      }),
  },
  {
    name: "neat-untrained",
    paradigm: "neat",
    create: () => new NeatAgent("neat-untrained", randomPolicy(42, inputs, outputs)),
  },
];

const games = Number(process.argv[2] ?? 120);
const start = Date.now();

let done = 0;
const standings = await runTournament({
  entrants,
  games,
  playersPerGame: 6,
  seed: 20260905,
  maxTurns: 400,
  onGame: () => {
    done++;
    if (done % 20 === 0) process.stderr.write(`  ${done}/${games} games\n`);
  },
});

const elapsed = (Date.now() - start) / 1000;
console.log(`\nBellum arena - ${games} games, 6 seats, ${elapsed.toFixed(1)}s (${(games / elapsed).toFixed(1)} games/s)\n`);
console.log(formatStandings(standings));
console.log(`\nAvg game length: ${(standings.reduce((a, s) => a + s.avgTurns, 0) / standings.length).toFixed(0)} turns`);
