import "../shared/core.js";

import { ApiError, officialAsset, textureAsset } from "./catalog.js";

import { body, keys, now, token, digest, ipHash, budget, challenge, equalHash } from "./security.js";

import publisher from "./publisher.js";
import { claims, checkKeys, registryError } from "./registry.js";

const core = globalThis.CatalogCore;

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const statuses = [ "pending", "approved", "declined" ];

function text(value, max, label) {
  if (typeof value !== "string" || value.length > max) throw new ApiError(label + " is too long or invalid.", 400);
  return value.trim();
}

export function draftInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApiError("Item details are required.", 400);
  const defaults = core.defaults();
  keys(value, Object.keys(defaults));
  const draft = {
    ...defaults
  };
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== typeof defaults[key]) throw new ApiError("Invalid item field: " + key, 400);
    if (typeof item === "string" && item.length > (key === "description" ? 12e3 : 200)) throw new ApiError("Item field is too long: " + key, 400);
    draft[key] = item;
  }
  for (const key of [ "startDate", "endDate" ]) {
    if (draft[key] && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(draft[key])) throw new ApiError("Dates must include their UTC timezone.", 400);
  }
  const errors = core.validate(draft);
  if (errors.length) throw new ApiError(errors.join(" "), 400);
  if (Number(draft.price) > 1e9 || Number(draft.stock) > 1e6) throw new ApiError("Price or stock exceeds the supported limit.", 400);
  draft.name = draft.name.trim();
  draft.assetId = String(Number(draft.assetId));
  if (draft.texture) draft.texture = core.assetContent(draft.texture) || draft.texture;
  if (draft.template) draft.template = core.assetContent(draft.template) || draft.template;
  return draft;
}

async function verifiedDraft(value, kind) {
  const draft = draftInput(value);
  if (kind === "owner") return {
    draft: draft,
    base: {
      id: Number(draft.assetId),
      name: draft.name,
      kind: draft.itemType === "BodyPackage" ? "Bundle" : "Asset"
    },
    texture: null
  };
  const base = await officialAsset(draft.assetId, draft.itemType === "BodyPackage" ? "Bundle" : "Asset");
  const mapping = core.assetMapping(base.assetType, base.kind);
  if (!(core.isAccessory(mapping.itemType) && core.isAccessory(draft.itemType)) && draft.itemType !== mapping.itemType) throw new ApiError("Item type must match the verified Roblox item.", 400);
  if (kind === "official" && draft.customTexture) throw new ApiError("Choose a custom reskin to replace the base texture.", 400);
  if (kind === "reskin" && !draft.customTexture) throw new ApiError("A custom reskin needs a replacement texture.", 400);
  if (kind === "reskin" && !(core.isAccessory(draft.itemType) || draft.itemType === "Face")) throw new ApiError("Reskins require an accessory or classic face base.", 400);
  if (kind === "reskin" && core.nameKey(draft.name) === core.nameKey(base.name)) throw new ApiError("Give your reskin its own catalog name.", 400);
  let texture = null;
  if (kind === "reskin") {
    texture = await textureAsset(core.assetContent(draft.texture)?.split("//")[1]);
    draft.texture = "rbxassetid://" + texture.id;
  } else if (draft.itemType === "Face") {
    texture = await textureAsset(base.id, true);
    draft.texture = "rbxassetid://" + texture.id;
  } else {
    draft.texture = "";
  }
  return {
    draft: draft,
    base: base,
    texture: texture
  };
}

function record(row) {
  return {
    id: row.id,
    kind: row.kind,
    username: row.username,
    notes: row.notes,
    status: row.status,
    draft: JSON.parse(row.draft_json),
    base: JSON.parse(row.base_json),
    texture: row.texture_json ? JSON.parse(row.texture_json) : null,
    ownerNote: row.owner_note,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function limit(value, fallback, max) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
}

export async function submit(request, env) {
  const data = await body(request);
  keys(data, [ "kind", "username", "notes", "draft", "turnstileToken", "receiptKey" ]);
  if (![ "official", "reskin" ].includes(data.kind)) throw new ApiError("Choose a catalog item or a custom reskin.", 400);
  const username = text(data.username, 20, "Roblox username");
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new ApiError("Enter a Roblox username of 3–20 letters, numbers, or underscores.", 400);
  const notes = text(data.notes || "", 2e3, "Submission message");
  if (typeof data.receiptKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.receiptKey)) throw new ApiError("Invalid submission receipt.", 400);
  const draft = draftInput(data.draft), ip = await ipHash(request, env), receiptHash = await digest(data.receiptKey);
  const fingerprint = await digest(JSON.stringify({
    kind: data.kind,
    username: username,
    notes: notes,
    draft: draft
  }));
  const existing = await env.DB.prepare("SELECT id,fingerprint,ip_hash FROM submissions WHERE receipt_hash=?1").bind(receiptHash).first();
  if (existing) {
    if (existing.fingerprint !== fingerprint || existing.ip_hash !== ip) throw new ApiError("Use a new receipt for a different submission.", 409);
    return {
      id: existing.id,
      receiptKey: data.receiptKey,
      status: "received"
    };
  }
  await challenge(request, env, data.turnstileToken, "submit");
  await budget(env, "submit:" + ip, 86400, limit(env.SUBMISSIONS_PER_IP_PER_DAY, 100, 100));
  await budget(env, "submit:all", 86400, limit(env.SUBMISSIONS_PER_DAY, 200, 1e4));
  const verified = await verifiedDraft(draft, data.kind);
  const id = crypto.randomUUID(), stamp = now();
  let result;
  try {
    await checkKeys(env, claims(verified.draft, verified.base, data.kind));
    result = await env.DB.prepare("INSERT INTO submissions(id,kind,username,notes,draft_json,base_json,texture_json,created_at,updated_at,receipt_hash,fingerprint,ip_hash,registry_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?8,?9,?10,?11,?12) ON CONFLICT(receipt_hash) DO NOTHING").bind(id, data.kind, username, notes, JSON.stringify(verified.draft), JSON.stringify(verified.base), verified.texture ? JSON.stringify(verified.texture) : null, stamp, receiptHash, fingerprint, ip, JSON.stringify(claims(verified.draft, verified.base, data.kind))).run();
  } catch (error) {
    if (registryError(error)?.status === 409) {
      const retry = await env.DB.prepare("SELECT id,fingerprint,ip_hash FROM submissions WHERE receipt_hash=?1").bind(receiptHash).first();
      if (retry && retry.fingerprint === fingerprint && retry.ip_hash === ip) return { id: retry.id, receiptKey: data.receiptKey, status: "received" };
    }
    throw registryError(error);
  }
  if (!result.meta.changes) {
    const row = await env.DB.prepare("SELECT id FROM submissions WHERE receipt_hash=?1").bind(receiptHash).first();
    return {
      id: row.id,
      receiptKey: data.receiptKey,
      status: "received"
    };
  }
  return {
    id: id,
    receiptKey: data.receiptKey,
    status: "pending"
  };
}

export async function submissionStatus(request, env) {
  const data = await body(request, 2048);
  keys(data, [ "id", "receiptKey" ]);
  if (!uuid.test(data.id || "") || !/^[A-Za-z0-9_-]{43}$/.test(data.receiptKey || "")) throw new ApiError("Invalid submission receipt.", 400);
  const row = await env.DB.prepare("SELECT receipt_hash,status,draft_json FROM submissions WHERE id=?1").bind(data.id).first();
  if (!row || !equalHash(row.receipt_hash || "", await digest(data.receiptKey))) throw new ApiError("Submission receipt was not found.", 404);
  return {
    id: data.id,
    status: row.status,
    name: JSON.parse(row.draft_json).name
  };
}

export async function listing(url, env) {
  const status = url.searchParams.get("status") || "pending";
  if (!statuses.includes(status)) throw new ApiError("Invalid review filter.", 400);
  let cursor = null;
  if (url.searchParams.has("cursor")) {
    try {
      const raw = url.searchParams.get("cursor");
      if (raw.length > 200) throw new Error;
      cursor = JSON.parse(atob(raw));
      if (!Number.isSafeInteger(cursor.time) || !uuid.test(cursor.id)) throw new Error;
    } catch {
      throw new ApiError("Invalid review cursor.", 400);
    }
  }
  const query = cursor ? env.DB.prepare("SELECT * FROM submissions WHERE status=?1 AND (created_at<?2 OR (created_at=?2 AND id<?3)) ORDER BY created_at DESC,id DESC LIMIT 31").bind(status, cursor.time, cursor.id) : env.DB.prepare("SELECT * FROM submissions WHERE status=?1 ORDER BY created_at DESC,id DESC LIMIT 31").bind(status);
  const results = await env.DB.batch([ query, env.DB.prepare("SELECT status,COUNT(*) AS total FROM submissions GROUP BY status"), env.DB.prepare("SELECT COUNT(*) AS total FROM catalog_items") ]);
  const rows = results[0].results, more = rows.length > 30, visible = rows.slice(0, 30), last = visible.at(-1);
  return {
    items: visible.map(record),
    counts: Object.fromEntries(statuses.map(key => [ key, results[1].results.find(row => row.status === key)?.total || 0 ])),
    catalogCount: results[2].results[0].total,
    nextCursor: more ? btoa(JSON.stringify({
      time: last.created_at,
      id: last.id
    })) : null
  };
}

export async function review(request, env, id, session) {
  if (!uuid.test(id)) throw new ApiError("Submission was not found.", 404);
  const data = await body(request);
  keys(data, [ "action", "version", "ownerNote", "draft" ]);
  if (![ "approve", "decline" ].includes(data.action) || !Number.isSafeInteger(data.version) || data.version < 1) throw new ApiError("Invalid review action.", 400);
  const note = text(data.ownerNote || "", 2e3, "Review note");
  const row = await env.DB.prepare("SELECT * FROM submissions WHERE id=?1").bind(id).first();
  if (!row) throw new ApiError("Submission was not found.", 404);
  if (row.version !== data.version) throw new ApiError("This item changed in another review. Reload the queue.", 409);
  const verified = data.action === "approve" ? await verifiedDraft(data.draft || JSON.parse(row.draft_json), row.kind) : {
    draft: JSON.parse(row.draft_json),
    base: JSON.parse(row.base_json),
    texture: row.texture_json ? JSON.parse(row.texture_json) : null
  };
  const status = data.action === "approve" ? "approved" : "declined", stamp = now();
  const claimKeys = claims(verified.draft, verified.base, row.kind);
  if (status === "approved") await checkKeys(env, claimKeys, id);
  let results;
  try {
    results = await env.DB.batch([ env.DB.prepare("UPDATE submissions SET status=?1,draft_json=?2,base_json=?3,texture_json=?4,owner_note=?5,updated_at=?6,version=version+1,registry_json=?9 WHERE id=?7 AND version=?8").bind(status, JSON.stringify(verified.draft), JSON.stringify(verified.base), verified.texture ? JSON.stringify(verified.texture) : null, note, stamp, id, data.version, JSON.stringify(claimKeys)), env.DB.prepare("INSERT INTO review_log(submission_id,action,record_version,created_at,session_hash) SELECT id,?1,version,?2,?3 FROM submissions WHERE id=?4 AND version=?5 AND updated_at=?2 AND changes()=1").bind(data.action, stamp, session.token_hash, id, data.version + 1) ]);
  } catch (error) {
    throw registryError(error);
  }
  if (!results[0].meta.changes) throw new ApiError("This item changed in another review. Reload the queue.", 409);
  return {
    item: record(await env.DB.prepare("SELECT * FROM submissions WHERE id=?1").bind(id).first())
  };
}

export async function ownerItem(request, env, session) {
  const data = await body(request);
  keys(data, [ "draft", "ownerNote" ]);
  const {draft: draft, base: base} = await verifiedDraft(data.draft, "owner");
  const note = text(data.ownerNote || "", 2000, "Review note");
  const id = crypto.randomUUID(), stamp = now();
  await checkKeys(env, claims(draft, base, "owner"));
  try {
    await env.DB.batch([ env.DB.prepare("INSERT INTO submissions(id,kind,username,status,draft_json,base_json,created_at,updated_at,owner_note,registry_json) VALUES(?1,'owner','Owner','approved',?2,?3,?4,?4,?5,?6)").bind(id, JSON.stringify(draft), JSON.stringify(base), stamp, note, JSON.stringify(claims(draft, base, "owner"))), env.DB.prepare("INSERT INTO review_log(submission_id,action,record_version,created_at,session_hash) VALUES(?1,'create',1,?2,?3)").bind(id, stamp, session.token_hash) ]);
  } catch (error) {
    throw registryError(error);
  }
  return {
    item: record(await env.DB.prepare("SELECT * FROM submissions WHERE id=?1").bind(id).first())
  };
}

export async function generate(request, env) {
  const data = await body(request, 65536);
  keys(data, [ "items", "mode" ]);
  if (![ "full", "items" ].includes(data.mode) || !Array.isArray(data.items) || data.items.length < 1 || data.items.length > 500) throw new ApiError("Select 1–500 approved items and an output format.", 400);
  const ids = new Set;
  for (const item of data.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ApiError("Invalid selected item.", 400);
    keys(item, [ "id", "version" ]);
    if (!uuid.test(item.id) || ids.has(item.id) || !Number.isSafeInteger(item.version)) throw new ApiError("Invalid selected item.", 400);
    ids.add(item.id);
  }
  const queries = [];
  for (let offset = 0; offset < data.items.length; offset += 50) {
    const group = data.items.slice(offset, offset + 50);
    const placeholders = group.map((item, index) => "?" + (index + 1)).join(",");
    queries.push(env.DB.prepare("SELECT s.id,s.status,s.version,s.draft_json,s.registry_json,EXISTS(SELECT 1 FROM catalog_keys k,json_each(s.registry_json) j WHERE k.key=j.value AND k.item_id<>s.id UNION ALL SELECT 1 FROM pending_keys k,json_each(s.registry_json) j WHERE k.key=j.value AND k.submission_id<>s.id) AS conflict FROM submissions s WHERE s.id IN (" + placeholders + ")").bind(...group.map(item => item.id)));
  }
  const results = await env.DB.batch(queries);
  const records = new Map(results.flatMap(result => result.results).map(row => [row.id, row]));
  const drafts = data.items.map(item => {
    const row = records.get(item.id);
    if (!row || row.status !== "approved" || row.version !== item.version) throw new ApiError("An item is no longer approved or has changed. Reload the queue before exporting.", 409);
    if (row.conflict) throw new ApiError("An approved item conflicts with the existing catalog. Review it before exporting.", 409);
    return JSON.parse(row.draft_json);
  });
  try {
    return {
      code: data.mode === "full" ? core.fullScript(drafts, publisher) : core.itemsLua(drafts),
      count: drafts.length,
      requirements: { heads: drafts.some(draft => draft.itemType === "Head"), detailedPlacement: drafts.some(draft => [ "LeftShoulder", "RightShoulder", "Collar", "WaistFront", "WaistCenter", "WaistBack" ].includes(draft.accessoryKind)) }
    };
  } catch (error) {
    throw new ApiError(error.message, 400);
  }
}
