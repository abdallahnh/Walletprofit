const crypto = require("node:crypto");

const SUPABASE_URL = "https://dcptfccyqctejouoaskw.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_bNWy6tg7qZpJakFbDmXCag_PF5V1ip8";

function snapshotHash(data) {
  const normalized = { ...data };
  delete normalized.exported_at;
  return crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function createSupabaseCloud({ fetchImpl = global.fetch, initialState = {}, onStateChange = () => {} } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required");

  let state = {
    session: initialState.session || null,
    revision: Number(initialState.revision || 0),
    last_snapshot_hash: initialState.last_snapshot_hash || null,
  };

  function publicState() {
    return {
      signed_in: !!state.session?.access_token,
      email: state.session?.user?.email || "",
      user_id: state.session?.user?.id || null,
      revision: state.revision,
      last_snapshot_hash: state.last_snapshot_hash,
    };
  }

  function persist() {
    onStateChange({ ...state });
  }

  async function request(path, { method = "GET", body, prefer, retry = true } = {}) {
    const headers = {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${state.session?.access_token || SUPABASE_PUBLISHABLE_KEY}`,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (prefer) headers.Prefer = prefer;

    const response = await fetchImpl(SUPABASE_URL + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (response.status === 401 && retry && state.session?.refresh_token) {
      await refreshSession();
      return request(path, { method, body, prefer, retry: false });
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!response.ok) {
      const message = payload?.msg || payload?.message || payload?.error_description || payload?.error || text;
      const error = new Error(message || `Supabase request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function signIn(email, password) {
    const response = await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      throw new Error(payload.error_description || payload.msg || payload.message || "Sign in failed");
    }
    state.session = payload;
    state.revision = 0;
    state.last_snapshot_hash = null;
    persist();
    return publicState();
  }

  async function refreshSession() {
    if (!state.session?.refresh_token) throw new Error("Your cloud session expired. Please sign in again.");
    const response = await fetchImpl(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ refresh_token: state.session.refresh_token }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
      state.session = null;
      persist();
      throw new Error("Your cloud session expired. Please sign in again.");
    }
    state.session = payload;
    persist();
    return publicState();
  }

  async function signOut() {
    if (state.session?.access_token) {
      await request("/auth/v1/logout", { method: "POST" }).catch(() => {});
    }
    state = { session: null, revision: 0, last_snapshot_hash: null };
    persist();
    return publicState();
  }

  async function getRemoteSnapshot() {
    if (!state.session?.access_token) throw new Error("Sign in to cloud first.");
    const rows = await request(
      "/rest/v1/wallet_profit_snapshots?id=eq.1&select=revision,data,updated_at,updated_by"
    );
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  async function requestAuthenticated(path, options = {}) {
    if (!state.session?.access_token) throw new Error("Sign in to cloud first.");
    return request(path, options);
  }

  async function pushSnapshot(data, expectedRevision) {
    if (!state.session?.user?.id) throw new Error("Sign in to cloud first.");
    const hash = snapshotHash(data);
    let rows;
    if (!expectedRevision) {
      rows = await request("/rest/v1/wallet_profit_snapshots", {
        method: "POST",
        prefer: "return=representation",
        body: {
          id: 1,
          revision: 1,
          data,
          updated_at: new Date().toISOString(),
          updated_by: state.session.user.id,
        },
      });
    } else {
      rows = await request(
        `/rest/v1/wallet_profit_snapshots?id=eq.1&revision=eq.${Number(expectedRevision)}`,
        {
          method: "PATCH",
          prefer: "return=representation",
          body: {
            revision: Number(expectedRevision) + 1,
            data,
            updated_at: new Date().toISOString(),
            updated_by: state.session.user.id,
          },
        }
      );
    }
    if (!Array.isArray(rows) || rows.length !== 1) {
      const error = new Error("Cloud data changed on another computer. Download it before uploading again.");
      error.code = "CLOUD_CONFLICT";
      throw error;
    }
    state.revision = Number(rows[0].revision);
    state.last_snapshot_hash = hash;
    persist();
    return rows[0];
  }

  function markPulled(snapshot) {
    state.revision = Number(snapshot.revision || 0);
    state.last_snapshot_hash = snapshotHash(snapshot.data);
    persist();
  }

  return {
    getPublicState: publicState,
    signIn,
    signOut,
    refreshSession,
    requestAuthenticated,
    getRemoteSnapshot,
    pushSnapshot,
    markPulled,
    snapshotHash,
  };
}

module.exports = {
  SUPABASE_URL,
  SUPABASE_PUBLISHABLE_KEY,
  createSupabaseCloud,
  snapshotHash,
};
