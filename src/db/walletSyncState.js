const { getDb } = require("./database");

const KEY_PREFIX = "walletSyncCheckpoint:";

function identity(storeId, walletName) {
  const store = String(storeId || "").trim();
  const wallet = String(walletName || "main").trim() || "main";
  if (!store) throw new Error("Store ID is required for wallet sync checkpoint");
  const key = KEY_PREFIX + encodeURIComponent(store) + ":" + encodeURIComponent(wallet);
  return { store, wallet, key };
}

function defaultState(storeId, walletName) {
  const { store, wallet } = identity(storeId, walletName);
  return {
    version: 1,
    store_id: store,
    wallet,
    status: "idle",
    next_page: 1,
    started_at: null,
    updated_at: null,
    last_error: null,
    last_completed_at: null,
    last_completed_page: null,
    last_synced_head_id: null,
    cycle_head_id: null,
  };
}

function normalizeState(storeId, walletName, value) {
  const fallback = defaultState(storeId, walletName);
  if (!value || typeof value !== "object") return fallback;
  return {
    ...fallback,
    ...value,
    store_id: fallback.store_id,
    wallet: fallback.wallet,
    next_page: Math.max(1, Math.trunc(Number(value.next_page) || 1)),
    last_synced_head_id: value.last_synced_head_id == null ? null : String(value.last_synced_head_id),
    cycle_head_id: value.cycle_head_id == null ? null : String(value.cycle_head_id),
  };
}

function get(storeId, walletName) {
  const { key } = identity(storeId, walletName);
  const row = getDb().prepare("SELECT value FROM config WHERE key = ?").get(key);
  if (!row?.value) return defaultState(storeId, walletName);
  try {
    return normalizeState(storeId, walletName, JSON.parse(row.value));
  } catch {
    return defaultState(storeId, walletName);
  }
}

function save(storeId, walletName, state) {
  const { key } = identity(storeId, walletName);
  const next = normalizeState(storeId, walletName, {
    ...state,
    updated_at: new Date().toISOString(),
  });
  getDb().prepare(
    "INSERT INTO config (key, value) VALUES (?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, JSON.stringify(next));
  return next;
}

function begin(storeId, walletName) {
  const current = get(storeId, walletName);
  const startsNewCycle = current.status === "idle" || current.status === "completed";
  return save(storeId, walletName, {
    ...current,
    status: "in_progress",
    next_page: startsNewCycle ? 1 : current.next_page,
    started_at: startsNewCycle ? new Date().toISOString() : current.started_at,
    cycle_head_id: startsNewCycle ? null : current.cycle_head_id,
    last_error: null,
  });
}

function setCycleHead(storeId, walletName, transactionId) {
  const current = get(storeId, walletName);
  if (current.cycle_head_id || transactionId == null) return current;
  return save(storeId, walletName, { ...current, cycle_head_id: String(transactionId) });
}

function advanceToPage(storeId, walletName, nextPage) {
  const current = get(storeId, walletName);
  return save(storeId, walletName, {
    ...current,
    status: "in_progress",
    next_page: Math.max(1, Math.trunc(Number(nextPage) || 1)),
    last_error: null,
  });
}

function markFailed(storeId, walletName, error) {
  const current = get(storeId, walletName);
  return save(storeId, walletName, {
    ...current,
    status: "failed",
    last_error: String(error?.message || error || "Wallet sync failed"),
  });
}

function markCompleted(storeId, walletName, lastPage) {
  const current = get(storeId, walletName);
  return save(storeId, walletName, {
    ...current,
    status: "completed",
    next_page: 1,
    last_error: null,
    last_completed_at: new Date().toISOString(),
    last_completed_page: Math.max(1, Math.trunc(Number(lastPage) || 1)),
    last_synced_head_id: current.cycle_head_id || current.last_synced_head_id,
    cycle_head_id: null,
  });
}

function reset(storeId, walletName) {
  const { key } = identity(storeId, walletName);
  getDb().prepare("DELETE FROM config WHERE key = ?").run(key);
  return defaultState(storeId, walletName);
}

function toPublicState(state) {
  return {
    store_id: state.store_id,
    wallet: state.wallet,
    status: state.status,
    next_page: state.next_page,
    started_at: state.started_at,
    updated_at: state.updated_at,
    last_error: state.last_error,
    last_completed_at: state.last_completed_at,
    last_completed_page: state.last_completed_page,
    last_synced_head_id: state.last_synced_head_id,
  };
}

module.exports = {
  get,
  begin,
  setCycleHead,
  advanceToPage,
  markFailed,
  markCompleted,
  reset,
  toPublicState,
};
