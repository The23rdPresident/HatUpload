import { readFile, writeFile } from "node:fs/promises";
import "../shared/core.js";

const core = globalThis.CatalogCore;
const items = JSON.parse(await readFile(new URL("../data/current-items.json", import.meta.url), "utf8"));
const quote = value => "'" + String(value).replace(/'/g, "''") + "'";
const lines = [];
for (const item of items) {
  lines.push("INSERT OR IGNORE INTO catalog_items(id,name,item_type,asset_id,source,draft_json) VALUES(" + [ item.id, item.name, item.itemType ].map(quote).join(",") + "," + Number(item.assetId) + ",'existing'," + quote(JSON.stringify(item)) + ");");
  const keys = core.registryKeys({ ...item, customTexture: false, texture: "" });
  if (item.itemType === "Face" && Number(item.assetId)) keys.push("face-texture:" + Number(item.assetId));
  for (const key of keys) {
    lines.push("INSERT INTO catalog_keys(key,item_id) VALUES(" + quote(key) + "," + quote(item.id) + ") ON CONFLICT(key) DO UPDATE SET item_id=excluded.item_id WHERE catalog_keys.item_id NOT LIKE 'existing:%';");
  }
}
await writeFile(new URL("../migrations/0003_seed_catalog.sql", import.meta.url), lines.join("\n") + "\n");
console.log("Prepared " + items.length + " existing catalog items.");
