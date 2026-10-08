import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import worker from "../server/worker.js";
import { publishOne, testConnection, publishingConfig } from "../server/publishing.js";
import { environment, upstream, ownerKey } from "./support.mjs";
import { now } from "../server/security.js";
import { sendAnnouncement, drainAnnouncements } from "../server/announcements.js";

const core = globalThis.CatalogCore;
const clone = value => JSON.parse(JSON.stringify(value));
const draft = changes => ({ ...core.defaults(), name: "Classic Hat", assetId: "100", accessoryKind: "Hat", price: "500", ...changes });
const webhookFixture = "https://discord.com/api/webhooks/1548840892628996198/" + "test-only-private-webhook-token".repeat(2);

function harness(t) {
  const env = { ...environment(), ROBLOX_API_KEY: "test-only-open-cloud-secret".repeat(3), ROBLOX_UNIVERSE_ID: "123456", ROBLOX_AUTO_PUBLISH: "true" };
  const stub = upstream(), original = globalThis.fetch, clock = Date.now;
  const receipts = new Map();
  const state = { ready: { application: "ReminisceItemUploader", schema: 1, announcements: "worker", items: [], types: { Hat: true, Hair: true, Head: true, Tool: true, Face: true, BodyPackage: true } }, catalog: null, revision: 0, calls: [], reads: 0, writes: 0, notifications: 0, fail: 0, notifyFail: false, writeHook: null, attributes: '{"untouched":true}', userIds: "[123]" };
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    if (["discord.com", "webhook.lewisakura.moe"].includes(url.hostname)) {
      assert.equal(options.headers["x-api-key"], undefined);
      assert.equal(options.redirect, "manual");
      assert.equal(url.searchParams.get("wait"), "true");
      state.webhookCalls ||= [];
      const payload = JSON.parse(options.body);
      state.webhookCalls.push({ payload, url });
      if (state.webhookHook) return state.webhookHook(payload);
      return Response.json({ id: "1548840892628996199" });
    }
    if (url.pathname === "/api-keys/v1/introspect") {
      assert.equal(url.hostname, "apis.roblox.com");
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "manual");
      assert.equal(JSON.parse(options.body).apiKey, env.ROBLOX_API_KEY.trim());
      if (state.keyCheckFail) return new Response("private key inspection details", { status: 503 });
      return Response.json(state.keyInspection || { enabled: true, expired: false, scopes: [
        { name: "universe-datastores.objects", operations: ["read", "create", "update"], universeDatastores: [{ universeId: "123456", datastoreName: "ReminisceLiveCatalog_v1" }] },
        { name: "universe-messaging-service", operations: ["publish"], universeIds: ["123456"] }
      ] });
    }
    if (url.hostname === "games.roblox.com") {
      assert.equal(options.headers?.["x-api-key"], undefined);
      assert.equal(options.redirect, "manual");
      if (state.metadataFail) return new Response(null, { status: 503 });
      return Response.json({ data: [{ id: state.metadataWrongId ? 999 : 123456, name: "Reminisce <test>", rootPlaceId: 18826098361, creator: { name: "2Reimagine" } }] });
    }
    if (url.hostname !== "apis.roblox.com") return stub.fetch(input, options);
    state.calls.push({ url, options });
    assert.equal(options.headers["x-api-key"], env.ROBLOX_API_KEY.trim());
    assert.equal(options.redirect, "manual");
    if (state.fail) return new Response("private upstream details " + env.ROBLOX_API_KEY, { status: state.fail });
    if (url.pathname.endsWith(":publishMessage")) {
      assert.equal(options.method, "POST");
      const message = JSON.parse(options.body);
      assert.equal(message.topic, "ReminisceLiveCatalog");
      assert.ok(Number.isSafeInteger(JSON.parse(message.message).v));
      state.notifications++;
      return new Response(null, { status: state.notifyFail ? 403 : 200 });
    }
    assert.equal(url.searchParams.get("datastoreName"), "ReminisceLiveCatalog_v1");
    assert.equal(url.searchParams.get("scope"), "global");
    assert.match(url.pathname, /universes\/123456\//);
    const key = url.searchParams.get("entryKey");
    if (!options.method) {
      await state.readHook?.();
      state.reads++;
      const value = key === "uploader-ready" ? state.ready : state.catalog;
      if (value === null) return new Response(null, { status: 404 });
      return Response.json(value, { headers: { "roblox-entry-version": key === "uploader-ready" ? "ready-1" : "revision-" + state.revision, "roblox-entry-attributes": state.attributes, "roblox-entry-userids": state.userIds } });
    }
    assert.equal(key, "catalog");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Content-MD5"], createHash("md5").update(options.body).digest("base64"));
    if (state.catalog !== null) {
      assert.equal(options.headers["roblox-entry-attributes"], state.attributes);
      assert.equal(options.headers["roblox-entry-userids"], state.userIds);
    }
    const injected = await state.writeHook?.(url, options);
    if (injected) return injected;
    if (state.catalog === null) assert.equal(url.searchParams.get("exclusiveCreate"), "true");
    else if (url.searchParams.get("matchVersion") !== "revision-" + state.revision) return new Response(null, { status: 409 });
    state.catalog = JSON.parse(options.body);
    state.revision++;
    state.writes++;
    if (state.ambiguous) { state.ambiguous = false; throw new Error("connection lost after commit"); }
    return Response.json({ version: "revision-" + state.revision });
  };
  t.after(() => { globalThis.fetch = original; Date.now = clock; env.DB.sqlite.close(); });
  return {
    env, state, stub, receipts,
    async request(path, data, session, ctx, origin = "https://catalog.test") {
      const response = await worker.fetch(new Request("https://catalog.test" + path, { method: data ? "POST" : "GET", headers: { Origin: origin, "CF-Connecting-IP": "192.0.2.10", ...(data ? { "Content-Type": "application/json" } : {}), ...(session ? { Authorization: "Bearer " + session } : {}) }, body: data ? JSON.stringify(data) : undefined }), env, ctx);
      return { response, data: await response.json() };
    },
    async login() {
      const result = await this.request("/api/admin/login", { key: ownerKey, turnstileToken: "login-ok" });
      assert.equal(result.response.status, 200);
      return result.data.token;
    },
    async submit(changes = {}, kind = "official") {
      const receiptKey = crypto.randomUUID().replaceAll("-", "").padEnd(43, "A");
      const result = await this.request("/api/submissions", { kind, draft: draft(changes), turnstileToken: "submit-ok", receiptKey });
      assert.equal(result.response.status, 200, JSON.stringify(result.data));
      receipts.set(result.data.id, receiptKey);
      return result.data.id;
    },
    async approve(id, session, ctx, action = "approve", version = 1) {
      const response = await worker.fetch(new Request("https://catalog.test/api/admin/submissions/" + id, { method: "PATCH", headers: { Origin: "https://catalog.test", "CF-Connecting-IP": "192.0.2.10", "Content-Type": "application/json", Authorization: "Bearer " + session }, body: JSON.stringify({ action, version }) }), env, ctx);
      return { response, data: await response.json() };
    },
    job(id) { return env.DB.sqlite.prepare("SELECT * FROM publish_jobs WHERE submission_id=?").get(id); },
    webhook(id) { return env.DB.sqlite.prepare("SELECT * FROM publish_webhooks WHERE submission_id=?").get(id); },
    async retry(id, session) { return this.request("/api/admin/publish/" + id, { version: 2 }, session); }
  };
}

test("approval queues an immutable item atomically and delivers through the worker background task", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ catalogType: "limited-u", stock: "25", endMode: "duration", duration: "2", durationUnit: "hours", accessoryKind: "LeftShoulder" });
  const work = [], result = await h.approve(id, session, { waitUntil: promise => work.push(promise) });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.item.publication.status, "queued");
  assert.equal(work.length, 1);
  await Promise.all(work);
  assert.equal(h.job(id).status, "published");
  const item = h.state.catalog.items["Classic Hat"];
  assert.equal(item.LimitedU, true);
  assert.equal(item.Stock, 25);
  assert.equal(item.MaxPerUser, 0);
  assert.equal(item.OffsaleAt - item.OnsaleAt, 7200);
  assert.equal(item.OnsaleAt, item.PublishedAt);
  assert.equal(item.AccessoryAttachment, "LeftShoulderAttachment");
  assert.equal(item.PublisherSubmissionId, id);
  assert.equal(h.state.notifications, 1);
  assert.equal((await h.approve(id, session, undefined, "approve", 2)).response.status, 409);
  assert.equal((await h.approve(id, session, undefined, "decline", 2)).response.status, 409);
  const listed = await h.request("/api/admin/submissions?status=approved", undefined, session);
  assert.equal(listed.data.items[0].publication.status, "published");
});

test("declining and disabled automatic publishing never write into Roblox", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  assert.equal((await h.approve(id, session, undefined, "decline")).response.status, 200);
  assert.equal(h.job(id), undefined);
  h.env.ROBLOX_AUTO_PUBLISH = "false";
  const next = await h.submit();
  assert.equal((await h.approve(next, session)).response.status, 200);
  assert.equal(h.job(next), undefined);
  assert.equal((await h.retry(next, session)).response.status, 409);
  assert.equal(h.state.calls.length, 0);
});

test("a failed outbox insert rolls back approval, audit, and the accepted-item registry", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.DB.sqlite.exec("CREATE TRIGGER fail_publish_insert BEFORE INSERT ON publish_jobs BEGIN SELECT RAISE(ABORT,'fixture unavailable'); END");
  assert.equal((await h.approve(id, session)).response.status, 503);
  assert.equal(h.env.DB.sqlite.prepare("SELECT status,version FROM submissions WHERE id=?").get(id).status, "pending");
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) total FROM review_log").get().total, 0);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) total FROM catalog_items WHERE id=?").get(id).total, 0);
});

test("conditional writes preserve a concurrent Studio publication and entry metadata", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.state.catalog = { version: 4, items: {}, known: {}, untouchedField: "keep" };
  h.state.revision = 4;
  h.state.writeHook = () => {
    h.state.writeHook = null;
    h.state.catalog.items["Studio Item"] = { Name: "Studio Item", AssetId: 500, ItemType: "Hat", Stock: 10, Limited: true };
    h.state.catalog.known["Studio Item"] = true;
    h.state.catalog.version++;
    h.state.revision++;
    return new Response(null, { status: 409 });
  };
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.state.catalog.items["Studio Item"].Stock, 10);
  assert.equal(h.state.catalog.untouchedField, "keep");
  assert.equal(h.state.catalog.version, 6);
  assert.equal(h.state.writes, 1);
});

test("a lost response after commit retries without another item, version, or timer reset", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ endMode: "duration", duration: "1", durationUnit: "hours" });
  await h.approve(id, session);
  h.state.ambiguous = true;
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "failed");
  const original = clone(h.state.catalog);
  const stamp = now();
  Date.now = () => (stamp + 86400) * 1000;
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.deepEqual(h.state.catalog, original);
  assert.equal(h.state.writes, 1);
  assert.equal(h.job(id).published_at, original.items["Classic Hat"].PublishedAt);
});

test("outages preserve acceptance and cron retries the same job when Roblox recovers", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  const jobId = h.job(id).job_id;
  h.state.fail = 503;
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "failed");
  assert.ok(h.job(id).next_attempt > now());
  assert.doesNotMatch(h.job(id).error, /test-only-open-cloud-secret/);
  assert.equal(h.env.DB.sqlite.prepare("SELECT status FROM submissions WHERE id=?").get(id).status, "approved");
  h.state.fail = 0;
  const due = h.job(id).next_attempt;
  Date.now = () => due * 1000;
  await worker.scheduled({ cron: "* * * * *" }, h.env);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.job(id).job_id, jobId);
});

test("expired leases recover safely and overlapping delivery cannot publish twice", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.env.DB.sqlite.prepare("UPDATE publish_jobs SET status='publishing',lease_until=? WHERE submission_id=?").run(now() - 1, id);
  let unblock, started;
  const blocked = new Promise(resolve => { unblock = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  h.state.readHook = async () => { h.state.readHook = null; started(); await blocked; };
  const first = publishOne(h.env, id);
  await entered;
  await publishOne(h.env, id);
  unblock();
  await first;
  assert.equal(h.state.writes, 1);
  assert.equal(h.job(id).status, "published");
});

test("a competing review during verification cannot enqueue a stale approval", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  const original = globalThis.fetch;
  let changed = false;
  globalThis.fetch = async (input, options) => {
    if (!changed && String(input).includes("economy.roblox.com/v2/assets/100/details")) {
      changed = true;
      h.env.DB.sqlite.prepare("UPDATE submissions SET status='declined',version=version+1 WHERE id=?").run(id);
    }
    return original(input, options);
  };
  assert.equal((await h.approve(id, session)).response.status, 409);
  assert.equal(h.job(id), undefined);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) total FROM review_log").get().total, 0);
  assert.equal(h.state.calls.length, 0);
});

test("automatically published owner items also require a verified Roblox-created base", async t => {
  const h = harness(t), session = await h.login();
  const bad = await h.request("/api/admin/items", { draft: draft({ name: "UGC owner item", assetId: "101" }) }, session);
  assert.equal(bad.response.status, 400);
  const good = await h.request("/api/admin/items", { draft: draft({ name: "Owner gear", assetId: "103", itemType: "Tool", accessoryKind: "", gearType: "Melee" }) }, session);
  assert.equal(good.response.status, 200, JSON.stringify(good.data));
  assert.equal(good.data.item.publication.status, "queued");
  await publishOne(h.env, good.data.item.id);
  assert.equal(h.job(good.data.item.id).status, "published");
  assert.equal(h.state.catalog.items["Owner gear"].ItemType, "Tool");
});

for (const source of ["authored", "live", "retired-name", "face-texture"]) test("the publisher rejects duplicates from " + source + " without replacing the game catalog", async t => {
  const h = harness(t), session = await h.login();
  const changes = source === "face-texture" ? { name: "New Face", assetId: "106", itemType: "Face", texture: "rbxassetid://200" } : {};
  const id = await h.submit(changes);
  const existing = { Name: "Other Name", AssetId: 100, ItemType: "Hat", Stock: 9, Limited: true };
  if (source === "authored") h.state.ready.items = [existing];
  if (source === "face-texture") h.state.ready.items = [{ Name: "Existing Face", AssetId: 0, ItemType: "Face", Texture: "rbxassetid://200" }];
  h.state.catalog = { version: 9, items: source === "live" ? { "Other Name": existing } : {}, known: source === "retired-name" ? { "classic   hat": true } : {} };
  const before = clone(h.state.catalog);
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "failed");
  assert.equal(h.job(id).next_attempt, null);
  const result = await h.request("/api/admin/submissions/" + id, undefined, session);
  assert.equal(result.data.item.status, "declined");
  assert.equal(result.data.item.version, 3);
  assert.equal(result.data.item.publication.autoDeclined, true);
  assert.equal(result.data.item.publication.retryable, false);
  assert.equal(h.env.DB.sqlite.prepare("SELECT source FROM catalog_items WHERE id=?").get(id).source, "existing");
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM review_log WHERE submission_id=? AND action='auto-decline'").get(id).n, 1);
  assert.equal((await h.retry(id, session)).response.status, 409);
  const resubmit = await h.request("/api/submissions", { kind: "official", draft: draft({ ...changes, name: "Another copy" }), turnstileToken: "submit-ok", receiptKey: "B".repeat(43) });
  assert.equal(resubmit.response.status, 409);
  assert.equal(h.state.writes, 0);
  assert.deepEqual(h.state.catalog, before);
  await publishOne(h.env, id);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM review_log WHERE submission_id=? AND action='auto-decline'").get(id).n, 1);
});

test("a distinct reskin may reuse an authored base and stores its verified replacement texture", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ name: "My Reskin", customTexture: true, texture: "201" }, "reskin");
  h.state.ready.items = [{ Name: "Classic Hat", AssetId: 100, ItemType: "Hat" }];
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.state.catalog.items["My Reskin"].Texture, "rbxassetid://200");
});

test("missing game readiness and unsupported heads never create catalog entries", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ name: "Classic Head", assetId: "105", itemType: "Head" });
  h.state.ready.types.Head = false;
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.match(h.job(id).error, /does not support Head/);
  assert.equal(h.state.writes, 0);
  h.state.ready = null;
  const connection = await testConnection(h.env);
  assert.equal(connection.connected, false);
  assert.match(connection.error, /Publish the updated game/);
});

test("Headless Head publishes as Head and retains its headless appearance and stock", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ name: "Headless Head", assetId: "15093053680", itemType: "Head", accessoryKind: "", catalogType: "limited-u", stock: "25", endMode: "duration", duration: "1", durationUnit: "hours" });
  assert.equal(h.state.ready.types.Head, true);
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published", h.job(id).error);
  const item = h.state.catalog.items["Headless Head"];
  assert.equal(item.ItemType, "Head");
  assert.equal(item.Headless, true);
  assert.equal(item.AssetId, 15093053680);
  assert.equal(item.Stock, 25);
  assert.equal(item.MaxPerUser, 0);
  assert.equal(item.OffsaleAt - item.OnsaleAt, 3600);
  assert.equal(item.Texture, undefined);
  assert.equal(item.PublisherSubmissionId, id);
  await publishOne(h.env, id);
  assert.equal(h.state.writes, 1);
});

test("an existing authored Headless Head blocks automatic publishing", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ name: "Headless Head", assetId: "15093053680", itemType: "Head", accessoryKind: "" });
  h.state.ready.items = [ { Name: "Existing Headless", AssetId: 134082579, ItemType: "Hat", Headless: true } ];
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "failed");
  assert.match(h.job(id).error, /already exists/);
  assert.equal(h.state.writes, 0);
});

test("messaging failure keeps the catalog published and allows the existing minute poll", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.state.notifyFail = true;
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.job(id).notification, "polling");
});

test("publishing endpoints require owner authentication and same-origin writes", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  assert.equal((await h.request("/api/admin/publishing")).response.status, 401);
  assert.equal((await h.request("/api/admin/publishing/test", {})).response.status, 401);
  assert.equal((await h.request("/api/admin/publish/" + id, { version: 1 })).response.status, 401);
  assert.equal((await h.request("/api/admin/publishing/test", {}, session, undefined, "https://evil.test")).response.status, 403);
  assert.equal((await h.request("/api/admin/publishing", undefined, session)).data.enabled, true);
  const publicConfig = await h.request("/api/config");
  assert.doesNotMatch(JSON.stringify(publicConfig.data), /ROBLOX_API_KEY|test-only-open-cloud-secret/);
  assert.equal(h.state.calls.length, 0);
});

test("manual retries reuse the same job and refuse to change its target experience", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.state.fail = 403;
  await publishOne(h.env, id);
  const jobId = h.job(id).job_id;
  h.env.ROBLOX_UNIVERSE_ID = "999999";
  assert.equal((await h.retry(id, session)).response.status, 409);
  h.env.ROBLOX_UNIVERSE_ID = "123456";
  h.state.fail = 0;
  assert.equal((await h.retry(id, session)).response.status, 200);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.job(id).job_id, jobId);
});

test("enabling publishing leaves older approvals untouched until the owner explicitly publishes", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.ROBLOX_AUTO_PUBLISH = "false";
  await h.approve(id, session);
  h.env.ROBLOX_AUTO_PUBLISH = "true";
  await worker.scheduled({ cron: "* * * * *" }, h.env);
  assert.equal(h.state.writes, 0);
  assert.equal((await h.retry(id, session)).response.status, 200);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
});

test("malformed existing catalog data fails closed and legacy empty Lua tables are accepted", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.state.catalog = { version: "oops", items: { untouched: true } };
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "failed");
  assert.equal(h.state.writes, 0);
  h.state.catalog = { version: 0, items: [], known: [] };
  await h.retry(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
});

test("connection checks are read-only and publishing requires valid configuration", async t => {
  const h = harness(t);
  assert.equal((await testConnection(h.env)).connected, true);
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.notifications, 0);
  h.env.ROBLOX_UNIVERSE_ID = "https://evil.test/";
  assert.equal(publishingConfig(h.env).enabled, false);
  assert.equal((await testConnection(h.env)).connected, false);
});


test("connection reports game identity and distinguishes missing place build from catalog version", async t => {
  const h = harness(t);
  h.state.ready.placeId = 18826098361;
  h.state.ready.updatedAt = 1780000000;
  const result = await testConnection(h.env);
  assert.equal(result.experience.name, "Reminisce <test>");
  assert.equal(result.experience.rootPlaceId, 18826098361);
  assert.equal(result.registeredPlaceId, 18826098361);
  assert.equal(result.placeVersion, null);
  assert.equal(result.protocolVersion, 1);
  assert.equal(result.catalogVersion, 0);
  assert.equal(result.liveItemCount, 0);
  assert.equal(result.uploaderVersion, "3.8.0");
  h.state.ready.placeVersion = 42;
  assert.equal((await testConnection(h.env)).placeVersion, 42);
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.notifications, 0);
});

test("public metadata failures preserve catalog connection and rejected keys retain game identity", async t => {
  const h = harness(t);
  h.state.metadataFail = true;
  let result = await testConnection(h.env);
  assert.equal(result.connected, true);
  assert.equal(result.experience, null);
  h.state.metadataFail = false;
  h.state.metadataWrongId = true;
  assert.equal((await testConnection(h.env)).experience, null);
  h.state.metadataWrongId = false;
  h.state.fail = 403;
  result = await testConnection(h.env);
  assert.equal(result.connected, false);
  assert.equal(result.experience.name, "Reminisce <test>");
  assert.ok(!JSON.stringify(result).includes(h.env.ROBLOX_API_KEY));
});

for (const status of [401, 403]) test("connection reports HTTP " + status + " and the exact failed read without revealing credentials", async t => {
  const h = harness(t);
  h.state.fail = status;
  const result = await testConnection(h.env);
  assert.equal(result.connected, false);
  assert.equal(result.diagnostic.httpStatus, status);
  assert.equal(result.diagnostic.operation, 'reading "uploader-ready"');
  assert.equal(result.diagnostic.requiredPermission, "universe-datastores.objects:read");
  assert.match(result.error, new RegExp("HTTP " + status));
  assert.equal(result.key.status, "active");
  assert.equal(result.key.permissions.update, true);
  assert.doesNotMatch(JSON.stringify(result), /private upstream|test-only-open-cloud-secret/);
  assert.equal(h.state.writes, 0);
});

test("a rejected catalog write stays approved and safely retries after replacing the key", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.state.writeHook = () => new Response("private upstream body", { status: 403 });
  await publishOne(h.env, id);
  const jobId = h.job(id).job_id;
  assert.equal(h.job(id).status, "failed");
  assert.match(h.job(id).error, /writing "catalog" \(HTTP 403\)/);
  assert.match(h.job(id).error, /universe-datastores.objects:update/);
  assert.equal(h.env.DB.sqlite.prepare("SELECT status FROM submissions WHERE id=?").get(id).status, "approved");
  assert.equal(h.state.writes, 0);
  h.env.ROBLOX_API_KEY = "replacement-fixture-key-with-valid-permissions";
  h.state.writeHook = null;
  await h.retry(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.job(id).job_id, jobId);
  assert.equal(h.state.writes, 1);
});

test("inspection verifies the installed key's experience and store restrictions rather than scope names alone", async t => {
  const h = harness(t);
  h.state.keyInspection = { enabled: true, expired: false, apiKey: h.env.ROBLOX_API_KEY, scopes: [
    { name: "universe-datastores.objects", operations: ["read"], universeDatastores: [{ universeId: "123456", datastoreName: "ReminisceLiveCatalog_v1" }] },
    { name: "universe-datastores.objects", operations: ["create", "update"], universeDatastores: [{ universeId: "999", datastoreName: "*" }] },
    { name: "universe-messaging-service", operations: ["publish"], universeIds: ["999"] }
  ] };
  const result = await testConnection(h.env);
  assert.deepEqual(result.key.permissions, { read: true, create: false, update: false, messaging: false });
  assert.equal(result.connected, true);
  assert.ok(!JSON.stringify(result).includes(h.env.ROBLOX_API_KEY));
  h.state.keyInspection.scopes[1].universeDatastores = [{ universeId: "123456", datastoreName: "AnotherStore" }];
  assert.equal((await testConnection(h.env)).key.permissions.update, false);
});

test("wildcard key targets are recognized and unknown resource formats remain unverified", async t => {
  const h = harness(t);
  h.state.keyInspection = { enabled: true, expired: false, scopes: [
    { name: "universe-datastores.objects", operations: ["read", "create", "update"], universeDatastores: [{ universeId: "*", datastoreName: "*" }] },
    { name: "universe-messaging-service", operations: ["publish"], universeIds: ["*"] }
  ] };
  assert.deepEqual((await testConnection(h.env)).key.permissions, { read: true, create: true, update: true, messaging: true });
  h.state.keyInspection.scopes[0].universeDatastores = ["future-resource-format"];
  assert.equal((await testConnection(h.env)).key.permissions.update, null);
});

for (const status of ["disabled", "expired"]) test("connection exposes the stored key's " + status + " status without returning the introspection body", async t => {
  const h = harness(t);
  h.state.keyInspection = { enabled: status !== "disabled", expired: status === "expired", name: h.env.ROBLOX_API_KEY };
  const result = await testConnection(h.env);
  assert.equal(result.key.status, status);
  assert.ok(!JSON.stringify(result).includes(h.env.ROBLOX_API_KEY));
});

test("key inspection outages do not invalidate working catalog reads", async t => {
  const h = harness(t);
  h.state.keyCheckFail = true;
  const result = await testConnection(h.env);
  assert.equal(result.connected, true);
  assert.equal(result.key.status, "unavailable");
  assert.equal(result.key.httpStatus, 503);
  assert.equal(h.state.writes, 0);
});

test("copied keys trim surrounding whitespace and reject embedded spaces without sending them", async t => {
  const h = harness(t);
  h.env.ROBLOX_API_KEY = " \n" + h.env.ROBLOX_API_KEY + "\r\n";
  assert.equal((await testConnection(h.env)).connected, true);
  h.env.ROBLOX_API_KEY = "fixture-invalid-key-with embedded-space";
  h.state.calls.length = 0;
  const result = await testConnection(h.env);
  assert.equal(result.connected, false);
  assert.match(result.error, /contains spaces or line breaks/);
  assert.equal(h.state.calls.length, 0);
});


test("ordinary dynamic heads publish as normal Heads with their original asset ID", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ name: "Static dynamic head", assetId: "205", itemType: "Head", accessoryKind: "" });
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published", h.job(id).error);
  const item = h.state.catalog.items["Static dynamic head"];
  assert.equal(item.ItemType, "Head");
  assert.equal(item.AssetId, 205);
  assert.equal(item.Headless, undefined);
  assert.equal(item.DynamicHead, undefined);
  assert.equal(item.Texture, undefined);
  await publishOne(h.env, id);
  assert.equal(h.state.writes, 1);
});

test("missing Head support stays approved and retry succeeds after the game update", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ name: "Dynamic head setup", assetId: "205", itemType: "Head", accessoryKind: "" });
  h.state.ready.types.Head = false;
  await h.approve(id, session);
  await publishOne(h.env, id);
  const record = await h.request("/api/admin/submissions/" + id, undefined, session);
  assert.equal(record.data.item.status, "approved");
  assert.equal(record.data.item.publication.retryable, true);
  assert.equal(record.data.item.publication.autoDeclined, false);
  h.state.ready.types.Head = true;
  await h.retry(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.state.catalog.items["Dynamic head setup"].ItemType, "Head");
});

test("invalid immutable settings automatically decline and release an unpublished item for correction", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  const saved = JSON.parse(h.job(id).draft_json);
  h.env.DB.sqlite.prepare("UPDATE publish_jobs SET draft_json=? WHERE submission_id=?").run(JSON.stringify({ ...saved, price: "bad" }), id);
  await publishOne(h.env, id);
  const record = await h.request("/api/admin/submissions/" + id, undefined, session);
  assert.equal(record.data.item.status, "declined");
  assert.equal(record.data.item.version, 3);
  assert.equal(record.data.item.publication.autoDeclined, true);
  assert.match(record.data.item.publication.error, /invalid catalog settings/);
  assert.equal(h.job(id).next_attempt, null);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM catalog_items WHERE id=?").get(id).n, 0);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM catalog_keys WHERE item_id=?").get(id).n, 0);
  assert.equal(h.state.writes, 0);
  assert.equal((await h.request("/api/admin/publish/" + id, { version: 3 }, session)).response.status, 409);
  const corrected = await h.submit();
  assert.notEqual(corrected, id);
});

test("automatic duplicate declines deliver a private reason without exposing approval notes", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.DB.sqlite.prepare("UPDATE submissions SET owner_note=? WHERE id=?").run("Owner-only approval note", id);
  await h.approve(id, session);
  h.state.ready.items = [{ Name: "Already present", ItemType: "Hat", AssetId: 100 }];
  await publishOne(h.env, id);
  const response = await h.request("/api/status", { id, receiptKey: h.receipts.get(id) });
  assert.equal(response.response.status, 200);
  assert.equal(response.data.status, "declined");
  assert.match(response.data.declineNote, /already exists/);
  assert.doesNotMatch(JSON.stringify(response.data), /Owner-only approval note|test-only-open-cloud-secret/);
  assert.equal(h.env.DB.sqlite.prepare("SELECT owner_note FROM submissions WHERE id=?").get(id).owner_note, "Owner-only approval note");
  assert.equal(h.state.writes, 0);
});

test("retryable API failures keep acceptance and do not disclose owner diagnostics to submitters", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.state.fail = 403;
  await publishOne(h.env, id);
  const response = await h.request("/api/status/batch", { receipts: [{ id, receiptKey: h.receipts.get(id) }] });
  assert.equal(response.data.items[0].status, "approved");
  assert.equal(response.data.items[0].declineNote, "");
  assert.doesNotMatch(JSON.stringify(response.data), /HTTP 403|ROBLOX_API_KEY|test-only-open-cloud-secret|Required:/);
});

for (const status of [400, 422]) test("a definitive rejected write HTTP " + status + " declines without exposing upstream details", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.state.writeHook = () => new Response("private rejected request " + h.env.ROBLOX_API_KEY, { status });
  await publishOne(h.env, id);
  const record = await h.request("/api/admin/submissions/" + id, undefined, session);
  assert.equal(record.data.item.status, "declined");
  assert.equal(record.data.item.publication.retryable, false);
  assert.match(record.data.item.publication.error, new RegExp("HTTP " + status));
  assert.doesNotMatch(JSON.stringify(record.data), /test-only-open-cloud-secret|private rejected request/);
  assert.equal(h.job(id).next_attempt, null);
  assert.equal(h.state.writes, 0);
});

test("automatic decline, audit and registry changes roll back together when a database write fails", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.state.ready.items = [{ Name: "Already present", ItemType: "Hat", AssetId: 100 }];
  h.env.DB.sqlite.exec("CREATE TRIGGER fail_decline_audit BEFORE INSERT ON review_log WHEN NEW.action='auto-decline' BEGIN SELECT RAISE(ABORT,'audit failure'); END;");
  await assert.rejects(() => publishOne(h.env, id), /audit failure/);
  assert.equal(h.env.DB.sqlite.prepare("SELECT status,version FROM submissions WHERE id=?").get(id).status, "approved");
  assert.equal(h.job(id).status, "publishing");
  assert.equal(h.env.DB.sqlite.prepare("SELECT source FROM catalog_items WHERE id=?").get(id).source, "accepted");
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM review_log WHERE action='auto-decline'").get().n, 0);
  h.env.DB.sqlite.exec("DROP TRIGGER fail_decline_audit;");
  const expired = h.job(id).lease_until + 1;
  Date.now = () => expired * 1000;
  await publishOne(h.env, id);
  assert.equal(h.env.DB.sqlite.prepare("SELECT status FROM submissions WHERE id=?").get(id).status, "declined");
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM review_log WHERE action='auto-decline'").get().n, 1);
  assert.equal(h.state.writes, 0);
});

test("an expired delivery cannot decline an item after another worker takes its lease", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.state.ready.items = [{ Name: "Already present", ItemType: "Hat", AssetId: 100 }];
  h.state.readHook = () => {
    h.state.readHook = null;
    h.env.DB.sqlite.prepare("UPDATE publish_jobs SET lease_token='new-owner' WHERE submission_id=?").run(id);
  };
  await publishOne(h.env, id);
  assert.equal(h.env.DB.sqlite.prepare("SELECT status,version FROM submissions WHERE id=?").get(id).status, "approved");
  assert.equal(h.job(id).lease_token, "new-owner");
  assert.equal(h.env.DB.sqlite.prepare("SELECT source FROM catalog_items WHERE id=?").get(id).source, "accepted");
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM review_log WHERE action='auto-decline'").get().n, 0);
});

test("selected failed publications retry with the same identities and report stale or terminal records", async t => {
  const h = harness(t), session = await h.login();
  const ids = [await h.submit(), await h.submit({ name: "Retry Hair", assetId: "104", itemType: "Hair", accessoryKind: "Hair" })];
  for (const id of ids) await h.approve(id, session);
  h.state.fail = 503;
  for (const id of ids) await publishOne(h.env, id);
  const originals = ids.map(id => h.job(id));
  h.state.fail = 0;
  const stale = await h.request("/api/admin/publish/retry", { items: [{ id: ids[0], version: 1 }] }, session);
  assert.equal(stale.response.status, 200);
  assert.equal(stale.data.queued.length, 0);
  assert.equal(stale.data.errors.length, 1);
  const work = [];
  const result = await h.request("/api/admin/publish/retry", { items: ids.map(id => ({ id, version: 2 })) }, session, { waitUntil: promise => work.push(promise) });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.queued, ids);
  assert.deepEqual(result.data.errors, []);
  await Promise.all(work);
  for (const [index, id] of ids.entries()) {
    assert.equal(h.job(id).status, "published");
    assert.equal(h.job(id).job_id, originals[index].job_id);
    assert.equal(h.job(id).draft_json, originals[index].draft_json);
  }
  assert.equal(h.state.writes, 2);
  const repeated = await h.request("/api/admin/publish/retry", { items: ids.map(id => ({ id, version: 2 })) }, session);
  assert.equal(repeated.data.queued.length, 0);
  assert.equal(repeated.data.errors.length, 2);
  assert.equal(h.state.writes, 2);
});

test("batch retries enforce owner access, same origin, unique IDs and the 30-item bound", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.state.fail = 503;
  await publishOne(h.env, id);
  const selection = { items: [{ id, version: 2 }] };
  assert.equal((await h.request("/api/admin/publish/retry", selection)).response.status, 401);
  assert.equal((await h.request("/api/admin/publish/retry", selection, session, undefined, "https://evil.test")).response.status, 403);
  for (const items of [[], [{ id, version: 0 }], [{ id: "invalid", version: 2 }], [selection.items[0], selection.items[0]], Array.from({ length: 31 }, () => ({ id: crypto.randomUUID(), version: 2 }))]) {
    assert.equal((await h.request("/api/admin/publish/retry", { items }, session)).response.status, 400);
    assert.equal(h.job(id).status, "failed");
  }
  h.state.fail = 0;
  const result = await h.request("/api/admin/publish/retry", { items: [{ id, version: 2 }, { id: crypto.randomUUID(), version: 2 }] }, session);
  assert.deepEqual(result.data.queued, [id]);
  assert.equal(result.data.errors.length, 1);
  await publishOne(h.env, id);
  assert.equal(h.state.writes, 1);
});

test("retention cleanup removes old automatic declines while keeping existing game identities blocked", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  h.state.ready.items = [{ Name: "Already present", ItemType: "Hat", AssetId: 100 }];
  await publishOne(h.env, id);
  const future = now() + 181 * 86400;
  Date.now = () => future * 1000;
  await worker.scheduled({ cron: "17 4 * * *" }, h.env);
  assert.equal(h.job(id), undefined);
  assert.equal(h.env.DB.sqlite.prepare("SELECT id FROM submissions WHERE id=?").get(id), undefined);
  assert.equal(h.env.DB.sqlite.prepare("SELECT source FROM catalog_items WHERE id=?").get(id).source, "existing");
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM catalog_keys WHERE key='asset:100'").get().n, 1);
});

for (const assetId of ["205", "105"]) for (const creatorType of ["User", "Group"]) test("non-Roblox " + creatorType + " head " + assetId + " submit and publish while other creator assets stay blocked", async t => {
  const h = harness(t), original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await original(url, options);
    if (!String(url).includes("economy.roblox.com/v2/assets/" + assetId + "/")) return response;
    const metadata = await response.json();
    metadata.Creator = { Id: 12, CreatorType: creatorType, Name: "Head Creator" };
    return Response.json(metadata);
  };
  const session = await h.login(), id = await h.submit({ name: "Creator Head", assetId, itemType: "Head", accessoryKind: "" });
  assert.equal((await h.approve(id, session)).response.status, 200);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published", h.job(id).error);
  assert.equal(h.state.catalog.items["Creator Head"].ItemType, "Head");
  assert.equal(h.state.catalog.items["Creator Head"].AssetId, Number(assetId));
  assert.equal((await h.request("/api/submissions", { kind: "official", draft: draft({ assetId: "101", name: "UGC Hat" }), receiptKey: "Z".repeat(43), turnstileToken: "submit-ok" })).response.status, 400);
  assert.equal((await h.request("/api/submissions", { kind: "official", draft: draft({ assetId, name: "Forged Hat", itemType: "Hat" }), receiptKey: "Y".repeat(43), turnstileToken: "submit-ok" })).response.status, 400);
});

for (const assetType of [18,79]) for (const creatorType of ["User","Group"]) test("UGC " + creatorType + " face type " + assetType + " publishes a standalone image without a head mesh", async t => {
  const h = harness(t), original = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    if (url.hostname === "economy.roblox.com" && url.pathname.includes("/9101/")) return Response.json({ AssetId:9101,Name:"Creator Face",AssetTypeId:assetType,Description:"Creator face description",Creator:{Id:12,CreatorTargetId:12,CreatorType:creatorType,Name:"Face Creator"} });
    if (url.hostname === "assetdelivery.roblox.com" && url.searchParams.get("id") === "9101") return new Response('<roblox>' + (assetType === 79 ? '<Item class="SpecialMesh"><Properties><token name="MeshType">0</token><Content name="TextureId"><url>rbxassetid://205</url></Content></Properties></Item>' : '') + '<Item class="Decal"><Properties><token name="Face">5</token><Content name="Texture"><url>rbxassetid://204</url></Content></Properties></Item></roblox>');
    return original(input, options);
  };
  const session = await h.login(), id = await h.submit({ name:"Creator Face",assetId:"9101",itemType:"Face",accessoryKind:"",texture:"200" });
  if (assetType === 79) h.env.ROBLOX_AUTO_PUBLISH = "false";
  assert.equal((await h.approve(id,session)).response.status,200);
  if (assetType === 79) {
    assert.equal(h.job(id),undefined);
    h.env.ROBLOX_AUTO_PUBLISH = "true";
    assert.equal((await h.retry(id,session)).response.status,200);
  }
  await publishOne(h.env,id);
  assert.equal(h.job(id).status,"published",h.job(id).error);
  const item = h.state.catalog.items["Creator Face"];
  assert.equal(item.ItemType,"Face");assert.equal(item.AssetId,9101);assert.equal(item.Texture,"rbxassetid://204");
  assert.equal(item.Headless,undefined);assert.equal(item.DynamicHead,undefined);
  assert.equal(h.state.writes,1);
  await publishOne(h.env,id);assert.equal(h.state.writes,1);
});

test("acceptance sends one recorded announcement without a player or game-server callback", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ catalogType: "limited-u", stock: "25", endMode: "duration", duration: "2", durationUnit: "hours", description: "Hat description @everyone <@&999>" });
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  h.env.NEW_ITEM_PING_ROLE_ID = "1548840892628996106";
  const work = [];
  await h.approve(id, session, { waitUntil: value => work.push(value) });
  await Promise.all(work);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.webhook(id).status, "sent");
  assert.equal(h.webhook(id).message_id, "1548840892628996199");
  assert.equal(h.webhook(id).attempts, 1);
  assert.equal(h.state.catalog.items["Classic Hat"].PublisherAnnouncement, "worker");
  const { payload } = h.state.webhookCalls[0];
  assert.equal(payload.content, "<@&1548840892628996106>");
  assert.deepEqual(payload.allowed_mentions, { parse: [], roles: ["1548840892628996106"] });
  assert.equal(payload.embeds[0].fields[1].value, "Limited U");
  assert.equal(payload.embeds[0].fields[2].value, "25 (Limited U)");
  assert.match(payload.embeds[0].description, /Sale ends <t:\d+:f>/);
  assert.match(payload.embeds[0].image.url, /^https:\/\/.+\.rbxcdn\.com\//);
  await sendAnnouncement(h.env, id);
  await publishOne(h.env, id);
  await worker.scheduled({ cron: "* * * * *" }, h.env);
  assert.equal(h.state.webhookCalls.length, 1);
  const record = (await h.request("/api/admin/submissions/" + id, undefined, session)).data.item;
  assert.equal(record.publication.webhook.status, "sent");
  assert.equal(record.publication.webhook.retryable, false);
  assert.doesNotMatch(JSON.stringify(record), /test-only-private-webhook-token|test-only-open-cloud-secret/);
});

test("webhook outages preserve publication and cron retries only the saved announcement", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ endMode: "duration", duration: "1", durationUnit: "hours" });
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  h.state.webhookHook = () => new Response("private response " + webhookFixture, { status: 503 });
  await h.approve(id, session);
  await publishOne(h.env, id);
  const original = clone(h.state.catalog);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.webhook(id).status, "failed");
  assert.doesNotMatch(h.webhook(id).error, /discord\.com|private|token/);
  Date.now = () => h.webhook(id).next_attempt * 1000;
  h.state.webhookHook = null;
  h.env.ROBLOX_AUTO_PUBLISH = "false";
  await worker.scheduled({ cron: "* * * * *" }, h.env);
  assert.equal(h.webhook(id).status, "sent");
  assert.equal(h.state.writes, 1);
  assert.deepEqual(h.state.catalog, original);
});

test("webhook rate limits respect retry_after and never retry early", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  h.state.webhookHook = () => Response.json({ retry_after: 240.5 }, { status: 429, headers: { "Retry-After": "120" } });
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.ok(h.webhook(id).next_attempt - now() >= 240);
  await drainAnnouncements(h.env);
  assert.equal(h.state.webhookCalls.length, 1);
  const due = h.webhook(id).next_attempt;
  Date.now = () => due * 1000;
  h.state.webhookHook = null;
  await drainAnnouncements(h.env);
  assert.equal(h.webhook(id).status, "sent");
});

test("a missing secret keeps a durable announcement until setup is completed", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.webhook(id).status, "failed");
  assert.equal(h.webhook(id).attempts, 0);
  assert.match(h.webhook(id).error, /NEW_ITEM_WEBHOOK_URL/);
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  const due = h.webhook(id).next_attempt;
  Date.now = () => due * 1000;
  await drainAnnouncements(h.env);
  assert.equal(h.webhook(id).status, "sent");
  assert.equal(h.webhook(id).attempts, 1);
});

test("owner-only announcement retry keeps the item, stock, version and sale timer unchanged", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  h.state.webhookHook = () => new Response("private upstream", { status: 403 });
  await h.approve(id, session);
  await publishOne(h.env, id);
  const snapshot = clone(h.state.catalog), path = "/api/admin/webhooks/" + id;
  assert.equal((await h.request(path, { version: 2 })).response.status, 401);
  assert.equal((await h.request(path, { version: 2 }, session, undefined, "https://evil.test")).response.status, 403);
  assert.equal((await h.request(path, { version: 1 }, session)).response.status, 409);
  h.state.webhookHook = null;
  const work = [], retry = await h.request(path, { version: 2 }, session, { waitUntil: value => work.push(value) });
  assert.equal(retry.response.status, 200);
  assert.equal(retry.data.item.publication.status, "published");
  assert.equal(retry.data.item.publication.webhook.status, "pending");
  await Promise.all(work);
  assert.equal(h.webhook(id).status, "sent");
  assert.deepEqual(h.state.catalog, snapshot);
  assert.equal(h.state.writes, 1);
  assert.equal((await h.request(path, { version: 2 }, session)).response.status, 409);
});

test("overlapping announcement deliveries share one lease and send only once", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  await h.approve(id, session);
  await publishOne(h.env, id);
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  let started, release;
  const entered = new Promise(resolve => started = resolve), blocked = new Promise(resolve => release = resolve);
  h.state.webhookHook = async () => { started(); await blocked; return Response.json({ id: "1548840892628996199" }); };
  await h.request("/api/admin/webhooks/" + id, { version: 2 }, session);
  const first = sendAnnouncement(h.env, id);
  await entered;
  await sendAnnouncement(h.env, id);
  release();
  await first;
  assert.equal(h.state.webhookCalls.length, 1);
  assert.equal(h.webhook(id).status, "sent");
});

test("ambiguous delivery and expired sends stop automatic retries to avoid duplicate pings", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  h.state.webhookHook = () => { throw new Error("private network failure " + webhookFixture); };
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.webhook(id).status, "uncertain");
  assert.equal(h.webhook(id).next_attempt, null);
  assert.doesNotMatch(h.webhook(id).error, /private|discord/);
  await drainAnnouncements(h.env);
  assert.equal(h.state.webhookCalls.length, 1);
  h.env.DB.sqlite.prepare("UPDATE publish_webhooks SET status='sending',lease_token='lost',lease_until=? WHERE submission_id=?").run(now() - 1, id);
  await drainAnnouncements(h.env);
  assert.equal(h.webhook(id).status, "uncertain");
  assert.equal(h.state.webhookCalls.length, 1);
  h.state.webhookHook = null;
  assert.equal((await h.request("/api/admin/webhooks/" + id, { version: 2 }, session)).response.status, 200);
  await sendAnnouncement(h.env, id);
  assert.equal(h.webhook(id).status, "sent");
});

test("legacy publish jobs keep game announcements and never trigger retroactive webhooks", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  await h.approve(id, session);
  h.env.DB.sqlite.prepare("UPDATE publish_jobs SET announcement_source='game' WHERE submission_id=?").run(id);
  delete h.state.ready.announcements;
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.webhook(id), undefined);
  assert.equal(h.state.catalog.items["Classic Hat"].PublisherAnnouncement, undefined);
  assert.equal(h.state.webhookCalls, undefined);
});

test("new announcements wait for the game suppression update before publishing", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  delete h.state.ready.announcements;
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "failed");
  assert.match(h.job(id).error, /3\.5\.0 game update/);
  assert.equal(h.state.writes, 0);
  assert.equal(h.webhook(id), undefined);
  h.state.ready.announcements = "worker";
  await h.retry(id, session);
  await publishOne(h.env, id);
  assert.equal(h.webhook(id).status, "sent");
});

test("a failed announcement insert rolls back the job and recovers the committed item once", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit({ endMode: "duration", duration: "1", durationUnit: "hours" });
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  await h.approve(id, session);
  h.env.DB.sqlite.exec("CREATE TRIGGER fail_webhook BEFORE INSERT ON publish_webhooks BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "failed");
  assert.equal(h.webhook(id), undefined);
  const saved = clone(h.state.catalog);
  h.env.DB.sqlite.exec("DROP TRIGGER fail_webhook");
  await h.retry(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "published");
  assert.equal(h.webhook(id).status, "sent");
  assert.equal(h.state.writes, 1);
  assert.deepEqual(h.state.catalog, saved);
});

test("duplicates, declines and event rewards never send catalog announcements", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture;
  h.state.ready.items.push({ Name: "Existing Hat", ItemType: "Hat", AssetId: 100 });
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.job(id).status, "failed");
  assert.equal(h.webhook(id), undefined);
  h.state.ready.items = [];
  const event = await h.submit({ name: "Event Hat", assetId: "104", itemType: "Hair", catalogType: "event", rewardSource: "Halloween" });
  await h.approve(event, session);
  await publishOne(h.env, event);
  assert.equal(h.job(event).status, "published");
  assert.equal(h.webhook(event).status, "skipped");
  assert.equal(h.state.webhookCalls, undefined);
});

test("webhook URLs stay private, validate their host, and never follow redirects", async t => {
  const h = harness(t), session = await h.login(), id = await h.submit();
  h.env.NEW_ITEM_WEBHOOK_URL = "https://evil.test/api/webhooks/1548840892628996198/" + "private-token".repeat(4);
  await h.approve(id, session);
  await publishOne(h.env, id);
  assert.equal(h.webhook(id).status, "failed");
  assert.equal(h.webhook(id).attempts, 0);
  assert.equal(h.state.webhookCalls, undefined);
  h.env.NEW_ITEM_WEBHOOK_URL = webhookFixture.replace("discord.com", "webhook.lewisakura.moe");
  h.state.webhookHook = () => new Response(null, { status: 302, headers: { Location: "https://evil.test/secret" } });
  await h.request("/api/admin/webhooks/" + id, { version: 2 }, session);
  await sendAnnouncement(h.env, id);
  assert.match(h.webhook(id).error, /HTTP 302/);
  assert.equal(h.state.webhookCalls.length, 1);
  const report = await testConnection(h.env);
  assert.equal(report.webhook.configured, true);
  assert.doesNotMatch(JSON.stringify(report), /test-only-private-webhook-token|test-only-open-cloud-secret/);
  assert.equal(h.state.webhookCalls.length, 1);
});
