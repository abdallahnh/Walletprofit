const orderSyncState = require("../db/orderSyncState");
const orderService = require("./orderService");

function emptyStats(startPage) {
  return {
    startPage,
    lastPage: startPage,
    pagesFetched: 0,
    fetched: 0,
    skippedInvalidSummaries: 0,
    skippedAlreadyCompleted: 0,
    stoppedAtWatermark: false,
    processed: 0,
    detailsLoaded: 0,
    detailsMissing: 0,
    detailsFailed: 0,
    ordersWithMatchedItems: 0,
    ordersWithoutMatchedItems: 0,
    totalOrderItems: 0,
    matchedOrderItems: 0,
    skippedNoBarcodeItems: 0,
    skippedUnmatchedProductItems: 0,
  };
}

function addSyncStats(stats, sync) {
  if (!sync) return;
  stats.totalOrderItems += Number(sync.total_items || 0);
  stats.matchedOrderItems += Number(sync.matched_items || 0);
  stats.skippedNoBarcodeItems += Number(sync.skipped_no_barcode || 0);
  stats.skippedUnmatchedProductItems += Number(sync.skipped_unmatched_product || 0);
  if (Number(sync.inserted_rows || 0) > 0) stats.ordersWithMatchedItems += 1;
  else stats.ordersWithoutMatchedItems += 1;
}

async function runCheckpointedOrderSync(storeId, dependencies = {}) {
  const stateStore = dependencies.stateStore || orderSyncState;
  const fetchPage = dependencies.fetchPage || orderService.syncOrdersPage;
  const loadDetails = dependencies.loadDetails || orderService.loadDetailsByCode;

  let state = stateStore.begin(storeId);
  const stats = emptyStats(state.next_page);

  for (let guard = 0; guard < 500; guard += 1) {
    const page = state.next_page;
    stats.lastPage = page;
    let pageResult;
    try {
      pageResult = await fetchPage(storeId, page);
    } catch (error) {
      state = stateStore.markFailed(storeId, error);
      return { ok: false, error: state.last_error, checkpoint: stateStore.toPublicState(state), ...stats };
    }

    stats.pagesFetched += 1;
    stats.fetched += pageResult.orders.length;
    stats.skippedInvalidSummaries += Math.max(0, pageResult.rawCount - pageResult.orders.length);

    const uniqueOrders = [];
    const seen = new Set();
    for (const order of pageResult.orders) {
      const code = String(order?.code || "");
      if (!code || seen.has(code)) continue;
      seen.add(code);
      uniqueOrders.push(order);
    }

    const completed = new Set(state.completed_order_codes);
    for (const order of uniqueOrders) {
      const code = String(order.code);
      if (state.last_synced_head_code && code === state.last_synced_head_code) {
        stats.stoppedAtWatermark = true;
        state = stateStore.markCompleted(storeId, page);
        return { ok: true, checkpoint: stateStore.toPublicState(state), ...stats };
      }
      if (!state.cycle_head_code) state = stateStore.setCycleHead(storeId, code);
      if (completed.has(code)) {
        stats.skippedAlreadyCompleted += 1;
        continue;
      }

      try {
        const detailed = await loadDetails(code);
        stats.processed += 1;
        if (detailed) stats.detailsLoaded += 1;
        else stats.detailsMissing += 1;
        addSyncStats(stats, detailed?._salesSync || null);
        state = stateStore.markOrderCompleted(storeId, page, code);
        completed.add(code);
      } catch (error) {
        stats.detailsFailed += 1;
        state = stateStore.markFailed(storeId, error, code);
        return { ok: false, error: state.last_error, checkpoint: stateStore.toPublicState(state), ...stats };
      }
    }

    if (!pageResult.hasNextPage) {
      state = stateStore.markCompleted(storeId, page);
      return { ok: true, checkpoint: stateStore.toPublicState(state), ...stats };
    }

    state = stateStore.advanceToPage(storeId, page + 1);
  }

  state = stateStore.markFailed(storeId, "Order sync stopped after the 500-page safety limit");
  return { ok: false, error: state.last_error, checkpoint: stateStore.toPublicState(state), ...stats };
}

module.exports = { runCheckpointedOrderSync };
