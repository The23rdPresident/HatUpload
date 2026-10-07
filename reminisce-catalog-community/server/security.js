import { timingSafeEqual } from "node:crypto";

import { ApiError } from "./catalog.js";

const encoder = new TextEncoder;

export const now = () => Math.floor(Date.now() / 1e3);

export const hex = bytes => Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");

export async function digest(value) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export function token() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function equalHash(a, b) {
  return /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

export function configured(env) {
  return Boolean(env.DB?.prepare && env.REQUEST_LIMITER?.limit && env.LOGIN_LIMITER?.limit && /^[a-f0-9]{64}$/.test(env.ADMIN_KEY_HASH || "") && /^[A-Za-z0-9_-]{43}$/.test(env.RATE_SECRET || "") && env.TURNSTILE_SECRET && env.TURNSTILE_SITE_KEY && !String(env.TURNSTILE_SITE_KEY).includes("REPLACE") && !/^[123]x0/.test(env.TURNSTILE_SITE_KEY) && !/^[123]x0/.test(env.TURNSTILE_SECRET));
}

export function originFor(request, env) {
  const origin = request.headers.get("Origin");
  const own = new URL(request.url).origin;
  const origins = String(env.PUBLIC_ORIGINS || "").split(",").map(value => value.trim()).filter(Boolean);
  if (origins.some(value => {
    try {
      const url = new URL(value);
      return url.origin !== value || url.protocol !== "https:";
    } catch {
      return true;
    }
  })) throw new ApiError("The site's allowed origins are not configured correctly.", 503);
  if (origin && origin !== own && !origins.includes(origin)) throw new ApiError("This website is not allowed to call the service.", 403);
  return origin || "";
}

export function requireOrigin(request, env) {
  const origin = originFor(request, env);
  if (!origin) throw new ApiError("A website origin is required for this request.", 403);
  return origin;
}

export function headers(origin, request) {
  const h = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    Vary: "Origin",
    "Cross-Origin-Resource-Policy": "same-site"
  };
  if (new URL(request.url).protocol === "https:") h["Strict-Transport-Security"] = "max-age=31536000";
  if (origin) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "GET, POST, PATCH, OPTIONS";
    h["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    h["Access-Control-Max-Age"] = "600";
  }
  return h;
}

export function json(value, status, origin, request, extra = {}) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status: status,
    headers: {
      ...headers(origin, request),
      "Content-Type": "application/json; charset=utf-8",
      ...extra
    }
  });
}

export async function body(request, max = 24576) {
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) throw new ApiError("Use a JSON request body.", 415);
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared > max) throw new ApiError("Request is too large.", 413);
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError("A request body is required.", 400);
  const parts = [];
  let size = 0;
  try {
    while (true) {
      const {done: done, value: value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new ApiError("Request is too large.", 413);
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  let data;
  try {
    data = JSON.parse(new TextDecoder("utf-8", {
      fatal: true
    }).decode(all));
  } catch {
    throw new ApiError("Invalid JSON.", 400);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("The request must be a JSON object.", 400);
  return data;
}

export function keys(value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ApiError("Unsupported field: " + key, 400);
}

export async function ipHash(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = await crypto.subtle.importKey("raw", encoder.encode(env.RATE_SECRET), {
    name: "HMAC",
    hash: "SHA-256"
  }, false, [ "sign" ]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(ip)));
}

export async function budget(env, scope, seconds, limit) {
  const start = Math.floor(now() / seconds) * seconds;
  const row = await env.DB.prepare("INSERT INTO rate_windows(scope,window_start,hits) VALUES(?1,?2,1) ON CONFLICT(scope,window_start) DO UPDATE SET hits=MIN(hits+1,?3) RETURNING hits").bind(scope, start, limit + 1).first();
  if (row.hits > limit) throw new ApiError("This request limit has been reached. Try again later.", 429);
}

export async function challenge(request, env, response, action) {
  const origin = requireOrigin(request, env);
  if (typeof response !== "string" || response.length < 1 || response.length > 2048) throw new ApiError("Complete the verification check.", 400);
  const controller = new AbortController, timer = setTimeout(() => controller.abort(), 1e4);
  let data;
  try {
    const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: response,
        remoteip: request.headers.get("CF-Connecting-IP") || undefined
      })
    });
    if (!result.ok) throw new Error;
    data = await result.json();
  } catch {
    throw new ApiError("Verification is temporarily unavailable. Try again.", 503);
  } finally {
    clearTimeout(timer);
  }
  if (!data.success || data.action !== action || data.hostname !== new URL(origin).hostname) throw new ApiError("Verification failed or expired. Complete a new check.", 403);
}

export async function authorize(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) throw new ApiError("Owner sign-in is required.", 401);
  const hash = await digest(match[1]);
  const session = await env.DB.prepare("SELECT token_hash,key_hash,expires_at FROM owner_sessions WHERE token_hash=?1").bind(hash).first();
  if (!session || session.expires_at <= now() || !equalHash(session.key_hash, env.ADMIN_KEY_HASH)) throw new ApiError("Your owner session has expired. Sign in again.", 401);
  return session;
}

export async function login(request, env) {
  const ip = await ipHash(request, env);
  if (!(await env.LOGIN_LIMITER.limit({
    key: ip
  })).success) throw new ApiError("Too many sign-in attempts. Try again in a minute.", 429);
  await budget(env, "login:" + ip, 3600, 15);
  const data = await body(request, 4096);
  keys(data, [ "key", "turnstileToken" ]);
  await challenge(request, env, data.turnstileToken, "owner-login");
  if (typeof data.key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(data.key) || !equalHash(await digest(data.key), env.ADMIN_KEY_HASH)) throw new ApiError("The owner key is incorrect.", 401);
  const sessionToken = token(), hash = await digest(sessionToken), expiry = now() + 1800;
  await env.DB.prepare("INSERT INTO owner_sessions(token_hash,key_hash,expires_at,created_at) VALUES(?1,?2,?3,?4)").bind(hash, env.ADMIN_KEY_HASH, expiry, now()).run();
  return {
    token: sessionToken,
    expiresAt: expiry
  };
}
