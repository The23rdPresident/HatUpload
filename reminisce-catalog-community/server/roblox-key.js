export const apiKey = env => typeof env.ROBLOX_API_KEY === "string" ? env.ROBLOX_API_KEY.trim() : "";

function resourceMatch(scope, universeId, storeName) {
  const resources = storeName ? scope.universeDatastores : scope.universeIds;
  if (!Array.isArray(resources)) return null;
  let unknown = false;
  for (const resource of resources) {
    if (resource === "*") return true;
    if (!storeName && [universeId, "*"].includes(String(resource))) return true;
    if (storeName && resource && typeof resource === "object") {
      if (![universeId, "*"].includes(String(resource.universeId))) continue;
      if ([storeName, "*"].includes(resource.datastoreName)) return true;
      if (typeof resource.datastoreName !== "string") unknown = true;
    } else if (storeName || typeof resource !== "string") unknown = true;
  }
  return unknown ? null : false;
}

function permission(scopes, name, operation, universeId, storeName) {
  let unknown = false;
  for (const scope of scopes) {
    if (scope?.name !== name || !Array.isArray(scope.operations) || !scope.operations.includes(operation)) continue;
    const allowed = resourceMatch(scope, universeId, storeName);
    if (allowed === true) return true;
    if (allowed === null) unknown = true;
  }
  return unknown ? null : false;
}

export async function inspectKey(env, universeId, storeName) {
  const fallback = { status: "unavailable", permissions: null };
  try {
    const response = await fetch("https://apis.roblox.com/api-keys/v1/introspect", {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(4000),
      headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: apiKey(env) })
    });
    if (!response.ok) return { ...fallback, httpStatus: response.status };
    const raw = await response.text();
    if (raw.length > 128000) return fallback;
    const data = JSON.parse(raw);
    const status = data.expired === true ? "expired" : data.enabled === false ? "disabled" : data.enabled === true && data.expired === false ? "active" : "unavailable";
    const permissions = Array.isArray(data.scopes) ? {
      read: permission(data.scopes, "universe-datastores.objects", "read", universeId, storeName),
      create: permission(data.scopes, "universe-datastores.objects", "create", universeId, storeName),
      update: permission(data.scopes, "universe-datastores.objects", "update", universeId, storeName),
      messaging: permission(data.scopes, "universe-messaging-service", "publish", universeId)
    } : null;
    return { status, permissions };
  } catch { return fallback; }
}
