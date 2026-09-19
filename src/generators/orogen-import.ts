// Import a planet simulated by World Orogen instead of generating one.
//
// Orogen (orogen.studio) runs a tectonic and climate simulation on a sphere and
// publishes the result per cell. An `.orogen` bundle carries that result already
// rasterised into the four arrays FMG keeps per grid cell — height, temperature,
// precipitation and biome — so the pipeline can skip its own heightmap, climate
// and biome steps and run everything downstream (features, rivers, cultures,
// burgs, states) on a simulated world rather than a procedural one.
//
// The bundle is produced by `tools/fmg-export/` in the Orogen dataset
// repository, which also owns the mapping constants; this module only consumes
// what the header declares.

import type { GridGraph } from "@/types/GridGraph";
import type { PackedGraph } from "@/types/PackedGraph";
import { rn } from "@/utils";
import { lock } from "@/utils/preferences";

declare global {
  var Orogen: OrogenModule;
}

const MAGIC = "OROGFMG1";
const KM_PER_DEGREE = 111.32; // one degree of latitude, the one distance that does not vary
const FORMAT = "orogen-fmg/1";

type PlaneType = "u8" | "i8";

interface PlaneSpec {
  name: string;
  type: PlaneType;
  description?: string;
}

export interface OrogenHeader {
  format: string;
  planet: string;
  seed: number;
  crop: string;
  label: string;
  width: number;
  height: number;
  box: { latN: number; latS: number; lonW: number; lonE: number };
  fmg: {
    canvasWidth: number;
    canvasHeight: number;
    heightExponent: number;
    mapSize: number;
    latitude: number;
    longitude: number;
  };
  planes: PlaneSpec[];
  heightMapping?: string;
  precipitation?: { mmPerUnit: number; scaleMm: number };
}

interface Planes {
  height: Uint8Array;
  temp: Int8Array;
  prec: Uint8Array;
  biome: Uint8Array;
  koppen: Uint8Array;
  /** optional: 1 where the bundle burned in a closed-basin lake */
  lake?: Uint8Array;
}

/** per-grid-cell values, resampled from the bundle raster onto the current grid */
interface Resampled {
  cellsX: number;
  cellsY: number;
  height: Uint8Array;
  temp: Int8Array;
  prec: Uint8Array;
  biome: Uint8Array;
  lake: Uint8Array;
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class OrogenModule {
  private header: OrogenHeader | null = null;
  private planes: Planes | null = null;
  private resampled: Resampled | null = null;

  /** decode a bundle; throws with a readable reason if it is not one */
  async parse(buffer: ArrayBuffer): Promise<{ header: OrogenHeader; planes: Planes }> {
    const bytes = new Uint8Array(buffer);
    const magic = String.fromCharCode(...bytes.subarray(0, MAGIC.length));
    if (magic !== MAGIC) throw new Error("Not an Orogen bundle");

    const view = new DataView(buffer);
    const headerLength = view.getUint32(MAGIC.length, true);
    const headerStart = MAGIC.length + 4;
    const header: OrogenHeader = JSON.parse(
      new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength))
    );
    if (header.format !== FORMAT) throw new Error(`Unsupported bundle format ${header.format}, expected ${FORMAT}`);

    const raw = await gunzip(bytes.subarray(headerStart + headerLength));
    const payload = raw.buffer as ArrayBuffer;
    const count = header.width * header.height;
    const needed = count * header.planes.length; // every plane is one byte per pixel
    if (raw.byteLength !== needed) {
      throw new Error(`Bundle payload is ${raw.byteLength} bytes, its ${header.planes.length} planes need ${needed}`);
    }

    const planes = {} as Record<string, Uint8Array | Int8Array>;
    let offset = 0;
    for (const { name, type } of header.planes) {
      const Ctor = type === "i8" ? Int8Array : Uint8Array;
      planes[name] = new Ctor(payload, raw.byteOffset + offset, count);
      offset += count;
    }
    for (const name of ["height", "temp", "prec", "biome"]) {
      if (!planes[name]) throw new Error(`Bundle is missing the ${name} plane`);
    }

    return { header, planes: planes as unknown as Planes };
  }

  async load(buffer: ArrayBuffer): Promise<OrogenHeader> {
    const { header, planes } = await this.parse(buffer);
    this.header = header;
    this.planes = planes;
    this.resampled = null;
    return header;
  }

  clear(): void {
    this.header = null;
    this.planes = null;
    this.resampled = null;
  }

  isActive(): boolean {
    return this.header !== null;
  }

  getHeader(): OrogenHeader | null {
    return this.header;
  }

  /**
   * Put the canvas and the map's place on the globe where the bundle says. The
   * longitude span is not settable in FMG — it falls out of the canvas aspect
   * (Coordinates.calculate) — so the canvas has to be applied too, not just the
   * three option percentages.
   */
  applyOptions(): void {
    if (!this.header) return;
    const { canvasWidth, canvasHeight, heightExponent, mapSize, latitude, longitude } = this.header.fmg;

    (document.getElementById("mapWidthInput") as HTMLInputElement).value = String(canvasWidth);
    (document.getElementById("mapHeightInput") as HTMLInputElement).value = String(canvasHeight);

    const exponentInput = document.getElementById("heightExponentInput") as HTMLInputElement;
    exponentInput.value = String(heightExponent);
    exponentInput.dispatchEvent(new Event("input", { bubbles: true }));

    // Ground scale is not derived from the lat/lon box anywhere in FMG — it is a
    // standalone option that randomizeOptions() rolls. Left alone, an imported
    // planet gets a scale bar and distance readouts off by whatever it rolled.
    // A degree of latitude is a constant length, so the box's height fixes it.
    const kmPerPixel = rn(((this.header.box.latN - this.header.box.latS) * KM_PER_DEGREE) / canvasHeight, 3);
    const scaleInput = document.getElementById("distanceScaleInput") as HTMLInputElement;
    if (scaleInput) {
      // a whole-globe map needs ~21 km/px, past the slider's stock maximum
      if (Number(scaleInput.max) < kmPerPixel) scaleInput.max = String(Math.ceil(kmPerPixel));
      scaleInput.value = String(kmPerPixel);
      // Locking matters as much as setting: randomizeOptions() rolls an unlocked
      // distanceScale from gauss(3, 1, 1, 5), and it runs after this.
      lock("distanceScale");
    }
    distanceScale = kmPerPixel; // the global the scale bar and every readout use

    // distanceScale carries no unit of its own — every readout pairs it with
    // whatever this input says, and FMG ships "mi". Left alone, a km figure gets
    // a miles label and the whole map reads 1.61x too large. areaUnit is
    // "square", so it follows this one.
    const unitInput = document.getElementById("distanceUnitInput") as HTMLInputElement | null;
    if (unitInput && unitInput.value !== "km") {
      unitInput.value = "km";
      unitInput.dispatchEvent(new Event("change", { bubbles: true }));
    }

    options.mapSize = mapSize;
    options.latitude = latitude;
    options.longitude = longitude;
  }

  /** km per map pixel the bundle implies — exposed so the value can be asserted */
  getDistanceScale(): number | null {
    if (!this.header) return null;
    const { box, fmg } = this.header;
    return rn(((box.latN - box.latS) * KM_PER_DEGREE) / fmg.canvasHeight, 3);
  }

  /**
   * Resample the bundle raster onto the current grid, box-averaging the
   * continuous planes and taking the plurality of the categorical one. The
   * bundle covers exactly the lat/lon box the map is placed on, so grid cell
   * (x, y) maps straight onto the raster rectangle it spans.
   */
  private resample(graph: GridGraph): Resampled {
    if (!this.header || !this.planes) throw new Error("No Orogen bundle is loaded");
    if (this.resampled && this.resampled.cellsX === graph.cellsX && this.resampled.cellsY === graph.cellsY) {
      return this.resampled;
    }

    const { width, height } = this.header;
    const { cellsX, cellsY } = graph;
    const count = cellsX * cellsY;
    const out: Resampled = {
      cellsX,
      cellsY,
      height: new Uint8Array(count),
      temp: new Int8Array(count),
      prec: new Uint8Array(count),
      biome: new Uint8Array(count),
      lake: new Uint8Array(count)
    };

    const lakePlane = this.planes.lake;
    const votes = new Uint16Array(256);
    for (let cy = 0; cy < cellsY; cy++) {
      const y0 = Math.floor((cy * height) / cellsY);
      const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / cellsY));

      for (let cx = 0; cx < cellsX; cx++) {
        const x0 = Math.floor((cx * width) / cellsX);
        const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / cellsX));

        let sumHeight = 0;
        let sumTemp = 0;
        let sumPrec = 0;
        let samples = 0;
        let lakeSamples = 0;
        let topBiome = 0;
        let topVotes = 0;

        for (let y = y0; y < y1; y++) {
          const row = y * width;
          for (let x = x0; x < x1; x++) {
            const k = row + x;
            sumHeight += this.planes.height[k];
            sumTemp += this.planes.temp[k];
            sumPrec += this.planes.prec[k];
            if (lakePlane?.[k]) lakeSamples++;
            samples++;
            const biome = this.planes.biome[k];
            const seen = ++votes[biome];
            if (seen > topVotes) {
              topVotes = seen;
              topBiome = biome;
            }
          }
        }
        for (let y = y0; y < y1; y++) {
          const row = y * width;
          for (let x = x0; x < x1; x++) votes[this.planes.biome[row + x]] = 0;
        }

        const i = cy * cellsX + cx;
        out.height[i] = Math.round(sumHeight / samples);
        out.temp[i] = Math.round(sumTemp / samples);
        out.prec[i] = Math.round(sumPrec / samples);
        out.biome[i] = topBiome;
        // any sample is enough: a burned lake is a minority of its cell wherever
        // it is being eroded by the average, which is exactly where the flag has
        // to survive for the lake to still be recognised as closed
        out.lake[i] = lakeSamples ? 1 : 0;
      }
    }

    this.resampled = out;
    return out;
  }

  /** Orogen's relief, in place of a heightmap template */
  heights(graph: GridGraph): Uint8Array {
    return Uint8Array.from(this.resample(graph).height);
  }

  /** Orogen's simulated annual mean temperature, in place of FMG's latitude bands */
  temperatures(graph: GridGraph): Int8Array {
    return Int8Array.from(this.resample(graph).temp);
  }

  /** Orogen's simulated rainfall, in place of FMG's wind passes */
  precipitation(graph: GridGraph): Uint8Array {
    return Uint8Array.from(this.resample(graph).prec);
  }

  /**
   * Mark the lakes the bundle burned in as closed, overriding the terrain test.
   *
   * `Lakes.detectCloseLakes` decides closure by walking outward from a lake's
   * lowest shore over anything below `feature.height + lakeElevationLimit`,
   * looking for the ocean. `Lakes.getHeight` takes that height from the
   * shoreline, so the walk's budget grows with the lake's altitude and a high
   * rimmed interior basin — the textbook endorheic case — is the one it most
   * readily calls open. It is also a test about terrain, not climate, which is
   * why FMG's terminal lakes carry no signal about aridity.
   *
   * The bundle's `lake` plane is not an opinion about terrain. It is the result
   * of the dataset's own water balance: inflow accumulated over the whole basin
   * against evaporation over the flooded area, with the lake trimmed back to
   * what that balance sustains. Where the two disagree, the bundle wins.
   *
   * Call after `Lakes.detectCloseLakes` and before `Lakes.defineClimateData`,
   * which is what reads `closed` to decide whether an outlet may form.
   */
  markClosedLakes(packGraph: PackedGraph, gridGraph: GridGraph): number {
    if (!this.isActive() || !this.planes?.lake) return 0;
    const { lake } = this.resample(gridGraph);
    const { f, g } = packGraph.cells;

    // A grid cell counts as burned if any of its raster samples was, so the mask
    // is wider than the water that survived the height average. That is what
    // makes an eroded lake still findable, and it is also why a lake has to be
    // mostly over the mask to be claimed: touching it is what a neighbouring
    // lake of FMG's own does.
    const OWNED = 0.5;
    const total = new Uint32Array(packGraph.features.length);
    const burned = new Uint32Array(packGraph.features.length);
    for (let cellId = 0; cellId < f.length; cellId++) {
      const featureId = f[cellId];
      if (!featureId || featureId >= total.length) continue;
      total[featureId]++;
      if (lake[g[cellId]]) burned[featureId]++;
    }

    let marked = 0;
    for (const feature of packGraph.features) {
      if (!feature || feature.type !== "lake") continue;
      const cells = total[feature.i];
      if (!cells || burned[feature.i] / cells < OWNED) continue;
      feature.closed = true;
      marked++;
    }
    return marked;
  }

  /**
   * Replace the biomes FMG derived from its own matrix with the ones Orogen's
   * published Köppen classes map to. FMG's wetlands are kept: they come from
   * river flux, which Köppen has no class for, so they are extra information
   * rather than a competing opinion.
   */
  applyBiomes(packGraph: PackedGraph, gridGraph: GridGraph): number {
    if (!this.isActive()) return 0;
    const { biome: orogenBiome } = this.resample(gridGraph);
    const { biome, h, g } = packGraph.cells;

    const WETLAND = 12;
    let replaced = 0;
    for (let cellId = 0; cellId < biome.length; cellId++) {
      if (h[cellId] < 20 || biome[cellId] === WETLAND) continue;
      const imported = orogenBiome[g[cellId]];
      if (!imported || imported === biome[cellId]) continue;
      biome[cellId] = imported;
      replaced++;
    }
    return replaced;
  }
}

window.Orogen = new OrogenModule();
