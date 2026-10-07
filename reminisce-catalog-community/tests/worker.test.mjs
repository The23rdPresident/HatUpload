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
  username: "HatMaker",
  notes: "For the next drop",
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
      notes: "changed"
    }
  })).response.status, 409);
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

test("owner routes require a valid session and enforce approved-only versioned exports", async t => {
  const h = harness(t), submission = await h.request("/api/submissions", {
    data: payload()
  }), id = submission.data.id;
  for (const path of [ "/api/admin/submissions", "/api/admin/generate", "/api/admin/submissions/" + id ]) assert.equal((await h.request(path, {
    method: path.includes(id) ? "PATCH" : "GET"
  })).response.status, 401);
  const token = await h.login();
  let result = await h.request("/api/admin/generate", {
    token: token,
    data: {
      items: [ {
        id: id,
        version: 1
      } ],
      mode: "items"
    }
  });
  assert.equal(result.response.status, 409);
  const approve = await h.request("/api/admin/submissions/" + id, {
    token: token,
    method: "PATCH",
    data: {
      action: "approve",
      version: 1,
      draft: draft({
        name: "Approved Hat",
        endMode: "duration",
        duration: "24"
      }),
      ownerNote: "Private note"
    }
  });
  assert.equal(approve.response.status, 200, JSON.stringify(approve.data));
  assert.equal(approve.data.item.version, 2);
  assert.equal((await h.request("/api/admin/submissions/" + id, {
    token: token,
    method: "PATCH",
    data: {
      action: "decline",
      version: 1
    }
  })).response.status, 409);
  result = await h.request("/api/admin/generate", {
    token: token,
    data: {
      items: [ {
        id: id,
        version: 2
      } ],
      mode: "full"
    }
  });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  assert.match(result.data.code, /Approved Hat/);
  assert.match(result.data.code, /OffsaleAt = os.time\(\) \+ 86400/);
  assert.match(result.data.code, /store:UpdateAsync/);
  await h.request("/api/admin/submissions/" + id, {
    token: token,
    method: "PATCH",
    data: {
      action: "decline",
      version: 2
    }
  });
  assert.equal((await h.request("/api/admin/generate", {
    token: token,
    data: {
      items: [ {
        id: id,
        version: 2
      } ],
      mode: "items"
    }
  })).response.status, 409);
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

test("SQL and Lua treat submitted text as data and never expose server secrets", async t => {
  const h = harness(t), description = '"); warn("injected") --\n<svg onload=alert(1)>';
  const result = await h.request("/api/submissions", {
    data: payload({
      notes: "'; DROP TABLE submissions; --",
      draft: draft({
        description: description
      })
    })
  });
  assert.equal(result.response.status, 200);
  const token = await h.login(), list = await h.request("/api/admin/submissions", {
    token: token
  });
  assert.equal(list.data.items[0].notes, "'; DROP TABLE submissions; --");
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
  const output = await h.request("/api/admin/generate", {
    token: token,
    data: {
      items: [ {
        id: result.data.id,
        version: 2
      } ],
      mode: "items"
    }
  });
  assert.match(output.data.code, /Description = "\\"\); warn\(\\"injected\\"\)/);
  assert.match(output.data.code, /\\n<svg/);
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
  const result = await h.request("/api/admin/generate", {
    token: token,
    data: {
      items: [ {
        id: first.data.item.id,
        version: 1
      } ],
      mode: "items"
    }
  });
  assert.equal(result.response.status, 200);
  assert.match(result.data.code, /ItemType = "Tool"/);
});

test("invalid dates, numeric caps, and object-valued item fields are rejected", async t => {
  const h = harness(t);
  for (const changes of [ {
    price: "1000000001"
  }, {
    stock: "1000001"
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

test("the full 500-item export preserves selection order and validates every approved record",async t=>{
  const h=harness(t),token=await h.login(),items=[];
  const insert=h.env.DB.sqlite.prepare("INSERT INTO submissions(id,kind,username,status,draft_json,base_json,created_at,updated_at,registry_json) VALUES(?,'owner','Owner','approved',?,'{}',1,1,?)");
  for(let index=0;index<500;index++){const id=crypto.randomUUID(),item=draft({name:'Batch item '+index,assetId:String(900000+index)});insert.run(id,JSON.stringify(item),JSON.stringify(core.registryKeys(item)));items.push({id,version:1});}
  const result=await h.request('/api/admin/generate',{token,data:{items,mode:'items'}});assert.equal(result.response.status,200,JSON.stringify(result.data));assert.equal(result.data.count,500);
  assert.ok(result.data.code.indexOf('Batch item 49"')<result.data.code.indexOf('Batch item 50"'));assert.match(result.data.code,/Batch item 499/);
  h.env.DB.sqlite.prepare("UPDATE submissions SET status='pending' WHERE id=?").run(items[450].id);
  assert.equal((await h.request('/api/admin/generate',{token,data:{items,mode:'items'}})).response.status,409);
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
