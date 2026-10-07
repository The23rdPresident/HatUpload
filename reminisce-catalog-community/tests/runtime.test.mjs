import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { upstream } from "./support.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import "../shared/core.js";

test("Cloudflare D1 returns batch decline feedback only for matching private receipts", async t => {
  const bundled = await build({ stdin: { contents: `import { submissionStatuses } from "./server/submissions.js";
export default { async fetch(request, env) { return Response.json(await submissionStatuses(request, env)); } };`, resolveDir: new URL("../", import.meta.url).pathname }, bundle: true, write: false, format: "esm", platform: "browser", external: ["node:crypto"] });
  const mf = new Miniflare(convertV4MiniflareOptions({ name: "catalog-feedback-runtime", modules: true, script: bundled.outputFiles[0].text, compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: "runtime-feedback-db" } }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const name of ["0001_catalog.sql", "0002_existing_catalog.sql", "0004_auto_publish.sql", "0005_webhook_delivery.sql", "0006_decline_feedback.sql"]) await db.exec((await readFile(new URL("../migrations/" + name, import.meta.url), "utf8")).replaceAll("\n", " "));
  const id = crypto.randomUUID(), deniedId = crypto.randomUUID(), receiptKey = "A".repeat(43), privateNote = "Owner-only runtime note";
  for (const [key, hashKey] of [[id, receiptKey], [deniedId, "B".repeat(43)]]) {
    await db.prepare("INSERT INTO submissions(id,kind,username,status,draft_json,base_json,owner_note,decline_note,receipt_hash,created_at,updated_at) VALUES(?1,'official','Community','declined',?2,'{}',?3,'Please revise the texture.',?4,1,1)").bind(key, JSON.stringify({ name: "Runtime feedback" }), privateNote, createHash("sha256").update(hashKey).digest("hex")).run();
  }
  const response = await mf.dispatchFetch("https://catalog.test/api/status/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ receipts: [{ id, receiptKey }, { id: deniedId, receiptKey }] }) });
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  assert.equal(data.items[0].declineNote, "Please revise the texture.");
  assert.deepEqual(data.items[1], { id: deniedId, status: "Unavailable" });
  assert.doesNotMatch(JSON.stringify(data), /Owner-only runtime note|receipt_hash|receiptKey/);
});

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
    if (url.pathname === "/headless") return Response.json(await officialAsset(15093053680));
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
    ["/search?q=Headless%20Head&category=heads", data => assert.equal(data.exactMatchId, 15093053680)],
    ["/texture", data => { assert.equal(data.id, 200); assert.equal(data.sourceId, 201); }],
    ["/verify", data => assert.equal(data.verified, true)],
    ["/headless", data => { assert.equal(data.id, 15093053680); assert.equal(data.assetType, 79); assert.equal(data.creatorId, 1); assert.match(data.thumbnail, /rbxcdn\.com/); }]
  ]) {
    const response = await mf.dispatchFetch("https://catalog.test" + path, { headers: { Origin: "https://catalog.test" } });
    const data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    check(data);
  }
  assert.ok(stub.calls.some(call => call.url.includes("siteverify")));
});

test("the actual Cloudflare runtime publishes and announces a Head without an online game server", async t => {
  const bundled = await build({ stdin: { contents: `import { publishOne } from "./server/publishing.js";
export default { async fetch(request, env) { await publishOne(env, "runtime-item"); return Response.json(await env.DB.prepare("SELECT status,notification,error FROM publish_jobs WHERE submission_id='runtime-item'").first()); } };`, resolveDir: new URL("../", import.meta.url).pathname }, bundle: true, write: false, format: "esm", platform: "browser", external: ["node:crypto"] });
  let catalog = null, writes = 0, messages = 0, webhooks = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "catalog-publishing-runtime", modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
    bindings: { ROBLOX_API_KEY: "runtime-fixture-private-key", ROBLOX_UNIVERSE_ID: "123456", ROBLOX_AUTO_PUBLISH: "true", NEW_ITEM_WEBHOOK_URL: "https://discord.com/api/webhooks/1548840892628996198/runtime-private-webhook-token-fixture" },
    d1Databases: { DB: "runtime-publishing-db" },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === "discord.com") {
        assert.equal(request.headers.get("x-api-key"), null);
        assert.equal(url.searchParams.get("wait"), "true");
        const payload = await request.json();
        assert.equal(payload.embeds[0].title, "Runtime Headless");
        assert.deepEqual(payload.allowed_mentions, { parse: [] });
        webhooks++;
        return Response.json({ id: "1548840892628996199" });
      }
      assert.equal(url.hostname, "apis.roblox.com");
      assert.equal(request.headers.get("x-api-key"), "runtime-fixture-private-key");
      if (url.pathname.endsWith(":publishMessage")) {
        messages++;
        const data = await request.json();
        assert.equal(JSON.parse(data.message).v, 1);
        return new Response(null, { status: 200 });
      }
      const key = url.searchParams.get("entryKey");
      if (key === "uploader-ready") return Response.json({ application: "ReminisceItemUploader", schema: 1, announcements: "worker", types: { Hat: true, Head: true }, items: [] }, { headers: { "roblox-entry-version": "ready-1" } });
      assert.equal(key, "catalog");
      if (request.method === "GET") return new Response(null, { status: 404 });
      assert.equal(url.searchParams.get("exclusiveCreate"), "true");
      const payload = await request.text();
      assert.equal(request.headers.get("content-md5"), createHash("md5").update(payload).digest("base64"));
      catalog = JSON.parse(payload);
      writes++;
      return Response.json({ version: "revision-1" });
    }
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await db.exec("CREATE TABLE submissions(id TEXT PRIMARY KEY,status TEXT,version INTEGER);");
  const schema = await readFile(new URL("../migrations/0004_auto_publish.sql", import.meta.url), "utf8");
  await db.exec(schema.replaceAll("\n", " "));
  await db.exec((await readFile(new URL("../migrations/0005_webhook_delivery.sql", import.meta.url), "utf8")).replaceAll("\n", " "));
  await db.prepare("INSERT INTO submissions(id,status,version) VALUES('runtime-item','approved',2)").run();
  const draft = { ...globalThis.CatalogCore.defaults(), name: "Runtime Headless", assetId: "15093053680", itemType: "Head", price: "500", catalogType: "limited-u", stock: "25", endMode: "duration", duration: "1", durationUnit: "hours" };
  await db.prepare("INSERT INTO publish_jobs(submission_id,job_id,record_version,universe_id,draft_json,base_json,next_attempt,created_at,updated_at,announcement_source) VALUES('runtime-item','runtime-job',2,'123456',?1,?2,0,0,0,'worker')").bind(JSON.stringify(draft), JSON.stringify({ id: 15093053680, kind: "Asset", assetType: 79, creatorType: "User", creatorId: 1 })).run();
  const response = await mf.dispatchFetch("https://catalog.test/runtime");
  assert.equal(response.status, 200);
  const job = await response.json();
  assert.equal(job.status, "published", job.error);
  assert.equal(job.notification, "sent");
  assert.equal(writes, 1);
  assert.equal(messages, 1);
  assert.equal(webhooks, 1);
  assert.equal((await db.prepare("SELECT status FROM publish_webhooks WHERE submission_id='runtime-item'").first()).status, "sent");
  await mf.dispatchFetch("https://catalog.test/runtime");
  assert.equal(webhooks, 1);
  assert.equal(catalog.items["Runtime Headless"].ItemType, "Head");
  assert.equal(catalog.items["Runtime Headless"].Headless, true);
  assert.equal(catalog.items["Runtime Headless"].PublisherAnnouncement, "worker");
  assert.equal(catalog.items["Runtime Headless"].Stock, 25);
  assert.equal(catalog.items["Runtime Headless"].OffsaleAt - catalog.items["Runtime Headless"].OnsaleAt, 3600);
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

test("Cloudflare connection diagnostics inspect only the installed key and identify rejected catalog reads", async t => {
  const bundled = await build({ stdin: { contents: `import { testConnection } from "./server/publishing.js";
export default { async fetch(request, env) { return Response.json(await testConnection(env)); } };`, resolveDir: new URL("../", import.meta.url).pathname }, bundle: true, write: false, format: "esm", platform: "browser", external: ["node:crypto"] });
  let rejected = 0, catalogWrites = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "catalog-key-runtime", modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
    bindings: { ROBLOX_API_KEY: " \nruntime-fixture-private-key\n", ROBLOX_UNIVERSE_ID: "123456", ROBLOX_AUTO_PUBLISH: "true" },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === "games.roblox.com") {
        assert.equal(request.headers.get("x-api-key"), null);
        return Response.json({ data: [{ id: 123456, name: "Runtime Reminisce", rootPlaceId: 18826098361 }] });
      }
      assert.equal(url.hostname, "apis.roblox.com");
      if (url.pathname === "/api-keys/v1/introspect") {
        assert.equal((await request.json()).apiKey, "runtime-fixture-private-key");
        if (rejected === 401) return new Response(null, { status: 401 });
        return Response.json({ enabled: true, expired: false, scopes: [
          { name: "universe-datastores.objects", operations: ["read", "create", "update"], universeDatastores: [{ universeId: "123456", datastoreName: "ReminisceLiveCatalog_v1" }] },
          { name: "universe-messaging-service", operations: ["publish"], universeIds: ["123456"] }
        ] });
      }
      assert.equal(request.headers.get("x-api-key"), "runtime-fixture-private-key");
      if (request.method !== "GET") catalogWrites++;
      if (rejected) return new Response("private upstream details", { status: rejected });
      if (url.searchParams.get("entryKey") === "uploader-ready") return Response.json({ application: "ReminisceItemUploader", schema: 1, types: { Hat: true }, items: [], placeId: 18826098361 }, { headers: { "roblox-entry-version": "ready-1" } });
      return new Response(null, { status: 404 });
    }
  }));
  t.after(() => mf.dispose());
  let report = await (await mf.dispatchFetch("https://catalog.test/check")).json();
  assert.equal(report.connected, true);
  assert.equal(report.key.status, "active");
  assert.equal(report.key.permissions.update, true);
  for (const status of [401, 403]) {
    rejected = status;
    report = await (await mf.dispatchFetch("https://catalog.test/check")).json();
    assert.equal(report.connected, false);
    assert.equal(report.experience.name, "Runtime Reminisce");
    assert.equal(report.diagnostic.httpStatus, status);
    assert.match(report.error, /reading "uploader-ready"/);
    assert.doesNotMatch(JSON.stringify(report), /runtime-fixture-private-key|private upstream details/);
  }
  assert.equal(catalogWrites, 0);
});

test("Cloudflare D1 atomically declines a duplicate Head and preserves its duplicate block", async t => {
  const bundled = await build({ stdin: { contents: `import { publishOne, itemRow, publication } from "./server/publishing.js";
export default { async fetch(request, env) { await publishOne(env, "runtime-duplicate"); const row = await itemRow(env, "runtime-duplicate"); return Response.json({ status: row.status, version: row.version, declineNote: row.decline_note, publication: publication(row) }); } };`, resolveDir: new URL("../", import.meta.url).pathname }, bundle: true, write: false, format: "esm", platform: "browser", external: ["node:crypto"] });
  let writes = 0;
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "catalog-decline-runtime", modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-10-07", compatibilityFlags: ["nodejs_compat"],
    bindings: { ROBLOX_API_KEY: "runtime-fixture-private-key", ROBLOX_UNIVERSE_ID: "123456", ROBLOX_AUTO_PUBLISH: "true" },
    d1Databases: { DB: "runtime-decline-db" },
    outboundService: async request => {
      const url = new URL(request.url);
      if (request.method !== "GET") { writes++; return new Response(null, { status: 503 }); }
      if (url.searchParams.get("entryKey") === "uploader-ready") return Response.json({ application: "ReminisceItemUploader", schema: 1, types: { Head: true }, items: [{ Name: "Existing Head", AssetId: 205, ItemType: "Head" }] }, { headers: { "roblox-entry-version": "ready-1" } });
      return new Response(null, { status: 404 });
    }
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  for (const name of ["0001_catalog.sql", "0002_existing_catalog.sql", "0004_auto_publish.sql", "0005_webhook_delivery.sql", "0006_decline_feedback.sql"]) await db.exec((await readFile(new URL("../migrations/" + name, import.meta.url), "utf8")).replaceAll("\n", " "));
  const draft = { ...globalThis.CatalogCore.defaults(), name: "Duplicate dynamic head", assetId: "205", itemType: "Head", price: "500" };
  const base = { id: 205, kind: "Asset", assetType: 79, creatorType: "User", creatorId: 1 };
  await db.prepare("INSERT INTO submissions(id,kind,username,status,draft_json,base_json,version,registry_json,created_at,updated_at) VALUES('runtime-duplicate','official','Community','approved',?1,?2,2,?3,1,1)").bind(JSON.stringify(draft), JSON.stringify(base), JSON.stringify(globalThis.CatalogCore.registryKeys(draft))).run();
  await db.prepare("INSERT INTO publish_jobs(submission_id,job_id,record_version,universe_id,draft_json,base_json,next_attempt,created_at,updated_at) VALUES('runtime-duplicate','runtime-duplicate-job',2,'123456',?1,?2,0,1,1)").bind(JSON.stringify(draft), JSON.stringify(base)).run();
  const response = await mf.dispatchFetch("https://catalog.test/runtime");
  assert.equal(response.status, 200, await response.clone().text());
  const record = await response.json();
  assert.equal(record.status, "declined");
  assert.equal(record.version, 3);
  assert.equal(record.publication.autoDeclined, true);
  assert.equal(record.publication.retryable, false);
  assert.match(record.publication.error, /already exists/);
  assert.equal(record.declineNote, record.publication.error);
  assert.equal(record.publication.nextAttempt, null);
  assert.equal((await db.prepare("SELECT source FROM catalog_items WHERE id='runtime-duplicate'").first()).source, "existing");
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM catalog_keys WHERE key='asset:205'").first()).n, 1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM review_log WHERE action='auto-decline'").first()).n, 1);
  await mf.dispatchFetch("https://catalog.test/runtime");
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM review_log WHERE action='auto-decline'").first()).n, 1);
  assert.equal(writes, 0);
});
