import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let groupId = null;
let group = null;
let people = [];
let sessions = [];
let items = [];
let assignments = [];
let payments = [];
let settlements = [];
let activity = [];
let qePayerId = null;

const CATS = { jedzenie: '🍕', transport: '🚗', nocleg: '🏨', rozrywka: '🎉', zakupy: '🛒', inne: '📦' };

const $ = (id) => document.getElementById(id);
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// przycisk instalacji PWA
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  $('btn-install').classList.remove('hidden');
});
$('btn-install').onclick = async () => {
  if (deferredInstall) {
    deferredInstall.prompt();
    await deferredInstall.userChoice;
    deferredInstall = null;
    $('btn-install').classList.add('hidden');
  } else if (/iphone|ipad|ipod/i.test(navigator.userAgent)) {
    toast('Safari: Udostępnij → „Dodaj do ekranu początkowego"', 5000);
  } else {
    toast('Menu przeglądarki → „Zainstaluj aplikację"', 4000);
  }
};

init();

async function init() {
  groupId = new URLSearchParams(location.search).get('g');
  if (!groupId) { location.href = 'index.html'; return; }

  $('btn-share').onclick = share;
  $('btn-add-person').onclick = addPerson;
  $('person-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addPerson(); });
  $('btn-add-receipt').onclick = addReceipt;
  $('btn-copy-group').onclick = copyGroupSummary;
  $('btn-csv').onclick = exportCsv;
  $('btn-print').onclick = () => window.print();
  $('qe-add').onclick = addQuickExpense;
  $('qe-currency').addEventListener('change', (e) => {
    if (e.target.value !== '__other') return;
    const code = (prompt('Podaj 3-literowy kod waluty (ISO), np. ALL dla albańskiego leka:') || '').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) { e.target.value = 'PLN'; return; }
    if (![...e.target.options].some(o => o.value === code)) {
      const o = document.createElement('option');
      o.value = o.textContent = code;
      e.target.insertBefore(o, e.target.querySelector('option[value="__other"]'));
    }
    e.target.value = code;
  });
  $('group-name-input').addEventListener('input', debounce(async () => {
    await db.from('groups').update({ name: $('group-name-input').value.trim() || 'Wyjazd' }).eq('id', groupId);
  }, 600));

  await loadAll();
  subscribeRealtime();
}

async function loadAll() {
  // rpc: dostep po dokladnym ID (link = dostep), bez mozliwosci listowania cudzych grup
  const g = await db.rpc('get_group', { gid: groupId });
  if (g.error || !g.data || !g.data.length) { toast('Nie znaleziono grupy'); return; }
  group = g.data[0];

  const [p, s, st, act] = await Promise.all([
    db.from('people').select('*').eq('group_id', groupId).order('created_at'),
    db.from('sessions').select('*').eq('group_id', groupId).order('created_at'),
    db.from('settlements').select('*').eq('group_id', groupId).order('created_at'),
    db.from('activity').select('*').eq('group_id', groupId).order('created_at', { ascending: false }).limit(30),
  ]);
  people = p.data || [];
  sessions = s.data || [];
  settlements = st.data || [];
  activity = act.data || [];

  const ids = sessions.map(x => x.id);
  if (ids.length) {
    const [i, a, pay] = await Promise.all([
      db.from('items').select('*').in('session_id', ids),
      db.from('assignments').select('*').in('session_id', ids),
      db.from('payments').select('*').in('session_id', ids),
    ]);
    items = i.data || [];
    assignments = a.data || [];
    payments = pay.data || [];
  } else {
    items = []; assignments = []; payments = [];
  }

  // zapamietaj odwiedzona grupe (lista na stronie glownej)
  try {
    const v = JSON.parse(localStorage.getItem('visitedGroups') || '[]').filter(x => x.id !== groupId);
    v.unshift({ id: groupId, name: group.name });
    localStorage.setItem('visitedGroups', JSON.stringify(v.slice(0, 20)));
  } catch { /* ignore */ }

  render();
}

function subscribeRealtime() {
  const reload = debounce(loadAll, 400);
  db.channel('group-' + groupId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'groups', filter: `id=eq.${groupId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'people', filter: `group_id=eq.${groupId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `group_id=eq.${groupId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items' }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments' }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'payments' }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'settlements', filter: `group_id=eq.${groupId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'activity', filter: `group_id=eq.${groupId}` }, reload)
    .subscribe();
}

// imie "mnie" do logu aktywnosci
function meName() {
  const meId = localStorage.getItem('me-' + groupId);
  const me = people.find(p => p.id === meId);
  return me ? me.name : null;
}

// log aktywnosci (fire & forget)
function logActivity(text) {
  const who = meName();
  db.from('activity').insert({ group_id: groupId, text: (who ? who + ': ' : '') + text }).then(() => {});
}

// ---------- szybki wydatek bez paragonu ----------
async function addQuickExpense() {
  const name = $('qe-name').value.trim();
  const amount = Number($('qe-amount').value) || 0;
  const currency = $('qe-currency').value;
  const category = $('qe-category').value;
  if (!name) return toast('Wpisz, czego dotyczy wydatek');
  if (amount <= 0) return toast('Wpisz kwotę');
  if (!people.length) return toast('Najpierw dodaj uczestników');
  if (!qePayerId) return toast('Zaznacz, kto zapłacił');

  let fx_rate = null;
  if (currency !== 'PLN') {
    for (const table of ['a', 'b']) {
      try {
        const r = await fetch('https://api.nbp.pl/api/exchangerates/rates/' + table + '/' + currency.toLowerCase() + '/?format=json');
        if (r.ok) { const d = await r.json(); if (d.rates && d.rates[0]) { fx_rate = d.rates[0].mid; break; } }
      } catch { /* dalej */ }
    }
    if (!fx_rate) {
      const manual = prompt('NBP nie podaje kursu ' + currency + '. Podaj kurs ręcznie (ile PLN za 1 ' + currency + '):');
      const v = Number(String(manual || '').replace(',', '.'));
      if (v > 0) fx_rate = v;
    }
  }

  const { data: ses, error } = await db.from('sessions')
    .insert({ group_id: groupId, name, currency, fx_rate, category }).select().single();
  if (error) return toast('Błąd: ' + error.message);

  const { data: item, error: e2 } = await db.from('items')
    .insert({ session_id: ses.id, name, qty: 1, unit_price: amount }).select().single();
  if (e2) return toast('Błąd: ' + e2.message);

  await db.from('assignments').insert(people.map(p => ({ item_id: item.id, person_id: p.id, session_id: ses.id, shares: 1 })));
  await db.from('payments').insert({ session_id: ses.id, person_id: qePayerId, amount });

  logActivity(`dodał(a) wydatek "${name}" ${amount} ${currency}`);
  $('qe-name').value = ''; $('qe-amount').value = '';
  qePayerId = null;
  toast('Wydatek dodany ⚡');
  loadAll();
}

async function share() {
  const url = location.href;
  if (navigator.share) {
    try { await navigator.share({ title: 'Rozliczenie wyjazdu', url }); return; } catch { /* anulowano */ }
  }
  await navigator.clipboard.writeText(url);
  toast('Link do grupy skopiowany 📋');
}

async function addPerson() {
  const name = $('person-name').value.trim();
  if (!name) return;
  if (people.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast('Ta osoba już jest');
  $('person-name').value = '';
  const { error } = await db.from('people').insert({ group_id: groupId, name });
  if (error) toast('Błąd: ' + error.message); else loadAll();
}

async function removePerson(id) {
  if (!confirm('Usunąć osobę? Zniknie ze WSZYSTKICH paragonów tej grupy razem z przypisaniami.')) return;
  const p = people.find(x => x.id === id);
  await db.from('people').delete().eq('id', id);
  logActivity('usunął(ęła) osobę ' + (p ? p.name : ''));
  loadAll();
}

async function addReceipt() {
  const { data, error } = await db.from('sessions').insert({ group_id: groupId, name: 'Rachunek ' + (sessions.length + 1) }).select().single();
  if (error) return toast('Błąd: ' + error.message);
  logActivity('dodał(a) paragon "' + data.name + '"');
  location.href = 'index.html?s=' + data.id;
}

async function removeReceipt(id) {
  if (!confirm('Usunąć ten paragon z całą zawartością?')) return;
  const s = sessions.find(x => x.id === id);
  await db.from('sessions').delete().eq('id', id);
  logActivity('usunął(ęła) paragon "' + (s ? s.name : '') + '"');
  loadAll();
}

// ---------- splaty ----------
async function markSettled(fromId, toId, amount) {
  const from = people.find(p => p.id === fromId), to = people.find(p => p.id === toId);
  if (!confirm(`Potwierdzić: ${from.name} oddał(a) ${to.name} ${fmt(amount)} zł?`)) return;
  const { error } = await db.from('settlements').insert({ group_id: groupId, from_person: fromId, to_person: toId, amount: Math.round(amount * 100) / 100 });
  if (error) return toast('Błąd: ' + error.message);
  logActivity(`oznaczył(a) spłatę: ${from.name} → ${to.name} ${fmt(amount)} zł ✓`);
  loadAll();
}

async function undoSettlement(id) {
  if (!confirm('Cofnąć tę spłatę?')) return;
  await db.from('settlements').delete().eq('id', id);
  loadAll();
}

// kurs PLN danego paragonu
function sessionRate(s, sessionItems) {
  if ((s.currency || 'PLN') === 'PLN') return 1;
  const total = sessionItems.reduce((sum, it) => sum + it.qty * it.unit_price, 0);
  const pb = Number(s.paid_base) || 0;
  if (pb > 0 && total > 0) return pb / total;
  return Number(s.fx_rate) || null;
}

// owed/paid per osoba w PLN dla jednego paragonu
function sessionTotals(s) {
  const sItems = items.filter(i => i.session_id === s.id);
  const sAsg = assignments.filter(a => a.session_id === s.id);
  const sPay = payments.filter(p => p.session_id === s.id);
  const rate = sessionRate(s, sItems);

  const owed = {};
  let unassigned = 0;
  for (const it of sItems) {
    const cost = it.qty * it.unit_price;
    const as = sAsg.filter(a => a.item_id === it.id);
    if (!as.length) { unassigned += cost; continue; }
    const totalSh = as.reduce((sum, a) => sum + (a.shares || 1), 0);
    for (const a of as) owed[a.person_id] = (owed[a.person_id] || 0) + cost * (a.shares || 1) / totalSh;
  }
  const itemsTotal = sItems.reduce((sum, it) => sum + it.qty * it.unit_price, 0);
  const assignedTotal = itemsTotal - unassigned;
  const tip = Number(s.tip) || 0;
  if (tip > 0) {
    const pids = Object.keys(owed);
    for (const pid of pids) {
      const tipShare = s.tip_mode === 'equal'
        ? tip / pids.length
        : (assignedTotal > 0 ? (owed[pid] / assignedTotal) * tip : tip / pids.length);
      owed[pid] += tipShare;
    }
  }
  const paid = {};
  for (const pay of sPay) paid[pay.person_id] = (paid[pay.person_id] || 0) + (Number(pay.amount) || 0);

  return { owed, paid, unassigned, itemsTotal, tip, rate, currency: s.currency || 'PLN' };
}

// agregacja calego wyjazdu w PLN
function groupTotals() {
  const owedPln = {}, paidPln = {};
  for (const p of people) { owedPln[p.id] = 0; paidPln[p.id] = 0; }
  const missingRate = [];
  let unassignedPln = 0;

  for (const s of sessions) {
    const t = sessionTotals(s);
    if (!t.rate) { if (t.itemsTotal > 0) missingRate.push(s); continue; }
    for (const pid in t.owed) if (owedPln[pid] !== undefined) owedPln[pid] += t.owed[pid] * t.rate;
    for (const pid in t.paid) if (paidPln[pid] !== undefined) paidPln[pid] += t.paid[pid] * t.rate;
    unassignedPln += t.unassigned * t.rate;
  }
  // splaty: kto oddal, temu rosnie "zaplacone"; kto dostal, temu maleje
  for (const st of settlements) {
    const amt = Number(st.amount) || 0;
    if (paidPln[st.from_person] !== undefined) paidPln[st.from_person] += amt;
    if (paidPln[st.to_person] !== undefined) paidPln[st.to_person] -= amt;
  }
  return { owedPln, paidPln, unassignedPln, missingRate };
}

// wydatki wg kategorii (PLN)
function categoryTotals() {
  const out = {};
  for (const s of sessions) {
    const t = sessionTotals(s);
    if (!t.rate) continue;
    const cat = s.category || 'inne';
    out[cat] = (out[cat] || 0) + (t.itemsTotal + t.tip) * t.rate;
  }
  return out;
}

// ---------- "kim jestes" (onboarding po wejsciu z linku) ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderMe() {
  const box = $('me-box');
  if (!box) return;
  box.innerHTML = '';
  const meId = localStorage.getItem('me-' + groupId);
  const me = people.find(p => p.id === meId);

  if (me) {
    const phoneTxt = me.phone ? '📱 ' + esc(me.phone) : '📱 nr do przelewów';
    box.innerHTML = `<div class="me-row">Ty w tej grupie: <strong>${esc(me.name)}</strong> <button class="btn-split" id="me-rename">✏️ zmień imię</button> <button class="btn-split" id="me-phone">${phoneTxt}</button> <button class="btn-split" id="me-clear">to nie ja</button></div>`;
    $('me-rename').onclick = async () => {
      const n = prompt('Twoje imię widoczne w grupie:', me.name);
      if (!n || !n.trim()) return;
      await db.from('people').update({ name: n.trim() }).eq('id', me.id);
      loadAll();
    };
    $('me-phone').onclick = async () => {
      const n = prompt('Twój numer telefonu (BLIK) — pokaże się osobom, które mają Ci oddać pieniądze.\nPozostaw puste, aby usunąć.', me.phone || '');
      if (n === null) return;
      await db.from('people').update({ phone: n.trim() || null }).eq('id', me.id);
      loadAll();
    };
    $('me-clear').onclick = () => { localStorage.removeItem('me-' + groupId); render(); };
    return;
  }

  // nowa osoba z linku: wybierz siebie albo dopisz sie
  const wrap = document.createElement('div');
  wrap.className = 'me-join';
  wrap.innerHTML = '<p class="me-hello">👋 Kim jesteś w tej grupie?</p>';
  if (people.length) {
    const hint = document.createElement('p');
    hint.className = 'muted small';
    hint.textContent = 'Jesteś już na liście? Dotknij swojego imienia:';
    wrap.appendChild(hint);
    const chips = document.createElement('div');
    chips.className = 'chips';
    for (const p of people) {
      const c = document.createElement('button');
      c.className = 'chip assignable';
      c.textContent = p.name;
      c.onclick = () => { localStorage.setItem('me-' + groupId, p.id); toast('Cześć, ' + p.name + '! 👋'); render(); };
      chips.appendChild(c);
    }
    wrap.appendChild(chips);
  }
  const row = document.createElement('div');
  row.className = 'row';
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.placeholder = people.length ? 'Albo dopisz nowe imię' : 'Twoje imię';
  inp.maxLength = 30;
  const btn = document.createElement('button');
  btn.className = 'btn-small';
  btn.textContent = 'Dołącz';
  const join = async () => {
    const name = inp.value.trim();
    if (!name) return;
    if (people.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast('To imię już jest — dotknij go na liście');
    const { data, error } = await db.from('people').insert({ group_id: groupId, name }).select().single();
    if (error) return toast('Błąd: ' + error.message);
    localStorage.setItem('me-' + groupId, data.id);
    db.from('activity').insert({ group_id: groupId, text: name + ' dołączył(a) do grupy 👋' }).then(() => {});
    toast('Witaj w grupie, ' + name + '! 🎉');
    loadAll();
  };
  btn.onclick = join;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  row.append(inp, btn);
  wrap.appendChild(row);
  box.appendChild(wrap);
}

function render() {
  if (document.activeElement !== $('group-name-input')) $('group-name-input').value = group.name;
  $('group-title').textContent = '🏕️ ' + group.name;
  document.title = group.name + ' — ParagonSplit';

  renderMe();

  // uczestnicy
  const pl = $('people-list');
  pl.innerHTML = '';
  if (!people.length) pl.innerHTML = '<span class="muted small">Dodaj uczestników wyjazdu — będą widoczni we wszystkich paragonach</span>';
  for (const p of people) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.innerHTML = p.name.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) + '<span class="x">✕</span>';
    chip.onclick = () => removePerson(p.id);
    pl.appendChild(chip);
  }

  // paragony
  const rl = $('receipts-list');
  rl.innerHTML = '';
  if (!sessions.length) rl.innerHTML = '<p class="muted small">Brak paragonów — dodaj pierwszy.</p>';
  for (const s of sessions) {
    const t = sessionTotals(s);
    const row = document.createElement('div');
    row.className = 'receipt-row';
    const a = document.createElement('a');
    a.href = 'index.html?s=' + s.id;
    const curTxt = t.currency === 'PLN' ? 'zł' : t.currency;
    const plnTxt = t.currency !== 'PLN' ? (t.rate ? ` ≈ ${fmt(t.itemsTotal * t.rate + (t.tip || 0) * t.rate)} zł` : ' ⚠️ brak kursu') : '';
    const d = new Date(s.created_at);
    const catIcon = CATS[s.category] || '🧾';
    a.innerHTML = `<strong>${catIcon} ${esc(s.name || 'Rachunek')}</strong><span class="muted small"> · ${d.toLocaleDateString('pl-PL')} · ${fmt(t.itemsTotal + (t.tip || 0))} ${curTxt}${plnTxt}</span>`;
    const del = document.createElement('button');
    del.className = 'btn-del';
    del.textContent = '✕';
    del.onclick = (e) => { e.preventDefault(); removeReceipt(s.id); };
    row.append(a, del);
    rl.appendChild(row);
  }

  renderQePayer();
  renderCatChart();
  renderActivity();
  renderGroupSummary();
}

function renderQePayer() {
  const box = $('qe-payer');
  if (!box) return;
  box.innerHTML = '';
  if (!qePayerId) {
    const meId = localStorage.getItem('me-' + groupId);
    if (people.some(p => p.id === meId)) qePayerId = meId;
  }
  for (const p of people) {
    const chip = document.createElement('button');
    chip.className = 'chip assignable' + (qePayerId === p.id ? ' on' : '');
    chip.textContent = p.name;
    chip.onclick = () => { qePayerId = p.id; renderQePayer(); };
    box.appendChild(chip);
  }
}

function renderCatChart() {
  const box = $('cat-chart');
  if (!box) return;
  box.innerHTML = '';
  const totals = categoryTotals();
  const entries = Object.entries(totals).filter(([, v]) => v > 0.005).sort((a, b) => b[1] - a[1]);
  if (!entries.length) { box.innerHTML = '<p class="muted small">Brak wydatków.</p>'; return; }
  const max = entries[0][1];
  for (const [cat, val] of entries) {
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `<span class="cat-label">${CATS[cat] || '📦'} ${esc(cat)}</span><div class="cat-track"><div class="cat-bar" style="width:${Math.max(4, Math.round(val / max * 100))}%"></div></div><span class="cat-val">${fmt(val)} zł</span>`;
    box.appendChild(row);
  }
}

function renderActivity() {
  const box = $('activity-list');
  if (!box) return;
  box.innerHTML = '';
  if (!activity.length) { box.innerHTML = '<p class="muted small">Brak aktywności.</p>'; return; }
  for (const a of activity) {
    const d = new Date(a.created_at);
    const row = document.createElement('div');
    row.className = 'act-row';
    row.innerHTML = `<span class="muted small">${d.toLocaleDateString('pl-PL')} ${d.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}</span> ${esc(a.text)}`;
    box.appendChild(row);
  }
}

function renderGroupSummary() {
  const box = $('group-summary');
  const setBox = $('group-settlement');
  box.innerHTML = '';
  setBox.innerHTML = '';

  if (!people.length || !sessions.length) {
    box.innerHTML = '<p class="muted small">Dodaj uczestników i paragony, aby zobaczyć rozliczenie.</p>';
    return;
  }

  const t = groupTotals();
  let grandOwed = 0, grandPaid = 0;
  for (const p of people) {
    grandOwed += t.owedPln[p.id];
    grandPaid += t.paidPln[p.id];
    const net = t.paidPln[p.id] - t.owedPln[p.id];
    const row = document.createElement('div');
    row.className = 'summary-row';
    row.innerHTML = `<span>${p.name}<span class="details">wydał ${fmt(t.owedPln[p.id])} zł · zapłacił ${fmt(t.paidPln[p.id])} zł</span></span><strong class="${net < -0.005 ? 'neg' : net > 0.005 ? 'pos' : ''}">${net > 0.005 ? '+' : ''}${fmt(net)} zł</strong>`;
    box.appendChild(row);
  }
  const totalRow = document.createElement('div');
  totalRow.className = 'summary-row total';
  totalRow.innerHTML = `<span>Razem wydatki</span><span>${fmt(grandOwed)} zł</span>`;
  box.appendChild(totalRow);

  if (t.unassignedPln > 0.005) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = `⚠️ Nieprzypisane pozycje: ${fmt(t.unassignedPln)} zł`;
    box.appendChild(w);
  }
  for (const s of t.missingRate) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = `⚠️ „${s.name || 'Rachunek'}" (${s.currency}) pominięty — brak kursu. Otwórz go i podaj kurs lub kwotę w PLN.`;
    box.appendChild(w);
  }
  if (Math.abs(grandPaid - grandOwed) > 0.01 && grandPaid > 0) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = `⚠️ Suma wpłat (${fmt(grandPaid)} zł) ≠ suma wydatków (${fmt(grandOwed)} zł) — sprawdź "kto zapłacił" w paragonach.`;
    box.appendChild(w);
  }

  const transfers = computeTransfers(t);
  if (transfers.length) {
    const h = document.createElement('h3');
    h.className = 'settle-title';
    h.textContent = 'Kto komu oddaje';
    setBox.appendChild(h);
    for (const tr of transfers) {
      const toPerson = people.find(p => p.name === tr.to);
      const phone = toPerson && toPerson.phone ? ` <span class="muted small">📱 ${esc(toPerson.phone)}</span>` : '';
      const row = document.createElement('div');
      row.className = 'settle-row';
      row.innerHTML = `<span>${esc(tr.from)} → ${esc(tr.to)}${phone}</span><span class="settle-actions"><strong>${fmt(tr.amount)} zł</strong> <button class="btn-small settle-done">✓ oddane</button></span>`;
      row.querySelector('.settle-done').onclick = () => {
        const fromP = people.find(p => p.name === tr.from);
        if (fromP && toPerson) markSettled(fromP.id, toPerson.id, tr.amount);
      };
      setBox.appendChild(row);
    }
  }

  // lista dokonanych splat
  const sBox = $('settled-list');
  if (sBox) {
    sBox.innerHTML = '';
    if (settlements.length) {
      const h2 = document.createElement('h3');
      h2.className = 'settle-title';
      h2.textContent = 'Spłacone ✓';
      sBox.appendChild(h2);
      for (const st of settlements) {
        const f = people.find(p => p.id === st.from_person);
        const to = people.find(p => p.id === st.to_person);
        if (!f || !to) continue;
        const row = document.createElement('div');
        row.className = 'settle-row settled';
        row.innerHTML = `<span>✓ ${esc(f.name)} → ${esc(to.name)}</span><span class="settle-actions"><strong>${fmt(Number(st.amount))} zł</strong> <button class="btn-del settle-undo">✕</button></span>`;
        row.querySelector('.settle-undo').onclick = () => undoSettlement(st.id);
        sBox.appendChild(row);
      }
    }
  }
}

// ---------- eksport CSV ----------
function exportCsv() {
  const t = groupTotals();
  const lines = [];
  const sep = ';';
  lines.push(['Grupa', group.name].join(sep));
  lines.push([]);
  lines.push(['PARAGONY', 'Data', 'Kategoria', 'Waluta', 'Kwota', 'Kwota PLN'].join(sep));
  for (const s of sessions) {
    const ts = sessionTotals(s);
    const total = ts.itemsTotal + (ts.tip || 0);
    lines.push([
      '"' + (s.name || 'Rachunek').replace(/"/g, '""') + '"',
      new Date(s.created_at).toLocaleDateString('pl-PL'),
      s.category || 'inne',
      ts.currency,
      total.toFixed(2).replace('.', ','),
      ts.rate ? (total * ts.rate).toFixed(2).replace('.', ',') : 'brak kursu'
    ].join(sep));
  }
  lines.push([]);
  lines.push(['OSOBA', 'Wydal PLN', 'Zaplacil PLN', 'Saldo PLN'].join(sep));
  for (const p of people) {
    const net = t.paidPln[p.id] - t.owedPln[p.id];
    lines.push([p.name, t.owedPln[p.id].toFixed(2).replace('.', ','), t.paidPln[p.id].toFixed(2).replace('.', ','), net.toFixed(2).replace('.', ',')].join(sep));
  }
  const transfers = computeTransfers(t);
  if (transfers.length) {
    lines.push([]);
    lines.push(['DO ODDANIA', 'Komu', 'Kwota PLN'].join(sep));
    for (const tr of transfers) lines.push([tr.from, tr.to, tr.amount.toFixed(2).replace('.', ',')].join(sep));
  }
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (group.name || 'wyjazd').replace(/[^\w\dąęółśżźćń -]/gi, '') + '-rozliczenie.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('CSV pobrany ⬇️');
}

function computeTransfers(t) {
  const nets = people.map(p => ({ name: p.name, net: Math.round((t.paidPln[p.id] - t.owedPln[p.id]) * 100) / 100 }));
  const debtors = nets.filter(x => x.net < -0.005).map(x => ({ ...x, net: -x.net })).sort((a, b) => b.net - a.net);
  const creditors = nets.filter(x => x.net > 0.005).sort((a, b) => b.net - a.net);
  const out = [];
  let di = 0, ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const amount = Math.min(debtors[di].net, creditors[ci].net);
    if (amount > 0.005) out.push({ from: debtors[di].name, to: creditors[ci].name, amount });
    debtors[di].net -= amount;
    creditors[ci].net -= amount;
    if (debtors[di].net <= 0.005) di++;
    if (creditors[ci].net <= 0.005) ci++;
  }
  return out;
}

async function copyGroupSummary() {
  if (!people.length || !sessions.length) return toast('Brak danych');
  const t = groupTotals();
  const lines = [`🏕️ ${group.name} — rozliczenie wyjazdu`, ''];
  for (const p of people) {
    const net = t.paidPln[p.id] - t.owedPln[p.id];
    lines.push(`${p.name}: wydał ${fmt(t.owedPln[p.id])} zł, zapłacił ${fmt(t.paidPln[p.id])} zł → ${net >= 0 ? 'dostaje' : 'oddaje'} ${fmt(Math.abs(net))} zł`);
  }
  const transfers = computeTransfers(t);
  if (transfers.length) {
    lines.push('', 'Przelewy:');
    for (const tr of transfers) lines.push(`  ${tr.from} → ${tr.to}: ${fmt(tr.amount)} zł`);
  }
  lines.push('', 'Szczegóły: ' + location.href);
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    toast('Rozliczenie skopiowane 📋');
  } catch {
    toast('Nie udało się skopiować');
  }
}
