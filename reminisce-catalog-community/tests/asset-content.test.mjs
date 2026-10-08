import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractTextureId } from "../server/asset-content.js";

const binary = new Uint8Array(readFileSync(new URL("./fixtures/classic-face.rbxm", import.meta.url)));
const xml = readFileSync(new URL("./fixtures/classic-face.rbxmx", import.meta.url));

test("original Roblox XML and binary face assets resolve to their image texture", () => {
  assert.equal(extractTextureId(xml), 83017053);
  assert.equal(extractTextureId(binary), 83017053);
});

test("texture extraction rejects foreign URLs, mesh textures, ambiguous decals and entity declarations", () => {
  const bytes = value => new TextEncoder().encode(value);
  const decal = texture => '<Item class="Decal"><Properties><Content name="Texture"><url>' + texture + '</url></Content></Properties></Item>';
  for (const source of [
    '<roblox>' + decal('https://evil.test/?id=100') + '</roblox>',
    '<roblox><Item class="SpecialMesh"><Properties><Content name="Texture"><url>rbxassetid://100</url></Content></Properties></Item></roblox>',
    '<roblox>' + decal('rbxassetid://100') + decal('rbxassetid://200') + '</roblox>',
    '<!DOCTYPE roblox [<!ENTITY texture "rbxassetid://100">]><roblox>' + decal('&texture;') + '</roblox>',
    '<roblox>' + decal('rbxassetid://9007199254740992') + '</roblox>'
  ]) assert.throws(() => extractTextureId(bytes(source)));
});

test("binary parsing bounds compressed chunks and rejects truncated or malformed models", () => {
  for (const end of [7, 25, 45, binary.length - 1]) assert.throws(() => extractTextureId(binary.slice(0, end)));
  const oversized = binary.slice();
  new DataView(oversized.buffer).setUint32(40, 65537, true);
  assert.throws(() => extractTextureId(oversized), /Oversized/);
  const invalidOffset = binary.slice();
  invalidOffset[48] = 0;
  invalidOffset[49] = 0;
  invalidOffset[50] = 0;
  assert.throws(() => extractTextureId(invalidOffset));
});
