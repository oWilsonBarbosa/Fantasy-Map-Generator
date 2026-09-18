import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";

const MAGIC = "OROGFMG1";

const PLANES = [
  { name: "height", type: "u8" },
  { name: "temp", type: "i8" },
  { name: "prec", type: "u8" },
  { name: "biome", type: "u8" },
  { name: "koppen", type: "u8" }
];

function makeHeader(overrides: Record<string, unknown> = {}) {
  return {
    format: "orogen-fmg/1",
    planet: "06cy8w6z6a89kow6psje93",
    seed: 10673275,
    crop: "test",
    label: "Test Crop",
    width: 4,
    height: 2,
    box: { latN: 90, latS: -90, lonW: -180, lonE: 180 },
    fmg: { canvasWidth: 1920, canvasHeight: 960, heightExponent: 2.03, mapSize: 100, latitude: 50, longitude: 50 },
    planes: PLANES,
    ...overrides
  };
}

/** Build a bundle the same way tools/fmg-export/bundle.mjs does. */
function makeBundle(header: ReturnType<typeof makeHeader>, planes: Record<string, ArrayLike<number>>) {
  const count = header.width * header.height;
  const payload = Buffer.concat(
    header.planes.map(({ name, type }) => {
      const values = planes[name] ?? new Array(count).fill(0);
      const array = type === "i8" ? Int8Array.from(values) : Uint8Array.from(values);
      return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
    })
  );

  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const prefix = Buffer.alloc(MAGIC.length + 4);
  prefix.write(MAGIC, 0, "ascii");
  prefix.writeUInt32LE(headerJson.length, MAGIC.length);
  const bundle = Buffer.concat([prefix, headerJson, gzipSync(payload)]);
  return bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength) as ArrayBuffer;
}

// 4x2 raster: the top row is land rising west to east, the bottom row is ocean.
const HEIGHTS = [20, 40, 60, 80, 0, 5, 10, 15];
const TEMPS = [10, 12, 14, 16, -20, -18, -16, -14];
const PRECS = [4, 8, 12, 16, 0, 0, 0, 0];
const BIOMES = [4, 6, 6, 9, 0, 0, 0, 0];

describe("Orogen import", () => {
  let Orogen: any;

  beforeEach(async () => {
    globalThis.window = globalThis.window || ({} as any);
    globalThis.options = { mapSize: 0, latitude: 0, longitude: 0 } as any;
    await import("./orogen-import");
    Orogen = (globalThis.window as any).Orogen;
    Orogen.clear();
  });

  const gridOf = (cellsX: number, cellsY: number) => ({ cellsX, cellsY }) as any;

  it("is inactive until a bundle is loaded", () => {
    expect(Orogen.isActive()).toBe(false);
    expect(Orogen.getHeader()).toBeNull();
  });

  it("decodes a bundle and exposes its header", async () => {
    const header = await Orogen.load(
      makeBundle(makeHeader(), { height: HEIGHTS, temp: TEMPS, prec: PRECS, biome: BIOMES })
    );
    expect(header.label).toBe("Test Crop");
    expect(header.planet).toBe("06cy8w6z6a89kow6psje93");
    expect(Orogen.isActive()).toBe(true);
  });

  it("rejects anything that is not a bundle", async () => {
    await expect(Orogen.load(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).buffer)).rejects.toThrow(
      "Not an Orogen bundle"
    );
  });

  it("rejects a bundle from a future format", async () => {
    const bundle = makeBundle(makeHeader({ format: "orogen-fmg/99" }), { height: HEIGHTS });
    await expect(Orogen.load(bundle)).rejects.toThrow("Unsupported bundle format");
  });

  it("rejects a payload that does not match the declared planes", async () => {
    // header claims a 4x2 raster, payload carries a 4x1 one
    const header = makeHeader();
    const short = Buffer.concat(PLANES.map(() => Buffer.from(Uint8Array.from([1, 2, 3, 4]))));
    const headerJson = Buffer.from(JSON.stringify(header), "utf8");
    const prefix = Buffer.alloc(MAGIC.length + 4);
    prefix.write(MAGIC, 0, "ascii");
    prefix.writeUInt32LE(headerJson.length, MAGIC.length);
    const bundle = Buffer.concat([prefix, headerJson, gzipSync(short)]);

    await expect(
      Orogen.load(bundle.buffer.slice(bundle.byteOffset, bundle.byteOffset + bundle.byteLength))
    ).rejects.toThrow(/planes need/);
  });

  it("passes the raster through unchanged when the grid matches it", async () => {
    await Orogen.load(makeBundle(makeHeader(), { height: HEIGHTS, temp: TEMPS, prec: PRECS, biome: BIOMES }));
    const graph = gridOf(4, 2);

    expect(Array.from(Orogen.heights(graph))).toEqual(HEIGHTS);
    expect(Array.from(Orogen.temperatures(graph))).toEqual(TEMPS);
    expect(Array.from(Orogen.precipitation(graph))).toEqual(PRECS);
  });

  it("keeps negative temperatures through the Int8 plane", async () => {
    await Orogen.load(makeBundle(makeHeader(), { temp: TEMPS }));
    expect(Array.from(Orogen.temperatures(gridOf(4, 2)))).toEqual(TEMPS);
  });

  it("box-averages the continuous planes when the grid is coarser", async () => {
    await Orogen.load(makeBundle(makeHeader(), { height: HEIGHTS, temp: TEMPS, prec: PRECS, biome: BIOMES }));
    const heights = Orogen.heights(gridOf(2, 1)); // each cell covers a 2x2 block

    // top-left block is heights 20, 40 over ocean 0, 5 -> mean 16.25 -> 16
    expect(Array.from(heights)).toEqual([16, 41]);
  });

  it("takes the plurality biome rather than averaging it", async () => {
    // a 2x2 block holding three Taiga (9) and one Grassland (4) must stay Taiga
    await Orogen.load(
      makeBundle(makeHeader(), { height: [20, 20, 20, 20, 20, 20, 20, 20], biome: [9, 9, 4, 4, 9, 4, 4, 4] })
    );
    const graph = gridOf(2, 1);
    const pack = {
      cells: { biome: Uint8Array.from([0, 0]), h: Uint8Array.from([25, 25]), g: [0, 1] }
    } as any;

    Orogen.applyBiomes(pack, graph);
    expect(Array.from(pack.cells.biome)).toEqual([9, 4]);
  });

  it("applies imported biomes to land cells only, keeping FMG's wetlands", async () => {
    await Orogen.load(makeBundle(makeHeader(), { height: HEIGHTS, biome: BIOMES }));
    const graph = gridOf(4, 2);
    const pack = {
      cells: {
        //          land   land   land  wetland  ocean
        biome: Uint8Array.from([1, 1, 1, 12, 1]),
        h: Uint8Array.from([25, 25, 25, 25, 10]),
        g: [0, 1, 2, 3, 4]
      }
    } as any;

    const replaced = Orogen.applyBiomes(pack, graph);
    expect(replaced).toBe(3); // three land cells changed
    expect(Array.from(pack.cells.biome)).toEqual([4, 6, 6, 12, 1]);
  });

  it("does nothing when no bundle is loaded", () => {
    const pack = { cells: { biome: Uint8Array.from([5]), h: Uint8Array.from([25]), g: [0] } } as any;
    expect(Orogen.applyBiomes(pack, gridOf(4, 2))).toBe(0);
    expect(Array.from(pack.cells.biome)).toEqual([5]);
  });

  it("forgets everything on clear", async () => {
    await Orogen.load(makeBundle(makeHeader(), { height: HEIGHTS }));
    Orogen.clear();
    expect(Orogen.isActive()).toBe(false);
    expect(() => Orogen.heights(gridOf(4, 2))).toThrow("No Orogen bundle is loaded");
  });
});
