# Driveway Stats (Free iPad PWA)

Offline-first 2v2 driveway basketball stat tracker.
- 2s/3s only
- Play to 40, win by 3
- Player-centric season stats (W/L independent of team labels)
- Exports: CSVs + teammate/opponent summaries + JSON backup

## Deploy free forever (GitHub Pages)
1. Create a GitHub repo (public is easiest).
2. Upload all files from this folder into the repo root.
3. Repo → Settings → Pages → Deploy from branch:
   - Branch: main
   - Folder: / (root)
4. Open the Pages URL on your iPad (Safari).
5. Share → Add to Home Screen.

## Backups / Exports
Tap **Export** to download:
- players.csv
- games.csv
- player_game_stats.csv
- player_season_totals.csv
- with_teammate_summary.csv
- vs_opponent_summary.csv
- backup_*.json (full restore backup)

## Notes
Data is stored locally on the iPad (IndexedDB). Clearing Safari website data erases it, so export periodically.
