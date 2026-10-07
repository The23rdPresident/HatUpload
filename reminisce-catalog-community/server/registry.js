import "../shared/core.js";
import { ApiError } from "./catalog.js";

const core = globalThis.CatalogCore;

export function claims(draft, base, kind) {
  const keys = core.registryKeys(draft);
  if (kind === "official" && base?.name) keys.push("name:" + core.nameKey(base.name));
  return [...new Set(keys)];
}

export async function checkKeys(env, keys, id = "") {
  const encoded = JSON.stringify(keys);
  const conflict = await env.DB.prepare("SELECT key FROM catalog_keys WHERE key IN (SELECT value FROM json_each(?1)) AND item_id<>?2 UNION ALL SELECT key FROM pending_keys WHERE key IN (SELECT value FROM json_each(?1)) AND submission_id<>?2 LIMIT 1").bind(encoded, id).first();
  if (conflict) throw new ApiError("This item already exists in Reminisce or is already awaiting review. A reskin must have its own name and a different replacement texture.", 409);
}

export function registryError(error) {
  if (String(error?.message).includes("catalog_duplicate")) return new ApiError("This item already exists in Reminisce or is already awaiting review. A reskin must have its own name and a different replacement texture.", 409);
  return error;
}

export async function catalogList(env) {
  const result = await env.DB.prepare("SELECT name,item_type,asset_id,texture_id,accessory_kind,source,accepted_at,draft_json FROM catalog_items ORDER BY item_type,name COLLATE NOCASE").all();
  return { items: result.results.map(row => ({ name: row.name, itemType: row.item_type, assetId: row.asset_id, texture: row.texture_id ? "rbxassetid://" + row.texture_id : "", accessoryKind: row.accessory_kind, source: row.source, acceptedAt: row.accepted_at, details: JSON.parse(row.draft_json) })), count: result.results.length };
}
