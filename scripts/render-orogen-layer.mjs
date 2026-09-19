// Render a layer view of maps that already exist, without regenerating them.
//
//   npm run build
//   node scripts/render-orogen-layer.mjs --maps ../0r063N/data/fmg/t2/maps --layer wetlands
//   node scripts/render-orogen-layer.mjs --maps ../0r063N/data/fmg/maps --layer biomes --only meridia
//
// build-orogen-maps.mjs saves with the `physical` preset, which leaves the
// biomes layer empty — so a biome question cannot be answered from the .png
// beside a .map, and regenerating would roll a different seed and answer it
// about a different world. This loads the saved .map through the app's own
// upload path instead, so what comes out is the map that is actually committed.
//
// CHROMIUM_PATH overrides the browser, matching playwright.config.ts.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_VIEWPORT = 2600;
const log = (...a) => console.log(...a);

const WETLAND = 12;
// Deep marsh green against a flat warm grey. Not a blue: the rivers are blue and
// the whole point of the view is telling a wetland apart from the channel it sits on.
const WETLAND_COLOR = "#1a5c33";
const QUIET_LAND = "#e7e2d8";
// Everything in the body that is not the map itself is app furniture — the load
// toast, the options trigger, the help button — and has no business in a plate.
// Hiding by structure rather than by id so a new control cannot quietly reappear.
const KEEP_VISIBLE = "map";

/**
 * Layer views. `preset` is an FMG layer preset; `recolour` greys every biome but
 * wetland down before the layer is drawn.
 *
 * Greying rather than hiding is the point: the rivers and lakes layers stay on,
 * so a wetland is visible against the drainage it sits on. That is the thing
 * worth looking at — on these maps a wetland can only be river-made, because
 * rainfall alone never reaches the moisture threshold.
 */
const VIEWS = {
  biomes: { preset: "biomes", recolour: false },
  wetlands: { preset: "biomes", recolour: true }
};

function parseArgs(argv) {
  const args = {
    maps: path.join(ROOT, "..", "0r063N", "data", "fmg", "t2", "maps"),
    out: null,
    layer: "wetlands",
    only: null,
    port: 4173
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--maps") args.maps = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
    else if (argv[i] === "--layer") args.layer = argv[++i];
    else if (argv[i] === "--only") args.only = argv[++i].split(",").map(s => s.trim());
    else if (argv[i] === "--port") args.port = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!VIEWS[args.layer]) throw new Error(`--layer must be one of ${Object.keys(VIEWS).join(", ")}`);
  args.out ??= path.join(args.maps, args.layer);
  return args;
}

async function startPreview(port) {
  const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], {
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
      server.kill("SIGKILL");
    }
  };
  process.on("exit", stop);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("vite preview did not start within 60s")), 60000);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    server.stdout.on("data", chunk => String(chunk).includes("Local:") && done());
    server.stderr.on("data", chunk => {
      const text = String(chunk);
      if (/EADDRINUSE|error/i.test(text)) {
        clearTimeout(timer);
        reject(new Error(`vite preview failed: ${text.trim()}`));
      }
    });
    server.on("exit", code => {
      clearTimeout(timer);
      reject(new Error(`vite preview exited with code ${code}`));
    });
  });
  return { stop };
}

/** canvas size and the wetland cell count, read straight out of the .map */
function readMapInfo(file) {
  const fields = fs.readFileSync(file, "utf8").split("\r\n");
  const params = fields[0].split("|");
  const biomes = fields[16].split(",");
  let land = 0;
  let wetland = 0;
  for (const value of biomes) {
    const biome = Number(value);
    if (!biome) continue;
    land++;
    if (biome === WETLAND) wetland++;
  }
  return { width: Number(params[4]), height: Number(params[5]), land, wetland };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(path.join(ROOT, "dist", "index.html"))) {
    throw new Error("dist/ is missing — run `npm run build` first");
  }

  let files = fs
    .readdirSync(args.maps)
    .filter(f => f.endsWith(".map"))
    .map(f => path.basename(f, ".map"))
    .sort();
  if (args.only) files = files.filter(name => args.only.includes(name));
  if (!files.length) throw new Error(`no .map files to render in ${args.maps}`);

  fs.mkdirSync(args.out, { recursive: true });
  const view = VIEWS[args.layer];

  log(`starting vite preview on ${args.port}...`);
  const preview = await startPreview(args.port);
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  const failures = [];
  try {
    for (const name of files) {
      const mapFile = path.join(args.maps, `${name}.map`);
      const info = readMapInfo(mapFile);
      const context = await browser.newContext({
        viewport: { width: Math.min(info.width, MAX_VIEWPORT), height: Math.min(info.height, MAX_VIEWPORT) },
        deviceScaleFactor: 1
      });
      const page = await context.newPage();

      try {
        // applyLayersPreset reads the preset name out of localStorage, and the
        // version pre-seed keeps the "Generator is updated" dialog off the map
        await page.addInitScript(preset => {
          try {
            localStorage.setItem("version", "999.0.0");
            localStorage.setItem("disable_click_arrow_tooltip", "true");
            localStorage.setItem("preset", preset);
          } catch {}
        }, view.preset);

        await page.goto(`http://localhost:${args.port}`, { waitUntil: "load" });
        // the app generates a random map on boot; let it finish or the load races it
        await page.waitForFunction(() => Boolean(window.mapId && window.pack?.cells), null, { timeout: 120000 });
        const bootMapId = await page.evaluate(() => window.mapId);

        // the app's own upload path, so the map is parsed exactly as a user's would be
        await page.setInputFiles("#mapToLoad", mapFile);
        await page.waitForFunction(id => window.mapId && window.mapId !== id, bootMapId, { timeout: 180000 });

        const drawn = await page.evaluate(
          ({ recolour, wetland, wetColor, quiet, keep }) => {
            if (recolour) {
              for (let index = 1; index < window.pack.biomes.length; index++) {
                window.pack.biomes[index].color = index === wetland ? wetColor : quiet;
              }
            }
            window.applyLayersPreset();
            window.Layers.drawAll();
            window.closeDialogs?.();
            window.resetZoom?.(0);
            for (const element of document.body.children) {
              if (element.id !== keep) element.style.display = "none";
            }
            let count = 0;
            for (const biome of window.pack.cells.biome) if (biome === wetland) count++;
            return { wetland: count, cells: window.pack.cells.i.length };
          },
          { recolour: view.recolour, wetland: WETLAND, wetColor: WETLAND_COLOR, quiet: QUIET_LAND, keep: KEEP_VISIBLE }
        );

        await page.waitForFunction(
          () => {
            const transform = document.getElementById("viewbox")?.getAttribute("transform");
            return !transform || /^translate\(0\s*,?\s*0\)\s*scale\(1\)$/.test(transform.trim());
          },
          null,
          { timeout: 15000 }
        );

        const shot = path.join(args.out, `${name}-${args.layer}.png`);
        const bytes = await page.locator("#map").screenshot({ path: shot });
        const share = info.land ? ((drawn.wetland / info.land) * 100).toFixed(2) : "0.00";
        log(
          `  ${name.padEnd(20)} ${drawn.wetland.toLocaleString().padStart(6)} wetland cells` +
            ` of ${info.land.toLocaleString().padStart(7)} land (${share}%)` +
            ` -> ${path.basename(shot)} (${(bytes.length / 1024).toFixed(0)} KB)`
        );
        if (drawn.wetland !== info.wetland) {
          throw new Error(`loaded map has ${drawn.wetland} wetland cells, the file says ${info.wetland}`);
        }
      } catch (error) {
        log(`  ${name}: FAILED — ${error.message}`);
        failures.push(name);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    preview.stop();
  }

  log(`\n${files.length - failures.length} of ${files.length} rendered to ${args.out}`);
  if (failures.length) {
    log(`failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
