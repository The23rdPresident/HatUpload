import test from "node:test";

import assert from "node:assert/strict";

import { createHash } from "node:crypto";

import worker from "../server/worker.js";

import { environment, upstream, ownerKey } from "./support.mjs";
import { checkKeys } from "../server/registry.js";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { ipHash, now } from "../server/security.js";
import { robloxJson } from "../server/catalog.js";

const core = globalThis.CatalogCore;

const draft = (changes = {}) => ({
  ...core.defaults(),
  name: "Classic Hat",
  assetId: "100",
  accessoryKind: "Hat",
  price: "500",
  ...changes
});

const payload = (changes = {}) => ({
  kind: "official",
  draft: draft(),
  turnstileToken: "submit-ok",
  receiptKey: "A".repeat(43),
  ...changes
});

function harness(t) {
  const env = environment(), stub = upstream(), original = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  t.after(() => {
    globalThis.fetch = original;
    env.DB.sqlite.close();
  });
  return {
    env: env,
    stub: stub,
    async request(path, options = {}) {
      const headers = {
        Origin: options.origin || "https://catalog.test",
        "CF-Connecting-IP": options.ip || "192.0.2.10"
      };
      if (options.token) headers.Authorization = "Bearer " + options.token;
      if (options.data) headers["Content-Type"] = "application/json";
      const response = await worker.fetch(new Request("https://catalog.test" + path, {
        method: options.method || (options.data ? "POST" : "GET"),
        headers: headers,
        body: options.data ? JSON.stringify(options.data) : undefined
      }), env);
      return {
        response: response,
        data: response.status === 204 ? null : await response.json()
      };
    },
    async login() {
      const response = await this.request("/api/admin/login", {
        data: {
          key: ownerKey,
          turnstileToken: "login-ok"
        }
      });
      assert.equal(response.response.status, 200, JSON.stringify(response.data));
      return response.data.token;
    }
  };
}

test("official lookups reject UGC and Group 1, accept gear, and filter search results", async t => {
  const h = harness(t);
  assert.equal((await h.request("/api/asset/100")).response.status, 200);
  for (const id of [ 101, 102 ]) assert.equal((await h.request("/api/asset/" + id)).response.status, 400);
  assert.equal((await h.request("/api/asset/103")).response.status, 200);
  const result = await h.request("/api/search?q=Classic%20Hat&robloxOnly=false");
  assert.deepEqual(result.data.items.map(item => item.id), [ 100 ]);
  const search = h.stub.calls.find(call => call.url.includes("search/items"));
  assert.match(search.url, /CreatorType=User/);
  assert.match(search.url, /Category=11/);
});

test("dynamic heads pass lookup for Roblox and other creators", async t => {
  const h = harness(t);
  for (const id of [15093053680, 134082579, 205]) {
    const lookup = await h.request("/api/asset/" + id);
    assert.equal(lookup.response.status, 200, JSON.stringify(lookup.data));
    assert.equal(lookup.data.item.creatorId, 1);
    assert.match(lookup.data.item.thumbnail, /rbxcdn\.com/);
    assert.equal(core.assetMapping(lookup.data.item.assetType, lookup.data.item.kind, id).itemType, "Head");
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await original(url, options);
    if (!String(url).includes("economy.roblox.com/v2/assets/205/")) return response;
    const item = await response.json();
    item.Creator.Id = 12;
    return Response.json(item);
  };
  assert.equal((await h.request("/api/asset/205")).response.status, 200);
});

test("Headless Head keeps its asset identity through approval and duplicate protection", async t => {
  const h = harness(t), proposal = draft({ name: "Headless Head", assetId: "15093053680", itemType: "Head", accessoryKind: "" });
  for (const changes of [{ itemType: "Hat" }, { customTexture: true, texture: "200" }, { Headless: true }]) {
    const result = await h.request("/api/submissions", { data: payload({ draft: { ...proposal, ...changes } }) });
    assert.equal(result.response.status, 400, JSON.stringify(result.data));
  }
  const first = await h.request("/api/submissions", { data: payload({ draft: proposal }) });
  assert.equal(first.response.status, 200, JSON.stringify(first.data));
  assert.equal((await h.request("/api/submissions", { data: payload({ receiptKey: "B".repeat(43), draft: { ...proposal, name: "Renamed Headless" } }) })).response.status, 409);
  assert.equal((await h.request("/api/submissions", { data: payload({ receiptKey: "D".repeat(43), draft: { ...proposal, assetId: "134082579", name: "Classic Headless" } }) })).response.status, 409);
  const token = await h.login();
  const approval = await h.request("/api/admin/submissions/" + first.data.id, { token, method: "PATCH", data: { action: "approve", version: 1 } });
  assert.equal(approval.response.status, 200, JSON.stringify(approval.data));
  const output = await h.request("/api/admin/submissions/" + first.data.id, { token });
  assert.equal(output.response.status, 200, JSON.stringify(output.data));
  const definition = core.buildDefinition(output.data.item.draft);
  assert.equal(definition.AssetId, 15093053680);
  assert.equal(definition.ItemType, "Head");
  assert.equal(definition.Headless, true);
  assert.equal((await h.request("/api/submissions", { data: payload({ receiptKey: "C".repeat(43), draft: proposal }) })).response.status, 409);
});

test("head name search finds Headless Head inside its Roblox bundle and excludes unrelated item types", async t => {
  const h = harness(t), result = await h.request("/api/search?q=Headless%20Head&category=heads");
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.exactMatchId, 15093053680);
  assert.deepEqual(result.data.items.map(item => item.id), [ 105, 15093053680, 205 ]);
  assert.equal(result.data.items.find(item => item.id === 15093053680).kind, "Asset");
  assert.ok(result.data.items.every(item => core.assetMapping(item.assetType, item.kind, item.id)?.itemType === "Head"));
  const search = h.stub.calls.find(call => call.url.includes("search/items"));
  assert.equal(new URL(search.url).searchParams.get("Category"), "1");
  assert.equal(new URL(search.url).searchParams.has("Subcategory"), false);
});

test("the hundredth submission is allowed and the next verified attempt is rate limited", async t => {
  const h = harness(t);
  delete h.env.SUBMISSIONS_PER_IP_PER_DAY;
  const ip = await ipHash(new Request("https://catalog.test", { headers: { "CF-Connecting-IP": "192.0.2.10" } }), h.env);
  h.env.DB.sqlite.prepare("INSERT INTO rate_windows(scope,window_start,hits) VALUES(?,?,99)").run("submit:" + ip, Math.floor(now() / 86400) * 86400);
  assert.equal((await h.request("/api/config")).data.dailyLimit, 100);
  assert.equal((await h.request("/api/submissions", { data: payload() })).response.status, 200);
  assert.equal((await h.request("/api/submissions", { data: payload({ receiptKey: "B".repeat(43) }) })).response.status, 429);
});

test("Roblox redirects stay on their original HTTPS host and off-host redirects are rejected", async t => {
  const h = harness(t);
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response(null, { status: 307, headers: { Location: "/new-path" } }) : Response.json({ ok: true });
  assert.deepEqual(await robloxJson("https://economy.roblox.com/old-path"), { ok: true });
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: "https://evil.test/private" } });
  await assert.rejects(() => robloxJson("https://economy.roblox.com/old-path"), /unsafe lookup redirect/);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) count FROM submissions").get().count, 0);
});

test("review aliases resolve to the document and static HEAD responses have no body", async t => {
  const h = harness(t);
  h.env.ASSETS = { fetch: async request => {
    assert.match(new URL(request.url).pathname, /\/(index|review)\.html$/);
    return new Response(request.method === "HEAD" ? null : "<!doctype html>", { headers: { "Content-Type": "text/html" } });
  } };
  for (const path of ["/", "/index", "/index.html", "/review", "/review.html"]) {
    const response = await worker.fetch(new Request("https://catalog.test" + path), h.env);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-cache");
  }
  const slash = await worker.fetch(new Request("https://catalog.test/review/"), h.env);
  assert.equal(slash.status, 308);
  assert.equal(slash.headers.get("Location"), "/review.html");
  const head = await worker.fetch(new Request("https://catalog.test/review.html", { method: "HEAD" }), h.env);
  assert.equal(await head.text(), "");
});

test("public submission is pending, private receipts work, and retrying a receipt is idempotent", async t => {
  const h = harness(t), data = payload();
  const first = await h.request("/api/submissions", {
    data: data
  });
  assert.equal(first.response.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.status, "pending");
  const second = await h.request("/api/submissions", {
    data: data
  });
  assert.equal(second.data.id, first.data.id);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM submissions").get().n, 1);
  const own = await h.request("/api/status", {
    data: {
      id: first.data.id,
      receiptKey: data.receiptKey
    }
  });
  assert.equal(own.data.status, "pending");
  assert.equal(own.data.ownerNote, undefined);
  assert.equal((await h.request("/api/status", {
    data: {
      id: first.data.id,
      receiptKey: "B".repeat(43)
    }
  })).response.status, 404);
  assert.equal((await h.request("/api/submissions", {
    data: {
      ...data,
      draft: { ...data.draft, price: "501" }
    }
  })).response.status, 409);
});

test("decline reasons reach only the receipt holder and private owner notes stay private", async t => {
  const h = harness(t), data = payload(), submission = await h.request("/api/submissions", { data });
  const id = submission.data.id, token = await h.login(), privateNote = "Private owner record", reason = "Please use a different texture.\n<img src=x onerror=alert(1)>";
  h.env.DB.sqlite.prepare("UPDATE submissions SET owner_note=?,decline_note=? WHERE id=?").run(privateNote, "Old reason", id);
  const status = () => h.request("/api/status", { data: { id, receiptKey: data.receiptKey } });
  const pending = await status();
  assert.equal(pending.data.declineNote, "");
  assert.doesNotMatch(JSON.stringify(pending.data), /Private owner record|Old reason/);
  const declined = await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "decline", version: 1, declineNote: reason } });
  assert.equal(declined.response.status, 200, JSON.stringify(declined.data));
  assert.equal(declined.data.item.ownerNote, privateNote);
  assert.equal(declined.data.item.declineNote, reason);
  const own = await status();
  assert.equal(own.data.status, "declined");
  assert.equal(own.data.declineNote, reason);
  assert.equal(own.data.ownerNote, undefined);
  assert.doesNotMatch(JSON.stringify(own.data), /Private owner record|receipt_hash|ip_hash/);
  assert.equal((await h.request("/api/status", { data: { id, receiptKey: "B".repeat(43) } })).response.status, 404);
  const changed = await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "decline", version: 2, declineNote: "Updated reason" } });
  assert.equal(changed.response.status, 200);
  assert.equal((await status()).data.declineNote, "Updated reason");
  assert.equal((await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "approve", version: 3 } })).response.status, 200);
  assert.equal((await status()).data.declineNote, "");
});

test("batch receipts disclose no item information for a missing or incorrect receipt", async t => {
  const h = harness(t), first = payload(), second = payload({ receiptKey: "B".repeat(43), draft: draft({ name: "Head suggestion", itemType: "Head", assetId: "205", accessoryKind: "" }) });
  const one = await h.request("/api/submissions", { data: first }), two = await h.request("/api/submissions", { data: second });
  const id = one.data.id, missing = crypto.randomUUID(), token = await h.login();
  await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "decline", version: 1, ownerNote: "Owner secret", declineNote: "Not a suitable item" } });
  const data = { receipts: [{ id, receiptKey: first.receiptKey }, { id: two.data.id, receiptKey: "C".repeat(43) }, { id: missing, receiptKey: "C".repeat(43) }] };
  const result = await h.request("/api/status/batch", { data });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.items[0].declineNote, "Not a suitable item");
  assert.deepEqual(result.data.items[1], { id: two.data.id, status: "Unavailable" });
  assert.deepEqual(result.data.items[2], { id: missing, status: "Unavailable" });
  assert.doesNotMatch(JSON.stringify(result.data), /Owner secret|Head suggestion|receiptKey|receipt_hash/);
  const correct = await h.request("/api/status/batch", { data: { receipts: [{ id: two.data.id, receiptKey: second.receiptKey }] } });
  assert.equal(correct.data.items[0].name, "Head suggestion");
  for (const receipts of [[], [null], [{ id, receiptKey: first.receiptKey, ownerNote: "forged" }], [data.receipts[0], data.receipts[0]], Array.from({ length: 31 }, () => data.receipts[0])]) {
    assert.equal((await h.request("/api/status/batch", { data: { receipts } })).response.status, 400);
  }
});

test("forged prices and stocks cannot bypass submission, owner creation or approval limits", async t => {
  const h = harness(t), token = await h.login();
  const changes = [{ price: "50001" }, { price: "-1" }, { price: "2.5" }, { catalogType: "limited", stock: "9" }, { catalogType: "limited", stock: "501" }, { catalogType: "limited-u", stock: "9" }, { catalogType: "limited-u", stock: "501" }, { catalogType: "limited-u", stock: "10.1" }];
  for (const change of changes) {
    const item = draft(change);
    assert.equal((await h.request("/api/submissions", { data: payload({ draft: item }) })).response.status, 400);
    assert.equal((await h.request("/api/admin/items", { token, data: { draft: item } })).response.status, 400);
  }
  const submission = await h.request("/api/submissions", { data: payload() }), id = submission.data.id;
  for (const change of changes) {
    assert.equal((await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "approve", version: 1, draft: draft(change) } })).response.status, 400);
  }
  const row = h.env.DB.sqlite.prepare("SELECT status,version FROM submissions WHERE id=?").get(id);
  assert.equal(row.status, "pending");
  assert.equal(row.version, 1);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM publish_jobs").get().n, 0);
});

test("server accepts inclusive boundaries and saves non-limited items with unlimited stock", async t => {
  const h = harness(t), token = await h.login();
  const cases = [{ price: "0", stock: "500" }, { price: "50000" }, { catalogType: "limited", stock: "10" }, { catalogType: "limited", stock: "500" }, { catalogType: "limited-u", stock: "10" }, { catalogType: "limited-u", stock: "500" }];
  for (const change of cases) {
    const response = await h.request("/api/submissions", { data: payload({ draft: draft(change), receiptKey: crypto.randomUUID().replaceAll("-", "").padEnd(43, "A") }) });
    assert.equal(response.response.status, 200, JSON.stringify(response.data));
    const id = response.data.id, saved = JSON.parse(h.env.DB.sqlite.prepare("SELECT draft_json FROM submissions WHERE id=?").get(id).draft_json);
    if (!change.catalogType) {
      assert.equal(saved.stock, "0");
      assert.equal(core.buildDefinition(saved).Stock, 0);
    } else assert.equal(Number(saved.stock), Number(change.stock));
    assert.equal((await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "decline", version: 1 } })).response.status, 200);
  }
});

test("reskins resolve decals to image IDs and reject meshes and off-host redirects", async t => {
  const h = harness(t), data = payload({
    kind: "reskin",
    draft: draft({
      name: "New reskin",
      customTexture: true,
      texture: "201"
    })
  });
  const result = await h.request("/api/submissions", {
    data: data
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  const stored = JSON.parse(h.env.DB.sqlite.prepare("SELECT draft_json FROM submissions").get().draft_json);
  assert.equal(stored.texture, "rbxassetid://200");
  for (const id of [ 202, 203 ]) assert.equal((await h.request("/api/texture/" + id)).response.status, 400);
  assert.ok(!h.stub.calls.some(call => call.url.includes("evil.test")));
});

test("submissions need no claimed username or message, and removed fields are rejected", async t => {
  const h = harness(t);
  for (const field of [ "username", "notes" ]) {
    assert.equal((await h.request("/api/submissions", { data: payload({ [field]: "Unverified identity" }) })).response.status, 400);
  }
  const first = await h.request("/api/submissions", { data: payload() });
  assert.equal(first.response.status, 200, JSON.stringify(first.data));
  const row = h.env.DB.sqlite.prepare("SELECT username,notes FROM submissions WHERE id=?").get(first.data.id);
  assert.equal(row.username, "Community");
  assert.equal(row.notes, "");
});

test("new uploads reject removed rewards, date schedules, and advanced placement", async t => {
  const h = harness(t);
  for (const changes of [
    { catalogType: "special", rewardSource: "Special" },
    { catalogType: "member", rewardSource: "Member" },
    { catalogType: "offsale" },
    { startMode: "date", startDate: "2036-10-31T12:00:00.000Z" },
    { endMode: "date", endDate: "2036-10-31T12:00:00.000Z" },
    { accessoryScale: "1.1" },
    { useOffset: true, offsetY: "1" },
    { rainbow: true }
  ]) {
    const result = await h.request("/api/submissions", { data: payload({ draft: draft(changes) }) });
    assert.equal(result.response.status, 400, JSON.stringify(changes));
  }
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM submissions").get().n, 0);
});

test("Limited U keeps finite stock and no mandatory timer through approval", async t => {
  const h = harness(t), proposal = draft({ catalogType: "limited-u", stock: "32" });
  const first = await h.request("/api/submissions", { data: payload({ draft: proposal }) });
  assert.equal(first.response.status, 200, JSON.stringify(first.data));
  const token = await h.login();
  const approval = await h.request("/api/admin/submissions/" + first.data.id, { token, method: "PATCH", data: { action: "approve", version: 1 } });
  assert.equal(approval.response.status, 200, JSON.stringify(approval.data));
  const record = await h.request("/api/admin/submissions/" + first.data.id, { token });
  const definition = core.buildDefinition(record.data.item.draft);
  assert.equal(definition.Stock, 32);
  assert.equal(definition.LimitedU, true);
  assert.equal(definition.MaxPerUser, 0);
  assert.equal(definition.OnsaleAt, undefined);
  assert.equal(definition.OffsaleAt, undefined);
});

test("classic face autofill extracts its image and official submissions use the canonical texture", async t => {
  const h = harness(t);
  const lookup = await h.request("/api/asset/106");
  assert.equal(lookup.response.status, 200);
  assert.equal(lookup.data.item.name, "Item 106");
  assert.equal(lookup.data.item.textureId, 200);
  assert.ok(h.stub.calls.some(call => call.url.includes("assetdelivery") && new URL(call.url).searchParams.get("version") === "1"));
  const proposal = draft({ name: "Automatic classic face", itemType: "Face", assetId: "106", texture: "205" });
  const submission = await h.request("/api/submissions", { data: payload({ draft: proposal }) });
  assert.equal(submission.response.status, 200, JSON.stringify(submission.data));
  const token = await h.login();
  const approval = await h.request("/api/admin/submissions/" + submission.data.id, { token, method: "PATCH", data: { action: "approve", version: 1 } });
  assert.equal(approval.response.status, 200, JSON.stringify(approval.data));
  assert.equal(approval.data.item.draft.texture, "rbxassetid://200");
  assert.equal(approval.data.item.draft.assetId, "106");
  const output = await h.request("/api/admin/submissions/" + submission.data.id, { token });
  const definition = core.buildDefinition(output.data.item.draft);
  assert.equal(definition.Texture, "rbxassetid://200");
  assert.equal(definition.AssetId, 106);
  await assert.rejects(checkKeys(h.env, [ "face-texture:200" ]), error => error.status === 409);
  assert.equal((await h.request("/api/asset/205")).response.status, 200);
});

test("face names search the classic archive even when the live catalog omits them", async t => {
  const h = harness(t);
  const search = await h.request("/api/search?q=Man%20Face&category=faces");
  assert.equal(search.response.status, 200, JSON.stringify(search.data));
  assert.equal(search.data.exactMatchId, 86487700);
  assert.equal(search.data.items[0].textureId, 83017053);
  assert.ok(search.data.items.every(item => item.assetType === 18 && item.creatorId === 1));
  const live = h.stub.calls.find(call => call.url.includes("catalog.roblox.com/v1/search"));
  assert.equal(new URL(live.url).searchParams.has("CreatorTargetId"), false);
  const first = await h.request("/api/search?q=face&category=faces");
  assert.ok(first.data.items.length >= 6);
  assert.match(first.data.nextCursor, /^faces:/);
  const next = await h.request("/api/search?q=face&category=faces&cursor=" + encodeURIComponent(first.data.nextCursor));
  assert.equal(next.response.status, 200);
  assert.ok(!next.data.items.some(item => first.data.items.some(previous => previous.id === item.id)));
  assert.equal((await h.request("/api/search?q=face&category=faces&cursor=classic:-1")).response.status, 400);
});

test("classic, dynamic asset, and bundle links resolve to the same classic face and image", async t => {
  const h = harness(t);
  for (const path of ["/api/face/7699174", "/api/face/15938951781", "/api/face/299652?kind=Bundle"]) {
    const result = await h.request(path);
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.item.id, 7699174);
    assert.equal(result.data.item.assetType, 18);
    assert.equal(result.data.item.kind, "Asset");
    assert.equal(result.data.item.textureId, 7699086);
    assert.equal(result.data.texture.id, 7699086);
    assert.equal(result.data.texture.assetType, 1);
    assert.equal(result.data.item.name, "Silly Fun");
    assert.match(result.data.item.description, /Silly Fun/);
  }
  const head = await h.request("/api/asset/15938951781");
  assert.equal(core.assetMapping(head.data.item.assetType, head.data.item.kind).itemType, "Face");
  assert.equal(head.data.item.textureId, 7699086);
});

test("unreadable heads stay heads and cannot become faces just by adopting a classic face name", async t => {
  const h = harness(t);
  assert.equal((await h.request("/api/face/205")).data.item.assetType, 79);
  assert.equal((await h.request("/api/face/100")).response.status, 400);
  assert.equal((await h.request("/api/face/301?kind=Bundle")).response.status, 400);
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await original(url, options);
    if (!String(url).includes("economy.roblox.com/v2/assets/205/")) return response;
    const item = await response.json();
    item.Name = "Silly Fun - Head";
    item.Creator.Id = 12;
    return Response.json(item);
  };
  assert.equal((await h.request("/api/face/205")).data.item.assetType, 79);
  assert.equal((await h.request("/api/asset/205")).response.status, 200);
});

test("resolved textures are verified as images and upstream rate limits remain retryable", async t => {
  const h = harness(t), original = globalThis.fetch;
  let denied = false;
  globalThis.fetch = async (url, options) => {
    if (!String(url).includes("economy.roblox.com/v2/assets/83017053/")) return original(url, options);
    if (denied) return new Response(null, { status: 429 });
    return Response.json({ AssetId: 83017053, AssetTypeId: 79, Name: "Dynamic head", Creator: { Id: 1, CreatorType: "User" } });
  };
  assert.equal((await h.request("/api/face/86487700")).response.status, 400);
  denied = true;
  const limited = await h.request("/api/face/86487700");
  assert.equal(limited.response.status, 429);
  assert.equal(limited.response.headers.get("Retry-After"), "60");
});

test("archived faces without saved ownership proof still verify Roblox ownership at selection", async t => {
  const h = harness(t), original = globalThis.fetch;
  const archive = JSON.parse(readFileSync(new URL("../data/classic-faces.json", import.meta.url), "utf8"));
  const face = archive.faces.find(face => !face.verifiedOfficial);
  assert.ok(face);
  globalThis.fetch = async (url, options) => {
    const response = await original(url, options);
    if (!String(url).includes("economy.roblox.com/v2/assets/" + face.id + "/")) return response;
    const item = await response.json();
    item.Creator = { Id: 12, CreatorType: "User", Name: "Other creator" };
    return Response.json(item);
  };
  assert.equal((await h.request("/api/face/" + face.id)).response.status, 400);
});

test("converted face submissions store classic identities and cannot bypass duplicate checks", async t => {
  const h = harness(t);
  const proposal = draft({ name: "Converted classic face", itemType: "Face", accessoryKind: "", assetId: "15938951781", texture: "15938951781" });
  const result = await h.request("/api/submissions", { data: payload({ draft: proposal }) });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  const stored = JSON.parse(h.env.DB.sqlite.prepare("SELECT draft_json FROM submissions WHERE id=?").get(result.data.id).draft_json);
  assert.equal(stored.assetId, "7699174");
  assert.equal(stored.texture, "rbxassetid://7699086");
  const duplicate = await h.request("/api/submissions", { data: payload({ receiptKey: "B".repeat(43), draft: { ...proposal, name: "Renamed same face", assetId: "7699174", texture: "7699086" } }) });
  assert.equal(duplicate.response.status, 409);
  const token = await h.login();
  const approved = await h.request("/api/admin/submissions/" + result.data.id, { token, method: "PATCH", data: { action: "approve", version: 1 } });
  assert.equal(approved.response.status, 200, JSON.stringify(approved.data));
  const definition = core.buildDefinition(approved.data.item.draft);
  assert.equal(definition.ItemType, "Face");
  assert.equal(definition.AssetId, 7699174);
  assert.equal(definition.Texture, "rbxassetid://7699086");
});

test("face reskins retain their verified replacement image instead of the default classic texture", async t => {
  const h = harness(t);
  const proposal = draft({ name: "Custom classic face", itemType: "Face", accessoryKind: "", assetId: "106", customTexture: true, texture: "204" });
  const result = await h.request("/api/submissions", { data: payload({ kind: "reskin", draft: proposal }) });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  const stored = JSON.parse(h.env.DB.sqlite.prepare("SELECT draft_json FROM submissions WHERE id=?").get(result.data.id).draft_json);
  assert.equal(stored.texture, "rbxassetid://204");
  const rejected = await h.request("/api/submissions", { data: payload({ kind: "reskin", receiptKey: "B".repeat(43), draft: { ...proposal, name: "Dynamic reskin", texture: "205" } }) });
  assert.equal(rejected.response.status, 400);
});

test("submission ownership and custom texture rules are enforced against forged requests", async t => {
  const h = harness(t);
  for (const [index, changes] of [ {
    assetId: "101"
  }, {
    assetId: "102"
  }, {
    customTexture: true,
    texture: "200"
  }, {
    itemType: "Tool"
  } ].entries()) {
    const result = await h.request("/api/submissions", {
      data: payload({
        receiptKey: String.fromCharCode(65 + index).repeat(43),
        draft: draft(changes)
      })
    });
    assert.equal(result.response.status, 400, JSON.stringify(result.data));
  }
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM submissions").get().n, 0);
});

test("owner records require a valid session and review decisions enforce current versions", async t => {
  const h = harness(t), submission = await h.request("/api/submissions", { data: payload() }), id = submission.data.id;
  for (const path of ["/api/admin/submissions", "/api/admin/generate", "/api/admin/submissions/" + id]) assert.equal((await h.request(path)).response.status, 401);
  const token = await h.login();
  const pending = await h.request("/api/admin/submissions/" + id, { token });
  assert.equal(pending.response.status, 200);
  assert.equal(pending.data.item.status, "pending");
  assert.equal(pending.data.item.receipt_hash, undefined);
  assert.equal(pending.data.item.ip_hash, undefined);
  assert.equal((await h.request("/api/admin/submissions/" + crypto.randomUUID(), { token })).response.status, 404);
  const approve = await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: {
    action: "approve", version: 1, draft: draft({ name: "Approved Hat", endMode: "duration", duration: "24" }), ownerNote: "Private note"
  } });
  assert.equal(approve.response.status, 200, JSON.stringify(approve.data));
  assert.equal(approve.data.item.version, 2);
  assert.equal((await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "decline", version: 1 } })).response.status, 409);
  const result = await h.request("/api/admin/submissions/" + id, { token });
  assert.equal(result.data.item.draft.name, "Approved Hat");
  assert.equal(result.data.item.ownerNote, "Private note");
  assert.equal(core.buildDefinition(result.data.item.draft).OffsaleAt.luaExpression, "os.time() + 86400");
  assert.equal((await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "decline", version: 2 } })).response.status, 200);
  assert.equal((await h.request("/api/admin/submissions/" + id, { token })).data.item.status, "declined");
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM review_log").get().n, 2);
});

test("incorrect keys, expiry, key rotation, and logout invalidate owner access", async t => {
  const h = harness(t);
  assert.equal((await h.request("/api/admin/login", {
    data: {
      key: "X".repeat(43),
      turnstileToken: "login-ok"
    }
  })).response.status, 401);
  let token = await h.login();
  h.env.DB.sqlite.prepare("UPDATE owner_sessions SET expires_at=1").run();
  assert.equal((await h.request("/api/admin/submissions", {
    token: token
  })).response.status, 401);
  token = await h.login();
  h.env.ADMIN_KEY_HASH = createHash("sha256").update("Y".repeat(43)).digest("hex");
  assert.equal((await h.request("/api/admin/submissions", {
    token: token
  })).response.status, 401);
  h.env.ADMIN_KEY_HASH = createHash("sha256").update(ownerKey).digest("hex");
  token = await h.login();
  assert.equal((await h.request("/api/admin/logout", {
    token: token,
    data: {}
  })).response.status, 200);
  assert.equal((await h.request("/api/admin/submissions", {
    token: token
  })).response.status, 401);
});

test("verification rejects failed tokens, mismatched actions, and mismatched hostnames", async t => {
  const h = harness(t);
  for (const [index, turnstileToken] of [ "bad", "wrong-action", "wrong-host" ].entries()) {
    assert.equal((await h.request("/api/submissions", {
      data: payload({
        turnstileToken: turnstileToken,
        receiptKey: String.fromCharCode(65 + index).repeat(43)
      })
    })).response.status, 403);
  }
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM submissions").get().n, 0);
});

test("allowed origins, required origins, and JSON body limits are enforced", async t => {
  const h = harness(t);
  assert.equal((await h.request("/api/submissions", {
    origin: "https://evil.test",
    data: payload()
  })).response.status, 403);
  const missing = await worker.fetch(new Request("https://catalog.test/api/submissions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload())
  }), h.env);
  assert.equal(missing.status, 403);
  const oversized = await h.request("/api/submissions", {
    data: payload({
      notes: "x".repeat(3e4)
    })
  });
  assert.equal(oversized.response.status, 413);
  assert.equal((await h.request("/api/submissions", {
    data: payload({
      execute: "evil"
    })
  })).response.status, 400);
  const preflight = await h.request("/api/submissions", {
    method: "OPTIONS"
  });
  assert.equal(preflight.response.status, 204);
  assert.equal(preflight.response.headers.get("Access-Control-Allow-Origin"), "https://catalog.test");
});

test("edge and atomic daily limits fail closed", async t => {
  const h = harness(t);
  h.env.SUBMISSIONS_PER_IP_PER_DAY = "1";
  assert.equal((await h.request("/api/submissions", {
    data: payload()
  })).response.status, 200);
  assert.equal((await h.request("/api/submissions", {
    data: payload({
      receiptKey: "B".repeat(43)
    })
  })).response.status, 429);
  h.env.REQUEST_LIMITER.limit = async () => ({
    success: false
  });
  assert.equal((await h.request("/api/asset/100")).response.status, 429);
  h.env.TURNSTILE_SECRET = "";
  assert.equal((await h.request("/api/config")).data.ready, false);
  assert.equal((await h.request("/api/admin/submissions")).response.status, 503);
});

test("submitted text stays data and owner records never expose server secrets", async t => {
  const h = harness(t), description = '"); warn("injected") --\n<svg onload=alert(1)>';
  const result = await h.request("/api/submissions", {
    data: payload({
      draft: draft({
        description: description
      })
    })
  });
  assert.equal(result.response.status, 200);
  const token = await h.login(), list = await h.request("/api/admin/submissions", {
    token: token
  });
  assert.equal(list.data.items[0].username, "Community");
  assert.equal(list.data.items[0].notes, "");
  assert.equal(list.data.items[0].receipt_hash, undefined);
  assert.equal(list.data.items[0].ip_hash, undefined);
  await h.request("/api/admin/submissions/" + result.data.id, {
    token: token,
    method: "PATCH",
    data: {
      action: "approve",
      version: 1
    }
  });
  const output = await h.request("/api/admin/submissions/" + result.data.id, { token });
  assert.equal(output.data.item.draft.description, description);
  assert.equal(output.data.item.receipt_hash, undefined);
  assert.equal(output.data.item.ip_hash, undefined);
  assert.equal((await h.request("/api/config")).data.ADMIN_KEY_HASH, undefined);
});

test("owner-created gear is registered and duplicate names are rejected before acceptance", async t => {
  const h = harness(t), token = await h.login();
  const first = await h.request("/api/admin/items", {
    token: token,
    data: {
      draft: draft({
        assetId: "999",
        itemType: "Tool",
        gearType: "Melee"
      })
    }
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.data.item.kind, "owner");
  const second = await h.request("/api/admin/items", {
    token: token,
    data: {
      draft: draft({
        assetId: "998"
      })
    }
  });
  assert.equal(second.response.status, 409);
  const result = await h.request("/api/admin/submissions/" + first.data.item.id, { token });
  assert.equal(result.response.status, 200);
  assert.equal(core.buildDefinition(result.data.item.draft).ItemType, "Tool");
});

test("invalid dates, numeric caps, and object-valued item fields are rejected", async t => {
  const h = harness(t);
  for (const changes of [ {
    price: "50001"
  }, {
    catalogType: "limited-u", stock: "501"
  }, {
    name: {
      luaExpression: "evil()"
    }
  }, {
    startMode: "date",
    startDate: "2036-01-01T12:00"
  } ]) {
    assert.equal((await h.request("/api/submissions", {
      data: payload({
        draft: draft(changes)
      })
    })).response.status, 400);
  }
});

test("a review changed during upstream validation cannot overwrite the newer decision or write a false audit entry",async t=>{
  const h=harness(t),submission=await h.request('/api/submissions',{data:payload()}),token=await h.login(),id=submission.data.id;
  let release,arrived;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>arrived=resolve);
  globalThis.fetch=async(input,options)=>{if(String(input).includes('economy.roblox.com/v2/assets/100/details')){arrived();await gate;}return h.stub.fetch(input,options);};
  const approval=h.request('/api/admin/submissions/'+id,{token,method:'PATCH',data:{action:'approve',version:1}});
  await started;
  const decline=await h.request('/api/admin/submissions/'+id,{token,method:'PATCH',data:{action:'decline',version:1}});assert.equal(decline.response.status,200);
  release();const result=await approval;assert.equal(result.response.status,409);
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM submissions WHERE id=?').get(id).status,'declined');
  assert.equal(h.env.DB.sqlite.prepare('SELECT COUNT(*) n FROM review_log').get().n,1);
});

test("static documents have security headers and cannot serve backend source",async t=>{
  const h=harness(t);h.env.ASSETS={fetch:async()=>new Response('<!doctype html>',{headers:{'Content-Type':'text/html'}})};
  const response=await worker.fetch(new Request('https://catalog.test/review.html'),h.env);assert.equal(response.status,200);assert.equal(response.headers.get('X-Frame-Options'),'DENY');assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
  for(const path of ['/server/publisher.js','/tests/support.mjs','/README.md'])assert.equal((await worker.fetch(new Request('https://catalog.test'+path),h.env)).status,404);
});

test("the removed code export endpoint remains unavailable to signed-in owners", async t => {
  const h = harness(t), token = await h.login();
  const item = await h.request("/api/admin/items", { token, data: { draft: draft({ name: "Approved record", assetId: "999" }) } });
  assert.equal(item.response.status, 200);
  for (const mode of ["items", "full"]) {
    const result = await h.request("/api/admin/generate", { token, data: { items: [{ id: item.data.item.id, version: 1 }], mode } });
    assert.equal(result.response.status, 404);
    assert.equal(result.data.code, undefined);
  }
});

test("all 407 supplied items are registered, including 58 items without IDs", async t => {
  const h = harness(t), seed = JSON.parse(readFileSync(new URL("../data/current-items.json", import.meta.url), "utf8"));
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM catalog_items WHERE source='existing'").get().n, 407);
  assert.equal(seed.filter(item => Number(item.assetId) === 0).length, 58);
  for (const item of seed) await assert.rejects(checkKeys(h.env, core.registryKeys(item)), error => error.status === 409, item.name);
  assert.equal((await h.request("/api/admin/catalog")).response.status, 401);
  const token = await h.login(), list = await h.request("/api/admin/catalog", { token });
  assert.equal(list.data.count, 407);
  assert.ok(list.data.items.some(item => item.name === "Zombie face" && item.assetId === 991219580));
});

test("existing names, Unicode disguises, and renamed existing asset IDs are blocked", async t => {
  const h = harness(t);
  for (const [index, changes] of [ { name: "Black Iron Branches" }, { name: "  ＢＬＡＣＫ  ＩＲＯＮ  ＢＲＡＮＣＨＥＳ  " }, { name: "Different Zombie", assetId: "133559536" } ].entries()) {
    const result = await h.request("/api/submissions", { data: payload({ receiptKey: String.fromCharCode(70 + index).repeat(43), draft: draft(changes) }) });
    assert.equal(result.response.status, 409, JSON.stringify(result.data));
  }
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM submissions").get().n, 0);
  const check = await h.request("/api/check-item", { data: { kind: "official", draft: { name: "Black Iron Branches", assetId: "100", itemType: "Hat", customTexture: false, texture: "" } } });
  assert.equal(check.response.status, 409);
});

test("pending items block duplicate IDs; declining an unaccepted item releases its reservation", async t => {
  const h = harness(t), first = await h.request("/api/submissions", { data: payload() });
  const duplicate = await h.request("/api/submissions", { data: payload({ receiptKey: "B".repeat(43), draft: draft({ name: "Renamed original" }) }) });
  assert.equal(duplicate.response.status, 409);
  const token = await h.login();
  assert.equal((await h.request("/api/admin/submissions/" + first.data.id, { token, method: "PATCH", data: { action: "decline", version: 1 } })).response.status, 200);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM pending_keys").get().n, 0);
  assert.equal((await h.request("/api/submissions", { data: payload({ receiptKey: "C".repeat(43) }) })).response.status, 200);
});

test("approval adds to the shared list immediately; edits preserve old keys and declines retain accepted items", async t => {
  const h = harness(t), submission = await h.request("/api/submissions", { data: payload() }), token = await h.login(), id = submission.data.id;
  const approve = await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "approve", version: 1 } });
  assert.equal(approve.response.status, 200, JSON.stringify(approve.data));
  assert.equal((await h.request("/api/admin/catalog", { token })).data.count, 408);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM pending_keys").get().n, 0);
  const edited = await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "approve", version: 2, draft: draft({ name: "Updated accepted name", accessoryKind: "WaistBack" }) } });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.data));
  const list = (await h.request("/api/admin/catalog", { token })).data;
  assert.equal(list.count, 408);
  assert.equal(list.items.find(item => item.source === "accepted").accessoryKind, "WaistBack");
  await assert.rejects(checkKeys(h.env, [ "name:classic hat" ]), error => error.status === 409);
  await h.request("/api/admin/submissions/" + id, { token, method: "PATCH", data: { action: "decline", version: 3 } });
  assert.equal((await h.request("/api/admin/catalog", { token })).data.count, 408);
  assert.equal((await h.request("/api/submissions", { data: payload({ receiptKey: "Z".repeat(43) }) })).response.status, 409);
});

test("new reskins may reuse an existing base while repeated base and resolved image pairs are blocked", async t => {
  const h = harness(t), item = draft({ name: "Brand new zombie reskin", assetId: "133559536", customTexture: true, texture: "201" });
  const first = await h.request("/api/submissions", { data: payload({ kind: "reskin", draft: item }) });
  assert.equal(first.response.status, 200, JSON.stringify(first.data));
  const duplicate = await h.request("/api/submissions", { data: payload({ kind: "reskin", receiptKey: "B".repeat(43), draft: { ...item, name: "Renamed same reskin", texture: "200" } }) });
  assert.equal(duplicate.response.status, 409);
});

test("concurrent duplicate submissions are atomic and concurrent receipt retries remain idempotent", async t => {
  const h = harness(t);
  const submissions = await Promise.all([ h.request("/api/submissions", { data: payload() }), h.request("/api/submissions", { data: payload({ receiptKey: "B".repeat(43), draft: draft({ name: "Concurrent rename" }) }) }) ]);
  assert.deepEqual(submissions.map(item => item.response.status).sort(), [ 200, 409 ]);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM submissions").get().n, 1);
  const retries = await Promise.all([0, 1].map(() => h.request("/api/submissions", { ip: "192.0.2.99", data: payload({ receiptKey: "C".repeat(43), draft: draft({ assetId: "104", itemType: "Hair", name: "Concurrent hair", accessoryKind: "Hair" }) }) })));
  assert.deepEqual(retries.map(item => item.response.status), [ 200, 200 ]);
  assert.equal(retries[0].data.id, retries[1].data.id);
});

test("public gear, classic heads, faces, shoes, and body packages verify their real types and creator", async t => {
  const h = harness(t);
  h.env.SUBMISSIONS_PER_IP_PER_DAY = "20";
  for (const [index, [assetId, itemType, accessoryKind, texture]] of [ ["103", "Tool", "", ""], ["105", "Head", "", ""], ["106", "Face", "", "200"], ["107", "Hat", "Ear", ""], ["108", "Hat", "LeftShoe", ""], ["109", "Hat", "RightShoe", ""], ["300", "BodyPackage", "", ""] ].entries()) {
    const result = await h.request("/api/submissions", { data: payload({ receiptKey: String.fromCharCode(70 + index).repeat(43), draft: draft({ assetId, itemType, accessoryKind, texture, name: "New " + itemType + " " + index }) }) });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
  }
  assert.equal((await h.request("/api/asset/106")).data.item.textureId, 200);
  assert.equal((await h.request("/api/asset/301?kind=Bundle")).response.status, 400);
  assert.equal((await h.request("/api/submissions", { data: payload({ receiptKey: "Z".repeat(43), draft: draft({ assetId: "103", itemType: "Head", name: "Forged head" }) }) })).response.status, 400);
});

test("bundle and asset namespaces stay separate and failed approval leaves the list and audit unchanged", async t => {
  const h = harness(t), first = await h.request("/api/submissions", { data: payload() }), token = await h.login();
  const bundle = await h.request("/api/submissions", { data: payload({ receiptKey: "B".repeat(43), draft: draft({ itemType: "BodyPackage", assetId: "100", name: "Separate bundle" }) }) });
  assert.equal(bundle.response.status, 200, JSON.stringify(bundle.data));
  const collision = await h.request("/api/admin/submissions/" + first.data.id, { token, method: "PATCH", data: { action: "approve", version: 1, draft: draft({ name: "Zombie face" }) } });
  assert.equal(collision.response.status, 409);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM catalog_items").get().n, 407);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM review_log").get().n, 0);
  assert.equal(h.env.DB.sqlite.prepare("SELECT version FROM submissions WHERE id=?").get(first.data.id).version, 1);
});

test("upgrading an existing database preserves records and protects old accepted items and face textures", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    const migration = name => readFileSync(new URL("../migrations/" + name, import.meta.url), "utf8");
    sqlite.exec(migration("0001_catalog.sql"));
    const insert = sqlite.prepare("INSERT INTO submissions(id,kind,username,status,draft_json,base_json,created_at,updated_at,receipt_hash) VALUES(?,'official','HatMaker',?,?,?,1,1,?)");
    insert.run("legacy-approved", "approved", JSON.stringify(draft({ name: "Legacy accepted gear", itemType: "Tool", assetId: "999" })), JSON.stringify({ name: "Original gear name" }), "legacy-receipt");
    insert.run("legacy-face", "approved", JSON.stringify(draft({ name: "Legacy accepted face", itemType: "Face", assetId: "106", texture: "rbxassetid://200" })), "{}", "face-receipt");
    insert.run("legacy-pending", "pending", JSON.stringify(draft({ name: "Legacy pending" })), "{}", "pending-receipt");
    sqlite.exec(migration("0002_existing_catalog.sql"));
    sqlite.exec(migration("0003_seed_catalog.sql"));
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM submissions").get().n, 3);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM catalog_items").get().n, 409);
    assert.equal(sqlite.prepare("SELECT item_id FROM catalog_keys WHERE key='asset:999'").get().item_id, "legacy-approved");
    assert.equal(sqlite.prepare("SELECT item_id FROM catalog_keys WHERE key='name:original gear name'").get().item_id, "legacy-approved");
    assert.equal(sqlite.prepare("SELECT item_id FROM catalog_keys WHERE key='face-texture:200'").get().item_id, "legacy-face");
    assert.equal(sqlite.prepare("SELECT submission_id FROM pending_keys WHERE key='asset:100'").get().submission_id, "legacy-pending");
    assert.equal(sqlite.prepare("SELECT receipt_hash FROM submissions WHERE id='legacy-approved'").get().receipt_hash, "legacy-receipt");
  } finally {
    sqlite.close();
  }
});

test("dynamic-head bundle links resolve to the actual Head asset before submission", async t => {
  const h = harness(t), original = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.pathname === "/v1/bundles/302/details") return Response.json({ id: 302, bundleType: "DynamicHead", creator: { id: 1, type: "User", name: "Roblox" }, items: [{ id: 205, type: "Asset" }, { id: 9999, type: "Asset" }] });
    if (target.pathname === "/v1/catalog/items/details" && options.method === "POST") {
      assert.deepEqual(JSON.parse(options.body).items.map(item => item.id), [205, 9999]);
      return Response.json({ data: [{ id: 205, assetType: 79 }, { id: 9999, assetType: 78 }] });
    }
    return original(url, options);
  };
  const lookup = await h.request("/api/asset/302?kind=Bundle");
  assert.equal(lookup.response.status, 200, JSON.stringify(lookup.data));
  assert.equal(lookup.data.item.id, 205);
  assert.equal(lookup.data.item.kind, "Asset");
  assert.equal(core.assetMapping(lookup.data.item.assetType, lookup.data.item.kind).itemType, "Head");
  assert.match(lookup.data.item.thumbnail, /205\.png$/);
  const result = await h.request("/api/submissions", { data: payload({ draft: draft({ name: "Bundle Head", itemType: "Head", assetId: "205", accessoryKind: "" }) }) });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.equal(JSON.parse(h.env.DB.sqlite.prepare("SELECT registry_json FROM submissions WHERE id=?").get(result.data.id).registry_json).includes("asset:205"), true);
});

test("ambiguous dynamic-head bundles fail safely without importing animations as heads", async t => {
  const h = harness(t);
  globalThis.fetch = async (url, options = {}) => {
    const target = new URL(String(url));
    if (target.pathname.includes("/bundles/302/details")) return Response.json({ id: 302, bundleType: 4, creator: { id: 1, type: "User", name: "Roblox" }, items: [{ id: 205, type: "Asset" }, { id: 15093053680, type: "Asset" }] });
    if (target.pathname.includes("/catalog/items/details")) return Response.json({ data: [{ id: 205, assetType: 79 }, { id: 15093053680, assetType: 79 }] });
    return h.stub.fetch(url, options);
  };
  const result = await h.request("/api/asset/302?kind=Bundle");
  assert.equal(result.response.status, 400);
  assert.match(result.data.error, /single supported head/);
  assert.equal(h.env.DB.sqlite.prepare("SELECT COUNT(*) n FROM submissions").get().n, 0);
});

test("head search includes other creators without relaxing accessory search", async t => {
  const h = harness(t), original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const target = new URL(String(url));
    if (target.hostname === "catalog.roblox.com" && target.pathname.includes("search")) {
      if (target.searchParams.get("Category") === "1") {
        assert.equal(target.searchParams.has("CreatorTargetId"), false);
        assert.equal(target.searchParams.has("CreatorType"), false);
        return Response.json({ data: [{ id: 205, itemType: "Asset", name: "Creator Head", assetType: 79, creatorType: "User", creatorTargetId: 12, creatorName: "Head Creator" }, { id: 105, itemType: "Asset", name: "Group Head", assetType: 17, creatorType: "Group", creatorTargetId: 23, creatorName: "Head Group" }, { id: 101, itemType: "Asset", name: "UGC Hat", assetType: 8, creatorType: "User", creatorTargetId: 12 }], nextPageCursor: null });
      }
      assert.equal(target.searchParams.get("CreatorTargetId"), "1");
    }
    return original(url, options);
  };
  const result = await h.request("/api/search?q=Creator%20Head&category=heads");
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data.items.map(item => item.id), [205, 105]);
  assert.equal(result.data.exactMatchId, 205);
  assert.deepEqual((await h.request("/api/search?q=Classic%20Hat&category=accessories")).data.items.map(item => item.id), [100]);
});

const headCatalog = JSON.parse(readFileSync(new URL('./fixtures/head-catalog.json', import.meta.url)));
const headBundles = new Map(headCatalog.bundles.map(item => [item.id, item]));
const headAssets = new Map(headCatalog.assets.map(item => [item.AssetId, item]));
const defaultMesh = readFileSync(new URL('./fixtures/default-head.mesh', import.meta.url));
const roundMesh = readFileSync(new URL('./fixtures/round-head.mesh', import.meta.url));
const headModel = (meshId, decal = '') => '<roblox><Item class="SpecialMesh"><Properties><token name="MeshType">5</token><Content name="MeshId"><url>rbxassetid://' + meshId + '</url></Content><Content name="TextureId"><url>rbxassetid://204</url></Content></Properties></Item>' + decal + '</roblox>';
const frontDecal = '<Item class="Decal"><Properties><token name="Face">5</token><Content name="Texture"><url>rbxassetid://204</url></Content></Properties></Item>';

function headUpstream(h) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(String(input)), id = Number(url.pathname.split('/')[3]);
    if (url.hostname === 'economy.roblox.com') {
      if (headAssets.has(id)) return Response.json(headAssets.get(id));
      if ([9001,9002,9003,9004].includes(id)) return Response.json({ AssetId: id, Name: 'New Face ' + id + ' - Dynamic Head', Description: 'Original UGC description', AssetTypeId: id === 9003 ? 18 : 79, Creator: { Id: id === 9002 ? 23 : 12, CreatorTargetId: id === 9002 ? 23 : 12, CreatorType: id === 9002 ? 'Group' : 'User', Name: 'UGC creator' } });
    }
    if (url.hostname === 'catalog.roblox.com' && headBundles.has(id) && url.pathname.endsWith('/details')) return Response.json(headBundles.get(id));
    if (url.hostname === 'assetdelivery.roblox.com') {
      const asset = Number(url.searchParams.get('id'));
      if (asset === 90050) return new Response(defaultMesh);
      if (asset === 90051) return new Response(roundMesh);
      if (asset === 9001) return new Response(headModel(90050));
      if (asset === 9002) return new Response(headModel(90050, frontDecal));
      if (asset === 9004) return new Response(headModel(90051, frontDecal));
    }
    return original(input, options);
  };
}

test('all six supplied bundle and head links select the correct item type and classic image', async t => {
  const h = harness(t);headUpstream(h);const token = await h.login();
  const examples = [
    [119419790090149,90451873203405,7074595,7046277],
    [43761506463462,95240587613909,42070576,42070872],
    [265852627205962,138449291541015,7131886,7131857],
    [4110,14629530741,null,null], [3935,14619697404,null,null], [51370,15054261012,null,null]
  ];
  for (const [bundle,asset,classic,texture] of examples) for (const path of ['/api/asset/'+bundle+'?kind=Bundle','/api/face/'+bundle+'?kind=Bundle','/api/asset/'+asset,'/api/face/'+asset,'/api/admin/asset/'+bundle+'?kind=Bundle','/api/admin/asset/'+asset]) {
    const result = await h.request(path,{token});
    assert.equal(result.response.status,200,JSON.stringify(result.data));
    assert.equal(core.assetMapping(result.data.item.assetType,result.data.item.kind).itemType,classic ? 'Face' : 'Head');
    assert.equal(result.data.item.id,classic || asset);
    if (classic) {
      assert.equal(result.data.item.textureId,texture);
      assert.equal(result.data.texture.assetType,1);
    } else assert.equal(result.data.item.textureId,undefined);
  }
});

test('UGC classic faces and front decals are accepted without importing their head mesh texture', async t => {
  const h = harness(t);headUpstream(h);
  const classic = await h.request('/api/face/9003');
  assert.equal(classic.response.status,200,JSON.stringify(classic.data));
  assert.equal(classic.data.item.creatorId,12);
  assert.equal(classic.data.item.textureId,200);
  const lookup = await h.request('/api/asset/9002');
  assert.equal(lookup.response.status,200,JSON.stringify(lookup.data));
  assert.equal(lookup.data.item.assetType,18);
  assert.equal(lookup.data.item.robloxAssetType,79);
  assert.equal(lookup.data.item.creatorType,'Group');
  assert.equal(lookup.data.item.textureId,204);
  const proposal = draft({name:'UGC front face',itemType:'Face',assetId:'9002',accessoryKind:'',texture:'200'});
  const submitted = await h.request('/api/submissions',{data:payload({draft:proposal})});
  assert.equal(submitted.response.status,200,JSON.stringify(submitted.data));
  const token = await h.login();
  const approved = await h.request('/api/admin/submissions/'+submitted.data.id,{method:'PATCH',token,data:{action:'approve',version:1}});
  assert.equal(approved.response.status,200,JSON.stringify(approved.data));
  const definition = core.buildDefinition(approved.data.item.draft);
  assert.equal(definition.ItemType,'Face');assert.equal(definition.AssetId,9002);assert.equal(definition.Texture,'rbxassetid://204');
  const duplicate = await h.request('/api/submissions',{data:payload({receiptKey:'B'.repeat(43),draft:{...proposal,name:'Renamed UGC face'}})});
  assert.equal(duplicate.response.status,409);
});

test('standard UGC heads need a standalone face image when there is no classic counterpart; shaped heads cannot use this fallback', async t => {
  const h = harness(t);headUpstream(h);
  const face = await h.request('/api/asset/9001');
  assert.equal(face.response.status,200,JSON.stringify(face.data));
  assert.equal(face.data.item.assetType,18);
  assert.equal(face.data.item.faceTextureRequired,true);
  assert.equal(face.data.item.textureId,null);
  assert.equal(face.data.texture,null);
  const proposal = draft({name:'New UGC face',itemType:'Face',assetId:'9001',accessoryKind:'',texture:'204'});
  for (const changes of [{texture:''},{texture:'205'},{itemType:'Head'}]) {
    const result = await h.request('/api/submissions',{data:payload({draft:{...proposal,...changes}})});
    assert.equal(result.response.status,400,JSON.stringify(result.data));
  }
  const submitted = await h.request('/api/submissions',{data:payload({draft:proposal})});
  assert.equal(submitted.response.status,200,JSON.stringify(submitted.data));
  const row = JSON.parse(h.env.DB.sqlite.prepare('SELECT draft_json FROM submissions WHERE id=?').get(submitted.data.id).draft_json);
  assert.equal(row.texture,'rbxassetid://204');assert.equal(row.assetId,'9001');
  const shaped = await h.request('/api/asset/9004');
  assert.equal(shaped.data.item.assetType,79);assert.equal(shaped.data.item.textureId,undefined);
  assert.equal((await h.request('/api/submissions',{data:payload({receiptKey:'C'.repeat(43),draft:{...proposal,assetId:'9004',name:'Shaped counterfeit face'}})})).response.status,400);
});

test('UGC replica faces reserve the original face and texture identity, and cannot be submitted as heads', async t => {
  const h = harness(t);headUpstream(h);
  const proposal = draft({name:'Contributor Epic face',itemType:'Face',assetId:'95240587613909',accessoryKind:'',texture:'205'});
  assert.equal((await h.request('/api/submissions',{data:payload({draft:{...proposal,itemType:'Head'}})})).response.status,400);
  assert.equal((await h.request('/api/submissions',{data:payload({draft:proposal})})).response.status,409);
  h.env.DB.sqlite.prepare('DELETE FROM catalog_keys WHERE item_id=?').run('existing:015');
  h.env.DB.sqlite.prepare('DELETE FROM catalog_items WHERE id=?').run('existing:015');
  const first = await h.request('/api/submissions',{data:payload({draft:proposal})});
  assert.equal(first.response.status,200,JSON.stringify(first.data));
  const stored = JSON.parse(h.env.DB.sqlite.prepare('SELECT draft_json FROM submissions WHERE id=?').get(first.data.id).draft_json);
  assert.equal(stored.assetId,'42070576');assert.equal(stored.texture,'rbxassetid://42070872');
  assert.equal((await h.request('/api/submissions',{data:payload({receiptKey:'B'.repeat(43),draft:{...proposal,assetId:'42070576',name:'Another Epic face'}})})).response.status,409);
  const token = await h.login();
  const rejected = await h.request('/api/admin/submissions/'+first.data.id,{method:'PATCH',token,data:{action:'approve',version:1,draft:{...stored,itemType:'Head'}}});
  assert.equal(rejected.response.status,400);
  assert.equal(h.env.DB.sqlite.prepare('SELECT status FROM submissions WHERE id=?').get(first.data.id).status,'pending');
});

test('face name search includes UGC dynamic bundles, keeps archive faces available during outages, and bounds cursor input', async t => {
  const h = harness(t), original = globalThis.fetch;
  let unavailable = false;
  globalThis.fetch = async (input,options) => {
    const url = new URL(String(input));
    if (url.hostname === 'catalog.roblox.com' && url.pathname.includes('/search/')) {
      assert.equal(url.searchParams.has('CreatorTargetId'),false);
      if (unavailable) return new Response(null,{status:503});
      return Response.json({data:[{id:43761506463462,itemType:'Bundle',bundleType:4,name:'Epic Face',creatorType:'User',creatorTargetId:166533394,creatorName:'infchris'},{id:101,itemType:'Asset',assetType:8,name:'UGC hat',creatorType:'User',creatorTargetId:12}],nextPageCursor:null});
    }
    return original(input,options);
  };
  const result = await h.request('/api/search?q=Epic%20Face&category=faces');
  assert.equal(result.response.status,200,JSON.stringify(result.data));
  assert.ok(result.data.items.some(item=>item.kind==='Bundle' && item.creatorId===166533394));
  assert.ok(result.data.items.some(item=>item.id===42070576));
  assert.ok(!result.data.items.some(item=>item.id===101));
  unavailable = true;
  const offline = await h.request('/api/search?q=Man%20Face&category=faces');
  assert.equal(offline.response.status,200);assert.equal(offline.data.exactMatchId,86487700);assert.match(offline.data.message,/Live Roblox results/);
  for (const state of [null,[],{offset:-1,live:'',liveDone:true},{offset:0,live:'x'.repeat(1001),liveDone:false}]) assert.equal((await h.request('/api/search?q=face&category=faces&cursor='+encodeURIComponent('faces:'+btoa(JSON.stringify(state))))).response.status,400);
});

test('head inspection propagates upstream limits and refuses foreign content redirects', async t => {
  const h = harness(t);headUpstream(h);const original = globalThis.fetch;
  let limited = true, external = false;
  globalThis.fetch = async (input,options) => {
    const url = new URL(String(input));
    if (url.hostname === 'assetdelivery.roblox.com' && url.searchParams.get('id')==='9001') return limited ? new Response(null,{status:429}) : new Response(null,{status:302,headers:{Location:'https://evil.test/private'}});
    if (url.hostname === 'evil.test') external = true;
    return original(input,options);
  };
  const limit = await h.request('/api/asset/9001');assert.equal(limit.response.status,429);assert.equal(limit.response.headers.get('Retry-After'),'60');
  limited = false;
  const unsafe = await h.request('/api/asset/9001');assert.equal(unsafe.response.status,502);assert.equal(external,false);
});
