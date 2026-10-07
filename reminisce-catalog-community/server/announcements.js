import { ApiError } from "./catalog.js";
import { now, body, keys } from "./security.js";

const hosts = new Set(["discord.com", "discordapp.com", "webhook.lewisakura.moe"]);
const digits = /^[1-9]\d{0,19}$/;

function webhookUrl(env) {
  try {
    const url = new URL(String(env.NEW_ITEM_WEBHOOK_URL || "").trim());
    if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password || url.port || url.hash || !/^\/api\/(?:v\d+\/)?webhooks\/[1-9]\d{0,19}\/[A-Za-z0-9_-]{20,}$/.test(url.pathname)) return null;
    for (const [key, value] of url.searchParams) if (key !== "wait" && !(key === "thread_id" && digits.test(value))) return null;
    url.searchParams.set("wait", "true");
    return url;
  } catch { return null; }
}

export function announcementConfig(env) {
  return { configured: Boolean(webhookUrl(env)), roleConfigured: digits.test(String(env.NEW_ITEM_PING_ROLE_ID || "")) };
}

const number = value => Math.max(0, Math.floor(Number(value) || 0)).toLocaleString("en-US");
const text = (value, limit) => Array.from(String(value || "")).slice(0, limit).join("");

export function announcementPayload(item, base, universeId) {
  const limitedU = item.LimitedU === true;
  const stock = Number(item.Stock) > 0 ? number(item.Stock) + (limitedU ? " (Limited U)" : " (Limited)") : "Unlimited";
  const extra = Number(item.OffsaleAt) > 0 ? "\n\nSale ends <t:" + item.OffsaleAt + ":f> (<t:" + item.OffsaleAt + ":R>)." : "";
  const embed = {
    title: text(item.Name, 250),
    description: text(item.Description || "No description provided.", 1000) + extra,
    color: 0x5865f2,
    fields: [
      { name: "Price", value: item.Catalog === false ? "Not sold in the catalog" : Number(item.Price) > 0 ? number(item.Price) + " pNgs" : "Free", inline: true },
      { name: "Type", value: limitedU ? "Limited U" : item.Limited === true ? "Limited" : "Non-Limited", inline: true },
      { name: "Stock", value: stock, inline: true }
    ],
    timestamp: new Date(item.PublishedAt * 1000).toISOString(),
    footer: { text: "Reminisce Economy • Experience " + universeId }
  };
  try {
    const image = new URL(String(base.thumbnail || ""));
    if (image.protocol === "https:" && !image.username && !image.password && !image.port && (image.hostname === "rbxcdn.com" || image.hostname.endsWith(".rbxcdn.com"))) embed.image = { url: image.href };
  } catch {}
  return { username: "Reminisce Economy", allowed_mentions: { parse: [] }, embeds: [embed] };
}

export function announcementStatement(env, job, item, stamp) {
  const skipped = item.Event === true || item.Special === true;
  const payload = announcementPayload(item, JSON.parse(job.base_json), job.universe_id);
  return env.DB.prepare("INSERT INTO publish_webhooks(submission_id,job_id,universe_id,payload_json,status,next_attempt,created_at,updated_at) SELECT submission_id,job_id,universe_id,?1,?2,?3,?4,?4 FROM publish_jobs WHERE submission_id=?5 AND job_id=?6 AND status='published' AND announcement_source='worker' AND changes()=1 ON CONFLICT(submission_id) DO NOTHING").bind(JSON.stringify(payload), skipped ? "skipped" : "pending", skipped ? null : stamp, stamp, job.submission_id, job.job_id);
}

async function settle(env, id, lease, status, error, nextAttempt = null, messageId = "") {
  const stamp = now();
  return env.DB.prepare("UPDATE publish_webhooks SET status=?1,error=?2,next_attempt=?3,message_id=?4,sent_at=?5,lease_token=NULL,lease_until=0,updated_at=?6 WHERE submission_id=?7 AND status='sending' AND lease_token=?8").bind(status, error, nextAttempt, messageId, status === "sent" ? stamp : null, stamp, id, lease).run();
}

async function releaseExpired(env) {
  await env.DB.prepare("UPDATE publish_webhooks SET status='uncertain',error='Delivery was interrupted and could not be confirmed. Check the announcement channel before retrying.',next_attempt=NULL,lease_token=NULL,lease_until=0,updated_at=?1 WHERE status='sending' AND lease_until<=?1").bind(now()).run();
}

function retryTime(response, data, attempt) {
  const seconds = Math.max(Number(data?.retry_after) || 0, Number(response.headers.get("Retry-After")) || 0);
  return now() + Math.max(1, Math.min(86400, Math.ceil(seconds || Math.min(3600, 60 * 2 ** (attempt - 1)))));
}

export async function sendAnnouncement(env, id) {
  await releaseExpired(env);
  const stamp = now(), lease = crypto.randomUUID();
  const claim = await env.DB.prepare("UPDATE publish_webhooks SET status='sending',lease_token=?1,lease_until=?2,updated_at=?3 WHERE submission_id=?4 AND universe_id=?5 AND status IN ('pending','failed') AND next_attempt IS NOT NULL AND next_attempt<=?3 AND EXISTS(SELECT 1 FROM publish_jobs p JOIN submissions s ON s.id=p.submission_id WHERE p.submission_id=publish_webhooks.submission_id AND p.status='published' AND p.job_id=publish_webhooks.job_id AND s.status='approved' AND s.version=p.record_version)").bind(lease, stamp + 120, stamp, id, String(env.ROBLOX_UNIVERSE_ID || "")).run();
  if (!claim.meta.changes) return;
  const job = await env.DB.prepare("SELECT * FROM publish_webhooks WHERE submission_id=?1 AND lease_token=?2").bind(id, lease).first();
  const url = webhookUrl(env);
  if (!url) {
    await settle(env, id, lease, "failed", "Add a valid NEW_ITEM_WEBHOOK_URL Worker secret, then retry the announcement.", stamp + 300);
    return;
  }
  let payload;
  try {
    payload = JSON.parse(job.payload_json);
    if (!payload || !Array.isArray(payload.embeds) || payload.embeds.length !== 1) throw new Error();
    payload.allowed_mentions = { parse: [] };
    delete payload.content;
    const role = String(env.NEW_ITEM_PING_ROLE_ID || "");
    if (digits.test(role)) {
      payload.content = "<@&" + role + ">";
      payload.allowed_mentions.roles = [role];
    }
  } catch {
    await settle(env, id, lease, "failed", "The saved announcement is invalid. Contact the site owner.");
    return;
  }
  const sending = await env.DB.prepare("UPDATE publish_webhooks SET attempts=attempts+1 WHERE submission_id=?1 AND status='sending' AND lease_token=?2").bind(id, lease).run();
  if (!sending.meta.changes) return;
  job.attempts++;
  let response;
  try {
    response = await fetch(url.href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), redirect: "manual", signal: AbortSignal.timeout(8000) });
  } catch {
    await settle(env, id, lease, "uncertain", "Delivery could not be confirmed. Check the announcement channel before retrying.");
    return;
  }
  let data = null;
  try {
    const raw = await response.text();
    if (raw.length <= 65536) data = JSON.parse(raw);
  } catch {}
  if (response.ok) {
    const messageId = digits.test(String(data?.id || "")) ? String(data.id) : "";
    if (!messageId && response.status !== 204) {
      await settle(env, id, lease, "uncertain", "The webhook returned success without a delivery receipt. Check the announcement channel before retrying.");
      return;
    }
    await settle(env, id, lease, "sent", "", null, messageId);
  } else if (response.status === 429 || response.status >= 500 && response.status <= 599) {
    const retry = job.attempts < 8;
    await settle(env, id, lease, "failed", (response.status === 429 ? "The webhook is rate limited." : "The webhook service is unavailable (HTTP " + response.status + ").") + (retry ? " The announcement will retry." : " Retry after fixing the problem."), retry ? retryTime(response, data, job.attempts) : null);
  } else {
    const message = [401, 403, 404].includes(response.status) ? "The webhook was rejected (HTTP " + response.status + "). Replace NEW_ITEM_WEBHOOK_URL, then retry the announcement." : "The webhook rejected the announcement (HTTP " + response.status + "). Check the webhook setup, then retry.";
    await settle(env, id, lease, "failed", message);
  }
}

export async function drainAnnouncements(env) {
  await releaseExpired(env);
  const rows = await env.DB.prepare("SELECT submission_id FROM publish_webhooks WHERE universe_id=?1 AND status IN ('pending','failed') AND next_attempt IS NOT NULL AND next_attempt<=?2 ORDER BY created_at LIMIT 3").bind(String(env.ROBLOX_UNIVERSE_ID || ""), now()).all();
  for (const row of rows.results) await sendAnnouncement(env, row.submission_id);
}

export async function retryAnnouncement(request, env, id) {
  const data = await body(request, 2048);
  keys(data, ["version"]);
  if (!Number.isSafeInteger(data.version) || data.version < 1) throw new ApiError("Invalid item version.", 400);
  if (!webhookUrl(env)) throw new ApiError("Add a valid NEW_ITEM_WEBHOOK_URL Worker secret first.", 409);
  await releaseExpired(env);
  const result = await env.DB.prepare("UPDATE publish_webhooks SET status='pending',attempts=0,error='',next_attempt=?1,updated_at=?1 WHERE submission_id=?2 AND universe_id=?3 AND status IN ('failed','uncertain') AND EXISTS(SELECT 1 FROM publish_jobs p JOIN submissions s ON s.id=p.submission_id WHERE p.submission_id=publish_webhooks.submission_id AND p.status='published' AND p.job_id=publish_webhooks.job_id AND s.status='approved' AND s.version=p.record_version AND s.version=?4)").bind(now(), id, String(env.ROBLOX_UNIVERSE_ID || ""), data.version).run();
  if (!result.meta.changes) throw new ApiError("Reload the published item. Only failed or unconfirmed announcements can be retried.", 409);
}
