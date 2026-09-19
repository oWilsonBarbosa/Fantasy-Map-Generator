# Importing a simulated planet

The Generator can build a map on top of a planet somebody else simulated, instead
of generating the world itself. **Options → Heightmap → Import Planet** takes an
`.orogen` bundle and uses it for the four things the bundle knows better than we
do — relief, temperature, rainfall and biomes — then runs the rest of the
pipeline normally. Coastlines, rivers, cultures, burgs, states and religions are
all still ours; they just derive from a simulated climate rather than a
procedural one.

The bundles come from [World Orogen](https://www.orogen.studio), a browser
tectonic-and-climate simulator, via `tools/fmg-export/` in its dataset
repository. That tool owns every mapping constant and documents what each one
costs; this page is only about our side.

## Where it plugs in

`src/generators/orogen-import.ts` exposes one global, `Orogen`. It holds no
bundle until one is loaded, and `Orogen.isActive()` is false, so nothing below
changes for an ordinary map.

| Pipeline step | With a bundle loaded |
| --- | --- |
| `heightmap` | `Orogen.heights()` instead of a template or precreated image |
| `mapSize` | skipped — the bundle already placed the map on the globe |
| `temperatures` | `Orogen.temperatures()`: simulated annual mean °C, altitude and continentality already in it |
| `precipitation` | `Orogen.precipitation()`: simulated rainfall, instead of this model's straight wind passes |
| `biomes` | `Biomes.define()` runs as usual, then `Orogen.applyBiomes()` overrules it from the imported Köppen classes |
| `rivers` | `Lakes.detectCloseLakes()` runs as usual, then `Orogen.markClosedLakes()` overrules which lakes are terminal |

Every other step is untouched. That is the point: `Rivers` reads
`grid.cells.prec`, `Population.rankCells` and `Cultures` read biome habitability
and temperature, so feeding real climate into those four arrays is enough to move
the whole downstream world without special-casing any of it.

Wetlands are the one biome we keep against the import. FMG derives them from
river flux, which Köppen has no class for, so they are extra information rather
than a competing opinion.

### Closed-basin lakes

A bundle may carry the footprints of the closed basins its source settled, burned
into the height plane as water and flagged in a `lake` plane. Both are needed.
The height alone puts the water in the right place, but this generator re-derives
whether a lake is terminal, and it does so from terrain: `detectCloseLakes` walks
out from a lake's lowest shore over anything below `feature.height +
lakeElevationLimit` looking for the ocean, and `Lakes.getHeight` takes that
height from the shoreline — so the walk's budget grows with the lake's altitude,
and a high rimmed interior basin is the case it most readily calls open. Scored
across 66 imported sheets, terminal lakes derived that way had a Spearman ρ of
−0.08 against aridity; the source's own had +0.61 over the same boxes.

`Orogen.markClosedLakes()` therefore sets `feature.closed` from the plane, after
`detectCloseLakes` and before `Lakes.defineClimateData()` — which is what reads
`closed` to decide whether an outlet may form. It claims a lake only when more
than half of its cells sit on the mask, because the resampled mask is wider than
the water that survived the height average and a neighbouring lake of this
generator's own would otherwise be swept in.

This generator still creates its own lakes by flooding depressions; only which
ones are terminal is imported.

## The bundle

```
magic       8 bytes   "OROGFMG1"
headerLen   uint32 LE
header      headerLen bytes of UTF-8 JSON
payload     gzip of every plane concatenated in header.planes order
```

Inflated with `DecompressionStream`, so no library is needed. Planes are one byte
per pixel: `height` (`grid.cells.h` scale, 20 = sea level), `temp` (signed °C),
`prec` (`grid.cells.prec` moisture units), `biome` (our biome ids), `koppen`
(the source classification, carried so the bundle is self-describing) and
`lake` (1 where a closed basin was burned in). Only `lake` is optional — a
bundle without it loads, and lake classification is left alone.

The raster is resampled onto whatever grid the current cell-density setting
produces — continuous planes box-averaged, biomes by plurality, so a coarse grid
never invents a biome that was not there.

### Why the header carries a canvas size

`Coordinates.calculate()` derives the map's longitude span from the canvas aspect
ratio:

```ts
const lonT = rn(Math.min((graphWidth / graphHeight) * latT, 360), 1);
```

Only `mapSize`, `latitude` and `longitude` are settable; `lonT` falls out of the
canvas. So `Orogen.applyOptions()` sets `mapWidthInput`/`mapHeightInput` as well
as the three percentages — a bundle that only set the percentages would land on
the wrong meridian. `heightExponent` comes from the header too, so the altitude
readout reports the planet's real metres.

### Ground scale

Nothing in the Generator derives `distanceScale` from the lat/lon box; it is a
standalone option that `randomizeOptions()` rolls from `gauss(3, 1, 1, 5)`. An
imported planet left alone therefore gets a scale bar and distance readouts off
by whatever came up. A degree of latitude is a constant length, so the box fixes
it: `applyOptions()` sets `(latN - latS) × 111.32 / canvasHeight`, locks the
option so the roll cannot overwrite it, lifts the slider's maximum when a
whole-globe box needs more than its stock 20, and assigns the `distanceScale`
global the readouts actually read.

It also switches `distanceUnitInput` to `km`. The number carries no unit of its
own — every readout pairs it with whatever that input says, and the Generator
ships `mi` — so a km figure under a miles label makes the whole map read 1.61×
too large. `areaUnit` is `square`, so it follows the same input.

## Producing `.map` files in bulk

`scripts/build-orogen-maps.mjs` drives a real Generator in a headless browser
through this same importer and saves what the app itself serialises:

```bash
npm run build
node scripts/build-orogen-maps.mjs --bundles ../0r063N/data/fmg --cells 100000
```

A `.map` embeds a rendered SVG of the whole map, so there is no way to write one
faithfully from outside the app — running it is the only honest option. The
script locks the cell-density option before generating (`generate()` calls
`randomizeOptions()`, which resets an unlocked density to the 10K default) and
sizes the browser window to the bundle's canvas so the rendered PNG shows the
whole map.

## Limits worth knowing

- FMG keeps a single temperature per cell, so a planet's summer and winter fields
  arrive averaged. Seasonality does not survive.
- Winds and ocean currents have no per-cell field here and are dropped. They
  shaped the imported rainfall and temperature, so their effect survives even
  though the vectors do not.
- The bundle's box decides the ground resolution, because the grid is uniform over
  the canvas. At 100 000 cells a whole planet is ~71 km per cell, a continent
  25–30 km, and a 20M km² box 14 km — the last matching the source mesh exactly.
  Reach for the smallest box that covers what you care about.
- The 100 000 ceiling is the options slider, not the engine: `grid.cells.i` and
  `pack.cells.g` are `Uint32Array` and `Grid.getCellsDesired()` reads
  `pointsInput.dataset.cells`, so setting that directly works.
  `scripts/build-orogen-maps.mjs --cells` does exactly that. Measured on a
  continent bundle: 100K → 11 s, 300K → 45 s, 1M → 425 s, so cost grows far
  faster than cell count. Past the budget where an imported cell covers one
  source cell, the extra cells interpolate rather than resolve.
