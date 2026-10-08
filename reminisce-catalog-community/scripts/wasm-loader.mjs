import { readFile } from "node:fs/promises";

export async function load(url, context, nextLoad) {
  if (!url.endsWith(".wasm")) return nextLoad(url, context);
  const bytes = await readFile(new URL(url));
  return {
    format: "module",
    shortCircuit: true,
    source: "export default new WebAssembly.Module(Buffer.from(" + JSON.stringify(bytes.toString("base64")) + ", 'base64'));"
  };
}
