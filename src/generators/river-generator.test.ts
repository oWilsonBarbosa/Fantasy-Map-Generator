import { beforeEach, describe, expect, it } from "vitest";
import { MIN_NAVIGABLE_FLUX } from "./river-generator";

describe("RiverModule helpers", () => {
  let Rivers: any;

  beforeEach(async () => {
    globalThis.TIME = false;
    globalThis.window = globalThis.window || ({} as any);
    globalThis.pack = {
      cells: { r: [], fl: [], f: [] },
      features: [],
      rivers: []
    } as any;

    await import("./river-generator");
    Rivers = (globalThis as any).Rivers;
  });

  function setCells(cells: { r?: number[]; fl?: number[]; f?: number[] }) {
    globalThis.pack.cells = { r: [], fl: [], f: [], ...cells } as any;
  }

  describe("isNavigable", () => {
    it("returns true when cell has a river and flux meets the threshold", () => {
      setCells({ r: [0, 1, 1], fl: [0, MIN_NAVIGABLE_FLUX, MIN_NAVIGABLE_FLUX + 50] });
      expect(Rivers.isNavigable(1)).toBe(true);
      expect(Rivers.isNavigable(2)).toBe(true);
    });

    it("returns false for cells with no river", () => {
      setCells({ r: [0, 0], fl: [500, 500] });
      expect(Rivers.isNavigable(0)).toBe(false);
    });

    it("returns false for river cells below the threshold", () => {
      setCells({ r: [0, 1], fl: [0, MIN_NAVIGABLE_FLUX - 1] });
      expect(Rivers.isNavigable(1)).toBe(false);
    });
  });

  describe("resolveDrainFeature", () => {
    it("returns the ocean feature id when river drains into the sea", () => {
      // cell 5 is the river-bearing land cell; cell 6 is the sea cell at the mouth
      setCells({ r: [0, 0, 0, 0, 0, 1, 0], f: [0, 0, 0, 0, 0, 0, 2] });
      globalThis.pack.features = [null, null, { i: 2, type: "ocean" }] as any;
      globalThis.pack.rivers = [{ i: 1, cells: [5, 6] }] as any;

      expect(Rivers.resolveDrainFeature(5)).toBe(2);
    });

    it("returns the closed lake feature id when river terminates in a closed lake", () => {
      setCells({ r: [0, 0, 1, 0], f: [0, 0, 0, 3] });
      globalThis.pack.features = [
        null,
        null,
        null,
        { i: 3, type: "lake" } // no outlet => closed
      ] as any;
      globalThis.pack.rivers = [{ i: 1, cells: [2, 3] }] as any;

      expect(Rivers.resolveDrainFeature(2)).toBe(3);
    });

    it("follows lake outlet onward to the final receiving sea", () => {
      // river 1 ends in lake (feature 3, has outlet to river 2); river 2 ends in ocean (feature 4)
      setCells({ r: [0, 1, 0, 2, 0], f: [0, 0, 3, 0, 4] });
      globalThis.pack.features = [null, null, null, { i: 3, type: "lake", outlet: 2 }, { i: 4, type: "ocean" }] as any;
      globalThis.pack.rivers = [
        { i: 1, cells: [1, 2] },
        { i: 2, cells: [3, 4] }
      ] as any;

      expect(Rivers.resolveDrainFeature(1)).toBe(4);
    });

    it("returns null when river leaves the map", () => {
      setCells({ r: [0, 1], f: [0, 0] });
      globalThis.pack.features = [null, null] as any;
      globalThis.pack.rivers = [{ i: 1, cells: [1, -1] }] as any;

      expect(Rivers.resolveDrainFeature(1)).toBeNull();
    });

    it("returns null for a cell with no river", () => {
      setCells({ r: [0, 0] });
      expect(Rivers.resolveDrainFeature(0)).toBeNull();
    });
  });

  describe("resolveLakeDrainFeature", () => {
    it("returns the ocean feature id when the lake outlet chain reaches the sea", () => {
      // lake feature 2 has outlet river 1; river 1 ends in ocean feature 3
      setCells({ r: [0, 1, 0], f: [0, 0, 3] });
      globalThis.pack.features = [null, null, { i: 2, type: "lake", outlet: 1 }, { i: 3, type: "ocean" }] as any;
      globalThis.pack.rivers = [{ i: 1, cells: [1, 2] }] as any;

      expect(Rivers.resolveLakeDrainFeature(2)).toBe(3);
    });

    it("follows a chain through an intermediate open lake to reach the ocean", () => {
      // lake 2 → river 1 → lake 3 (open) → river 2 → ocean 4
      setCells({ r: [0, 1, 0, 2, 0], f: [0, 0, 3, 0, 4] });
      globalThis.pack.features = [
        null,
        null,
        { i: 2, type: "lake", outlet: 1 },
        { i: 3, type: "lake", outlet: 2 },
        { i: 4, type: "ocean" }
      ] as any;
      globalThis.pack.rivers = [
        { i: 1, cells: [1, 2] }, // river 1 drains lake 2 into lake 3
        { i: 2, cells: [3, 4] } // river 2 drains lake 3 into ocean 4
      ] as any;

      expect(Rivers.resolveLakeDrainFeature(2)).toBe(4);
    });

    it("returns the closed downstream lake feature id when the chain terminates there", () => {
      // lake 2 (open) → river 1 → lake 3 (closed, no outlet)
      setCells({ r: [0, 1, 0], f: [0, 0, 3] });
      globalThis.pack.features = [
        null,
        null,
        { i: 2, type: "lake", outlet: 1 },
        { i: 3, type: "lake" } // no outlet — closed
      ] as any;
      globalThis.pack.rivers = [{ i: 1, cells: [1, 2] }] as any;

      expect(Rivers.resolveLakeDrainFeature(2)).toBe(3);
    });

    it("returns null when the outlet river exits the map", () => {
      setCells({ r: [0, 1], f: [0, 0] });
      globalThis.pack.features = [null, null, { i: 2, type: "lake", outlet: 1 }] as any;
      globalThis.pack.rivers = [{ i: 1, cells: [1, -1] }] as any;

      expect(Rivers.resolveLakeDrainFeature(2)).toBeNull();
    });

    it("returns the lake's own feature id when the lake has no outlet (closed lake)", () => {
      globalThis.pack.features = [null, null, { i: 2, type: "lake" }] as any;
      globalThis.pack.rivers = [] as any;

      expect(Rivers.resolveLakeDrainFeature(2)).toBe(2);
    });

    it("returns null for a non-lake feature id", () => {
      globalThis.pack.features = [null, null, { i: 2, type: "ocean" }] as any;
      globalThis.pack.rivers = [] as any;

      expect(Rivers.resolveLakeDrainFeature(2)).toBeNull();
    });

    it("returns null for an unknown feature id", () => {
      globalThis.pack.features = [null] as any;
      globalThis.pack.rivers = [] as any;

      expect(Rivers.resolveLakeDrainFeature(99)).toBeNull();
    });
  });
});

// River flux is accumulated rainfall, so a basin's total scales with how many cells it holds.
// At the stock 100K cells the very largest rivers already gather more than 65,535, and
// pack.cells.fl used to be a Uint16Array: the total wrapped, and a trunk river read as a
// trickle from that point down to its mouth.
describe("flux accumulation", () => {
  const LAND = 400; // cells in the chain, summit down to the coast
  const PRECIPITATION = 200; // per cell, so the mouth gathers 80,000 — past the 16-bit ceiling

  // One river's worth of land: cell 0 is the sea, cells 1..LAND climb inland from it, so
  // every cell drains to the one below and the mouth collects the whole chain.
  function buildChain() {
    const n = LAND + 1;
    const cells = {
      i: Array.from({ length: n }, (_, cell) => cell),
      h: Float32Array.from({ length: n }, (_, cell) => (cell === 0 ? 10 : 20.5 + cell * 0.1)),
      t: new Uint8Array(n), // zero, so alterHeights leaves the heights as given
      b: new Uint8Array(n),
      haven: new Uint32Array(n), // none, so each cell drains to its lowest neighbour
      g: Uint32Array.from({ length: n }, (_, cell) => cell),
      f: Uint16Array.from({ length: n }, (_, cell) => (cell === 0 ? 1 : 2)),
      c: Array.from({ length: n }, (_, cell) => [cell - 1, cell + 1].filter(other => other >= 0 && other < n)),
      p: Array.from({ length: n }, (_, cell) => [cell * 4, 50])
    };
    return { cells, n };
  }

  beforeEach(async () => {
    const { cells, n } = buildChain();
    globalThis.TIME = false;
    globalThis.window = globalThis.window || ({} as any);
    (globalThis as any).seed = "1";
    (globalThis as any).graphWidth = 2000;
    (globalThis as any).graphHeight = 100;
    (globalThis as any).pointsInput = { dataset: { cells: "10000" } }; // a modifier of exactly 1
    (globalThis as any).grid = { cells: { prec: new Uint8Array(n).fill(PRECIPITATION) } };
    (globalThis as any).Lakes = {
      detectCloseLakes: () => {},
      defineClimateData: () => new Uint16Array(n),
      cleanupLakeData: () => {}
    };
    (globalThis as any).Orogen = { markClosedLakes: () => 0 };
    globalThis.pack = { cells, features: [0, { i: 1, type: "ocean" }, { i: 2, type: "island" }], rivers: [] } as any;

    await import("./river-generator");
  });

  it("keeps the flux of a river that gathers more than 65,535", () => {
    (globalThis as any).Rivers.generate(false);

    const [river] = pack.rivers;
    expect(pack.rivers).toHaveLength(1);
    expect(river.discharge).toBe(LAND * PRECIPITATION);
    expect(river.discharge).toBeGreaterThan(65535);
  });

  it("never lets flux fall going downstream, which is what a wrap looks like", () => {
    (globalThis as any).Rivers.generate(false);

    const { fl } = pack.cells;
    // cell LAND is the headwater and cell 1 the mouth, so flux must not increase with the cell id
    for (let cell = 1; cell < LAND; cell++) expect(fl[cell]).toBeGreaterThanOrEqual(fl[cell + 1]);
  });
});
