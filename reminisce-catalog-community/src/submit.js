(async function() {
  "use strict";
  const ui = window.CatalogUI, core = window.CatalogCore, {$: $, node: node, notice: notice, toast: toast, api: api} = ui;
  let kind = "official", lookupMode = "name", lookupVersion = 0, selected = null, verification = null, pending = null, cursor = null, searchQuery = "", busy = false, searchTimer;
  const searchCategory = () => ({ Face: "faces", Tool: "gear", BodyPackage: "bundles", Head: "heads" }[$("item-type").value] || "accessories");
  const receiptStorage = "reminisce.receipts.v2";
  let receipts = [];
  try {
    const saved = JSON.parse(localStorage.getItem(receiptStorage) || "[]");
    if (Array.isArray(saved)) receipts = saved.filter(item => item && /^[a-f0-9-]{36}$/.test(item.id) && /^[A-Za-z0-9_-]{43}$/.test(item.receiptKey)).slice(0, 30);
  } catch {}
  function saveReceipts() {
    try {
      localStorage.setItem(receiptStorage, JSON.stringify(receipts));
    } catch {
      toast("Keep this page open to retain your submission receipts.");
    }
    renderReceipts();
  }
  function renderReceipts() {
    $("receipts").replaceChildren();
    if (!receipts.length) $("receipts").append(node("p", "Nothing submitted from this device yet.", "helper"));
    for (const item of receipts) {
      const row = node("div", undefined, "receipt");
      row.append(node("strong", item.name), node("span", item.status, "tag"), node("small", item.id));
      $("receipts").append(row);
    }
    $("check-status").hidden = !receipts.length;
  }
  function setKind(value) {
    kind = value;
    for (const type of [ "official", "reskin" ]) {
      const active = type === kind;
      $("kind-" + type).classList.toggle("active", active);
      $("kind-" + type).setAttribute("aria-pressed", String(active));
    }
    $("custom-texture").checked = kind === "reskin";
    $("custom-texture").disabled = true;
    $("item-type").disabled = false;
    $("texture-check-field").hidden = true;
    ui.sync();
    $("texture-check-field").hidden = true;
    $("edit-state").textContent = kind === "reskin" ? "Use an official base hat and your replacement texture." : "Suggested settings for an official Roblox item.";
  }
  for (const type of [ "official", "reskin" ]) $("kind-" + type).addEventListener("click", () => setKind(type));
  async function choose(id, query = null, assetKind = "Asset", category = searchCategory(), version = lookupVersion) {
    const {item: item} = await api("/asset/" + id + "?kind=" + assetKind);
    if (query !== null && query !== $("search-input").value.trim()) return;
    if (version !== lookupVersion || category !== searchCategory()) return;
    ui.applyAsset(item, kind === "reskin");
    selected = item;
    const supportsReskin = core.isAccessory($("item-type").value) || $("item-type").value === "Face";
    $("kind-reskin").disabled = !supportsReskin;
    if (!supportsReskin) kind = "official";
    setKind(kind);
    notice("lookup-status", "Verified official Roblox item · " + item.name + (item.assetType === 18 ? ". Enter its classic face texture ID below." : ""));
    $("search-results").replaceChildren();
  }
  function results(items, append) {
    if (!append) $("search-results").replaceChildren();
    for (const item of items) {
      const button = node("button", undefined, "result");
      button.type = "button";
      const icon = ui.thumbnail(item), details = node("span", undefined, "result-caption");
      details.append(node("strong", item.name), node("small", "by Roblox"), node("small", "ID " + item.id));
      button.append(icon, details);
      button.addEventListener("click", async () => {
        if (busy) return;
        busy = true;
        try {
          await choose(item.id, null, item.kind);
        } catch (error) {
          notice("lookup-status", error.message);
        } finally {
          busy = false;
        }
      });
      $("search-results").append(button);
    }
  }
  async function search(append = false) {
    if (busy) return;
    busy = true;
    $("search-button").disabled = true;
    notice("lookup-status", "Searching Roblox…");
    try {
      const query = append ? searchQuery : $("search-input").value.trim(), parsed = core.parseAssetQuery(query), category = searchCategory(), version = lookupVersion;
      if (lookupMode === "link" && !parsed) throw new Error("Paste a Roblox catalog or bundle link, or enter an item ID.");
      if (parsed) {
        if (!parsed.id) throw new Error("Enter a valid Roblox asset or bundle ID.");
        const fromLink = /^https?:\/\//i.test(query);
        await choose(parsed.id, query, parsed.kind === "Bundle" || !fromLink && category === "bundles" ? "Bundle" : "Asset", category, version);
        cursor = null;
      } else {
        const data = await api("/search?q=" + encodeURIComponent(query) + "&category=" + category + (append && cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
        if (version !== lookupVersion || query !== $("search-input").value.trim() || category !== searchCategory()) return;
        searchQuery = query;
        cursor = data.nextCursor;
        results(data.items, append);
        notice("lookup-status", data.items.length ? "Choose a result to copy its details." : "No official Roblox items matched. Try another name, Item type, or item link.");
        if (!append && data.exactMatchId) await choose(data.exactMatchId, query, category === "bundles" ? "Bundle" : "Asset", category, version);
      }
      $("more-results").hidden = !cursor;
    } catch (error) {
      notice("lookup-status", error.message);
    } finally {
      busy = false;
      $("search-button").disabled = false;
    }
  }
  $("search-form").addEventListener("submit", event => {
    event.preventDefault();
    clearTimeout(searchTimer);
    search();
  });
  $("more-results").addEventListener("click", () => search(true));
  function clearResults() {
    lookupVersion++;
    clearTimeout(searchTimer);
    cursor = null;
    $("more-results").hidden = true;
    $("search-results").replaceChildren();
  }
  $("item-type").addEventListener("change", () => {
    selected = null;
    clearResults();
    const supportsReskin = core.isAccessory($("item-type").value) || $("item-type").value === "Face";
    $("kind-reskin").disabled = !supportsReskin;
    if (!supportsReskin) kind = "official";
    setKind(kind);
    notice("lookup-status", "Search for an official Roblox item of this type, or paste its link.");
  });
  for (const mode of [ "name", "link" ]) $("lookup-" + mode).addEventListener("click", () => {
    lookupMode = mode;
    clearResults();
    for (const value of [ "name", "link" ]) {
      $("lookup-" + value).classList.toggle("active", value === mode);
      $("lookup-" + value).setAttribute("aria-pressed", String(value === mode));
    }
    $("search-label").textContent = mode === "link" ? "Roblox item link or ID" : "Roblox item name";
    $("search-input").type = mode === "link" ? "text" : "search";
    $("search-input").placeholder = mode === "link" ? "https://www.roblox.com/catalog/…" : "e.g. Sinister Zombie";
    $("search-input").value = "";
    $("search-button").textContent = mode === "link" ? "Fill details" : "Search";
    $("search-input").focus();
  });
  $("search-input").addEventListener("input", () => {
    clearResults();
    function run() {
      if ($("search-input").value.trim().length < 2) return;
      if (busy) searchTimer = setTimeout(run, 650);
      else search();
    }
    if ($("search-input").value.trim().length >= 2) searchTimer = setTimeout(run, 650);
  });
  $("asset-id").addEventListener("change", () => {
    if ($("item-type").value !== "Face" && selected && String(selected.id) !== $("asset-id").value) {
      selected = null;
      ui.showAsset(null);
    }
  });
  $("primary-action").textContent = "Review submission";
  $("item-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    notice("form-errors", "");
    $("primary-action").disabled = true;
    busy = true;
    try {
      let draft = ui.readDraft();
      const assetKind = draft.itemType === "BodyPackage" ? "Bundle" : "Asset";
      if (draft.itemType === "Face" && !selected) throw new Error("First find the Roblox face by name or paste its item link. Then enter its classic texture ID in Item details.");
      if (!selected || String(selected.id) !== draft.assetId || selected.kind !== assetKind) {
        const {item: item} = await api("/asset/" + encodeURIComponent(draft.assetId) + "?kind=" + assetKind);
        selected = item;
        const mapping = core.assetMapping(item.assetType, item.kind);
        draft = {
          ...draft,
          ...mapping,
          accessoryKind: core.isAccessory(mapping.itemType) ? draft.accessoryKind || mapping.accessoryKind : "",
          name: draft.name || item.name,
          description: draft.description || item.description,
          texture: mapping.itemType === "Face" ? "" : draft.texture
        };
        ui.fillDraft(draft);
        ui.showAsset(item);
        setKind(kind);
        if (mapping.itemType === "Face") {
          $("asset-id").focus();
          throw new Error("Roblox details copied. Enter the classic face texture ID in Item details.");
        }
      }
      draft = ui.validDraft();
      draft.customTexture = kind === "reskin";
      if (kind === "reskin" && !(core.isAccessory(draft.itemType) || draft.itemType === "Face")) throw new Error("Choose an accessory or classic face for a reskin.");
      if (kind === "reskin" || draft.itemType === "Face") {
        const {item: item} = await api("/texture/" + core.assetContent(draft.texture).split("//")[1]);
        draft.texture = "rbxassetid://" + item.id;
        ui.fillDraft(draft);
      }
      await api("/check-item", { method: "POST", data: { kind, draft: Object.fromEntries([ "name", "itemType", "assetId", "customTexture", "texture" ].map(key => [key, draft[key]])) } });
      if (!verification?.value) throw new Error("Complete the verification check below before submitting.");
      pending = {
        kind: kind,
        draft: draft,
        receiptKey: ui.randomKey()
      };
      ui.summary(draft, $("review-content"));
      notice("submission-error", "");
      $("review-dialog").showModal();
    } catch (error) {
      notice("form-errors", error.message);
      $("form-errors").scrollIntoView({
        block: "center",
        behavior: "smooth"
      });
    } finally {
      busy = false;
      $("primary-action").disabled = false;
    }
  });
  $("confirm-submit").addEventListener("click", async () => {
    if (!pending || busy) return;
    busy = true;
    $("confirm-submit").disabled = true;
    notice("submission-error", "");
    try {
      const result = await api("/submissions", {
        method: "POST",
        data: {
          ...pending,
          turnstileToken: verification.value
        }
      });
      receipts.unshift({
        ...result,
        name: pending.draft.name,
        status: "pending"
      });
      receipts = receipts.slice(0, 30);
      saveReceipts();
      $("review-dialog").close();
      pending = null;
      toast("Submission received. You can check its status on this device.");
      ui.fillDraft(core.defaults());
      selected = null;
      $("kind-reskin").disabled = false;
      ui.showAsset(null);
      setKind(kind);
      clearResults();
      $("search-input").value = "";
      notice("lookup-status", "Search for your next official Roblox item.");
    } catch (error) {
      notice("submission-error", error.message);
    } finally {
      verification?.reset();
      busy = false;
      $("confirm-submit").disabled = false;
    }
  });
  $("check-status").addEventListener("click", async () => {
    $("check-status").disabled = true;
    try {
      for (const receipt of receipts) {
        try {
          const result = await api("/status", {
            method: "POST",
            data: {
              id: receipt.id,
              receiptKey: receipt.receiptKey
            }
          });
          receipt.status = result.status;
          receipt.name = result.name;
        } catch (error) {
          if (error.status === 404) receipt.status = "Unavailable"; else throw error;
        }
      }
      saveReceipts();
      toast("Submission statuses updated.");
    } catch (error) {
      toast(error.message);
    } finally {
      $("check-status").disabled = false;
    }
  });
  ui.fillDraft(core.defaults());
  $("item-type").querySelector('option[value="TShirt"]').remove();
  setKind(kind);
  renderReceipts();
  $("primary-action").disabled = true;
  $("search-button").disabled = true;
  const config = await ui.connect();
  if (config) {
    $("daily-limit").textContent = "Daily limit: " + config.dailyLimit + " submissions per network.";
    try {
      verification = await ui.verifier(config, "submit");
      $("primary-action").disabled = false;
      $("search-button").disabled = false;
    } catch (error) {
      notice("service-status", error.message);
    }
  }
})();
