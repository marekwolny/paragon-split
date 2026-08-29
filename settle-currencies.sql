-- ParagonSplit — waluty rozliczane osobno
--
-- Domyślnie wszystko przelicza się na PLN, tak jak dotąd. Ten skrypt dodaje możliwość
-- wskazania walut, które mają zostać nieprzeliczone i rozliczyć się same w sobie
-- (np. wydatki w EUR oddajecie sobie w EUR).
--
-- Uruchom w Supabase → SQL Editor. Można wielokrotnie. Wymaga rls-hardening.sql.

-- ============================================================
-- 1. KOLUMNY
-- ============================================================

-- lista kodów walut, których NIE przeliczamy na PLN; pusta = wszystko na PLN
alter table groups add column if not exists settle_currencies jsonb default '[]'::jsonb;

-- spłaty muszą wiedzieć, w jakiej walucie zostały oddane
alter table settlements add column if not exists currency text default 'PLN';
update settlements set currency = 'PLN' where currency is null;

-- ============================================================
-- 2. ZAPIS USTAWIEŃ WYJAZDU
-- ============================================================

create or replace function update_group(gid uuid, patch jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update groups set
    name = case when patch ? 'name'
                then coalesce(nullif(trim(patch->>'name'), ''), name)
                else name end,
    settle_currencies = case when patch ? 'settle_currencies'
                             then patch->'settle_currencies'
                             else settle_currencies end
  where id = gid;
$$;

-- ============================================================
-- 3. SPŁATY Z WALUTĄ
-- ============================================================
-- Stara wersja miała cztery argumenty; usuwamy ją, żeby PostgREST nie musiał
-- wybierać między dwoma wariantami o tej samej nazwie.

drop function if exists add_settlement(uuid, uuid, uuid, numeric);

create or replace function add_settlement(gid uuid, p_from uuid, p_to uuid, p_amount numeric, p_currency text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into settlements (group_id, from_person, to_person, amount, currency)
  values (gid, p_from, p_to, round(greatest(0, p_amount), 2),
          coalesce(nullif(upper(trim(coalesce(p_currency, ''))), ''), 'PLN'));
$$;

grant execute on function update_group(uuid, jsonb) to anon, authenticated;
grant execute on function add_settlement(uuid, uuid, uuid, numeric, text) to anon, authenticated;
