import * as api from './data.js';

let chan = null; // kanal do rozglaszania zmian innym urzadzeniom
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
    try { await api.renameGroup(groupId, $('group-name-input').value.trim() || 'Wyjazd'); api.announce(chan); }
    catch (e) { toast('Błąd: ' + e.message); }
  }, 600));

  await loadAll();
  subscribeRealtime();
}

async function loadAll() {
  // dostep po dokladnym ID (link = dostep), bez mozliwosci listowania cudzych grup
  let b;
  try { b = await api.loadGroupBundle(groupId); }
  catch { toast('Nie znaleziono grupy'); return; }
  group = b.group;
  people = b.people;
  sessions = b.sessions;
  settlements = b.settlements;
  activity = b.activity;
  items = b.items;
  assignments = b.assignments;
  payments = b.payments;

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
  chan = api.subscribe('group-' + groupId, [
    { table: 'groups', filter: `id=eq.${groupId}` },
    { table: 'people', filter: `group_id=eq.${groupId}` },
    { table: 'sessions', filter: `group_id=eq.${groupId}` },
    { table: 'items', filter: undefined },
    { table: 'assignments', filter: undefined },
    { table: 'payments', filter: undefined },
    { table: 'settlements', filter: `group_id=eq.${groupId}` },
    { table: 'activity', filter: `group_id=eq.${groupId}` },
  ], reload);
}

// zapis poszedl: powiadom innych i przeladuj u siebie
function synced() {
  api.announce(chan);
  loadAll();
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
  api.logActivity(groupId, (who ? who + ': ' : '') + text);
}

// ---------- szybki wydatek bez paragonu ----------
async function addQuickExpense() {
  const name = $('qe-name').value.trim();
  // przecinek z klawiatury numerycznej tez ma dzialac
  const amount = Number(String($('qe-amount').value).replace(/\s/g, '').replace(',', '.')) || 0;
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

  try {
    const ses = await api.createSession({ groupId, name });
    await api.updateSession(ses.id, { currency, fx_rate, category });
    await api.addItems(ses.id, [{ name, qty: 1, unit_price: amount, position: 0 }]);
    await api.assignEveryone(ses.id);
    await api.setPayment(ses.id, qePayerId, amount);
    logActivity(`dodał(a) wydatek "${name}" ${amount} ${currency}`);
    $('qe-name').value = ''; $('qe-amount').value = '';
    qePayerId = null;
    toast('Wydatek dodany ⚡');
    synced();
  } catch (e) { toast('Błąd: ' + e.message); }
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
  try { await api.addPerson({ groupId, name }); synced(); }
  catch (e) { toast('Błąd: ' + e.message); }
}

async function removePerson(id) {
  if (!confirm('Usunąć osobę? Zniknie ze WSZYSTKICH paragonów tej grupy razem z przypisaniami.')) return;
  const p = people.find(x => x.id === id);
  try {
    await api.deletePerson(id);
    logActivity('usunął(ęła) osobę ' + (p ? p.name : ''));
    synced();
  } catch (e) { toast('Błąd: ' + e.message); }
}

async function addReceipt() {
  try {
    const s = await api.createSession({ groupId, name: 'Rachunek ' + (sessions.length + 1) });
    logActivity('dodał(a) paragon "' + s.name + '"');
    location.href = 'index.html?s=' + s.id;
  } catch (e) { toast('Błąd: ' + e.message); }
}

async function removeReceipt(id) {
  if (!confirm('Usunąć ten paragon z całą zawartością?')) return;
  const s = sessions.find(x => x.id === id);
  try {
    await api.deleteSession(id);
    logActivity('usunął(ęła) paragon "' + (s ? s.name : '') + '"');
    synced();
  } catch (e) { toast('Błąd: ' + e.message); }
}

// ---------- splaty ----------
async function markSettled(fromId, toId, amount) {
  const from = people.find(p => p.id === fromId), to = people.find(p => p.id === toId);
  if (!confirm(`Potwierdzić: ${from.name} oddał(a) ${to.name} ${fmt(amount)} zł?`)) return;
  try {
    await api.addSettlement(groupId, fromId, toId, Math.round(amount * 100) / 100);
    logActivity(`oznaczył(a) spłatę: ${from.name} → ${to.name} ${fmt(amount)} zł ✓`);
    synced();
  } catch (e) { toast('Błąd: ' + e.message); }
}

async function undoSettlement(id) {
  if (!confirm('Cofnąć tę spłatę?')) return;
  try { await api.deleteSettlement(id); synced(); }
  catch (e) { toast('Błąd: ' + e.message); }
}

// kurs PLN danego paragonu
function sessionRate(s, sessionItems) {
  if ((s.currency || 'PLN') === 'PLN') return 1;
  // "zaplacono lacznie w PLN" obejmuje caly rachunek, wiec napiwek tez wchodzi do mianownika
  const total = sessionItems.reduce((sum, it) => sum + it.qty * it.unit_price, 0) + (Number(s.tip) || 0);
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
    // ta sama regula co na ekranie paragonu: napiwek dziela osoby, ktore cos jadly,
    // a gdy nikt nie ma przypisanych pozycji - wszyscy uczestnicy grupy
    const pids = Object.keys(owed).length ? Object.keys(owed) : people.map(p => p.id);
    for (const pid of pids) {
      const base = owed[pid] || 0;
      const tipShare = s.tip_mode === 'equal'
        ? tip / pids.length
        : (assignedTotal > 0 ? (base / assignedTotal) * tip : tip / pids.length);
      owed[pid] = base + tipShare;
    }
  }
  const paid = {};
  for (const pay of sPay) paid[pay.person_id] = (paid[pay.person_id] || 0) + (Number(pay.amount) || 0);
  // kto wylozyl napiwek (moze byc kilka osob, dzielone po rowno)
  const tipPayers = (Array.isArray(s.tip_payers) ? s.tip_payers : []).filter(id => people.some(p => p.id === id));
  if (tipPayers.length && tip > 0) {
    for (const id of tipPayers) paid[id] = (paid[id] || 0) + tip / tipPayers.length;
  }

  return { owed, paid, unassigned, itemsTotal, tip, rate, currency: s.currency || 'PLN' };
}

// agregacja calego wyjazdu w PLN
function groupTotals() {
  const owedPln = {}, paidPln = {};
  for (const p of people) { owedPln[p.id] = 0; paidPln[p.id] = 0; }
  const missingRate = [];
  let unassignedPln = 0;
  let billPln = 0; // wszystko, co widnieje na paragonach (razem z pozycjami niczyimi)

  for (const s of sessions) {
    const t = sessionTotals(s);
    if (!t.rate) { if (t.itemsTotal > 0) missingRate.push(s); continue; }
    for (const pid in t.owed) if (owedPln[pid] !== undefined) owedPln[pid] += t.owed[pid] * t.rate;
    for (const pid in t.paid) if (paidPln[pid] !== undefined) paidPln[pid] += t.paid[pid] * t.rate;
    unassignedPln += t.unassigned * t.rate;
    billPln += (t.itemsTotal + t.tip) * t.rate;
  }
  // splaty: kto oddal, temu rosnie "zaplacone"; kto dostal, temu maleje
  for (const st of settlements) {
    const amt = Number(st.amount) || 0;
    if (paidPln[st.from_person] !== undefined) paidPln[st.from_person] += amt;
    if (paidPln[st.to_person] !== undefined) paidPln[st.to_person] -= amt;
  }
  return { owedPln, paidPln, unassignedPln, missingRate, billPln };
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
    const phoneTxt = me.phone ? '📱 ' + esc(me.phone) : t('📱 nr do przelewów');
    box.innerHTML = `<div class="me-row">${t('Ty w tej grupie:')} <strong>${esc(me.name)}</strong> <button class="btn-split" id="me-rename">${t('✏️ zmień imię')}</button> <button class="btn-split" id="me-phone">${phoneTxt}</button> <button class="btn-split" id="me-clear">${t('to nie ja')}</button></div>`;
    $('me-rename').onclick = async () => {
      const n = prompt('Twoje imię widoczne w grupie:', me.name);
      if (!n || !n.trim()) return;
      try { await api.updatePerson(me.id, { name: n.trim() }); synced(); }
      catch (e) { toast('Błąd: ' + e.message); }
    };
    $('me-phone').onclick = async () => {
      const n = prompt('Twój numer telefonu (BLIK) — pokaże się osobom, które mają Ci oddać pieniądze.\nPozostaw puste, aby usunąć.', me.phone || '');
      if (n === null) return;
      try { await api.updatePerson(me.id, { phone: n.trim() || null }); synced(); }
      catch (e) { toast('Błąd: ' + e.message); }
    };
    $('me-clear').onclick = () => { localStorage.removeItem('me-' + groupId); render(); };
    return;
  }

  // nowa osoba z linku: wybierz siebie albo dopisz sie
  const wrap = document.createElement('div');
  wrap.className = 'me-join';
  wrap.innerHTML = '<p class="me-hello">' + t('👋 Kim jesteś w tej grupie?') + '</p>';
  if (people.length) {
    const hint = document.createElement('p');
    hint.className = 'muted small';
    hint.textContent = t('Jesteś już na liście? Dotknij swojego imienia:');
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
  inp.placeholder = people.length ? t('Albo dopisz nowe imię') : t('Twoje imię');
  inp.maxLength = 30;
  const btn = document.createElement('button');
  btn.className = 'btn-small';
  btn.textContent = t('Dołącz');
  const join = async () => {
    const name = inp.value.trim();
    if (!name) return;
    if (people.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast('To imię już jest — dotknij go na liście');
    let person;
    try { person = await api.addPerson({ groupId, name }); }
    catch (e) { return toast('Błąd: ' + e.message); }
    localStorage.setItem('me-' + groupId, person.id);
    api.logActivity(groupId, name + ' dołączył(a) do grupy 👋');
    toast('Witaj w grupie, ' + name + '! 🎉');
    synced();
  };
  btn.onclick = join;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
  row.append(inp, btn);
  wrap.appendChild(row);
  box.appendChild(wrap);
}

// Czy paragon jest rozliczony: wszystkie pozycje przypisane do osob i wiadomo, kto zaplacil.
function receiptStatus(s, st) {
  const sItems = items.filter(i => i.session_id === s.id);
  if (!sItems.length) return { cls: 'st-empty', icon: '○', text: t('pusty — brak pozycji') };

  const sAsg = assignments.filter(a => a.session_id === s.id);
  const assignedIds = new Set(sAsg.map(a => a.item_id));
  const missing = sItems.filter(i => !assignedIds.has(i.id)).length;
  if (missing) {
    return { cls: 'st-warn', icon: '⚠️', text: missing + ' z ' + sItems.length + ' ' + t('poz. bez osoby') };
  }

  const hasPayer = payments.some(p => p.session_id === s.id)
    || (Array.isArray(s.tip_payers) && s.tip_payers.length);
  if (!hasPayer) return { cls: 'st-warn', icon: '⚠️', text: t('nie wiadomo, kto zapłacił') };

  if (!st.rate) return { cls: 'st-warn', icon: '⚠️', text: t('brak kursu') };

  return { cls: 'st-ok', icon: '✓', text: t('rozliczony') };
}

function render() {
  if (document.activeElement !== $('group-name-input')) $('group-name-input').value = group.name;
  $('group-title').textContent = '🏕️ ' + group.name;
  document.title = group.name + ' — ParagonSplit';

  renderMe();

  // uczestnicy
  const pl = $('people-list');
  pl.innerHTML = '';
  if (!people.length) pl.innerHTML = '<span class="muted small">' + t('Dodaj uczestników wyjazdu — będą widoczni we wszystkich paragonach') + '</span>';
  for (const p of people) {
    // usuwa tylko ✕ - klikniecie w imie nie kasuje uczestnika przez przypadek
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = p.name;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = t('Usuń osobę');
    x.onclick = () => removePerson(p.id);
    chip.appendChild(x);
    pl.appendChild(chip);
  }

  // paragony
  const rl = $('receipts-list');
  rl.innerHTML = '';
  if (!sessions.length) rl.innerHTML = '<p class="muted small">' + t('Brak paragonów — dodaj pierwszy.') + '</p>';
  for (const s of sessions) {
    // UWAGA: nie nazywac tego `t` — przyslania globalna funkcje tlumaczen t()
    const st = sessionTotals(s);
    const row = document.createElement('div');
    row.className = 'receipt-row';
    const a = document.createElement('a');
    a.href = 'index.html?s=' + s.id;
    const curTxt = st.currency === 'PLN' ? 'zł' : st.currency;
    const plnTxt = st.currency !== 'PLN' ? (st.rate ? ` ≈ ${fmt(st.itemsTotal * st.rate + (st.tip || 0) * st.rate)} zł` : ' ⚠️ brak kursu') : '';
    const d = new Date(s.created_at);
    const catIcon = CATS[s.category] || '🧾';
    const stat = receiptStatus(s, st);
    a.innerHTML = `<strong>${catIcon} ${esc(s.name || 'Rachunek')}</strong>`
      + `<span class="muted small"> · ${d.toLocaleDateString('pl-PL')} · ${fmt(st.itemsTotal + (st.tip || 0))} ${curTxt}${plnTxt}</span>`
      + `<span class="receipt-status ${stat.cls}">${stat.icon} ${esc(stat.text)}</span>`;
    const ren = document.createElement('button');
    ren.className = 'btn-rename';
    ren.textContent = '✏️';
    ren.title = t('Zmień nazwę');
    ren.onclick = async (e) => {
      e.preventDefault();
      const n = prompt('Nazwa paragonu:', s.name || 'Rachunek');
      if (n === null) return;
      const name = n.trim();
      if (!name || name === s.name) return;
      try {
        await api.updateSession(s.id, { name });
        logActivity('zmienił(a) nazwę paragonu na "' + name + '"');
        synced();
      } catch (err) { toast('Błąd: ' + err.message); }
    };

    const del = document.createElement('button');
    del.className = 'btn-del';
    del.textContent = '✕';
    del.onclick = (e) => { e.preventDefault(); removeReceipt(s.id); };
    row.append(a, ren, del);
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
  if (!entries.length) { box.innerHTML = '<p class="muted small">' + t('Brak wydatków.') + '</p>'; return; }
  const max = entries[0][1];
  for (const [cat, val] of entries) {
    const row = document.createElement('div');
    row.className = 'cat-row';
    row.innerHTML = `<span class="cat-label">${CATS[cat] || '📦'} ${esc(t(cat))}</span><div class="cat-track"><div class="cat-bar" style="width:${Math.max(4, Math.round(val / max * 100))}%"></div></div><span class="cat-val">${fmt(val)} zł</span>`;
    box.appendChild(row);
  }
}

function renderActivity() {
  const box = $('activity-list');
  if (!box) return;
  box.innerHTML = '';
  if (!activity.length) { box.innerHTML = '<p class="muted small">' + t('Brak aktywności.') + '</p>'; return; }
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
    box.innerHTML = '<p class="muted small">' + t('Dodaj uczestników i paragony, aby zobaczyć rozliczenie.') + '</p>';
    return;
  }

  const g = groupTotals();
  let grandOwed = 0, grandPaid = 0;
  for (const p of people) {
    grandOwed += g.owedPln[p.id];
    grandPaid += g.paidPln[p.id];
    const net = g.paidPln[p.id] - g.owedPln[p.id];
    const row = document.createElement('div');
    row.className = 'summary-row';
    row.innerHTML = `<span>${esc(p.name)}<span class="details">${t('wydał')} ${fmt(g.owedPln[p.id])} zł · ${t('zapłacił')} ${fmt(g.paidPln[p.id])} zł</span></span><strong class="${net < -0.005 ? 'neg' : net > 0.005 ? 'pos' : ''}">${net > 0.005 ? '+' : ''}${fmt(net)} zł</strong>`;
    box.appendChild(row);
  }
  const totalRow = document.createElement('div');
  totalRow.className = 'summary-row total';
  // suma z paragonow (ta sama, co w wykresie kategorii); pozycje niczyje sa w niej zawarte
  const detail = g.unassignedPln > 0.005 ? `<span class="details">${t('rozdzielone')} ${fmt(grandOwed)} zł</span>` : '';
  totalRow.innerHTML = `<span>${t('Razem wydatki')}</span><span class="amount-col"><span>${fmt(g.billPln)} zł</span>${detail}</span>`;
  box.appendChild(totalRow);

  if (g.unassignedPln > 0.005) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = `⚠️ ${t('Nieprzypisane pozycje')}: ${fmt(g.unassignedPln)} zł`;
    box.appendChild(w);
  }
  for (const s of g.missingRate) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = `⚠️ „${s.name || 'Rachunek'}" (${s.currency}) pominięty — brak kursu. Otwórz go i podaj kurs lub kwotę w PLN.`;
    box.appendChild(w);
  }
  if (Math.abs(grandPaid - g.billPln) > 0.01 && grandPaid > 0) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = `⚠️ Suma wpłat (${fmt(grandPaid)} zł) ≠ suma z paragonów (${fmt(g.billPln)} zł) — sprawdź "kto zapłacił" w paragonach.`;
    box.appendChild(w);
  }

  const transfers = computeTransfers(g);
  if (transfers.length) {
    const h = document.createElement('h3');
    h.className = 'settle-title';
    h.textContent = t('Kto komu oddaje');
    setBox.appendChild(h);
    for (const tr of transfers) {
      const toPerson = people.find(p => p.name === tr.to);
      const phone = toPerson && toPerson.phone ? ` <span class="muted small">📱 ${esc(toPerson.phone)}</span>` : '';
      const row = document.createElement('div');
      row.className = 'settle-row';
      row.innerHTML = `<span>${esc(tr.from)} → ${esc(tr.to)}${phone}</span><span class="settle-actions"><strong>${fmt(tr.amount)} zł</strong> <button class="btn-small settle-done">${t('✓ oddane')}</button></span>`;
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
      h2.textContent = t('Spłacone ✓');
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
