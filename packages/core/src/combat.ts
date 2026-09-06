import type { Rng } from "./rng.js";

export interface BattleOutcome {
  readonly attackerDice: number[];
  readonly defenderDice: number[];
  readonly attackerLosses: number;
  readonly defenderLosses: number;
}

/** One assault round: highest-vs-highest, ties go to the defender. */
export function rollBattle(rng: Rng, attackDice: number, defendDice: number): BattleOutcome {
  const a: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < attackDice; i++) a.push(rng.d6());
  for (let i = 0; i < defendDice; i++) d.push(rng.d6());

  const as = [...a].sort((x, y) => y - x);
  const ds = [...d].sort((x, y) => y - x);

  let attackerLosses = 0;
  let defenderLosses = 0;
  const pairs = Math.min(as.length, ds.length);
  for (let i = 0; i < pairs; i++) {
    if (as[i]! > ds[i]!) defenderLosses++;
    else attackerLosses++;
  }
  return { attackerDice: a, defenderDice: d, attackerLosses, defenderLosses };
}

/**
 * Exact per-round loss distribution, enumerated over every dice outcome (7776 at
 * most) and cached. RiskArena ships these as static data files; deriving them
 * keeps the numbers honest if the combat rule is ever varied.
 *
 * Returns p[k], the probability the attacker loses exactly k this round.
 */
const roundCache = new Map<string, number[]>();

export function roundLossDistribution(attackDice: number, defendDice: number): number[] {
  const key = attackDice + ":" + defendDice;
  const hit = roundCache.get(key);
  if (hit) return hit;

  const pairs = Math.min(attackDice, defendDice);
  const counts = new Array<number>(pairs + 1).fill(0);
  const total = Math.pow(6, attackDice + defendDice);

  const a = new Array<number>(attackDice).fill(0);
  const d = new Array<number>(defendDice).fill(0);

  const walk = (i: number): void => {
    if (i < attackDice) {
      for (let v = 1; v <= 6; v++) {
        a[i] = v;
        walk(i + 1);
      }
      return;
    }
    const j = i - attackDice;
    if (j < defendDice) {
      for (let v = 1; v <= 6; v++) {
        d[j] = v;
        walk(i + 1);
      }
      return;
    }
    const as = [...a].sort((x, y) => y - x);
    const ds = [...d].sort((x, y) => y - x);
    let losses = 0;
    for (let k = 0; k < pairs; k++) if (as[k]! <= ds[k]!) losses++;
    counts[losses]!++;
  };
  walk(0);

  const p = counts.map((c) => c / total);
  roundCache.set(key, p);
  return p;
}

const conquestCache = new Map<number, number>();

/**
 * Probability the attacker eventually clears the territory, assuming it presses
 * until one side is spent.
 *
 * @param attackers troops the attacker can commit, i.e. troops in the source
 *   territory minus the one that must stay behind.
 * @param defenders troops standing in the target.
 */
export function conquestProbability(attackers: number, defenders: number): number {
  if (attackers <= 0) return 0;
  if (defenders <= 0) return 1;
  const key = attackers * 1000 + defenders;
  const hit = conquestCache.get(key);
  if (hit !== undefined) return hit;

  const aDice = Math.min(3, attackers);
  const dDice = Math.min(2, defenders);
  const dist = roundLossDistribution(aDice, dDice);
  const pairs = Math.min(aDice, dDice);

  let p = 0;
  for (let attackerLosses = 0; attackerLosses <= pairs; attackerLosses++) {
    const w = dist[attackerLosses];
    if (!w) continue;
    const defenderLosses = pairs - attackerLosses;
    p += w * conquestProbability(attackers - attackerLosses, defenders - defenderLosses);
  }

  conquestCache.set(key, p);
  return p;
}
