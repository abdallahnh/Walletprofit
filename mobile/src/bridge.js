(function () {
  "use strict";

  const Core = window.MobileCore;
  if (!Core) throw new Error("mobile-core.js must load before bridge.js");

  const SUPABASE_URL = "https://dcptfccyqctejouoaskw.supabase.co";
  const SUPABASE_KEY = "sb_publishable_bNWy6tg7qZpJakFbDmXCag_PF5V1ip8";
  const AUTH_KEY = "walletProfitMobileAuth";
  const META_KEY = "walletProfitMobileCloudMeta";
  const DB_NAME = "walletProfitMobile";
  const DB_STORE = "snapshots";
  const DB_KEY = "current";
  const SYNC_INTERVAL_MS = 120000;
  const MOBILE_BUILD = "1.2.0";

  let data = Core.emptyData();
  let session = readJson(AUTH_KEY, null);
  let cloudMeta = readJson(META_KEY, { revision: 0, lastHash: null, userId: null });
  let autoSyncBusy = false;
  let autoSyncTimer = null;

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJson(key, value) {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  }

  function openCache() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(DB_STORE)) {
          request.result.createObjectStore(DB_STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function cacheGet() {
    return cacheGetKey(DB_KEY);
  }

  async function cacheGetKey(key) {
    const db = await openCache();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readonly");
      const request = transaction.objectStore(DB_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
    });
  }

  async function cacheSet(value) {
    return cachePut(DB_KEY, value);
  }

  async function cachePut(key, value) {
    const db = await openCache();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, "readwrite");
      transaction.objectStore(DB_STORE).put(value, key);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    });
  }

  async function hashSnapshot(snapshot) {
    const normalized = { ...snapshot };
    delete normalized.exported_at;
    const bytes = new TextEncoder().encode(JSON.stringify(normalized));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function persistCloudMeta() {
    writeJson(META_KEY, cloudMeta);
  }

  async function persistData() {
    data.exported_at = new Date().toISOString();
    await cacheSet(data);
  }

  const ready = (async () => {
    const cached = await cacheGet().catch(() => null);
    data = Core.normalizeData(cached || Core.emptyData());
    return data;
  })();

  async function supabaseRequest(path, options) {
    const opts = options || {};
    const headers = {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${session?.access_token || SUPABASE_KEY}`,
      Accept: "application/json",
      ...(opts.headers || {}),
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.prefer) headers.Prefer = opts.prefer;
    let response = await fetch(SUPABASE_URL + path, {
      method: opts.method || "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    if (response.status === 401 && opts.retry !== false && session?.refresh_token) {
      await refreshSession();
      return supabaseRequest(path, { ...opts, retry: false });
    }
    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) {
      const message = payload?.message || payload?.msg || payload?.error_description || payload?.error || text;
      throw new Error(message || `Cloud request failed (${response.status})`);
    }
    return payload;
  }

  async function signIn(email, password) {
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw new Error(payload.error_description || payload.message || payload.msg || "Sign in failed");
    }
    const changedUser = cloudMeta.userId && cloudMeta.userId !== payload.user?.id;
    session = payload;
    writeJson(AUTH_KEY, session);
    if (changedUser) {
      cloudMeta = { revision: 0, lastHash: null, userId: payload.user?.id || null };
      persistCloudMeta();
    } else if (!cloudMeta.userId) {
      cloudMeta.userId = payload.user?.id || null;
      persistCloudMeta();
    }
    ensureAutomaticSync();
    return cloudStatus();
  }

  async function refreshSession() {
    if (!session?.refresh_token) throw new Error("Cloud session expired. Please sign in again.");
    const response = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      session = null;
      writeJson(AUTH_KEY, null);
      throw new Error("Cloud session expired. Please sign in again.");
    }
    session = payload;
    writeJson(AUTH_KEY, session);
    return session;
  }

  async function getRemoteSnapshot() {
    if (!session?.access_token) throw new Error("Sign in to cloud first.");
    const rows = await supabaseRequest(
      "/rest/v1/wallet_profit_snapshots?id=eq.1&select=revision,data,updated_at,updated_by"
    );
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  async function pushSnapshot(expectedRevision) {
    if (!session?.user?.id) throw new Error("Sign in to cloud first.");
    const hash = await hashSnapshot(data);
    let rows;
    if (!expectedRevision) {
      rows = await supabaseRequest("/rest/v1/wallet_profit_snapshots", {
        method: "POST",
        prefer: "return=representation",
        body: {
          id: 1,
          revision: 1,
          data,
          updated_at: new Date().toISOString(),
          updated_by: session.user.id,
        },
      });
    } else {
      rows = await supabaseRequest(
        `/rest/v1/wallet_profit_snapshots?id=eq.1&revision=eq.${Number(expectedRevision)}`,
        {
          method: "PATCH",
          prefer: "return=representation",
          body: {
            revision: Number(expectedRevision) + 1,
            data,
            updated_at: new Date().toISOString(),
            updated_by: session.user.id,
          },
        }
      );
    }
    if (!Array.isArray(rows) || rows.length !== 1) {
      const error = new Error("Cloud data changed on another device. Download it or explicitly replace it.");
      error.code = "CLOUD_CONFLICT";
      throw error;
    }
    cloudMeta = { revision: Number(rows[0].revision), lastHash: hash, userId: session.user.id };
    persistCloudMeta();
    return rows[0];
  }

  async function pullSnapshot() {
    const remote = await getRemoteSnapshot();
    if (!remote?.data) throw new Error("There is no cloud data to download yet.");
    await createSafetyBackup();
    data = Core.normalizeData(remote.data);
    await persistData();
    cloudMeta = {
      revision: Number(remote.revision || 0),
      lastHash: await hashSnapshot(data),
      userId: session.user?.id || null,
    };
    persistCloudMeta();
    return { ok: true, action: "downloaded", revision: cloudMeta.revision };
  }

  async function syncCloud() {
    await ready;
    if (!session?.access_token) return { ok: false, error: "Sign in to cloud first." };
    const remote = await getRemoteSnapshot();
    if (!remote) {
      const uploaded = await pushSnapshot(0);
      return { ok: true, action: "uploaded", revision: Number(uploaded.revision) };
    }
    const remoteRevision = Number(remote.revision || 0);
    const localHash = await hashSnapshot(data);
    if (!cloudMeta.revision) {
      return {
        ok: false,
        conflict: true,
        needs_choice: true,
        remote_revision: remoteRevision,
        error: "This device has not synced with the existing cloud data. Choose Download Cloud or Replace Cloud.",
      };
    }
    const localChanged = localHash !== cloudMeta.lastHash;
    if (remoteRevision > cloudMeta.revision) {
      if (localChanged) {
        return { ok: false, conflict: true, remote_revision: remoteRevision, error: "Both this device and the cloud changed. Choose which copy to keep." };
      }
      return pullSnapshot();
    }
    if (remoteRevision < cloudMeta.revision) {
      return { ok: false, conflict: true, remote_revision: remoteRevision, error: "Cloud revision is older than this device. Use an explicit cloud action." };
    }
    if (!localChanged) return { ok: true, action: "current", revision: remoteRevision };
    const uploaded = await pushSnapshot(remoteRevision);
    return { ok: true, action: "uploaded", revision: Number(uploaded.revision) };
  }

  async function replaceCloud() {
    const remote = await getRemoteSnapshot();
    const uploaded = await pushSnapshot(Number(remote?.revision || 0));
    return { ok: true, action: "uploaded", revision: Number(uploaded.revision) };
  }

  async function cloudStatus() {
    await ready;
    const base = {
      ok: true,
      signed_in: !!session?.access_token,
      email: session?.user?.email || "",
      user_id: session?.user?.id || null,
      revision: Number(cloudMeta.revision || 0),
    };
    if (!base.signed_in) return base;
    try {
      const remote = await getRemoteSnapshot();
      return {
        ...base,
        remote_revision: Number(remote?.revision || 0),
        remote_updated_at: remote?.updated_at || null,
        cloud_empty: !remote,
      };
    } catch (error) {
      return { ...base, ok: false, error: String(error.message || error) };
    }
  }

  async function mutate(fn) {
    await ready;
    const result = await fn(data);
    if (result?.ok === false) return result;
    await persistData();
    if (session?.access_token && cloudMeta.revision) {
      try {
        const cloud = await syncCloud();
        if (!cloud.ok) return { ...(result || { ok: true }), cloud_pending: true, cloud_error: cloud.error };
        return { ...(result || { ok: true }), cloud };
      } catch (error) {
        return { ...(result || { ok: true }), cloud_pending: true, cloud_error: String(error.message || error) };
      }
    }
    return result || { ok: true };
  }

  function getConfigValue(prefix) {
    const row = data.config.find((item) => String(item.key || "").startsWith(prefix));
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  function setConfigValue(key, value) {
    Core.upsertBy(data.config, (row) => row.key === key, { key, value: JSON.stringify(value) });
  }

  function removeConfigPrefix(prefix) {
    data.config = data.config.filter((row) => !String(row.key || "").startsWith(prefix));
  }

  function navigate(page) {
    location.href = page;
    return Promise.resolve({ ok: true });
  }

  function selectFile(accept) {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = accept || "";
      input.onchange = () => resolve(input.files?.[0] || null);
      input.click();
    });
  }

  function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  async function saveAndShare(name, content, mimeType, options) {
    const plugins = window.Capacitor?.Plugins || {};
    const isBase64 = !!options?.base64;
    if (plugins.Filesystem && plugins.Share) {
      const writeOptions = {
        path: name,
        data: isBase64 ? content : toBase64(content),
        directory: "CACHE",
      };
      await plugins.Filesystem.writeFile(writeOptions);
      const uri = await plugins.Filesystem.getUri({ path: name, directory: "CACHE" });
      await plugins.Share.share({ title: name, url: uri.uri, dialogTitle: `Share ${name}` });
      return { ok: true, path: uri.uri, shared: true };
    }
    const blob = isBase64
      ? new Blob([Uint8Array.from(atob(content), (char) => char.charCodeAt(0))], { type: mimeType })
      : new Blob([content], { type: mimeType });
    const file = new File([blob], name, { type: mimeType });
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return { ok: true, path: name, shared: true };
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, path: name };
  }

  async function createSafetyBackup() {
    await ready;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await cachePut(`safety-${stamp}`, Core.normalizeData(data));
    return { ok: true, key: `safety-${stamp}` };
  }

  function parseCsvLine(line) {
    const result = [];
    let value = "";
    let quoted = false;
    for (let index = 0; index < line.length; index += 1) {
      const char = line[index];
      if (char === '"') {
        if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
        else quoted = !quoted;
      } else if (char === "," && !quoted) {
        result.push(value.trim()); value = "";
      } else value += char;
    }
    result.push(value.trim());
    return result;
  }

  function parseWalletText(text) {
    const rows = [];
    for (const line of String(text || "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      if (/^id[\s,]+amount[\s,]+reason/i.test(line)) continue;
      let columns = line.split("\t").map((item) => item.trim());
      if (columns.length < 5) columns = parseCsvLine(line);
      if (columns.length < 5) columns = line.split(/\s{2,}/).map((item) => item.trim());
      const id = Number(columns[0]);
      const amount = Number(String(columns[1] || "").replace(/,/g, ""));
      if (!Number.isFinite(id) || !Number.isFinite(amount)) continue;
      rows.push({ id, amount, reason: columns[2] || "", type: columns[3] || "", created_at: columns[4] || "", order_code: Core.extractOrderCode(columns[2]) });
    }
    return rows;
  }

  async function importWalletText(text) {
    const rows = parseWalletText(text);
    return mutate(() => {
      const existing = new Set(data.transactions.map((row) => String(row.id)));
      let inserted = 0;
      for (const row of rows) {
        if (existing.has(String(row.id))) continue;
        data.transactions.push(row);
        existing.add(String(row.id));
        inserted += 1;
      }
      return { ok: true, inserted, ignored: rows.length - inserted };
    });
  }

  async function importOrdersText(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2) return { ok: false, error: "CSV file has no data rows" };
    const header = parseCsvLine(lines[0]).map((item) => item.toLowerCase());
    const indexOf = (name) => header.indexOf(name);
    if (indexOf("order_code") < 0) return { ok: false, error: "CSV must include order_code" };
    let updated = 0;
    for (const line of lines.slice(1)) {
      const columns = parseCsvLine(line);
      const orderCode = columns[indexOf("order_code")];
      if (!orderCode) continue;
      let supplier = null;
      const name = indexOf("supplier_name") >= 0 ? String(columns[indexOf("supplier_name")] || "").trim() : "";
      if (name) {
        supplier = data.suppliers.find((item) => item.name.toLowerCase() === name.toLowerCase());
        if (!supplier) {
          supplier = { id: Core.nextId(data.suppliers), name, color: Core.normalizeColor(null, data.suppliers.length + 1), phone: "", created_at: new Date().toISOString() };
          data.suppliers.push(supplier);
        }
      }
      Core.upsertBy(data.order_meta, (row) => row.order_code === orderCode, {
        order_code: orderCode,
        supplier_id: supplier?.id || null,
        supplier_cost: indexOf("supplier_cost") >= 0 ? Math.trunc(Number(columns[indexOf("supplier_cost")] || 0)) : 0,
        supplier_paid: indexOf("supplier_paid") >= 0 && ["1", "true", "yes"].includes(String(columns[indexOf("supplier_paid")]).toLowerCase()) ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
      updated += 1;
    }
    return mutate(() => ({ ok: true, updated, total: lines.length - 1 }));
  }

  function ordersCsv() {
    const columns = ["order_code", "supplier_name", "gross", "service_fee", "vat", "incentive", "marketing", "merchant_payout", "toters_margin", "supplier_cost", "supplier_paid", "net_profit", "row_count", "dates"];
    const rows = Core.computeOrders(data).orders.map((order) => columns.map((key) => {
      const value = order[key] ?? "";
      return typeof value === "string" && /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(","));
    return [columns.join(","), ...rows].join("\n");
  }

  async function httpJson(url, headers) {
    const nativeHttp = window.Capacitor?.Plugins?.CapacitorHttp;
    if (nativeHttp) {
      const response = await nativeHttp.request({ url, method: "GET", headers: headers || {} });
      if (response.status < 200 || response.status >= 300) throw new Error(`Request failed (${response.status})`);
      return response.data;
    }
    const response = await fetch(url, { headers: headers || {} });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return response.json();
  }

  function validatedBaseUrl(value) {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:") throw new Error("Mobile wallet connections must use HTTPS");
    return url.toString().replace(/\/$/, "");
  }

  async function syncWallet() {
    await ready;
    const config = data.walletConfig || {};
    if (!config.storeId || !config.token) return { ok: false, error: "Missing store ID or token in Wallet Settings" };
    const base = validatedBaseUrl(config.baseUrl);
    const origin = new URL(base).origin;
    const wallet = config.wallet || "main";
    const key = `walletSyncCheckpoint:${config.storeId}:${wallet}`;
    const previous = getConfigValue(key) || {};
    const watermark = previous.last_synced_head_id ? String(previous.last_synced_head_id) : null;
    let cycleHead = null;
    let page = 1;
    let totalFetched = 0;
    let totalInserted = 0;
    let stoppedAtWatermark = false;
    for (let guard = 0; guard < 500; guard += 1) {
      const url = new URL(`${base}/api/stores/${encodeURIComponent(config.storeId)}/wallet/all`);
      url.searchParams.set("page", String(page));
      url.searchParams.set("wallet", wallet);
      if (url.origin !== origin) throw new Error("Wallet pagination left the configured server");
      const json = await httpJson(url.toString(), { Authorization: `Bearer ${config.token}`, Accept: "application/json" });
      const walletPage = json?.data?.wallet;
      const items = Array.isArray(walletPage?.data) ? walletPage.data : [];
      if (!cycleHead && items[0]?.id != null) cycleHead = String(items[0].id);
      const existing = new Set(data.transactions.map((row) => String(row.id)));
      for (const item of items) {
        if (watermark && String(item.id) === watermark) { stoppedAtWatermark = true; break; }
        totalFetched += 1;
        if (existing.has(String(item.id))) continue;
        data.transactions.push({ ...item, amount: Math.trunc(Number(item.amount || 0)), order_code: item.order_code || Core.extractOrderCode(item.reason) });
        existing.add(String(item.id));
        totalInserted += 1;
      }
      setConfigValue(key, {
        version: 2,
        store_id: String(config.storeId),
        wallet,
        status: "running",
        next_page: page,
        last_completed_page: Math.max(Number(previous.last_completed_page || 1), page),
        last_synced_head_id: watermark,
        updated_at: new Date().toISOString(),
      });
      if (stoppedAtWatermark || !walletPage?.next_page_url || !items.length) break;
      const next = new URL(walletPage.next_page_url, base);
      if (next.origin !== origin) throw new Error("Wallet pagination left the configured server");
      page += 1;
    }
    setConfigValue(key, {
      version: 2,
      store_id: String(config.storeId),
      wallet,
      status: "completed",
      next_page: 1,
      last_completed_page: Math.max(Number(previous.last_completed_page || 1), page),
      last_synced_head_id: cycleHead || watermark,
      last_completed_at: new Date().toISOString(),
    });
    const saved = await mutate(() => ({ ok: true }));
    return { ...saved, ok: true, pages: page, totalFetched, totalInserted, totalIgnored: totalFetched - totalInserted, stoppedAtWatermark, checkpoint: getConfigValue(key) };
  }

  async function remainingBalance() {
    await ready;
    const config = data.walletConfig || {};
    if (!config.storeId || !config.token) return { ok: false, error: "Missing store ID or token" };
    const base = validatedBaseUrl(config.baseUrl);
    const json = await httpJson(`${base}/api/retailer/stores-wallets-summary`, { Authorization: `Bearer ${config.token}`, Accept: "application/json" });
    const entry = json?.data?.[String(config.storeId)] || json?.data?.[Number(config.storeId)];
    if (!entry) return { ok: false, error: `Store ${config.storeId} not found in wallets summary` };
    const parsed = Core.parseWalletSummaryEntry(entry, config.wallet || "main");
    if (!parsed) return { ok: false, error: `No wallet summary for store ${config.storeId}` };
    return {
      ok: true,
      store_id: String(config.storeId),
      store_name: parsed.store_name,
      wallet: parsed.wallet,
      currency_ref: parsed.currency_ref,
      raw_amount_lbp: parsed.raw_amount_lbp,
      remaining_from_toters_lbp: parsed.remaining_from_toters_lbp,
      fetched_at: new Date().toISOString(),
      mobile_build: MOBILE_BUILD,
    };
  }

  function getProducts() {
    return [...data.products].sort((a, b) => String(a.item_name || "").localeCompare(String(b.item_name || "")));
  }

  async function importProductsRows(rows) {
    return mutate(() => {
      let count = 0;
      for (const raw of rows || []) {
        const barcode = String(raw.barcode || raw.Barcode || "").trim();
        if (!barcode) continue;
        const existing = data.products.find((item) => String(item.barcode) === barcode);
        const value = {
          ...(existing || {}),
          ...raw,
          id: existing?.id || Core.nextId(data.products),
          barcode,
          item_name: raw.item_name || raw["Item Name"] || raw.name || existing?.item_name || barcode,
          unit_price_usd: Number(raw.unit_price_usd ?? raw.price ?? existing?.unit_price_usd ?? 0),
          cost_usd: Number(raw.cost_usd ?? raw.cost ?? existing?.cost_usd ?? 0),
          stock_quantity: Number(raw.stock_quantity ?? raw.stock ?? existing?.stock_quantity ?? 0),
          created_at: existing?.created_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        Core.upsertBy(data.products, (item) => String(item.barcode) === barcode, value);
        count += 1;
      }
      return { ok: true, count };
    });
  }

  function workbookRowsToObjects(workbook) {
    const first = workbook.SheetNames[0];
    return window.XLSX.utils.sheet_to_json(workbook.Sheets[first], { defval: "" });
  }

  async function importProductsFile() {
    const file = await selectFile(".xlsx,.xls,.csv,.json");
    if (!file) return { ok: false, canceled: true };
    if (/\.json$/i.test(file.name)) return importProductsRows(JSON.parse(await file.text()));
    if (/\.csv$/i.test(file.name)) {
      const lines = (await file.text()).split(/\r?\n/).filter(Boolean);
      const header = parseCsvLine(lines.shift());
      return importProductsRows(lines.map((line) => Object.fromEntries(parseCsvLine(line).map((value, index) => [header[index], value]))));
    }
    if (!window.XLSX) return { ok: false, error: "Excel library is unavailable" };
    const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
    return importProductsRows(workbookRowsToObjects(workbook));
  }

  async function exportExcel(name, rows) {
    if (!window.XLSX) return saveAndShare(name.replace(/\.xlsx$/i, ".csv"), objectsToCsv(rows), "text/csv");
    const workbook = window.XLSX.utils.book_new();
    const worksheet = window.XLSX.utils.json_to_sheet(rows);
    window.XLSX.utils.book_append_sheet(workbook, worksheet, "Data");
    const base64 = window.XLSX.write(workbook, { bookType: "xlsx", type: "base64" });
    return saveAndShare(name, base64, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", { base64: true });
  }

  function objectsToCsv(rows) {
    if (!rows?.length) return "";
    const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    const escape = (value) => {
      const text = String(value ?? "");
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [headers.join(","), ...rows.map((row) => headers.map((header) => escape(row[header])).join(","))].join("\n");
  }

  function billText(bill) {
    const lines = [
      `Supplier Payment Bill`,
      `Order: ${bill.order_code}`,
      `Supplier: ${bill.supplier_name || "(Unassigned)"}`,
      bill.supplier_phone ? `Phone: ${bill.supplier_phone}` : "",
      "",
      ...(bill.lines || []).map((line) => `${line.item_name} × ${line.quantity}: ${Number(line.line_cost_display || 0).toLocaleString()} ${bill.display_currency}`),
      "",
      `Total: ${Number(bill.total_cost_display || 0).toLocaleString()} ${bill.display_currency}`,
      `Paid: ${bill.supplier_paid ? "Yes" : "No"}`,
    ];
    return lines.filter((line) => line !== "").join("\n");
  }

  async function openOrder(orderCode) {
    await ready;
    const order = Core.computeOrders(data).orders.find((item) => item.order_code === orderCode);
    if (!order) return { ok: false, error: "Order not found" };
    const bills = Core.buildBillDataList(data, orderCode);
    const saleRows = data.sales.filter((sale) => sale.order_code === orderCode);
    const orderDetail = saleRows.map((sale) => {
      const product = data.products.find((item) => Number(item.id) === Number(sale.product_id)) || {};
      return {
        quantity: sale.quantity,
        item_price: Number(sale.unit_price || 0) * Number(data.walletConfig?.usdToLbpRate || 90000),
        total: Number(sale.total_sale || 0) * Number(data.walletConfig?.usdToLbpRate || 90000),
        item: { ...product, barcode: sale.barcode || product.barcode },
      };
    });
    sessionStorage.setItem("walletProfitMobileOrder", JSON.stringify({
      order: { ...order, code: orderCode, order_detail: orderDetail },
      billData: bills[0] || null,
      billDataList: bills,
    }));
    return navigate("orderDetails.html");
  }

  const CATALOG_CACHE_KEY = "productCatalogCache";
  const CATALOG_SELECT = [
    "id", "barcode", "item_name", "sku", "brand", "category", "sub_category",
    "description", "model_name", "color", "measurement_unit", "measurement_value",
    "selling_price_usd", "vendor_price_usd", "merchant_code", "image_url", "image_urls",
    "stock_quantity", "is_available", "is_archived", "stock_status", "updated_at",
    "merchant_supplier_mapping(supplier_key,supplier_name)",
  ].join(",");

  async function catalogCachedProducts() {
    return (await cacheGetKey(CATALOG_CACHE_KEY).catch(() => null)) || [];
  }

  async function catalogGetProducts(options) {
    const opts = options || {};
    const filters = [`select=${encodeURIComponent(CATALOG_SELECT)}`, "order=item_name.asc"];
    if (!opts.includeArchived) filters.push("is_archived=eq.false");
    const term = String(opts.search || "").trim();
    if (term) {
      const pattern = encodeURIComponent(`*${term}*`);
      filters.push(`or=(barcode.ilike.${pattern},item_name.ilike.${pattern},sku.ilike.${pattern},brand.ilike.${pattern})`);
    }
    try {
      const products = await supabaseRequest(`/rest/v1/products?${filters.join("&")}`);
      await cachePut(CATALOG_CACHE_KEY, products || []);
      return { ok: true, products: products || [], source: "supabase" };
    } catch (error) {
      return {
        ok: true,
        products: await catalogCachedProducts(),
        source: "cache",
        warning: String(error.message || error),
      };
    }
  }

  async function catalogMutate(method, path, body) {
    try {
      const rows = await supabaseRequest(path, {
        method,
        prefer: "return=representation",
        body,
      });
      const product = Array.isArray(rows) ? rows[0] : null;
      if (!product) return { ok: false, error: "Supabase did not return the product" };
      const cached = await catalogCachedProducts();
      const index = cached.findIndex((item) => String(item.id) === String(product.id));
      if (index >= 0) cached[index] = product;
      else cached.push(product);
      await cachePut(CATALOG_CACHE_KEY, cached);
      return { ok: true, product };
    } catch (error) {
      return { ok: false, error: String(error.message || error) };
    }
  }

  const api = {
    importMerge: (text) => importWalletText(text),
    ordersGetReconciliation: async () => { await ready; return Core.computeOrders(data).orders; },
    totalsGet: async (opts) => { await ready; return Core.getTotals(data, opts); },
    ordersUpsertMeta: (payload) => mutate(() => {
      if (!payload?.order_code) return { ok: false, error: "Missing order code" };
      const supplierId = payload.supplier_id ? Number(payload.supplier_id) : null;
      if ((Number(payload.supplier_cost || 0) > 0 || payload.supplier_paid) && !supplierId) return { ok: false, error: "Select a supplier first" };
      data.order_line_meta = data.order_line_meta.filter((line) => line.order_code !== payload.order_code);
      Core.upsertBy(data.order_meta, (row) => row.order_code === payload.order_code, {
        order_code: payload.order_code,
        supplier_id: supplierId,
        supplier_cost: Math.trunc(Number(payload.supplier_cost || 0)),
        supplier_paid: payload.supplier_paid ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
      return { ok: true, supplier_id: supplierId };
    }),
    ordersGetLineMeta: async (orderCode) => { await ready; return { ok: true, lines: Core.lineMetaForOrder(data, orderCode) }; },
    ordersUpsertLineMeta: (payload) => mutate(() => {
      if (!payload?.order_code || !payload?.barcode) return { ok: false, error: "Missing order or barcode" };
      Core.upsertBy(data.order_line_meta, (line) => line.order_code === payload.order_code && String(line.barcode) === String(payload.barcode), {
        order_code: payload.order_code,
        barcode: String(payload.barcode),
        supplier_id: payload.supplier_id ? Number(payload.supplier_id) : null,
        supplier_cost_lbp: Math.trunc(Number(payload.supplier_cost_lbp || 0)),
        supplier_paid: payload.supplier_paid ? 1 : 0,
        updated_at: new Date().toISOString(),
      });
      const sale = data.sales.find((item) => item.order_code === payload.order_code && String(item.barcode) === String(payload.barcode));
      if (sale) {
        sale.cost = Number(payload.supplier_cost_lbp || 0) / Number(data.walletConfig?.usdToLbpRate || 90000);
        sale.profit = Number(sale.total_sale || 0) - sale.cost;
      }
      return { ok: true };
    }),
    resetSupplierMeta: () => mutate(() => { data.order_meta = []; data.order_line_meta = []; return { ok: true }; }),
    suppliersGetAll: async () => { await ready; return [...data.suppliers].map((supplier) => ({ ...supplier, color: Core.normalizeColor(supplier.color, supplier.id) })).sort((a, b) => a.name.localeCompare(b.name)); },
    suppliersCreate: (payload) => mutate(() => {
      const name = String(payload?.name || payload || "").trim();
      if (!name) return { ok: false, error: "Supplier name is required" };
      if (data.suppliers.some((supplier) => supplier.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `Supplier "${name}" already exists` };
      const id = Core.nextId(data.suppliers);
      const supplier = { id, name, color: Core.normalizeColor(payload?.color, id), phone: String(payload?.phone || "").trim(), created_at: new Date().toISOString() };
      data.suppliers.push(supplier);
      return { ok: true, supplier };
    }),
    suppliersUpdate: (payload) => mutate(() => {
      const supplier = data.suppliers.find((item) => Number(item.id) === Number(payload?.id));
      if (!supplier) return { ok: false, error: "Supplier not found" };
      const name = String(payload.name || "").trim();
      if (!name) return { ok: false, error: "Supplier name is required" };
      Object.assign(supplier, { name, color: Core.normalizeColor(payload.color, supplier.id), phone: String(payload.phone || "").trim() });
      return { ok: true };
    }),
    suppliersRename: (id, name) => api.suppliersUpdate({ ...(data.suppliers.find((item) => Number(item.id) === Number(id)) || {}), id, name }),
    suppliersDelete: (id) => mutate(() => {
      data.suppliers = data.suppliers.filter((supplier) => Number(supplier.id) !== Number(id));
      data.order_meta.forEach((meta) => { if (Number(meta.supplier_id) === Number(id)) meta.supplier_id = null; });
      data.order_line_meta.forEach((meta) => { if (Number(meta.supplier_id) === Number(id)) meta.supplier_id = null; });
      return { ok: true };
    }),
    suppliersGetSummary: async (opts) => { await ready; return Core.getSupplierSummary(data, opts); },
    openSuppliers: () => navigate("suppliers.html"),
    openSettlements: () => navigate("settlements.html"),
    openTransactions: () => navigate("transactions.html"),
    openCompanyExpenses: () => navigate("companyExpenses.html"),
    companyExpensesGetCategories: async () => { await ready; return [...new Set([...Core.DEFAULT_CATEGORIES, ...data.company_expenses.map((row) => row.category).filter(Boolean)])].sort(); },
    companyExpensesGetAll: async (opts) => { await ready; return Core.getExpenses(data, opts); },
    companyExpensesGetSummary: async (opts) => { await ready; const rows = Core.getExpenses(data, opts); return { count: rows.length, total_lbp: rows.reduce((sum, row) => sum + Number(row.amount_lbp || 0), 0), rows }; },
    companyExpensesCreate: (payload) => mutate(() => {
      const amount = Math.trunc(Number(payload?.amount_lbp || 0));
      if (!payload?.category || !payload?.expense_date || amount <= 0) return { ok: false, error: "Category, date, and a positive amount are required" };
      const id = Core.nextId(data.company_expenses);
      const now = new Date().toISOString();
      data.company_expenses.push({ id, category: String(payload.category), description: String(payload.description || ""), amount_lbp: amount, expense_date: String(payload.expense_date).slice(0, 10), notes: String(payload.notes || ""), created_at: now, updated_at: now });
      return { ok: true, id };
    }),
    companyExpensesUpdate: (payload) => mutate(() => {
      const row = data.company_expenses.find((item) => Number(item.id) === Number(payload?.id));
      if (!row) return { ok: false, error: "Expense not found" };
      const amount = Math.trunc(Number(payload.amount_lbp || 0));
      if (!payload.category || !payload.expense_date || amount <= 0) return { ok: false, error: "Category, date, and a positive amount are required" };
      Object.assign(row, { category: String(payload.category), description: String(payload.description || ""), amount_lbp: amount, expense_date: String(payload.expense_date).slice(0, 10), notes: String(payload.notes || ""), updated_at: new Date().toISOString() });
      return { ok: true };
    }),
    companyExpensesDelete: (id) => mutate(() => { const before = data.company_expenses.length; data.company_expenses = data.company_expenses.filter((row) => Number(row.id) !== Number(id)); return before === data.company_expenses.length ? { ok: false, error: "Expense not found" } : { ok: true }; }),
    transactionsGetSettlements: async () => { await ready; const settlements = Core.getTransactions(data, { type: "settlement" }); return { settlements, total: settlements.reduce((sum, row) => sum + Number(row.amount || 0), 0), count: settlements.length }; },
    transactionsGetAll: async (opts) => { await ready; return Core.getTransactions(data, opts); },
    exportCsv: async () => { await ready; return saveAndShare("orders-reconciliation.csv", ordersCsv(), "text/csv"); },
    importWalletFile: async () => { const file = await selectFile(".tsv,.csv,.txt"); return file ? importWalletText(await file.text()) : { ok: false, canceled: true }; },
    importOrdersCsv: async () => { const file = await selectFile(".csv"); return file ? importOrdersText(await file.text()) : { ok: false, canceled: true }; },
    exportBackup: async () => { await ready; return saveAndShare(`wallet-profit-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), "application/json"); },
    importBackup: async () => {
      const file = await selectFile(".json");
      if (!file) return { ok: false, canceled: true };
      const parsed = JSON.parse(await file.text());
      if (!Array.isArray(parsed.transactions)) return { ok: false, error: "Invalid wallet backup" };
      await createSafetyBackup();
      data = Core.normalizeData(parsed);
      await persistData();
      return { ok: true, replaced: true, format: "json" };
    },
    cloudGetStatus: () => cloudStatus(),
    cloudSignIn: (email, password) => signIn(email, password),
    cloudSignOut: async () => { if (session?.access_token) await supabaseRequest("/auth/v1/logout", { method: "POST" }).catch(() => {}); session = null; cloudMeta = { revision: 0, lastHash: null, userId: null }; writeJson(AUTH_KEY, null); persistCloudMeta(); if (autoSyncTimer) clearInterval(autoSyncTimer); autoSyncTimer = null; return { ok: true, signed_in: false, revision: 0 }; },
    cloudSync: () => syncCloud(),
    cloudPull: () => pullSnapshot(),
    cloudReplace: () => replaceCloud(),
    walletGetConfig: async () => { await ready; return data.walletConfig; },
    walletSaveConfig: (config) => mutate(() => { try { data.walletConfig = { ...data.walletConfig, ...config, baseUrl: validatedBaseUrl(config.baseUrl), storeId: String(config.storeId || "").trim(), wallet: String(config.wallet || "main").trim() || "main", token: String(config.token || "").trim(), usdToLbpRate: Number(config.usdToLbpRate || 90000), displayCurrency: String(config.displayCurrency || "USD").toUpperCase() }; return { ok: true }; } catch (error) { return { ok: false, error: String(error.message || error) }; } }),
    walletSync: () => syncWallet().catch((error) => ({ ok: false, error: String(error.message || error) })),
    walletGetSyncStatus: async () => { await ready; const config = data.walletConfig || {}; return { ok: true, checkpoint: getConfigValue(`walletSyncCheckpoint:${config.storeId}:${config.wallet || "main"}`) || { status: "idle", next_page: 1, last_completed_page: 1 } }; },
    walletResetSync: () => mutate(() => { removeConfigPrefix("walletSyncCheckpoint:"); return { ok: true, checkpoint: { status: "idle", next_page: 1, last_completed_page: 1 } }; }),
    walletGetRemainingBalance: () => remainingBalance().catch((error) => ({ ok: false, error: String(error.message || error) })),
    openOrder,
    openProducts: () => navigate("products.html"),
    openImport: () => navigate("import.html"),
    productsGet: async () => { await ready; return getProducts(); },
    productsImport: (rows) => importProductsRows(rows),
    productsImportExcel: () => importProductsFile().catch((error) => ({ ok: false, error: String(error.message || error) })),
    productsUpdate: (barcode, updates) => mutate(() => { const product = data.products.find((item) => String(item.barcode) === String(barcode)); if (!product) return { ok: false, error: "Product not found" }; const previousPrice = Number(product.unit_price_usd || 0); const previousCost = Number(product.cost_usd || 0); Object.assign(product, updates, { unit_price_usd: Number(updates.unit_price_usd ?? product.unit_price_usd ?? 0), cost_usd: Number(updates.cost_usd ?? product.cost_usd ?? 0), stock_quantity: Number(updates.stock_quantity ?? product.stock_quantity ?? 0), updated_at: new Date().toISOString() }); if (previousPrice !== product.unit_price_usd || previousCost !== product.cost_usd) data.product_price_history.push({ id: Core.nextId(data.product_price_history), product_id: product.id, barcode: product.barcode, unit_price_usd: product.unit_price_usd, cost_usd: product.cost_usd, effective_at: new Date().toISOString() }); return { ok: true }; }),
    productsExportExcel: async () => { await ready; return exportExcel("products.xlsx", getProducts()); },
    catalogGetProducts: (opts) => catalogGetProducts(opts),
    catalogGetProductByBarcode: async (barcode) => {
      const key = String(barcode || "").trim();
      if (!key) return { ok: true, product: null };
      try {
        const rows = await supabaseRequest(`/rest/v1/products?select=${encodeURIComponent(CATALOG_SELECT)}&barcode=eq.${encodeURIComponent(key)}&limit=1`);
        return { ok: true, product: rows?.[0] || null };
      } catch (error) {
        const product = (await catalogCachedProducts()).find((item) => String(item.barcode) === key) || null;
        return product ? { ok: true, product, source: "cache", warning: String(error.message || error) } : { ok: false, error: String(error.message || error) };
      }
    },
    catalogGetMappings: async () => {
      try {
        const mappings = await supabaseRequest("/rest/v1/merchant_supplier_mapping?select=merchant_code,supplier_key,supplier_name,updated_at&order=merchant_code.asc");
        return { ok: true, mappings, source: "supabase" };
      } catch (error) {
        return { ok: false, error: String(error.message || error), mappings: [] };
      }
    },
    catalogRefreshCache: async () => {
      const result = await catalogGetProducts({ includeArchived: true });
      return result.source === "supabase" ? { ok: true, products: result.products.length, refreshed_at: new Date().toISOString() } : { ok: false, error: result.warning };
    },
    catalogRetryOrderItems: async () => ({ ok: false, error: "Retry product matching is available on the desktop app after syncing orders." }),
    catalogGetBackfillPreview: async () => ({ ok: false, error: "Historical backfill is available on the desktop app." }),
    catalogBackfillMissingData: async () => ({ ok: false, error: "Historical backfill is available on the desktop app." }),
    catalogCreateProduct: (payload) => catalogMutate("POST", `/rest/v1/products?select=${encodeURIComponent(CATALOG_SELECT)}`, payload || {}),
    catalogUpdateProduct: (id, updates) => catalogMutate("PATCH", `/rest/v1/products?id=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(CATALOG_SELECT)}`, updates || {}),
    catalogArchiveProduct: (id) => catalogMutate("PATCH", `/rest/v1/products?id=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(CATALOG_SELECT)}`, { is_archived: true }),
    catalogRestoreProduct: (id) => catalogMutate("PATCH", `/rest/v1/products?id=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(CATALOG_SELECT)}`, { is_archived: false }),
    catalogSetStock: (id, inStock) => catalogMutate("PATCH", `/rest/v1/products?id=eq.${encodeURIComponent(id)}&select=${encodeURIComponent(CATALOG_SELECT)}`, { is_available: !!inStock, stock_status: inStock ? "in_stock" : "out_of_stock" }),
    salesReport: async (opts) => { await ready; return Core.salesReport(data, opts); },
    salesRevenueByPeriod: async (opts) => { await ready; return Core.salesRevenueByPeriod(data, opts); },
    walletRevenueByPeriod: async (opts) => { await ready; return Core.walletRevenueByPeriod(data, opts); },
    salesTopProductsByRevenue: async (opts) => { await ready; return Core.salesReport(data, opts).sort((a, b) => b.revenue - a.revenue).slice(0, Number(opts?.limit || 10)); },
    salesTopProductsByProfit: async (opts) => { await ready; return Core.salesReport(data, opts).sort((a, b) => b.profit - a.profit).slice(0, Number(opts?.limit || 10)); },
    salesProfitMarginAnalysis: async (opts) => { await ready; return Core.salesReport(data, opts).map((row) => ({ ...row, profit_margin_percent: row.profit == null ? null : row.revenue ? row.profit / row.revenue * 100 : 0 })).sort((a, b) => Number(b.profit_margin_percent || 0) - Number(a.profit_margin_percent || 0)).slice(0, Number(opts?.limit || 20)); },
    salesExportExcel: async (opts) => { await ready; return exportExcel("sales-report.xlsx", Core.salesReport(data, opts)); },
    salesSyncFromOrders: async () => ({ ok: false, error: "Toters order-detail synchronization is managed by the desktop app. Sync shared cloud data on mobile to receive the results.", checkpoint: getConfigValue("ordersSyncCheckpoint:") || { status: "idle" } }),
    salesGetOrderSyncStatus: async () => { await ready; return { ok: true, checkpoint: getConfigValue("ordersSyncCheckpoint:") || { status: "idle", next_page: 1, last_completed_page: 1 } }; },
    salesResetOrderSync: () => mutate(() => { removeConfigPrefix("ordersSyncCheckpoint:"); return { ok: true, checkpoint: { status: "idle", next_page: 1, last_completed_page: 1 } }; }),
    openRevenueDashboard: () => navigate("revenueDashboard.html"),
    openDbAdmin: () => navigate("dbAdmin.html"),
    dbListTables: async () => { await ready; return ["transactions", "suppliers", "order_meta", "order_line_meta", "products", "sales", "product_price_history", "company_expenses", "config"]; },
    dbGetTable: async (table, limit) => { await ready; return Array.isArray(data[table]) ? data[table].slice(0, Math.max(1, Number(limit || 200))) : []; },
    dbClearTable: (table) => mutate(() => { if (!Array.isArray(data[table])) return { ok: false, error: "Unknown table" }; data[table] = []; return { ok: true }; }),
  };

  window.api = api;
  window.orderApi = {
    onOrderData(callback) {
      ready.then(() => {
        const payload = readJsonFromSession("walletProfitMobileOrder");
        if (payload && typeof callback === "function") callback(payload);
      });
    },
    async openWhatsAppBill(bill) {
      const text = billText(bill);
      const phone = String(bill?.supplier_phone || "").replace(/\D/g, "");
      const url = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
      const browser = window.Capacitor?.Plugins?.Browser;
      if (browser) await browser.open({ url });
      else location.href = url;
      return { ok: true };
    },
    exportBillExcel: (bill) => exportExcel(`supplier-bill-${bill.order_code}-${bill.supplier_name || "supplier"}.xlsx`, bill.lines || []),
    exportBillWord: (bill) => saveAndShare(`supplier-bill-${bill.order_code}-${bill.supplier_name || "supplier"}.html`, `<html><body><pre>${billText(bill).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre></body></html>`, "text/html"),
  };

  document.addEventListener("DOMContentLoaded", () => {
    document.body.classList.add("mobile-app");
    const page = location.pathname.split("/").pop() || "index.html";
    if (page !== "index.html") {
      document.body.classList.add("mobile-secondary-page");
      const back = document.createElement("button");
      back.className = "mobile-back";
      back.type = "button";
      back.textContent = "‹ Back";
      back.setAttribute("aria-label", "Back to previous screen");
      back.addEventListener("click", () => {
        if (history.length > 1) history.back();
        else location.href = "index.html";
      });
      document.body.appendChild(back);
    }
  });

  function readJsonFromSession(key) {
    try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch { return null; }
  }

  ready.then(() => {
    ensureAutomaticSync();
  });

  function ensureAutomaticSync() {
    if (!session?.access_token || autoSyncTimer) return;
    setTimeout(() => automaticSync(), 2500);
    autoSyncTimer = setInterval(() => automaticSync(), SYNC_INTERVAL_MS);
  }

  async function automaticSync() {
    if (autoSyncBusy || !session?.access_token || !cloudMeta.revision) return;
    autoSyncBusy = true;
    try {
      const result = await syncCloud();
      if (result?.action === "downloaded") location.reload();
    } catch {
      // Offline mode remains available; retry later.
    } finally {
      autoSyncBusy = false;
    }
  }

  console.info("[Wallet Profit Mobile] cloud bridge ready");
})();
