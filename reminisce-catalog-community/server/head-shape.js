import { dracoPositions } from "./draco.js";

const decoder = new TextDecoder();
const standard = [0.857, 0.982, 1.004, 1.004, 1.004, 1.004, 1.004, 1.004, 0.966, 0.857];

export async function meshPositions(bytes) {
  if (bytes.length > 1048576) throw new Error("Oversized head mesh");
  const end = bytes.subarray(0, 20).indexOf(10), version = decoder.decode(bytes.subarray(0, end));
  if (end < 0) throw new Error("Missing mesh header");
  const start = end + 1, view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (version === "version 7.00") {
    let position = start, core = null;
    while (position < bytes.length) {
      if (position + 16 > bytes.length) throw new Error("Truncated mesh section");
      const tag = decoder.decode(bytes.subarray(position, position + 8)), size = view.getUint32(position + 12, true), next = position + 16 + size;
      if (next > bytes.length || size > 1048576) throw new Error("Oversized mesh section");
      if (tag === "COREMESH") {
        if (core || view.getUint32(position + 8, true) !== 2 || size < 19 || view.getUint32(position + 16, true) !== size - 4) throw new Error("Invalid core mesh");
        core = bytes.subarray(position + 20, next);
      }
      position = next;
    }
    if (!core) throw new Error("Missing core mesh");
    return dracoPositions(core);
  }
  if (!["version 2.00", "version 3.00", "version 3.01", "version 4.00", "version 4.01", "version 5.00"].includes(version) || bytes.length < start + 12) throw new Error("Unsupported head mesh version");
  const header = view.getUint16(start, true), modern = /version [45]/.test(version), stride = modern ? 40 : bytes[start + 2], count = view.getUint32(start + 4, true);
  if (header < 12 || header > 64 || ![36, 40].includes(stride) || count < 4 || count > 12000 || start + header + count * stride > bytes.length) throw new Error("Invalid head mesh vertices");
  const values = new Float32Array(count * 3);
  for (let n = 0; n < count; n++) for (let axis = 0; axis < 3; axis++) values[n * 3 + axis] = view.getFloat32(start + header + n * stride + axis * 4, true);
  return values;
}

export function isDefaultHead(points, scale = [1, 1, 1]) {
  if (!points.length || points.length % 3 || points.length > 36000 || scale.length !== 3 || scale.some(value => !Number.isFinite(value) || value <= 0)) return false;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let n = 0; n < points.length; n++) {
    const value = points[n] * scale[n % 3], axis = n % 3;
    if (!Number.isFinite(value) || Math.abs(value) > 1000) return false;
    min[axis] = Math.min(min[axis], value);
    max[axis] = Math.max(max[axis], value);
  }
  const widths = max.map((value, axis) => value - min[axis]), radius = widths[0] / 2, half = widths[1] / 2;
  if (radius < 0.001 || half < 0.001 || Math.abs(widths[2] / widths[0] - 1) > 0.12 || Math.abs(widths[1] / widths[0] - 1) > 0.15) return false;
  const center = max.map((value, axis) => (value + min[axis]) / 2), profile = new Array(10).fill(0), present = new Set();
  for (let n = 0; n < points.length; n += 3) {
    const height = (points[n + 1] * scale[1] - center[1]) / half;
    const bin = Math.min(9, Math.max(0, Math.floor((height + 1) * 5)));
    const distance = Math.hypot(points[n] * scale[0] - center[0], points[n + 2] * scale[2] - center[2]) / radius;
    profile[bin] = Math.max(profile[bin], distance);
    present.add(bin);
  }
  if (present.size < 8) return false;
  const errors = [...present].map(bin => Math.abs(profile[bin] - standard[bin]));
  return Math.max(...errors) <= 0.18 && errors.reduce((sum, value) => sum + value, 0) / errors.length <= 0.09;
}
