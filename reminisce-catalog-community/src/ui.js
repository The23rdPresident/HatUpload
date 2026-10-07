(function(root) {
  "use strict";
  const core = root.CatalogCore, $ = id => document.getElementById(id), form = $("item-form");
  let base = "", toastTimer;
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  function notice(id, message) {
    const element = $(id);
    element.textContent = message || "";
    element.hidden = !message;
  }
  function toast(message) {
    clearTimeout(toastTimer);
    notice("toast", message);
    toastTimer = setTimeout(() => notice("toast", ""), 5e3);
  }
  async function api(path, options = {}) {
    const controller = new AbortController, timer = setTimeout(() => controller.abort(), 25e3);
    try {
      const headers = {
        Accept: "application/json"
      };
      if (options.data) headers["Content-Type"] = "application/json";
      if (options.token) headers.Authorization = "Bearer " + options.token;
      const response = await fetch(base + path, {
        method: options.method || "GET",
        headers: headers,
        body: options.data ? JSON.stringify(options.data) : undefined,
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "error"
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(data.error || "The request could not be completed.");
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The request timed out. Try again.");
      if (error instanceof TypeError) throw new Error("The service could not be reached. Check your connection and site setup.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  async function connect() {
    try {
      const configured = String(root.SITE_CONFIG?.apiUrl || "").replace(/\/$/, "");
      if (configured) {
        const url = new URL(configured);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("The site's service URL is invalid.");
        base = url.origin + "/api";
      } else {
        base = location.origin + "/api";
      }
      const config = await api("/config");
      if (!config.ready) throw new Error("The owner needs to complete the database, owner key, and verification setup before submissions can open.");
      notice("service-status", "");
      return config;
    } catch (error) {
      notice("service-status", error.message);
      return null;
    }
  }
  function readDraft() {
    const draft = core.defaults();
    for (const key of Object.keys(draft)) {
      const field = form.elements.namedItem(key);
      if (field) draft[key] = field.type === "checkbox" ? field.checked : field.value;
    }
    for (const key of [ "startDate", "endDate" ]) {
      if (draft[key]) {
        const date = new Date(draft[key]);
        if (!Number.isFinite(date.getTime())) throw new Error("Choose a valid date and time.");
        draft[key] = date.toISOString();
      }
    }
    return draft;
  }
  function fillDraft(draft) {
    for (const [key, value] of Object.entries({
      ...core.defaults(),
      ...draft
    })) {
      const field = form.elements.namedItem(key);
      if (!field) continue;
      if (field.type === "checkbox") field.checked = value; else if ([ "startDate", "endDate" ].includes(key) && value) {
        const date = new Date(value);
        field.value = Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 6e4).toISOString().slice(0, 16) : "";
      } else field.value = value;
    }
    sync();
    notice("form-errors", "");
  }
  function sync() {
    const get = name => form.elements.namedItem(name), type = get("itemType").value, catalog = get("catalogType").value;
    const hidden = core.HIDDEN_TYPES.includes(catalog), accessory = core.isAccessory(type), original = [ "BodyPackage", "Head" ].includes(type), texture = (get("customTexture").checked || type === "Face") && !original;
    if (original) get("customTexture").checked = false;
    $("stock-field").hidden = catalog !== "limited";
    $("reward-field").hidden = !hidden;
    get("price").disabled = hidden;
    $("schedule-section").hidden = hidden || catalog === "offsale";
    $("start-date-field").hidden = get("startMode").value !== "date";
    $("end-date-field").hidden = get("endMode").value !== "date";
    $("duration-field").hidden = get("endMode").value !== "duration";
    $("accessory-kind-field").hidden = !accessory;
    $("gear-field").hidden = type !== "Tool";
    $("clothing-class-field").hidden = type !== "TShirt";
    $("template-field").hidden = type !== "TShirt";
    $("texture-check-field").hidden = type === "Face" || original;
    $("texture-field").hidden = !texture;
    $("texture-hint").hidden = !texture;
    $("offset-fields").hidden = !get("useOffset").checked;
    form.querySelector("details.advanced").hidden = !accessory;
    $("availability-hint").textContent = {
      normal: "Unlimited stock. A price of 0 makes the item free.",
      limited: "Numbered Limited with a fixed stock count.",
      "limited-u": "Timed Limited U with unlimited stock. Choose a sale duration or end date.",
      event: "An event reward, outside the purchasable catalog.",
      special: "A special reward, outside the purchasable catalog.",
      member: "A membership reward, outside the purchasable catalog.",
      offsale: "Listed as offsale when the code is run."
    }[catalog];
    $("timezone-label").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone || "your local timezone";
  }
  function validDraft() {
    const draft = readDraft(), errors = core.validate(draft);
    if (errors.length) throw new Error(errors.join(" "));
    return draft;
  }
  function safeThumbnail(value) {
    try {
      const url = new URL(value);
      if (url.protocol === "https:" && !url.username && !url.password && !url.port && (url.hostname === "rbxcdn.com" || url.hostname.endsWith(".rbxcdn.com"))) return url.href;
    } catch {}
    return "";
  }
  function thumbnail(item, className = "item-thumbnail") {
    const box = node("span", undefined, className);
    const fallback = node("span", "No image", "thumbnail-fallback");
    const url = safeThumbnail(item?.thumbnail);
    box.append(fallback);
    if (url) {
      const image = node("img");
      image.alt = item.name || "Roblox item";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.width = 150;
      image.height = 150;
      image.onerror = () => { image.hidden = true; fallback.hidden = false; };
      image.src = url;
      fallback.hidden = true;
      box.append(image);
    }
    return box;
  }
  function showAsset(item) {
    $("selected-item").hidden = !item;
    if (!item) return;
    $("selected-name").textContent = item.name;
    $("selected-meta").textContent = "ID " + item.id + (item.creatorName ? " · " + item.creatorName : "");
    $("selected-link").href = "https://www.roblox.com/" + (item.kind === "Bundle" ? "bundles/" : "catalog/") + item.id;
    const image = $("selected-image");
    const safe = safeThumbnail(item.thumbnail);
    image.hidden = !safe;
    $("preview-fallback").hidden = Boolean(safe);
    image.removeAttribute("src");
    image.alt = item.name || "Original Roblox item";
    image.referrerPolicy = "no-referrer";
    if (safe) image.src = safe;
    image.onerror = () => {
      image.hidden = true;
      $("preview-fallback").hidden = false;
    };
  }
  function applyAsset(item, keepName = false) {
    const draft = readDraft(), mapping = core.assetMapping(item.assetType, item.kind);
    if (!mapping) throw new Error("This asset type is not supported.");
    fillDraft({
      ...draft,
      ...mapping,
      assetId: String(item.id),
      name: keepName && draft.name ? draft.name : item.name,
      description: item.description || "",
      texture: item.textureId ? "rbxassetid://" + item.textureId : draft.texture
    });
    showAsset(item);
  }
  function summary(draft, target) {
    target.replaceChildren();
    const table = node("table", undefined, "review-table");
    const rows = [ [ "Name", draft.name ], [ "Asset / bundle ID", draft.assetId ], [ "Item type", core.TYPE_LABELS[draft.itemType] ], [ "Catalog type", core.LABELS[draft.catalogType] ], [ "Price", core.HIDDEN_TYPES.includes(draft.catalogType) ? "Reward" : draft.price + " pNgs" ], [ "Stock", draft.catalogType === "limited" ? draft.stock : "Unlimited" ], [ "Texture", draft.customTexture || draft.itemType === "Face" ? draft.texture : "Original texture" ], [ "Accessory category", core.isAccessory(draft.itemType) ? core.KIND_LABELS[draft.accessoryKind] : "—" ], [ "On sale", draft.startMode === "date" ? new Date(draft.startDate).toLocaleString() : "When code is run" ], [ "Off sale", draft.catalogType === "offsale" ? "Immediately" : draft.endMode === "duration" ? draft.duration + " " + draft.durationUnit + " after sale start" : draft.endMode === "date" ? new Date(draft.endDate).toLocaleString() : "No end date" ], [ "Description", draft.description || "—" ] ];
    for (const [label, value] of rows) {
      const row = node("tr");
      row.append(node("th", label), node("td", value));
      table.append(row);
    }
    target.append(table);
  }
  function randomKey() {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  let verificationScript;
  async function verifier(config, action) {
    const state = {
      value: "",
      id: null,
      reset() {
        state.value = "";
        if (state.id !== null) root.turnstile?.reset(state.id);
      }
    };
    if (!root.turnstile) {
      verificationScript ||= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error("The verification check could not load. Refresh the page."));
        document.head.append(script);
      });
      await verificationScript;
    }
    state.id = root.turnstile.render($("verification"), {
      sitekey: config.siteKey,
      action: action,
      theme: "light",
      size: "flexible",
      callback: value => state.value = value,
      "expired-callback": () => state.value = "",
      "error-callback": () => {
        state.value = "";
        toast("Verification could not complete. Refresh or try again.");
      }
    });
    return state;
  }
  for (const button of document.querySelectorAll("[data-close]")) button.addEventListener("click", () => $(button.dataset.close).close());
  if (form) {
    for (const kind of core.KINDS) {
      const option = node("option", core.KIND_LABELS[kind]);
      option.value = kind;
      $("accessory-kind").append(option);
    }
    $("accessory-kind").addEventListener("change", () => {
      if (core.isAccessory($("item-type").value)) $("item-type").value = $("accessory-kind").value === "Hair" ? "Hair" : "Hat";
    });
    $("item-type").addEventListener("change", () => {
      if ($("item-type").value === "Hair") $("accessory-kind").value = "Hair";
      else if ($("item-type").value === "Hat" && $("accessory-kind").value === "Hair") $("accessory-kind").value = "Hat";
    });
  }
  form?.addEventListener("change", sync);
  root.CatalogUI = {
    $: $,
    node: node,
    notice: notice,
    toast: toast,
    api: api,
    connect: connect,
    readDraft: readDraft,
    fillDraft: fillDraft,
    sync: sync,
    validDraft: validDraft,
    showAsset: showAsset,
    thumbnail: thumbnail,
    applyAsset: applyAsset,
    summary: summary,
    randomKey: randomKey,
    verifier: verifier
  };
})(window);
