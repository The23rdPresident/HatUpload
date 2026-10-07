const SUPPORTED_ASSETS = new Set([ 2, 8, 11, 12, 17, 18, 19, 41, 42, 43, 44, 45, 46, 47, 57, 58, 70, 71 ]);

const SEARCH_CATEGORIES = {
  accessories: {
    Category: "11"
  },
  gear: {
    Category: "5",
    Subcategory: "5"
  },
  faces: {
    Category: "4",
    Subcategory: "10"
  },
  heads: {
    Category: "4",
    Subcategory: "15"
  },
  clothing: {
    Category: "3"
  },
  bundles: {
    Category: "4",
    Subcategory: "37"
  }
};

class ApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

const positiveId = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

function normalizeItem(raw, kind = "Asset") {
  const id = Number(raw.id ?? raw.AssetId ?? raw.TargetId);
  if (!positiveId(id)) throw new ApiError("Roblox returned an invalid asset ID.");
  return {
    id: id,
    kind: kind,
    name: String(raw.name ?? raw.Name ?? ""),
    description: String(raw.description ?? raw.Description ?? ""),
    assetType: Number(raw.assetType ?? raw.AssetTypeId ?? 0),
    creatorName: String(raw.creatorName ?? raw.Creator?.Name ?? raw.creator?.name ?? ""),
    creatorType: String(raw.creatorType ?? raw.Creator?.CreatorType ?? raw.creator?.type ?? ""),
    creatorId: Number(raw.creatorTargetId ?? raw.Creator?.CreatorTargetId ?? raw.Creator?.Id ?? raw.creator?.id ?? 0),
    thumbnail: ""
  };
}

async function robloxJson(url, init = {}) {
  const controller = new AbortController, timer = setTimeout(() => controller.abort(), 12e3);
  try {
    const options = {
      ...init,
      signal: controller.signal,
      redirect: "manual",
      headers: {
        Accept: "application/json",
        ...init.headers
      }
    };
    let response = await fetchRoblox(url, options);
    if (response.status === 403 && init.method === "POST" && response.headers.get("x-csrf-token")) response = await fetchRoblox(url, {
      ...options,
      headers: {
        ...options.headers,
        "x-csrf-token": response.headers.get("x-csrf-token")
      }
    });
    if (response.status === 429) throw new ApiError("Roblox is rate-limiting lookups. Wait a moment and try again.", 429);
    if (response.status === 404) throw new ApiError("Roblox could not find that item. Check the ID and whether it is a bundle.", 404);
    if (!response.ok) throw new ApiError("Roblox lookup returned HTTP " + response.status + ". Try again later.", response.status === 400 ? 400 : 502);
    try {
      return await response.json();
    } catch {
      throw new ApiError("Roblox returned an unreadable response.");
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(error.name === "AbortError" ? "Roblox lookup timed out. Try again." : "The lookup service could not reach Roblox.", 504);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRoblox(input, options) {
  const original = new URL(input);
  let url = original;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetch(url.href, options);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("Location");
    await response.body?.cancel();
    if (!location || options.method === "POST") throw new ApiError("Roblox redirected this lookup unexpectedly. Try another item ID.");
    const next = new URL(location, url);
    if (next.protocol !== "https:" || next.hostname !== original.hostname || next.port || next.username || next.password) throw new ApiError("Roblox returned an unsafe lookup redirect.");
    url = next;
  }
  throw new ApiError("Roblox returned too many lookup redirects.");
}

async function thumbnails(items, kind) {
  if (!items.length) return;
  try {
    const url = new URL(kind === "Bundle" ? "https://thumbnails.roblox.com/v1/bundles/thumbnails" : "https://thumbnails.roblox.com/v1/assets");
    url.searchParams.set(kind === "Bundle" ? "bundleIds" : "assetIds", items.map(item => item.id).join(","));
    url.searchParams.set("size", "150x150");
    url.searchParams.set("format", "Png");
    url.searchParams.set("isCircular", "false");
    const data = await robloxJson(url.href);
    const images = new Map((data.data || []).filter(thumb => thumb.state === "Completed").map(thumb => [ Number(thumb.targetId), thumb.imageUrl ]));
    for (const item of items) {
      const raw = images.get(item.id);
      if (raw) {
        const image = new URL(raw);
        if (image.protocol === "https:" && (image.hostname === "rbxcdn.com" || image.hostname.endsWith(".rbxcdn.com"))) item.thumbnail = image.href;
      }
    }
  } catch {}
}

async function search(url) {
  const q = (url.searchParams.get("q") || "").trim();
  const category = url.searchParams.get("category") || "accessories";
  const robloxOnly = url.searchParams.get("robloxOnly") !== "false";
  const cursor = url.searchParams.get("cursor") || "";
  if (q.length < 2 || q.length > 150) throw new ApiError("Search names must contain 2–150 characters.", 400);
  if (!Object.hasOwn(SEARCH_CATEGORIES, category)) throw new ApiError("Unsupported search category.", 400);
  if (cursor.length > 1e3) throw new ApiError("Invalid search cursor.", 400);
  const target = new URL("https://catalog.roblox.com/v1/search/items/details");
  for (const [key, value] of Object.entries(SEARCH_CATEGORIES[category])) target.searchParams.set(key, value);
  target.searchParams.set("Keyword", q);
  target.searchParams.set("Limit", "10");
  target.searchParams.set("SortType", "0");
  target.searchParams.set("IncludeNotForSale", "true");
  if (robloxOnly) {
    target.searchParams.set("CreatorType", "User");
    target.searchParams.set("CreatorTargetId", "1");
  }
  if (cursor) target.searchParams.set("Cursor", cursor);
  const raw = await robloxJson(target.href);
  if (!Array.isArray(raw.data)) throw new ApiError("Roblox returned an invalid search response.");
  const kind = category === "bundles" ? "Bundle" : "Asset";
  const items = raw.data.filter(item => kind === "Bundle" ? item.itemType === "Bundle" && (item.bundleType === "BodyParts" || item.bundleType === 1) : item.itemType === "Asset" && SUPPORTED_ASSETS.has(Number(item.assetType))).map(item => normalizeItem(item, kind));
  await thumbnails(items, kind);
  const exact = items.filter(item => item.name.toLocaleLowerCase() === q.toLocaleLowerCase());
  return {
    items: items,
    nextCursor: raw.nextPageCursor || null,
    exactMatchId: (robloxOnly || !raw.nextPageCursor) && exact.length === 1 ? exact[0].id : null
  };
}

async function details(id, kind) {
  let raw;
  if (kind === "Bundle") {
    raw = await robloxJson("https://catalog.roblox.com/v1/bundles/" + id + "/details");
    if (raw.bundleType !== "BodyParts" && raw.bundleType !== 1) throw new ApiError("This bundle is not a body package supported by your game.", 400);
  } else {
    try {
      raw = await robloxJson("https://economy.roblox.com/v2/assets/" + id + "/details");
    } catch (error) {
      if (error.status === 429) throw error;
      const data = await robloxJson("https://catalog.roblox.com/v1/catalog/items/details", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          items: [ {
            itemType: "Asset",
            id: Number(id)
          } ]
        })
      });
      raw = data.data?.[0];
      if (!raw) throw new ApiError("Roblox could not find that item.", 404);
    }
  }
  const item = normalizeItem(raw, kind);
  if (kind === "Asset" && !SUPPORTED_ASSETS.has(item.assetType)) throw new ApiError("This asset type is not supported. Use an accessory, gear, classic face, classic head, clothing item, or body package.", 400);
  await thumbnails([ item ], kind);
  return {
    item: item
  };
}

const PUBLIC_ASSETS = new Set([ 8, 17, 18, 19, 41, 42, 43, 44, 45, 46, 47, 57, 58, 70, 71 ]);

function isOfficial(item) {
  return item.creatorType === "User" && item.creatorId === 1 && (item.kind === "Bundle" || PUBLIC_ASSETS.has(item.assetType));
}

async function officialAsset(id, kind = "Asset") {
  if (!positiveId(id)) throw new ApiError("Enter a valid base asset ID.", 400);
  const {item: item} = await details(id, kind);
  if (!isOfficial(item)) throw new ApiError("The item must be an accessory, classic face, gear, classic head, or body package created by the official Roblox user account.", 400);
  return item;
}

async function textureAsset(id, allowFace = false) {
  if (!positiveId(id)) throw new ApiError("Enter a valid texture or image asset ID.", 400);
  const item = normalizeItem(await robloxJson("https://economy.roblox.com/v2/assets/" + id + "/details"));
  if (item.assetType === 1) {
    await thumbnails([ item ], "Asset");
    return {
      ...item,
      sourceId: Number(id)
    };
  }
  if (item.assetType !== 13 && !(allowFace && item.assetType === 18)) throw new ApiError("The texture must be an image asset or a decal that contains an image.", 400);
  let url = "https://assetdelivery.roblox.com/v1/asset/?id=" + id;
  const controller = new AbortController, timer = setTimeout(() => controller.abort(), 12e3);
  try {
    for (let hop = 0; hop < 4; hop++) {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !(parsed.hostname === "assetdelivery.roblox.com" || parsed.hostname.endsWith(".rbxcdn.com"))) throw new Error;
      const response = await fetch(url, {
        redirect: "manual",
        signal: controller.signal
      });
      if ([ 301, 302, 303, 307, 308 ].includes(response.status)) {
        url = new URL(response.headers.get("Location"), url).href;
        continue;
      }
      if (!response.ok || Number(response.headers.get("Content-Length") || 0) > 65536) throw new Error;
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const {done: done, value: value} = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 65536) {
            await reader.cancel();
            throw new Error;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const xml = (new TextDecoder).decode(bytes);
      const content = xml.match(/<Content\s+name=["']Texture["'][^>]*>\s*<url>([^<]+)<\/url>/i)?.[1];
      const imageId = content?.match(/(?:rbxassetid:\/\/|[?&]id=)(\d+)/i)?.[1];
      if (!positiveId(imageId) || Number(imageId) === Number(id)) throw new Error;
      const image = normalizeItem(await robloxJson("https://economy.roblox.com/v2/assets/" + imageId + "/details"));
      if (image.assetType !== 1) throw new Error;
      await thumbnails([ image ], "Asset");
      return {
        ...image,
        sourceId: Number(id)
      };
    }
    throw new Error;
  } catch {
    throw new ApiError("This decal's image could not be read. Enter the actual texture image ID instead.", 400);
  } finally {
    clearTimeout(timer);
  }
}

export { ApiError, search, details, robloxJson, normalizeItem, isOfficial, officialAsset, textureAsset };
