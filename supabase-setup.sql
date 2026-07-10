-- Uruchom całość w Supabase: SQL Editor -> New query -> wklej -> Run

create table sessions (
  id uuid primary key default gen_random_uuid(),
  name text default 'Rachunek',
  tip numeric default 0,
  tip_mode text default 'proportional', -- 'proportional' | 'equal'
  created_at timestamptz default now()
);

create table people (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  name text not null,
  created_at timestamptz default now()
);

create table items (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references sessions(id) on delete cascade,
  name text not null,
  qty numeric not null default 1,
  unit_price numeric not null default 0,
  position int not null default 0,
  created_at timestamptz default now()
);

create table assignments (
  item_id uuid not null references items(id) on delete cascade,
  person_id uuid not null references people(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  primary key (item_id, person_id)
);

-- RLS: dostęp anonimowy, bezpieczeństwo przez niezgadywalny UUID sesji w URL
alter table sessions enable row level security;
alter table people enable row level security;
alter table items enable row level security;
alter table assignments enable row level security;

create policy "allow all" on sessions for all using (true) with check (true);
create policy "allow all" on people for all using (true) with check (true);
create policy "allow all" on items for all using (true) with check (true);
create policy "allow all" on assignments for all using (true) with check (true);

-- Realtime (zmiany widoczne u wszystkich na żywo)
alter publication supabase_realtime add table sessions;
alter publication supabase_realtime add table people;
alter publication supabase_realtime add table items;
alter publication supabase_realtime add table assignments;
