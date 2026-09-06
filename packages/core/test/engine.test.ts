import assert from "node:assert/strict";
import { test } from "node:test";

import { EARTH, conquestProbability, roundLossDistribution, runMatchSync, territoryCount } from "../src/index.js";
import { HeuristicAgent, RandomAgent } from "@bellum/agents";
import { updateRatings, newRating, conservative } from "@bellum/arena";

test("the map is well formed", () => {
  assert.equal(EARTH.territoryCount, 42);
  assert.equal(EARTH.continents.length, 6);
  assert.equal(
    EARTH.continents.reduce((a, c) => a + c.territories.length, 0),
    42,
  );

  // Adjacency must be symmetric, or attacks are legal in only one direction.
  for (let t = 0; t < EARTH.territoryCount; t++) {
    for (const n of EARTH.adjacency[t]!) {
      assert.ok(
        EARTH.adjacency[n]!.includes(t),
        `${EARTH.territoryNames[t]} lists ${EARTH.territoryNames[n]} but not the reverse`,
      );
      assert.notEqual(n, t, "a territory cannot border itself");
    }
  }

  // The board must be one connected component, or a game can never be won.
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length) {
    for (const n of EARTH.adjacency[stack.pop()!]!) {
      if (!seen.has(n)) {
        seen.add(n);
        stack.push(n);
      }
    }
  }
  assert.equal(seen.size, 42, "map is not fully connected");
});

test("combat odds are exact and sane", () => {
  for (const [a, d] of [
    [1, 1],
    [2, 1],
    [3, 1],
    [1, 2],
    [2, 2],
    [3, 2],
  ] as const) {
    const dist = roundLossDistribution(a, d);
    const total = dist.reduce((x, y) => x + y, 0);
    assert.ok(Math.abs(total - 1) < 1e-12, `distribution for ${a}v${d} sums to ${total}`);
  }

  // Three attacker dice against two defender dice: the attacker takes both
  // losses 29.26% of the time. This is the standard published figure.
  const d32 = roundLossDistribution(3, 2);
  assert.ok(Math.abs(d32[2]! - 0.2926) < 0.001, `got ${d32[2]}`);
  assert.ok(Math.abs(d32[0]! - 0.3717) < 0.001, `got ${d32[0]}`);

  // More attackers can only help; more defenders can only hurt.
  for (let d = 1; d <= 10; d++) {
    for (let a = 1; a < 20; a++) {
      assert.ok(conquestProbability(a + 1, d) >= conquestProbability(a, d) - 1e-12);
      assert.ok(conquestProbability(a, d + 1) <= conquestProbability(a, d) + 1e-12);
    }
  }
  assert.ok(conquestProbability(1, 1) < 0.42 && conquestProbability(1, 1) > 0.4);
  assert.ok(conquestProbability(20, 1) > 0.99);
});

test("matches are reproducible from the seed", () => {
  const play = () =>
    runMatchSync([new RandomAgent("a", 1), new RandomAgent("b", 2), new RandomAgent("c", 3)], {
      seed: 12345,
      maxTurns: 400,
      recordLog: true,
    });

  const first = play();
  const second = play();
  assert.equal(first.winner, second.winner);
  assert.equal(first.turns, second.turns);
  assert.deepEqual(first.ranking, second.ranking);
  assert.equal(first.log.length, second.log.length);
});

test("random self-play never produces an illegal state", () => {
  // Random agents are the oracle: they explore rule corners a good bot avoids.
  let conquests = 0;
  const games = 150;

  for (let g = 0; g < games; g++) {
    const playerCount = 2 + (g % 5);
    const result = runMatchSync(
      Array.from({ length: playerCount }, (_, i) => new RandomAgent(`r${i}`, g * 10 + i)),
      { seed: 900 + g, maxTurns: 400 },
    );

    const state = result.finalState;
    let totalOwned = 0;
    for (let t = 0; t < EARTH.territoryCount; t++) {
      assert.ok(state.owner[t]! >= 0, "every territory must be owned once setup ends");
      assert.ok(state.troops[t]! >= 1, `territory ${t} has ${state.troops[t]} troops`);
      totalOwned++;
    }
    assert.equal(totalOwned, 42);

    assert.equal(result.ranking.length, playerCount, "everyone must be ranked");
    assert.equal(new Set(result.ranking).size, playerCount, "no duplicate ranks");

    if (result.reason === "conquest") {
      conquests++;
      assert.notEqual(result.winner, null);
      assert.equal(territoryCount(state, result.winner!), 42, "a conquest winner owns the board");
      assert.equal(state.players.filter((p) => p.alive).length, 1);
    }
  }

  // Random play mostly stalemates: agents that attack indiscriminately never
  // consolidate, so most of these hit the turn cap. That is a fact about random
  // play, not about the engine, so this only checks conquest is reachable at all.
  assert.ok(conquests > 0, "no random game ever reached a conquest");
});

test("competent play terminates in a conquest", () => {
  // This is the real termination check. If the engine ever deadlocks a phase, or
  // reinforcement stops outpacing attrition, this rate collapses.
  let conquests = 0;
  const games = 40;

  for (let g = 0; g < games; g++) {
    const result = runMatchSync(
      [new HeuristicAgent("a"), new HeuristicAgent("b"), new HeuristicAgent("c")],
      { seed: 300 + g, maxTurns: 400 },
    );
    if (result.reason === "conquest") {
      conquests++;
      assert.equal(territoryCount(result.finalState, result.winner!), 42);
    }
  }

  assert.ok(conquests / games > 0.8, `only ${conquests}/${games} heuristic games reached a conquest`);
});

test("the heuristic agent beats random decisively", () => {
  // If this ever fails, the heuristic has regressed or the engine has a bug that
  // rewards flailing. Either way it is worth failing the build over.
  let heuristicWins = 0;
  const games = 40;

  for (let g = 0; g < games; g++) {
    const result = runMatchSync(
      [new HeuristicAgent("h"), new RandomAgent("r1", g), new RandomAgent("r2", g + 500)],
      { seed: 7000 + g, maxTurns: 400 },
    );
    if (result.ranking[0] === 0) heuristicWins++;
  }

  assert.ok(heuristicWins / games > 0.8, `heuristic took first in only ${heuristicWins}/${games}`);
});

test("trueskill separates a stronger player from a weaker one", () => {
  const ratings = [newRating(), newRating()];
  for (let i = 0; i < 30; i++) updateRatings(ratings, [0, 1]);

  assert.ok(ratings[0]!.mu > ratings[1]!.mu);
  // The gap has to be decisive, not merely signed.
  assert.ok(conservative(ratings[0]!) - conservative(ratings[1]!) > 15);
  // Uncertainty must shrink as evidence accumulates. It flattens out rather than
  // going to zero, because once the favourite is obvious another win teaches
  // almost nothing and tau adds a little uncertainty back every game.
  assert.ok(ratings[0]!.sigma < newRating().sigma * 0.55, `sigma stalled at ${ratings[0]!.sigma}`);
  assert.ok(Number.isFinite(ratings[0]!.mu) && Number.isFinite(ratings[0]!.sigma));
});
