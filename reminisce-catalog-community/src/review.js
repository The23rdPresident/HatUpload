(async function() {
  "use strict";
  const ui = window.CatalogUI, core = window.CatalogCore, {$: $, node: node, notice: notice, toast: toast} = ui;
  let session = "", expiryTimer, verification = null, filter = "pending", rows = [], cursor = null, current = null, creating = false, busy = false;
  const selected = new Map;
  let publishTimer;
  const canRetry = item => publishing.enabled && item.status === "approved" && item.publication?.retryable === true;
  const canRetryWebhook = item => publishing.webhook?.configured && item?.publication?.webhook?.retryable === true && item.publication.universeId === publishing.universeId;
  let publishing = { enabled: false, configured: false };
  function webhookMessage(item) {
    const webhook = item.publication?.webhook;
    if (!webhook) return "";
    if (webhook.status === "sent") return " Announcement sent.";
    if (webhook.status === "skipped") return " Event and special rewards are not announced.";
    if (["pending", "sending"].includes(webhook.status)) return " Sending the announcement…";
    return " Announcement: " + webhook.error + (webhook.nextAttempt ? " Next retry: " + new Date(webhook.nextAttempt * 1000).toLocaleTimeString() + "." : "");
  }
  function lockEditor(locked) {
    for (const input of document.querySelectorAll("#item-form input, #item-form select, #item-form textarea")) input.disabled = locked;
    $("owner-note").disabled = locked;
  }
  function publishMessage(item) {
    const state = item?.publication;
    if (!state) return "";
    if (state.autoDeclined) return "Automatically declined: " + state.error;
    if (state.status !== "published" && state.universeId !== publishing.universeId) return "This item is queued for experience " + state.universeId + ". Restore that Universe ID before retrying.";
    if (state.status === "published") return "Published to the game · " + new Date(state.publishedAt * 1000).toLocaleString() + (state.notification === "polling" ? ". Servers will refresh within about a minute." : ". Running servers were notified.") + webhookMessage(item) + " Item settings are locked.";
    if (state.status === "failed") return "Publish failed: " + state.error + (state.nextAttempt ? " Next retry: " + new Date(state.nextAttempt * 1000).toLocaleTimeString() + "." : " Use Retry publish after fixing the problem.");
    return state.status === "publishing" ? "Publishing to the game… Item settings are locked. Refresh to check its progress." : "Accepted and queued for the game. Item settings are locked. Refresh to check its progress.";
  }
  function signedOut() {
    session = "";
    clearTimeout(expiryTimer);
    clearTimeout(publishTimer);
    selected.clear();
    rows = [];
    current = null;
    $("owner-workspace").hidden = true;
    $("login-panel").hidden = false;
    $("logout").hidden = true;
    $("session-status").hidden = true;
    $("queue-list").replaceChildren();
    $("owner-key").value = "";
    lockEditor(false);
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
    $("retry-selected").disabled = !selected.size || selected.size > 30 || busy || !publishing.enabled;
    $("select-all-label").hidden = filter !== "approved" || !rows.some(canRetry);
    $("select-all").checked = rows.some(canRetry) && rows.filter(canRetry).every(row => selected.has(row.id));
  }
  function openItem(item) {
    current = item;
    creating = false;
    $("detail-empty").hidden = true;
    $("detail-editor").hidden = false;
    $("owner-lookup").hidden = true;
    $("contributor-detail").hidden = false;
    $("detail-kind").textContent = item.kind === "reskin" ? "CUSTOM RESKIN" : item.kind === "owner" ? "OWNER ITEM" : "CATALOG ITEM";
    $("detail-title").textContent = item.draft.name;
    $("detail-status").textContent = item.status;
    $("detail-author").textContent = (item.kind === "owner" ? "Created by you" : "Community submission") + " · " + new Date(item.createdAt * 1e3).toLocaleString();
    $("owner-note").value = item.ownerNote || "";
    $("texture-link").hidden = !item.texture;
    if (item.texture) $("texture-link").href = "https://www.roblox.com/catalog/" + (item.texture.sourceId || item.texture.id);
    lockEditor(false);
    ui.fillDraft(item.draft);
    ui.showAsset(item.base);
    $("item-type").disabled = item.kind !== "owner";
    $("custom-texture").disabled = item.kind !== "owner";
    if (item.publication) lockEditor(true);
    $("primary-action").textContent = item.status === "approved" ? "Save approved changes" : "Approve submission";
    if (publishing.enabled && item.status !== "approved") $("primary-action").textContent = "Approve & publish";
    $("primary-action").disabled = Boolean(item.publication) || !publishing.enabled;
    $("decline").hidden = Boolean(item.publication);
    notice("publish-status", publishMessage(item));
    $("publish-item").hidden = !publishing.enabled || item.status !== "approved" || (item.publication && !canRetry(item));
    $("publish-item").textContent = item.publication ? "Retry publish" : "Publish to game";
    $("retry-webhook").hidden = !canRetryWebhook(item);
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
      if (filter === "approved" && canRetry(item)) {
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
      const caption = node("span", undefined, "queue-caption");
      caption.append(node("strong", item.draft.name), node("small", item.kind === "reskin" ? "Custom reskin" : item.kind === "owner" ? "Owner item" : "Catalog item"), node("span", core.LABELS[item.draft.catalogType] + " · " + item.draft.price + " pNgs", "batch-meta"));
      if (item.publication) caption.append(node("small", "Game: " + item.publication.status));
      if (item.publication?.webhook) caption.append(node("small", "Announcement: " + item.publication.webhook.status));
      button.append(ui.thumbnail(item.base, "queue-thumbnail"), caption);
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
    publishing = data.publishing;
    notice("publishing-config", (publishing.enabled ? "Automatic publishing configured. Test game connection to verify access before accepting items." : publishing.configured ? "Roblox is configured. Automatic publishing is switched off." : "Automatic publishing needs setup. Follow AUTO_PUBLISH.md to connect your game.") + (publishing.webhook?.configured ? " Announcements are configured." : " Add NEW_ITEM_WEBHOOK_URL to enable announcements without a player online."));
    cursor = data.nextCursor;
    for (const status of [ "pending", "approved", "declined" ]) $(status + "-count").textContent = data.counts[status];
    $("catalog-count").textContent = "(" + data.catalogCount + ")";
    for (const item of rows) {
      if (!canRetry(item)) selected.delete(item.id);
      else if (selected.has(item.id)) selected.set(item.id, {
        id: item.id,
        version: item.version
      });
    }
    render();
    schedulePublishRefresh();
  }
  function schedulePublishRefresh() {
    clearTimeout(publishTimer);
    const waiting = item => item?.publication && (["queued", "publishing"].includes(item.publication.status) || ["pending", "sending"].includes(item.publication.webhook?.status) || Boolean(item.publication.webhook?.nextAttempt));
    if (!session || !rows.some(waiting) && !waiting(current)) return;
    publishTimer = setTimeout(async () => {
      if (busy || document.hidden) { schedulePublishRefresh(); return; }
      try {
        if (current?.publication) await refreshItem(current.id);
        else await load();
      } catch { schedulePublishRefresh(); }
    }, 5000);
  }
  async function refreshItem(id) {
    const {item} = await api("/admin/submissions/" + id);
    if (filter !== item.status) selected.clear();
    filter = item.status;
    await load();
    openItem(item);
    schedulePublishRefresh();
    return item;
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
        const stock = item.source === "accepted" && ![ "limited", "limited-u" ].includes(details.catalogType) ? "0" : details.stock || "0";
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
    selected.clear();
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
      if (current) await refreshItem(current.id);
      else await load();
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
    for (const item of rows.filter(canRetry)) {
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
    lockEditor(false);
    ui.fillDraft(core.defaults());
    ui.showAsset(null);
    $("item-type").disabled = false;
    $("custom-texture").disabled = false;
    $("primary-action").textContent = "Approve & publish";
    $("primary-action").disabled = !publishing.enabled;
    notice("publish-status", "");
    $("publish-item").hidden = true;
    $("retry-webhook").hidden = true;
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
    if (busy || !publishing.enabled || !current && !creating) return;
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
      const item = await refreshItem(result.item.id);
      toast(item.publication?.autoDeclined ? "Submission automatically declined." : item.publication ? "Approved and queued for your game." : "Approved.");
    } catch (error) {
      notice("form-errors", error.message);
    } finally {
      busy = false;
      $("primary-action").disabled = Boolean(current?.publication) || !publishing.enabled;
      controls();
    }
  });
  $("test-publishing").addEventListener("click", async () => {
    if (busy) return;
    $("test-publishing").disabled = true;
    notice("publishing-test", "Checking your game connection…");
    try {
      const result = await api("/admin/publishing/test", { method: "POST", data: {} });
      const panel = $("publishing-test");
      panel.hidden = false;
      panel.replaceChildren(node("p", result.connected ? "Catalog read access verified." : "Catalog connection failed: " + result.error));
      const table = node("table", undefined, "review-table");
      const fields = [
        ["Target game (public information)", result.experience?.name || "Game name unavailable"],
        ["Creator", result.experience?.creator || "Unavailable"],
        ["Universe ID", result.universeId || "Not configured"],
        ["Main place ID", result.experience?.rootPlaceId || "Unavailable"],
        ["Uploader version", result.uploaderVersion],
        ["Automatic publishing", result.enabled ? "Enabled" : "Disabled"],
        ["Webhook secret", result.webhook?.configured ? "Configured; delivery is confirmed when an item is published" : "Missing or invalid: NEW_ITEM_WEBHOOK_URL"],
        ["Announcement role ping", result.webhook?.roleConfigured ? "Configured" : "Disabled"]
      ];
      if (result.key) {
        const statuses = { active: "Active from this Worker", expired: "Expired", disabled: "Disabled", unavailable: "Could not verify" };
        fields.push(["Stored API key", (statuses[result.key.status] || "Could not verify") + (result.key.httpStatus ? " (HTTP " + result.key.httpStatus + ")" : "")]);
        const permissions = result.key.permissions;
        if (permissions) for (const [key, label] of [["read", "Read entry scope"], ["create", "Create entry scope"], ["update", "Update entry scope"], ["messaging", "Messaging scope"]]) fields.push([label, permissions[key] === true ? "Configured for this target" : permissions[key] === false ? "Missing for this target" : "Target restriction could not be verified"]);
      }
      if (result.diagnostic) fields.push(["Failed operation", result.diagnostic.operation], ["Roblox HTTP status", result.diagnostic.httpStatus], ["Required scope", result.diagnostic.requiredPermission]);
      if (result.connected) fields.push(
        ["Catalog version", result.catalogVersion],
        ["Published items", result.liveItemCount],
        ["Existing game items", result.authoredItemCount],
        ["Publisher protocol", result.protocolVersion],
        ["Registered place ID", result.registeredPlaceId || "Not reported"],
        ["Place build version", result.placeVersion || "Not reported by the installed game"],
        ["Registration recorded", result.registeredAt ? new Date(result.registeredAt * 1000).toLocaleString() : "Not reported"],
        ["Supported item types", result.types.map(type => core.KIND_LABELS[type] || type).join(", ")],
        ["Game announcement update", result.gameAnnouncements === "worker" ? "Installed in the registered place" : "Publish the updated game files to prevent duplicate announcements"]
      );
      for (const [label, value] of fields) {
        const row = node("tr");
        row.append(node("th", label), node("td", String(value ?? "Unavailable")));
        table.append(row);
      }
      panel.append(table);
      if (!result.connected) panel.append(node("p", "The game name identifies the configured target. It does not verify the API key or access to the catalog. Replace ROBLOX_API_KEY in this Worker's secrets after regenerating a key."));
      if (result.key?.permissions && Object.values(result.key.permissions).includes(false)) panel.append(node("p", "The stored key is missing a required scope for this target. Update its experience and data-store permissions, replace the Worker secret if regenerated, then test again."));
      if (result.experience) {
        const link = node("a", "Open game on Roblox");
        link.href = "https://www.roblox.com/games/" + result.experience.rootPlaceId;
        link.target = "_blank"; link.rel = "noopener noreferrer";
        panel.append(link);
      }
      if (result.connected) panel.append(node("p", "Accepted items use one shared catalog across places in this experience. Each place needs the updated game scripts. Servers refresh through notifications or the 60-second polling fallback. Scope checks show the key's declared permissions; a successful publication confirms write access. This test does not confirm every place. Registration time is not a server heartbeat."));
    } catch (error) { notice("publishing-test", error.message); }
    finally { $("test-publishing").disabled = false; }
  });
  $("publish-item").addEventListener("click", async () => {
    if (busy || !current) return;
    busy = true;
    $("publish-item").disabled = true;
    try {
      const result = await api("/admin/publish/" + current.id, { method: "POST", data: { version: current.version } });
      const item = await refreshItem(result.item.id);
      toast(item.publication?.autoDeclined ? "Submission automatically declined." : item.publication?.status === "published" ? "Published to your game." : "Item queued for your game.");
    } catch (error) { notice("publish-status", error.message); }
    finally { busy = false; $("publish-item").disabled = false; controls(); }
  });
  $("retry-webhook").addEventListener("click", async () => {
    if (busy || !current || !canRetryWebhook(current)) return;
    if (current.publication.webhook.status === "uncertain" && !window.confirm("Delivery could not be confirmed. Check the announcement channel first. Retry only if the announcement is missing.")) return;
    busy = true;
    $("retry-webhook").disabled = true;
    try {
      const result = await api("/admin/webhooks/" + current.id, { method: "POST", data: { version: current.version } });
      await refreshItem(result.item.id);
      toast("Announcement queued. The item stays published.");
    } catch (error) { notice("publish-status", error.message); }
    finally { busy = false; $("retry-webhook").disabled = false; controls(); }
  });
  $("decline").addEventListener("click", () => {
    if (current && !busy) {
      $("decline-note").value = current.status === "declined" ? current.declineNote || "" : "";
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
          ownerNote: $("owner-note").value,
          declineNote: $("decline-note").value
        }
      });
      selected.delete(current.id);
      current = null;
      $("decline-dialog").close();
      $("detail-editor").hidden = true;
      $("detail-empty").hidden = false;
      await load();
      toast("Submission declined. The reason is available on the submitter's private receipt.");
    } catch (error) {
      notice("decline-error", error.message);
    } finally {
      busy = false;
      $("confirm-decline").disabled = false;
      controls();
    }
  });
  $("retry-selected").addEventListener("click", async () => {
    if (busy || !selected.size || selected.size > 30) return;
    busy = true;
    controls();
    try {
      const result = await api("/admin/publish/retry", { method: "POST", data: { items: Array.from(selected.values()) } });
      selected.clear();
      await load();
      if (current) await refreshItem(current.id);
      toast(result.queued.length + " publication(s) queued." + (result.errors.length ? " " + result.errors.map(item => item.error).join(" ") : ""));
    } catch (error) { toast(error.message); }
    finally { busy = false; controls(); }
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
