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
  $('group-name-input').addEventListener('input', debounce(async () => {
    await db.from('groups').update({ name: $('group-name-input').value.trim() || 'Wyjazd' }).eq('id', groupId);
  }, 600));

  await loadAll();
  subscribeRealtime();
}

async function loadAll() {
  const g = await db.from('groups').select('*').eq('id', groupId).single();
  if (g.error) { toast('Nie znaleziono grupy'); return; }
  group = g.data;

  const [p, s] = await Promise.all([
    db.from('people').select('*').eq('group_id', groupId).order('created_at'),
    db.from('sessions').select('*').eq('group_id', groupId).order('created_at'),
  ]);
  people = p.data || [];
  sessions = s.data || [];

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
    .subscribe();
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
  await db.from('people').delete().eq('id', id);
  loadAll();
}

async function addReceipt() {
  const { data, error } = await db.from('sessions').insert({ group_id: groupId, name: 'Rachunek ' + (sessions.length + 1) }).select().single();
  if (error) return toast('Błąd: ' + error.message);
  location.href = 'index.html?s=' + data.id;
}

async function removeReceipt(id) {
  if (!confirm('Usunąć ten paragon z całą zawartością?')) return;
  await db.from('sessions').delete().eq('id', id);
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
  return { owedPln, paidPln, unassignedPln, missingRate };
}

function render() {
  if (document.activeElement !== $('group-name-input')) $('group-name-input').value = group.name;
  $('group-title').textContent = '🏕️ ' + group.name;
  document.title = group.name + ' — ParagonSplit';

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
    a.innerHTML = `<strong>🧾 ${s.name || 'Rachunek'}</strong><span class="muted small"> · ${d.toLocaleDateString('pl-PL')} · ${fmt(t.itemsTotal + (t.tip || 0))} ${curTxt}${plnTxt}</span>`;
    const del = document.createElement('button');
    del.className = 'btn-del';
    del.textContent = '✕';
    del.onclick = (e) => { e.preventDefault(); removeReceipt(s.id); };
    row.append(a, del);
    rl.appendChild(row);
  }

  renderGroupSummary();
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
      const row = document.createElement('div');
      row.className = 'settle-row';
      row.innerHTML = `<span>${tr.from} → ${tr.to}</span><strong>${fmt(tr.amount)} zł</strong>`;
      setBox.appendChild(row);
    }
  }
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
