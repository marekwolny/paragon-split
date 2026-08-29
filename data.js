// Warstwa dostepu do danych.
//
// Docelowo caly odczyt i zapis idzie przez funkcje RPC (SECURITY DEFINER) w Supabase,
// a tabele maja wylaczony dostep dla anona - inaczej kazdy z publicznym kluczem moze
// pobrac wszystkie paragony, imiona, kwoty i numery telefonow z calej bazy.
//
// Kazda funkcja ma sciezke awaryjna na stare, bezposrednie zapytania: dzieki temu
// mozna wgrac nowy JavaScript ZANIM wykona sie rls-hardening.sql (i odwrotnie),
// bez okna, w ktorym aplikacja nie dziala.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
export const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
export { SUPABASE_URL };

// czy dana funkcja RPC istnieje w bazie (zapamietane na czas zycia strony)
const rpcMissing = new Set();
function isMissing(error) {
  if (!error) return false;
  return error.code === 'PGRST202' || /could not find the function|does not exist/i.test(error.message || '');
}

// wolaj RPC; gdy funkcji jeszcze nie ma w bazie - uruchom sciezke awaryjna
async function call(fn, args, legacy) {
  if (!rpcMissing.has(fn)) {
    const { data, error } = await db.rpc(fn, args);
    if (!error) return data;
    if (!isMissing(error)) throw new Error(error.message);
    rpcMissing.add(fn);
    console.warn('RPC ' + fn + ' nie istnieje — stary tryb (uruchom rls-hardening.sql)');
  }
  return legacy();
}

const arr = (x) => (Array.isArray(x) ? x : []);

// ---------- odczyt ----------

export function loadSessionBundle(sid) {
  return call('get_session_bundle', { sid }, async () => {
    const s = await db.from('sessions').select('*').eq('id', sid).single();
    if (s.error) throw new Error(s.error.message);
    const session = s.data;
    const peopleQuery = session.group_id
      ? db.from('people').select('*').eq('group_id', session.group_id).order('created_at')
      : db.from('people').select('*').eq('session_id', sid).order('created_at');
    const [p, i, a, pay] = await Promise.all([
      peopleQuery,
      db.from('items').select('*').eq('session_id', sid).order('position').order('created_at'),
      db.from('assignments').select('*').eq('session_id', sid),
      db.from('payments').select('*').eq('session_id', sid),
    ]);
    return { session, people: p.data || [], items: i.data || [], assignments: a.data || [], payments: pay.data || [] };
  }).then(normalizeSessionBundle);
}

function normalizeSessionBundle(b) {
  if (!b || !b.session) throw new Error('Nie znaleziono sesji');
  return {
    session: b.session,
    people: arr(b.people),
    items: arr(b.items),
    assignments: arr(b.assignments),
    payments: arr(b.payments),
  };
}

export function loadGroupBundle(gid) {
  return call('get_group_bundle', { gid }, async () => {
    const g = await db.rpc('get_group', { gid });
    if (g.error || !g.data || !g.data.length) throw new Error('Nie znaleziono grupy');
    const [p, s, st, act] = await Promise.all([
      db.from('people').select('*').eq('group_id', gid).order('created_at'),
      db.from('sessions').select('*').eq('group_id', gid).order('created_at'),
      db.from('settlements').select('*').eq('group_id', gid).order('created_at'),
      db.from('activity').select('*').eq('group_id', gid).order('created_at', { ascending: false }).limit(30),
    ]);
    const sessions = s.data || [];
    const ids = sessions.map(x => x.id);
    let items = [], assignments = [], payments = [];
    if (ids.length) {
      const [i, a, pay] = await Promise.all([
        db.from('items').select('*').in('session_id', ids),
        db.from('assignments').select('*').in('session_id', ids),
        db.from('payments').select('*').in('session_id', ids),
      ]);
      items = i.data || []; assignments = a.data || []; payments = pay.data || [];
    }
    return {
      group: g.data[0], people: p.data || [], sessions,
      items, assignments, payments,
      settlements: st.data || [], activity: act.data || [],
    };
  }).then((b) => {
    if (!b || !b.group) throw new Error('Nie znaleziono grupy');
    return {
      group: b.group,
      people: arr(b.people),
      sessions: arr(b.sessions),
      items: arr(b.items),
      assignments: arr(b.assignments),
      payments: arr(b.payments),
      settlements: arr(b.settlements),
      activity: arr(b.activity),
    };
  });
}

export async function myGroups(userId) {
  const data = await call('list_my_groups', {}, async () => {
    if (!userId) return [];
    const r = await db.from('groups').select('id,name,created_at').eq('owner', userId).order('created_at', { ascending: false });
    if (r.error) throw new Error(r.error.message);
    return r.data || [];
  });
  return arr(data);
}

// ---------- grupy ----------

export function createGroup(name, ownerId) {
  return call('create_group', { p_name: name }, async () => {
    const r = await db.from('groups').insert({ name, owner: ownerId }).select().single();
    if (r.error) throw new Error(r.error.message);
    return r.data;
  });
}

// patch: { name?, settle_currencies? }
export function updateGroup(gid, patch) {
  return call('update_group', { gid, patch }, async () => {
    const r = await db.from('groups').update(patch).eq('id', gid);
    if (r.error) throw new Error(r.error.message);
  });
}

export async function renameGroup(gid, name) {
  await call('rename_group', { gid, p_name: name }, async () => {
    const r = await db.from('groups').update({ name }).eq('id', gid);
    if (r.error) throw new Error(r.error.message);
  });
  // UPDATE odfiltrowany przez RLS nie zglasza bledu, tylko cicho nie rusza zadnego wiersza,
  // wiec sprawdzamy, czy nazwa faktycznie sie zmienila
  const back = await db.rpc('get_group', { gid });
  const got = back.data && back.data[0] && back.data[0].name;
  if (got !== undefined && got !== name) {
    throw new Error('nazwa nie zapisala sie w bazie (nadal „' + got + '") — sprawdz uprawnienia do tabeli groups');
  }
}

// ---------- osoby ----------

export function addPerson({ groupId = null, sessionId = null, name }) {
  return call('add_person', { gid: groupId, sid: sessionId, p_name: name }, async () => {
    const row = groupId ? { group_id: groupId, name } : { session_id: sessionId, name };
    const r = await db.from('people').insert(row).select().single();
    if (r.error) throw new Error(r.error.message);
    return r.data;
  });
}

export function updatePerson(pid, patch) {
  return call('update_person', { pid, patch }, async () => {
    const r = await db.from('people').update(patch).eq('id', pid);
    if (r.error) throw new Error(r.error.message);
  });
}

export function deletePerson(pid) {
  return call('delete_person', { pid }, async () => {
    const r = await db.from('people').delete().eq('id', pid);
    if (r.error) throw new Error(r.error.message);
  });
}

// ---------- paragony (sesje) ----------

export function createSession({ groupId = null, name = null }) {
  return call('create_session', { gid: groupId, p_name: name }, async () => {
    const payload = {};
    if (groupId) payload.group_id = groupId;
    if (name) payload.name = name;
    const r = await db.from('sessions').insert(payload).select().single();
    if (r.error) throw new Error(r.error.message);
    return r.data;
  });
}

export function updateSession(sid, patch) {
  return call('update_session', { sid, patch }, async () => {
    const r = await db.from('sessions').update(patch).eq('id', sid);
    if (r.error) throw new Error(r.error.message);
  });
}

export function deleteSession(sid) {
  return call('delete_session', { sid }, async () => {
    const r = await db.from('sessions').delete().eq('id', sid);
    if (r.error) throw new Error(r.error.message);
  });
}

// ---------- pozycje ----------

export async function addItems(sid, rows) {
  if (!rows.length) return [];
  const clean = rows.map(r => ({
    name: r.name, orig_name: r.orig_name || null,
    qty: r.qty, unit_price: r.unit_price, position: r.position || 0,
  }));
  const data = await call('add_items', { sid, rows: clean }, async () => {
    let ins = await db.from('items').insert(clean.map(r => ({ ...r, session_id: sid }))).select();
    if (ins.error && /orig_name/i.test(ins.error.message || '')) {
      ins = await db.from('items').insert(clean.map(({ orig_name, ...r }) => ({ ...r, session_id: sid }))).select();
    }
    if (ins.error) throw new Error(ins.error.message);
    return ins.data || [];
  });
  return arr(data);
}

export function updateItem(iid, patch) {
  return call('update_item', { iid, patch }, async () => {
    const r = await db.from('items').update(patch).eq('id', iid);
    if (r.error) throw new Error(r.error.message);
  });
}

export function deleteItem(iid) {
  return call('delete_item', { iid }, async () => {
    const r = await db.from('items').delete().eq('id', iid);
    if (r.error) throw new Error(r.error.message);
  });
}

// ---------- przypisania ----------

// shares = 0 lub null usuwa przypisanie
export function setAssignment(sid, iid, pid, shares) {
  return call('set_assignment', { iid, pid, p_shares: shares || 0 }, async () => {
    if (!shares) {
      const r = await db.from('assignments').delete().eq('item_id', iid).eq('person_id', pid);
      if (r.error) throw new Error(r.error.message);
      return;
    }
    const up = await db.from('assignments').update({ shares }).eq('item_id', iid).eq('person_id', pid).select();
    if (up.error) throw new Error(up.error.message);
    if (up.data && up.data.length) return;
    const r = await db.from('assignments').insert({ item_id: iid, person_id: pid, session_id: sid, shares });
    if (r.error) throw new Error(r.error.message);
  });
}

// wsadowo, rows = [{item_id, person_id, shares}]
export async function addAssignments(sid, rows) {
  if (!rows.length) return 0;
  const data = await call('add_assignments', { sid, rows }, async () => {
    const r = await db.from('assignments').insert(rows.map(x => ({ ...x, session_id: sid })));
    if (r.error) throw new Error(r.error.message);
    return rows.length;
  });
  return Number(data) || 0;
}

export function assignEveryone(sid) {
  return call('assign_all', { sid }, async () => {
    const [i, p, a, s] = await Promise.all([
      db.from('items').select('id').eq('session_id', sid),
      db.from('sessions').select('group_id').eq('id', sid).single(),
      db.from('assignments').select('item_id,person_id').eq('session_id', sid),
      Promise.resolve(null),
    ]);
    const gid = p.data && p.data.group_id;
    const pe = gid
      ? await db.from('people').select('id').eq('group_id', gid)
      : await db.from('people').select('id').eq('session_id', sid);
    const have = new Set((a.data || []).map(x => x.item_id + '|' + x.person_id));
    const rows = [];
    for (const it of i.data || []) for (const per of pe.data || []) {
      if (!have.has(it.id + '|' + per.id)) rows.push({ item_id: it.id, person_id: per.id, session_id: sid, shares: 1 });
    }
    if (!rows.length) return 0;
    const r = await db.from('assignments').insert(rows);
    if (r.error) throw new Error(r.error.message);
    return rows.length;
  });
}

// ---------- wplaty i splaty ----------

// amount === null usuwa wplate
export function setPayment(sid, pid, amount) {
  return call('set_payment', { sid, pid, p_amount: amount }, async () => {
    if (amount === null || amount === undefined) {
      const r = await db.from('payments').delete().eq('session_id', sid).eq('person_id', pid);
      if (r.error) throw new Error(r.error.message);
      return;
    }
    const up = await db.from('payments').update({ amount }).eq('session_id', sid).eq('person_id', pid).select();
    if (up.error) throw new Error(up.error.message);
    if (up.data && up.data.length) return;
    const r = await db.from('payments').insert({ session_id: sid, person_id: pid, amount });
    if (r.error) throw new Error(r.error.message);
  });
}

export function addSettlement(gid, fromId, toId, amount, currency = 'PLN') {
  return call('add_settlement', { gid, p_from: fromId, p_to: toId, p_amount: amount, p_currency: currency }, async () => {
    const r = await db.from('settlements').insert({ group_id: gid, from_person: fromId, to_person: toId, amount, currency });
    if (r.error) throw new Error(r.error.message);
  });
}

export function deleteSettlement(id) {
  return call('delete_settlement', { p_id: id }, async () => {
    const r = await db.from('settlements').delete().eq('id', id);
    if (r.error) throw new Error(r.error.message);
  });
}

export function logActivity(gid, text) {
  return call('log_activity', { gid, p_text: text }, async () => {
    await db.from('activity').insert({ group_id: gid, text });
  }).catch(() => { /* log aktywnosci nigdy nie blokuje akcji */ });
}

// ---------- odswiezanie u innych ----------
//
// Po zamknieciu `select` dla anona kanaly postgres_changes przestaja cokolwiek dostarczac
// (Realtime respektuje RLS), wiec zmiany rozglaszamy sami przez broadcast.
// Subskrypcja na postgres_changes zostaje na czas, gdy SQL jeszcze nie poszedl.

export function subscribe(channelName, legacyTables, onChange) {
  const ch = db.channel(channelName, { config: { broadcast: { self: false } } });
  ch.on('broadcast', { event: 'sync' }, onChange);
  for (const t of legacyTables) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table: t.table, filter: t.filter }, onChange);
  }
  ch.subscribe();

  // siatka bezpieczenstwa: powrot do karty odswieza dane
  document.addEventListener('visibilitychange', () => { if (!document.hidden) onChange(); });
  return ch;
}

export function announce(ch) {
  if (!ch) return;
  try { ch.send({ type: 'broadcast', event: 'sync', payload: {} }); } catch { /* trudno */ }
}

// Prog, ponizej ktorego roznica miedzy wplatami a rachunkiem to zaokraglenie,
// a nie blad: towary na wage i zaokraglenia kasy potrafia dac kilka jednostek roznicy.
// 0,1% rachunku (minimum 2 grosze) — przy 2856 ALL to 2,86 ALL, przy 16300 ALL to 16 ALL.
export function billTolerance(bill) {
  return Math.max(0.02, Math.abs(Number(bill) || 0) * 0.001);
}

// ---------- diagnostyka dla stopki z wersja ----------
// Odpowiada na pytanie "czy to, co widze, jest faktycznie wgrane i czy SQL poszedl".
export async function diag() {
  const out = { rpc: false, origName: false, tipPayers: false };

  const r = await db.rpc('get_session_bundle', { sid: '00000000-0000-0000-0000-000000000000' });
  out.rpc = !(r.error && isMissing(r.error));

  const a = await db.from('items').select('orig_name').limit(1);
  out.origName = !(a.error && /orig_name/i.test(a.error.message || ''));

  const b = await db.from('sessions').select('tip_payers').limit(1);
  out.tipPayers = !(b.error && /tip_payers/i.test(b.error.message || ''));

  return out;
}
window.__psDiag = diag;
