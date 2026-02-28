// Export helpers: CSV + JSON backup + teammate/opponent summaries
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function downloadBlob(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function toCSV(headers, rows) {
  const lines = [];
  lines.push(headers.map(csvEscape).join(","));
  for (const r of rows) {
    lines.push(headers.map(h => csvEscape(r[h])).join(","));
  }
  return lines.join("\n");
}

const STAT_TYPES = ["2PM","2PMISS","3PM","3PMISS","AST","OREB","DREB","BLK","STL"];

function emptyLine() {
  const o = {};
  for (const s of STAT_TYPES) o[s] = 0;
  return o;
}

function computeDerived(line) {
  const twoPA = line["2PM"] + line["2PMISS"];
  const threePA = line["3PM"] + line["3PMISS"];
  const pts = line["2PM"]*2 + line["3PM"]*3;
  const reb = line["OREB"] + line["DREB"];
  const twoPct = twoPA > 0 ? (line["2PM"]/twoPA) : null;
  const threePct = threePA > 0 ? (line["3PM"]/threePA) : null;
  return { twoPA, threePA, pts, reb, twoPct, threePct };
}

async function buildGameBox(game) {
  const events = await DB.listEventsForGame(game.game_id);
  const lines = new Map();
  const allPids = [...game.sideA_player_ids, ...game.sideB_player_ids];
  for (const pid of allPids) lines.set(pid, emptyLine());
  for (const ev of events) {
    if (!lines.has(ev.player_id)) continue;
    const line = lines.get(ev.player_id);
    line[ev.stat_type] = (line[ev.stat_type] || 0) + (ev.delta || 1);
  }
  const scoreA = game.sideA_player_ids.reduce((sum,pid)=> sum + computeDerived(lines.get(pid)).pts, 0);
  const scoreB = game.sideB_player_ids.reduce((sum,pid)=> sum + computeDerived(lines.get(pid)).pts, 0);
  const winner_side = scoreA > scoreB ? "A" : "B";
  return { events, lines, scoreA, scoreB, winner_side };
}

async function exportSeason(season) {
  const players = await DB.listPlayers(false);
  const seasons = await DB.listSeasons(true);
  const games = await DB.listGamesForSeason(season.season_id, true);
  const playersById = new Map(players.map(p => [p.player_id, p]));

  const allEvents = [];
  for (const g of games) {
    const ev = await DB.listEventsForGame(g.game_id);
    allEvents.push(...ev);
  }
  const backup = { exported_at: new Date().toISOString(), players, seasons, games, events: allEvents };

  const stamp = new Date().toISOString().slice(0,10);
  const seasonSlug = season.name.replace(/\s+/g,'_');

  // players.csv
  const playersHeaders = ["player_id","name","created_at","active"];
  const playersRows = players.map(p => ({ player_id:p.player_id, name:p.name, created_at:p.created_at, active:p.active }));

  // games.csv
  const gamesHeaders = [
    "game_id","season_id","played_at",
    "sideA_p1_id","sideA_p1_name","sideA_p2_id","sideA_p2_name",
    "sideB_p1_id","sideB_p1_name","sideB_p2_id","sideB_p2_name",
    "final_score_a","final_score_b","winner_side"
  ];
  const gamesRows = games.map(g => {
    const [a1,a2]=g.sideA_player_ids, [b1,b2]=g.sideB_player_ids;
    return {
      game_id:g.game_id, season_id:g.season_id, played_at:g.played_at,
      sideA_p1_id:a1, sideA_p1_name:(((playersById.get(a1) && playersById.get(a1).name) || "")||""),
      sideA_p2_id:a2, sideA_p2_name:(((playersById.get(a2) && playersById.get(a2).name) || "")||""),
      sideB_p1_id:b1, sideB_p1_name:(((playersById.get(b1) && playersById.get(b1).name) || "")||""),
      sideB_p2_id:b2, sideB_p2_name:(((playersById.get(b2) && playersById.get(b2).name) || "")||""),
      final_score_a:g.final_score_a, final_score_b:g.final_score_b, winner_side:g.winner_side
    };
  });

  // player_game_stats.csv
  const pgsHeaders = [
    "season_id","season_name","game_id","played_at",
    "player_id","player_name","side",
    "teammate_id","teammate_name",
    "opp1_id","opp1_name","opp2_id","opp2_name",
    "result",
    "2PM","2PMISS","2PA","2P_PCT","3PM","3PMISS","3PA","3P_PCT",
    "PTS","AST","OREB","DREB","REB","STL","BLK"
  ];
  const pgsRows = [];
  for (const g of games) {
    const { lines } = await buildGameBox(g);
    const sideMap = new Map();
    for (const pid of g.sideA_player_ids) sideMap.set(pid, "A");
    for (const pid of g.sideB_player_ids) sideMap.set(pid, "B");
    const winnerSide = g.winner_side;

    for (const pid of [...g.sideA_player_ids, ...g.sideB_player_ids]) {
      const side = sideMap.get(pid);
      const teammate_id = side === "A" ? g.sideA_player_ids.find(x=>x!==pid) : g.sideB_player_ids.find(x=>x!==pid);
      const opps = side === "A" ? g.sideB_player_ids : g.sideA_player_ids;
      const line = lines.get(pid) || emptyLine();
      const d = computeDerived(line);
      pgsRows.push({
        season_id:season.season_id, season_name:season.name, game_id:g.game_id, played_at:g.played_at,
        player_id:pid, player_name:(((playersById.get(pid) && playersById.get(pid).name) || "")||""), side,
        teammate_id, teammate_name:(((playersById.get(teammate_id) && playersById.get(teammate_id).name) || "")||""),
        opp1_id:opps[0], opp1_name:(((playersById.get(opps[0]) && playersById.get(opps[0]).name) || "")||""),
        opp2_id:opps[1], opp2_name:(((playersById.get(opps[1]) && playersById.get(opps[1]).name) || "")||""),
        result:(side===winnerSide)?"W":"L",
        "2PM":line["2PM"], "2PMISS":line["2PMISS"], "2PA":d.twoPA, "2P_PCT":d.twoPct===null?"":d.twoPct.toFixed(4),
        "3PM":line["3PM"], "3PMISS":line["3PMISS"], "3PA":d.threePA, "3P_PCT":d.threePct===null?"":d.threePct.toFixed(4),
        "PTS":d.pts, "AST":line["AST"], "OREB":line["OREB"], "DREB":line["DREB"], "REB":d.reb, "STL":line["STL"], "BLK":line["BLK"]
      });
    }
  }

  // player_season_totals.csv
  const pstHeaders = [
    "season_id","season_name","player_id","player_name",
    "GP","W","L","WIN_PCT",
    "2PM","2PMISS","2PA","2P_PCT",
    "3PM","3PMISS","3PA","3P_PCT",
    "PTS","PTS_PER_GAME",
    "AST","AST_PER_GAME",
    "OREB","OREB_PER_GAME",
    "DREB","DREB_PER_GAME",
    "REB","REB_PER_GAME",
    "STL","STL_PER_GAME",
    "BLK","BLK_PER_GAME"
  ];
  const totals = new Map();
  for (const r of pgsRows) {
    const pid = r.player_id;
    if (!totals.has(pid)) totals.set(pid, {GP:0,W:0,L:0, twoM:0,twoA:0, threeM:0,threeA:0, PTS:0, AST:0, OREB:0, DREB:0, STL:0, BLK:0});
    const t = totals.get(pid);
    t.GP += 1;
    if (r.result==="W") t.W += 1; else t.L += 1;
    t.twoM += +r["2PM"]; t.twoA += +r["2PA"];
    t.threeM += +r["3PM"]; t.threeA += +r["3PA"];
    t.PTS += +r["PTS"]; t.AST += +r["AST"]; t.OREB += +r["OREB"]; t.DREB += +r["DREB"]; t.STL += +r["STL"]; t.BLK += +r["BLK"];
  }
  const pstRows = [];
  for (const [pid,t] of totals.entries()) {
    const reb = t.OREB + t.DREB;
    const winPct = t.GP ? (t.W/t.GP) : 0;
    const twoPct = t.twoA ? (t.twoM/t.twoA) : null;
    const threePct = t.threeA ? (t.threeM/t.threeA) : null;
    const per = (x)=> t.GP ? (x/t.GP) : 0;
    pstRows.push({
      season_id:season.season_id, season_name:season.name, player_id:pid, player_name:(((playersById.get(pid) && playersById.get(pid).name) || "")||""),
      GP:t.GP, W:t.W, L:t.L, WIN_PCT:t.GP?winPct.toFixed(4):"",
      "2PM":t.twoM, "2PMISS":(t.twoA - t.twoM), "2PA":t.twoA, "2P_PCT":twoPct===null?"":twoPct.toFixed(4),
      "3PM":t.threeM, "3PMISS":(t.threeA - t.threeM), "3PA":t.threeA, "3P_PCT":threePct===null?"":threePct.toFixed(4),
      "PTS":t.PTS, "PTS_PER_GAME":per(t.PTS).toFixed(2),
      "AST":t.AST, "AST_PER_GAME":per(t.AST).toFixed(2),
      "OREB":t.OREB, "OREB_PER_GAME":per(t.OREB).toFixed(2),
      "DREB":t.DREB, "DREB_PER_GAME":per(t.DREB).toFixed(2),
      "REB":reb, "REB_PER_GAME":per(reb).toFixed(2),
      "STL":t.STL, "STL_PER_GAME":per(t.STL).toFixed(2),
      "BLK":t.BLK, "BLK_PER_GAME":per(t.BLK).toFixed(2)
    });
  }
  pstRows.sort((a,b)=> parseFloat(b.PTS_PER_GAME)-parseFloat(a.PTS_PER_GAME));

  // with_teammate_summary.csv
  const withHeaders = [
    "season_id","season_name","player_id","player_name","teammate_id","teammate_name",
    "GP","W","L","WIN_PCT","PTS_PER_GAME","AST_PER_GAME","REB_PER_GAME","STL_PER_GAME","BLK_PER_GAME","2P_PCT","3P_PCT"
  ];
  const withMap = new Map();
  for (const r of pgsRows) {
    const key = r.player_id + "::" + r.teammate_id;
    if (!withMap.has(key)) withMap.set(key, {GP:0,W:0,L:0, PTS:0,AST:0,REB:0,STL:0,BLK:0, twoM:0,twoA:0, threeM:0,threeA:0, meta:r});
    const t = withMap.get(key);
    t.GP += 1;
    if (r.result==="W") t.W += 1; else t.L += 1;
    t.PTS += +r.PTS; t.AST += +r.AST; t.REB += +r.REB; t.STL += +r.STL; t.BLK += +r.BLK;
    t.twoM += +r["2PM"]; t.twoA += +r["2PA"]; t.threeM += +r["3PM"]; t.threeA += +r["3PA"];
  }
  const withRows = [];
  for (const [k,t] of withMap.entries()) {
    const r = t.meta;
    const winPct = t.GP ? (t.W/t.GP) : 0;
    const twoPct = t.twoA ? (t.twoM/t.twoA) : null;
    const threePct = t.threeA ? (t.threeM/t.threeA) : null;
    withRows.push({
      season_id:season.season_id, season_name:season.name,
      player_id:r.player_id, player_name:r.player_name, teammate_id:r.teammate_id, teammate_name:r.teammate_name,
      GP:t.GP, W:t.W, L:t.L, WIN_PCT:t.GP?winPct.toFixed(4):"",
      PTS_PER_GAME:(t.PTS/t.GP).toFixed(2), AST_PER_GAME:(t.AST/t.GP).toFixed(2), REB_PER_GAME:(t.REB/t.GP).toFixed(2),
      STL_PER_GAME:(t.STL/t.GP).toFixed(2), BLK_PER_GAME:(t.BLK/t.GP).toFixed(2),
      "2P_PCT":twoPct===null?"":twoPct.toFixed(4), "3P_PCT":threePct===null?"":threePct.toFixed(4)
    });
  }
  withRows.sort((a,b)=> b.GP - a.GP);

  // vs_opponent_summary.csv
  const vsHeaders = [
    "season_id","season_name","player_id","player_name","opponent_id","opponent_name",
    "GP","W","L","WIN_PCT","PTS_PER_GAME","AST_PER_GAME","REB_PER_GAME","STL_PER_GAME","BLK_PER_GAME","2P_PCT","3P_PCT"
  ];
  const vsMap = new Map();
  for (const r of pgsRows) {
    for (const opp of [{id:r.opp1_id, name:r.opp1_name},{id:r.opp2_id, name:r.opp2_name}]) {
      const key = r.player_id + "::" + opp.id;
      if (!vsMap.has(key)) vsMap.set(key, {GP:0,W:0,L:0, PTS:0,AST:0,REB:0,STL:0,BLK:0, twoM:0,twoA:0, threeM:0,threeA:0, meta:{...r, opponent_id:opp.id, opponent_name:opp.name}});
      const t = vsMap.get(key);
      t.GP += 1;
      if (r.result==="W") t.W += 1; else t.L += 1;
      t.PTS += +r.PTS; t.AST += +r.AST; t.REB += +r.REB; t.STL += +r.STL; t.BLK += +r.BLK;
      t.twoM += +r["2PM"]; t.twoA += +r["2PA"]; t.threeM += +r["3PM"]; t.threeA += +r["3PA"];
    }
  }
  const vsRows = [];
  for (const [k,t] of vsMap.entries()) {
    const m = t.meta;
    const winPct = t.GP ? (t.W/t.GP) : 0;
    const twoPct = t.twoA ? (t.twoM/t.twoA) : null;
    const threePct = t.threeA ? (t.threeM/t.threeA) : null;
    vsRows.push({
      season_id:season.season_id, season_name:season.name,
      player_id:m.player_id, player_name:m.player_name, opponent_id:m.opponent_id, opponent_name:m.opponent_name,
      GP:t.GP, W:t.W, L:t.L, WIN_PCT:t.GP?winPct.toFixed(4):"",
      PTS_PER_GAME:(t.PTS/t.GP).toFixed(2), AST_PER_GAME:(t.AST/t.GP).toFixed(2), REB_PER_GAME:(t.REB/t.GP).toFixed(2),
      STL_PER_GAME:(t.STL/t.GP).toFixed(2), BLK_PER_GAME:(t.BLK/t.GP).toFixed(2),
      "2P_PCT":twoPct===null?"":twoPct.toFixed(4), "3P_PCT":threePct===null?"":threePct.toFixed(4)
    });
  }
  vsRows.sort((a,b)=> b.GP - a.GP);

  // downloads
  downloadBlob(`players_${stamp}.csv`, "text/csv", toCSV(playersHeaders, playersRows));
  downloadBlob(`games_${seasonSlug}_${stamp}.csv`, "text/csv", toCSV(gamesHeaders, gamesRows));
  downloadBlob(`player_game_stats_${seasonSlug}_${stamp}.csv`, "text/csv", toCSV(pgsHeaders, pgsRows));
  downloadBlob(`player_season_totals_${seasonSlug}_${stamp}.csv`, "text/csv", toCSV(pstHeaders, pstRows));
  downloadBlob(`with_teammate_summary_${seasonSlug}_${stamp}.csv`, "text/csv", toCSV(withHeaders, withRows));
  downloadBlob(`vs_opponent_summary_${seasonSlug}_${stamp}.csv`, "text/csv", toCSV(vsHeaders, vsRows));
  downloadBlob(`backup_${seasonSlug}_${stamp}.json`, "application/json", JSON.stringify(backup, null, 2));
}

async function exportGame(game, season, playersById) {
  const { lines, scoreA, scoreB, winner_side } = await buildGameBox(game);
  const [a1,a2]=game.sideA_player_ids, [b1,b2]=game.sideB_player_ids;

  const headers = [
    "game_id","played_at","season_name",
    "sideA_p1","sideA_p2","sideB_p1","sideB_p2",
    "final_score_a","final_score_b","winner_side",
    "player_name","side","result",
    "2PM","2PMISS","2PA","2P_PCT","3PM","3PMISS","3PA","3P_PCT","PTS","AST","OREB","DREB","REB","STL","BLK"
  ];
  const sideMap = new Map();
  for (const pid of game.sideA_player_ids) sideMap.set(pid, "A");
  for (const pid of game.sideB_player_ids) sideMap.set(pid, "B");

  const rows = [];
  for (const pid of [...game.sideA_player_ids, ...game.sideB_player_ids]) {
    const line = lines.get(pid) || emptyLine();
    const d = computeDerived(line);
    const side = sideMap.get(pid);
    const result = (side===winner_side)?"W":"L";
    rows.push({
      game_id:game.game_id, played_at:game.played_at, season_name:season.name,
      sideA_p1:(((playersById.get(a1) && playersById.get(a1).name) || "")||""), sideA_p2:(((playersById.get(a2) && playersById.get(a2).name) || "")||""),
      sideB_p1:(((playersById.get(b1) && playersById.get(b1).name) || "")||""), sideB_p2:(((playersById.get(b2) && playersById.get(b2).name) || "")||""),
      final_score_a:scoreA, final_score_b:scoreB, winner_side,
      player_name:(((playersById.get(pid) && playersById.get(pid).name) || "")||""), side, result,
      "2PM":line["2PM"], "2PMISS":line["2PMISS"], "2PA":d.twoPA, "2P_PCT":d.twoPct===null?"":d.twoPct.toFixed(4),
      "3PM":line["3PM"], "3PMISS":line["3PMISS"], "3PA":d.threePA, "3P_PCT":d.threePct===null?"":d.threePct.toFixed(4),
      "PTS":d.pts, "AST":line["AST"], "OREB":line["OREB"], "DREB":line["DREB"], "REB":d.reb, "STL":line["STL"], "BLK":line["BLK"]
    });
  }

  const stamp = game.played_at.slice(0,10);
  const name = `${((playersById.get(a1) && playersById.get(a1).name) || "")||"A1"}_${((playersById.get(a2) && playersById.get(a2).name) || "")||"A2"}_vs_${((playersById.get(b1) && playersById.get(b1).name) || "")||"B1"}_${((playersById.get(b2) && playersById.get(b2).name) || "")||"B2"}`.replace(/\s+/g,'_');
  downloadBlob(`game_${stamp}_${name}.csv`, "text/csv", toCSV(headers, rows));
  downloadBlob(`game_${stamp}_${name}.json`, "application/json", JSON.stringify({game, scoreA, scoreB, winner_side, rows}, null, 2));
}
