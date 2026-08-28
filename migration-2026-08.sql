-- ParagonSplit — migracja z 2026-08
-- Supabase → SQL Editor → New query → wklej całość → Run.
-- Bezpieczna do wielokrotnego uruchomienia (if not exists).

-- 1) Oryginalna nazwa pozycji, tak jak jest wydrukowana na paragonie.
--    W kolumnie "name" trzymamy nazwę wyświetlaną (tłumaczenie / poprawki użytkownika).
alter table items add column if not exists orig_name text;

-- 2) Kto wyłożył pieniądze na napiwek — tablica id osób, kwota dzielona równo między nie.
alter table sessions add column if not exists tip_payers jsonb default '[]'::jsonb;

-- 3) Kolumny, z których korzysta aplikacja, a których mogło zabraknąć
--    w starszej instalacji (nie zaszkodzą, jeśli już są).
alter table sessions add column if not exists name text default 'Rachunek';
alter table sessions add column if not exists currency text default 'PLN';
alter table sessions add column if not exists fx_rate numeric;
alter table sessions add column if not exists paid_base numeric;
alter table sessions add column if not exists category text default 'inne';
alter table sessions add column if not exists receipt_urls jsonb default '[]'::jsonb;
