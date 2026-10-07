import "../shared/core.js";
import { createHash } from "node:crypto";
import { ApiError, isOfficial, isAllowedHead, officialAsset } from "./catalog.js";
import { now, body, keys } from "./security.js";
import { apiKey, inspectKey } from "./roblox-key.js";
import { announcementConfig, announcementStatement, sendAnnouncement } from "./announcements.js";

const core = globalThis.CatalogCore;
const storeName = "ReminisceLiveCatalog_v1";
const topic = "ReminisceLiveCatalog";
const sizeLimit = 4 * 1024 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function rejectedItem(message, duplicate = false) {
  const error = new ApiError(message, 409);
  error.permanent = true;
  error.duplicate = duplicate;
  return error;
}

export function publishingConfig(env) {
  const universeId = String(env.ROBLOX_UNIVERSE_ID || "");
  const key = apiKey(env);
  const configured = /^[1-9]\d{0,15}$/.test(universeId) && Number.isSafeInteger(Number(universeId)) && key.length > 20 && !/\s/.test(key);
  return { enabled: configured && env.ROBLOX_AUTO_PUBLISH === "true", configured, universeId: /^[1-9]\d{0,15}$/.test(universeId) ? universeId : "", storeName, webhook: announcementConfig(env) };
}

function entryUrl(env, key) {
  const url = new URL("https://apis.roblox.com/datastores/v1/universes/" + publishingConfig(env).universeId + "/standard-datastores/datastore/entries/entry");
  url.searchParams.set("datastoreName", storeName);
  url.searchParams.set("scope", "global");
  url.searchParams.set("entryKey", key);
  return url;
}

async function cloud(env, url, options = {}, timeout = 5000) {
  let response;
  try {
    response = await fetch(url.href, { ...options, headers: { "x-api-key": apiKey(env), ...options.headers }, redirect: "manual", signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new ApiError("Roblox did not respond. Your accepted item is saved; publishing will retry.", 503);
  }
  if ([401, 403].includes(response.status)) {
    const messaging = url.pathname.endsWith(":publishMessage");
    const writing = options.method === "POST";
    const operation = messaging ? "publishing a server notification" : (writing ? "writing" : "reading") + ' "' + url.searchParams.get("entryKey") + '"';
    const requiredPermission = messaging ? "universe-messaging-service:publish" : "universe-datastores.objects:" + (writing ? "update" : "read");
    const message = response.status === 401
      ? "Roblox rejected the stored ROBLOX_API_KEY (HTTP 401) while " + operation + ". Replace the Worker secret with the current complete key. Check that the key is enabled and unexpired."
      : "Roblox denied " + operation + " (HTTP 403). Required: " + requiredPermission + " on " + (messaging ? "experience " : storeName + " in experience ") + publishingConfig(env).universeId + ". Check the key owner's experience/group access and IP restrictions.";
    const error = new ApiError(message, 503);
    error.diagnostic = { httpStatus: response.status, operation, requiredPermission };
    throw error;
  }
  if (response.status === 429) throw new ApiError("Roblox is rate limiting publishing. Your accepted item is saved; publishing will retry.", 503);
  if (options.method === "POST" && url.searchParams.get("entryKey") === "catalog" && [400, 422].includes(response.status)) throw rejectedItem("Roblox rejected this item's catalog write (HTTP " + response.status + "). Its saved definition could not be published.");
  if (![200, 204, 404, 409, 412].includes(response.status)) throw new ApiError("Roblox rejected the catalog request (HTTP " + response.status + "). Check the owner setup guide.", 503);
  return response;
}

async function readEntry(env, key) {
  const response = await cloud(env, entryUrl(env, key));
  if ([404, 204].includes(response.status)) return { value: null, version: null, attributes: null, userIds: null };
  if (response.status !== 200) throw new ApiError("Roblox could not read the catalog safely.", 503);
  const raw = await response.text();
  if (new TextEncoder().encode(raw).length > sizeLimit) throw new ApiError("The Roblox catalog is too large to update safely.", 409);
  let value;
  try { value = JSON.parse(raw); } catch { throw new ApiError("The Roblox catalog is not valid JSON. Nothing was overwritten.", 409); }
  const version = response.headers.get("roblox-entry-version");
  if (!version) throw new ApiError("Roblox did not return an entry version. Nothing was overwritten.", 503);
  return { value, version, attributes: response.headers.get("roblox-entry-attributes"), userIds: response.headers.get("roblox-entry-userids") };
}

async function readyGame(env) {
  const { value } = await readEntry(env, "uploader-ready");
  if (!object(value) || value.application !== "ReminisceItemUploader" || value.schema !== 1 || !object(value.types) || !Array.isArray(value.items)) throw new ApiError("Publish the updated game places and start a server once before enabling automatic publishing.", 409);
  return value;
}

async function experienceDetails(universeId) {
  try {
    const response = await fetch("https://games.roblox.com/v1/games?universeIds=" + universeId, { redirect: "manual", signal: AbortSignal.timeout(4000) });
    if (!response.ok) return null;
    const raw = await response.text();
    if (raw.length > 128000) return null;
    const game = JSON.parse(raw).data?.find(item => String(item.id) === universeId);
    if (!game || typeof game.name !== "string" || !Number.isSafeInteger(game.rootPlaceId) || game.rootPlaceId <= 0) return null;
    return { name: game.name.slice(0, 200), rootPlaceId: game.rootPlaceId,
      creator: typeof game.creator?.name === "string" ? game.creator.name.slice(0, 200) : null,
      updated: typeof game.updated === "string" && Number.isFinite(Date.parse(game.updated)) ? game.updated : null };
  } catch { return null; }
}

export async function testConnection(env) {
  const config = publishingConfig(env);
  const report = { ...config, uploaderVersion: "3.6.0", checkedAt: now(), experience: null, key: null };
  if (!config.configured) return { ...report, connected: false, error: /\s/.test(apiKey(env)) ? "The stored ROBLOX_API_KEY contains spaces or line breaks. Replace it with the complete key copied as one line." : "Add ROBLOX_UNIVERSE_ID and the ROBLOX_API_KEY Worker secret first." };
  const metadata = experienceDetails(config.universeId);
  const keyCheck = inspectKey(env, config.universeId, storeName);
  let result;
  try {
    const ready = await readyGame(env);
    const entry = await readEntry(env, "catalog");
    if (entry.value !== null) catalog(entry.value);
    const positiveInteger = value => Number.isSafeInteger(value) && value > 0 ? value : null;
    result = { ...report, connected: true, types: Object.keys(ready.types).filter(key => ready.types[key] === true),
      catalogVersion: Number(entry.value?.version) || 0, liveItemCount: Object.keys(entry.value?.items || {}).length,
      authoredItemCount: ready.items.length, protocolVersion: ready.schema,
      registeredPlaceId: positiveInteger(ready.placeId), registeredAt: positiveInteger(ready.updatedAt),
      placeVersion: positiveInteger(ready.placeVersion), refreshSeconds: 60, gameAnnouncements: ready.announcements === "worker" ? "worker" : "game" };
  } catch (error) {
    result = { ...report, connected: false, error: error instanceof ApiError ? error.message : "The connection check failed. Try again.", diagnostic: error.diagnostic || null };
  }
  result.experience = await metadata;
  result.key = await keyCheck;
  return result;
}

export function enqueueStatement(env, id, version, draft, base, stamp) {
  return env.DB.prepare("INSERT INTO publish_jobs(submission_id,job_id,record_version,universe_id,draft_json,base_json,next_attempt,created_at,updated_at,announcement_source) SELECT id,?1,version,?2,?3,?7,?4,?4,?4,'worker' FROM submissions WHERE id=?5 AND version=?6 AND status='approved' AND changes()=1").bind(crypto.randomUUID(), publishingConfig(env).universeId, JSON.stringify(draft), stamp, id, version, JSON.stringify(base));
}

export function publication(row) {
  if (!row.publish_status) return null;
  return { status: row.publish_status, universeId: row.publish_universe_id, attempts: row.publish_attempts, error: row.publish_error, publishedAt: row.publish_at, catalogVersion: row.publish_catalog_version, notification: row.publish_notification, nextAttempt: row.publish_next_attempt, retryable: row.status === "approved" && row.publish_status === "failed", autoDeclined: row.status === "declined" && row.publish_status === "failed", webhook: row.webhook_status ? { status: row.webhook_status, attempts: row.webhook_attempts, error: row.webhook_error, nextAttempt: row.webhook_next_attempt, sentAt: row.webhook_sent_at, retryable: row.status === "approved" && row.publish_status === "published" && ["failed", "uncertain"].includes(row.webhook_status) } : null };
}

export const publicationJoin = " LEFT JOIN publish_jobs p ON p.submission_id=s.id LEFT JOIN publish_webhooks w ON w.submission_id=p.submission_id ";
export const publicationColumns = "s.*,p.status AS publish_status,p.universe_id AS publish_universe_id,p.attempts AS publish_attempts,p.error AS publish_error,p.published_at AS publish_at,p.catalog_version AS publish_catalog_version,p.notification AS publish_notification,p.next_attempt AS publish_next_attempt,w.status AS webhook_status,w.attempts AS webhook_attempts,w.error AS webhook_error,w.next_attempt AS webhook_next_attempt,w.sent_at AS webhook_sent_at";

export async function itemRow(env, id) {
  return env.DB.prepare("SELECT " + publicationColumns + " FROM submissions s" + publicationJoin + "WHERE s.id=?1").bind(id).first();
}

export async function lockedPublication(env, id) {
  return Boolean(await env.DB.prepare("SELECT submission_id FROM publish_jobs WHERE submission_id=?1").bind(id).first());
}

export async function retryPublication(request, env, id) {
  if (!publishingConfig(env).enabled) throw new ApiError("Automatic publishing is not enabled. Follow AUTO_PUBLISH.md first.", 409);
  const data = await body(request, 2048);
  keys(data, ["version"]);
  if (!Number.isSafeInteger(data.version) || data.version < 1) throw new ApiError("Invalid item version.", 400);
  return queueRetry(env, id, data.version);
}

async function queueRetry(env, id, version, failedOnly = false) {
  const row = await env.DB.prepare("SELECT * FROM submissions WHERE id=?1").bind(id).first();
  if (!row || row.status !== "approved" || row.version !== version) throw new ApiError("Reload the approved item before publishing.", 409);
  const config = publishingConfig(env), stamp = now();
  const existing = await env.DB.prepare("SELECT * FROM publish_jobs WHERE submission_id=?1").bind(id).first();
  if (failedOnly && existing?.status !== "failed") throw new ApiError("Only failed publications can be retried.", 409);
  if (existing && existing.universe_id !== config.universeId) throw new ApiError("This item belongs to a different Roblox experience. Restore its original Universe ID before retrying.", 409);
  if (!existing) {
    const draft = JSON.parse(row.draft_json);
    const base = await officialAsset(draft.assetId, draft.itemType === "BodyPackage" ? "Bundle" : "Asset");
    await env.DB.prepare("INSERT INTO publish_jobs(submission_id,job_id,record_version,universe_id,draft_json,base_json,next_attempt,created_at,updated_at,announcement_source) SELECT id,?1,version,?2,draft_json,?6,?3,?3,?3,'worker' FROM submissions WHERE id=?4 AND status='approved' AND version=?5 ON CONFLICT(submission_id) DO NOTHING").bind(crypto.randomUUID(), config.universeId, stamp, id, version, JSON.stringify(base)).run();
  }
  else if (existing.status === "failed") await env.DB.prepare("UPDATE publish_jobs SET status='queued',next_attempt=?1,error='',updated_at=?1 WHERE submission_id=?2 AND status='failed' AND EXISTS(SELECT 1 FROM submissions s WHERE s.id=submission_id AND s.status='approved' AND s.version=record_version AND s.version=?3)").bind(stamp, id, version).run();
  return itemRow(env, id);
}

export async function retryPublications(request, env) {
  if (!publishingConfig(env).enabled) throw new ApiError("Automatic publishing is not enabled. Follow AUTO_PUBLISH.md first.", 409);
  const data = await body(request, 8192);
  keys(data, ["items"]);
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 30) throw new ApiError("Select 1–30 failed publications.", 400);
  const seen = new Set();
  for (const item of data.items) {
    if (!object(item)) throw new ApiError("Invalid selected publication.", 400);
    keys(item, ["id", "version"]);
    if (!uuid.test(item.id || "") || seen.has(item.id) || !Number.isSafeInteger(item.version) || item.version < 1) throw new ApiError("Invalid selected publication.", 400);
    seen.add(item.id);
  }
  const queued = [], errors = [];
  for (const item of data.items) {
    try {
      const row = await queueRetry(env, item.id, item.version, true);
      if (row.publish_status === "queued") queued.push(item.id);
    } catch (error) {
      errors.push({ id: item.id, error: error instanceof ApiError ? error.message : "This item could not be queued. Refresh and try again." });
    }
  }
  return { queued, errors };
}

function catalog(value) {
  if (object(value)) {
    if (Array.isArray(value.items) && value.items.length === 0) value.items = {};
    if (Array.isArray(value.known) && value.known.length === 0) value.known = {};
  }
  if (!object(value) || !object(value.items) || (value.known !== undefined && !object(value.known)) || !Number.isSafeInteger(value.version) || value.version < 0 || value.version >= Number.MAX_SAFE_INTEGER) throw new ApiError("The existing Roblox catalog has an unexpected format. Nothing was overwritten.", 409);
  for (const [name, item] of Object.entries(value.items)) if (!object(item) || (item.Name !== undefined && item.Name !== name)) throw new ApiError("The existing Roblox catalog contains an invalid item. Nothing was overwritten.", 409);
  return value;
}

function identity(raw) {
  const id = Number(raw.AssetId);
  if (!Number.isSafeInteger(id) || id <= 0) return "";
  const bundle = raw.ItemType === "BodyPackage";
  const base = (bundle ? "bundle:" : "asset:") + (!bundle && core.isHeadlessAsset(id) ? 15093053680 : id);
  const texture = core.assetContent(String(raw.Texture || ""));
  return texture ? "reskin:" + base + ":" + texture.split("//")[1] : base;
}

function conflict(candidate, raw, name) {
  const candidateTexture = core.assetContent(String(candidate.Texture || "")), existingTexture = core.assetContent(String(raw.Texture || ""));
  return core.nameKey(candidate.Name) === core.nameKey(name || raw.Name) || (identity(candidate) && identity(candidate) === identity(raw)) || (candidate.ItemType === "Face" && raw.ItemType === "Face" && candidateTexture && candidateTexture === existingTexture);
}

function definition(draft, stamp) {
  let item;
  try { item = core.buildDefinition(draft); }
  catch { throw rejectedItem("This item has invalid catalog settings and cannot be published."); }
  for (const [key, value] of Object.entries(item)) {
    if (object(value) && typeof value.luaExpression === "string") {
      const match = /^os\.time\(\)(?: \+ (\d+))?$/.exec(value.luaExpression);
      if (!match) throw new ApiError("This item contains an unsupported sale expression.", 400);
      item[key] = stamp + Number(match[1] || 0);
    } else if (object(value)) throw new ApiError("This item contains unsupported catalog data.", 400);
  }
  item.PublishedAt = stamp;
  return item;
}

async function writeItem(env, job) {
  let draft, base;
  try { draft = JSON.parse(job.draft_json); base = JSON.parse(job.base_json); }
  catch { throw rejectedItem("This item's saved publication data is invalid and cannot be published."); }
  if (!object(draft) || !object(base)) throw rejectedItem("This item's saved publication data is invalid and cannot be published.");
  if ((!isOfficial(base) && !isAllowedHead(base)) || Number(base.id) !== Number(draft.assetId)) throw rejectedItem("Automatic publishing requires a verified catalog head or a Roblox-created base item of another type.");
  const mapping = core.assetMapping(base.assetType, base.kind, base.id);
  if (!mapping || (!(core.isAccessory(mapping.itemType) && core.isAccessory(draft.itemType)) && draft.itemType !== mapping.itemType)) throw rejectedItem("Automatic publishing requires a matching Roblox-created base item.");
  const itemType = definition(draft, now()).ItemType;
  const ready = await readyGame(env);
  if (ready.types[itemType] !== true) throw new ApiError("The game does not support " + draft.itemType + " items yet. Install the supplied game update, publish the place, start a new server and retry.", 503);
  if (job.announcement_source === "worker" && ready.announcements !== "worker") throw new ApiError("Publish the 3.5.0 game update and start a new server once before retrying. This prevents the game from sending a second announcement.", 503);
  for (let attempt = 0; attempt < 2; attempt++) {
    const entry = await readEntry(env, "catalog"), data = entry.value === null ? { version: 0, items: {}, known: {} } : catalog(entry.value);
    const stamp = now(), item = definition(draft, stamp);
    const existing = Object.hasOwn(data.items, item.Name) ? data.items[item.Name] : null;
    if (existing?.PublisherJobId === job.job_id && existing.PublisherSubmissionId === job.submission_id) return { publishedAt: existing.PublishedAt, version: data.version, item: existing };
    for (const raw of ready.items) {
      if (!object(raw)) throw new ApiError("The game's item registration is invalid. Refresh its registration before retrying.", 503);
      if (conflict(item, raw)) throw rejectedItem("This item already exists in the game's authored catalog. Nothing was changed.", true);
    }
    for (const [name, raw] of Object.entries(data.items)) if (conflict(item, raw, name)) throw rejectedItem("This name, asset, or face texture already exists in the game's live catalog. Nothing was changed.", true);
    if (Object.keys(data.known || {}).some(name => core.nameKey(name) === core.nameKey(item.Name))) throw rejectedItem("This name was previously published in the game. Choose a new item.", true);
    item.PublisherJobId = job.job_id;
    item.PublisherSubmissionId = job.submission_id;
    item.PublisherRecordVersion = job.record_version;
    if (job.announcement_source === "worker") item.PublisherAnnouncement = "worker";
    const updated = { ...data, items: { ...data.items, [item.Name]: item }, known: { ...data.known, [item.Name]: true }, version: data.version + 1, updatedAt: stamp };
    const payload = JSON.stringify(updated);
    if (new TextEncoder().encode(payload).length > sizeLimit) throw new ApiError("The live catalog has reached Roblox's 4 MiB entry limit. Nothing was overwritten.", 409);
    const url = entryUrl(env, "catalog"), headers = { "Content-Type": "application/json", "Content-MD5": createHash("md5").update(payload, "utf8").digest("base64") };
    if (entry.version) url.searchParams.set("matchVersion", entry.version); else url.searchParams.set("exclusiveCreate", "true");
    if (entry.attributes) headers["roblox-entry-attributes"] = entry.attributes;
    if (entry.userIds) headers["roblox-entry-userids"] = entry.userIds;
    const response = await cloud(env, url, { method: "POST", headers, body: payload });
    if ([409, 412].includes(response.status)) continue;
    if (response.status !== 200) throw new ApiError("Roblox did not confirm the catalog write. Publishing will retry safely.", 503);
    return { publishedAt: stamp, version: updated.version, item };
  }
  throw new ApiError("Another catalog update happened at the same time. Publishing will retry without replacing it.", 503);
}

async function notify(env, version) {
  try {
    const response = await cloud(env, new URL("https://apis.roblox.com/cloud/v2/universes/" + publishingConfig(env).universeId + ":publishMessage"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topic, message: JSON.stringify({ v: version }) }) }, 3000);
    return response.status === 200 ? "sent" : "polling";
  } catch { return "polling"; }
}

export async function publishOne(env, id) {
  const config = publishingConfig(env);
  if (!config.enabled) return;
  const stamp = now(), lease = crypto.randomUUID();
  const claim = await env.DB.prepare("UPDATE publish_jobs SET status='publishing',attempts=attempts+1,lease_token=?1,lease_until=?2,updated_at=?3 WHERE submission_id=?4 AND universe_id=?5 AND ((status IN ('queued','failed') AND next_attempt IS NOT NULL AND next_attempt<=?3) OR (status='publishing' AND lease_until<=?3)) AND EXISTS(SELECT 1 FROM submissions s WHERE s.id=submission_id AND s.status='approved' AND s.version=record_version)").bind(lease, stamp + 120, stamp, id, config.universeId).run();
  if (!claim.meta.changes) return;
  const job = await env.DB.prepare("SELECT * FROM publish_jobs WHERE submission_id=?1 AND lease_token=?2").bind(id, lease).first();
  let completed = null;
  try {
    const result = await writeItem(env, job);
    const finishedAt = now();
    const saved = await env.DB.batch([
      env.DB.prepare("UPDATE publish_jobs SET status='published',error='',published_at=?1,catalog_version=?2,notification='polling',next_attempt=NULL,lease_token=NULL,lease_until=0,updated_at=?3 WHERE submission_id=?4 AND lease_token=?5").bind(result.publishedAt, result.version, finishedAt, id, lease),
      announcementStatement(env, job, result.item, finishedAt)
    ]);
    if (saved[0].meta.changes) completed = result;
  } catch (error) {
    const message = error instanceof ApiError ? error.message : "Publishing could not finish. Your accepted item is saved; retry from the owner page.";
    if (error?.permanent === true) {
      const failedAt = now();
      await env.DB.batch([
        env.DB.prepare("UPDATE submissions SET status='declined',decline_note=?5,version=version+1,updated_at=?1 WHERE id=?2 AND status='approved' AND version=?3 AND EXISTS(SELECT 1 FROM publish_jobs p WHERE p.submission_id=submissions.id AND p.status='publishing' AND p.lease_token=?4)").bind(failedAt, id, job.record_version, lease, message),
        env.DB.prepare("INSERT INTO review_log(submission_id,action,record_version,created_at,session_hash) SELECT id,'auto-decline',version,?1,'automatic-publisher' FROM submissions WHERE id=?2 AND status='declined' AND version=?3 AND updated_at=?1 AND EXISTS(SELECT 1 FROM publish_jobs p WHERE p.submission_id=submissions.id AND p.status='publishing' AND p.lease_token=?4)").bind(failedAt, id, job.record_version + 1, lease),
        error.duplicate
          ? env.DB.prepare("UPDATE catalog_items SET source='existing' WHERE id=?1 AND source='accepted' AND EXISTS(SELECT 1 FROM submissions s JOIN publish_jobs p ON p.submission_id=s.id WHERE s.id=?1 AND s.status='declined' AND s.version=?2 AND p.lease_token=?3)").bind(id, job.record_version + 1, lease)
          : env.DB.prepare("DELETE FROM catalog_items WHERE id=?1 AND source='accepted' AND EXISTS(SELECT 1 FROM submissions s JOIN publish_jobs p ON p.submission_id=s.id WHERE s.id=?1 AND s.status='declined' AND s.version=?2 AND p.lease_token=?3)").bind(id, job.record_version + 1, lease),
        env.DB.prepare("UPDATE publish_jobs SET status='failed',error=?1,next_attempt=NULL,lease_token=NULL,lease_until=0,updated_at=?2 WHERE submission_id=?3 AND lease_token=?4 AND EXISTS(SELECT 1 FROM submissions s WHERE s.id=submission_id AND s.status='declined' AND s.version=?5)").bind(message, failedAt, id, lease, job.record_version + 1)
      ]);
      return;
    }
    const retry = job.attempts < 8;
    await env.DB.prepare("UPDATE publish_jobs SET status='failed',error=?1,next_attempt=?2,lease_token=NULL,lease_until=0,updated_at=?3 WHERE submission_id=?4 AND lease_token=?5").bind(message, retry ? now() + Math.min(3600, 60 * 2 ** (job.attempts - 1)) : null, now(), id, lease).run();
  }
  if (completed) {
    const notification = await notify(env, completed.version);
    await env.DB.prepare("UPDATE publish_jobs SET notification=?1 WHERE submission_id=?2 AND status='published'").bind(notification, id).run();
    await sendAnnouncement(env, id);
  }
}

export async function drainPublishing(env) {
  if (!publishingConfig(env).enabled) return;
  const rows = await env.DB.prepare("SELECT submission_id FROM publish_jobs WHERE universe_id=?1 AND ((status IN ('queued','failed') AND next_attempt IS NOT NULL AND next_attempt<=?2) OR (status='publishing' AND lease_until<=?2)) ORDER BY created_at LIMIT 3").bind(publishingConfig(env).universeId, now()).all();
  for (const row of rows.results) await publishOne(env, row.submission_id);
}
