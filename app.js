// UI + routing + live stat tracking (with Supabase cloud backup)
let state = { route:"home", season:null, players:[], currentGame:null };

// --- In-progress game persistence (local + optional cloud) ---
let LIVE_SYNC_TIMER = null;
let LIVE_SYNC_INFLIGHT = false;

async function hydrateOpenGame(){
  try{
    // If we already have one, keep it
    if(state.currentGame && state.currentGame.finalized===false){
      localStorage.setItem("open_game_id", state.currentGame.game_id);
      return state.currentGame;
    }
    const openId = localStorage.getItem("open_game_id");
    if(openId){
      const g = await DB.getGame(openId);
      if(g && g.finalized===false){
        // Only restore if it belongs to the current season (when one is selected)
        if(!state.season || g.season_id === state.season.season_id){
          state.currentGame = g;
          return g;
        }
      } else {
        localStorage.removeItem("open_game_id");
      }
    }
    // If none stored, see if there is any unfinished game in the current season
    if(state.season){
      const gs = await DB.listGamesForSeason(state.season.season_id, false);
      const open = gs.find(x=>x.finalized===false);
      if(open){
        state.currentGame = open;
        localStorage.setItem("open_game_id", open.game_id);
        return open;
      }
    }
  }catch(e){
    // ignore
  }
  return null;
}

async function scheduleLiveCloudSync(){
  // Debounced sync-up only (fast), to keep cloud safer mid-game
  if(LIVE_SYNC_TIMER) return;
  LIVE_SYNC_TIMER = setTimeout(async()=>{
    LIVE_SYNC_TIMER = null;
    if(LIVE_SYNC_INFLIGHT) return;
    try{
      const h = await sbHealth();
      if(!h.configured || !h.signed_in) return;
      const live = await DB.getSetting("live_autosync", true);
      if(!live) return;
      LIVE_SYNC_INFLIGHT = true;
      await sbSyncUp();
      await DB.setSetting("last_sync_at", new Date().toISOString());
    }catch(e){
      // ignore; user can always manual Sync
    }finally{
      LIVE_SYNC_INFLIGHT = false;
    }
  }, 1200);
}


function $(sel){ return document.querySelector(sel); }
function el(tag, attrs={}, children=[]){
  const n=document.createElement(tag);
  for(const [k,v] of Object.entries(attrs)){
    if(k==="class") n.className=v;
    else if(k==="html") n.innerHTML=v;
    else if(k.startsWith("on") && typeof v==="function") n.addEventListener(k.slice(2), v);
    else n.setAttribute(k,v);
  }
  for(const c of children) n.appendChild(c);
  return n;
}

function setRoute(r){
  state.route=r;
  document.body.classList.toggle("route-live", r==="live");
  const bm=document.getElementById("btnMenu");
  if(bm) bm.style.display = (r==="live") ? "" : "none";
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active", b.dataset.route===r));
  render();
}

function openMenu(){
  const open = state.openGame && state.openGame.finalized===false;
  const items = [
    {r:"home", label:"Home"},
    {r:"start", label:"Start Game"},
    {r:"players", label:"Players"},
    {r:"dashboard", label:"Dashboard"},
    {r:"leaderboard", label:"Leaderboard"},
    {r:"awards", label:"Awards"},
    {r:"records", label:"Records"},
    {r:"draft", label:"Draft"},
  ];
  let body = '<div class="p" style="margin:0;">';
  for(const it of items){
    body += `<button class="btn ghost" style="width:100%; justify-content:flex-start; margin-top:8px;" onclick="window.__goRoute('${it.r}')">${it.label}</button>`;
  }
  body += '</div>';
  showModal(open ? "Menu (game in progress)" : "Menu", body, [{label:"Close", kind:"ghost"}]);
}

function showModal(title, bodyHtml, actions){
  $("#modalBackdrop").hidden=false;
  $("#modal").hidden=false;
  const m=$("#modal"); m.innerHTML="";
  m.appendChild(el("div",{class:"h2", html:title}));
  m.appendChild(el("div",{class:"p", html:bodyHtml}));
  const row=el("div",{class:"row", style:"justify-content:flex-end; margin-top:12px; gap:10px;"});
  for(const a of actions){
    row.appendChild(el("button",{class:`btn ${a.kind||"ghost"}`, html:a.label, onclick:()=>{ hideModal(); a.onClick && a.onClick(); }}));
  }
  m.appendChild(row);
  $("#modalBackdrop").onclick=hideModal;
}
function hideModal(){ $("#modalBackdrop").hidden=true; $("#modal").hidden=true; }

function computeFromEvents(game, events){
  const statTypes=["2PM","2PMISS","3PM","3PMISS","AST","OREB","DREB","BLK","STL"];
  const lines=new Map();
  for(const pid of [...game.sideA_player_ids, ...game.sideB_player_ids]){
    const o={}; for(const s of statTypes) o[s]=0; lines.set(pid,o);
  }
  for(const ev of events){
    const line=lines.get(ev.player_id); if(!line) continue;
    line[ev.stat_type]=(line[ev.stat_type]||0)+(ev.delta||1);
  }
  const derived=(pid)=>{
    const l=lines.get(pid);
    const twoA=l["2PM"]+l["2PMISS"];
    const threeA=l["3PM"]+l["3PMISS"];
    const pts=l["2PM"]*2 + l["3PM"]*3;
    const reb=l["OREB"]+l["DREB"];
    return {twoA, threeA, pts, reb};
  };
  const scoreA=game.sideA_player_ids.reduce((s,p)=>s+derived(p).pts,0);
  const scoreB=game.sideB_player_ids.reduce((s,p)=>s+derived(p).pts,0);
  const lead=Math.abs(scoreA-scoreB);
  const canFinalize=(Math.max(scoreA,scoreB)>=40)&&(lead>=3);
  const winner_side=scoreA>scoreB?"A":"B";
  return {lines, derived, scoreA, scoreB, lead, canFinalize, winner_side};
}

async function refreshPlayers(){ state.players=await DB.listPlayers(true); }

async function ensureSeason(){
  // prefer stored season id
  const sid = await DB.getSetting("current_season_id", null);
  if (sid) {
    const seasons = await DB.listSeasons(true);
    const found = seasons.find(s => s.season_id === sid);
    if (found) return found;
  }
  const s = await DB.ensureDefaultSeason();
  await DB.setSetting("current_season_id", s.season_id);
  return s;
}

async function updateHeaderSeason(){
  state.season = await ensureSeason();
  $("#seasonSub").textContent = `Season: ${state.season.name}`;
}

async function init(){
  document.querySelectorAll(".nav-btn").forEach(b=>b.addEventListener("click", ()=>setRoute(b.dataset.route)));

  $("#btnExportQuick").addEventListener("click", async()=>{ if(state.season) await exportSeason(state.season); });

  $("#btnSync").addEventListener("click", async()=>{
    try{
      const health = await sbHealth();
      if (!health.configured) {
        showModal("Cloud not configured",
          "Paste your Supabase URL + anon key into <b>config.js</b> (see README).",
          [{label:"OK", kind:"ghost"}]
        );
        return;
      }
      if (!health.signed_in) {
        setRoute("login");
        return;
      }
      showModal("Syncing…", "Pushing pending changes to cloud, then refreshing from cloud.", []);
      const up = await sbSyncUp();
      const down = await sbSyncDown();
      await DB.setSetting("last_sync_at", new Date().toISOString());
      hideModal();
      await updateHeaderSeason();
      render();
      showModal("Sync complete", `Pushed: <b>${up.pushed}</b><br/>Cloud rows pulled: players ${down.players}, seasons ${down.seasons}, games ${down.games}, events ${down.events}`, [{label:"OK", kind:"ghost"}]);
    } catch(e){
      hideModal();
      showModal("Sync error", (e && e.message) ? e.message : String(e), [{label:"OK", kind:"ghost"}]);
    }
  });

  
  $("#btnResume").addEventListener("click", ()=>setRoute("live"));
  $("#btnMenu").addEventListener("click", ()=>openMenu());

  $("#btnSignOut").addEventListener("click", async()=>{
    try{
      await sbSignOut();
      await DB.setSetting("last_sync_at", null);
      setRoute("home");
      render();
    } catch(e){
      showModal("Sign out error", (e && e.message) ? e.message : String(e), [{label:"OK", kind:"ghost"}]);
    }
  });

$("#btnSettings").addEventListener("click", async()=>{
    const autoExport=await DB.getSetting("auto_export_finalize", false);
    const autoSync=await DB.getSetting("auto_sync_finalize", true);
    const last = await DB.getSetting("last_sync_at", null);
    const lastTxt = last ? new Date(last).toLocaleString() : "—";

    const h = await sbHealth();
    const signedIn = h.configured && h.signed_in;

    showModal("Settings",
      `<div class="row" style="justify-content:space-between; align-items:flex-start;">
        <div>
          <b>Auto-export after finalize</b><br/>
          <span class="muted">If enabled, finalize will download game files (optional).</span>
        </div>
        <label class="switch">
          <input type="checkbox" id="toggleAutoExport" ${autoExport?"checked":""}/>
          <span class="slider"></span>
        </label>
      </div>

      <div class="hr"></div>

      <div class="row" style="justify-content:space-between; align-items:flex-start;">
        <div>
          <b>Auto-sync after finalize</b><br/>
          <span class="muted">Finalize will automatically push changes to the cloud.</span>
        </div>
        <label class="switch">
          <input type="checkbox" id="toggleAutoSync" ${autoSync?"checked":""}/>
          <span class="slider"></span>
        </label>
      </div>

      <div class="hr"></div>

      <div class="row" style="justify-content:space-between; align-items:center;">
        <div>
          <b>Last sync</b><br/>
          <span class="muted">${lastTxt}</span>
        </div>
        <button class="btn" id="btnSyncNow">Sync now</button>
      </div>

      <div class="hr"></div>

      <div class="row" style="justify-content:space-between; align-items:center;">
        <div>
          <b>Backup</b><br/>
          <span class="muted">Download a full season JSON snapshot (players + games + events).</span>
        </div>
        <button class="btn" id="btnBackupSeason">Download backup</button>
      </div>

      <div class="hr"></div>

      <div class="row" style="justify-content:space-between; align-items:center;">
        <div>
          <b>Account</b><br/>
          <span class="muted">${signedIn ? ("Signed in as "+h.email) : "Not signed in"}</span>
        </div>
        <button class="btn danger" id="btnSignOutNow" ${signedIn?"":"disabled"}>Sign out</button>
      </div>
      `,
      [{label:"Close", kind:"ghost"}]
    );

    $("#toggleAutoExport").addEventListener("change", async(e)=>{ await DB.setSetting("auto_export_finalize", e.target.checked); });
    $("#toggleAutoSync").addEventListener("change", async(e)=>{ await DB.setSetting("auto_sync_finalize", e.target.checked); });

    $("#btnSyncNow").addEventListener("click", async()=>{
      hideModal();
      $("#btnSync").click();
    });

    $("#btnBackupSeason").addEventListener("click", async()=>{
      try{
        const season = state.season || await DB.ensureDefaultSeason();
        const players = await DB.listPlayers(false);
        const games = await DB.listGamesForSeason(season.season_id, null);
        const events = [];
        for (const g of games){
          const evs = await DB.listEventsForGame(g.game_id);
          for (const e of evs) events.push(e);
        }
        const payload = { exported_at: new Date().toISOString(), season, players, games, events };
        const blob = new Blob([JSON.stringify(payload,null,2)], {type:"application/json"});
        const a=document.createElement("a");
        a.href=URL.createObjectURL(blob);
        a.download=`driveway_backup_${season.name.replace(/\s+/g,"_")}.json`;
        document.body.appendChild(a); a.click(); a.remove();
      } catch(e){
        showModal("Backup error", (e && e.message) ? e.message : String(e), [{label:"OK", kind:"ghost"}]);
      }
    });

    $("#btnSignOutNow").addEventListener("click", async()=>{
      try{
        await sbSignOut();
        await DB.setSetting("last_sync_at", null);
        hideModal();
        setRoute("home");
        render();
      } catch(e){
        showModal("Sign out error", (e && e.message) ? e.message : String(e), [{label:"OK", kind:"ghost"}]);
      }
    });
  });

  await updateHeaderSeason();

  // If Supabase configured + logged in, sync down once on startup (so laptop/iPad match)
  try{
    const health = await sbHealth();
    if (health.configured && health.signed_in) {
      await sbSyncUp();
      await sbSyncDown();
      await updateHeaderSeason();
    }
  } catch {}

  setRoute("home");
}
init();

async function cloudBar(){
  const h = await sbHealth();
  const last = await DB.getSetting("last_sync_at", null);

  const so = document.getElementById("btnSignOut");
  if (so) so.style.display = (h.configured && h.signed_in) ? "" : "none";

  // restore in-progress game (if any)
  const open = await hydrateOpenGame();
  const br = document.getElementById("btnResume");
  if (br) br.style.display = (open && open.finalized===false) ? "" : "none";

  // mini status near Sync
  const mini = document.getElementById("cloudMini");
  if (mini){
    if (h.configured && h.signed_in){
      const pending = h.pending_ops || 0;
      mini.textContent = pending ? `pending ${pending}` : "";
    } else {
      mini.textContent = "";
    }
  }

  let dotClass = "dot";
  let text = "Local only";
  if (h.configured && h.signed_in) {
    dotClass = (h.pending_ops===0) ? "dot ok" : "dot warn";
    text = `Cloud ✓ (${h.email})`;
  } else if (h.configured && !h.signed_in) {
    dotClass = "dot warn";
    text = "Cloud (not signed in)";
  }

  const bar=el("div",{class:"cloud-bar"});
  bar.appendChild(el("div",{class:dotClass}));
  bar.appendChild(el("div",{class:"p", html:text}));

  // optional tiny last-sync text (kept minimal)
  if (h.configured && h.signed_in && last){
    bar.appendChild(el("div",{class:"mini muted", style:"margin-left:auto;", html:`Last sync: ${new Date(last).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}`}));
  } else {
    bar.appendChild(el("div",{style:"margin-left:auto;"})); // keep layout stable
  }

  return bar;
}

async function render(){
  const app=$("#app"); app.innerHTML="";

  if (state.route === "login") return renderLogin(app);

  app.appendChild(await cloudBar());

  if(state.route==="home") return renderHome(app);
  if(state.route==="players") return renderPlayers(app);
  if(state.route==="start") return renderStart(app);
  if(state.route==="live") return renderLive(app);
  if(state.route==="recap") return renderRecap(app);
  if(state.route==="dashboard") return renderDashboard(app);
  if(state.route==="leaderboard") return renderLeaderboard(app);
  if(state.route==="awards") return renderAwards(app);
  if(state.route==="records") return renderRecords(app);
  if(state.route==="recover") return renderRecover(app);
  if(state.route==="draft") return renderDraft(app);
}

function renderHome(app){
  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:"Home"}));
  c.appendChild(el("div",{class:"p", html:"2v2 driveway stat tracker. Saves locally and (optionally) backs up to Supabase cloud."}));
  const row=el("div",{class:"row"});
  row.appendChild(el("button",{class:"btn ok", html:"Start Game", onclick:()=>setRoute("start")}));
  if(state.currentGame && state.currentGame.finalized===false){
    row.appendChild(el("button",{class:"btn ok", html:"Resume Game", onclick:()=>setRoute("live")}));
  }
  row.appendChild(el("button",{class:"btn ghost", html:"Players", onclick:()=>setRoute("players")}));
  row.appendChild(el("button",{class:"btn ghost", html:"Dashboard", onclick:()=>setRoute("dashboard")}));
  row.appendChild(el("button",{class:"btn ghost", html:"Export Season", onclick:async()=>{ await exportSeason(state.season);} }));
  c.appendChild(row);
  c.appendChild(el("div",{class:"hr"}));
  c.appendChild(el("div",{class:"badge", html:"Target 40 • Win by 3 • 2s/3s only"}));
  app.appendChild(c);

  const tips=el("div",{class:"card section", style:"margin-top:12px;"});
  tips.appendChild(el("div",{class:"h2", html:"Backups"}));
  tips.appendChild(el("div",{class:"p", html:"Cloud: tap <b>Sync</b> anytime (top right). For safety, export occasionally too."}));
  tips.appendChild(el("div",{class:"p", html:"On iPad Safari: Share → Add to Home Screen."}));
  app.appendChild(tips);
}

async function renderLogin(app){
  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:"Cloud Sign In"}));

  const ready = supabaseReady();
  if (!ready) {
    c.appendChild(el("div",{class:"p", html:"Cloud not configured yet. Open <b>config.js</b> and paste your Supabase URL + anon key."}));
    c.appendChild(el("button",{class:"btn ghost", html:"Back", onclick:()=>setRoute("home")}));
    app.appendChild(c);
    return;
  }

  const email = el("input",{class:"input", placeholder:"Email", type:"email"});
  const pass = el("input",{class:"input", placeholder:"Password", type:"password", style:"margin-top:10px;"});

  const btnRow = el("div",{class:"row", style:"margin-top:12px;"});
  btnRow.appendChild(el("button",{class:"btn ok", html:"Sign In", onclick:async()=>{
    try{
      await sbSignIn(email.value.trim(), pass.value);
      showModal("Signed in", "Now syncing down your cloud data…", []);
      await sbSyncUp();
      await sbSyncDown();
      hideModal();
      await updateHeaderSeason();
      setRoute("home");
    } catch(e){
      hideModal();
      showModal("Sign in error", (e&&e.message)?e.message:String(e), [{label:"OK", kind:"ghost"}]);
    }
  }}));
  btnRow.appendChild(el("button",{class:"btn ghost", html:"Create Account", onclick:async()=>{
    try{
      await sbSignUp(email.value.trim(), pass.value);
      showModal("Account created", "If Supabase requires email confirmation, confirm then sign in. Otherwise syncing now…", []);
      await sbSyncUp();
      await sbSyncDown();
      hideModal();
      await updateHeaderSeason();
      setRoute("home");
    } catch(e){
      hideModal();
      showModal("Sign up error", (e&&e.message)?e.message:String(e), [{label:"OK", kind:"ghost"}]);
    }
  }}));
  btnRow.appendChild(el("button",{class:"btn ghost", html:"Back", onclick:()=>setRoute("home")}));

  c.appendChild(email);
  c.appendChild(pass);
  c.appendChild(btnRow);

  app.appendChild(c);
}

async function renderPlayers(app){
  await refreshPlayers();
  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:"Players"}));
  c.appendChild(el("div",{class:"p", html:"Add players once. If cloud is enabled, they sync across devices."}));

  const input=el("input",{class:"input", placeholder:"Add player name…"});
  const add=el("button",{class:"btn ok", html:"Add", onclick:async()=>{
    const name=input.value.trim();
    if(!name) return;
    const p = await DB.addPlayer(name);
    // queue cloud upsert
    await DB.enqueueOp("upsert_player", p);
    input.value="";
    render();
  }});
  c.appendChild(el("div",{class:"row"},[input, add]));

  const tbl=el("table",{class:"table", style:"margin-top:12px;"});
  tbl.appendChild(el("thead",{html:"<tr><th>Name</th><th style='width:140px;'>Status</th></tr>"}));
  const tb=el("tbody",{});
  for(const p of state.players){
    const tr=el("tr",{});
    tr.style.cursor="pointer";
    tr.onclick=()=>showPlayerModal(p.player_id);
    tr.appendChild(el("td",{html:`<b>${p.name}</b><div class="kbd">${p.player_id.slice(0,8)}</div>`}));
    const td=el("td",{});
    td.appendChild(el("button",{class:"btn small ghost", html:"Archive", onclick:async(e)=>{ e.stopPropagation();
      p.active=false;
      await DB.updatePlayer(p);
      await DB.enqueueOp("upsert_player", p);
      render();
    }}));
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  c.appendChild(tbl);
  app.appendChild(c);
}

async function renderStart(app){
  await refreshPlayers();
  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:"Start Game"}));

  if(state.players.length<4){
    c.appendChild(el("div",{class:"p", html:"Add at least 4 players first."}));
    c.appendChild(el("button",{class:"btn ok", html:"Go to Players", onclick:()=>setRoute("players")}));
    app.appendChild(c); return;
  }

  if(!state._start) state._start={selected:[], A:[null,null], B:[null,null]};
  const s=state._start;

  const sel=el("select",{class:"input", style:"max-width:420px;"});
  sel.appendChild(el("option",{value:"", html:"Select player…"}));
  for(const p of state.players){
    if(s.selected.includes(p.player_id)) continue;
    sel.appendChild(el("option",{value:p.player_id, html:p.name}));
  }
  const addBtn=el("button",{class:"btn ok", html:"Add to 4", onclick:()=>{
    const id=sel.value; if(!id) return;
    s.selected.push(id);
    const slots=[...s.A,...s.B];
    const idx=slots.findIndex(x=>!x);
    if(idx!==-1){ if(idx<2) s.A[idx]=id; else s.B[idx-2]=id; }
    render();
  }});
  c.appendChild(el("div",{class:"row"},[sel, addBtn]));

  const chips=el("div",{class:"row", style:"margin-top:10px;"});
  for(const id of s.selected){
    const nm=state.players.find(p=>p.player_id===id)?.name||id;
    const chip=el("span",{class:"badge", html:`${nm} <span style="opacity:.7">✕</span>`});
    chip.style.cursor="pointer";
    chip.onclick=()=>{
      s.selected=s.selected.filter(x=>x!==id);
      s.A=s.A.map(x=>x===id?null:x);
      s.B=s.B.map(x=>x===id?null:x);
      render();
    };
    chips.appendChild(chip);
  }
  c.appendChild(chips);

  const makeSide=(label, arr)=>{
    const box=el("div",{class:"card section", style:"background: rgba(255,255,255,.02);"});
    box.appendChild(el("div",{class:"h2", html:label}));
    for(let i=0;i<2;i++){
      const dd=el("select",{class:"input", style:"margin-top:10px;"});
      dd.appendChild(el("option",{value:"", html:`Slot ${i+1}`}));
      for(const id of s.selected){
        const nm=state.players.find(p=>p.player_id===id)?.name||id;
        dd.appendChild(el("option",{value:id, html:nm}));
      }
      dd.value=arr[i]||"";
      dd.onchange=()=>{
        const id=dd.value||null;
        const used=new Set([...(s.A.filter(Boolean)), ...(s.B.filter(Boolean))]);
        if(id && used.has(id) && arr[i]!==id){ dd.value=arr[i]||""; return; }
        arr[i]=id;
      };
      box.appendChild(dd);
    }
    return box;
  };
  const pair=el("div",{class:"grid2", style:"margin-top:12px;"});
  pair.appendChild(makeSide("Side A", s.A));
  pair.appendChild(makeSide("Side B", s.B));
  c.appendChild(pair);

  const swaps=el("div",{class:"row", style:"margin-top:12px;"});
  const swap=(label, fn)=>el("button",{class:"btn ghost", html:label, onclick:()=>{ fn(); render(); }});
  swaps.appendChild(swap("Swap A2 ↔ B1", ()=>{ const t=s.A[1]; s.A[1]=s.B[0]; s.B[0]=t; }));
  swaps.appendChild(swap("Swap A1 ↔ B1", ()=>{ const t=s.A[0]; s.A[0]=s.B[0]; s.B[0]=t; }));
  swaps.appendChild(swap("Swap Sides", ()=>{ const t=s.A; s.A=s.B; s.B=t; }));
  swaps.appendChild(swap("Reset", ()=>{ state._start={selected:[], A:[null,null], B:[null,null]}; }));
  c.appendChild(swaps);

  const ready=(s.A.every(Boolean) && s.B.every(Boolean) && new Set([...s.A,...s.B]).size===4);
  c.appendChild(el("div",{class:"hr"}));
  c.appendChild(el("button",{class:`btn ${ready?"ok":"ghost"}`, html:"Start", onclick:async()=>{
    if(!ready) return;
    const game=await DB.addGame(state.season.season_id, s.A, s.B);
    await DB.enqueueOp("upsert_game", game);
    state.currentGame=game;
    state._start=null;
    setRoute("live");
  }}));
  app.appendChild(c);
}

async function renderLive(app){
  let game=state.currentGame;
  if(!game){
    game = await hydrateOpenGame();
  }
  if(!game){
    const c=el("div",{class:"card section"});
    c.appendChild(el("div",{class:"h1", html:"No game in progress"}));
    c.appendChild(el("button",{class:"btn ok", html:"Start Game", onclick:()=>setRoute("start")}));
    app.appendChild(c); return;
  }

  const playersAll=await DB.listPlayers(false);
  const playersById=new Map(playersAll.map(p=>[p.player_id,p]));
  const name=(id)=>playersById.get(id)?.name||"—";

  const evs=await DB.listEventsForGame(game.game_id);
  const box=computeFromEvents(game, evs);

  const scoreCard=el("div",{class:"card scorebar"});
  const scoreline=el("div",{class:"scoreline"});
  scoreline.appendChild(el("div",{class:"score", html:`${box.scoreA}`}));
  scoreline.appendChild(el("div",{class:"score", style:"opacity:.5", html:"—"}));
  scoreline.appendChild(el("div",{class:"score", html:`${box.scoreB}`}));
  scoreCard.appendChild(scoreline);

  const to40A=Math.max(0, 40-box.scoreA);
  const to40B=Math.max(0, 40-box.scoreB);

  const rule=el("div",{class:"ruleline"});
  rule.appendChild(el("div",{html:"Target 40 • Win by 3"}));
  rule.appendChild(el("div",{html:`Lead: ${box.lead} (need 3)`}));
  rule.appendChild(el("div",{html:`To 40: A needs ${to40A} • B needs ${to40B}`}));
  scoreCard.appendChild(rule);

  if(box.canFinalize){
    scoreCard.appendChild(el("div",{class:"badge", style:"margin-top:10px; color:#d1fae5; border-color: rgba(34,197,94,.35); background: rgba(34,197,94,.10);", html:"Game can be finalized"}));
  }

  // Recent events (last 3)
  const statLabel=(s)=>{
    const map={
      "2PM":"2PT MAKE","2PMISS":"2PT MISS",
      "3PM":"3PT MAKE","3PMISS":"3PT MISS",
      "AST":"AST","OREB":"OREB","DREB":"DREB","STL":"STL","BLK":"BLK"
    };
    return map[s]||s;
  };
  const recent = evs.slice(-3).reverse();
  const recentWrap = el("div",{style:"margin-top:10px;"});
  recentWrap.appendChild(el("div",{class:"small-note", html:"Last actions"}));
  const row = el("div",{class:"recent-actions", style:"margin-top:6px;"});
  if(!recent.length){
    row.appendChild(el("div",{class:"recent-chip", html:"—"}));
  } else {
    for(const e of recent){
      const when = (e.timestamp ? new Date(e.timestamp).toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "");
      row.appendChild(el("div",{class:"recent-chip", html:`${when ? "<span style=\"opacity:.6\">"+when+"</span> " : ""}<b>${name(e.player_id)}</b> • ${statLabel(e.stat_type)}`}));
    }
  }
  recentWrap.appendChild(row);
  scoreCard.appendChild(recentWrap);

  app.appendChild(scoreCard);

  const grid=el("div",{class:"grid4"});
  const sideMap=new Map();
  for(const pid of game.sideA_player_ids) sideMap.set(pid,"A");
  for(const pid of game.sideB_player_ids) sideMap.set(pid,"B");

  const addEvent=async(pid, stat)=>{
    const ev = await DB.addEvent(game.game_id, pid, stat);
    await DB.enqueueOp("upsert_event", ev);
    // keep an in-progress pointer so we can always resume
    localStorage.setItem("open_game_id", game.game_id);
    scheduleLiveCloudSync();
    render();
  };

  const cardFor=(pid)=>{
    const line=box.lines.get(pid);
    const d=box.derived(pid);

    const card=el("div",{class:"card player-card"});
    const header=el("div",{class:"player-name"});
    header.appendChild(el("div",{html:name(pid)}));
    header.appendChild(el("div",{class:"side-tag", html:`Side ${sideMap.get(pid)}`}));
    card.appendChild(header);

    const shoot=el("div",{class:"btn-grid-2x2"});
    shoot.appendChild(el("button",{class:"stat-btn primary", html:"2PT MAKE", onclick:()=>addEvent(pid,"2PM")}));
    shoot.appendChild(el("button",{class:"stat-btn miss", html:"2PT MISS", onclick:()=>addEvent(pid,"2PMISS")}));
    shoot.appendChild(el("button",{class:"stat-btn primary", html:"3PT MAKE", onclick:()=>addEvent(pid,"3PM")}));
    shoot.appendChild(el("button",{class:"stat-btn miss", html:"3PT MISS", onclick:()=>addEvent(pid,"3PMISS")}));
    card.appendChild(shoot);

    const row3=el("div",{class:"btn-row3"});
    row3.appendChild(el("button",{class:"stat-btn mid", html:"AST", onclick:()=>addEvent(pid,"AST")}));
    row3.appendChild(el("button",{class:"stat-btn mid", html:"OREB", onclick:()=>addEvent(pid,"OREB")}));
    row3.appendChild(el("button",{class:"stat-btn mid", html:"DREB", onclick:()=>addEvent(pid,"DREB")}));
    card.appendChild(row3);

    const row2=el("div",{class:"btn-row2"});
    row2.appendChild(el("button",{class:"stat-btn mid", html:"STL", onclick:()=>addEvent(pid,"STL")}));
    row2.appendChild(el("button",{class:"stat-btn mid", html:"BLK", onclick:()=>addEvent(pid,"BLK")}));
    card.appendChild(row2);

    const mini=`PTS ${d.pts} | 2s ${line["2PM"]}-${d.twoA} | 3s ${line["3PM"]}-${d.threeA} | REB ${d.reb} (O${line["OREB"]}/D${line["DREB"]}) | AST ${line["AST"]} | STL ${line["STL"]} | BLK ${line["BLK"]}`;
    card.appendChild(el("div",{class:"mini", html:mini}));
    return card;
  };

  for(const pid of [...game.sideA_player_ids, ...game.sideB_player_ids]) grid.appendChild(cardFor(pid));
  app.appendChild(grid);

  const actions=el("div",{class:"card section", style:"margin-top:12px;"});
  const act=el("div",{class:"bottom-actions"});
  act.appendChild(el("button",{class:"btn ghost", html:"Undo", onclick:async()=>{
    if(!evs.length) return;
    const last=evs[evs.length-1];
    await DB.deleteEvent(last.event_id);
    await DB.enqueueOp("delete_event", { event_id: last.event_id });
    render();
  }}));
  act.appendChild(el("button",{class:"btn ok", html:"End Game", onclick:async()=>{
    if(!box.canFinalize){
      showModal("End game early?",
        "Game has not met win condition (Target 40, win by 3). End anyway?",
        [{label:"Cancel", kind:"ghost"},{label:"End Anyway", kind:"danger", onClick:()=>setRoute("recap")}]
      );
    } else {
      setRoute("recap");
    }
  }}));
  actions.appendChild(act);
  app.appendChild(actions);
}

async function renderRecap(app){
  const game=state.currentGame;
  if(!game){ setRoute("home"); return; }

  const playersAll=await DB.listPlayers(false);
  const playersById=new Map(playersAll.map(p=>[p.player_id,p]));
  const name=(id)=>playersById.get(id)?.name||"—";

  const evs=await DB.listEventsForGame(game.game_id);
  const box=computeFromEvents(game, evs);

  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:"Game Recap"}));
  c.appendChild(el("div",{class:"badge", html:`Final: ${box.scoreA} — ${box.scoreB} • Winner: Side ${box.winner_side}`}));

  const tbl=el("table",{class:"table", style:"margin-top:12px;"});
  tbl.appendChild(el("thead",{html:"<tr><th>Player</th><th>Side</th><th>PTS</th><th>2s</th><th>3s</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th></tr>"}));
  const tb=el("tbody",{});
  const sideMap=new Map();
  for(const pid of game.sideA_player_ids) sideMap.set(pid,"A");
  for(const pid of game.sideB_player_ids) sideMap.set(pid,"B");

  for(const pid of [...game.sideA_player_ids, ...game.sideB_player_ids]){
    const line=box.lines.get(pid);
    const d=box.derived(pid);
    const tr=el("tr",{});
    tr.appendChild(el("td",{html:`<b>${name(pid)}</b>`}));
    tr.appendChild(el("td",{html:sideMap.get(pid)}));
    tr.appendChild(el("td",{html:d.pts}));
    tr.appendChild(el("td",{html:`${line["2PM"]}-${d.twoA}`}));
    tr.appendChild(el("td",{html:`${line["3PM"]}-${d.threeA}`}));
    tr.appendChild(el("td",{html:d.reb}));
    tr.appendChild(el("td",{html:line["AST"]}));
    tr.appendChild(el("td",{html:line["STL"]}));
    tr.appendChild(el("td",{html:line["BLK"]}));
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  c.appendChild(tbl);

  c.appendChild(el("div",{class:"hr"}));
  const row=el("div",{class:"row"});
  row.appendChild(el("button",{class:"btn ok", html:"Finalize Game", onclick:async()=>{
    game.finalized=true;
    game.final_score_a=box.scoreA;
    game.final_score_b=box.scoreB;
    game.winner_side=box.winner_side;
    await DB.putGame(game);

    // queue a bulk finalize upsert (game + its events) for reliability
    await DB.enqueueOp("upsert_bulk_finalize", { game, events: evs });
    localStorage.removeItem("open_game_id");
    scheduleLiveCloudSync();

    const auto=await DB.getSetting("auto_export_finalize", false);
    if(auto){
      await exportGame(game, state.season, playersById);
      await exportSeason(state.season);
    }
    state.currentGame=null;
    setRoute("dashboard");
  }}));
  row.appendChild(el("button",{class:"btn ghost", html:"Export Game", onclick:async()=>{ await exportGame(game, state.season, playersById); }}));
  row.appendChild(el("button",{class:"btn danger", html:"Discard Game", onclick:async()=>{
    showModal("Discard this game?", "This deletes the game and all its events.",
      [{label:"Cancel", kind:"ghost"},{label:"Discard", kind:"danger", onClick:async()=>{
        await DB.deleteGame(game.game_id);
        await DB.enqueueOp("delete_game", { game_id: game.game_id });
        state.currentGame=null;
        setRoute("home");
      }}]
    );
  }}));
  c.appendChild(row);
  app.appendChild(c);
}

async function renderDashboard(app){
  const gamesFinal = await DB.listGamesForSeason(state.season.season_id, true);
  // Use chronological order for streak/Elo
  const gamesChrono = [...gamesFinal].sort((a,b)=>a.played_at.localeCompare(b.played_at));

  const playersAll = await DB.listPlayers(false);
  const playersById = new Map(playersAll.map(p=>[p.player_id,p]));
  const name = (id)=>playersById.get(id)?.name||"—";

  // Helpers
  const initTotals = ()=>({GP:0,W:0,L:0, PTS:0, AST:0, OREB:0, DREB:0, STL:0, BLK:0, twoM:0,twoA:0, threeM:0,threeA:0});
  const totals = new Map();
  const streak = new Map(); // pid -> {type:'W'|'L'|null, n:int}
  const elo = new Map(); // pid -> rating
  const ELO_START = 1000;
  const K_BASE = 20;

  const getElo = (pid)=> elo.has(pid) ? elo.get(pid) : (elo.set(pid, ELO_START), ELO_START);
  const setElo = (pid, v)=> elo.set(pid, v);

  // Pair aggregations
  const teammate = new Map(); // key sorted pid1|pid2 -> {GP,W,L, pts_for, pts_against, margin_sum}
  const head2head = new Map(); // key sorted pid1|pid2 -> anchored {a, b, aWins, bWins, games, margin_sum_from_a}

  const pairKey = (a,b)=> [a,b].sort().join("|");

  // Compute season totals, streaks, pair stats, Elo
  for (const g of gamesChrono){
    const evs = await DB.listEventsForGame(g.game_id);
    const box = computeFromEvents(g, evs);

    const sideMap = new Map();
    for (const pid of g.sideA_player_ids) sideMap.set(pid,"A");
    for (const pid of g.sideB_player_ids) sideMap.set(pid,"B");
    const winner = g.winner_side;

    // Score + margin
    const scoreA = box.scoreA;
    const scoreB = box.scoreB;
    const margin = Math.abs(scoreA - scoreB);
    const winnerScore = Math.max(scoreA, scoreB);

    // --- Elo update (team-based) ---
    const teamA = g.sideA_player_ids;
    const teamB = g.sideB_player_ids;
    const eloA = teamA.reduce((s,p)=>s+getElo(p),0)/teamA.length;
    const eloB = teamB.reduce((s,p)=>s+getElo(p),0)/teamB.length;

    const expectedA = 1 / (1 + Math.pow(10, (eloB - eloA)/400));
    const actualA = (winner === "A") ? 1 : 0;

    // Margin multiplier: larger margin increases update, capped to avoid huge swings.
    const marginMult = Math.min(2.0, 1 + (margin / 10));
    // Mild score multiplier (winning 40-38 is a little "tougher" than 40-20)
    const scoreMult = Math.min(1.5, 1 + (winnerScore / 100));
    const K = K_BASE * marginMult * scoreMult;

    const deltaA = K * (actualA - expectedA);
    const deltaB = -deltaA;

    for (const pid of teamA) setElo(pid, getElo(pid) + deltaA);
    for (const pid of teamB) setElo(pid, getElo(pid) + deltaB);

    // --- Totals + streak ---
    for (const pid of [...teamA, ...teamB]){
      if (!totals.has(pid)) totals.set(pid, initTotals());
      if (!streak.has(pid)) streak.set(pid, {type:null, n:0});
      const t = totals.get(pid);
      const s = streak.get(pid);

      const side = sideMap.get(pid);
      t.GP += 1;
      const isWin = (side === winner);
      if (isWin) t.W += 1; else t.L += 1;

      const curType = isWin ? "W" : "L";
      if (s.type === curType) s.n += 1;
      else { s.type = curType; s.n = 1; }

      const line = box.lines.get(pid);
      const d = box.derived(pid);
      t.PTS += d.pts;
      t.AST += line["AST"];
      t.OREB += line["OREB"];
      t.DREB += line["DREB"];
      t.STL += line["STL"];
      t.BLK += line["BLK"];
      t.twoM += line["2PM"]; t.twoA += d.twoA;
      t.threeM += line["3PM"]; t.threeA += d.threeA;
    }

    // --- Teammate chemistry ---
    const addTeammatePair = (p1,p2, didWin, ptsFor, ptsAgainst, marginSigned)=>{
      const k = pairKey(p1,p2);
      if (!teammate.has(k)) teammate.set(k, {GP:0,W:0,L:0, pts_for:0, pts_against:0, margin_sum:0});
      const r = teammate.get(k);
      r.GP += 1;
      if (didWin) r.W += 1; else r.L += 1;
      r.pts_for += ptsFor;
      r.pts_against += ptsAgainst;
      r.margin_sum += marginSigned;
    };
    addTeammatePair(teamA[0], teamA[1], winner==="A", scoreA, scoreB, (winner==="A"? +margin : -margin));
    addTeammatePair(teamB[0], teamB[1], winner==="B", scoreB, scoreA, (winner==="B"? +margin : -margin));

    // --- Head-to-head (opponents) ---
    const addH2H = (p,q, pWon, marginSigned)=>{
      const k = pairKey(p,q);
      if (!head2head.has(k)) head2head.set(k, {a:null, b:null, aWins:0, bWins:0, games:0, margin_sum_from_a:0});
      const r = head2head.get(k);
      const [lo, hi] = [p,q].sort();
      r.a = lo; r.b = hi;
      const pIsLo = (p === lo);
      r.games += 1;
      if (pWon) {
        if (pIsLo) r.aWins += 1; else r.bWins += 1;
        r.margin_sum_from_a += pIsLo ? +marginSigned : -marginSigned;
      } else {
        if (pIsLo) r.bWins += 1; else r.aWins += 1;
        r.margin_sum_from_a += pIsLo ? -marginSigned : +marginSigned;
      }
    };
    for (const a of teamA){
      for (const b of teamB){
        addH2H(a,b, winner==="A", margin);
      }
    }
  }

  // Build player rows
  const rows = [];
  for (const [pid,t] of totals.entries()){
    const reb = t.OREB + t.DREB;
    const twoPct = t.twoA ? (t.twoM/t.twoA) : null;
    const threePct = t.threeA ? (t.threeM/t.threeA) : null;
    const st = streak.get(pid) || {type:null,n:0};
    rows.push({
      pid,
      player: name(pid),
      GP: t.GP,
      WL: `${t.W}-${t.L}`,
      streak: st.type ? `${st.type}${st.n}` : "—",
      elo: getElo(pid),
      ppg: (t.GP ? t.PTS/t.GP : 0),
      rpg: (t.GP ? reb/t.GP : 0),
      apg: (t.GP ? t.AST/t.GP : 0),
      spg: (t.GP ? t.STL/t.GP : 0),
      bpg: (t.GP ? t.BLK/t.GP : 0),
      twoPct,
      threePct
    });
  }

  // Controls & sorts
  const sortMode = state._dashSort || "elo";
  const winPct = (r)=>{
    const [w,l] = r.WL.split("-").map(x=>Number(x));
    return (w+l) ? (w/(w+l)) : 0;
  };
  const streakVal = (s)=>{
    if (!s || s==="—") return 0;
    const t = s[0];
    const n = Number(s.slice(1))||0;
    return (t==="W") ? n : -n;
  };
  if (sortMode==="ppg") rows.sort((a,b)=>b.ppg-a.ppg);
  else if (sortMode==="wl") rows.sort((a,b)=>winPct(b)-winPct(a));
  else if (sortMode==="streak") rows.sort((a,b)=>streakVal(b.streak)-streakVal(a.streak));
  else if (sortMode==="gp") rows.sort((a,b)=>b.GP-a.GP);
  else rows.sort((a,b)=>b.elo-a.elo);

  const pctClass = (x)=>{
    if (x===null) return "";
    if (x>=0.55) return "pct-good";
    if (x>=0.40) return "pct-ok";
    return "pct-bad";
  };
  const pctText = (x)=> x===null ? "—" : (x*100).toFixed(0)+"%";

  const closeMargin = state._closeMargin || 5;

  // --- Main card ---
  const c = el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:`Dashboard • ${state.season.name}`}));
  c.appendChild(el("div",{class:"p", html:`Games: <b>${gamesFinal.length}</b> • Close games (≤${closeMargin}): <b>${gamesFinal.filter(g=>Math.abs(g.final_score_a-g.final_score_b)<=closeMargin).length}</b>`}));
  c.appendChild(el("div",{class:"small-note", html:`Elo: team strength adjusts for opponent strength automatically; updates scale with margin (cap 2.0x) and mildly with score.`}));

  const controls = el("div",{class:"controls", style:"margin-top:10px;"});
  const sortSel = el("select",{class:"input"});
  sortSel.innerHTML = `
    <option value="elo">Sort: Elo</option>
    <option value="ppg">Sort: PTS/G</option>
    <option value="wl">Sort: Win %</option>
    <option value="streak">Sort: Streak</option>
    <option value="gp">Sort: Games Played</option>
  `;
  sortSel.value = sortMode;
  sortSel.onchange = ()=>{ state._dashSort = sortSel.value; render(); };
  controls.appendChild(sortSel);

  const marginSel = el("select",{class:"input"});
  marginSel.innerHTML = `
    <option value="5">Close games: ≤ 5</option>
    <option value="4">Close games: ≤ 4</option>
    <option value="3">Close games: ≤ 3</option>
    <option value="2">Close games: ≤ 2</option>
  `;
  marginSel.value = String(closeMargin);
  marginSel.onchange = ()=>{ state._closeMargin = Number(marginSel.value); render(); };
  controls.appendChild(marginSel);

  c.appendChild(controls);

  const tbl = el("table",{class:"table", style:"margin-top:12px;"});
  tbl.appendChild(el("thead",{html:"<tr><th>Player</th><th>Elo</th><th>Streak</th><th>GP</th><th>W-L</th><th>PTS/G</th><th>REB/G</th><th>AST/G</th><th>STL/G</th><th>BLK</th><th>2P%</th><th>3P%</th></tr>"}));
  const tb = el("tbody",{});
  for (const r of rows){
    const tr = el("tr",{});
    tr.appendChild(el("td",{html:`<b>${r.player}</b>`}));
    tr.appendChild(el("td",{html:r.elo.toFixed(0)}));
    tr.appendChild(el("td",{html:`<b>${r.streak}</b>`}));
    tr.appendChild(el("td",{html:r.GP}));
    tr.appendChild(el("td",{html:r.WL}));
    tr.appendChild(el("td",{html:r.ppg.toFixed(1)}));
    tr.appendChild(el("td",{html:r.rpg.toFixed(1)}));
    tr.appendChild(el("td",{html:r.apg.toFixed(1)}));
    tr.appendChild(el("td",{html:r.spg.toFixed(1)}));
    tr.appendChild(el("td",{html:r.bpg.toFixed(1)}));
    tr.appendChild(el("td",{html:`<span class="${pctClass(r.twoPct)}">${pctText(r.twoPct)}</span>`}));
    tr.appendChild(el("td",{html:`<span class="${pctClass(r.threePct)}">${pctText(r.threePct)}</span>`}));
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  c.appendChild(tbl);
  app.appendChild(c);

  // --- Close Games ---
  const closeGames = gamesFinal
    .filter(g=>Math.abs(g.final_score_a-g.final_score_b) <= closeMargin)
    .sort((a,b)=>b.played_at.localeCompare(a.played_at))
    .slice(0, 25);

  const closeCard = el("div",{class:"card section", style:"margin-top:12px;"});
  closeCard.appendChild(el("div",{class:"h2", html:`Close Games (≤ ${closeMargin})`}));
  if (!closeGames.length) closeCard.appendChild(el("div",{class:"p", html:"No close games yet."}));
  else {
    const lt = el("table",{class:"table"});
    lt.appendChild(el("thead",{html:"<tr><th>Date</th><th>Matchup</th><th>Final</th><th>Margin</th></tr>"}));
    const ltb = el("tbody",{});
    for (const g of closeGames){
      const [a1,a2] = g.sideA_player_ids, [b1,b2] = g.sideB_player_ids;
      const matchup = `${name(a1)} + ${name(a2)} vs ${name(b1)} + ${name(b2)}`;
      const mg = Math.abs(g.final_score_a - g.final_score_b);
      const tr = el("tr",{});
      tr.appendChild(el("td",{html:g.played_at.slice(0,10)}));
      tr.appendChild(el("td",{html:matchup}));
      tr.appendChild(el("td",{html:`${g.final_score_a} — ${g.final_score_b} (W: ${g.winner_side})`}));
      tr.appendChild(el("td",{html:`${mg}`}));
      ltb.appendChild(tr);
    }
    lt.appendChild(ltb);
    closeCard.appendChild(lt);
  }
  app.appendChild(closeCard);

  // --- Head-to-head ---
  const h2hCard = el("div",{class:"card section", style:"margin-top:12px;"});
  h2hCard.appendChild(el("div",{class:"h2", html:"Head-to-Head"}));

  const pSel1 = el("select",{class:"input"});
  const pSel2 = el("select",{class:"input"});
  pSel1.appendChild(el("option",{value:"", html:"Player 1"}));
  pSel2.appendChild(el("option",{value:"", html:"Player 2"}));
  for (const p of playersAll.filter(p=>p.active)){
    pSel1.appendChild(el("option",{value:p.player_id, html:p.name}));
    pSel2.appendChild(el("option",{value:p.player_id, html:p.name}));
  }
  pSel1.value = state._h2h1 || "";
  pSel2.value = state._h2h2 || "";
  pSel1.onchange = ()=>{ state._h2h1 = pSel1.value; render(); };
  pSel2.onchange = ()=>{ state._h2h2 = pSel2.value; render(); };

  const lookupRow = el("div",{class:"controls", style:"margin-top:10px;"});
  lookupRow.appendChild(pSel1);
  lookupRow.appendChild(pSel2);
  h2hCard.appendChild(lookupRow);

  const showH2H = (p,q)=>{
    if (!p || !q || p===q) return null;
    const k = pairKey(p,q);
    const r = head2head.get(k);
    if (!r) return { text:"No games vs each other yet." };
    const lo = r.a, hi = r.b;
    const selectedLo = (p===lo && q===hi);
    const pWins = selectedLo ? r.aWins : r.bWins;
    const qWins = selectedLo ? r.bWins : r.aWins;
    const avgMarginForP = r.games ? (selectedLo ? (r.margin_sum_from_a/r.games) : (-r.margin_sum_from_a/r.games)) : 0;
    return { text:`<b>${name(p)}</b> vs <b>${name(q)}</b>: <b>${pWins}-${qWins}</b> (Games: ${r.games}) • Avg margin for ${name(p)}: <b>${avgMarginForP.toFixed(1)}</b>` };
  };

  const h2hRes = showH2H(state._h2h1, state._h2h2);
  if (h2hRes) h2hCard.appendChild(el("div",{class:"p", style:"margin-top:10px;", html:h2hRes.text}));
  else h2hCard.appendChild(el("div",{class:"p", style:"margin-top:10px;", html:"Pick two players to see their head-to-head record (only when they were opponents)."}));

  // Top rivalries
  const rivalRows = [];
  for (const r of head2head.values()){
    rivalRows.push({a:r.a,b:r.b,games:r.games,aWins:r.aWins,bWins:r.bWins});
  }
  rivalRows.sort((x,y)=> y.games - x.games);
  const topR = rivalRows.slice(0, 10);
  if (topR.length){
    const t = el("table",{class:"table", style:"margin-top:12px;"});
    t.appendChild(el("thead",{html:"<tr><th>Matchup</th><th>Record</th><th>Games</th></tr>"}));
    const bdy = el("tbody",{});
    for (const r of topR){
      const tr = el("tr",{});
      tr.appendChild(el("td",{html:`${name(r.a)} vs ${name(r.b)}`}));
      tr.appendChild(el("td",{html:`${r.aWins}-${r.bWins}`}));
      tr.appendChild(el("td",{html:r.games}));
      bdy.appendChild(tr);
    }
    t.appendChild(bdy);
    h2hCard.appendChild(t);
  }
  app.appendChild(h2hCard);

  // --- Teammate chemistry ---
  const teamCard = el("div",{class:"card section", style:"margin-top:12px;"});
  teamCard.appendChild(el("div",{class:"h2", html:"Teammate Chemistry"}));
  teamCard.appendChild(el("div",{class:"p", html:"Records when two players were on the same side."}));

  const chem = [];
  for (const [k,r] of teammate.entries()){
    const [p1,p2] = k.split("|");
    const gp = r.GP;
    const wp = gp ? (r.W/gp) : 0;
    const avgMargin = gp ? (r.margin_sum/gp) : 0;
    chem.push({p1,p2,gp, wl:`${r.W}-${r.L}`, wp, avgMargin});
  }
  chem.sort((a,b)=> (b.wp - a.wp) || (b.gp - a.gp));

  if (!chem.length) teamCard.appendChild(el("div",{class:"p", html:"No games yet."}));
  else {
    const t = el("table",{class:"table", style:"margin-top:12px;"});
    t.appendChild(el("thead",{html:"<tr><th>Pair</th><th>W-L</th><th>Win%</th><th>GP</th><th>Avg Margin</th></tr>"}));
    const bdy = el("tbody",{});
    for (const r of chem.slice(0, 15)){
      const tr = el("tr",{});
      tr.appendChild(el("td",{html:`${name(r.p1)} + ${name(r.p2)}`}));
      tr.appendChild(el("td",{html:r.wl}));
      tr.appendChild(el("td",{html:(r.wp*100).toFixed(0)+"%"}));
      tr.appendChild(el("td",{html:r.gp}));
      tr.appendChild(el("td",{html:r.avgMargin.toFixed(1)}));
      bdy.appendChild(tr);
    }
    t.appendChild(bdy);
    teamCard.appendChild(t);
  }
  app.appendChild(teamCard);

  // --- Game Log ---
  const log = el("div",{class:"card section", style:"margin-top:12px;"});
  log.appendChild(el("div",{class:"h2", html:"Game Log"}));
  if (!gamesFinal.length) log.appendChild(el("div",{class:"p", html:"No finalized games yet."}));
  else {
    const lt = el("table",{class:"table"});
    lt.appendChild(el("thead",{html:"<tr><th>Date</th><th>Matchup</th><th>Final</th><th>Margin</th></tr>"}));
    const ltb = el("tbody",{});
    for (const g of [...gamesFinal].sort((a,b)=>b.played_at.localeCompare(a.played_at)).slice(0,25)){
      const [a1,a2] = g.sideA_player_ids, [b1,b2] = g.sideB_player_ids;
      const matchup = `${name(a1)} + ${name(a2)} vs ${name(b1)} + ${name(b2)}`;
      const mg = Math.abs(g.final_score_a - g.final_score_b);
      const tr = el("tr",{});
      tr.style.cursor = "pointer";
      tr.onclick = ()=>{ state.currentGame=g; setRoute("recap"); };
      tr.appendChild(el("td",{html:g.played_at.slice(0,10)}));
      tr.appendChild(el("td",{html:matchup}));
      tr.appendChild(el("td",{html:`${g.final_score_a} — ${g.final_score_b} (W: ${g.winner_side})`}));
      tr.appendChild(el("td",{html:String(mg)}));
      ltb.appendChild(tr);
    }
    lt.appendChild(ltb);
    log.appendChild(lt);
  }
  app.appendChild(log);
}

// ===== v4: Leaderboard / Records / Awards / Draft + Player Career Highs =====

function _pidName(pid, playersById){
  return playersById.get(pid)?.name || "—";
}

function _formatVs(opp1, opp2, playersById){
  return `${_pidName(opp1, playersById)} + ${_pidName(opp2, playersById)}`;
}

function _formatTeammate(tid, playersById){
  return _pidName(tid, playersById);
}

function _statValue(box, pid, statKey){
  const line = box.lines.get(pid);
  const d = box.derived(pid);
  if (statKey==="PTS") return d.pts;
  if (statKey==="3PM") return line["3PM"];
  if (statKey==="2PM") return line["2PM"];
  if (statKey==="REB") return line["OREB"] + line["DREB"];
  if (statKey==="AST") return line["AST"];
  if (statKey==="STL") return line["STL"];
  if (statKey==="BLK") return line["BLK"];
  return 0;
}

async function _computeElo(gamesChrono){
  const elo = new Map();
  const ELO_START=1000;
  const K_BASE=20;
  const get=(pid)=> elo.has(pid)?elo.get(pid):(elo.set(pid,ELO_START),ELO_START);
  const set=(pid,v)=> elo.set(pid,v);

  const start = new Map();
  for (const g of gamesChrono){
    const teamA=g.sideA_player_ids;
    const teamB=g.sideB_player_ids;
    for(const pid of [...teamA,...teamB]) if(!start.has(pid)) start.set(pid, get(pid));

    const eloA=teamA.reduce((s,p)=>s+get(p),0)/teamA.length;
    const eloB=teamB.reduce((s,p)=>s+get(p),0)/teamB.length;
    const expectedA = 1/(1+Math.pow(10,(eloB-eloA)/400));
    const actualA = (g.winner_side==="A")?1:0;

    const margin=Math.abs(g.final_score_a-g.final_score_b);
    const winnerScore=Math.max(g.final_score_a,g.final_score_b);
    const marginMult=Math.min(2.0, 1+(margin/10));
    const scoreMult=Math.min(1.5, 1+(winnerScore/100));
    const K=K_BASE*marginMult*scoreMult;

    const deltaA=K*(actualA-expectedA);
    const deltaB=-deltaA;

    for(const pid of teamA) set(pid, get(pid)+deltaA);
    for(const pid of teamB) set(pid, get(pid)+deltaB);
  }

  const delta = new Map();
  for (const [pid, rating] of elo.entries()){
    const base = start.get(pid) ?? 1000;
    delta.set(pid, rating - base);
  }
  return { elo, delta };
}

async function _buildTopPerformances(games, playersById, topN){
  const cats=[
    {key:"PTS", label:"Points"},
    {key:"3PM", label:"3s Made"},
    {key:"2PM", label:"2s Made"},
    {key:"REB", label:"Rebounds"},
    {key:"AST", label:"Assists"},
    {key:"STL", label:"Steals"},
    {key:"BLK", label:"Blocks"},
  ];
  const out = new Map();
  for (const c of cats) out.set(c.key, []);

  for (const g of games){
    const evs = await DB.listEventsForGame(g.game_id);
    const box = computeFromEvents(g, evs);

    const [a1,a2]=g.sideA_player_ids;
    const [b1,b2]=g.sideB_player_ids;

    const metaFor = (pid)=>{
      const side = g.sideA_player_ids.includes(pid) ? "A" : "B";
      const teammate = (side==="A") ? (pid===a1?a2:a1) : (pid===b1?b2:b1);
      const opp = (side==="A") ? [b1,b2] : [a1,a2];
      return { teammate, opp };
    };

    for (const pid of [...g.sideA_player_ids, ...g.sideB_player_ids]){
      const meta = metaFor(pid);
      for (const c of cats){
        const v = _statValue(box, pid, c.key);
        out.get(c.key).push({
          pid,
          player: _pidName(pid, playersById),
          value: v,
          date: g.played_at.slice(0,10),
          teammate: _formatTeammate(meta.teammate, playersById),
          vs: _formatVs(meta.opp[0], meta.opp[1], playersById),
        });
      }
    }
  }

  for (const c of cats){
    out.set(c.key, out.get(c.key).sort((a,b)=>b.value-a.value).slice(0, topN));
  }
  return {cats, out};
}

async function _longestWinStreaks(gamesChrono){
  const best = new Map();
  const cur = new Map();
  for (const g of gamesChrono){
    const winner = g.winner_side;
    for (const pid of [...g.sideA_player_ids, ...g.sideB_player_ids]){
      const side = g.sideA_player_ids.includes(pid) ? "A" : "B";
      const won = (side === winner);
      const c = cur.get(pid) || 0;
      const next = won ? (c+1) : 0;
      cur.set(pid, next);
      best.set(pid, Math.max(best.get(pid)||0, next));
    }
  }
  return best;
}

async function showPlayerModal(player_id){
  const playersAll=await DB.listPlayers(false);
  const playersById=new Map(playersAll.map(p=>[p.player_id,p]));
  const p=playersById.get(player_id);
  if(!p) return;

  const allGames=(await DB.listAllFinalizedGames()).sort((a,b)=>a.played_at.localeCompare(b.played_at));
  const seasonGames=(state.season ? (await DB.listGamesForSeason(state.season.season_id, true)).sort((a,b)=>a.played_at.localeCompare(b.played_at)) : []);

  // Categories for highs table
  const cats=[
    {key:"PTS", label:"PTS"},
    {key:"3PM", label:"3PM"},
    {key:"2PM", label:"2PM"},
    {key:"REB", label:"REB"},
    {key:"AST", label:"AST"},
    {key:"STL", label:"STL"},
    {key:"BLK", label:"BLK"},
  ];

  const initHigh=()=>({value:-1,date:"—",teammate:"—",vs:"—", extra:""});
  const highs={};
  for (const c of cats) highs[c.key]=initHigh();

  // Career totals (all-time)
  const totals={ GP:0, W:0, L:0, PTS:0,
    twoM:0,twoA:0, threeM:0,threeA:0,
    REB:0, AST:0, STL:0, BLK:0
  };

  // simple W-L helper
  const wl=(g)=>{
    const side = g.sideA_player_ids.includes(player_id) ? "A" : (g.sideB_player_ids.includes(player_id) ? "B" : null);
    if(!side) return null;
    return (side===g.winner_side) ? "W" : "L";
  };

  for (const g of allGames){
    if(!g.sideA_player_ids.includes(player_id) && !g.sideB_player_ids.includes(player_id)) continue;

    totals.GP += 1;
    const res = wl(g);
    if(res==="W") totals.W += 1;
    else if(res==="L") totals.L += 1;

    const evs=await DB.listEventsForGame(g.game_id);
    const box=computeFromEvents(g, evs);

    const [a1,a2]=g.sideA_player_ids;
    const [b1,b2]=g.sideB_player_ids;

    const side = g.sideA_player_ids.includes(player_id) ? "A" : "B";
    const teammate = (side==="A") ? (player_id===a1?a2:a1) : (player_id===b1?b2:b1);
    const opp = (side==="A") ? [b1,b2] : [a1,a2];

    const line = box.lines.get(player_id);
    const d = box.derived(player_id);

    const pts = d.pts;
    const twoM = line["2PM"], twoA = d.twoA;
    const threeM = line["3PM"], threeA = d.threeA;
    const reb = line["OREB"] + line["DREB"];

    totals.PTS += pts;
    totals.twoM += twoM; totals.twoA += twoA;
    totals.threeM += threeM; totals.threeA += threeA;
    totals.REB += reb;
    totals.AST += line["AST"];
    totals.STL += line["STL"];
    totals.BLK += line["BLK"];

    // highs
    for (const c of cats){
      const v=_statValue(box, player_id, c.key);
      if (v > highs[c.key].value){
        let extra="";
        if (c.key==="3PM") extra = ` (${threeM}/${threeA})`;
        if (c.key==="2PM") extra = ` (${twoM}/${twoA})`;
        highs[c.key] = {
          value: v,
          date: g.played_at.slice(0,10),
          teammate: _formatTeammate(teammate, playersById),
          vs: _formatVs(opp[0], opp[1], playersById),
          extra
        };
      }
    }
  }

  // Season W-L (display only)
  let seasonWL = {w:0,l:0};
  if(state.season){
    for(const g of seasonGames){
      const res=wl(g);
      if(res==="W") seasonWL.w++;
      else if(res==="L") seasonWL.l++;
    }
  }

  const pct = (m,a)=> a? ((m/a)*100).toFixed(0)+"%":"—";
  const perG = (x)=> totals.GP? (x/totals.GP).toFixed(1):"0.0";

  let html = `<div class="p"><b>${p.name}</b><br/><span class="muted">All-time: ${totals.W}-${totals.L} • Season: ${seasonWL.w}-${seasonWL.l}</span></div>`;

  html += `<div class="hr"></div><div class="p"><b>Career Totals (All-Time)</b></div>`;
  html += `<table class="table" style="margin-top:10px;"><thead><tr>
    <th>PTS</th><th>2PM/2PA</th><th>3PM/3PA</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>GP</th>
  </tr></thead><tbody><tr>
    <td><b>${totals.PTS}</b><div class="muted">${perG(totals.PTS)} /g</div></td>
    <td><b>${totals.twoM}/${totals.twoA}</b><div class="muted">${pct(totals.twoM, totals.twoA)}</div></td>
    <td><b>${totals.threeM}/${totals.threeA}</b><div class="muted">${pct(totals.threeM, totals.threeA)}</div></td>
    <td><b>${totals.REB}</b><div class="muted">${perG(totals.REB)} /g</div></td>
    <td><b>${totals.AST}</b><div class="muted">${perG(totals.AST)} /g</div></td>
    <td><b>${totals.STL}</b><div class="muted">${perG(totals.STL)} /g</div></td>
    <td><b>${totals.BLK}</b><div class="muted">${perG(totals.BLK)} /g</div></td>
    <td><b>${totals.GP}</b></td>
  </tr></tbody></table>`;

  html += `<div class="hr"></div><div class="p"><b>Career Highs (Single Game)</b><br/><span class="muted">Includes date, teammate, and opponents.</span></div>`;
  html += `<table class="table" style="margin-top:10px;"><thead><tr><th>Stat</th><th>High</th><th>Date</th><th>Teammate</th><th>vs</th></tr></thead><tbody>`;
  for (const c of cats){
    const h=highs[c.key];
    const hv = (h.value>=0) ? (String(h.value) + (h.extra||"")) : "—";
    html += `<tr><td><b>${c.label}</b></td><td><b>${hv}</b></td><td>${h.date}</td><td>${h.teammate}</td><td>${h.vs}</td></tr>`;
  }
  html += `</tbody></table>`;

  showModal("Player", html, [{label:"Close", kind:"ghost"}]);
}

async function renderLeaderboard(app){
  const playersAll=await DB.listPlayers(false);
  const playersById=new Map(playersAll.map(p=>[p.player_id,p]));
  const topN = state._lbN || 10;
  const games=(await DB.listGamesForSeason(state.season.season_id, true)).sort((a,b)=>b.played_at.localeCompare(a.played_at));
  const {cats, out} = await _buildTopPerformances(games, playersById, topN);

  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:`Leaderboard • ${state.season.name}`}));
  c.appendChild(el("div",{class:"p", html:"Top single-game performances for the current season."}));

  const controls=el("div",{class:"controls", style:"margin-top:10px;"});
  const sel=el("select",{class:"input"});
  sel.innerHTML = `<option value="5">Top 5</option><option value="10">Top 10</option><option value="15">Top 15</option><option value="25">Top 25</option><option value="50">Top 50</option>`;
  sel.value = String(topN);
  sel.onchange=()=>{ state._lbN = Number(sel.value); render(); };
  controls.appendChild(sel);
  c.appendChild(controls);

  for (const cat of cats){
    const list = out.get(cat.key) || [];
    c.appendChild(el("div",{class:"hr"}));
    c.appendChild(el("div",{class:"h2", html:`Top ${topN} • ${cat.label}`}));
    if(!list.length){ c.appendChild(el("div",{class:"p", html:"No games yet."})); continue; }
    const t=el("table",{class:"table"});
    t.appendChild(el("thead",{html:"<tr><th>#</th><th>Player</th><th>Value</th><th>Date</th><th>Teammate</th><th>vs</th></tr>"}));
    const bdy=el("tbody",{});
    list.forEach((r,i)=>{
      const tr=el("tr",{});
      tr.appendChild(el("td",{html:String(i+1)}));
      tr.appendChild(el("td",{html:`<b>${r.player}</b>`}));
      tr.appendChild(el("td",{html:`<b>${r.value}</b>`}));
      tr.appendChild(el("td",{html:r.date}));
      tr.appendChild(el("td",{html:r.teammate}));
      tr.appendChild(el("td",{html:r.vs}));
      bdy.appendChild(tr);
    });
    t.appendChild(bdy);
    c.appendChild(t);
  }
  app.appendChild(c);
}

async function renderRecords(app){
  const playersAll=await DB.listPlayers(false);
  const playersById=new Map(playersAll.map(p=>[p.player_id,p]));
  const topN = state._recN || 25;

  const games=(await DB.listAllFinalizedGames()).sort((a,b)=>b.played_at.localeCompare(a.played_at));
  const gamesChrono=[...games].sort((a,b)=>a.played_at.localeCompare(b.played_at));

  const {cats, out} = await _buildTopPerformances(games, playersById, topN);
  const streaks = await _longestWinStreaks(gamesChrono);

  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:"All-Time Records"}));
  c.appendChild(el("div",{class:"p", html:`Top ${topN} across every season. Includes date + teammate + opponents.`}));

  const controls=el("div",{class:"controls", style:"margin-top:10px;"});
  const sel=el("select",{class:"input"});
  sel.innerHTML = `<option value="10">Top 10</option><option value="25">Top 25</option><option value="50">Top 50</option>`;
  sel.value = String(topN);
  sel.onchange=()=>{ state._recN = Number(sel.value); render(); };
  controls.appendChild(sel);
  c.appendChild(controls);

  for (const cat of cats){
    const list = out.get(cat.key) || [];
    c.appendChild(el("div",{class:"hr"}));
    c.appendChild(el("div",{class:"h2", html:`Top ${topN} • ${cat.label}`}));
    if(!list.length){ c.appendChild(el("div",{class:"p", html:"No games yet."})); continue; }
    const t=el("table",{class:"table"});
    t.appendChild(el("thead",{html:"<tr><th>#</th><th>Player</th><th>Value</th><th>Date</th><th>Teammate</th><th>vs</th></tr>"}));
    const bdy=el("tbody",{});
    list.forEach((r,i)=>{
      const tr=el("tr",{});
      tr.appendChild(el("td",{html:String(i+1)}));
      tr.appendChild(el("td",{html:`<b>${r.player}</b>`}));
      tr.appendChild(el("td",{html:`<b>${r.value}</b>`}));
      tr.appendChild(el("td",{html:r.date}));
      tr.appendChild(el("td",{html:r.teammate}));
      tr.appendChild(el("td",{html:r.vs}));
      bdy.appendChild(tr);
    });
    t.appendChild(bdy);
    c.appendChild(t);
  }

  c.appendChild(el("div",{class:"hr"}));
  c.appendChild(el("div",{class:"h2", html:`Top ${topN} • Longest Win Streak`}));
  const streakRows=[];
  for (const [pid,n] of streaks.entries()){
    streakRows.push({player:_pidName(pid, playersById), streak:n});
  }
  streakRows.sort((a,b)=>b.streak-a.streak);
  const t=el("table",{class:"table"});
  t.appendChild(el("thead",{html:"<tr><th>#</th><th>Player</th><th>Win Streak</th></tr>"}));
  const bdy=el("tbody",{});
  streakRows.slice(0,topN).forEach((r,i)=>{
    const tr=el("tr",{});
    tr.appendChild(el("td",{html:String(i+1)}));
    tr.appendChild(el("td",{html:`<b>${r.player}</b>`}));
    tr.appendChild(el("td",{html:`<b>${r.streak}</b>`}));
    bdy.appendChild(tr);
  });
  t.appendChild(bdy);
  c.appendChild(t);

  app.appendChild(c);
}

async function renderAwards(app){
  const playersAll=await DB.listPlayers(false);
  const playersById=new Map(playersAll.map(p=>[p.player_id,p]));

  const seasonGames=(await DB.listGamesForSeason(state.season.season_id, true)).sort((a,b)=>a.played_at.localeCompare(b.played_at));
  const allGames=(await DB.listAllFinalizedGames()).sort((a,b)=>a.played_at.localeCompare(b.played_at));

  const seasonElo = await _computeElo(seasonGames);
  const allElo = await _computeElo(allGames);

  async function totalsForGames(games){
    const totals=new Map();
    const init=()=>({GP:0,W:0,L:0, PTS:0, AST:0, STL:0, BLK:0});
    for (const g of games){
      const evs=await DB.listEventsForGame(g.game_id);
      const box=computeFromEvents(g, evs);
      for (const pid of [...g.sideA_player_ids, ...g.sideB_player_ids]){
        if(!totals.has(pid)) totals.set(pid, init());
        const t=totals.get(pid);
        t.GP += 1;
        const side = g.sideA_player_ids.includes(pid) ? "A" : "B";
        if(side===g.winner_side) t.W += 1; else t.L += 1;
        const line=box.lines.get(pid);
        const d=box.derived(pid);
        t.PTS += d.pts;
        t.AST += line["AST"];
        t.STL += line["STL"];
        t.BLK += line["BLK"];
      }
    }
    return totals;
  }

  const seasonTotals = await totalsForGames(seasonGames);
  const allTotals = await totalsForGames(allGames);

  const closeMargin=5;
  const seasonClose = seasonGames.filter(g=>Math.abs(g.final_score_a-g.final_score_b)<=closeMargin);
  const seasonCloseTotals = await totalsForGames(seasonClose);

  const minGames = 5;

  const root=el("div",{});
  const head=el("div",{class:"card section"});
  head.appendChild(el("div",{class:"h1", html:"Awards"}));
  head.appendChild(el("div",{class:"p", html:"Season awards + all-time awards (data-driven)."}));
  root.appendChild(head);

  const mkCard=(title, subtitle, lines)=>{
    const card=el("div",{class:"card section", style:"margin-top:12px;"});
    card.appendChild(el("div",{class:"h2", html:title}));
    if(subtitle) card.appendChild(el("div",{class:"p", html:subtitle}));
    if(!lines.length) card.appendChild(el("div",{class:"p", html:"No games yet."}));
    for(const l of lines) card.appendChild(el("div",{class:"p", html:l}));
    return card;
  };

  // Season winners
  const seasonLines=[];
  let mvpPid=null, mvpElo=-1e9;
  for (const [pid,r] of seasonElo.elo.entries()) if(r>mvpElo){mvpElo=r;mvpPid=pid;}
  if(mvpPid) seasonLines.push(`<b>MVP (Elo)</b>: ${_pidName(mvpPid, playersById)} • ${mvpElo.toFixed(0)}`);

  let scPid=null, sc=-1;
  for (const [pid,t] of seasonTotals.entries()){
    if(t.GP<minGames) continue;
    const ppg=t.PTS/t.GP;
    if(ppg>sc){sc=ppg;scPid=pid;}
  }
  if(scPid) seasonLines.push(`<b>Scoring Champ</b>: ${_pidName(scPid, playersById)} • ${sc.toFixed(1)} PPG (min ${minGames} GP)`);

  let defPid=null, dv=-1;
  for(const [pid,t] of seasonTotals.entries()){
    if(t.GP<minGames) continue;
    const v=(t.STL+t.BLK)/t.GP;
    if(v>dv){dv=v;defPid=pid;}
  }
  if(defPid) seasonLines.push(`<b>Defensive Anchor</b>: ${_pidName(defPid, playersById)} • ${dv.toFixed(2)} (STL+BLK)/G`);

  let clutchPid=null, cp=-1;
  for(const [pid,t] of seasonCloseTotals.entries()){
    if(t.GP<3) continue;
    const wp=t.W/t.GP;
    if(wp>cp){cp=wp;clutchPid=pid;}
  }
  if(clutchPid) seasonLines.push(`<b>Clutch Player</b>: ${_pidName(clutchPid, playersById)} • ${(cp*100).toFixed(0)}% win rate in ≤${closeMargin} margin games`);

  let impPid=null, imp=-1e9;
  for(const [pid,d] of seasonElo.delta.entries()){
    if(d>imp){imp=d;impPid=pid;}
  }
  if(impPid) seasonLines.push(`<b>Most Improved (Elo Δ)</b>: ${_pidName(impPid, playersById)} • +${imp.toFixed(0)}`);

  root.appendChild(mkCard("Season Awards", `Season: <b>${state.season.name}</b>`, seasonLines));

  // All-time winners
  const allLines=[];
  let amvpPid=null, amvp=-1e9;
  for (const [pid,r] of allElo.elo.entries()) if(r>amvp){amvp=r;amvpPid=pid;}
  if(amvpPid) allLines.push(`<b>All-Time MVP (Elo)</b>: ${_pidName(amvpPid, playersById)} • ${amvp.toFixed(0)}`);

  let ascPid=null, asc=-1;
  for (const [pid,t] of allTotals.entries()){
    if(t.GP<minGames) continue;
    const ppg=t.PTS/t.GP;
    if(ppg>asc){asc=ppg;ascPid=pid;}
  }
  if(ascPid) allLines.push(`<b>All-Time Scoring Champ</b>: ${_pidName(ascPid, playersById)} • ${asc.toFixed(1)} PPG (min ${minGames} GP)`);

  let adefPid=null, adv=-1;
  for(const [pid,t] of allTotals.entries()){
    if(t.GP<minGames) continue;
    const v=(t.STL+t.BLK)/t.GP;
    if(v>adv){adv=v;adefPid=pid;}
  }
  if(adefPid) allLines.push(`<b>All-Time Defensive Anchor</b>: ${_pidName(adefPid, playersById)} • ${adv.toFixed(2)} (STL+BLK)/G`);

  let aimpPid=null, aimp=-1e9;
  for(const [pid,d] of allElo.delta.entries()){
    if(d>aimp){aimp=d;aimpPid=pid;}
  }
  if(aimpPid) allLines.push(`<b>All-Time Most Improved (Elo Δ)</b>: ${_pidName(aimpPid, playersById)} • +${aimp.toFixed(0)}`);

  root.appendChild(mkCard("All-Time Awards", "Across every season (based on full history).", allLines));
  app.appendChild(root);
}


async function renderRecover(app){
  const h = await sbHealth();
  app.appendChild(el("div",{class:"card section", html:`<b>Recover from Cloud</b><br/><span class="muted">Use this only if events exist in Supabase but games/players were never created (or were lost locally). This will rebuild players + games from cloud events.</span>`}));

  if(!h.configured){
    app.appendChild(el("div",{class:"card section", html:`Cloud is not configured. Paste your Supabase URL + anon key into config.js.`}));
    return;
  }
  if(!h.signed_in){
    app.appendChild(el("div",{class:"card section", html:`Sign in first (Sync button) to recover. If you just signed in, refresh once then try again.`}));
    return;
  }

  const btn = el("button",{class:"btn", html:"Load cloud events"});
  const wrap = el("div",{class:"card section"});
  wrap.appendChild(btn);
  const out = el("div",{class:"p", html:""});
  wrap.appendChild(out);
  app.appendChild(wrap);

  btn.addEventListener("click", async ()=>{
    btn.disabled=true;
    out.innerHTML = `<div class="muted">Loading…</div>`;
    try{
      const [events, cloudPlayers, cloudGames, cloudSeasons] = await Promise.all([
        sbFetchAllEvents(), sbFetchPlayers(), sbFetchGames(), sbFetchSeasons()
      ]);

      // Group events by game_id
      const byGame = new Map();
      for(const e of events){
        if(!byGame.has(e.game_id)) byGame.set(e.game_id, []);
        byGame.get(e.game_id).push(e);
      }

      // Determine orphan game_ids (no games row)
      const cloudGameIds = new Set((cloudGames||[]).map(g=>g.game_id));
      const orphanGameIds = [...byGame.keys()].filter(id=>!cloudGameIds.has(id));

      // Determine player_ids seen in orphan games
      const seenPlayers = new Set();
      const gameMeta = orphanGameIds.map(gid=>{
        const evs = byGame.get(gid)||[];
        const pids = [...new Set(evs.map(x=>x.player_id))].slice(0,10);
        pids.forEach(pid=>seenPlayers.add(pid));
        const ts = evs.map(x=>x.timestamp).filter(Boolean).sort();
        const played_at = ts.length ? ts[ts.length-1] : new Date().toISOString();
        // compute per-player box
        const stat = new Map();
        for(const pid of pids){
          stat.set(pid,{twoM:0,twoMi:0,threeM:0,threeMi:0,ast:0,oreb:0,dreb:0,stl:0,blk:0});
        }
        for(const ev of evs){
          const s=stat.get(ev.player_id); if(!s) continue;
          const d=ev.delta||1;
          if(ev.stat_type==="2PM") s.twoM+=d;
          if(ev.stat_type==="2PMISS") s.twoMi+=d;
          if(ev.stat_type==="3PM") s.threeM+=d;
          if(ev.stat_type==="3PMISS") s.threeMi+=d;
          if(ev.stat_type==="AST") s.ast+=d;
          if(ev.stat_type==="OREB") s.oreb+=d;
          if(ev.stat_type==="DREB") s.dreb+=d;
          if(ev.stat_type==="STL") s.stl+=d;
          if(ev.stat_type==="BLK") s.blk+=d;
        }
        return {game_id:gid, played_at, player_ids:pids, stat};
      });

      const existingPlayersById = new Map((cloudPlayers||[]).map(p=>[p.player_id,p]));
      const missingPlayers = [...seenPlayers].filter(pid=>!existingPlayersById.has(pid));

      // render UI
      let html = `<div class="p"><b>Cloud status</b><br/>
        Events: ${events.length} • Games table rows: ${(cloudGames||[]).length} • Orphan games: ${orphanGameIds.length}</div>`;

      if(orphanGameIds.length===0){
        html += `<div class="card section">Nothing to recover. Games already exist in cloud.</div>`;
        out.innerHTML = html;
        btn.disabled=false;
        return;
      }

      // Season ensure
      const season = (cloudSeasons||[]).find(s=>!s.archived) || { season_id: "season_"+new Date().getFullYear(), name: "Driveway 2026", archived:false, created_at:new Date().toISOString() };

      html += `<div class="card section"><b>Step 1 — Name missing players</b><div class="muted">We found ${missingPlayers.length} player IDs in events that don’t exist in cloud players table yet.</div></div>`;
      html += `<div class="card section" id="recoverPlayers"></div>`;
      html += `<div class="card section"><b>Step 2 — Rebuild each game</b><div class="muted">For each orphan game, pick the 2 players on Side A. Side B will auto-fill. Then choose the winner.</div></div>`;
      html += `<div id="recoverGames"></div>`;
      html += `<div class="card section"><button class="btn" id="btnRecoverGo">Create players + games in cloud</button> <span class="muted" id="recoverMsg"></span></div>`;

      out.innerHTML = html;

      // build player naming form
      const rp = document.getElementById("recoverPlayers");
      const nameInputs = new Map();
      for(const pid of missingPlayers){
        const row = el("div",{class:"row", style:"justify-content:space-between; gap:10px; align-items:center; margin-top:10px;"});
        row.appendChild(el("div",{class:"mini muted", html:`${pid.slice(0,8)}…`}));        
        const inp = el("input",{class:"input", placeholder:"Player name", value:""});
        inp.style.flex="1";
        row.appendChild(inp);
        rp.appendChild(row);
        nameInputs.set(pid, inp);
      }
      if(missingPlayers.length===0){
        rp.appendChild(el("div",{class:"muted", html:"No missing players."}));
      }

      // build games UI
      const rg = document.getElementById("recoverGames");
      const gameUI = new Map(); // gid -> {checks, winner}
      const nameOf = (pid)=>{
        const p = existingPlayersById.get(pid);
        if(p && p.name) return p.name;
        const inp = nameInputs.get(pid);
        return inp && inp.value ? inp.value : pid.slice(0,6);
      };

      for(const gm of gameMeta){
        const card = el("div",{class:"card section"});
        card.appendChild(el("div",{html:`<b>Game</b> <span class="muted">${gm.played_at.slice(0,19).replace("T"," ")}</span><br/><span class="mini muted">${gm.game_id}</span>`}));
        // player list with checkboxes
        const checks = new Map();
        const grid = el("div",{class:"grid2", style:"margin-top:10px;"});
        for(const pid of gm.player_ids){
          const pCard = el("div",{class:"card mini-card"});
          const cb = el("input",{});
          cb.type="checkbox";
          pCard.appendChild(el("div",{class:"row", style:"justify-content:space-between; align-items:center; gap:10px;", html:`<b>${nameOf(pid)}</b>`}));
          pCard.appendChild(cb);
          // stats line
          const s = gm.stat.get(pid);
          const twoA = s.twoM+s.twoMi;
          const threeA = s.threeM+s.threeMi;
          const pts = s.twoM*2 + s.threeM*3;
          pCard.appendChild(el("div",{class:"mini muted", html:`PTS ${pts} • 2s ${s.twoM}/${twoA} • 3s ${s.threeM}/${threeA} • REB ${s.oreb+s.dreb} • AST ${s.ast}`}));
          grid.appendChild(pCard);
          checks.set(pid, cb);
          cb.addEventListener("change", ()=>{
            // enforce max 2
            const sel=[...checks.entries()].filter(([_,c])=>c.checked).map(([pid])=>pid);
            if(sel.length>2){
              cb.checked=false;
            }
          });
        }
        card.appendChild(el("div",{class:"small-note", html:"Check exactly 2 players for Side A"}));
        card.appendChild(grid);

        const winner = el("select",{class:"input"});
        winner.innerHTML = `<option value="A">Winner: Side A</option><option value="B">Winner: Side B</option>`;
        card.appendChild(winner);

        rg.appendChild(card);
        gameUI.set(gm.game_id, {checks, winner, meta:gm});
      }

      document.getElementById("btnRecoverGo").onclick = async ()=>{
        const msg = document.getElementById("recoverMsg");
        msg.textContent = "Working…";
        try{
          // create season in cloud if none exists
          await sbUpsertSeason(season);

          // create players (missing)
          const newPlayers = [];
          for(const [pid, inp] of nameInputs.entries()){
            const nm = (inp.value||"").trim();
            if(!nm) throw new Error("Every missing player must have a name.");
            newPlayers.push({ player_id: pid, name: nm, active: true, created_at: new Date().toISOString() });
          }
          if(newPlayers.length) await sbUpsertPlayers(newPlayers);

          // create each game
          for(const [gid, ui] of gameUI.entries()){
            const sel=[...ui.checks.entries()].filter(([_,c])=>c.checked).map(([pid])=>pid);
            if(sel.length!==2) throw new Error("Each game must have exactly 2 Side A players checked.");
            const sideA=sel;
            const sideB=[...ui.checks.keys()].filter(pid=>!sideA.includes(pid));
            if(sideB.length!==2) throw new Error("Each game must have exactly 4 players total.");
            // compute side scores
            const ptsFor=(pid)=>{
              const s=ui.meta.stat.get(pid);
              return s.twoM*2 + s.threeM*3;
            };
            const aScore=ptsFor(sideA[0])+ptsFor(sideA[1]);
            const bScore=ptsFor(sideB[0])+ptsFor(sideB[1]);
            const game = {
              game_id: gid,
              season_id: season.season_id,
              played_at: ui.meta.played_at,
              finalized: true,
              sideA_player_ids: sideA,
              sideB_player_ids: sideB,
              sideA_score: aScore,
              sideB_score: bScore,
              winner_side: ui.winner.value
            };
            await sbUpsertGame(game);
          }

          msg.textContent = "Done. Now tap Sync to download everything to this device.";
        }catch(e){
          msg.textContent = "Error: " + (e.message||e);
        }
      };

    }catch(e){
      out.innerHTML = `<div class="card section"><b>Recover error</b><br/><span class="muted">${(e.message||e)}</span></div>`;
    } finally {
      btn.disabled=false;
    }
  });
}
async function renderDraft(app){
  const playersAll=await DB.listPlayers(false);
  const playersById=new Map(playersAll.map(p=>[p.player_id,p]));
  const active = playersAll.filter(p=>p.active);

  const seasonGames=(await DB.listGamesForSeason(state.season.season_id, true)).sort((a,b)=>a.played_at.localeCompare(b.played_at));
  const eloRes=await _computeElo(seasonGames);
  const getElo=(pid)=> eloRes.elo.get(pid) ?? 1000;

  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:`Draft • ${state.season.name}`}));
  c.appendChild(el("div",{class:"p", html:"Select who’s here today. If more than 4 are selected, it randomly picks 4, then splits teams balanced by Elo."}));

  const present=new Set(state._presentPlayers || []);

  const controls=el("div",{class:"controls", style:"margin-top:10px;"});
  controls.appendChild(el("button",{class:"btn", html:"Select all", onclick:()=>{ state._presentPlayers = active.map(p=>p.player_id); render(); }}));
  controls.appendChild(el("button",{class:"btn ghost", html:"Clear", onclick:()=>{ state._presentPlayers=[]; state._draft=null; render(); }}));
  c.appendChild(controls);

  const tbl=el("table",{class:"table", style:"margin-top:10px;"});
  tbl.appendChild(el("thead",{html:"<tr><th>Here</th><th>Player</th><th>Elo</th></tr>"}));
  const bdy=el("tbody",{});
  for(const p of active){
    const tr=el("tr",{});
    const cb=document.createElement("input");
    cb.type="checkbox";
    cb.checked=present.has(p.player_id);
    cb.onchange=()=>{
      const s=new Set(state._presentPlayers || []);
      if(cb.checked) s.add(p.player_id); else s.delete(p.player_id);
      state._presentPlayers=[...s];
    };
    const td0=el("td",{}); td0.appendChild(cb);
    tr.appendChild(td0);
    tr.appendChild(el("td",{html:`<b>${p.name}</b>`}));
    tr.appendChild(el("td",{html:getElo(p.player_id).toFixed(0)}));
    bdy.appendChild(tr);
  }
  tbl.appendChild(bdy);
  c.appendChild(tbl);

  const btn=el("button",{class:"btn ok", style:"margin-top:12px;", html:"Randomize Teams", onclick:()=>{
    const selected = state._presentPlayers || [];
    if(selected.length<4){
      showModal("Need 4 players", "Select at least <b>4</b> players who are present.", [{label:"OK", kind:"ghost"}]);
      return;
    }
    // shuffle and pick 4
    const pool=[...selected];
    for(let i=pool.length-1;i>0;i--){
      const j=Math.floor(Math.random()*(i+1));
      [pool[i],pool[j]]=[pool[j],pool[i]];
    }
    const pick=pool.slice(0,4);

    // best balanced split
    const combos=[
      [[pick[0],pick[1]],[pick[2],pick[3]]],
      [[pick[0],pick[2]],[pick[1],pick[3]]],
      [[pick[0],pick[3]],[pick[1],pick[2]]],
    ];
    let best=null;
    for(const [A,B] of combos){
      const sumA=getElo(A[0])+getElo(A[1]);
      const sumB=getElo(B[0])+getElo(B[1]);
      const diff=Math.abs(sumA-sumB);
      const score=diff + (Math.random()*0.001);
      if(!best || score<best.score) best={A,B,sumA,sumB,diff,score};
    }
    state._draft=best;
    render();
  }});
  c.appendChild(btn);

  if(state._draft){
    const d=state._draft;
    const teamBox=el("div",{class:"pair-grid", style:"margin-top:12px;"});
    const cardA=el("div",{class:"card section"});
    cardA.appendChild(el("div",{class:"h2", html:`Team A (Elo ${d.sumA.toFixed(0)})`}));
    cardA.appendChild(el("div",{class:"p", html:`<b>${_pidName(d.A[0], playersById)}</b> • ${getElo(d.A[0]).toFixed(0)}`}));
    cardA.appendChild(el("div",{class:"p", html:`<b>${_pidName(d.A[1], playersById)}</b> • ${getElo(d.A[1]).toFixed(0)}`}));

    const cardB=el("div",{class:"card section"});
    cardB.appendChild(el("div",{class:"h2", html:`Team B (Elo ${d.sumB.toFixed(0)})`}));
    cardB.appendChild(el("div",{class:"p", html:`<b>${_pidName(d.B[0], playersById)}</b> • ${getElo(d.B[0]).toFixed(0)}`}));
    cardB.appendChild(el("div",{class:"p", html:`<b>${_pidName(d.B[1], playersById)}</b> • ${getElo(d.B[1]).toFixed(0)}`}));

    teamBox.appendChild(cardA);
    teamBox.appendChild(cardB);
    c.appendChild(el("div",{class:"p", style:"margin-top:10px;", html:`Balance diff: <b>${d.diff.toFixed(0)}</b> Elo points`}));
    c.appendChild(teamBox);
  } else {
    c.appendChild(el("div",{class:"p", style:"margin-top:10px;", html:"No draft yet."}));
  }

  app.appendChild(c);
}
