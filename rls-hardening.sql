-- ParagonSplit — zamknięcie dostępu anonimowego
--
-- PROBLEM: polityki `using (true)` na sessions/items/people/assignments/payments/
-- settlements/activity oznaczają, że każdy z publicznym kluczem anon (jest w config.js)
-- może pobrać CAŁĄ zawartość tych tabel — wszystkie wyjazdy, imiona, kwoty i numery
-- telefonów, nie tylko swoje. Może też wysłać UPDATE albo DELETE bez filtra.
--
-- ROZWIĄZANIE: cały odczyt i zapis przez funkcje SECURITY DEFINER (jak istniejące
-- `get_group`), a na tabelach zero polityk — czyli zero dostępu dla anona.
-- Model „link = dostęp" zostaje: żeby cokolwiek przeczytać albo zmienić, trzeba znać
-- niezgadywalny UUID sesji lub grupy.
--
-- KOLEJNOŚĆ: najpierw wgraj nowy JavaScript (ma ścieżkę awaryjną na stary tryb,
-- więc działa i przed, i po tym skrypcie), potem uruchom to w SQL Editorze.
--
-- WYCOFANIE: na końcu pliku jest zakomentowany blok przywracający stary stan.

-- ============================================================
-- 0. KOLUMNY (to samo co migration-2026-08.sql — bezpieczne przy powtórce)
-- ============================================================
-- Funkcje niżej odwołują się do tych kolumn, więc muszą istnieć.

alter table items    add column if not exists orig_name text;
alter table sessions add column if not exists tip_payers jsonb default '[]'::jsonb;

-- ============================================================
-- 1. ODCZYT
-- ============================================================

create or replace function get_session_bundle(sid uuid)
returns json
language sql
security definer
set search_path = public, pg_temp
as $$
  select json_build_object(
    'session', (select row_to_json(s) from sessions s where s.id = sid),
    'people', coalesce((
      select json_agg(p order by p.created_at) from people p
      where p.session_id = sid
         or (p.group_id is not null and p.group_id = (select group_id from sessions where id = sid))
    ), '[]'::json),
    'items', coalesce((
      select json_agg(i order by i.position, i.created_at) from items i where i.session_id = sid
    ), '[]'::json),
    'assignments', coalesce((
      select json_agg(a) from assignments a where a.session_id = sid
    ), '[]'::json),
    'payments', coalesce((
      select json_agg(pay) from payments pay where pay.session_id = sid
    ), '[]'::json)
  );
$$;

create or replace function get_group_bundle(gid uuid)
returns json
language sql
security definer
set search_path = public, pg_temp
as $$
  select json_build_object(
    'group', (select row_to_json(g) from groups g where g.id = gid),
    'people', coalesce((select json_agg(p order by p.created_at) from people p where p.group_id = gid), '[]'::json),
    'sessions', coalesce((select json_agg(s order by s.created_at) from sessions s where s.group_id = gid), '[]'::json),
    'items', coalesce((
      select json_agg(i order by i.position, i.created_at) from items i
      where i.session_id in (select id from sessions where group_id = gid)
    ), '[]'::json),
    'assignments', coalesce((
      select json_agg(a) from assignments a
      where a.session_id in (select id from sessions where group_id = gid)
    ), '[]'::json),
    'payments', coalesce((
      select json_agg(pay) from payments pay
      where pay.session_id in (select id from sessions where group_id = gid)
    ), '[]'::json),
    'settlements', coalesce((select json_agg(st order by st.created_at) from settlements st where st.group_id = gid), '[]'::json),
    'activity', coalesce((
      select json_agg(x) from (
        select * from activity where group_id = gid order by created_at desc limit 30
      ) x
    ), '[]'::json)
  );
$$;

-- lista własnych wyjazdów — tylko dla zalogowanego właściciela
create or replace function list_my_groups()
returns json
language sql
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select json_agg(x) from (
      select id, name, created_at from groups
      where auth.uid() is not null and owner = auth.uid()
      order by created_at desc
    ) x
  ), '[]'::json);
$$;

-- ============================================================
-- 2. GRUPY
-- ============================================================

create or replace function create_group(p_name text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r groups;
begin
  if auth.uid() is null then raise exception 'Zaloguj się, aby utworzyć wyjazd'; end if;
  insert into groups (name, owner) values (coalesce(nullif(trim(p_name), ''), 'Wyjazd'), auth.uid())
  returning * into r;
  return row_to_json(r);
end $$;

create or replace function rename_group(gid uuid, p_name text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update groups set name = coalesce(nullif(trim(p_name), ''), 'Wyjazd') where id = gid;
$$;

-- ============================================================
-- 3. OSOBY
-- ============================================================

create or replace function add_person(gid uuid, sid uuid, p_name text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r people;
begin
  if coalesce(trim(p_name), '') = '' then raise exception 'Podaj imię'; end if;
  if gid is null and sid is null then raise exception 'Brak grupy i sesji'; end if;
  insert into people (group_id, session_id, name) values (gid, sid, trim(p_name))
  returning * into r;
  return row_to_json(r);
end $$;

create or replace function update_person(pid uuid, patch jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update people set
    name  = case when patch ? 'name'  then coalesce(nullif(trim(patch->>'name'), ''), name) else name end,
    phone = case when patch ? 'phone' then nullif(trim(coalesce(patch->>'phone', '')), '') else phone end
  where id = pid;
$$;

create or replace function delete_person(pid uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from people where id = pid;
$$;

-- ============================================================
-- 4. PARAGONY (SESJE)
-- ============================================================

create or replace function create_session(gid uuid, p_name text)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare r sessions;
begin
  insert into sessions (group_id, name)
  values (gid, coalesce(nullif(trim(coalesce(p_name, '')), ''), 'Rachunek'))
  returning * into r;
  return row_to_json(r);
end $$;

create or replace function update_session(sid uuid, patch jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update sessions set
    name         = case when patch ? 'name'         then patch->>'name' else name end,
    tip          = case when patch ? 'tip'          then coalesce((patch->>'tip')::numeric, 0) else tip end,
    tip_mode     = case when patch ? 'tip_mode'     then patch->>'tip_mode' else tip_mode end,
    tip_payers   = case when patch ? 'tip_payers'   then patch->'tip_payers' else tip_payers end,
    currency     = case when patch ? 'currency'     then patch->>'currency' else currency end,
    fx_rate      = case when patch ? 'fx_rate'      then (nullif(patch->>'fx_rate', ''))::numeric else fx_rate end,
    paid_base    = case when patch ? 'paid_base'    then (nullif(patch->>'paid_base', ''))::numeric else paid_base end,
    category     = case when patch ? 'category'     then patch->>'category' else category end,
    receipt_urls = case when patch ? 'receipt_urls' then patch->'receipt_urls' else receipt_urls end
  where id = sid;
$$;

create or replace function delete_session(sid uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from sessions where id = sid;
$$;

-- ============================================================
-- 5. POZYCJE
-- ============================================================

create or replace function add_items(sid uuid, rows jsonb)
returns json
language sql
security definer
set search_path = public, pg_temp
as $$
  with ins as (
    insert into items (session_id, name, orig_name, qty, unit_price, position)
    select sid,
           left(coalesce(r->>'name', ''), 120),
           nullif(left(coalesce(r->>'orig_name', ''), 120), ''),
           greatest(1, coalesce((r->>'qty')::numeric, 1)),
           greatest(0, coalesce((r->>'unit_price')::numeric, 0)),
           coalesce((r->>'position')::int, 0)
    from jsonb_array_elements(rows) r
    where coalesce(r->>'name', '') <> ''
    returning *
  )
  select coalesce((select json_agg(ins order by ins.position) from ins), '[]'::json);
$$;

create or replace function update_item(iid uuid, patch jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update items set
    name       = case when patch ? 'name'       then left(patch->>'name', 120) else name end,
    orig_name  = case when patch ? 'orig_name'  then nullif(left(coalesce(patch->>'orig_name', ''), 120), '') else orig_name end,
    qty        = case when patch ? 'qty'        then greatest(1, coalesce((patch->>'qty')::numeric, 1)) else qty end,
    unit_price = case when patch ? 'unit_price' then greatest(0, coalesce((patch->>'unit_price')::numeric, 0)) else unit_price end,
    position   = case when patch ? 'position'   then coalesce((patch->>'position')::int, position) else position end
  where id = iid;
$$;

create or replace function delete_item(iid uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from items where id = iid;
$$;

-- ============================================================
-- 6. PRZYPISANIA
-- ============================================================

-- p_shares = 0 usuwa przypisanie
create or replace function set_assignment(iid uuid, pid uuid, p_shares int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare sid uuid;
begin
  select session_id into sid from items where id = iid;
  if sid is null then raise exception 'Nie ma takiej pozycji'; end if;

  if coalesce(p_shares, 0) <= 0 then
    delete from assignments where item_id = iid and person_id = pid;
    return;
  end if;

  update assignments set shares = least(9, p_shares) where item_id = iid and person_id = pid;
  if not found then
    insert into assignments (item_id, person_id, session_id, shares)
    values (iid, pid, sid, least(9, p_shares));
  end if;
end $$;

-- wsadowe dodanie przypisan (uzywa tego migrate.html)
create or replace function add_assignments(sid uuid, rows jsonb)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare n int;
begin
  with dodane as (
    insert into assignments (item_id, person_id, session_id, shares)
    select (r->>'item_id')::uuid, (r->>'person_id')::uuid, sid,
           least(9, greatest(1, coalesce((r->>'shares')::int, 1)))
    from jsonb_array_elements(rows) r
    where not exists (
      select 1 from assignments a
      where a.item_id = (r->>'item_id')::uuid and a.person_id = (r->>'person_id')::uuid
    )
    returning 1
  )
  select count(*) into n from dodane;
  return n;
end $$;

create or replace function assign_all(sid uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare gid uuid; n int;
begin
  select group_id into gid from sessions where id = sid;
  with dodane as (
    insert into assignments (item_id, person_id, session_id, shares)
    select i.id, p.id, sid, 1
    from items i
    cross join people p
    where i.session_id = sid
      and ((gid is not null and p.group_id = gid) or (gid is null and p.session_id = sid))
      and not exists (select 1 from assignments a where a.item_id = i.id and a.person_id = p.id)
    returning 1
  )
  select count(*) into n from dodane;
  return n;
end $$;

-- ============================================================
-- 7. WPŁATY I SPŁATY
-- ============================================================

-- p_amount = null usuwa wpłatę
create or replace function set_payment(sid uuid, pid uuid, p_amount numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_amount is null then
    delete from payments where session_id = sid and person_id = pid;
    return;
  end if;
  update payments set amount = greatest(0, p_amount) where session_id = sid and person_id = pid;
  if not found then
    insert into payments (session_id, person_id, amount) values (sid, pid, greatest(0, p_amount));
  end if;
end $$;

create or replace function add_settlement(gid uuid, p_from uuid, p_to uuid, p_amount numeric)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into settlements (group_id, from_person, to_person, amount)
  values (gid, p_from, p_to, round(greatest(0, p_amount), 2));
$$;

create or replace function delete_settlement(p_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from settlements where id = p_id;
$$;

create or replace function log_activity(gid uuid, p_text text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into activity (group_id, text) values (gid, left(coalesce(p_text, ''), 300));
$$;

-- ============================================================
-- 8. UPRAWNIENIA DO FUNKCJI
-- ============================================================

grant execute on function
  get_session_bundle(uuid), get_group_bundle(uuid), list_my_groups(),
  create_group(text), rename_group(uuid, text),
  add_person(uuid, uuid, text), update_person(uuid, jsonb), delete_person(uuid),
  create_session(uuid, text), update_session(uuid, jsonb), delete_session(uuid),
  add_items(uuid, jsonb), update_item(uuid, jsonb), delete_item(uuid),
  set_assignment(uuid, uuid, int), assign_all(uuid), add_assignments(uuid, jsonb),
  set_payment(uuid, uuid, numeric),
  add_settlement(uuid, uuid, uuid, numeric), delete_settlement(uuid),
  log_activity(uuid, text)
to anon, authenticated;

-- ============================================================
-- 9. ZAMKNIĘCIE TABEL
-- ============================================================
-- RLS włączony + zero polityk = zero dostępu dla anona i zalogowanego.
-- Funkcje powyżej są SECURITY DEFINER i należą do właściciela tabel, więc omijają RLS.

alter table groups      enable row level security;
alter table sessions    enable row level security;
alter table people      enable row level security;
alter table items       enable row level security;
alter table assignments enable row level security;
alter table payments    enable row level security;
alter table settlements enable row level security;
alter table activity    enable row level security;

-- UWAGA: `groups` zostawiamy w spokoju — ma już politykę ograniczoną do właściciela
-- (anonim dostaje z niej zero wierszy, sprawdzone). Kasujemy tylko polityki „allow all".
drop policy if exists "allow all" on sessions;
drop policy if exists "allow all" on people;
drop policy if exists "allow all" on items;
drop policy if exists "allow all" on assignments;
drop policy if exists "allow all" on payments;
drop policy if exists "allow all" on settlements;
drop policy if exists "allow all" on activity;

-- Gdyby polityki nazywały się inaczej — pokaż, co jeszcze zostało do usunięcia:
-- select tablename, policyname from pg_policies where schemaname = 'public';

-- ============================================================
-- 10. SPRAWDZENIE
-- ============================================================
-- Po uruchomieniu wejdź na stronę, otwórz konsolę i wklej:
--
--   const K = window.APP_CONFIG.SUPABASE_ANON_KEY, U = window.APP_CONFIG.SUPABASE_URL;
--   for (const t of ['sessions','items','people','payments','activity','settlements']) {
--     const r = await fetch(U+'/rest/v1/'+t+'?select=*&limit=5', {headers:{apikey:K,Authorization:'Bearer '+K}});
--     console.log(t, r.status, (await r.json()).length ?? '-');
--   }
--
-- Każda tabela ma zwrócić 0 wierszy. Aplikacja ma działać normalnie.

-- ============================================================
-- WYCOFANIE (odkomentuj i uruchom, jeśli coś pójdzie nie tak)
-- ============================================================
-- create policy "allow all" on groups      for all using (true) with check (true);
-- create policy "allow all" on sessions    for all using (true) with check (true);
-- create policy "allow all" on people      for all using (true) with check (true);
-- create policy "allow all" on items       for all using (true) with check (true);
-- create policy "allow all" on assignments for all using (true) with check (true);
-- create policy "allow all" on payments    for all using (true) with check (true);
-- create policy "allow all" on settlements for all using (true) with check (true);
-- create policy "allow all" on activity    for all using (true) with check (true);
