import test from "node:test";

import assert from "node:assert/strict";

import template from "../server/publisher.js";

import "../shared/core.js";

const core = globalThis.CatalogCore;

const item = (changes = {}) => ({
  ...core.defaults(),
  name: "New catalog variant",
  assetId: "133559536",
  price: "500",
  ...changes
});

test("prices include 0 and 50,000 and reject fractional, negative and excessive values", () => {
  for (const price of ["0", "50000"]) {
    assert.deepEqual(core.validate(item({ price })), []);
    assert.equal(core.buildDefinition(item({ price })).Price, Number(price));
  }
  for (const price of ["-1", "1.5", "50001", "9007199254740992", "", "1e4"]) {
    assert.match(core.validate(item({ price })).join(" "), /0 to 50,000/);
    assert.throws(() => core.buildDefinition(item({ price })));
  }
});

test("both limited types use whole stock from 10 through 500; normal stock is unlimited", () => {
  for (const catalogType of ["limited", "limited-u"]) {
    for (const stock of ["10", "500"]) {
      assert.deepEqual(core.validate(item({ catalogType, stock })), []);
      assert.equal(core.buildDefinition(item({ catalogType, stock })).Stock, Number(stock));
    }
    for (const stock of ["0", "9", "501", "10.5", "-10", "", "Infinity"]) {
      assert.match(core.validate(item({ catalogType, stock })).join(" "), /10 to 500/);
      assert.throws(() => core.buildDefinition(item({ catalogType, stock })));
    }
  }
  assert.equal(core.buildDefinition(item({ stock: "500" })).Stock, 0);
  assert.equal(core.buildDefinition(item({ stock: "10" })).Limited, false);
});

test("numbered Limited exports stock, custom texture, and the game's actual accessory key", () => {
  const def = core.buildDefinition(item({
    catalogType: "limited",
    stock: "50",
    customTexture: true,
    texture: "118771731681462",
    accessoryKind: "Back",
    useOffset: true,
    offsetX: "-1",
    offsetY: "0.25",
    offsetZ: "2"
  }));
  assert.equal(def.Limited, true);
  assert.equal(def.Stock, 50);
  assert.equal(def.Texture, "rbxassetid://118771731681462");
  assert.equal(def.AccessoryKind, "Back");
  assert.deepEqual(def.AccessoryOffset, [ -1, .25, 2 ]);
});

test("Limited U exports fixed stock and repeat purchases without requiring a timer", () => {
  const def = core.buildDefinition(item({ catalogType: "limited-u", stock: "75" }));
  assert.equal(def.Stock, 75);
  assert.equal(def.Limited, true);
  assert.equal(def.LimitedU, true);
  assert.equal(def.MaxPerUser, 0);
  assert.equal(def.OnsaleAt, undefined);
  assert.equal(def.OffsaleAt, undefined);
  assert.deepEqual(core.validate(item({ catalogType: "limited-u", stock: "75" })), []);
});

test("a Limited U timer is optional and starts when publishing code runs", () => {
  const def = core.buildDefinition(item({
    catalogType: "limited-u",
    endMode: "duration",
    duration: "7",
    durationUnit: "days"
  }));
  assert.equal(def.Stock, 100);
  assert.equal(def.LimitedU, true);
  assert.equal(def.OnsaleAt.luaExpression, "os.time()");
  assert.equal(def.OffsaleAt.luaExpression, "os.time() + 604800");
  assert.match(core.itemLua(item({
    catalogType: "limited-u",
    endMode: "duration",
    duration: "1",
    durationUnit: "minutes"
  })), /OffsaleAt = os\.time\(\) \+ 60/);
});

test("future dates convert to UTC and scheduled duration has an exact integer deadline", () => {
  const draft = item({
    startMode: "date",
    startDate: "2036-10-31T12:30:00-04:00",
    endMode: "duration",
    duration: "2",
    durationUnit: "hours"
  });
  const def = core.buildDefinition(draft);
  assert.equal(def.OnsaleAt, "2036-10-31T16:30:00Z");
  assert.equal(def.OffsaleAt, Date.parse("2036-10-31T18:30:00Z") / 1e3);
});

test("event rewards match your game and do not become purchasable", () => {
  const def = core.buildDefinition(item({
    catalogType: "event",
    rewardSource: "2026 Halloween Item",
    price: "999"
  }));
  assert.equal(def.Event, true);
  assert.equal(def.Special, true);
  assert.equal(def.Catalog, false);
  assert.equal(def.Price, 0);
  assert.equal(def.RewardSource, "2026 Halloween Item");
  assert.equal(def.EventDescription, undefined);
});

test("unsupported or incompatible catalog combinations are rejected", () => {
  for (const draft of [ item({
    catalogType: "limited",
    stock: "0"
  }), item({
    catalogType: "limited-u",
    stock: "0"
  }), item({
    price: "-5"
  }), item({
    assetId: "9007199254740992"
  }), item({
    itemType: "Face",
    texture: ""
  }), item({
    itemType: "TShirt",
    template: ""
  }), item({
    itemType: "Neck"
  }), item({
    accessoryScale: "2.1"
  }), item({
    endMode: "duration",
    duration: "0.000001",
    durationUnit: "hours"
  }) ]) assert.ok(core.validate(draft).length, JSON.stringify(draft));
});

test("duplicate names and invalid sale dates cannot be exported", () => {
  assert.throws(() => core.itemsLua([ item(), item() ]), /Duplicate name/);
  assert.ok(core.validate(item({
    id: "b"
  }), [ item({
    id: "a"
  }) ], "b").some(s => s.includes("already in the batch")));
  assert.equal(core.validate(item({
    id: "a"
  }), [ item({
    id: "a"
  }) ], "a").length, 0);
  assert.ok(core.validate(item({
    startMode: "date",
    startDate: "2036-10-31T12:30",
    endMode: "date",
    endDate: "2036-10-30T12:30"
  })).length);
});

test("Lua strings escape quotation marks, controls, and backslashes without corrupting Unicode", () => {
  assert.equal(core.luaString('a"\\\n\t\x0012 🍂'), '"a\\"\\\\\\n\\t\\00012 🍂"');
  const lua = core.itemLua(item({
    description: '"); warn("oops") --\nTwo lines 🦇'
  }));
  assert.match(lua, /Description = "\\"\); warn\(\\"oops\\"\)/);
  assert.match(lua, /\\nTwo lines 🦇/);
});

test("full export retains the entire publisher after the ITEMS block byte for byte", async () => {
  const output = core.fullScript([ item(), item({
    name: "Second item"
  }) ], template);
  assert.equal(output.slice(output.indexOf("\nlocal REMOVE =")), template.slice(template.indexOf("\nlocal REMOVE =")));
  assert.match(output, /store:UpdateAsync/);
  assert.match(output, /MessagingService:PublishAsync/);
  assert.match(output, /InsertService:LoadAsset/);
  assert.match(output, /Second item/);
  assert.match(output, /knownNames\[catalogNameKey\(raw.Name\)\]/);
  assert.match(output, /HatDefinitions.GetAll\(\)/);
});

test("direct lookup accepts Roblox URLs and distinguishes bundle IDs", () => {
  assert.deepEqual(core.parseAssetQuery("https://www.roblox.com/catalog/133559536/Sinister-Zombie"), {
    id: 133559536,
    kind: "Asset"
  });
  assert.deepEqual(core.parseAssetQuery("https://www.roblox.com/bundles/201/Headless-Horseman"), {
    id: 201,
    kind: "Bundle"
  });
  assert.equal(core.parseAssetQuery("https://roblox.com.evil.test/catalog/123/"), null);
  assert.equal(core.assetContent("https://evil.test/texture.png"), null);
  assert.deepEqual(core.assetMapping(43, "Asset").accessoryKind, "Neck");
});

test("normal stock is unlimited; offsale uses a past deadline; face texture is required", () => {
  assert.equal(core.buildDefinition(item({
    stock: "30"
  })).Stock, 0);
  assert.equal(core.buildDefinition(item({
    catalogType: "offsale"
  })).OffsaleAt, 1);
  assert.equal(core.buildDefinition(item({
    itemType: "Face",
    texture: "90515594"
  })).Texture, "rbxassetid://90515594");
});

test("all requested placements and heads retain distinct export metadata", () => {
  for (const kind of [ "Hat", "Hair", "Face", "Neck", "LeftShoulder", "RightShoulder", "Collar", "Front", "Back", "WaistFront", "WaistCenter", "WaistBack", "Torso", "Ear", "LeftShoe", "RightShoe" ]) {
    const definition = core.buildDefinition(item({ accessoryKind: kind }));
    assert.equal(definition.AccessoryCategory, kind);
  }
  const shoulder = core.buildDefinition(item({ accessoryKind: "LeftShoulder" }));
  assert.equal(shoulder.AccessoryKind, "Shoulder");
  assert.equal(shoulder.AccessoryAttachment, "LeftShoulderAttachment");
  assert.equal(shoulder.ShoulderSide, "Left");
  assert.equal(core.buildDefinition(item({ accessoryKind: "WaistBack" })).AccessoryAttachment, "WaistBackAttachment");
  assert.equal(core.buildDefinition(item({ itemType: "Head" })).ItemType, "Head");
  assert.equal(core.assetMapping(17, "Asset").itemType, "Head");
  assert.equal(core.assetMapping(70, "Asset").accessoryKind, "LeftShoe");
  assert.ok(core.validate(item({ itemType: "Head", customTexture: true, texture: "200" })).length);
});

test("duplicate keys normalize case, whitespace, smart quotes, and Unicode width", () => {
  assert.equal(core.nameKey("  ＢＬＡＣＫ  ＩＲＯＮ  ＢＲＡＮＣＨＥＳ  "), "black iron branches");
  assert.equal(core.nameKey("Roblox’s Hat"), core.nameKey("Roblox's Hat"));
  assert.throws(() => core.itemsLua([ item({ name: "Hat" }), item({ name: "ＨＡＴ" }) ]), /Duplicate name/);
  assert.ok(core.registryKeys(item({ itemType: "BodyPackage", assetId: "201" })).includes("bundle:201"));
  assert.ok(core.registryKeys(item({ assetId: "201" })).includes("asset:201"));
  assert.ok(core.registryKeys(item({ customTexture: true, texture: "200" })).includes("reskin:asset:133559536:200"));
});

test("all dynamic heads map to Head while known Headless assets keep their special appearance", () => {
  const parsed = core.parseAssetQuery("https://www.roblox.com/catalog/15093053680/Headless-Head");
  assert.deepEqual(parsed, { id: 15093053680, kind: "Asset" });
  assert.equal(core.assetMapping(79, "Asset", parsed.id).itemType, "Head");
  assert.equal(core.assetMapping(79, "Asset", 205).itemType, "Head");
  assert.equal(core.assetMapping(79, "Asset").itemType, "Head");
  for (const assetId of [ "15093053680", "134082579" ]) {
    const draft = item({ itemType: "Head", assetId, catalogType: "limited-u", stock: "25", endMode: "duration", duration: "1", durationUnit: "hours" });
    const definition = core.buildDefinition(draft);
    assert.equal(definition.ItemType, "Head");
    assert.equal(definition.Headless, true);
    assert.equal(definition.AssetId, Number(assetId));
    assert.equal(definition.Price, 500);
    assert.equal(definition.Stock, 25);
    assert.equal(definition.LimitedU, true);
    assert.equal(definition.MaxPerUser, 0);
    assert.equal(definition.Texture, undefined);
    assert.equal(definition.OffsaleAt.luaExpression, "os.time() + 3600");
    assert.match(core.fullScript([ draft ], template), /Headless = true/);
  }
  assert.equal(core.buildDefinition(item({ itemType: "Head", assetId: "105" })).Headless, undefined);
  assert.match(template, /if not definition\.Headless and \(definition\.ItemType/);
});
