import { DatabaseSync } from "node:sqlite";

import { readFileSync, readdirSync } from "node:fs";

import { createHash } from "node:crypto";
import classicData from "../data/classic-faces.json" with { type: "json" };

const classicFaces = new Map(classicData.faces.map(face => [face.id, face]));
const classicTextures = new Set(classicData.faces.map(face => face.textureId));

export const ownerKey = "K".repeat(43);

export function database() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter(file => file.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  function prepare(sql) {
    let values = [];
    const expand = () => {
      const parameters = [];
      const query = sql.replace(/\?(\d+)/g, (_, index) => {
        parameters.push(values[Number(index) - 1]);
        return "?";
      });
      return {
        query: query,
        parameters: parameters
      };
    };
    const statement = {
      bind(...items) {
        values = items;
        return statement;
      },
      async first() {
        const {query: query, parameters: parameters} = expand();
        return sqlite.prepare(query).get(...parameters) || null;
      },
      async all() {
        const {query: query, parameters: parameters} = expand();
        return {
          results: sqlite.prepare(query).all(...parameters),
          success: true,
          meta: {
            changes: 0
          }
        };
      },
      async run() {
        const {query: query, parameters: parameters} = expand();
        const result = sqlite.prepare(query).run(...parameters);
        return {
          results: [],
          success: true,
          meta: {
            changes: Number(result.changes)
          }
        };
      },
      async execute() {
        const {query: query, parameters: parameters} = expand();
        if (/RETURNING|^SELECT/i.test(query)) {
          const rows = sqlite.prepare(query).all(...parameters);
          return {
            results: rows,
            success: true,
            meta: {
              changes: 0
            }
          };
        }
        return statement.run();
      }
    };
    return statement;
  }
  return {
    sqlite: sqlite,
    prepare: prepare,
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

export function environment() {
  return {
    DB: database(),
    REQUEST_LIMITER: {
      limit: async () => ({
        success: true
      })
    },
    LOGIN_LIMITER: {
      limit: async () => ({
        success: true
      })
    },
    ADMIN_KEY_HASH: createHash("sha256").update(ownerKey).digest("hex"),
    RATE_SECRET: "R".repeat(43),
    TURNSTILE_SITE_KEY: "production-site-key-fixture",
    TURNSTILE_SECRET: "production-secret-fixture",
    PUBLIC_ORIGINS: "",
    SUBMISSIONS_PER_IP_PER_DAY: "100",
    SUBMISSIONS_PER_DAY: "200"
  };
}

export function upstream() {
  const calls = [];
  const fetch = async (input, options = {}) => {
    const url = new URL(String(input));
    calls.push({
      url: url.href,
      options: options
    });
    const reply = value => Response.json(value);
    if (url.hostname === "challenges.cloudflare.com") {
      const data = JSON.parse(options.body);
      return reply({
        success: data.response !== "bad",
        action: data.response === "wrong-action" ? "unexpected" : data.response.startsWith("login") ? "owner-login" : "submit",
        hostname: data.response === "wrong-host" ? "evil.test" : "catalog.test"
      });
    }
    if (url.hostname === "economy.roblox.com") {
      const id = Number(url.pathname.split("/")[3]);
      const assetType = {
        100: 8,
        101: 8,
        102: 8,
        103: 19,
        104: 41,
        105: 17,
        106: 18,
        107: 57,
        108: 70,
        109: 71,
        110: 43,
        111: 44,
        112: 47,
        134082579: 17,
        15093053680: 79,
        133559536: 8,
        200: 1,
        201: 13,
        202: 4,
        203: 13,
        204: 1,
        205: 79,
        15938951781: 79
      }[id] || (classicFaces.has(id) ? 18 : classicTextures.has(id) ? 1 : 0);
      if (!assetType) return new Response("missing", {
        status: 404
      });
      return reply({
        AssetId: id,
        Name: id === 100 ? "Classic Hat" : id === 15093053680 || id === 134082579 ? "Headless Head" : id === 15938951781 ? "Silly Fun - Head" : classicFaces.get(id)?.name || "Item " + id,
        Description: "An official catalog description.",
        AssetTypeId: assetType,
        Creator: {
          Id: id === 101 || (id >= 200 && id <= 203) ? 12 : 1,
          CreatorType: id === 102 ? "Group" : "User",
          Name: id === 101 || (id >= 200 && id <= 203) ? "Contributor" : "Roblox"
        }
      });
    }
    if (url.hostname === "catalog.roblox.com" && url.pathname.includes("search")) {
      const subcategory = url.searchParams.get("Subcategory"), category = url.searchParams.get("Category");
      const ids = subcategory === "10" ? [106] : category === "1" ? [105] : category === "5" ? [103] : [100, 101, 102];
      return reply({
      data: [...ids.map(id => ({
        id: id,
        itemType: "Asset",
        name: id === 100 ? "Classic Hat" : id < 103 ? "Other Hat" : "Item " + id,
        description: "Original description",
        assetType: id === 106 ? 18 : id === 105 ? 17 : id === 103 ? 19 : 8,
        creatorType: id === 102 ? "Group" : "User",
        creatorTargetId: id === 101 ? 12 : 1,
        creatorName: "Roblox"
      })), ...(category === "1" ? [ { id: 201, itemType: "Bundle", bundleType: 1, name: "Headless Horseman", creatorType: "User", creatorTargetId: 1, creatorName: "Roblox", bundledItems: [ { id: 15093053680, name: "Headless Head", type: "Asset", assetType: 79 }, { id: 205, name: "Other Dynamic Head", type: "Asset", assetType: 79 } ] } ] : [])],
      nextPageCursor: null
    });
    }
    if (url.hostname === "catalog.roblox.com" && /\/bundles\/\d+\/details/.test(url.pathname)) {
      const id = Number(url.pathname.split("/")[3]);
      if (id === 299652) return reply({ id, name: "Silly Fun", bundleType: "DynamicHead", creator: { id: 1, type: "User", name: "Roblox" }, items: [{ id: 15938951781, name: "Silly Fun - Head", type: "Asset", assetType: 79 }] });
      return reply({ id, name: "Bundle " + id, description: "A body package.", bundleType: "BodyParts", creator: { id: id === 301 ? 2 : 1, type: "User", name: "Roblox" } });
    }
    if (url.hostname === "catalog.roblox.com") return reply({
      data: []
    });
    if (url.hostname === "thumbnails.roblox.com") return reply({
      data: (url.searchParams.get("assetIds") || "").split(",").map(id => ({
        targetId: Number(id),
        state: "Completed",
        imageUrl: "https://fixtures.rbxcdn.com/" + id + ".png"
      }))
    });
    if (url.hostname === "assetdelivery.roblox.com") {
      if (url.searchParams.get("id") === "203") return new Response(null, {
        status: 302,
        headers: {
          Location: "https://evil.test/private"
        }
      });
      const texture = classicFaces.get(Number(url.searchParams.get("id")))?.textureId || 200;
      return new Response('<roblox><Item class="Decal"><Properties><Content name="Texture"><url>http://www.roblox.com/asset/?id=' + texture + '</url></Content></Properties></Item></roblox>');
    }
    throw new Error("Unexpected upstream: " + url.href);
  };
  return {
    fetch: fetch,
    calls: calls
  };
}
