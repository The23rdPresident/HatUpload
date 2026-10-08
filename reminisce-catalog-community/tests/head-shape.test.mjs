import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { meshPositions, isDefaultHead } from "../server/head-shape.js";
import { extractHeadModel } from "../server/asset-content.js";

const mesh = new Uint8Array(readFileSync(new URL("./fixtures/default-head.mesh", import.meta.url)));

function sphere() {
  const points = [];
  for (let y = -1; y <= 1.0001; y += .1) for (let angle = 0; angle < 48; angle++) {
    const radius = Math.sqrt(Math.max(0, 1 - y * y)), a = angle * Math.PI / 24;
    points.push(radius * Math.cos(a), y, radius * Math.sin(a));
  }
  return new Float32Array(points);
}

function uncompressed(points) {
  const header = new TextEncoder().encode("version 5.00\n"), bytes = new Uint8Array(header.length + 32 + points.length / 3 * 40), view = new DataView(bytes.buffer);
  bytes.set(header);view.setUint16(header.length,32,true);view.setUint32(header.length+4,points.length/3,true);
  for (let n = 0; n < points.length; n++) view.setFloat32(header.length+32+Math.floor(n/3)*40+n%3*4,points[n],true);
  return bytes;
}

test("default head geometry is recognized across mesh encoding while round and stretched heads stay heads", async () => {
  const points = await meshPositions(mesh);
  assert.equal(isDefaultHead(points), true);
  assert.equal(isDefaultHead(await meshPositions(uncompressed(points))), true);
  assert.equal(isDefaultHead(await meshPositions(uncompressed(sphere()))), false);
  assert.equal(isDefaultHead(points, [2,1,1]), false);
  assert.equal(isDefaultHead(points, [1,1,2]), false);
  assert.equal(isDefaultHead(points, [2,2,2]), true);
});

test("mesh parsing rejects truncation, oversized sections, missing positions and invalid geometry", async () => {
  for (const size of [0,10,26,mesh.length-1]) await assert.rejects(meshPositions(mesh.subarray(0,size)));
  const excessive = mesh.slice();new DataView(excessive.buffer).setUint32(25, 2000000, true);
  await assert.rejects(meshPositions(excessive), /Oversized/);
  const missing = mesh.slice();missing[13] = 88;
  await assert.rejects(meshPositions(missing), /Missing/);
  const bad = mesh.slice();bad[41] = 1;
  await assert.rejects(meshPositions(bad), /Unsupported/);
  assert.equal(isDefaultHead(new Float32Array([NaN,0,1,0,0,0])), false);
  assert.equal(isDefaultHead(new Float32Array([0,0,0,0,0,0])), false);
});

test("head inspection separates front decals from mesh textures and rejects multiple meshes and foreign content", () => {
  const bytes = text => new TextEncoder().encode(text);
  const head = '<Item class="SpecialMesh"><Properties><token name="MeshType">0</token><Content name="TextureId"><url>rbxassetid://900</url></Content></Properties></Item>';
  const decal = (face, id) => '<Item class="Decal"><Properties><token name="Face">' + face + '</token><Content name="Texture"><url>rbxassetid://' + id + '</url></Content></Properties></Item>';
  assert.deepEqual(extractHeadModel(bytes('<roblox>' + head + decal(5,204) + decal(2,200) + '</roblox>')), { meshId:null,builtin:true,scale:[1,1,1],faceTextureIds:[204] });
  assert.deepEqual(extractHeadModel(bytes('<roblox>' + head + '</roblox>')).faceTextureIds, []);
  assert.throws(() => extractHeadModel(bytes('<roblox>' + head + head + '</roblox>')), /single/);
  assert.throws(() => extractHeadModel(bytes('<!DOCTYPE roblox><roblox>' + head + '</roblox>')));
  assert.throws(() => extractHeadModel(bytes('<Item class="SpecialMesh"><Properties><Content name="MeshId"><url>https://evil.test/1</url></Content></Properties></Item>')));
  const binary = extractHeadModel(new Uint8Array(readFileSync(new URL("./fixtures/dynamic-head.rbxm", import.meta.url))));
  assert.equal(binary.meshId, 133902161072571);
  assert.deepEqual(binary.scale, [1,1,1]);
  assert.deepEqual(binary.faceTextureIds, []);
});
