-- GezinsPlanner Database Schema
-- Voer dit uit in de Supabase SQL Editor

-- ── KINDEREN ──────────────────────────────────────────────────────────────────
create table if not exists children (
  id         text primary key,
  name       text not null,
  avatar     text not null default '👤',
  coins      integer not null default 0,
  pin        text,
  sort_order integer default 0,
  created_at timestamptz default now()
);

-- ── TAKEN ─────────────────────────────────────────────────────────────────────
create table if not exists tasks (
  id         text primary key,
  child_id   text not null references children(id) on delete cascade,
  title      text not null,
  description text default '',
  coins      integer not null default 5,
  date       text not null,   -- 'YYYY-MM-DD'
  status     text not null default 'pending'  -- pending | done | approved
             check (status in ('pending','done','approved')),
  created_at timestamptz default now()
);

-- ── BELONINGEN ────────────────────────────────────────────────────────────────
create table if not exists rewards (
  id         text primary key,
  title      text not null,
  description text default '',
  cost       integer not null default 10,
  emoji      text not null default '🎁',
  created_at timestamptz default now()
);

-- ── AANVRAGEN (redemptions) ───────────────────────────────────────────────────
create table if not exists redemptions (
  id           text primary key,
  child_id     text not null references children(id) on delete cascade,
  reward_id    text references rewards(id) on delete set null,
  reward_title text not null,
  reward_emoji text not null default '🎁',
  cost         integer not null,
  date         text not null,   -- 'YYYY-MM-DD'
  status       text not null default 'pending'  -- pending | approved | rejected
               check (status in ('pending','approved','rejected')),
  created_at   timestamptz default now()
);

-- ── ROW LEVEL SECURITY (open voor nu, pas aan als je auth toevoegt) ───────────
alter table children    enable row level security;
alter table tasks       enable row level security;
alter table rewards     enable row level security;
alter table redemptions enable row level security;

-- Tijdelijk: iedereen mag alles (verander dit als je logins toevoegt)
create policy "public_all" on children    for all using (true) with check (true);
create policy "public_all" on tasks       for all using (true) with check (true);
create policy "public_all" on rewards     for all using (true) with check (true);
create policy "public_all" on redemptions for all using (true) with check (true);

-- ── STARTDATA ─────────────────────────────────────────────────────────────────
insert into children (id, name, avatar, coins, pin, sort_order) values
  ('c1', 'Nevah',  '👧', 35, '1234', 1),
  ('c2', 'Kylian', '👦', 20, '0000', 2)
on conflict (id) do nothing;

insert into rewards (id, title, description, cost, emoji) values
  ('r1', 'IJsje',           'Één bolletje ijs',  20, '🍦'),
  ('r2', 'Extra schermtijd','30 minuten extra',   30, '📱'),
  ('r3', 'Bioscoopje',      'Film uitzoeken',     80, '🎬')
on conflict (id) do nothing;

-- ── REALTIME (live sync tussen apparaten) ────────────────────────────────────
-- Schakel realtime in voor alle tabellen zodat wijzigingen direct zichtbaar zijn
-- op alle apparaten zonder te refreshen
alter publication supabase_realtime add table children;
alter publication supabase_realtime add table tasks;
alter publication supabase_realtime add table rewards;
alter publication supabase_realtime add table redemptions;
