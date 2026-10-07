import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { upstream } from "./support.mjs";
import { readFile } from "node:fs/promises";

test("Roblox metadata, thumbnails, decal resolution, and verification work in the Cloudflare runtime", async t => {
  const bundled = await build({
    stdin: {
      contents: `import { search, officialAsset, textureAsset } from "./server/catalog.js";
import { challenge } from "./server/security.js";
export default { async fetch(request, env) {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/search") return Response.json(await search(url));
    if (url.pathname === "/texture") return Response.json(await textureAsset(201));
    if (url.pathname === "/verify") { await challenge(request, env, "login-ok", "owner-login"); return Response.json({ verified: true }); }
    return Response.json(await officialAsset(100));
  } catch (error) { return Response.json({ error: error.message }, { status: error.status || 500 }); }
} };`,
      resolveDir: new URL("../", import.meta.url).pathname
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    external: ["node:crypto"]
  });
  const stub = upstream();
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "catalog-runtime",
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-10-07",
    compatibilityFlags: ["nodejs_compat"],
    bindings: { TURNSTILE_SECRET: "production-fixture", PUBLIC_ORIGINS: "" },
    outboundService: async request => stub.fetch(request.url, {
      method: request.method,
      body: request.method === "POST" ? await request.text() : undefined,
      headers: request.headers
    })
  }));
  t.after(() => mf.dispose());
  for (const [path, check] of [
    ["/asset", data => { assert.equal(data.name, "Classic Hat"); assert.match(data.thumbnail, /rbxcdn\.com/); }],
    ["/search?q=Classic%20Hat", data => assert.equal(data.exactMatchId, 100)],
    ["/texture", data => { assert.equal(data.id, 200); assert.equal(data.sourceId, 201); }],
    ["/verify", data => assert.equal(data.verified, true)]
  ]) {
    const response = await mf.dispatchFetch("https://catalog.test" + path, { headers: { Origin: "https://catalog.test" } });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    check(data);
  }
  assert.ok(stub.calls.some(call => call.url.includes("siteverify")));
});

test("owner documents and relative assets are served correctly in the Cloudflare runtime", async t => {
  const bundled = await build({
    entryPoints: [new URL("../server/worker.js", import.meta.url).pathname],
    bundle: true, write: false, format: "esm", platform: "browser", external: ["node:crypto"]
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "catalog-assets",
    modules: true,
    script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-10-07",
    compatibilityFlags: ["nodejs_compat"],
    serviceBindings: {
      ASSETS: async request => {
        const path = new URL(request.url).pathname;
        const html = path.endsWith(".html");
        const bytes = await readFile(new URL("../docs" + path, import.meta.url));
        return new Response(bytes, { headers: { "Content-Type": html ? "text/html" : path.endsWith(".png") ? "image/png" : "application/javascript" } });
      }
    }
  }));
  t.after(() => mf.dispose());
  for (const path of ["/", "/index.html", "/review.html", "/review"]) {
    const response = await mf.dispatchFetch("https://catalog.test" + path, { redirect: "manual" });
    assert.equal(response.status, 200, path + " " + (response.status === 200 ? "" : await response.clone().text()));
    assert.match(await response.text(), /<!doctype html>/);
    assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  }
  const slash = await mf.dispatchFetch("https://catalog.test/review/", { redirect: "manual" });
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get("Location"), "/review.html");
  const hidden = await mf.dispatchFetch("https://catalog.test/server/security.js");
  assert.equal(hidden.status, 404);
  const script = await mf.dispatchFetch("https://catalog.test/assets/review.min.js");
  assert.equal(script.status, 200);
  const icon = await mf.dispatchFetch("https://catalog.test/favicon.png");
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("Content-Type"), "image/png");
  assert.deepEqual(new Uint8Array(await icon.arrayBuffer()), new Uint8Array(await readFile(new URL("../src/favicon.png", import.meta.url))));
  const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  assert.equal(config.assets.html_handling, "none");
});
