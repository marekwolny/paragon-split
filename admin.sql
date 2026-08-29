-- ParagonSplit — panel administracyjny
--
-- Dostęp mają WYŁĄCZNIE konta wypisane w tabeli `admins`. Sprawdzenie jest po stronie
-- bazy (funkcje SECURITY DEFINER), więc nie da się go obejść przez konsolę przeglądarki
-- ani przez wywołanie REST-a z publicznym kluczem anon.
--
-- Uruchom w Supabase → SQL Editor. Można wielokrotnie.
-- Wymaga wcześniejszego rls-hardening.sql.

-- ============================================================
-- 1. LISTA ADMINÓW
-- ============================================================

create table if not exists admins (
  email    text primary key,
  added_at timestamptz default now()
);

-- Twoje konta. Dopisanie kolejnego: insert into admins(email) values ('ktos@example.com');
insert into admins (email) values
  ('mareczek85@gmail.com'),
  ('marek.wolny@gmail.com')
on conflict (email) do nothing;

alter table admins enable row level security;
-- celowo zero polityk: tabela jest widoczna tylko przez funkcje ponizej

-- ============================================================
-- 2. CZY JESTEM ADMINEM
-- ============================================================
-- Zwraca false dla niezalogowanych i dla kont spoza listy — nigdy nie rzuca bledem,
-- zeby dalo sie tym sterowac widocznoscia linku w interfejsie.

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from admins
    where lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ============================================================
-- 3. PRZEGLĄD
-- ============================================================

create or replace function admin_overview()
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare res json;
begin
  if not is_admin() then
    raise exception 'Brak dostępu — to konto nie jest na liście administratorów';
  end if;

  select json_build_object(
    'generated_at', now(),

    'stats', json_build_object(
      'users',    (select count(*) from auth.users),
      'groups',   (select count(*) from groups),
      'sessions', (select count(*) from sessions),
      'items',    (select count(*) from items),
      'people',   (select count(*) from people),
      'payments', (select count(*) from payments)
    ),

    -- kto ma konto i kiedy sie ostatnio logowal
    'users', (select coalesce(json_agg(x), '[]'::json) from (
      select u.email,
             u.created_at,
             u.last_sign_in_at,
             (select count(*) from groups g where g.owner = u.id) as groups,
             exists (select 1 from admins a where lower(a.email) = lower(u.email)) as is_admin
      from auth.users u
      order by u.last_sign_in_at desc nulls last
      limit 100
    ) x),

    -- wyjazdy: czyje, ile w nich siedzi
    'groups', (select coalesce(json_agg(x), '[]'::json) from (
      select g.id, g.name, g.created_at,
             (select u.email from auth.users u where u.id = g.owner) as owner_email,
             (select count(*) from sessions s where s.group_id = g.id) as sessions,
             (select count(*) from people p where p.group_id = g.id)   as people
      from groups g
      order by g.created_at desc
      limit 60
    ) x),

    -- ostatnio zalozone rachunki
    'recent_sessions', (select coalesce(json_agg(x), '[]'::json) from (
      select s.id, s.name, s.created_at, s.currency, s.group_id,
             (select g.name from groups g where g.id = s.group_id) as group_name,
             (select count(*) from items i where i.session_id = s.id) as items,
             (select coalesce(sum(i.qty * i.unit_price), 0) from items i where i.session_id = s.id) as total
      from sessions s
      order by s.created_at desc
      limit 60
    ) x),

    -- log aktywnosci ze wszystkich wyjazdow
    'recent_activity', (select coalesce(json_agg(x), '[]'::json) from (
      select a.created_at, a.text,
             (select g.name from groups g where g.id = a.group_id) as group_name
      from activity a
      order by a.created_at desc
      limit 120
    ) x)
  ) into res;

  return res;
end $$;

grant execute on function is_admin() to anon, authenticated;
grant execute on function admin_overview() to authenticated;

-- ============================================================
-- 4. SPRAWDZENIE
-- ============================================================
-- select is_admin();        -- z panelu Supabase zwroci false (brak JWT) — to normalne
-- select * from admins;     -- lista uprawnionych kont
