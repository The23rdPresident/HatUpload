import createDecoder from "./vendor/draco-decoder.js";
import compiled from "./vendor/draco-decoder.wasm";

let decoderModule;

function module() {
  decoderModule ||= createDecoder({
    instantiateWasm(imports, ready) {
      const instance = new WebAssembly.Instance(compiled, imports);
      ready(instance, compiled);
      return instance.exports;
    },
    print() {},
    printErr() {}
  });
  return decoderModule;
}

export async function dracoPositions(bytes) {
  if (bytes.length < 15 || bytes.length > 1048576 || new TextDecoder().decode(bytes.subarray(0, 5)) !== "DRACO" || bytes[5] !== 2 || bytes[7] !== 1 || bytes[8] !== 0) throw new Error("Unsupported compressed mesh");
  let cursor = 11;
  function count() {
    let value = 0;
    for (let shift = 0; shift < 28; shift += 7) {
      if (cursor >= bytes.length) throw new Error("Truncated mesh count");
      const part = bytes[cursor++];
      value |= (part & 127) << shift;
      if (!(part & 128)) return value;
    }
    throw new Error("Invalid mesh count");
  }
  const faces = count(), points = count();
  if (points < 4 || points > 12000 || faces < 4 || faces > 24000) throw new Error("Oversized compressed mesh");
  const d = await module(), buffer = new d.DecoderBuffer(), decoder = new d.Decoder(), mesh = new d.Mesh(), values = new d.DracoFloat32Array();
  let status;
  try {
    buffer.Init(bytes, bytes.length);
    status = decoder.DecodeBufferToMesh(buffer, mesh);
    if (!status.ok() || mesh.num_points() !== points || mesh.num_faces() !== faces || mesh.num_attributes() > 16) throw new Error("Invalid compressed mesh");
    const index = decoder.GetAttributeId(mesh, d.POSITION);
    if (index < 0) throw new Error("Missing mesh positions");
    const attribute = decoder.GetAttribute(mesh, index);
    if (attribute.num_components() !== 3 || !decoder.GetAttributeFloatForAllPoints(mesh, attribute, values) || values.size() !== points * 3) throw new Error("Invalid mesh positions");
    return Float32Array.from({ length: points * 3 }, (_, index) => values.GetValue(index));
  } finally {
    if (status) d.destroy(status);
    for (const value of [values, mesh, decoder, buffer]) d.destroy(value);
  }
}
