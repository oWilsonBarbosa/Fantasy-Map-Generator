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

Every other step is untouched. That is the point: `Rivers` reads
`grid.cells.prec`, `Population.rankCells` and `Cultures` read biome habitability
and temperature, so feeding real climate into those four arrays is enough to move
the whole downstream world without special-casing any of it.

Wetlands are the one biome we keep against the import. FMG derives them from
river flux, which Köppen has no class for, so they are extra information rather
than a competing opinion.

## The bundle

```
magic       8 bytes   "OROGFMG1"
headerLen   uint32 LE
header      headerLen bytes of UTF-8 JSON
payload     gzip of every plane concatenated in header.planes order
```

Inflated with `DecompressionStream`, so no library is needed. Planes are one byte
per pixel: `height` (`grid.cells.h` scale, 20 = sea level), `temp` (signed °C),
`prec` (`grid.cells.prec` moisture units), `biome` (our biome ids) and `koppen`
(the source classification, carried so the bundle is self-describing).

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
