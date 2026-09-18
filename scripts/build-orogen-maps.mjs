// Turn .orogen planet bundles into .map files by driving a real FMG in a browser.
//
//   npm run build && node scripts/build-orogen-maps.mjs --bundles ../0r063N/data/fmg
//
// A .map embeds a rendered SVG of the whole map, so it cannot be written from
// outside the app — the only way to produce one faithfully is to run the app.
// This loads each bundle through the same Orogen importer the UI uses, runs the
// normal generation pipeline on top of it, and saves what FMG itself serialises.
//
// CHROMIUM_PATH overrides the browser, matching playwright.config.ts.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW_URL = "http://localhost:4173";
const MAX_VIEWPORT = 2600; // a window big enough for any crop's canvas without absurd memory
const log = (...a) => console.log(...a);

/** Read a bundle's JSON header without inflating its payload. */
function readHeader(bytes) {
  const magic = bytes.subarray(0, 8).toString("ascii");
  if (magic !== "OROGFMG1") throw new Error(`not an Orogen bundle (magic ${JSON.stringify(magic)})`);
  const headerLength = bytes.readUInt32LE(8);
  return JSON.parse(bytes.subarray(12, 12 + headerLength).toString("utf8"));
}

function parseArgs(argv) {
  const args = {
    bundles: path.join(ROOT, "..", "0r063N", "data", "fmg"),
    out: path.join(ROOT, "..", "0r063N", "data", "fmg", "maps"),
    cells: 100000,
    only: null,
    screenshots: true,
    reloadCheck: true
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--bundles") args.bundles = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--cells") args.cells = +argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--no-screenshots") args.screenshots = false;
    else if (argv[i] === "--no-reload-check") args.reloadCheck = false;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return args;
}

/**
 * Load a written .map back into a clean page and check it comes out the same.
 * Writing a file the app cannot read again would be the worst possible failure
 * here, and it is cheap to rule out.
 */
async function checkReload(browser, mapFile, expected) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    try {
      localStorage.setItem("version", "999.0.0");
    } catch {}
  });
  try {
    await page.goto(PREVIEW_URL, { waitUntil: "load" });
    await page.waitForFunction(() => Boolean(window.mapId && window.pack?.cells), null, { timeout: 120000 });

    await page.setInputFiles("#mapToLoad", mapFile);
    await page.waitForFunction(
      count => window.pack?.cells?.i?.length === count,
      expected.packCells,
      { timeout: 180000 }
    );

    return await page.evaluate(() => ({
      packCells: window.pack.cells.i.length,
      burgs: window.pack.burgs.length - 1,
      states: window.pack.states.length - 1,
      rivers: window.pack.rivers.length,
      mapCoordinates: window.mapCoordinates
    }));
  } finally {
    await context.close();
  }
}

async function startPreview() {
  // --strictPort so a leftover preview from an earlier run cannot quietly serve a
  // stale dist on the port we then navigate to.
  // detached so the whole process group can be killed: signalling the spawned
  // wrapper alone leaves the real server running and holding the port, which then
  // keeps this process alive forever and serves a stale dist to the next run.
  const server = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      server.kill("SIGKILL"); // the group is already gone
    }
  };
  process.on("exit", stop);

  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("vite preview did not start within 60s")), 60000);
      const fail = message => {
        clearTimeout(timer);
        reject(new Error(message));
      };
      const onData = data => {
        const text = data.toString();
        if (/is in use|EADDRINUSE/.test(text)) return fail("port 4173 is already in use — stop the other preview first");
        if (text.includes(PREVIEW_URL)) {
          clearTimeout(timer);
          resolve();
        }
      };
      server.stdout.on("data", onData);
      server.stderr.on("data", onData);
      server.on("error", reject);
      server.on("exit", code => fail(`vite preview exited with code ${code}`));
    });
  } catch (error) {
    stop();
    throw error;
  }

  return { stop };
}

/** Everything below runs inside the page, against the real app globals. */
async function buildMap(page, bundleBytes, cells) {
  return page.evaluate(
    async ({ bytes, cells }) => {
      const buffer = new Uint8Array(bytes).buffer;
      const header = await window.Orogen.load(buffer);
      window.Orogen.applyOptions();

      // The detail slider is the cell budget. Grid.getCellsDesired() reads the
      // dataset attribute, not the slider position, so setting it directly lifts the
      // UI's 100K ceiling — nothing downstream is 16-bit indexed. It has to be
      // locked as well as set: generate() calls randomizeOptions(), which resets an
      // unlocked density back to the 10K default before the grid is built.
      const densitySteps = { 1000: 1, 2000: 2, 5000: 3, 10000: 4, 20000: 5, 30000: 6, 40000: 7, 50000: 8, 60000: 9, 70000: 10, 80000: 11, 90000: 12, 100000: 13 };
      const pointsInput = document.getElementById("pointsInput");
      pointsInput.value = String(densitySteps[cells] ?? 13);
      pointsInput.dataset.cells = String(cells);
      window.lock("points");

      window.mapName.value = header.label;

      const bootMapId = window.mapId;
      const started = performance.now();
      // generate() only rebuilds the data. The SVG keeps showing the previous map
      // until the layers are redrawn, which is what regenerateMap() does around it.
      window.undraw();
      await window.generate({});
      window.Layers.drawAll();
      window.fitMapToScreen();
      const elapsed = Math.round(performance.now() - started);

      // mapId is stamped at the end of every generation. If it did not move, this
      // map is the one the app made on boot and the import never took.
      if (window.mapId === bootMapId) throw new Error("generation did not replace the boot map");

      // every Services method is lazily loaded, so it resolves rather than returns
      const mapData = await window.Services.Save.prepareMapData();
      return {
        header,
        mapData,
        elapsed,
        stats: {
          gridCells: window.grid.cells.i.length,
          packCells: window.pack.cells.i.length,
          landCells: Array.from(window.pack.cells.h).filter(h => h >= 20).length,
          burgs: window.pack.burgs.length - 1,
          states: window.pack.states.length - 1,
          rivers: window.pack.rivers.length,
          cultures: window.pack.cultures.length - 1,
          religions: window.pack.religions.length - 1,
          biomes: Array.from(window.pack.cells.biome).reduce((acc, b) => {
            acc[b] = (acc[b] ?? 0) + 1;
            return acc;
          }, {}),
          mapCoordinates: window.mapCoordinates
        }
      };
    },
    { bytes: Array.from(bundleBytes), cells }
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
    throw new Error("dist/ is missing — run `npm run build` first");
  }

  let files = fs.readdirSync(args.bundles).filter(f => f.endsWith(".orogen")).sort();
  if (args.only) files = files.filter(f => path.basename(f, ".orogen") === args.only);
  if (!files.length) throw new Error(`no .orogen bundles in ${args.bundles}`);

  fs.mkdirSync(args.out, { recursive: true });

  log(`starting vite preview...`);
  const preview = await startPreview();

  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const results = [];
  try {
    for (const file of files) {
      const name = path.basename(file, ".orogen");
      const bundleBytes = fs.readFileSync(path.join(args.bundles, file));
      const bundleHeader = readHeader(bundleBytes);

      // Size the window to the map's own canvas so the whole map is on screen at
      // 1:1 — FMG only ever renders the part the current zoom fits, and its PNG
      // export inlines web fonts over the network, which an offline run cannot do.
      const context = await browser.newContext({
        viewport: {
          width: Math.min(bundleHeader.fmg.canvasWidth, MAX_VIEWPORT),
          height: Math.min(bundleHeader.fmg.canvasHeight, MAX_VIEWPORT)
        },
        deviceScaleFactor: 1
      });
      const page = await context.newPage();
      const pageErrors = [];
      // Two kinds of console noise are not faults of the map: third-party assets the
      // sandbox blocks, and the generator's own user-facing notices, which it routes
      // through console.error whatever their severity.
      const isNoise = text =>
        /Failed to load resource|net::ERR_|ERR_CERT/.test(text) || /Name is too short|Namebase is not found/.test(text);
      page.on("pageerror", error => pageErrors.push(error.message));
      page.on("console", message => {
        if (message.type() === "error" && !isNoise(message.text())) pageErrors.push(message.text());
      });

      log(`\n${name}:`);
      // pre-seed the version so the "Generator is updated" dialog never opens over the map
      await page.addInitScript(() => {
        try {
          localStorage.setItem("version", "999.0.0");
          localStorage.setItem("disable_click_arrow_tooltip", "true");
        } catch {}
      });
      await page.goto(PREVIEW_URL, { waitUntil: "load" });
      // The app generates a random map on boot. Let that finish before importing,
      // or the two generations race and the SVG ends up showing the other one.
      await page.waitForFunction(() => Boolean(window.mapId && window.Orogen && window.pack?.cells), null, { timeout: 120000 });

      const { header, mapData, elapsed, stats } = await buildMap(page, bundleBytes, args.cells);

      const mapFile = path.join(args.out, `${name}.map`);
      fs.writeFileSync(mapFile, mapData);
      log(`  generated in ${(elapsed / 1000).toFixed(1)}s -> ${path.basename(mapFile)} (${(mapData.length / 1e6).toFixed(1)} MB)`);
      log(`  ${stats.packCells.toLocaleString()} cells, ${stats.landCells.toLocaleString()} land` +
          `, ${stats.burgs} burgs, ${stats.states} states, ${stats.rivers} rivers` +
          `, ${stats.cultures} cultures, ${stats.religions} religions`);
      log(`  box ${stats.mapCoordinates.latN}..${stats.mapCoordinates.latS} lat` +
          `, ${stats.mapCoordinates.lonW}..${stats.mapCoordinates.lonE} lon`);

      if (args.screenshots) {
        await page.evaluate(() => {
          window.closeDialogs?.();
          window.resetZoom?.(0);
        });
        // resetZoom runs through a d3 transition, so the transform is not applied
        // until the next frame — screenshotting straight away catches the old view
        await page.waitForFunction(
          () => {
            const transform = document.getElementById("viewbox")?.getAttribute("transform");
            return !transform || /^translate\(0\s*,?\s*0\)\s*scale\(1\)$/.test(transform.trim());
          },
          null,
          { timeout: 15000 }
        );

        const shot = path.join(args.out, `${name}.png`);
        const box = await page.locator("#map").screenshot({ path: shot });
        log(`  rendered -> ${path.basename(shot)} (${(box.length / 1024).toFixed(0)} KB)`);
      }

      if (pageErrors.length) {
        log(`  page errors:`);
        for (const error of pageErrors.slice(0, 5)) log(`    - ${error}`);
      }

      await context.close();

      if (args.reloadCheck) {
        const reloaded = await checkReload(browser, mapFile, stats);
        const same =
          reloaded.packCells === stats.packCells &&
          reloaded.burgs === stats.burgs &&
          reloaded.states === stats.states &&
          reloaded.rivers === stats.rivers;
        log(
          `  reload ${same ? "ok" : "MISMATCH"}: ${reloaded.packCells.toLocaleString()} cells` +
            `, ${reloaded.burgs} burgs, ${reloaded.states} states, ${reloaded.rivers} rivers`
        );
        if (!same) pageErrors.push("reloaded map does not match what was saved");
      }

      results.push({ name, header, stats, bytes: mapData.length, errors: pageErrors.length });
    }
  } finally {
    await browser.close();
    preview.stop();
  }

  const failed = results.filter(r => r.errors);
  log(`\n${results.length} maps written to ${args.out}`);
  if (failed.length) {
    log(`${failed.length} produced page errors: ${failed.map(r => r.name).join(", ")}`);
    process.exit(1);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
