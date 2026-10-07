(async function() {
  "use strict";
  const ui = window.CatalogUI, core = window.CatalogCore, {$: $, node: node, notice: notice, toast: toast} = ui;
  let session = "", expiryTimer, verification = null, filter = "pending", rows = [], cursor = null, current = null, creating = false, busy = false, exportItems = [];
  const selected = new Map;
  function signedOut() {
    session = "";
    clearTimeout(expiryTimer);
    selected.clear();
    rows = [];
    current = null;
    exportItems = [];
    $("owner-workspace").hidden = true;
    $("login-panel").hidden = false;
    $("logout").hidden = true;
    $("session-status").hidden = true;
    $("queue-list").replaceChildren();
    $("output-code").value = "";
    $("owner-key").value = "";
    ui.fillDraft(core.defaults());
    for (const dialog of document.querySelectorAll("dialog[open]")) dialog.close();
    verification?.reset();
  }
  async function api(path, options = {}) {
    try {
      return await ui.api(path, {
        ...options,
        token: session
      });
    } catch (error) {
      if (error.status === 401) {
        signedOut();
        notice("login-error", "Your session has expired. Sign in again.");
      }
      throw error;
    }
  }
  function controls() {
    $("selected-count").textContent = String(selected.size);
    $("generate").disabled = !selected.size || busy;
    $("select-all-label").hidden = filter !== "approved" || !rows.length;
    $("select-all").checked = rows.length > 0 && rows.every(row => selected.has(row.id));
  }
  function openItem(item) {
    current = item;
    creating = false;
    $("detail-empty").hidden = true;
    $("detail-editor").hidden = false;
    $("owner-lookup").hidden = true;
    $("contributor-detail").hidden = false;
    $("detail-kind").textContent = item.kind === "reskin" ? "CUSTOM RESKIN" : item.kind === "owner" ? "OWNER ITEM" : "OFFICIAL ROBLOX ITEM";
    $("detail-title").textContent = item.draft.name;
    $("detail-status").textContent = item.status;
    $("detail-author").textContent = (item.kind === "owner" ? "Created by you" : "Submitted as " + item.username + " · username unverified") + " · " + new Date(item.createdAt * 1e3).toLocaleString();
    $("detail-notes").textContent = item.notes || "No contributor message.";
    $("owner-note").value = item.ownerNote || "";
    $("texture-link").hidden = !item.texture;
    if (item.texture) $("texture-link").href = "https://www.roblox.com/catalog/" + (item.texture.sourceId || item.texture.id);
    ui.fillDraft(item.draft);
    ui.showAsset(item.base);
    $("item-type").disabled = item.kind !== "owner";
    $("custom-texture").disabled = item.kind !== "owner";
    $("primary-action").textContent = item.status === "approved" ? "Save approved changes" : "Approve submission";
    $("decline").hidden = false;
    render();
  }
  function render() {
    $("queue-list").replaceChildren();
    $("queue-empty").hidden = rows.length > 0;
    if (!rows.length) {
      $("queue-empty").querySelector("h3").textContent = "No " + filter + " submissions.";
    }
    for (const item of rows) {
      const row = node("li", undefined, "queue-row" + (current?.id === item.id ? " chosen" : ""));
      if (filter === "approved") {
        const label = node("label", undefined, "queue-check"), check = node("input");
        check.type = "checkbox";
        check.checked = selected.has(item.id);
        check.setAttribute("aria-label", "Select " + item.draft.name);
        check.addEventListener("change", () => {
          if (check.checked) selected.set(item.id, {
            id: item.id,
            version: item.version
          }); else selected.delete(item.id);
          controls();
        });
        label.append(check);
        row.append(label);
      }
      const button = node("button", undefined, "queue-item");
      button.append(node("strong", item.draft.name), node("small", item.kind === "reskin" ? "Custom reskin · " + item.username : item.kind === "owner" ? "Owner item" : "Official item · " + item.username), node("span", core.LABELS[item.draft.catalogType] + " · " + item.draft.price + " pNgs", "batch-meta"));
      button.addEventListener("click", () => {
        if (!busy) openItem(item);
      });
      row.append(button);
      $("queue-list").append(row);
    }
    $("load-more").hidden = !cursor;
    $("queue-title").textContent = filter[0].toUpperCase() + filter.slice(1) + " submissions";
    for (const button of document.querySelectorAll("[data-status]")) {
      const active = button.dataset.status === filter;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", String(active));
    }
    controls();
  }
  async function load(append = false) {
    const data = await api("/admin/submissions?status=" + filter + (append && cursor ? "&cursor=" + encodeURIComponent(cursor) : ""));
    rows = append ? [ ...rows, ...data.items ] : data.items;
    cursor = data.nextCursor;
    for (const status of [ "pending", "approved", "declined" ]) $(status + "-count").textContent = data.counts[status];
    $("catalog-count").textContent = "(" + data.catalogCount + ")";
    for (const item of rows) {
      if (selected.has(item.id)) selected.set(item.id, {
        id: item.id,
        version: item.version
      });
    }
    render();
  }
  $("login-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    $("login-button").disabled = true;
    notice("login-error", "");
    try {
      if (!verification?.value) throw new Error("Complete the verification check to sign in.");
      const data = await ui.api("/admin/login", {
        method: "POST",
        data: {
          key: $("owner-key").value,
          turnstileToken: verification.value
        }
      });
      session = data.token;
      $("login-panel").hidden = true;
      $("owner-workspace").hidden = false;
      $("logout").hidden = false;
      $("session-status").hidden = false;
      $("session-status").textContent = "Session ends " + new Date(data.expiresAt * 1e3).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      expiryTimer = setTimeout(() => {
        signedOut();
        notice("login-error", "Your session has expired. Sign in again.");
      }, Math.max(0, data.expiresAt * 1e3 - Date.now()));
      await load();
    } catch (error) {
      notice("login-error", error.message);
      if (session) toast(error.message);
    } finally {
      $("owner-key").value = "";
      verification?.reset();
      busy = false;
      $("login-button").disabled = false;
      controls();
    }
  });
  $("logout").addEventListener("click", async () => {
    try {
      if (session) await api("/admin/logout", {
        method: "POST",
        data: {}
      });
    } catch {}
    signedOut();
  });
  $("download-catalog").addEventListener("click", async () => {
    if (busy) return;
    $("download-catalog").disabled = true;
    try {
      const catalog = await api("/admin/catalog");
      const lines = [ "REMINISCE CURRENT NON-CLOTHING ITEM LIST", "Generated " + new Date().toISOString().slice(0, 10), "Total registered non-clothing items: " + catalog.items.filter(item => item.itemType !== "TShirt").length, "Includes current items and accepted submissions.", "" ];
      let index = 0;
      for (const item of catalog.items) {
        if (item.itemType === "TShirt") continue;
        const details = item.details;
        const price = item.source === "accepted" && core.HIDDEN_TYPES.includes(details.catalogType) ? "0" : details.price || "0";
        const stock = item.source === "accepted" && details.catalogType !== "limited" ? "0" : details.stock || "0";
        const fields = [ String(++index).padStart(3, "0") + ". [" + item.itemType + "] " + item.name, "AssetId " + item.assetId, details.flags || core.LABELS[details.catalogType] || "Accepted", "Price " + price, "Stock " + stock ];
        if (item.texture) fields.push("Texture " + item.texture);
        if (item.accessoryKind) fields.push("Accessory " + core.KIND_LABELS[item.accessoryKind]);
        lines.push(fields.join(" | "));
      }
      const url = URL.createObjectURL(new Blob([ lines.join("\n") + "\n" ], { type: "text/plain;charset=utf-8" })), link = node("a");
      link.href = url;
      link.download = "Current_NonClothing_Item_List_" + new Date().toISOString().slice(0, 10).replaceAll("-", "") + ".txt";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast("Updated item list downloaded.");
    } catch (error) {
      toast(error.message);
    } finally {
      $("download-catalog").disabled = false;
    }
  });
  window.addEventListener("pagehide", signedOut);
  for (const button of document.querySelectorAll("[data-status]")) button.addEventListener("click", async () => {
    if (busy) return;
    filter = button.dataset.status;
    current = null;
    $("detail-editor").hidden = true;
    $("detail-empty").hidden = false;
    try {
      await load();
    } catch (error) {
      toast(error.message);
    }
  });
  $("refresh-queue").addEventListener("click", async () => {
    if (busy) return;
    try {
      await load();
      if (current) {
        const item = rows.find(row => row.id === current.id);
        if (item) openItem(item); else {
          current = null;
          $("detail-editor").hidden = true;
          $("detail-empty").hidden = false;
        }
      }
      toast("Queue refreshed.");
    } catch (error) {
      toast(error.message);
    }
  });
  $("load-more").addEventListener("click", async () => {
    if (busy) return;
    $("load-more").disabled = true;
    try {
      await load(true);
    } catch (error) {
      toast(error.message);
    } finally {
      $("load-more").disabled = false;
    }
  });
  $("select-all").addEventListener("change", () => {
    for (const item of rows) {
      if ($("select-all").checked) selected.set(item.id, {
        id: item.id,
        version: item.version
      }); else selected.delete(item.id);
    }
    render();
  });
  $("new-item").addEventListener("click", () => {
    if (busy) return;
    creating = true;
    current = null;
    $("detail-empty").hidden = true;
    $("detail-editor").hidden = false;
    $("owner-lookup").hidden = false;
    $("contributor-detail").hidden = true;
    $("detail-title").textContent = "Create your own item";
    $("detail-kind").textContent = "OWNER ITEM";
    $("detail-status").textContent = "New";
    $("owner-note").value = "";
    ui.fillDraft(core.defaults());
    ui.showAsset(null);
    $("item-type").disabled = false;
    $("custom-texture").disabled = false;
    $("primary-action").textContent = "Save as approved";
    $("decline").hidden = true;
    $("edit-state").textContent = "Owner items are added directly to Approved.";
    render();
  });
  $("owner-lookup-form").addEventListener("submit", async event => {
    event.preventDefault();
    try {
      const parsed = core.parseAssetQuery($("owner-asset").value);
      if (!parsed?.id) throw new Error("Enter an asset ID or a Roblox catalog / bundle link.");
      const {item: item} = await api("/admin/asset/" + parsed.id + "?kind=" + parsed.kind);
      ui.applyAsset(item);
      notice("owner-lookup-status", "Filled details for " + item.name);
    } catch (error) {
      notice("owner-lookup-status", error.message);
    }
  });
  $("item-form").addEventListener("submit", async event => {
    event.preventDefault();
    if (busy || !current && !creating) return;
    busy = true;
    $("primary-action").disabled = true;
    notice("form-errors", "");
    try {
      const draft = ui.validDraft();
      let result;
      if (creating) result = await api("/admin/items", {
        method: "POST",
        data: {
          draft: draft,
          ownerNote: $("owner-note").value
        }
      }); else result = await api("/admin/submissions/" + current.id, {
        method: "PATCH",
        data: {
          action: "approve",
          version: current.version,
          draft: draft,
          ownerNote: $("owner-note").value
        }
      });
      selected.set(result.item.id, {
        id: result.item.id,
        version: result.item.version
      });
      filter = "approved";
      await load();
      openItem(result.item);
      toast("Approved and selected for export.");
    } catch (error) {
      notice("form-errors", error.message);
    } finally {
      busy = false;
      $("primary-action").disabled = false;
      controls();
    }
  });
  $("decline").addEventListener("click", () => {
    if (current && !busy) {
      notice("decline-error", "");
      $("decline-dialog").showModal();
    }
  });
  $("confirm-decline").addEventListener("click", async () => {
    if (!current || busy) return;
    busy = true;
    $("confirm-decline").disabled = true;
    try {
      await api("/admin/submissions/" + current.id, {
        method: "PATCH",
        data: {
          action: "decline",
          version: current.version,
          ownerNote: $("owner-note").value
        }
      });
      selected.delete(current.id);
      current = null;
      $("decline-dialog").close();
      $("detail-editor").hidden = true;
      $("detail-empty").hidden = false;
      await load();
      toast("Submission declined.");
    } catch (error) {
      notice("decline-error", error.message);
    } finally {
      busy = false;
      $("confirm-decline").disabled = false;
      controls();
    }
  });
  async function output() {
    $("output-code").value = "";
    $("copy-code").disabled = true;
    $("download-code").disabled = true;
    notice("copy-status", "Generating code…");
    try {
      const data = await api("/admin/generate", {
        method: "POST",
        data: {
          items: exportItems,
          mode: $("output-mode").value
        }
      });
      $("output-code").value = data.code;
      const requirements = [];
      if (data.requirements.heads) requirements.push("Heads require the updated head system in your game before publishing.");
      if (data.requirements.detailedPlacement) requirements.push("Exact shoulder, collar, and waist choices require the game to read the exported placement fields.");
      notice("export-requirements", requirements.join(" "));
      $("output-summary").textContent = data.count + " approved item" + (data.count === 1 ? "" : "s");
      notice("copy-status", "");
      $("copy-code").disabled = false;
      $("download-code").disabled = false;
    } catch (error) {
      notice("copy-status", error.message);
    }
  }
  $("generate").addEventListener("click", async () => {
    if (busy || !selected.size) return;
    exportItems = Array.from(selected.values());
    $("output-dialog").showModal();
    await output();
  });
  $("output-mode").addEventListener("change", output);
  $("copy-code").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("output-code").value);
      notice("copy-status", "Copied to clipboard.");
    } catch {
      $("output-code").focus();
      $("output-code").select();
      notice("copy-status", "Press Ctrl+C or Cmd+C to copy the selected code.");
    }
  });
  $("download-code").addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([ $("output-code").value ], {
      type: "text/plain;charset=utf-8"
    })), link = node("a");
    link.href = url;
    link.download = "Reminisce_LiveCatalogPublisher.lua";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1e3);
  });
  ui.fillDraft(core.defaults());
  $("login-button").disabled = true;
  const config = await ui.connect();
  if (config) {
    try {
      verification = await ui.verifier(config, "owner-login");
      $("login-button").disabled = false;
    } catch (error) {
      notice("service-status", error.message);
    }
  }
})();
