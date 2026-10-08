const decoder = new TextDecoder("utf-8", { fatal: true });
const maxBytes = 65536;

function imageId(value) {
  const text = value.replace(/&amp;/g, "&").trim();
  const match = text.match(/^rbxassetid:\/\/(\d+)$/i) || text.match(/^https?:\/\/(?:(?:www\.)?roblox\.com\/asset\/?|assetdelivery\.roblox\.com\/v1\/asset\/?|assetgame\.roblox\.com\/asset\/?|www\.roblox\.com\/asset-thumbnail\/image)\?(?:[^#]*&)?id=(\d+)(?:&[^#]*)?$/i);
  const id = Number(match?.[1]);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid image reference");
  return id;
}

function lz4(bytes, size) {
  if (size > maxBytes) throw new Error("Oversized model chunk");
  const output = new Uint8Array(size);
  let input = 0, written = 0;
  function length(value) {
    if (value !== 15) return value;
    let extra;
    do {
      if (input >= bytes.length) throw new Error("Truncated compressed chunk");
      extra = bytes[input++];
      value += extra;
      if (value > maxBytes) throw new Error("Oversized compressed chunk");
    } while (extra === 255);
    return value;
  }
  while (input < bytes.length) {
    const token = bytes[input++];
    const literal = length(token >> 4);
    if (input + literal > bytes.length || written + literal > size) throw new Error("Invalid compressed literal");
    output.set(bytes.subarray(input, input + literal), written);
    input += literal;
    written += literal;
    if (input === bytes.length) break;
    if (input + 2 > bytes.length) throw new Error("Truncated compressed offset");
    const offset = bytes[input++] | bytes[input++] << 8;
    const count = length(token & 15) + 4;
    if (!offset || offset > written || written + count > size) throw new Error("Invalid compressed match");
    for (let n = 0; n < count; n++) {
      output[written] = output[written - offset];
      written++;
    }
  }
  if (written !== size) throw new Error("Invalid decompressed size");
  return output;
}

function modelTextures(bytes) {
  if (bytes.length < 32 || bytes.length > maxBytes || decoder.decode(bytes.subarray(0, 8)) !== "<roblox!" || ![137, 255, 13, 10, 26, 10, 0, 0].every((value, index) => bytes[index + 8] === value)) throw new Error("Invalid model header");
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(16, true) > 32 || header.getUint32(20, true) > 128) throw new Error("Oversized model");
  const classes = new Map(), textures = [];
  let position = 32, expanded = 0, ended = false;
  while (position < bytes.length) {
    if (position + 16 > bytes.length) throw new Error("Truncated model chunk");
    const tag = decoder.decode(bytes.subarray(position, position + 4));
    const compressed = header.getUint32(position + 4, true), size = header.getUint32(position + 8, true);
    const end = position + 16 + (compressed || size);
    expanded += size;
    if (size > maxBytes || expanded > maxBytes * 4 || end > bytes.length) throw new Error("Oversized model chunk");
    const raw = bytes.subarray(position + 16, end);
    position = end;
    if (tag === "END\0") {
      ended = true;
      break;
    }
    if (tag !== "INST" && tag !== "PROP") continue;
    const data = compressed ? lz4(raw, size) : raw;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let cursor = 0;
    function number() {
      if (cursor + 4 > data.length) throw new Error("Truncated model number");
      const value = view.getUint32(cursor, true);
      cursor += 4;
      return value;
    }
    function string() {
      const length = number();
      if (cursor + length > data.length) throw new Error("Truncated model string");
      const value = decoder.decode(data.subarray(cursor, cursor + length));
      cursor += length;
      return value;
    }
    const id = number(), name = string();
    if (tag === "INST") {
      if (cursor >= data.length || data[cursor++] !== 0) throw new Error("Invalid decal model class");
      const count = number();
      if (count > 128 || classes.has(id) || cursor + count * 4 !== data.length) throw new Error("Invalid model instances");
      classes.set(id, { name, count });
    } else {
      const type = data[cursor++], group = classes.get(id);
      if (!group) throw new Error("Unknown model class");
      if (group.name !== "Decal" || name !== "Texture") continue;
      if (type !== 1) throw new Error("Unsupported texture property");
      for (let i = 0; i < group.count; i++) textures.push(imageId(string()));
      if (cursor !== data.length) throw new Error("Invalid texture property");
    }
  }
  if (!ended || position !== bytes.length) throw new Error("Incomplete decal model");
  return textures;
}

export function extractTextureId(bytes) {
  const binary = bytes.length >= 8 && decoder.decode(bytes.subarray(0, 8)) === "<roblox!";
  let textures;
  if (binary) textures = modelTextures(bytes);
  else {
    if (bytes.length > maxBytes) throw new Error("Oversized decal");
    const xml = decoder.decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsupported XML declaration");
    textures = [...xml.matchAll(/<Item\b[^>]*\bclass=["']Decal["'][^>]*>([\s\S]*?)<\/Item>/gi)].flatMap(item => [...item[1].matchAll(/<Content\s+name=["']Texture["'][^>]*>\s*<url>([^<]+)<\/url>\s*<\/Content>/gi)].map(match => imageId(match[1])));
  }
  const ids = [...new Set(textures)];
  if (ids.length !== 1) throw new Error("A single decal texture is required");
  return ids[0];
}

function headProperties(bytes) {
  if (bytes.length < 32 || bytes.length > maxBytes) throw new Error("Invalid head model size");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), classes = new Map();
  if (view.getUint32(16, true) > 32 || view.getUint32(20, true) > 128) throw new Error("Oversized head model");
  let position = 32, expanded = 0, ended = false;
  while (position < bytes.length) {
    if (position + 16 > bytes.length) throw new Error("Truncated head model");
    const tag = decoder.decode(bytes.subarray(position, position + 4)), compressed = view.getUint32(position + 4, true), size = view.getUint32(position + 8, true), end = position + 16 + (compressed || size);
    expanded += size;
    if (size > maxBytes || end > bytes.length || expanded > maxBytes * 4) throw new Error("Oversized head model chunk");
    const raw = bytes.subarray(position + 16, end);
    position = end;
    if (tag === "END\0") { ended = true; break; }
    if (!["INST", "PROP"].includes(tag)) continue;
    const data = compressed ? lz4(raw, size) : raw, chunk = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let cursor = 0;
    function number() {
      if (cursor + 4 > data.length) throw new Error("Truncated head property");
      const value = chunk.getUint32(cursor, true);
      cursor += 4;
      return value;
    }
    function string() {
      const size = number();
      if (cursor + size > data.length) throw new Error("Truncated head string");
      const value = decoder.decode(data.subarray(cursor, cursor + size));
      cursor += size;
      return value;
    }
    const id = number(), name = string();
    if (tag === "INST") {
      if (data[cursor++] !== 0) throw new Error("Unsupported head class");
      const count = number();
      if (!count || count > 128 || classes.has(id) || cursor + count * 4 !== data.length) throw new Error("Invalid head instances");
      classes.set(id, Array.from({ length: count }, () => ({ class: name, props: {} })));
      continue;
    }
    const group = classes.get(id), type = data[cursor++];
    if (!group) throw new Error("Unknown head class");
    if (!group.some(item => ["MeshPart", "SpecialMesh", "Decal"].includes(item.class)) || !["MeshId", "MeshID", "TextureID", "TextureId", "Texture", "MeshType", "Face", "Scale"].includes(name)) continue;
    if (group.some(item => Object.hasOwn(item.props, name))) throw new Error("Duplicate head property");
    if (type === 1) for (const item of group) item.props[name] = string();
    else if (type === 18 || type === 14) {
      const count = group.length, axes = type === 14 ? 3 : 1;
      if (cursor + count * 4 * axes !== data.length) throw new Error("Invalid head numeric property");
      for (let n = 0; n < count; n++) {
        const values = [];
        for (let axis = 0; axis < axes; axis++) {
          let bits = 0;
          for (let byte = 0; byte < 4; byte++) bits = (bits << 8) | data[cursor + axis * count * 4 + byte * count + n];
          if (type === 14) {
            const buffer = new ArrayBuffer(4), value = new DataView(buffer);
            value.setUint32(0, (bits >>> 1) | (bits << 31));
            values.push(value.getFloat32(0));
          } else values.push(bits >>> 0);
        }
        group[n].props[name] = axes === 1 ? values[0] : values;
      }
      cursor = data.length;
    } else throw new Error("Unsupported head property type");
    if (cursor !== data.length) throw new Error("Invalid head property length");
  }
  if (!ended || position !== bytes.length) throw new Error("Incomplete head model");
  return [...classes.values()].flat();
}

export function extractHeadModel(bytes) {
  if (bytes.length > maxBytes) throw new Error("Oversized head model");
  let instances;
  if (bytes.length >= 16 && decoder.decode(bytes.subarray(0, 8)) === "<roblox!") {
    if (![137, 255, 13, 10, 26, 10, 0, 0].every((value, index) => bytes[index + 8] === value)) throw new Error("Invalid head model header");
    instances = headProperties(bytes);
  } else {
    const xml = decoder.decode(bytes);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Unsupported head XML");
    instances = [...xml.matchAll(/<Item\b[^>]*\bclass=["'](MeshPart|SpecialMesh|Decal)["'][^>]*>\s*<Properties>([\s\S]*?)<\/Properties>/gi)].map(match => {
      const props = {};
      for (const content of match[2].matchAll(/<Content\s+name=["']([^"']+)["'][^>]*>\s*(?:<url>([^<]+)<\/url>|<null\s*\/>)\s*<\/Content>/gi)) props[content[1]] = content[2] || "";
      for (const value of match[2].matchAll(/<token\s+name=["'](MeshType|Face)["']\s*>(\d+)<\/token>/gi)) props[value[1]] = Number(value[2]);
      const scale = match[2].match(/<Vector3\s+name=["']Scale["']\s*>\s*<X>([^<]+)<\/X>\s*<Y>([^<]+)<\/Y>\s*<Z>([^<]+)<\/Z>\s*<\/Vector3>/i);
      if (scale) props.Scale = scale.slice(1).map(Number);
      return { class: match[1], props };
    });
  }
  const heads = instances.filter(item => ["MeshPart", "SpecialMesh"].includes(item.class));
  if (heads.length !== 1) throw new Error("A single head mesh is required");
  const props = heads[0].props, reference = props.MeshId || props.MeshID || "";
  const meshId = reference ? imageId(reference) : null;
  const builtin = heads[0].class === "SpecialMesh" && props.MeshType === 0 && !meshId;
  if (!builtin && !meshId) throw new Error("Missing head mesh ID");
  const decals = instances.filter(item => item.class === "Decal" && (item.props.Face === undefined || item.props.Face === 5) && item.props.Texture).map(item => imageId(item.props.Texture));
  return { meshId, builtin, scale: props.Scale || [1, 1, 1], faceTextureIds: [...new Set(decals)] };
}
