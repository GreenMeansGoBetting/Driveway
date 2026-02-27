// IndexedDB wrapper (no external deps)
const DB_NAME = "driveway_stats_db";
const DB_VERSION = 2;

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 15);
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains("players")) {
        const s = db.createObjectStore("players", { keyPath: "player_id" });
        s.createIndex("name", "name", { unique: false });
        s.createIndex("active", "active", { unique: false });
      }

      if (!db.objectStoreNames.contains("seasons")) {
        const s = db.createObjectStore("seasons", { keyPath: "season_id" });
        s.createIndex("archived", "archived", { unique: false });
      }

      if (!db.objectStoreNames.contains("games")) {
        const s = db.createObjectStore("games", { keyPath: "game_id" });
        s.createIndex("season_id", "season_id", { unique: false });
        s.createIndex("played_at", "played_at", { unique: false });
        s.createIndex("finalized", "finalized", { unique: false });
      }

      if (!db.objectStoreNames.contains("events")) {
        const s = db.createObjectStore("events", { keyPath: "event_id" });
        s.createIndex("game_id", "game_id", { unique: false });
        s.createIndex("player_id", "player_id", { unique: false });
        s.createIndex("stat_type", "stat_type", { unique: false });
        s.createIndex("game_time", ["game_id", "timestamp"], { unique: false });
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings", { keyPath: "key" });
      }

      // NEW: outbox queue for cloud sync
      if (!db.objectStoreNames.contains("outbox")) {
        const s = db.createObjectStore("outbox", { keyPath: "op_id" });
        s.createIndex("created_at", "created_at", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = {};
    for (const n of storeNames) stores[n] = t.objectStore(n);

    let result;
    Promise.resolve(fn(stores)).then(r => { result = r; }).catch(reject);

    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

const DB = {
  uuidv4,

  async getSetting(key, fallback=null) {
    return tx(["settings"], "readonly", ({settings}) => new Promise(res => {
      const r = settings.get(key);
      r.onsuccess = () => res(r.result ? r.result.value : fallback);
      r.onerror = () => res(fallback);
    }));
  },

  async setSetting(key, value) {
    return tx(["settings"], "readwrite", ({settings}) => settings.put({key, value}));
  },

  async listPlayers(activeOnly=true) {
    return tx(["players"], "readonly", ({players}) => new Promise(resolve => {
      const out = [];
      const req = players.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out.sort((a,b)=>a.name.localeCompare(b.name)));
        const v = c.value;
        if (!activeOnly || v.active) out.push(v);
        c.continue();
      };
      req.onerror = () => resolve(out);
    }));
  },

  async putPlayer(player) {
    return tx(["players"], "readwrite", ({players}) => players.put(player));
  },

  async clearPlayers() {
    return tx(["players"], "readwrite", ({players}) => players.clear());
  },

  async addPlayer(name) {
    const player = { player_id: uuidv4(), name: name.trim(), created_at: new Date().toISOString(), active: true };
    await DB.putPlayer(player);
    return player;
  },

  async updatePlayer(player) {
    return DB.putPlayer(player);
  },

  async listSeasons(includeArchived=false) {
    return tx(["seasons"], "readonly", ({seasons}) => new Promise(resolve => {
      const out = [];
      const req = seasons.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out.sort((a,b)=>a.name.localeCompare(b.name)));
        const v = c.value;
        if (includeArchived || !v.archived) out.push(v);
        c.continue();
      };
      req.onerror = () => resolve(out);
    }));
  },

  async putSeason(season) {
    return tx(["seasons"], "readwrite", ({seasons}) => seasons.put(season));
  },

  async clearSeasons() {
    return tx(["seasons"], "readwrite", ({seasons}) => seasons.clear());
  },

  async ensureDefaultSeason() {
    const seasonName = "Driveway 2026";
    const seasons = await DB.listSeasons(true);
    const found = seasons.find(s => s.name === seasonName && !s.archived);
    if (found) return found;
    const season = { season_id: uuidv4(), name: seasonName, start_date: new Date().toISOString().slice(0,10), archived: false };
    await DB.putSeason(season);
    return season;
  },

  async putGame(game) {
    return tx(["games"], "readwrite", ({games}) => games.put(game));
  },

  async clearGames() {
    return tx(["games"], "readwrite", ({games}) => games.clear());
  },

  async addGame(season_id, sideA_ids, sideB_ids) {
    const game = {
      game_id: uuidv4(),
      season_id,
      played_at: new Date().toISOString(),
      sideA_player_ids: sideA_ids,
      sideB_player_ids: sideB_ids,
      final_score_a: 0,
      final_score_b: 0,
      winner_side: null,
      finalized: false,
      notes: ""
    };
    await DB.putGame(game);
    return game;
  },

  async deleteGame(game_id) {
    return tx(["games","events"], "readwrite", async ({games, events}) => {
      games.delete(game_id);
      await new Promise(resolve => {
        const idx = events.index("game_id");
        const req = idx.openCursor(IDBKeyRange.only(game_id));
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          c.delete();
          c.continue();
        };
        req.onerror = () => resolve();
      });
    });
  },

  async putEvent(ev) {
    return tx(["events"], "readwrite", ({events}) => events.put(ev));
  },

  async clearEvents() {
    return tx(["events"], "readwrite", ({events}) => events.clear());
  },

  async addEvent(game_id, player_id, stat_type) {
    const ev = { event_id: uuidv4(), game_id, timestamp: new Date().toISOString(), player_id, stat_type, delta: 1 };
    await DB.putEvent(ev);
    return ev;
  },

  async listEventsForGame(game_id) {
    return tx(["events"], "readonly", ({events}) => new Promise(resolve => {
      const out = [];
      const idx = events.index("game_time");
      const range = IDBKeyRange.bound([game_id, ""], [game_id, "\uffff"]);
      const req = idx.openCursor(range);
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out);
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => resolve(out);
    }));
  },

  async deleteEvent(event_id) {
    return tx(["events"], "readwrite", ({events}) => events.delete(event_id));
  },

  async listGamesForSeason(season_id, finalizedOnly=true) {
    return tx(["games"], "readonly", ({games}) => new Promise(resolve => {
      const out = [];
      const idx = games.index("season_id");
      const req = idx.openCursor(IDBKeyRange.only(season_id));
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out.sort((a,b)=>b.played_at.localeCompare(a.played_at)));
        const v = c.value;
        if (!finalizedOnly || v.finalized) out.push(v);
        c.continue();
      };
      req.onerror = () => resolve(out);
    }));
  },

  // Outbox ops

  async listAllFinalizedGames(){
    return tx(["games"], "readonly", ({games}) => new Promise(res=>{
      const out=[];
      const cur = games.openCursor();
      cur.onsuccess = (e)=>{
        const c=e.target.result;
        if(!c) return res(out);
        const v=c.value;
        if(v.finalized===true) out.push(v);
        c.continue();
      };
      cur.onerror = ()=>res(out);
    }));
  },

async enqueueOp(kind, payload) {
  const op = { op_id: uuidv4(), kind, payload, created_at: new Date().toISOString() };
  await tx(["outbox"], "readwrite", ({outbox}) => outbox.put(op));

  // NEW: auto-sync to Supabase after any queued op (debounced)
  // Safe if supabase_client.js isn't loaded: it won't throw.
  if (typeof scheduleAutoSync === "function") scheduleAutoSync();

  return op;
},

  async listOps() {
    return tx(["outbox"], "readonly", ({outbox}) => new Promise(resolve => {
      const out = [];
      const req = outbox.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return resolve(out.sort((a,b)=>a.created_at.localeCompare(b.created_at)));
        out.push(c.value);
        c.continue();
      };
      req.onerror = () => resolve(out);
    }));
  },

  async deleteOp(op_id) {
    return tx(["outbox"], "readwrite", ({outbox}) => outbox.delete(op_id));
  }
};
