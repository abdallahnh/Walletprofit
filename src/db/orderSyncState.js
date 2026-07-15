const { getDb } = require("./database");

const KEY_PREFIX = "ordersSyncCheckpoint:";

function keyForStore(storeId) {
  const id = String(storeId || "").trim();
  if (!id) throw new Error("Store ID is required for order sync checkpoint");
  return KEY_PREFIX + id;
}

function defaultState(storeId) {
  return {
    version: 2,
    store_id: String(storeId),
    status: "idle",
    next_page: 1,
    completed_order_codes: [],
    started_at: null,
    updated_at: null,
    last_error: null,
    failed_order_code: null,
    last_completed_at: null,
    last_completed_page: null,
    last_synced_head_code: null,
    cycle_head_code: null,
  };
}

function normalizeState(storeId, value) {
  const fallback = defaultState(storeId);
  if (!value || typeof value !== "object") return fallback;
  const rebuildCompletedV1 = Number(value.version || 1) < 2 && value.status === "completed";
  return {
    ...fallback,
    ...value,
    version: 2,
    store_id: String(storeId),
    status: rebuildCompletedV1 ? "idle" : value.status,
    next_page: rebuildCompletedV1
      ? 1
      : Math.max(1, Math.trunc(Number(value.next_page) || 1)),
    completed_order_codes: !rebuildCompletedV1 && Array.isArray(value.completed_order_codes)
      ? Array.from(new Set(value.completed_order_codes.map(String)))
      : [],
    last_completed_page: rebuildCompletedV1 ? null : value.last_completed_page,
    last_synced_head_code: rebuildCompletedV1 ? null : value.last_synced_head_code,
    cycle_head_code: rebuildCompletedV1 ? null : value.cycle_head_code,
  };
}

function get(storeId) {
  const row = getDb().prepare("SELECT value FROM config WHERE key = ?").get(keyForStore(storeId));
  if (!row?.value) return defaultState(storeId);
  try {
    return normalizeState(storeId, JSON.parse(row.value));
  } catch {
    return defaultState(storeId);
  }
}

function save(storeId, state) {
  const next = normalizeState(storeId, {
    ...state,
    updated_at: new Date().toISOString(),
  });
  getDb().prepare(`
    INSERT INTO config (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(keyForStore(storeId), JSON.stringify(next));
  return next;
}

function begin(storeId) {
  const current = get(storeId);
  const startsNewCycle = current.status === "idle" || current.status === "completed";
  return save(storeId, {
    ...current,
    status: "in_progress",
    next_page: startsNewCycle ? 1 : current.next_page,
    completed_order_codes: startsNewCycle ? [] : current.completed_order_codes,
    started_at: startsNewCycle ? new Date().toISOString() : current.started_at,
    cycle_head_code: startsNewCycle ? null : current.cycle_head_code,
    last_error: null,
    failed_order_code: null,
  });
}

function setCycleHead(storeId, orderCode) {
  const current = get(storeId);
  if (current.cycle_head_code || !orderCode) return current;
  return save(storeId, { ...current, cycle_head_code: String(orderCode) });
}

function markOrderCompleted(storeId, page, orderCode) {
  const current = get(storeId);
  if (current.next_page !== page) {
    throw new Error(`Order sync checkpoint page mismatch: expected ${current.next_page}, got ${page}`);
  }
  return save(storeId, {
    ...current,
    status: "in_progress",
    completed_order_codes: [...current.completed_order_codes, String(orderCode)],
    last_error: null,
    failed_order_code: null,
  });
}

function advanceToPage(storeId, nextPage) {
  const current = get(storeId);
  return save(storeId, {
    ...current,
    status: "in_progress",
    next_page: Math.max(1, Math.trunc(Number(nextPage) || 1)),
    completed_order_codes: [],
    last_error: null,
    failed_order_code: null,
  });
}

function markFailed(storeId, error, orderCode = null) {
  const current = get(storeId);
  return save(storeId, {
    ...current,
    status: "failed",
    last_error: String(error?.message || error || "Order sync failed"),
    failed_order_code: orderCode == null ? null : String(orderCode),
  });
}

function markCompleted(storeId, lastPage) {
  const current = get(storeId);
  const now = new Date().toISOString();
  const completedPage = Math.max(1, Math.trunc(Number(lastPage) || 1));
  return save(storeId, {
    ...current,
    status: "completed",
    next_page: 1,
    completed_order_codes: [],
    last_error: null,
    failed_order_code: null,
    last_completed_at: now,
    // Incremental cycles often stop on page 1 at the saved watermark. Keep the
    // deepest historical page instead of replacing it with this run's last page.
    last_completed_page: Math.max(Number(current.last_completed_page) || 0, completedPage),
    last_synced_head_code: current.cycle_head_code || current.last_synced_head_code,
    cycle_head_code: null,
  });
}

function reset(storeId) {
  getDb().prepare("DELETE FROM config WHERE key = ?").run(keyForStore(storeId));
  return defaultState(storeId);
}

function toPublicState(state) {
  return {
    store_id: state.store_id,
    status: state.status,
    next_page: state.next_page,
    completed_on_page: state.completed_order_codes.length,
    started_at: state.started_at,
    updated_at: state.updated_at,
    last_error: state.last_error,
    failed_order_code: state.failed_order_code,
    last_completed_at: state.last_completed_at,
    last_completed_page: state.last_completed_page,
    last_synced_head_code: state.last_synced_head_code,
  };
}

module.exports = {
  get,
  begin,
  setCycleHead,
  markOrderCompleted,
  advanceToPage,
  markFailed,
  markCompleted,
  reset,
  toPublicState,
};
