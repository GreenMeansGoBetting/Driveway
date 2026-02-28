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
  } catch { return null; }
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

  // overwrite local
  await DB.clearPlayers();
  await DB.clearSeasons();
  await DB.clearGames();
  await DB.clearEvents();

  for (const p of players) await DB.putPlayer(p);
  for (const s of seasons) await DB.putSeason(s);
  for (const g of games) await DB.putGame(g);
  for (const e of events) await DB.putEvent(e);

  // set current season if exists
  const current = seasons.find(x => !x.archived) || null;
  if (current) await DB.setSetting("current_season_id", current.season_id);

  return { players: players.length, seasons: seasons.length, games: games.length, events: events.length };
}

// Sync-up: pushes queued ops from outbox
async function sbSyncUp() {
  if (!supabaseReady()) return { pushed: 0, remaining: 0, note: "Supabase not configured" };
  const session = await sbGetSession();
  if (!session) return { pushed: 0, remaining: (await DB.listOps()).length, note: "Not signed in" };
  const owner_id = session.user.id;

  const ops = await DB.listOps();
  let pushed = 0;

  for (const op of ops) {
    const { kind, payload } = op;
    try {
      if (kind === "upsert_player") {
        await sb().from("players").upsert({ ...payload, owner_id });
      } else if (kind === "upsert_season") {
        await sb().from("seasons").upsert({ ...payload, owner_id });
      } else if (kind === "upsert_game") {
        await sb().from("games").upsert({ ...payload, owner_id });
      } else if (kind === "upsert_event") {
        await sb().from("events").upsert({ ...payload, owner_id });
      } else if (kind === "delete_game") {
        // delete game + events
        await sb().from("events").delete().eq("owner_id", owner_id).eq("game_id", payload.game_id);
        await sb().from("games").delete().eq("owner_id", owner_id).eq("game_id", payload.game_id);
      } else if (kind === "delete_event") {
        await sb().from("events").delete().eq("owner_id", owner_id).eq("event_id", payload.event_id);
      } else if (kind === "upsert_bulk_finalize") {
        // used after finalize: upsert game + all events for the game
        await sb().from("games").upsert({ ...payload.game, owner_id });
        if (payload.events && payload.events.length) {
          const rows = payload.events.map(e => ({ ...e, owner_id }));
          await sb().from("events").upsert(rows);
        }
      }

      await DB.deleteOp(op.op_id);
      pushed += 1;
    } catch (e) {
      // stop on first error to avoid burning requests
      return { pushed, remaining: ops.length - pushed, error: (e && e.message) ? e.message : String(e) };
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


async function sbFetchAllEvents(){
  const h = await sbHealth();
  if(!h.configured || !h.signed_in) throw new Error("Not signed in");
  const uid = (await sb().auth.getUser()).data.user.id;
  const { data, error } = await sb().from("events").select("*").eq("owner_id", uid).order("timestamp", {ascending:true});
  if(error) throw error;
  return data || [];
}
async function sbFetchPlayers(){
  const h = await sbHealth();
  if(!h.configured || !h.signed_in) throw new Error("Not signed in");
  const uid = (await sb().auth.getUser()).data.user.id;
  const { data, error } = await sb().from("players").select("*").eq("owner_id", uid);
  if(error) throw error;
  return data || [];
}
async function sbFetchGames(){
  const h = await sbHealth();
  if(!h.configured || !h.signed_in) throw new Error("Not signed in");
  const uid = (await sb().auth.getUser()).data.user.id;
  const { data, error } = await sb().from("games").select("*").eq("owner_id", uid);
  if(error) throw error;
  return data || [];
}
async function sbFetchSeasons(){
  const h = await sbHealth();
  if(!h.configured || !h.signed_in) throw new Error("Not signed in");
  const uid = (await sb().auth.getUser()).data.user.id;
  const { data, error } = await sb().from("seasons").select("*").eq("owner_id", uid);
  if(error) throw error;
  return data || [];
}
async function sbUpsertPlayers(players){
  const h = await sbHealth();
  if(!h.configured || !h.signed_in) throw new Error("Not signed in");
  const uid = (await sb().auth.getUser()).data.user.id;
  const payload = (players||[]).map(p=>({ ...p, owner_id: uid }));
  const { error } = await sb().from("players").upsert(payload);
  if(error) throw error;
}
async function sbUpsertSeason(season){
  const h = await sbHealth();
  if(!h.configured || !h.signed_in) throw new Error("Not signed in");
  const uid = (await sb().auth.getUser()).data.user.id;
  const { error } = await sb().from("seasons").upsert({ ...season, owner_id: uid });
  if(error) throw error;
}
async function sbUpsertGame(game){
  const h = await sbHealth();
  if(!h.configured || !h.signed_in) throw new Error("Not signed in");
  const uid = (await sb().auth.getUser()).data.user.id;
  const { error } = await sb().from("games").upsert({ ...game, owner_id: uid });
  if(error) throw error;
}
// expose
window.sbFetchAllEvents = sbFetchAllEvents;
window.sbFetchPlayers = sbFetchPlayers;
window.sbFetchGames = sbFetchGames;
window.sbFetchSeasons = sbFetchSeasons;
window.sbUpsertPlayers = sbUpsertPlayers;
window.sbUpsertSeason = sbUpsertSeason;
window.sbUpsertGame = sbUpsertGame;
