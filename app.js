// UI + routing + live stat tracking
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

async function init(){
  document.querySelectorAll(".nav-btn").forEach(b=>b.addEventListener("click", ()=>setRoute(b.dataset.route)));
  $("#btnExportQuick").addEventListener("click", async()=>{ if(state.season) await exportSeason(state.season); });
  $("#btnSettings").addEventListener("click", async()=>{
    const auto=await DB.getSetting("auto_export_finalize", true);
    showModal("Settings",
      `<div class="row" style="justify-content:space-between;">
        <div><b>Auto-export after Finalize</b><div class="kbd">Downloads game + season exports after each finalize</div></div>
        <button class="btn ${auto?"ok":"ghost"}" id="toggleAuto">${auto?"ON":"OFF"}</button>
      </div>`,
      [{label:"Close", kind:"ghost"}]
    );
    setTimeout(()=>{
      const t=document.getElementById("toggleAuto");
      if(!t) return;
      t.onclick=async()=>{
        const cur=await DB.getSetting("auto_export_finalize", true);
        await DB.setSetting("auto_export_finalize", !cur);
        hideModal();
      };
    },0);
  });

  state.season=await DB.ensureDefaultSeason();
  $("#seasonSub").textContent=`Season: ${state.season.name}`;
  setRoute("home");
}
init();

async function refreshPlayers(){ state.players=await DB.listPlayers(true); }

async function render(){
  const app=$("#app"); app.innerHTML="";
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
  c.appendChild(el("div",{class:"p", html:"2v2 driveway stat tracker. Data stays on this iPad."}));
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
  tips.appendChild(el("div",{class:"h2", html:"Tips"}));
  tips.appendChild(el("div",{class:"p", html:"On iPad Safari: Share → Add to Home Screen."}));
  tips.appendChild(el("div",{class:"p", html:"Export regularly for backups (downloads CSV + JSON)."}));
  app.appendChild(tips);
}

async function renderPlayers(app){
  await refreshPlayers();
  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:"Players"}));
  c.appendChild(el("div",{class:"p", html:"Add players once. Archive later if needed."}));

  const input=el("input",{class:"input", placeholder:"Add player name…"});
  const add=el("button",{class:"btn ok", html:"Add", onclick:async()=>{
    const name=input.value.trim();
    if(!name) return;
    await DB.addPlayer(name);
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
      showModal("Archive player?",
        `Hide <b>${p.name}</b> from selection but keep all historical stats.`,
        [{label:"Cancel", kind:"ghost"},{label:"Archive", kind:"danger", onClick:async()=>{ p.active=false; await DB.updatePlayer(p); render(); }}]
      );
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

  const addEvent=async(pid, stat)=>{ await DB.addEvent(game.game_id, pid, stat); render(); };

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
    await DB.updateGame(game);

    const auto=await DB.getSetting("auto_export_finalize", true);
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
      [{label:"Cancel", kind:"ghost"},{label:"Discard", kind:"danger", onClick:async()=>{ await DB.deleteGame(game.game_id); state.currentGame=null; setRoute("home"); }}]
    );
  }}));
  c.appendChild(row);
  app.appendChild(c);
}

async function renderDashboard(app){
  const games=await DB.listGamesForSeason(state.season.season_id, true);
  const playersAll=await DB.listPlayers(false);
  const playersById=new Map(playersAll.map(p=>[p.player_id,p]));
  const name=(id)=>playersById.get(id)?.name||"—";

  const totals=new Map();
  const init=()=>({GP:0,W:0,L:0, PTS:0, AST:0, OREB:0, DREB:0, STL:0, BLK:0, twoM:0,twoA:0, threeM:0,threeA:0});
  for(const g of games){
    const evs=await DB.listEventsForGame(g.game_id);
    const box=computeFromEvents(g, evs);
    const sideMap=new Map();
    for(const pid of g.sideA_player_ids) sideMap.set(pid,"A");
    for(const pid of g.sideB_player_ids) sideMap.set(pid,"B");
    const winner=g.winner_side;

    for(const pid of [...g.sideA_player_ids, ...g.sideB_player_ids]){
      if(!totals.has(pid)) totals.set(pid, init());
      const t=totals.get(pid);
      const side=sideMap.get(pid);
      t.GP += 1;
      if(side===winner) t.W += 1; else t.L += 1;
      const line=box.lines.get(pid);
      const d=box.derived(pid);
      t.PTS += d.pts; t.AST += line["AST"]; t.OREB += line["OREB"]; t.DREB += line["DREB"]; t.STL += line["STL"]; t.BLK += line["BLK"];
      t.twoM += line["2PM"]; t.twoA += d.twoA; t.threeM += line["3PM"]; t.threeA += d.threeA;
    }
  }

  const rows=[];
  for(const [pid,t] of totals.entries()){
    const reb=t.OREB+t.DREB;
    const twoPct=t.twoA? (t.twoM/t.twoA): null;
    const threePct=t.threeA? (t.threeM/t.threeA): null;
    rows.push({
      player:name(pid), GP:t.GP, WL:`${t.W}-${t.L}`,
      ppg:(t.GP? t.PTS/t.GP:0), rpg:(t.GP? reb/t.GP:0), apg:(t.GP? t.AST/t.GP:0),
      spg:(t.GP? t.STL/t.GP:0), bpg:(t.GP? t.BLK/t.GP:0),
      twoPct, threePct
    });
  }
  rows.sort((a,b)=>b.ppg-a.ppg);

  const c=el("div",{class:"card section"});
  c.appendChild(el("div",{class:"h1", html:`Dashboard • ${state.season.name}`}));  
  c.appendChild(el("div",{class:"p", html:`Games: <b>${games.length}</b> • Tap Export for full CSVs + teammate/opponent summaries.`}));

  const tbl=el("table",{class:"table", style:"margin-top:12px;"});
  tbl.appendChild(el("thead",{html:"<tr><th>Player</th><th>GP</th><th>W-L</th><th>PTS/G</th><th>REB/G</th><th>AST/G</th><th>STL/G</th><th>BLK/G</th><th>2P%</th><th>3P%</th></tr>"}));
  const tb=el("tbody",{});
  const pct=(x)=> x===null? "—" : (x*100).toFixed(0)+"%";
  for(const r of rows){
    const tr=el("tr",{});
    tr.appendChild(el("td",{html:`<b>${r.player}</b>`}));
    tr.appendChild(el("td",{html:r.GP}));
    tr.appendChild(el("td",{html:r.WL}));
    tr.appendChild(el("td",{html:r.ppg.toFixed(1)}));
    tr.appendChild(el("td",{html:r.rpg.toFixed(1)}));
    tr.appendChild(el("td",{html:r.apg.toFixed(1)}));
    tr.appendChild(el("td",{html:r.spg.toFixed(1)}));
    tr.appendChild(el("td",{html:r.bpg.toFixed(1)}));
    tr.appendChild(el("td",{html:pct(r.twoPct)}));
    tr.appendChild(el("td",{html:pct(r.threePct)}));
    tb.appendChild(tr);
  }
  tbl.appendChild(tb);
  c.appendChild(tbl);

  const log=el("div",{class:"card section", style:"margin-top:12px;"});
  log.appendChild(el("div",{class:"h2", html:"Game Log"}));
  if(!games.length) log.appendChild(el("div",{class:"p", html:"No finalized games yet."}));
  else{
    const lt=el("table",{class:"table"});
    lt.appendChild(el("thead",{html:"<tr><th>Date</th><th>Matchup</th><th>Final</th></tr>"}));
    const ltb=el("tbody",{});
    for(const g of games.slice(0,25)){
      const [a1,a2]=g.sideA_player_ids, [b1,b2]=g.sideB_player_ids;
      const matchup=`${name(a1)} + ${name(a2)} vs ${name(b1)} + ${name(b2)}`;
      const tr=el("tr",{});
      tr.style.cursor="pointer";
      tr.onclick=()=>{ state.currentGame=g; setRoute("recap"); };
      tr.appendChild(el("td",{html:g.played_at.slice(0,10)}));
      tr.appendChild(el("td",{html:matchup}));
      tr.appendChild(el("td",{html:`${g.final_score_a} — ${g.final_score_b} (W: ${g.winner_side})`}));
      ltb.appendChild(tr);
    }
    lt.appendChild(ltb);
    log.appendChild(lt);
  }

  app.appendChild(c);
  app.appendChild(log);
}
