import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";

const configPath = resolve("wrangler.jsonc");
let input = process.argv[2];
try {
  if (!input) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try { input = await prompt.question("Roblox experience Universe ID: "); } finally { prompt.close(); }
  }
  const universeId = String(input).trim();
  if (!/^[1-9]\d{0,15}$/.test(universeId) || !Number.isSafeInteger(Number(universeId))) throw new Error("Enter the numeric Universe ID, not a game link or place ID.");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(configPath + ".backup", JSON.stringify(config, null, 2) + "\n");
  config.vars = { ...config.vars, ROBLOX_UNIVERSE_ID: universeId, ROBLOX_AUTO_PUBLISH: "true" };
  config.triggers = { ...config.triggers, crons: [...new Set([...(config.triggers?.crons || ["17 4 * * *"]), "* * * * *"])] };
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  console.log("Automatic publishing configured for experience " + universeId + ".");
  console.log("Next: npx wrangler secret put ROBLOX_API_KEY, then build and deploy.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
