# Driveway Stats + Supabase Cloud Backup (Free)

This version keeps the same fast 2v2 stat UI, but adds **optional cloud backup + cross-device sync** using Supabase (free tier).

## What you get
- iPad can break → your season is still safe in the cloud
- Add players on laptop → iPad can Sync and see them
- Works offline locally; when you Sync it pushes pending changes

---

## 1) Create a Supabase project (free)
1. Go to Supabase and create a new project.
2. In the project:
   - **Authentication → Providers → Email** should be enabled (default).
3. **Project Settings → API**
   - Copy **Project URL**
   - Copy **anon public key**

---

## 2) Create database tables
In Supabase: **SQL Editor → New query** and run this:

```sql
-- Players
create table if not exists public.players (
  owner_id uuid not null references auth.users(id) on delete cascade,
  player_id uuid primary key,
  name text not null,
  created_at timestamptz not null,
  active boolean not null default true
);

-- Seasons
create table if not exists public.seasons (
  owner_id uuid not null references auth.users(id) on delete cascade,
  season_id uuid primary key,
  name text not null,
  start_date date not null,
  archived boolean not null default false
);

-- Games
create table if not exists public.games (
  owner_id uuid not null references auth.users(id) on delete cascade,
  game_id uuid primary key,
  season_id uuid not null,
  played_at timestamptz not null,
  sideA_player_ids uuid[] not null,
  sideB_player_ids uuid[] not null,
  final_score_a int not null default 0,
  final_score_b int not null default 0,
  winner_side text,
  finalized boolean not null default false,
  notes text
);

-- Events
create table if not exists public.events (
  owner_id uuid not null references auth.users(id) on delete cascade,
  event_id uuid primary key,
  game_id uuid not null,
  timestamp timestamptz not null,
  player_id uuid not null,
  stat_type text not null,
  delta int not null default 1
);

-- Helpful indexes
create index if not exists players_owner_idx on public.players(owner_id);
create index if not exists seasons_owner_idx on public.seasons(owner_id);
create index if not exists games_owner_idx on public.games(owner_id);
create index if not exists events_owner_idx on public.events(owner_id);
create index if not exists events_game_owner_idx on public.events(owner_id, game_id);

-- Enable RLS
alter table public.players enable row level security;
alter table public.seasons enable row level security;
alter table public.games enable row level security;
alter table public.events enable row level security;

-- Policies: only signed-in user can read/write their own rows
create policy "players_owner" on public.players
for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "seasons_owner" on public.seasons
for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "games_owner" on public.games
for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy "events_owner" on public.events
for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
```

---

## 3) Add Supabase keys into the app
Open `config.js` and paste:

```js
window.SUPABASE_URL = "https://YOURPROJECT.supabase.co";
window.SUPABASE_ANON_KEY = "YOUR_ANON_PUBLIC_KEY";
```

Commit `config.js` to GitHub.

---

## 4) Use it
- Open the site
- Tap **Sync**
- If not signed in, go to **Cloud Sign In**
- Create a single account (email/password)
- Use that same login on iPad and laptop

### Notes
- Auto-export is OFF by default now (no more 6 files per game).
- You can still Export Season anytime for CSV/JSON.
- If you play offline, the app queues changes and will push them on the next Sync.

