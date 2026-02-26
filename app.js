// UI + routing + live stat tracking (with Supabase cloud backup)
let state = { route:"home", season:null, players:[], currentGame:null };

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
  document.querySelectorAll(".nav-btn").forEach(b=>b.classList.toggle("active", b.dataset.route===r));
  render();
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
      hideModal();
      await updateHeaderSeason();
      render();
      showModal("Sync complete", `Pushed: <b>${up.pushed}</b><br/>Cloud rows pulled: players ${down.players}, seasons ${down.seasons}, games ${down.games}, events ${down.events}`, [{label:"OK", kind:"ghost"}]);
    } catch(e){
      hideModal();
      showModal("Sync error", (e && e.message) ? e.message : String(e), [{label:"OK", kind:"ghost"}]);
    }
  });

  $("#btnSettings").addEventListener("click", async()=>{
    const auto=await DB.getSetting("auto_export_finalize", false); // default OFF now
    showModal("Settings",
      `<div class="row" style="justify-content:space-between;">
        <div><b>Auto-export after Finalize</b><div class="kbd">If ON, downloads exports after each finalized game</div></div>
        <button class="btn ${auto?"ok":"ghost"}" id="toggleAuto">${auto?"ON":"OFF"}</button>
      </div>`,
      [{label:"Close", kind:"ghost"}]
    );
    setTimeout(()=>{
      const t=document.getElementById("toggleAuto");
      if(!t) return;
      t.onclick=async()=>{
        const cur=await DB.getSetting("auto_export_finalize", false);
        await DB.setSetting("auto_export_finalize", !cur);
        hideModal();
      };
    },0);
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
  let dotClass = "dot";
  let text = "Local only";
  if (h.configured && h.signed_in) {
    dotClass = (h.pending_ops===0) ? "dot ok" : "dot warn";
    text = (h.pending_ops===0) ? `Cloud ✓ (${h.email})` : `Cloud pending (${h.pending_ops})`;
  } else if (h.configured && !h.signed_in) {
    dotClass = "dot warn";
    text = "Cloud (not signed in)";
  } else {
    dotClass = "dot";
    text = "Cloud not set";
  }
  const bar = el("div",{class:"cloudbar"});
  bar.appendChild(el("div",{class:"cloud-pill", html:`<span class="${dotClass}"></span>${text}`}));
  if (h.configured && !h.signed_in) {
    bar.appendChild(el("button",{class:"btn ghost", html:"Sign in", onclick:()=>setRoute("login")}));
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
}

function renderHome(app){
  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:"Home"}));
  c.appendChild(el("div",{class:"p", html:"2v2 driveway stat tracker. Saves locally and (optionally) backs up to Supabase cloud."}));
  const row=el("div",{class:"row"});
  row.appendChild(el("button",{class:"btn ok", html:"Start Game", onclick:()=>setRoute("start")}));
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
    tr.appendChild(el("td",{html:`<b>${p.name}</b><div class="kbd">${p.player_id.slice(0,8)}</div>`}));
    const td=el("td",{});
    td.appendChild(el("button",{class:"btn small ghost", html:"Archive", onclick:async()=>{
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
  const game=state.currentGame;
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
  app.appendChild(scoreCard);

  const grid=el("div",{class:"grid4"});
  const sideMap=new Map();
  for(const pid of game.sideA_player_ids) sideMap.set(pid,"A");
  for(const pid of game.sideB_player_ids) sideMap.set(pid,"B");

  const addEvent=async(pid, stat)=>{
    const ev = await DB.addEvent(game.game_id, pid, stat);
    await DB.enqueueOp("upsert_event", ev);
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
