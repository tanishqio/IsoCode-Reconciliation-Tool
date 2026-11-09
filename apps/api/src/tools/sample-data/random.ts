// A small seeded random number generator, so the same seed always gives the same sample data.
// (mulberry32. Not for anything secret.)

export interface Rng {
  /** A number from 0 up to, not including, 1. */
  next: () => number;
  /** A whole number from min to max, both included. */
  int: (min: number, max: number) => number;
  pick: <T>(items: readonly T[]) => T;
  /** True with the given probability (0 to 1). */
  chance: (probability: number) => boolean;
  /** A new array in random order. */
  shuffle: <T>(items: readonly T[]) => T[];
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number): number => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: (items) => {
      const item = items[int(0, items.length - 1)];
      if (item === undefined) throw new RangeError("Cannot pick from an empty list.");
      return item;
    },
    chance: (probability) => next() < probability,
    shuffle: (items) => {
      const copy = [...items];
      for (let index = copy.length - 1; index > 0; index -= 1) {
        const other = int(0, index);
        const held = copy[index] as (typeof items)[number];
        copy[index] = copy[other] as (typeof items)[number];
        copy[other] = held;
      }
      return copy;
    },
  };
}
