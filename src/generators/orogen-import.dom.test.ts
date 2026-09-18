// Browser-mode test (vitest.browser.config.ts): applyOptions writes to real option
// inputs, which the node environment's document stub cannot stand in for.
import { beforeEach, expect, test } from "vitest";
import "./orogen-import";

const MAGIC = "OROGFMG1";

const header = {
  format: "orogen-fmg/1",
  planet: "06cy8w6z6a89kow6psje93",
  seed: 10673275,
  crop: "meridia",
  label: "Meridia",
  width: 2,
  height: 2,
  box: { latN: 71.6758, latS: -18.2383, lonW: -159.5623, lonE: -60.6916 },
  fmg: {
    canvasWidth: 1424,
    canvasHeight: 1295,
    heightExponent: 2.03,
    mapSize: 49.9523,
    latitude: 20.3408,
    longitude: 92.1734
  },
  planes: [
    { name: "height", type: "u8" },
    { name: "temp", type: "i8" },
    { name: "prec", type: "u8" },
    { name: "biome", type: "u8" },
    { name: "koppen", type: "u8" }
  ]
};

async function makeBundle() {
  const payload = new Uint8Array(header.width * header.height * header.planes.length);
  const headerJson = new TextEncoder().encode(JSON.stringify(header));
  const gzip = new Blob([payload]).stream().pipeThrough(new CompressionStream("gzip"));
  const compressed = new Uint8Array(await new Response(gzip).arrayBuffer());

  const bundle = new Uint8Array(MAGIC.length + 4 + headerJson.length + compressed.length);
  bundle.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(bundle.buffer).setUint32(MAGIC.length, headerJson.length, true);
  bundle.set(headerJson, MAGIC.length + 4);
  bundle.set(compressed, MAGIC.length + 4 + headerJson.length);
  return bundle.buffer;
}

beforeEach(() => {
  document.body.innerHTML = /* html */ `
    <input id="mapWidthInput" value="960" />
    <input id="mapHeightInput" value="540" />
    <input id="heightExponentInput" value="2" />`;
  globalThis.options = { mapSize: 0, latitude: 0, longitude: 0 } as never;
  window.Orogen.clear();
});

test("applyOptions puts the map where the bundle's header says", async () => {
  await window.Orogen.load(await makeBundle());
  window.Orogen.applyOptions();

  // the canvas matters as much as the three percentages: FMG derives the longitude
  // span from the canvas aspect, so a default canvas would silently narrow the map
  expect((document.getElementById("mapWidthInput") as HTMLInputElement).value).toBe("1424");
  expect((document.getElementById("mapHeightInput") as HTMLInputElement).value).toBe("1295");
  expect((document.getElementById("heightExponentInput") as HTMLInputElement).value).toBe("2.03");
  expect(options.mapSize).toBe(49.9523);
  expect(options.latitude).toBe(20.3408);
  expect(options.longitude).toBe(92.1734);
});

test("the applied placement reproduces the bundle's lat/lon box", async () => {
  await window.Orogen.load(await makeBundle());
  window.Orogen.applyOptions();

  // mirror of Coordinates.calculate()
  const latT = (options.mapSize / 100) * 180;
  const latN = 90 - (180 - latT) * (options.latitude / 100);
  const lonT = Math.min((header.fmg.canvasWidth / header.fmg.canvasHeight) * latT, 360);
  const lonE = 180 - (360 - lonT) * (options.longitude / 100);

  expect(latN).toBeCloseTo(header.box.latN, 1);
  expect(latN - latT).toBeCloseTo(header.box.latS, 1);
  expect(lonE).toBeCloseTo(header.box.lonE, 0);
  expect(lonE - lonT).toBeCloseTo(header.box.lonW, 0);
});
