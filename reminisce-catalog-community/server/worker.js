import { ApiError, search, details, isOfficial, officialAsset, textureAsset } from "./catalog.js";

import { now, configured, originFor, requireOrigin, json, ipHash, authorize, login } from "./security.js";

import { submit, submissionStatus, listing, review, ownerItem, generate } from "./submissions.js";
import { body, keys } from "./security.js";
import { claims, checkKeys, catalogList } from "./registry.js";

function staticHeaders(request) {
  const h = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self' https://challenges.cloudflare.com; style-src 'self'; img-src 'self' data: https://*.rbxcdn.com; connect-src 'self' https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  };
  if (new URL(request.url).protocol === "https:") h["Strict-Transport-Security"] = "max-age=31536000";
  return h;
}

async function cached(url, read) {
  const cache = globalThis.caches?.default;
  const key = new Request(url);
  const hit = cache ? await cache.match(key) : null;
  if (hit) return hit.json();
  const result = await read();
  if (cache) await cache.put(key, new Response(JSON.stringify(result), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=180"
    }
  }));
  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    let origin = "";
    if (!path.startsWith("/api/")) {
      if (![ "GET", "HEAD" ].includes(request.method) || !env.ASSETS?.fetch) return new Response("Not found", {
        status: 404,
        headers: staticHeaders(request)
      });
      if (!/^\/(?:index\.html|review\.html|config\.js|favicon\.svg|assets\/[a-z0-9.-]+)?$/.test(path)) return new Response("Not found", {
        status: 404,
        headers: staticHeaders(request)
      });
      const response = await env.ASSETS.fetch(request), headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(staticHeaders(request))) headers.set(key, value);
      if (path.endsWith(".html") || path === "/" || path === "/config.js") headers.set("Cache-Control", "no-cache");
      return new Response(response.body, {
        status: response.status,
        headers: headers
      });
    }
    try {
      origin = originFor(request, env);
      if (request.method === "OPTIONS") {
        requireOrigin(request, env);
        return json(null, 204, origin, request);
      }
      if (path === "/api/config" && request.method === "GET") return json({
        ready: configured(env),
        siteKey: configured(env) ? env.TURNSTILE_SITE_KEY : "",
        version: 3
      }, 200, origin, request);
      if (!configured(env)) throw new ApiError("The service setup is incomplete. Contact the site owner.", 503);
      const ip = await ipHash(request, env);
      if (!(await env.REQUEST_LIMITER.limit({
        key: ip
      })).success) throw new ApiError("Too many requests. Try again in a minute.", 429);
      if ([ "POST", "PATCH" ].includes(request.method)) requireOrigin(request, env);
      let result;
      if (path === "/api/search" && request.method === "GET") {
        const query = new URL("/api/search", url);
        for (const key of [ "q", "cursor" ]) {
          if (url.searchParams.has(key)) query.searchParams.set(key, url.searchParams.get(key));
        }
        const category = url.searchParams.get("category") || "accessories";
        if (![ "accessories", "gear", "faces", "bundles", "heads" ].includes(category)) throw new ApiError("Unsupported search category.", 400);
        query.searchParams.set("category", category);
        query.searchParams.set("robloxOnly", "true");
        result = await cached(query.href, async () => {
          const data = await search(query);
          data.items = data.items.filter(isOfficial);
          if (!data.items.some(item => item.id === data.exactMatchId)) data.exactMatchId = null;
          return data;
        });
      } else if (/^\/api\/asset\/\d+$/.test(path) && request.method === "GET") {
        const kind = url.searchParams.get("kind") === "Bundle" ? "Bundle" : "Asset";
        const lookupUrl = new URL(path, url);
        lookupUrl.searchParams.set("kind", kind);
        result = await cached(lookupUrl.href, async () => {
          const item = await officialAsset(path.split("/").at(-1), kind);
          if (item.assetType === 18) item.textureId = (await textureAsset(item.id, true)).id;
          return { item };
        });
      } else if (/^\/api\/texture\/\d+$/.test(path) && request.method === "GET") {
        result = await cached(new URL(path, url).href, async () => ({
          item: await textureAsset(path.split("/").at(-1))
        }));
      } else if (path === "/api/submissions" && request.method === "POST") {
        result = await submit(request, env);
      } else if (path === "/api/check-item" && request.method === "POST") {
        const data = await body(request, 4096);
        keys(data, [ "kind", "draft" ]);
        if (![ "official", "reskin" ].includes(data.kind) || !data.draft || typeof data.draft !== "object" || Array.isArray(data.draft)) throw new ApiError("Invalid item check.", 400);
        keys(data.draft, [ "name", "itemType", "assetId", "customTexture", "texture" ]);
        const draft = data.draft;
        if (typeof draft.name !== "string" || draft.name.length > 180 || !globalThis.CatalogCore.nameKey(draft.name) || !globalThis.CatalogCore.ITEM_TYPES.includes(draft.itemType) || !/^\d{1,16}$/.test(draft.assetId || "") || !Number.isSafeInteger(Number(draft.assetId)) || Number(draft.assetId) < 1 || typeof draft.customTexture !== "boolean" || typeof draft.texture !== "string" || draft.texture.length > 200) throw new ApiError("Invalid item check.", 400);
        await checkKeys(env, claims(draft));
        result = { available: true };
      } else if (path === "/api/status" && request.method === "POST") {
        result = await submissionStatus(request, env);
      } else if (path === "/api/admin/login" && request.method === "POST") {
        result = await login(request, env);
      } else if (path.startsWith("/api/admin/")) {
        const session = await authorize(request, env);
        if (path === "/api/admin/logout" && request.method === "POST") {
          await env.DB.prepare("DELETE FROM owner_sessions WHERE token_hash=?1").bind(session.token_hash).run();
          result = {
            signedOut: true
          };
        } else if (path === "/api/admin/submissions" && request.method === "GET") {
          result = await listing(url, env);
        } else if (/^\/api\/admin\/submissions\/[a-f0-9-]+$/.test(path) && request.method === "PATCH") {
          result = await review(request, env, path.split("/").at(-1), session);
        } else if (path === "/api/admin/items" && request.method === "POST") {
          result = await ownerItem(request, env, session);
        } else if (path === "/api/admin/catalog" && request.method === "GET") {
          result = await catalogList(env);
        } else if (path === "/api/admin/generate" && request.method === "POST") {
          result = await generate(request, env);
        } else if (/^\/api\/admin\/asset\/\d+$/.test(path) && request.method === "GET") {
          result = await details(path.split("/").at(-1), url.searchParams.get("kind") === "Bundle" ? "Bundle" : "Asset");
        } else throw new ApiError("That route or method is not available.", 404);
      } else throw new ApiError("That route or method is not available.", 404);
      return json(result, 200, origin, request);
    } catch (error) {
      return json({
        error: error instanceof ApiError ? error.message : "The service could not complete this request. Try again later."
      }, error instanceof ApiError ? error.status : 503, origin, request, error.status === 429 ? {
        "Retry-After": "60"
      } : {});
    }
  },
  async scheduled(controller, env) {
    if (!env.DB?.prepare) return;
    await env.DB.batch([ env.DB.prepare("DELETE FROM owner_sessions WHERE expires_at<?1").bind(now()), env.DB.prepare("DELETE FROM rate_windows WHERE window_start<?1").bind(now() - 172800), env.DB.prepare("DELETE FROM review_log WHERE created_at<?1").bind(now() - 15552e3), env.DB.prepare("DELETE FROM submissions WHERE status='declined' AND updated_at<?1").bind(now() - 15552e3) ]);
  }
};
