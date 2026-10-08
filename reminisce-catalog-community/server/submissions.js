import "../shared/core.js";

import { ApiError, textureAsset } from "./catalog.js";
import { resolveFace, resolveItem } from "./faces.js";

import { body, keys, now, token, digest, ipHash, budget, challenge, equalHash } from "./security.js";

import { claims, checkKeys, registryError } from "./registry.js";
import { publishingConfig, enqueueStatement, publication, publicationColumns, publicationJoin, itemRow, lockedPublication } from "./publishing.js";

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
  if (![ "limited", "limited-u" ].includes(draft.catalogType)) draft.stock = "0";
  if (core.HIDDEN_TYPES.includes(draft.catalogType)) draft.price = "0";
  const errors = core.validate(draft);
  if (errors.length) throw new ApiError(errors.join(" "), 400);
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
  const face = draft.itemType === "Face" ? await resolveFace(draft.assetId) : null;
  const base = face ? face.item : (await resolveItem(draft.assetId, draft.itemType === "BodyPackage" ? "Bundle" : "Asset")).item;
  const mapping = core.assetMapping(base.assetType, base.kind, base.id);
  if (!mapping || (!(core.isAccessory(mapping.itemType) && core.isAccessory(draft.itemType)) && draft.itemType !== mapping.itemType)) throw new ApiError("Item type must match the verified Roblox item.", 400);
  if (kind === "official" && draft.customTexture) throw new ApiError("Choose a custom reskin to replace the base texture.", 400);
  if (kind === "reskin" && !draft.customTexture) throw new ApiError("A custom reskin needs a replacement texture.", 400);
  if (kind === "reskin" && !(core.isAccessory(draft.itemType) || draft.itemType === "Face")) throw new ApiError("Reskins require an accessory or classic face base.", 400);
  if (kind === "reskin" && core.nameKey(draft.name) === core.nameKey(base.name)) throw new ApiError("Give your reskin its own catalog name.", 400);
  let texture = null;
  if (kind === "reskin" || draft.itemType === "Face") {
    texture = kind === "reskin" || face?.item.faceTextureRequired ? await textureAsset(core.assetContent(draft.texture)?.split("//")[1]) : face.texture;
    draft.texture = "rbxassetid://" + texture.id;
    if (face) draft.assetId = String(base.id);
  } else {
    draft.texture = "";
  }
  return {
    draft: draft,
    base: base,
    texture: texture
  };
}

export function record(row) {
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
    declineNote: row.decline_note || "",
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publication: publication(row)
  };
}

function limit(value, fallback, max) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 && n <= max ? n : fallback;
}

function uploadSettings(draft) {
  if (!core.UPLOAD_TYPES.includes(draft.catalogType)) throw new ApiError("Choose Non limited, Limited, Limited U, or Event reward.", 400);
  if (draft.startMode !== "now" || ![ "never", "duration" ].includes(draft.endMode) || draft.startDate || draft.endDate) throw new ApiError("Items go on sale when published. Timed items use a sale duration.", 400);
  if (Number(draft.accessoryScale) !== 1 || draft.useOffset || draft.rainbow || [draft.offsetX, draft.offsetY, draft.offsetZ].some(value => Number(value) !== 0)) throw new ApiError("Custom accessory placement settings are no longer accepted.", 400);
}

export async function submit(request, env) {
  const data = await body(request);
  keys(data, [ "kind", "draft", "turnstileToken", "receiptKey" ]);
  if (![ "official", "reskin" ].includes(data.kind)) throw new ApiError("Choose a catalog item or a custom reskin.", 400);
  const username = "Community", notes = "";
  if (typeof data.receiptKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.receiptKey)) throw new ApiError("Invalid submission receipt.", 400);
  const draft = draftInput(data.draft), ip = await ipHash(request, env), receiptHash = await digest(data.receiptKey);
  uploadSettings(draft);
  const fingerprint = await digest(JSON.stringify({
    kind: data.kind,
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

function validReceipt(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("Invalid submission receipt.", 400);
  keys(data, [ "id", "receiptKey" ]);
  if (typeof data.id !== "string" || typeof data.receiptKey !== "string" || !uuid.test(data.id) || !/^[A-Za-z0-9_-]{43}$/.test(data.receiptKey)) throw new ApiError("Invalid submission receipt.", 400);
}

function receiptStatus(row) {
  return {
    id: row.id,
    status: row.status,
    name: JSON.parse(row.draft_json).name,
    updatedAt: row.updated_at,
    declineNote: row.status === "declined" ? row.decline_note || "Your submission was declined. No reason was provided." : ""
  };
}

export async function submissionStatus(request, env) {
  const data = await body(request, 2048);
  validReceipt(data);
  const row = await env.DB.prepare("SELECT id,receipt_hash,status,draft_json,decline_note,updated_at FROM submissions WHERE id=?1").bind(data.id).first();
  if (!row || !equalHash(row.receipt_hash || "", await digest(data.receiptKey))) throw new ApiError("Submission receipt was not found.", 404);
  return receiptStatus(row);
}

export async function submissionStatuses(request, env) {
  const data = await body(request, 8192);
  keys(data, [ "receipts" ]);
  if (!Array.isArray(data.receipts) || !data.receipts.length || data.receipts.length > 30) throw new ApiError("Check 1–30 submission receipts at a time.", 400);
  for (const receipt of data.receipts) validReceipt(receipt);
  const ids = data.receipts.map(receipt => receipt.id);
  if (new Set(ids).size !== ids.length) throw new ApiError("Each submission receipt must be unique.", 400);
  const result = await env.DB.prepare("SELECT id,receipt_hash,status,draft_json,decline_note,updated_at FROM submissions WHERE id IN (" + ids.map((_, index) => "?" + (index + 1)).join(",") + ")").bind(...ids).all();
  const rows = new Map(result.results.map(row => [row.id, row]));
  const items = await Promise.all(data.receipts.map(async receipt => {
    const hash = await digest(receipt.receiptKey), row = rows.get(receipt.id);
    return row && equalHash(row.receipt_hash || "", hash) ? receiptStatus(row) : { id: receipt.id, status: "Unavailable" };
  }));
  return { items };
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
  const select = "SELECT " + publicationColumns + " FROM submissions s" + publicationJoin;
  const query = cursor ? env.DB.prepare(select + "WHERE s.status=?1 AND (s.created_at<?2 OR (s.created_at=?2 AND s.id<?3)) ORDER BY s.created_at DESC,s.id DESC LIMIT 31").bind(status, cursor.time, cursor.id) : env.DB.prepare(select + "WHERE s.status=?1 ORDER BY s.created_at DESC,s.id DESC LIMIT 31").bind(status);
  const results = await env.DB.batch([ query, env.DB.prepare("SELECT status,COUNT(*) AS total FROM submissions GROUP BY status"), env.DB.prepare("SELECT COUNT(*) AS total FROM catalog_items") ]);
  const rows = results[0].results, more = rows.length > 30, visible = rows.slice(0, 30), last = visible.at(-1);
  return {
    items: visible.map(record),
    counts: Object.fromEntries(statuses.map(key => [ key, results[1].results.find(row => row.status === key)?.total || 0 ])),
    catalogCount: results[2].results[0].total,
    publishing: publishingConfig(env),
    nextCursor: more ? btoa(JSON.stringify({
      time: last.created_at,
      id: last.id
    })) : null
  };
}

export async function review(request, env, id, session) {
  if (!uuid.test(id)) throw new ApiError("Submission was not found.", 404);
  const data = await body(request);
  keys(data, [ "action", "version", "ownerNote", "declineNote", "draft" ]);
  if (![ "approve", "decline" ].includes(data.action) || !Number.isSafeInteger(data.version) || data.version < 1) throw new ApiError("Invalid review action.", 400);
  const declineNote = text(data.declineNote ?? "", 2e3, "Decline note");
  const row = await env.DB.prepare("SELECT * FROM submissions WHERE id=?1").bind(id).first();
  if (!row) throw new ApiError("Submission was not found.", 404);
  const note = data.ownerNote === undefined ? row.owner_note : text(data.ownerNote, 2e3, "Review note");
  if (row.version !== data.version) throw new ApiError("This item changed in another review. Reload the queue.", 409);
  if (await lockedPublication(env, id)) throw new ApiError("This item is locked because it has been queued for the game. Use Retry publish for a failed delivery; declining does not remove a published item.", 409);
  const reviewDraft = data.draft || JSON.parse(row.draft_json);
  const verifyKind = row.kind === "owner" && publishingConfig(env).enabled ? reviewDraft.customTexture ? "reskin" : "official" : row.kind;
  const verified = data.action === "approve" ? await verifiedDraft(reviewDraft, verifyKind) : {
    draft: JSON.parse(row.draft_json),
    base: JSON.parse(row.base_json),
    texture: row.texture_json ? JSON.parse(row.texture_json) : null
  };
  const status = data.action === "approve" ? "approved" : "declined", stamp = now();
  const claimKeys = claims(verified.draft, verified.base, row.kind);
  if (status === "approved") await checkKeys(env, claimKeys, id);
  let results;
  try {
    const statements = [ env.DB.prepare("UPDATE submissions SET status=?1,draft_json=?2,base_json=?3,texture_json=?4,owner_note=?5,updated_at=?6,version=version+1,registry_json=?9,decline_note=?10 WHERE id=?7 AND version=?8 AND NOT EXISTS(SELECT 1 FROM publish_jobs p WHERE p.submission_id=submissions.id)").bind(status, JSON.stringify(verified.draft), JSON.stringify(verified.base), verified.texture ? JSON.stringify(verified.texture) : null, note, stamp, id, data.version, JSON.stringify(claimKeys), status === "declined" ? declineNote : ""), env.DB.prepare("INSERT INTO review_log(submission_id,action,record_version,created_at,session_hash) SELECT id,?1,version,?2,?3 FROM submissions WHERE id=?4 AND version=?5 AND updated_at=?2 AND changes()=1").bind(data.action, stamp, session.token_hash, id, data.version + 1) ];
    if (status === "approved" && publishingConfig(env).enabled) statements.push(enqueueStatement(env, id, data.version + 1, verified.draft, verified.base, stamp));
    results = await env.DB.batch(statements);
  } catch (error) {
    throw registryError(error);
  }
  if (!results[0].meta.changes) throw new ApiError("This item changed in another review. Reload the queue.", 409);
  return {
    item: record(await itemRow(env, id))
  };
}

export async function ownerItem(request, env, session) {
  const data = await body(request);
  keys(data, [ "draft", "ownerNote" ]);
  const {draft: draft, base: base} = await verifiedDraft(data.draft, publishingConfig(env).enabled ? data.draft?.customTexture ? "reskin" : "official" : "owner");
  uploadSettings(draft);
  const note = text(data.ownerNote || "", 2000, "Review note");
  const id = crypto.randomUUID(), stamp = now();
  await checkKeys(env, claims(draft, base, "owner"));
  try {
    const statements = [ env.DB.prepare("INSERT INTO submissions(id,kind,username,status,draft_json,base_json,created_at,updated_at,owner_note,registry_json) VALUES(?1,'owner','Owner','approved',?2,?3,?4,?4,?5,?6)").bind(id, JSON.stringify(draft), JSON.stringify(base), stamp, note, JSON.stringify(claims(draft, base, "owner"))), env.DB.prepare("INSERT INTO review_log(submission_id,action,record_version,created_at,session_hash) VALUES(?1,'create',1,?2,?3)").bind(id, stamp, session.token_hash) ];
    if (publishingConfig(env).enabled) statements.push(enqueueStatement(env, id, 1, draft, base, stamp));
    await env.DB.batch(statements);
  } catch (error) {
    throw registryError(error);
  }
  return {
    item: record(await itemRow(env, id))
  };
}

