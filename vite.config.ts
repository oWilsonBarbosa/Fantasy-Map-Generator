import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

/**
 * `#defElements` is a sprite sheet — relief symbols, fill patterns, markers — rather than UI, so it
 * lives in its own file. It is inlined rather than linked because SVG `url(#id)` and `<use href="#id">`
 * only resolve within one document, and every consumer reads it synchronously at boot.
 *
 * The standalone file declares an xmlns so it opens on its own; inline in HTML that namespace is
 * implied, so it is dropped to emit exactly the markup index.html used to carry.
 */
const inlineDefElements = {
  name: "inline-def-elements",
  transformIndexHtml(html: string) {
    const svg = readFileSync(fileURLToPath(new URL("./src/def-elements.svg", import.meta.url)), "utf8")
      .replace(' xmlns="http://www.w3.org/2000/svg"', "")
      .trimEnd();
    const marker = /^[ \t]*<!-- reusable svg elements[^>]*-->/m;
    if (!marker.test(html)) throw new Error("inline-def-elements: index.html is missing the def-elements.svg marker");
    return html.replace(marker, () => svg);
  }
};

/**
 * The desktop app ships the same renderer, minus the parts that only make sense on the web:
 * Google Analytics (a program that phones home on launch is a different bargain than a web page),
 * and the PWA plumbing, which `public/main.js` already skips under Electron
 */
const stripWebOnlyTags = {
  name: "strip-web-only-tags",
  transformIndexHtml: (html: string) =>
    html
      .replace(/<script async src="https:\/\/www\.googletagmanager\.com[^>]*><\/script>\s*/, "")
      .replace(/<script>\s*window\.dataLayer[\s\S]*?<\/script>\s*/, "")
      .replace(/<link rel="manifest"[^>]*>\s*/, "")
};

export default ({ mode }: { mode: string }) => ({
  root: "./src",
  base: mode === "electron" ? "./" : process.env.NETLIFY ? "/" : "/Fantasy-Map-Generator/",
  plugins: [inlineDefElements, ...(mode === "electron" ? [stripWebOnlyTags] : [])],
  build: {
    outDir: mode === "electron" ? "../dist-electron/renderer" : "../dist",
    assetsDir: "./",
    emptyOutDir: mode === "electron"
  },
  publicDir: "../public",
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url))
    }
  }
});
