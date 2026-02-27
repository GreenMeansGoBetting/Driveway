// Supabase integration (cloud backup + cross-device sync)
// Requires config.js to set window.SUPABASE_URL and window.SUPABASE_ANON_KEY
let SB = null;

function supabaseReady() {
  return window.SUPABASE_URL && window.SUPABASE_ANON_KEY &&
         !String(window.SUPABASE_URL).includes("PASTE_") &&
         !String(window.SUPABASE_ANON_KEY).includes("PASTE_");
}

function sb() {
  if (!SB) {
    if (!supabaseReady()) throw new Error("Supabase config missing");
    SB = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
  }
  return SB;
}

async function sbGetSession() {
  try {
    const { data } = await sb().auth.getSession();
    return data.session || null;
  } catch {
    return null;
  }
}

async function sbSignIn(email, password) {
  const { data, error } = await sb().auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.session;
}

async function sbSignUp(email, password) {
  const { data, error } = await sb().auth.signUp({ email, password });
  if (error) throw error;
  return data.session;
}

async function sbSignOut() {
  try { await sb().auth.signOut(); } catch {}
}

/* =========================================================
   AUTO-SYNC (debounced)
========================================================= */
let AUTO_SYNC_TIMER = null;

function autoSyncEnabled() {
  return window.AUTO_SYNC_ENABLED !== false;
}

function scheduleAutoSync(delay = 400) {
  if (!autoSyncEnabled()) return;
  clearTimeout(AUTO_SYNC_TIMER);
  AUTO_SYNC_TIMER = setTimeout(async () => {
    try {
      await sbSyncUp();
    } catch (e) {
      console.warn("Auto-sync failed:", e);
    }
  }, delay);
}

// Sync-down: pulls all rows for this user and overwrites local DB.
async function sbSyncDown() {
  const session = await sbGetSession();
  if (!session) throw new Error("Not signed in");
  const owner_id = session.user.id;

  const fetchAll = async (table) => {
    const { data, error } = await sb().from(table).select("*").eq("owner_id", owner_id);
    if (error) throw error;
    return data || [];
  };

  const [players, seasons, games, events] = await Promise.all([
    fetchAll("players"),
    fetchAll("seasons"),
    fetchAll("games"),
    fetchAll("events"),
  ]);

  await DB.clearPlayers();
  await DB.clearSeasons();
  await DB.clearGames();
  await DB.clearEvents();

  for (const p of players) await DB.putPlayer(p);
  for (const s of seasons) await DB.putSeason(s);
  for (const g of games) await DB.putGame(g);
  for (const e of events) await DB.putEvent(e);

  const current = seasons.find(x => !x.archived) || null;
  if (current) await DB.setSetting("current_season_id", current.season_id);

  return { players: players.length, seasons: seasons.length, games: games.length, events: events.length };
}

// Sync-up: pushes queued ops from outbox
async function sbSyncUp() {
  if (!supabaseReady()) return { pushed: 0, remaining: 0, note: "Supabase not configured" };

  const session = await sbGetSession();
  const opsAll = await DB.listOps();

  if (!session) return { pushed: 0, remaining: opsAll.length, note: "Not signed in" };

  const owner_id = session.user.id;
  const ops = opsAll;
  let pushed = 0;

  for (const op of ops) {
    const { kind, payload } = op;

    try {
      if (kind === "upsert_player") {
        const { error } = await sb().from("players").upsert({ ...payload, owner_id });
        if (error) throw error;

      } else if (kind === "upsert_season") {
        const { error } = await sb().from("seasons").upsert({ ...payload, owner_id });
        if (error) throw error;

      } else if (kind === "upsert_game") {
        const { error } = await sb().from("games").upsert({ ...payload, owner_id });
        if (error) throw error;

      } else if (kind === "upsert_event") {
        const { error } = await sb().from("events").upsert({ ...payload, owner_id });
        if (error) throw error;

      } else if (kind === "delete_game") {
        // delete game + events
        {
          const { error: e1 } = await sb().from("events")
            .delete()
            .eq("owner_id", owner_id)
            .eq("game_id", payload.game_id);
          if (e1) throw e1;
        }
        {
          const { error: e2 } = await sb().from("games")
            .delete()
            .eq("owner_id", owner_id)
            .eq("game_id", payload.game_id);
          if (e2) throw e2;
        }

      } else if (kind === "delete_event") {
        const { error } = await sb().from("events")
          .delete()
          .eq("owner_id", owner_id)
          .eq("event_id", payload.event_id);
        if (error) throw error;

      } else if (kind === "upsert_bulk_finalize") {
        // used after finalize: upsert game + all events for the game
        {
          const { error: gErr } = await sb().from("games").upsert({ ...payload.game, owner_id });
          if (gErr) throw gErr;
        }
        if (payload.events && payload.events.length) {
          const rows = payload.events.map(e => ({ ...e, owner_id }));
          const { error: evErr } = await sb().from("events").upsert(rows);
          if (evErr) throw evErr;
        }

      } else if (kind === "set_active_game") {
        // Stream overlay looks here to know which game to display
        const { error } = await sb().from("stream_state").upsert({
          id: "main",
          owner_id,
          active_game_id: payload.game_id,
          updated_at: new Date().toISOString()
        });
        if (error) throw error;

      } else if (kind === "clear_active_game") {
        // Clears overlay when game finalized/ended
        const { error } = await sb().from("stream_state").upsert({
          id: "main",
          owner_id,
          active_game_id: null,
          updated_at: new Date().toISOString()
        });
        if (error) throw error;
      }

      await DB.deleteOp(op.op_id);
      pushed += 1;

    } catch (e) {
      return {
        pushed,
        remaining: ops.length - pushed,
        error: (e && e.message) ? e.message : String(e)
      };
    }
  }

  return { pushed, remaining: 0 };
}

async function sbHealth() {
  const configured = supabaseReady();
  const session = configured ? await sbGetSession() : null;
  const ops = await DB.listOps();
  return {
    configured,
    signed_in: !!session,
    email: session?.user?.email || null,
    pending_ops: ops.length
  };
}
