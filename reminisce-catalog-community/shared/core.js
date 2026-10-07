(function(root) {
  "use strict";
  const ITEM_TYPES = [ "Hat", "Hair", "Face", "Tool", "TShirt", "BodyPackage", "Head" ];
  const CATALOG_TYPES = [ "normal", "limited", "limited-u", "event", "special", "member", "offsale" ];
  const UPLOAD_TYPES = [ "normal", "limited", "limited-u", "event" ];
  const KINDS = [ "", "Hat", "Hair", "Face", "Neck", "Shoulder", "LeftShoulder", "RightShoulder", "Collar", "Front", "Back", "Waist", "WaistFront", "WaistCenter", "WaistBack", "Ear", "Torso", "LeftShoe", "RightShoe" ];
  const KIND_LABELS = { "": "Auto · use asset attachments", Hat: "Hat", Hair: "Hair", Face: "Face accessory", Neck: "Neck", Shoulder: "Shoulders · use asset attachments", LeftShoulder: "Left shoulder", RightShoulder: "Right shoulder", Collar: "Collar", Front: "Front", Back: "Back", Waist: "Waist · use asset attachments", WaistFront: "Waist · front", WaistCenter: "Waist · center", WaistBack: "Waist · back", Ear: "Ears", Torso: "Torso", LeftShoe: "Left foot", RightShoe: "Right foot" };
  const TYPE_LABELS = { Hat: "Accessory", Hair: "Accessory", Face: "Face", Tool: "Tools", TShirt: "Classic clothing", BodyPackage: "Body package", Head: "Head" };
  const PLACEMENTS = { LeftShoulder: [ "Shoulder", "LeftShoulderAttachment", "Left" ], RightShoulder: [ "Shoulder", "RightShoulderAttachment", "Right" ], Collar: [ "Shoulder", "", "" ], WaistFront: [ "Waist", "WaistFrontAttachment", "" ], WaistCenter: [ "Waist", "WaistCenterAttachment", "" ], WaistBack: [ "Waist", "WaistBackAttachment", "" ] };
  const GEARS = [ "", "Melee", "Ranged", "Explosives", "Power Ups", "Navigation Enhancers", "Musical Instruments", "Social Items", "Building Tools", "Personal Transport" ];
  const HIDDEN_TYPES = [ "event", "special", "member" ];
  const LABELS = {
    normal: "Non limited",
    limited: "Limited",
    "limited-u": "Limited U",
    event: "Event reward",
    special: "Special reward",
    member: "Membership reward",
    offsale: "Offsale"
  };
  const MAX_BATCH = 500;
  const expression = value => ({
    luaExpression: value
  });
  const text = value => String(value ?? "");
  const isAccessory = type => type === "Hat" || type === "Hair";
  const nameKey = value => text(value).normalize("NFKC").replace(/[\u200b-\u200d\u2060\ufeff]/g, "").replace(/[\u2018\u2019]/g, "'").replace(/\s+/g, " ").trim().toLowerCase();
  function registryKeys(draft) {
    const id = integer(draft.assetId, 1), texture = assetContent(draft.texture)?.split("//")[1];
    const namespace = draft.itemType === "BodyPackage" ? "bundle" : "asset";
    const keys = [ "name:" + nameKey(draft.name) ];
    if (id) keys.push(draft.customTexture && texture ? "reskin:" + namespace + ":" + id + ":" + texture : namespace + ":" + id);
    if (draft.itemType === "Face" && texture) keys.push("face-texture:" + texture);
    return [...new Set(keys)];
  }
  function integer(value, min = 0) {
    if (text(value).trim() === "" || !/^\d+$/.test(text(value).trim())) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= min ? n : null;
  }
  function assetContent(value) {
    const raw = text(value).trim();
    const match = raw.match(/^(?:rbxassetid:\/\/)?(\d+)$/i);
    const id = match && integer(match[1], 1);
    return id === null || !match ? null : "rbxassetid://" + id;
  }
  function parseAssetQuery(value) {
    const raw = text(value).trim();
    if (/^\d+$/.test(raw)) return {
      id: integer(raw, 1),
      kind: "Asset"
    };
    if (/^rbxassetid:\/\/\d+$/i.test(raw)) return {
      id: integer(raw.split("//")[1], 1),
      kind: "Asset"
    };
    try {
      const url = new URL(raw);
      if (![ "https:", "http:" ].includes(url.protocol) || url.username || url.password || url.port || !(url.hostname === "roblox.com" || url.hostname.endsWith(".roblox.com"))) return null;
      const match = url.pathname.match(/^\/(catalog|bundles|library)\/(\d+)(?:\/|$)/i);
      if (match) return {
        id: integer(match[2], 1),
        kind: match[1].toLowerCase() === "bundles" ? "Bundle" : "Asset"
      };
      if (url.pathname === "/asset/" || url.pathname === "/asset") return {
        id: integer(url.searchParams.get("id"), 1),
        kind: "Asset"
      };
    } catch {}
    return null;
  }
  function durationSeconds(draft) {
    const multiplier = {
      minutes: 60,
      hours: 3600,
      days: 86400
    }[draft.durationUnit];
    const n = Number(draft.duration);
    if (!multiplier || !Number.isFinite(n) || n <= 0) return null;
    const seconds = Math.floor(n * multiplier);
    return Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 31536e5 ? seconds : null;
  }
  function dateStamp(value) {
    const time = new Date(value).getTime();
    return text(value).trim() && Number.isFinite(time) ? Math.floor(time / 1e3) : null;
  }
  function validate(draft, batch = [], editingId = null, now = Date.now()) {
    const errors = [];
    const name = text(draft.name).trim();
    const hidden = HIDDEN_TYPES.includes(draft.catalogType);
    if (!name || !nameKey(name) || name.length > 180) errors.push("Enter a catalog name of 1–180 characters.");
    if (/[\x00-\x1f\x7f]/.test(name)) errors.push("The catalog name cannot contain control characters or line breaks.");
    if (text(draft.description).length > 12e3) errors.push("Keep the description to 12,000 characters or fewer.");
    if (integer(draft.assetId, 1) === null) errors.push("Enter a positive whole-number asset ID.");
    if (!ITEM_TYPES.includes(draft.itemType)) errors.push("Choose a supported item type.");
    if (!CATALOG_TYPES.includes(draft.catalogType)) errors.push("Choose a supported catalog type.");
    if (!hidden && integer(draft.price) === null) errors.push("Price must be a whole number of pNgs, 0 or higher.");
    if ([ "limited", "limited-u" ].includes(draft.catalogType) && integer(draft.stock, 1) === null) errors.push("Limited stock must be a whole number of 1 or more.");
    if (hidden && !text(draft.rewardSource).trim()) errors.push("Enter the event or reward label.");
    if (text(draft.rewardSource).length > 180) errors.push("Keep the event or reward label to 180 characters or fewer.");
    if (batch.some(item => item.id !== editingId && nameKey(item.name) === nameKey(name))) errors.push("This catalog name is already in the batch. Edit its existing entry.");
    if (!editingId && batch.length >= MAX_BATCH) errors.push("Export this batch before adding more than 500 items.");
    if (!hidden && draft.catalogType !== "offsale") {
      if (![ "now", "date" ].includes(draft.startMode) || ![ "never", "duration", "date" ].includes(draft.endMode)) errors.push("Choose a valid sale schedule.");
      const start = draft.startMode === "date" ? dateStamp(draft.startDate) : Math.floor(now / 1e3);
      if (draft.startMode === "date" && start === null) errors.push("Choose a valid start date and time.");
      if (draft.endMode === "date") {
        const end = dateStamp(draft.endDate);
        if (end === null) errors.push("Choose a valid end date and time."); else if (start !== null && end <= start) errors.push("The sale must end after it starts. Choose a future end time or use Offsale.");
      }
      if (draft.endMode === "duration" && durationSeconds(draft) === null) errors.push("Enter a duration from 1 second to 100 years.");
    }
    if (draft.customTexture && [ "BodyPackage", "Head" ].includes(draft.itemType)) errors.push("Body packages and heads use their original appearance.");
    if ((draft.customTexture || draft.itemType === "Face") && ![ "BodyPackage", "Head" ].includes(draft.itemType) && !assetContent(draft.texture)) errors.push("Enter the actual texture image ID, as digits or rbxassetid://ID.");
    if (draft.itemType === "TShirt") {
      if (!assetContent(draft.template)) errors.push("Clothing needs its actual image / template ID.");
      if (![ "ShirtGraphic", "Shirt", "Pants" ].includes(draft.clothingClass)) errors.push("Choose a supported clothing class.");
    }
    if (draft.itemType === "Tool" && !GEARS.includes(draft.gearType || "")) errors.push("Choose a supported gear category.");
    if (isAccessory(draft.itemType)) {
      if (!KINDS.includes(draft.accessoryKind || "")) errors.push("Choose a supported accessory category.");
      const scale = Number(draft.accessoryScale);
      if (!Number.isFinite(scale) || scale < .5 || scale > 2) errors.push("Accessory scale must be between 0.5 and 2.");
      if (draft.useOffset && [ draft.offsetX, draft.offsetY, draft.offsetZ ].some(v => text(v).trim() === "" || !Number.isFinite(Number(v)) || Math.abs(Number(v)) > 1e5)) errors.push("Offsets need finite X, Y, and Z values between -100,000 and 100,000.");
    }
    return errors;
  }
  function buildDefinition(draft) {
    const errors = validate(draft);
    if (errors.length) throw new Error(errors.join("\n"));
    const hidden = HIDDEN_TYPES.includes(draft.catalogType);
    const limited = draft.catalogType === "limited" || draft.catalogType === "limited-u";
    const definition = {
      Name: text(draft.name).trim(),
      Description: text(draft.description),
      AssetId: integer(draft.assetId, 1),
      ItemType: draft.itemType,
      Price: hidden ? 0 : integer(draft.price),
      Limited: limited,
      Stock: limited ? integer(draft.stock, 1) : 0
    };
    if (draft.catalogType === "limited-u") {
      definition.LimitedU = true;
      definition.MaxPerUser = 0;
    }
    if (hidden) {
      definition.Catalog = false;
      if (draft.catalogType === "event") definition.Event = true;
      if (draft.catalogType === "event" || draft.catalogType === "special") definition.Special = true;
      if (draft.catalogType === "member") definition.MemberOnly = true;
      definition.RewardSource = text(draft.rewardSource).trim();
    } else if (draft.catalogType === "offsale") {
      definition.OffsaleAt = 1;
    } else {
      if (draft.startMode === "date") definition.OnsaleAt = new Date(draft.startDate).toISOString().replace(/\.\d{3}Z$/, "Z");
      if (draft.endMode === "date") definition.OffsaleAt = new Date(draft.endDate).toISOString().replace(/\.\d{3}Z$/, "Z");
      if (draft.endMode === "duration") {
        const seconds = durationSeconds(draft);
        if (draft.startMode === "now") definition.OnsaleAt = expression("os.time()");
        if (draft.startMode === "now") definition.OffsaleAt = expression("os.time() + " + seconds); else definition.OffsaleAt = dateStamp(draft.startDate) + seconds;
      }
    }
    if ((draft.customTexture || draft.itemType === "Face") && ![ "BodyPackage", "Head" ].includes(draft.itemType)) definition.Texture = assetContent(draft.texture);
    if (draft.itemType === "TShirt") {
      definition.ClothingClass = draft.clothingClass;
      definition.Template = assetContent(draft.template);
    }
    if (draft.itemType === "Tool" && draft.gearType) definition.GearType = draft.gearType;
    if (isAccessory(draft.itemType)) {
      if (draft.accessoryKind) {
        const placement = PLACEMENTS[draft.accessoryKind];
        definition.AccessoryKind = placement ? placement[0] : draft.accessoryKind;
        definition.AccessoryCategory = draft.accessoryKind;
        if (placement?.[1]) definition.AccessoryAttachment = placement[1];
        if (placement?.[2]) definition.ShoulderSide = placement[2];
      }
      if (Number(draft.accessoryScale) !== 1) definition.AccessoryScale = Number(draft.accessoryScale);
      if (draft.useOffset) definition.AccessoryOffset = [ Number(draft.offsetX), Number(draft.offsetY), Number(draft.offsetZ) ];
    }
    if (draft.rainbow) definition.Rainbow = true;
    return definition;
  }
  function luaString(value) {
    return '"' + text(value).replace(/[\\"\x00-\x1f\x7f]/g, char => {
      if (char === "\\") return "\\\\";
      if (char === '"') return '\\"';
      if (char === "\n") return "\\n";
      if (char === "\r") return "\\r";
      if (char === "\t") return "\\t";
      return "\\" + char.charCodeAt(0).toString().padStart(3, "0");
    }) + '"';
  }
  function luaValue(value) {
    if (value && typeof value === "object" && typeof value.luaExpression === "string") {
      if (!/^os\.time\(\)(?: \+ \d+)?$/.test(value.luaExpression)) throw new Error("Unsupported Lua expression.");
      return value.luaExpression;
    }
    if (typeof value === "string") return luaString(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (Array.isArray(value)) return "{ " + value.map(luaValue).join(", ") + " }";
    throw new Error("Unsupported Lua field value.");
  }
  function itemLua(draft) {
    const def = buildDefinition(draft);
    return "\t{\n" + Object.entries(def).map(([key, value]) => "\t\t" + key + " = " + luaValue(value) + ",").join("\n") + "\n\t},";
  }
  function itemsLua(batch) {
    if (!Array.isArray(batch) || !batch.length) throw new Error("Add at least one item to the batch.");
    if (batch.length > MAX_BATCH) throw new Error("This batch exceeds 500 items.");
    const seen = new Set;
    for (const item of batch) {
      const errors = validate(item);
      if (errors.length) throw new Error(text(item.name) + ": " + errors.join(" "));
      const name = nameKey(item.name);
      if (seen.has(name)) throw new Error("Duplicate name in batch: " + name);
      seen.add(name);
    }
    return "local ITEMS = {\n" + batch.map(itemLua).join("\n") + "\n}";
  }
  function fullScript(batch, template) {
    if (typeof template !== "string") throw new Error("The publisher template is unavailable.");
    const start = template.indexOf("local ITEMS = {");
    const end = template.indexOf("\nlocal REMOVE =", start);
    if (start < 0 || end < 0) throw new Error("Publisher template markers are missing.");
    return template.slice(0, start) + itemsLua(batch) + "\n" + template.slice(end);
  }
  function defaults() {
    return {
      name: "",
      description: "",
      assetId: "",
      itemType: "Hat",
      catalogType: "normal",
      price: "0",
      stock: "100",
      rewardSource: "",
      startMode: "now",
      startDate: "",
      endMode: "never",
      endDate: "",
      duration: "24",
      durationUnit: "hours",
      customTexture: false,
      texture: "",
      accessoryKind: "",
      gearType: "",
      clothingClass: "ShirtGraphic",
      template: "",
      accessoryScale: "1",
      useOffset: false,
      offsetX: "0",
      offsetY: "0",
      offsetZ: "0",
      rainbow: false
    };
  }
  function assetMapping(assetType, kind) {
    if (kind === "Bundle") return {
      itemType: "BodyPackage",
      accessoryKind: ""
    };
    const mappings = {
      8: [ "Hat", "Hat" ],
      41: [ "Hair", "Hair" ],
      42: [ "Hat", "Face" ],
      43: [ "Hat", "Neck" ],
      44: [ "Hat", "Shoulder" ],
      45: [ "Hat", "Front" ],
      46: [ "Hat", "Back" ],
      47: [ "Hat", "Waist" ],
      57: [ "Hat", "Ear" ],
      58: [ "Hat", "Face" ],
      70: [ "Hat", "LeftShoe" ],
      71: [ "Hat", "RightShoe" ],
      17: [ "Head", "" ],
      18: [ "Face", "" ],
      19: [ "Tool", "" ],
      2: [ "TShirt", "" ],
      11: [ "TShirt", "" ],
      12: [ "TShirt", "" ]
    };
    const match = mappings[assetType];
    return match ? {
      itemType: match[0],
      accessoryKind: match[1],
      clothingClass: assetType === 11 ? "Shirt" : assetType === 12 ? "Pants" : "ShirtGraphic"
    } : null;
  }
  root.CatalogCore = {
    ITEM_TYPES: ITEM_TYPES,
    CATALOG_TYPES: CATALOG_TYPES,
    UPLOAD_TYPES: UPLOAD_TYPES,
    KINDS: KINDS,
    KIND_LABELS: KIND_LABELS,
    TYPE_LABELS: TYPE_LABELS,
    nameKey: nameKey,
    registryKeys: registryKeys,
    MAX_BATCH: MAX_BATCH,
    LABELS: LABELS,
    HIDDEN_TYPES: HIDDEN_TYPES,
    defaults: defaults,
    validate: validate,
    buildDefinition: buildDefinition,
    luaString: luaString,
    itemLua: itemLua,
    itemsLua: itemsLua,
    fullScript: fullScript,
    assetContent: assetContent,
    parseAssetQuery: parseAssetQuery,
    assetMapping: assetMapping,
    isAccessory: isAccessory,
    durationSeconds: durationSeconds
  };
})(globalThis);
