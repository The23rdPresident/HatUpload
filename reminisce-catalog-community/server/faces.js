import data from "../data/classic-faces.json" with { type: "json" };
import knownHeads from "../data/dynamic-heads.json" with { type: "json" };
import { ApiError, officialAsset, textureAsset, robloxJson, thumbnails, normalizeItem, assetBytes, isAllowedHead } from "./catalog.js";
import { extractHeadModel } from "./asset-content.js";
import { meshPositions, isDefaultHead } from "./head-shape.js";

const faces = new Map(data.faces.map(face => [face.id, face]));
const nameKey = value => String(value).normalize("NFKC").replace(/[‘’]/g, "'").replace(/[‐‑–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
const aliases = new Map([["man", "man face"], ["woman", "woman face"], ["stevie", "smile"], ["o_o", "o.o"]]);
const creator = item => ["User", "Group"].includes(item.creatorType) && Number.isSafeInteger(item.creatorId) && item.creatorId > 0;
const belongs = (bundle, id) => (bundle.items || []).some(item => item.type === "Asset" && Number(item.id) === id);
const dynamicBundle = bundle => bundle.bundleType === "DynamicHead" || bundle.bundleType === 4;

function classicItem(face, source = null) {
  return {
    id: face.id, name: face.name, description: face.description, textureId: face.textureId,
    kind: "Asset", assetType: 18, creatorName: "Roblox", creatorType: "User", creatorId: 1, thumbnail: "",
    classicFaceId: face.id, sourceId: source?.sourceId || source?.id || face.id, sourceKind: source?.sourceKind || source?.kind || "Asset",
    sourceAssetId: source?.id || face.id, sourceName: source?.name || face.name, sourceCreatorName: source?.creatorName || "Roblox",
    faceTextureRequired: false
  };
}

function namedFaces(name) {
  let key = nameKey(name).replace(/\s*(?:-\s*)?(?:dynamic head|animated head|head)$/i, "").trim();
  key = aliases.get(key) || key;
  return [...faces.values()].filter(face => nameKey(face.name) === key);
}

function singleFace(candidates) {
  const matches = [...new Map(candidates.map(face => [face.id, face])).values()];
  if (!matches.length) return null;
  if (new Set(matches.map(face => face.textureId)).size !== 1) throw new ApiError("Several classic faces match this item. Paste the specific classic face link instead.", 400);
  return matches.sort((a, b) => a.id - b.id)[0];
}

async function resolved(face, source) {
  if (!face.verifiedOfficial) {
    const base = await officialAsset(face.id);
    if (base.creatorType !== "User" || base.creatorId !== 1 || ![18, 79].includes(base.assetType)) throw new ApiError("The original classic face could not be verified as a Roblox item.", 400);
  }
  const texture = await textureAsset(face.textureId), item = classicItem({ ...face, textureId: texture.id }, source);
  await thumbnails([item], "Asset");
  if (!item.thumbnail) item.thumbnail = texture.thumbnail;
  return { item, texture };
}

function reviewed(source, records) {
  return records.find(record => record.assetId === source.id && record.creatorType === source.creatorType && record.creatorId === source.creatorId);
}

async function sourceItem(id, kind, existing) {
  if (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) < 1) throw new ApiError("Enter a valid Roblox asset or bundle ID.", 400);
  id = Number(id);
  if (kind !== "Bundle") return { source: existing || await officialAsset(id), bundle: null };
  const bundle = await robloxJson("https://catalog.roblox.com/v1/bundles/" + id + "/details"), raw = normalizeItem(bundle, "Bundle");
  if (Number(bundle.id) !== id || !creator(raw)) throw new ApiError("The bundle's creator could not be verified.", 400);
  if (!dynamicBundle(bundle)) return { source: await officialAsset(id, kind), bundle };
  const assets = (bundle.items || []).filter(item => item.type === "Asset" && Number.isSafeInteger(Number(item.id)) && Number(item.id) > 0);
  if (!assets.length || assets.length > 20) throw new ApiError("This bundle does not contain a single supported head.", 400);
  let heads = assets.filter(item => Number(item.assetType) === 79);
  if (!heads.length) {
    const info = await robloxJson("https://catalog.roblox.com/v1/catalog/items/details", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items: assets.map(item => ({ itemType: "Asset", id: Number(item.id) })) }) });
    heads = (info.data || []).filter(item => item.assetType === 79 && assets.some(asset => Number(asset.id) === Number(item.id)));
  }
  if (heads.length !== 1) throw new ApiError("This bundle does not contain a single supported head.", 400);
  const source = await officialAsset(heads[0].id);
  if (source.assetType !== 79 || source.creatorType !== raw.creatorType || source.creatorId !== raw.creatorId) throw new ApiError("The bundle's head and creator do not match.", 400);
  return { source: { ...source, sourceId: id, sourceKind: "Bundle", name: bundle.name || source.name, description: bundle.description || source.description }, bundle };
}

async function relatedBundles(source) {
  try {
    const result = await robloxJson("https://catalog.roblox.com/v1/assets/" + source.id + "/bundles?limit=100");
    return (result.data || []).slice(0, 100).filter(bundle => belongs(bundle, source.id) && Number(bundle.creator?.id) === source.creatorId && bundle.creator?.type === source.creatorType);
  } catch (error) {
    if (error.status !== 404) throw error;
    return [];
  }
}

async function originalFace(source, bundle) {
  const confirmed = reviewed(source, knownHeads.faces);
  if (confirmed) return faces.get(confirmed.classicFaceId);
  if (source.creatorType === "User" && source.creatorId === 1) {
    const mapped = bundle && faces.get(Number(data.bundles[String(bundle.id)]));
    if (mapped && belongs(bundle, source.id)) return mapped;
    const named = singleFace(namedFaces(source.name));
    if (named) return named;
    const bundles = await relatedBundles(source);
    return singleFace(bundles.flatMap(item => {
      const face = faces.get(Number(data.bundles[String(item.id)]));
      return face ? [face] : [];
    }));
  }
  return null;
}

async function inspect(source) {
  const model = extractHeadModel(await assetBytes(source.id));
  if (model.builtin) {
    const [x, y, z] = model.scale;
    return { model, standard: [x, y, z].every(value => Number.isFinite(value) && value > 0) && Math.abs(x / y - 1) < 0.12 && Math.abs(x / z - 1) < 0.12 };
  }
  if (knownHeads.defaultMeshes.includes(model.meshId) && model.scale.every(value => Number.isFinite(value) && value > 0 && Math.abs(value / model.scale[0] - 1) < 0.02)) return { model, standard: true };
  return { model, standard: isDefaultHead(await meshPositions(await assetBytes(model.meshId, 1048576)), model.scale) };
}

async function creatorClassic(source) {
  const key = nameKey(source.name).replace(/\s*(?:-\s*)?(?:dynamic head|animated head|head)$/i, "").trim();
  const endpoint = new URL("https://catalog.roblox.com/v1/search/items/details");
  for (const [key, value] of Object.entries({ Category: "4", Subcategory: "10", Keyword: source.name.replace(/\s*(?:-\s*)?(?:dynamic head|animated head|head)$/i, ""), CreatorType: source.creatorType, CreatorTargetId: String(source.creatorId), IncludeNotForSale: "true", Limit: "10" })) endpoint.searchParams.set(key, value);
  const result = await robloxJson(endpoint.href);
  const matches = (result.data || []).map(item => normalizeItem(item)).filter(item => item.assetType === 18 && item.creatorType === source.creatorType && item.creatorId === source.creatorId && nameKey(item.name) === key);
  if (matches.length !== 1) return null;
  return resolveFace(matches[0].id);
}

function faceItem(source, texture = null) {
  return { ...source, assetType: 18, robloxAssetType: source.assetType, textureId: texture?.id || null, faceTextureRequired: !texture, sourceAssetId: source.id, sourceId: source.sourceId || source.id, sourceKind: source.sourceKind || "Asset", headShape: "default" };
}

export async function resolveItem(id, kind = "Asset", existing = null) {
  if (kind !== "Bundle" && faces.has(Number(id))) return resolved(faces.get(Number(id)), { id: Number(id), kind: "Asset" });
  const { source, bundle } = await sourceItem(id, kind, existing);
  if (source.assetType === 18) {
    const texture = await textureAsset(source.id, true);
    return { item: { ...faceItem(source, texture), classicFaceId: source.id }, texture };
  }
  if (source.assetType !== 79 || !isAllowedHead(source)) return { item: source };
  if (globalThis.CatalogCore.isHeadlessAsset(source.id) || reviewed(source, knownHeads.heads)) return { item: { ...source, headShape: "custom" } };
  const classic = await originalFace(source, bundle);
  if (classic) return resolved(classic, source);
  let inspected;
  try {
    inspected = await inspect(source);
  } catch (error) {
    if (error instanceof ApiError && error.status !== 400) throw error;
    return { item: { ...source, headShape: "unavailable" } };
  }
  if (!inspected.standard) return { item: { ...source, headShape: "custom" } };
  const names = singleFace([...namedFaces(source.name), ...(bundle ? namedFaces(bundle.name) : [])]);
  if (names) return resolved(names, source);
  if (inspected.model.faceTextureIds.length === 1) {
    const texture = await textureAsset(inspected.model.faceTextureIds[0]);
    return { item: faceItem(source, texture), texture };
  }
  if (inspected.model.faceTextureIds.length > 1) throw new ApiError("This head contains several front face images. Paste the intended classic face link instead.", 400);
  const created = await creatorClassic(source);
  if (created) return created;
  return { item: faceItem(source), texture: null };
}

export async function resolveFace(id, kind = "Asset", existing = null) {
  const result = await resolveItem(id, kind, existing);
  if (result.item.assetType !== 18) throw new ApiError(result.item.assetType === 79 || result.item.assetType === 17 ? "This item has a different head shape. Upload it as a Head, or paste a classic face link." : "Choose a classic face or a face on the default Roblox head.", 400);
  return result;
}

export async function searchFaces(url) {
  const query = (url.searchParams.get("q") || "").trim(), cursor = url.searchParams.get("cursor") || "";
  if (query.length < 2 || query.length > 150) throw new ApiError("Search names must contain 2–150 characters.", 400);
  let state = { offset: 0, live: "", liveDone: false };
  if (cursor) {
    if (!cursor.startsWith("faces:") || cursor.length > 1600) throw new ApiError("Invalid face search cursor.", 400);
    try { state = JSON.parse(atob(cursor.slice(6))); } catch { throw new ApiError("Invalid face search cursor.", 400); }
    if (!state || typeof state !== "object" || Array.isArray(state) || !Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > faces.size || typeof state.live !== "string" || state.live.length > 1000 || typeof state.liveDone !== "boolean") throw new ApiError("Invalid face search cursor.", 400);
  }
  const key = aliases.get(nameKey(query)) || nameKey(query), score = face => nameKey(face.name) === key ? 0 : nameKey(face.name).startsWith(key) ? 1 : 2;
  const matches = [...faces.values()].filter(face => nameKey(face.name).includes(key)).sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name) || a.id - b.id);
  const archived = matches.slice(state.offset, state.offset + 6).map(face => classicItem(face));
  state.offset += archived.length;
  let live = [], liveError = "";
  if (!state.liveDone) {
    const endpoint = new URL("https://catalog.roblox.com/v1/search/items/details");
    for (const [key, value] of Object.entries({ Category: "1", Keyword: query, IncludeNotForSale: "true", Limit: "10", SortType: "0", ...(state.live ? { Cursor: state.live } : {}) })) endpoint.searchParams.set(key, value);
    try {
      const result = await robloxJson(endpoint.href);
      live = (result.data || []).flatMap(raw => {
        if (raw.itemType === "Bundle" && [4, "DynamicHead"].includes(raw.bundleType)) return [{ ...normalizeItem(raw, "Bundle"), assetType: 79 }];
        const item = normalizeItem(raw);
        return [18, 79].includes(item.assetType) && creator(item) && !faces.has(item.id) ? [item] : [];
      });
      state.live = typeof result.nextPageCursor === "string" ? result.nextPageCursor : "";
      state.liveDone = !state.live;
    } catch (error) {
      if (!archived.length) throw error;
      state.liveDone = true;
      liveError = "Live Roblox results could not be loaded. Classic faces are shown; paste a UGC item link to retry.";
    }
  }
  await thumbnails(archived, "Asset");
  await thumbnails(live.filter(item => item.kind === "Asset"), "Asset");
  await thumbnails(live.filter(item => item.kind === "Bundle"), "Bundle");
  const items = [...archived, ...live], exact = matches.filter(face => nameKey(face.name) === key);
  return { items, nextCursor: state.offset < matches.length || !state.liveDone ? "faces:" + btoa(JSON.stringify(state)) : null, exactMatchId: exact.length === 1 ? exact[0].id : null, message: liveError };
}
