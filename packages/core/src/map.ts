/**
 * The classic 42-territory world map.
 *
 * Territories are plain integer ids everywhere in the engine. That is deliberate:
 * a NEAT genome wants a fixed-length Float32Array indexed by territory, and a
 * graph-convolution observation (see the D.A.D paper, arXiv:2009.06355) wants a
 * static adjacency matrix. Strings are for humans and for the replay log only.
 */

export type TerritoryId = number;
export type ContinentId = number;

export interface Continent {
  readonly id: ContinentId;
  readonly name: string;
  readonly bonus: number;
  readonly territories: readonly TerritoryId[];
}

export interface GameMap {
  readonly name: string;
  readonly territoryNames: readonly string[];
  readonly continents: readonly Continent[];
  /** adjacency[t] = sorted neighbour ids. */
  readonly adjacency: readonly (readonly TerritoryId[])[];
  /** continentOf[t] = the continent that contains t. */
  readonly continentOf: readonly ContinentId[];
  readonly territoryCount: number;
}

const RAW: Record<string, { bonus: number; territories: Record<string, string[]> }> = {
  "North America": {
    bonus: 5,
    territories: {
      Alaska: ["Northwest Territory", "Alberta", "Kamchatka"],
      "Northwest Territory": ["Alaska", "Alberta", "Ontario", "Greenland"],
      Greenland: ["Northwest Territory", "Ontario", "Quebec", "Iceland"],
      Alberta: ["Alaska", "Northwest Territory", "Ontario", "Western United States"],
      Ontario: ["Northwest Territory", "Alberta", "Greenland", "Quebec", "Western United States", "Eastern United States"],
      Quebec: ["Greenland", "Ontario", "Eastern United States"],
      "Western United States": ["Alberta", "Ontario", "Eastern United States", "Central America"],
      "Eastern United States": ["Ontario", "Quebec", "Western United States", "Central America"],
      "Central America": ["Western United States", "Eastern United States", "Venezuela"],
    },
  },
  "South America": {
    bonus: 2,
    territories: {
      Venezuela: ["Central America", "Brazil", "Peru"],
      Brazil: ["Venezuela", "Peru", "Argentina", "North Africa"],
      Peru: ["Venezuela", "Brazil", "Argentina"],
      Argentina: ["Peru", "Brazil"],
    },
  },
  Europe: {
    bonus: 5,
    territories: {
      Iceland: ["Greenland", "Great Britain", "Scandinavia"],
      Scandinavia: ["Iceland", "Great Britain", "Northern Europe", "Ukraine"],
      Ukraine: ["Scandinavia", "Northern Europe", "Southern Europe", "Ural", "Afghanistan", "Middle East"],
      "Great Britain": ["Iceland", "Scandinavia", "Northern Europe", "Western Europe"],
      "Northern Europe": ["Scandinavia", "Ukraine", "Great Britain", "Western Europe", "Southern Europe"],
      "Western Europe": ["Great Britain", "Northern Europe", "Southern Europe", "North Africa"],
      "Southern Europe": ["Northern Europe", "Ukraine", "Western Europe", "North Africa", "Egypt", "Middle East"],
    },
  },
  Africa: {
    bonus: 3,
    territories: {
      "North Africa": ["Brazil", "Western Europe", "Southern Europe", "Egypt", "East Africa", "Congo"],
      Egypt: ["Southern Europe", "North Africa", "East Africa", "Middle East"],
      "East Africa": ["Egypt", "North Africa", "Congo", "South Africa", "Madagascar", "Middle East"],
      Congo: ["North Africa", "East Africa", "South Africa"],
      "South Africa": ["Congo", "East Africa", "Madagascar"],
      Madagascar: ["East Africa", "South Africa"],
    },
  },
  Asia: {
    bonus: 7,
    territories: {
      Ural: ["Ukraine", "Siberia", "China", "Afghanistan"],
      Siberia: ["Ural", "Yakutsk", "Irkutsk", "Mongolia", "China"],
      Yakutsk: ["Siberia", "Irkutsk", "Kamchatka"],
      Kamchatka: ["Yakutsk", "Irkutsk", "Mongolia", "Japan", "Alaska"],
      Irkutsk: ["Siberia", "Yakutsk", "Kamchatka", "Mongolia"],
      Mongolia: ["Siberia", "Irkutsk", "Kamchatka", "Japan", "China"],
      Japan: ["Kamchatka", "Mongolia"],
      Afghanistan: ["Ukraine", "Ural", "China", "India", "Middle East"],
      China: ["Ural", "Siberia", "Mongolia", "Afghanistan", "India", "Siam"],
      "Middle East": ["Ukraine", "Southern Europe", "Egypt", "East Africa", "Afghanistan", "India"],
      India: ["Afghanistan", "China", "Middle East", "Siam"],
      Siam: ["China", "India", "Indonesia"],
    },
  },
  Australia: {
    bonus: 2,
    territories: {
      Indonesia: ["Siam", "New Guinea", "Western Australia"],
      "New Guinea": ["Indonesia", "Western Australia", "Eastern Australia"],
      "Western Australia": ["Indonesia", "New Guinea", "Eastern Australia"],
      "Eastern Australia": ["New Guinea", "Western Australia"],
    },
  },
};

function buildEarth(): GameMap {
  const names: string[] = [];
  const continents: Continent[] = [];
  const continentOf: number[] = [];

  for (const [cName, c] of Object.entries(RAW)) {
    const ids: number[] = [];
    for (const tName of Object.keys(c.territories)) {
      const id = names.length;
      names.push(tName);
      ids.push(id);
      continentOf[id] = continents.length;
    }
    continents.push({ id: continents.length, name: cName, bonus: c.bonus, territories: ids });
  }

  const index = new Map(names.map((n, i) => [n, i]));
  const adjacency: number[][] = names.map(() => []);
  for (const c of Object.values(RAW)) {
    for (const [tName, neighbours] of Object.entries(c.territories)) {
      const from = index.get(tName)!;
      for (const n of neighbours) {
        const to = index.get(n);
        if (to === undefined) throw new Error(`Unknown neighbour "${n}" of "${tName}"`);
        adjacency[from]!.push(to);
      }
      adjacency[from]!.sort((a, b) => a - b);
    }
  }

  return {
    name: "Earth",
    territoryNames: names,
    continents,
    adjacency,
    continentOf,
    territoryCount: names.length,
  };
}

export const EARTH: GameMap = buildEarth();
