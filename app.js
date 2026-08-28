import * as api from './data.js';
import { db, SUPABASE_URL } from './data.js';

// ---------- stan ----------
let chan = null; // kanal do rozglaszania zmian innym urzadzeniom
let sessionId = null;
let session = null;
let people = [];
let items = [];
let assignments = []; // {item_id, person_id, shares}
let payments = []; // {session_id, person_id, amount}
let renderPending = false;
let lastPhoto = null; // {base64, stored} - ostatnie zdjecie do ponownej analizy bez wybierania pliku

const $ = (id) => document.getElementById(id);
const fmt = (n) => (Math.round(n * 100) / 100).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function toast(msg, ms = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---------- start ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// przycisk instalacji PWA
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstall = e;
  const b = $('btn-install');
  if (b) b.classList.remove('hidden');
});
function bindInstall() {
  const b = $('btn-install');
  if (!b) return;
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (isIos && !standalone) b.classList.remove('hidden');
  b.onclick = async () => {
    if (deferredInstall) {
      deferredInstall.prompt();
      await deferredInstall.userChoice;
      deferredInstall = null;
      b.classList.add('hidden');
    } else if (isIos) {
      toast('Safari: Udostępnij → „Dodaj do ekranu początkowego"', 5000);
    } else {
      toast('Menu przeglądarki → „Zainstaluj aplikację"', 4000);
    }
  };
}

init();

async function init() {
  bindInstall();
  const params = new URLSearchParams(location.search);
  sessionId = params.get('s');

  if (!sessionId) {
    $('view-landing').classList.remove('hidden');
    $('btn-new').onclick = () => createSession(); // bez argumentu! (event to nie groupId)
    initLanding();
    return;
  }

  $('view-session').classList.remove('hidden');
  $('btn-share').classList.remove('hidden');
  bindUI();
  await loadAll();
  subscribeRealtime();
}

async function createSession(groupId) {
  try {
    const s = await api.createSession({ groupId: groupId || null });
    location.search = '?s=' + s.id;
  } catch (e) { toast('Błąd: ' + e.message); }
}

// zapis poszedl: powiadom innych i przeladuj u siebie
function synced() {
  api.announce(chan);
  loadAll();
}

// ---------- landing: logowanie + grupy ----------
async function initLanding() {
  $('btn-login').onclick = async () => {
    const { error } = await db.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin } });
    if (error) toast('Błąd logowania: ' + error.message);
  };
  $('btn-logout').onclick = async () => { await db.auth.signOut(); renderAuth(null); };
  $('btn-new-group').onclick = createGroup;
  $('group-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') createGroup(); });

  const { data: { user } } = await db.auth.getUser();
  renderAuth(user);
  db.auth.onAuthStateChange((_ev, sess) => renderAuth(sess ? sess.user : null));
}

let currentUser = null;
async function renderAuth(user) {
  currentUser = user;
  $('auth-logged-out').classList.toggle('hidden', !!user);
  $('auth-logged-in').classList.toggle('hidden', !user);
  if (user) $('auth-email').textContent = '👤 ' + (user.email || 'zalogowano');
  renderGroupsList();
}

function visitedGroups() {
  try { return JSON.parse(localStorage.getItem('visitedGroups') || '[]'); } catch { return []; }
}

let groupsSeq = 0;
async function renderGroupsList() {
  const box = $('groups-list');

  // lista grup widoczna tylko po zalogowaniu
  if (!currentUser) {
    box.innerHTML = '<p class="muted small">Zaloguj się, aby zobaczyć swoje grupy. Do cudzej grupy dołączysz przez otrzymany link.</p>';
    return;
  }

  // renderAuth() wola sie dwa razy (getUser + onAuthStateChange), wiec bez tego licznika
  // oba przebiegi dopisywaly sie do listy i grupy dublowaly sie na ekranie
  const seq = ++groupsSeq;
  const mine = await api.myGroups(currentUser.id).catch(() => []);
  if (seq !== groupsSeq) return;
  box.innerHTML = '';
  const seen = new Set(mine.map(g => g.id));
  const visited = visitedGroups().filter(g => !seen.has(g.id));
  const all = [...mine, ...visited.map(v => ({ ...v, visited: true }))];
  if (!all.length) {
    box.innerHTML = '<p class="muted small">Brak grup — utwórz pierwszą poniżej.</p>';
    return;
  }
  for (const g of all) {
    const a = document.createElement('a');
    a.className = 'group-link';
    a.href = 'group.html?g=' + g.id;
    a.textContent = '🏕️ ' + g.name + (g.visited ? ' (dołączono z linku)' : '');
    box.appendChild(a);
  }
}

async function createGroup() {
  if (!currentUser) return toast('Zaloguj się, aby utworzyć grupę');
  const name = $('group-name').value.trim() || 'Wyjazd';
  try {
    const g = await api.createGroup(name, currentUser.id);
    location.href = 'group.html?g=' + g.id;
  } catch (e) { toast('Błąd: ' + e.message); }
}

// ---------- dane ----------
async function loadAll() {
  let b;
  try { b = await api.loadSessionBundle(sessionId); }
  catch { toast('Nie znaleziono sesji'); return; }
  session = b.session;
  people = b.people;
  items = b.items;
  assignments = b.assignments;
  payments = b.payments;

  const back = $('group-backlink');
  if (back && session.group_id) {
    back.classList.remove('hidden');
    $('group-back-a').href = 'group.html?g=' + session.group_id;
  }
  render();
}

// waluta sesji + efektywny kurs PLN
function cur() { return (session && session.currency) || 'PLN'; }
function effectiveRate() {
  if (cur() === 'PLN') return 1;
  // "zaplacono lacznie w PLN" dotyczy calego rachunku, wiec napiwek tez wchodzi do mianownika
  const billTotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0) + (Number(session.tip) || 0);
  const pb = Number(session.paid_base) || 0;
  if (pb > 0 && billTotal > 0) return pb / billTotal;
  return Number(session.fx_rate) || null;
}

// osoby, ktore wylozyly pieniadze na napiwek (moze byc kilka - dzielone rowno)
function tipPayerIds() {
  const raw = session && session.tip_payers;
  const arr = Array.isArray(raw) ? raw : [];
  return arr.filter(id => people.some(p => p.id === id));
}

// ile kazda osoba faktycznie wylozyla: wplaty + jej czesc napiwku
function paidByPerson() {
  const paid = {};
  for (const p of people) paid[p.id] = 0;
  for (const pay of payments) if (paid[pay.person_id] !== undefined) paid[pay.person_id] += Number(pay.amount) || 0;
  const tp = tipPayerIds();
  const tip = Number(session.tip) || 0;
  if (tp.length && tip > 0) for (const id of tp) paid[id] += tip / tp.length;
  return paid;
}
const fmtC = (n) => fmt(n) + ' ' + (cur() === 'PLN' ? 'zł' : cur());

async function fetchNbpRate(code) {
  // tabela A (popularne) -> tabela B (egzotyczne, np. ALL - lek albanski)
  for (const table of ['a', 'b']) {
    try {
      const r = await fetch('https://api.nbp.pl/api/exchangerates/rates/' + table + '/' + code.toLowerCase() + '/?format=json');
      if (r.ok) {
        const d = await r.json();
        if (d.rates && d.rates[0]) return d.rates[0].mid;
      }
    } catch { /* dalej */ }
  }
  return null;
}

// dopisz walute do selecta, jesli jej nie ma
function ensureCurrencyOption(sel, code) {
  if (![...sel.options].some(o => o.value === code)) {
    const o = document.createElement('option');
    o.value = o.textContent = code;
    const other = sel.querySelector('option[value="__other"]');
    if (other) sel.insertBefore(o, other); else sel.appendChild(o);
  }
}

function subscribeRealtime() {
  const reload = debounce(loadAll, 300);
  // w sesji grupowej osoby wisza pod group_id, nie pod session_id
  const peopleFilter = session && session.group_id
    ? `group_id=eq.${session.group_id}`
    : `session_id=eq.${sessionId}`;
  chan = api.subscribe('session-' + sessionId, [
    { table: 'items', filter: `session_id=eq.${sessionId}` },
    { table: 'people', filter: peopleFilter },
    { table: 'assignments', filter: `session_id=eq.${sessionId}` },
    { table: 'sessions', filter: `id=eq.${sessionId}` },
    { table: 'payments', filter: `session_id=eq.${sessionId}` },
  ], reload);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ---------- UI ----------
function bindUI() {
  $('btn-share').onclick = share;
  $('btn-add-person').onclick = addPerson;
  $('person-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') addPerson(); });
  $('btn-add-item').onclick = addItemManual;
  $('btn-all-assign').onclick = assignEveryoneToEverything;
  $('file-input').addEventListener('change', onPhoto);
  $('session-name').addEventListener('input', debounce(async (e) => {
    const name = e.target.value.trim() || 'Rachunek';
    try { await api.updateSession(sessionId, { name }); api.announce(chan); }
    catch (err) { toast('Błąd: ' + err.message); }
  }, 600));
  const retryBtn = $('btn-retry-ai');
  if (retryBtn) retryBtn.onclick = analyzePhoto;
  $('category').addEventListener('change', async (e) => {
    await api.updateSession(sessionId, { category: e.target.value }).catch(err => toast('Błąd: ' + err.message));
    api.announce(chan);
  });
  $('tip-input').addEventListener('change', async (e) => {
    const tip = Math.max(0, parseFloat(String(e.target.value).replace(',', '.')) || 0);
    await api.updateSession(sessionId, { tip }).catch(err => toast('Błąd: ' + err.message));
    synced();
  });
  $('tip-prop').onclick = () => setTipMode('proportional');
  $('tip-equal').onclick = () => setTipMode('equal');
  $('btn-expand-all').onclick = toggleAllDetails;
  $('btn-copy-summary').onclick = copySummary;

  // link do ustawienia wlasnego klucza AI
  const aiBtn = document.createElement('button');
  aiBtn.className = 'btn-split';
  aiBtn.textContent = '🔑 Własny klucz AI';
  aiBtn.title = 'Ustaw własny klucz Gemini do analizy paragonów';
  aiBtn.onclick = setupAiKey;
  $('receipt-thumbs').insertAdjacentElement('afterend', aiBtn);

  $('currency').addEventListener('change', async (e) => {
    let c = e.target.value;
    if (c === '__other') {
      const code = (prompt('Podaj 3-literowy kod waluty (ISO), np. ALL dla albańskiego leka, RSD dla dinara serbskiego:') || '').trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) { renderCurrency(); return; }
      ensureCurrencyOption(e.target, code);
      c = code;
      e.target.value = code;
    }
    let patch = { currency: c };
    if (c !== 'PLN') {
      const mid = await fetchNbpRate(c);
      if (mid) patch.fx_rate = mid;
    } else {
      patch.fx_rate = null;
      patch.paid_base = null;
    }
    await api.updateSession(sessionId, patch).catch(err => toast('Błąd: ' + err.message));
    synced();
  });
  $('fx-rate').addEventListener('change', async (e) => {
    const v = Number(e.target.value) || null;
    await api.updateSession(sessionId, { fx_rate: v }).catch(err => toast('Błąd: ' + err.message));
    synced();
  });
  $('paid-base').addEventListener('change', async (e) => {
    const v = Number(e.target.value) || null;
    await api.updateSession(sessionId, { paid_base: v }).catch(err => toast('Błąd: ' + err.message));
    synced();
  });
}

function renderCurrency() {
  const c = cur();
  ensureCurrencyOption($('currency'), c);
  if (document.activeElement !== $('currency')) $('currency').value = c;
  if (document.activeElement !== $('category')) $('category').value = session.category || 'inne';
  const foreign = c !== 'PLN';
  $('fx-rate').classList.toggle('hidden', !foreign);
  $('fx-label').classList.toggle('hidden', !foreign);
  $('paid-base-row').classList.toggle('hidden', !foreign);
  if (foreign) {
    if (document.activeElement !== $('fx-rate')) $('fx-rate').value = session.fx_rate || '';
    if (document.activeElement !== $('paid-base')) $('paid-base').value = session.paid_base || '';
    const eff = effectiveRate();
    $('fx-label').textContent = 'PLN za 1 ' + c + (Number(session.paid_base) > 0 && eff ? ` (kurs z wpłaty: ${eff.toFixed(4)})` : '');
  }
}

function toggleAllDetails() {
  const all = document.querySelectorAll('#summary .person-details');
  if (!all.length) return;
  const anyHidden = [...all].some(d => d.classList.contains('hidden'));
  all.forEach(d => d.classList.toggle('hidden', !anyHidden));
  document.querySelectorAll('#summary .summary-row.clickable').forEach(r => r.classList.toggle('open', anyHidden));
  $('btn-expand-all').textContent = anyHidden ? '▴ Zwiń wszystkich' : '▾ Rozwiń wszystkich';
}

// pelny tekst rozliczenia do wklejenia na czacie
function buildSummaryText() {
  const tot = computeTotals();
  const lines = [t('🧾 Rozliczenie rachunku'), ''];
  const rate = effectiveRate();
  for (const p of people) {
    const plnTxt = cur() !== 'PLN' && rate ? ` (≈ ${fmt(tot.owed[p.id] * rate)} zł)` : '';
    lines.push(`${p.name} ${t('— do zapłaty')} ${fmtC(tot.owed[p.id])}${plnTxt}`);
    for (const item of items) {
      const as = assignments.filter(a => a.item_id === item.id);
      const mine = as.find(a => a.person_id === p.id);
      if (!mine) continue;
      const totalSh = as.reduce((s, a) => s + (a.shares || 1), 0);
      const cost = item.qty * item.unit_price * (mine.shares || 1) / totalSh;
      const shareTxt = totalSh > 1 ? ` (${mine.shares || 1}/${totalSh})` : '';
      lines.push(`  • ${item.name}${shareTxt}: ${fmtC(cost)}`);
    }
    if (tot.tipShares[p.id] > 0.005) lines.push(`  • ${t('napiwek')}: ${fmtC(tot.tipShares[p.id])}`);
    lines.push('');
  }
  lines.push(`${t('Razem')}: ${fmtC(tot.grand)}${cur() !== 'PLN' && rate ? ` ≈ ${fmt(tot.grand * rate)} zł (${rate.toFixed(4)})` : ''}`);
  const tpIds = tipPayerIds();
  if (tpIds.length && tot.tip > 0) {
    const names = tpIds.map(id => (people.find(p => p.id === id) || {}).name).filter(Boolean).join(', ');
    lines.push(`${t('Napiwek wyłożyli')}: ${names} (${fmtC(tot.tip)})`);
  }
  if (tot.unassignedSum > 0.005) lines.push(`⚠️ ${t('Nieprzypisane pozycje')}: ${fmtC(tot.unassignedSum)}`);

  if (payments.length || tipPayerIds().length) {
    const paid = paidByPerson();
    const nets = people.map(p => ({ name: p.name, net: Math.round((paid[p.id] - tot.owed[p.id]) * 100) / 100 }));
    const debtors = nets.filter(x => x.net < -0.005).map(x => ({ ...x, net: -x.net })).sort((a, b) => b.net - a.net);
    const creditors = nets.filter(x => x.net > 0.005).sort((a, b) => b.net - a.net);
    if (debtors.length && creditors.length) {
      lines.push('', t('Kto komu oddaje:'));
      let di = 0, ci = 0;
      while (di < debtors.length && ci < creditors.length) {
        const amount = Math.min(debtors[di].net, creditors[ci].net);
        if (amount > 0.005) lines.push(`  ${debtors[di].name} → ${creditors[ci].name}: ${fmtC(amount)}`);
        debtors[di].net -= amount;
        creditors[ci].net -= amount;
        if (debtors[di].net <= 0.005) di++;
        if (creditors[ci].net <= 0.005) ci++;
      }
    }
  }
  return lines.join('\n');
}

async function copySummary() {
  if (!people.length || !items.length) return toast('Brak danych do rozliczenia');
  try {
    await navigator.clipboard.writeText(buildSummaryText());
    toast('Rozliczenie skopiowane 📋 — wklej na czacie');
  } catch {
    toast('Nie udało się skopiować');
  }
}

async function setTipMode(mode) {
  await api.updateSession(sessionId, { tip_mode: mode }).catch(e => toast('Błąd: ' + e.message));
  synced();
}

async function share() {
  const url = location.href;
  if (navigator.share) {
    try { await navigator.share({ title: 'Podziel rachunek', url }); return; } catch { /* anulowano */ }
  }
  await navigator.clipboard.writeText(url);
  toast('Link skopiowany 📋');
}

// ---------- osoby ----------
async function addPerson() {
  const name = $('person-name').value.trim();
  if (!name) return;
  if (people.some(p => p.name.toLowerCase() === name.toLowerCase())) return toast('Ta osoba już jest');
  $('person-name').value = '';
  try {
    await api.addPerson(session && session.group_id
      ? { groupId: session.group_id, name }
      : { sessionId, name });
    synced();
  } catch (e) { toast('Błąd: ' + e.message); }
}

async function removePerson(id) {
  const p = people.find(x => x.id === id);
  const who = p ? ` „${p.name}"` : '';
  const msg = session && session.group_id
    ? `Usunąć osobę${who} z CAŁEJ grupy? Zniknie ze wszystkich paragonów wyjazdu razem z przypisaniami.`
    : `Usunąć osobę${who} i jej przypisania?`;
  if (!confirm(msg)) return;
  try { await api.deletePerson(id); synced(); }
  catch (e) { toast('Błąd: ' + e.message); }
}

// ---------- pozycje ----------
async function addItemManual() {
  try {
    await api.addItems(sessionId, [{ name: t('Nowa pozycja'), qty: 1, unit_price: 0, position: items.length }]);
    synced();
  } catch (e) { toast('Błąd: ' + e.message); }
}

async function removeItem(id) {
  try { await api.deleteItem(id); synced(); }
  catch (e) { toast('Błąd: ' + e.message); }
}

const saveItem = debounce(async (id, patch) => {
  try { await api.updateItem(id, patch); api.announce(chan); }
  catch (e) { toast('Błąd: ' + e.message); }
}, 500);

// "4x Piwo" -> 4 osobne pozycje po 1 szt.
async function splitItem(item) {
  const qty = Math.round(item.qty);
  if (qty < 2) return;
  const rows = [];
  for (let k = 0; k < qty - 1; k++) {
    rows.push({ name: item.name, orig_name: item.orig_name, qty: 1, unit_price: item.unit_price, position: item.position });
  }
  try {
    await api.addItems(sessionId, rows);
    await api.updateItem(item.id, { qty: 1 });
    synced();
  } catch (e) { toast('Błąd: ' + e.message); }
}

async function toggleAssign(itemId, personId) {
  const exists = assignments.some(a => a.item_id === itemId && a.person_id === personId);
  try { await api.setAssignment(sessionId, itemId, personId, exists ? 0 : 1); synced(); }
  catch (e) { toast('Błąd: ' + e.message); }
}

// jednym tapnieciem: kazda pozycja podzielona rowno na wszystkich
async function assignEveryoneToEverything() {
  if (!people.length || !items.length) return toast('Brak osób lub pozycji');
  if (!confirm('Przypisać WSZYSTKIE osoby do WSZYSTKICH pozycji (po równo)? Istniejące przypisania zostaną zachowane.')) return;
  try {
    const n = await api.assignEveryone(sessionId);
    toast(n ? `Przypisano ${n} pozycji 👥` : 'Wszystko już przypisane');
    synced();
  } catch (e) { toast('Błąd: ' + e.message); }
}

// zwieksz udzial osoby w pozycji (np. para je za dwoje): 1 -> 2 -> 3 ... max 9
async function bumpShares(itemId, personId) {
  const a = assignments.find(x => x.item_id === itemId && x.person_id === personId);
  if (!a) return;
  const next = Math.min(9, (a.shares || 1) + 1);
  try { await api.setAssignment(sessionId, itemId, personId, next); synced(); }
  catch (e) { toast('Błąd: ' + e.message); }
}

// ---------- kto zaplacil ----------
async function togglePayer(personId) {
  const exists = payments.some(x => x.person_id === personId);
  let amount = null;
  if (!exists) {
    const t = computeTotals();
    const paidSoFar = payments.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    // napiwek wylozony osobno nie wchodzi do kwoty podpowiadanej platnikowi rachunku
    const tipCovered = tipPayerIds().length ? t.tip : 0;
    amount = Math.max(0, Math.round((t.billTotal - tipCovered - paidSoFar) * 100) / 100);
  }
  try { await api.setPayment(sessionId, personId, amount); synced(); }
  catch (e) { toast('Błąd: ' + e.message); }
}

const savePayment = debounce(async (personId, amount) => {
  try { await api.setPayment(sessionId, personId, amount); synced(); }
  catch (e) { toast('Błąd: ' + e.message); }
}, 600);

// ---------- klucz AI (wlasny klucz Gemini per urzadzenie) ----------
function setupAiKey() {
  const cur = localStorage.getItem('geminiKey') || '';
  const key = prompt(
    'Analiza paragonów AI wymaga klucza Gemini.\n\n' +
    'Jak zdobyć darmowy klucz (2 min):\n' +
    '1. Wejdź na aistudio.google.com/apikey\n' +
    '2. Zaloguj się kontem Google\n' +
    '3. Kliknij "Create API key" i skopiuj klucz\n\n' +
    'Wklej klucz poniżej — zapisze się tylko na tym urządzeniu.\n' +
    '(pozostaw puste i OK, aby usunąć zapisany klucz)',
    cur
  );
  if (key === null) return;
  const k = key.trim();
  if (k) { localStorage.setItem('geminiKey', k); toast('Klucz zapisany na tym urządzeniu 🔑'); }
  else { localStorage.removeItem('geminiKey'); toast('Klucz usunięty'); }
}

// ---------- zdjęcie -> Gemini ----------
function showRetry(on) {
  const b = $('btn-retry-ai');
  if (b) b.classList.toggle('hidden', !on);
}

async function onPhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  try {
    const { base64, blob } = await downscale(file);
    lastPhoto = { base64, blob, stored: false };
  } catch {
    $('upload-status').textContent = '❌ Nie udało się odczytać zdjęcia.';
    return;
  }
  analyzePhoto();
}

// analiza ostatniego zdjecia - wolana tez przez "Sprobuj ponownie", bez wybierania pliku od nowa
async function analyzePhoto() {
  if (!lastPhoto) return;
  const status = $('upload-status');
  showRetry(false);
  status.innerHTML = '<span class="spinner">🤖 Analizuję paragon…</span>';
  const hadItems = items.length;

  try {
    // podglad zapisujemy tylko raz - ponowna proba nie dubluje miniatur
    if (!lastPhoto.stored) {
      try {
        const path = sessionId + '/' + Date.now() + '.jpg';
        const up = await db.storage.from('receipts').upload(path, lastPhoto.blob, { contentType: 'image/jpeg' });
        if (!up.error) {
          const url = SUPABASE_URL + '/storage/v1/object/public/receipts/' + path;
          const urls = Array.isArray(session.receipt_urls) ? session.receipt_urls : [];
          await api.updateSession(sessionId, { receipt_urls: [...urls, url] });
          lastPhoto.stored = true;
        }
      } catch (e2) { console.warn('Nie udalo sie zapisac podgladu paragonu', e2); }
    }

    // autoryzacja AI: zalogowany user (whitelist) albo wlasny klucz z tego urzadzenia
    const headers = { 'Content-Type': 'application/json' };
    try {
      const { data: sess } = await db.auth.getSession();
      if (sess && sess.session) headers.Authorization = 'Bearer ' + sess.session.access_token;
    } catch { /* niezalogowany */ }
    const userKey = localStorage.getItem('geminiKey') || undefined;

    const r = await fetch('/api/parse-receipt', {
      method: 'POST',
      headers,
      body: JSON.stringify({ image: lastPhoto.base64, mimeType: 'image/jpeg', userKey }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 403 && data.needKey) {
      status.innerHTML = '🔑 Analiza AI wymaga własnego (darmowego) klucza Gemini. Pozycje możesz też dodać ręcznie.';
      showRetry(true);
      setupAiKey();
      return;
    }
    if (!r.ok) throw new Error(data.error || ('Błąd API (' + r.status + ')'));

    const parsed = Array.isArray(data.items) ? data.items : [];
    if (!parsed.length) {
      status.textContent = 'Nie rozpoznano pozycji — spróbuj ponownie lub zrób wyraźniejsze zdjęcie.';
      showRetry(true);
      return;
    }

    const rows = parsed.map((it, idx) => {
      const orig = String(it.name || '').trim();
      const shown = String(it.name_pl || '').trim() || orig;
      return {
        name: shown,
        orig_name: orig && orig !== shown ? orig : null,
        qty: it.qty,
        unit_price: it.unit_price,
        position: hadItems + idx,
      };
    });
    await api.addItems(sessionId, rows);

    const extra = await applyReceiptMeta(data, hadItems);
    status.textContent = `✅ Rozpoznano ${parsed.length} pozycji — sprawdź i popraw w razie potrzeby.` + extra;
    synced();
  } catch (err) {
    status.textContent = '❌ ' + err.message;
    showRetry(true);
  }
}

// nazwa lokalu, kategoria i waluta wykryte przez AI - ustawiane tylko gdy uzytkownik sam nic nie wybral
async function applyReceiptMeta(data, hadItems) {
  const patch = {};
  const notes = [];

  const isDefaultName = !session.name || /^Rachunek(\s+\d+)?$/i.test(String(session.name).trim());
  if (data.merchant && isDefaultName) {
    patch.name = data.merchant;
    notes.push('nazwa: ' + data.merchant);
  }
  if (data.category && (!session.category || session.category === 'inne')) {
    patch.category = data.category;
    notes.push('kategoria: ' + data.category);
  }
  // waluta tylko na pustym rachunku, zeby nie przestawic juz policzonych pozycji
  if (data.currency && data.currency !== cur() && cur() === 'PLN' && !hadItems) {
    patch.currency = data.currency;
    const mid = await fetchNbpRate(data.currency);
    if (mid) patch.fx_rate = mid;
    notes.push('waluta: ' + data.currency + (mid ? ` (kurs NBP ${mid})` : ' — podaj kurs ręcznie'));
  }

  if (!Object.keys(patch).length) return '';
  try { await api.updateSession(sessionId, patch); }
  catch { return ''; }
  Object.assign(session, patch);
  return ' Ustawiono automatycznie — ' + notes.join(', ') + '.';
}

function downscale(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const MAX = 1280;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
      canvas.toBlob((blob) => {
        resolve({ base64: dataUrl.split(',')[1], blob });
        URL.revokeObjectURL(img.src);
      }, 'image/jpeg', 0.8);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- render ----------
function render() {
  // nie nadpisuj, gdy ktoś właśnie edytuje pole
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && (ae.closest('#items-list') || ae.closest('#payer-rows'))) {
    if (!renderPending) {
      renderPending = true;
      ae.addEventListener('blur', () => { renderPending = false; render(); }, { once: true });
    }
    return;
  }

  const sn = $('session-name');
  if (sn && document.activeElement !== sn) sn.value = session.name || '';

  renderPeople();
  renderReceipts();
  renderCurrency();
  renderItems();
  renderTip();
  renderPayers();
  renderSummary();
}

function renderReceipts() {
  const box = $('receipt-thumbs');
  if (!box) return;
  box.innerHTML = '';
  const urls = Array.isArray(session && session.receipt_urls) ? session.receipt_urls : [];
  for (const url of urls) {
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    const img = document.createElement('img');
    img.src = url;
    img.alt = 'Paragon';
    img.loading = 'lazy';
    a.appendChild(img);
    box.appendChild(a);
  }
}

function renderPeople() {
  const box = $('people-list');
  box.innerHTML = '';
  if (!people.length) box.innerHTML = '<span class="muted small">' + t('Dodaj osoby, które się składają') + '</span>';
  for (const p of people) {
    // usuwa tylko ✕ - klikniecie w imie nie kasuje osoby przez przypadek
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = p.name;
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = '✕';
    x.title = t('Usuń osobę');
    x.onclick = () => removePerson(p.id);
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

function renderItems() {
  const box = $('items-list');
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<p class="muted small">' + t('Brak pozycji — wgraj zdjęcie paragonu lub dodaj ręcznie.') + '</p>';
    return;
  }
  for (const item of items) {
    const itemAssignments = assignments.filter(a => a.item_id === item.id);
    const totalSh = itemAssignments.reduce((s, a) => s + (a.shares || 1), 0);
    const q = Math.max(1, Math.round(item.qty));
    // zielony dopiero gdy udzialy pokrywaja liczbe sztuk (przy 1 szt. wystarczy ktokolwiek)
    let state = ' unassigned';
    if (itemAssignments.length) state = (q > 1 && totalSh < q) ? ' partial' : ' done';
    const div = document.createElement('div');
    div.className = 'item' + state;

    // wiersz 1: nazwa + usun
    const top = document.createElement('div');
    top.className = 'item-top';

    const iName = mkInput('text', item.name, 'i-name');
    iName.oninput = () => saveItem(item.id, { name: iName.value });

    const del = document.createElement('button');
    del.className = 'btn-del';
    del.textContent = '✕';
    del.onclick = () => removeItem(item.id);

    top.append(iName, del);

    // wiersz 2: ilosc x cena = suma
    const mid = document.createElement('div');
    mid.className = 'item-mid';

    const iQty = mkInput('number', item.qty, 'i-qty');
    iQty.min = 1; iQty.step = 1;
    iQty.oninput = () => saveItem(item.id, { qty: Math.max(1, Math.round(Number(iQty.value) || 1)) });

    const x = document.createElement('span');
    x.className = 'muted';
    x.textContent = '×';

    const iPrice = mkInput('number', item.unit_price, 'i-price');
    iPrice.min = 0; iPrice.step = 0.01; iPrice.inputMode = 'decimal';
    iPrice.oninput = () => saveItem(item.id, { unit_price: Math.max(0, Number(iPrice.value) || 0) });

    const eq = document.createElement('span');
    eq.className = 'muted';
    eq.textContent = '=';

    const total = document.createElement('span');
    total.className = 'item-total';
    total.textContent = fmtC(item.qty * item.unit_price);

    mid.append(iQty, x, iPrice, eq, total);

    const actions = document.createElement('div');
    actions.className = 'item-actions chips';
    for (const p of people) {
      const a = assignments.find(x => x.item_id === item.id && x.person_id === p.id);
      const chip = document.createElement('button');
      chip.className = 'chip assignable' + (a ? ' on' : '');
      chip.textContent = p.name + (a && (a.shares || 1) > 1 ? ' ×' + a.shares : '');
      chip.onclick = () => toggleAssign(item.id, p.id);
      actions.appendChild(chip);
      if (a) {
        const plus = document.createElement('button');
        plus.className = 'chip-plus';
        plus.textContent = '+';
        plus.title = 'Zwiększ udział (np. je za dwoje)';
        plus.onclick = (ev) => { ev.stopPropagation(); bumpShares(item.id, p.id); };
        actions.appendChild(plus);
      }
    }
    if (Math.round(item.qty) > 1) {
      const split = document.createElement('button');
      split.className = 'btn-split';
      split.textContent = `${t('Rozdziel na')} ${Math.round(item.qty)} × 1 ${t('szt.')}`;
      split.onclick = () => splitItem(item);
      actions.appendChild(split);
    }

    div.append(top, mid);

    // oryginalna nazwa z paragonu - dotkniecie wstawia ja do pola nazwy
    if (item.orig_name && item.orig_name !== item.name) {
      const orig = document.createElement('button');
      orig.className = 'orig-name';
      orig.textContent = '🧾 ' + item.orig_name;
      orig.title = t('Nazwa z paragonu — dotknij, aby jej użyć');
      orig.onclick = () => {
        iName.value = item.orig_name;
        saveItem(item.id, { name: item.orig_name });
      };
      div.append(orig);
    }

    div.append(actions);
    box.appendChild(div);
  }
}

function mkInput(type, value, cls) {
  const el = document.createElement('input');
  el.type = type;
  el.value = value;
  el.className = cls;
  return el;
}

function renderTip() {
  if (document.activeElement !== $('tip-input')) $('tip-input').value = session.tip || '';
  $('tip-prop').classList.toggle('active', session.tip_mode === 'proportional');
  $('tip-equal').classList.toggle('active', session.tip_mode === 'equal');
  const cn = $('tip-cur');
  if (cn) cn.textContent = cur() === 'PLN' ? 'zł' : cur();

  const box = $('tip-payers');
  if (!box) return;
  box.innerHTML = '';
  if (!people.length) {
    box.innerHTML = '<span class="muted small">' + t('Najpierw dodaj osoby') + '</span>';
    return;
  }
  const tp = tipPayerIds();
  for (const p of people) {
    const on = tp.indexOf(p.id) !== -1;
    const chip = document.createElement('button');
    chip.className = 'chip assignable' + (on ? ' on' : '');
    const share = on && tp.length > 1 ? ' ' + fmtC((Number(session.tip) || 0) / tp.length) : '';
    chip.textContent = p.name + share;
    chip.onclick = () => toggleTipPayer(p.id);
    box.appendChild(chip);
  }
}

async function toggleTipPayer(personId) {
  const tp = tipPayerIds();
  const i = tp.indexOf(personId);
  if (i === -1) tp.push(personId); else tp.splice(i, 1);
  session.tip_payers = tp; // od razu, zeby UI nie mrugal przed odswiezeniem
  try { await api.updateSession(sessionId, { tip_payers: tp }); }
  catch { toast('Nie zapisano — brakuje kolumny tip_payers? Uruchom migration-2026-08.sql', 6000); }
  synced();
}

// oblicza koszty pozycji + napiwek per osoba
function computeTotals() {
  const shares = {}; // person_id -> kwota z pozycji
  for (const p of people) shares[p.id] = 0;

  let unassignedSum = 0;
  for (const item of items) {
    const cost = item.qty * item.unit_price;
    const assigned = assignments.filter(a => a.item_id === item.id && shares[a.person_id] !== undefined);
    if (!assigned.length) { unassignedSum += cost; continue; }
    const totalSh = assigned.reduce((s, a) => s + (a.shares || 1), 0);
    for (const a of assigned) shares[a.person_id] += cost * (a.shares || 1) / totalSh;
  }

  const itemsTotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const assignedTotal = itemsTotal - unassignedSum;
  const tip = Number(session.tip) || 0;

  // napiwek dziela osoby, ktore cos jadly; jesli nikt nic nie ma - wszyscy po rowno
  // (ta sama regula co w rozliczeniu grupy, inaczej salda sie rozjezdzaja)
  const eaters = people.filter(p => shares[p.id] > 0.005);
  const tipCrowd = eaters.length ? eaters : people;

  const owed = {}; // person_id -> laczna kwota do zaplaty (pozycje + napiwek)
  const tipShares = {};
  let grand = 0;
  for (const p of people) {
    let tipShare = 0;
    if (tip > 0 && tipCrowd.some(x => x.id === p.id)) {
      tipShare = session.tip_mode === 'equal'
        ? tip / tipCrowd.length
        : (assignedTotal > 0 ? (shares[p.id] / assignedTotal) * tip : tip / tipCrowd.length);
    }
    owed[p.id] = shares[p.id] + tipShare;
    tipShares[p.id] = tipShare;
    grand += owed[p.id];
  }
  // billTotal = wszystko, co realnie widnieje na rachunku (razem z pozycjami niczyimi)
  const billTotal = itemsTotal + tip;
  return { shares, tipShares, owed, grand, unassignedSum, tip, itemsTotal, billTotal };
}

function renderPayers() {
  const chipsBox = $('payer-chips');
  const rowsBox = $('payer-rows');
  if (!chipsBox || !rowsBox) return;
  chipsBox.innerHTML = '';
  rowsBox.innerHTML = '';

  if (!people.length) {
    chipsBox.innerHTML = '<span class="muted small">' + t('Najpierw dodaj osoby') + '</span>';
    return;
  }

  for (const p of people) {
    const isPayer = payments.some(x => x.person_id === p.id);
    const chip = document.createElement('button');
    chip.className = 'chip assignable' + (isPayer ? ' on' : '');
    chip.textContent = p.name;
    chip.onclick = () => togglePayer(p.id);
    chipsBox.appendChild(chip);
  }

  for (const pay of payments) {
    const person = people.find(p => p.id === pay.person_id);
    if (!person) continue;
    const row = document.createElement('div');
    row.className = 'row payer-row';
    const label = document.createElement('span');
    label.className = 'payer-name';
    label.textContent = person.name;
    const input = mkInput('number', Math.round((Number(pay.amount) || 0) * 100) / 100, 'i-price');
    input.min = 0; input.step = 0.01; input.inputMode = 'decimal';
    input.oninput = () => savePayment(pay.person_id, Math.max(0, Number(input.value) || 0));
    const zl = document.createElement('span');
    zl.textContent = cur() === 'PLN' ? 'zł' : cur();
    row.append(label, input, zl);
    rowsBox.appendChild(row);
  }
}

function renderSummary() {
  const box = $('summary');
  const setBox = $('settlement');
  box.innerHTML = '';
  if (setBox) setBox.innerHTML = '';

  if (!people.length || !items.length) {
    box.innerHTML = '<p class="muted small">' + t('Dodaj osoby i pozycje, aby zobaczyć podział.') + '</p>';
    return;
  }

  const tt = computeTotals();
  const t2 = tt;

  for (const p of people) {
    const rate = effectiveRate();
    const plnTxt = cur() !== 'PLN' && rate ? `<span class="details">≈ ${fmt(t2.owed[p.id] * rate)} zł</span>` : '';
    const row = document.createElement('div');
    row.className = 'summary-row clickable';
    row.innerHTML = `<span><span class="chev">▸</span> ${escapeHtml(p.name)}${t2.tip > 0 ? `<span class="details">${t('pozycje')} ${fmtC(t2.shares[p.id])} + ${t('napiwek')} ${fmtC(t2.tipShares[p.id])}</span>` : ''}</span><span class="amount-col"><strong>${fmtC(t2.owed[p.id])}</strong>${plnTxt}</span>`;

    // szczegoly: dokladna lista pozycji tej osoby
    const det = document.createElement('div');
    det.className = 'person-details hidden';
    const lines = [];
    for (const item of items) {
      const as = assignments.filter(a => a.item_id === item.id);
      const mine = as.find(a => a.person_id === p.id);
      if (!mine) continue;
      const totalSh = as.reduce((s, a) => s + (a.shares || 1), 0);
      const cost = item.qty * item.unit_price * (mine.shares || 1) / totalSh;
      const shareTxt = totalSh > 1 ? ` <span class="muted">(${mine.shares || 1}/${totalSh} ${t('udz.')})</span>` : '';
      lines.push(`<div class="pd-row"><span>${escapeHtml(item.name)}${shareTxt}</span><span>${fmtC(cost)}</span></div>`);
    }
    if (t2.tipShares[p.id] > 0.005) lines.push(`<div class="pd-row"><span>${t('Napiwek')}</span><span>${fmtC(t2.tipShares[p.id])}</span></div>`);
    det.innerHTML = lines.join('') || '<div class="pd-row"><span class="muted">' + t('Brak przypisanych pozycji') + '</span></div>';

    row.onclick = () => {
      det.classList.toggle('hidden');
      row.classList.toggle('open');
    };
    box.appendChild(row);
    box.appendChild(det);
  }

  const rateT = effectiveRate();
  const totalRow = document.createElement('div');
  totalRow.className = 'summary-row total';
  totalRow.innerHTML = `<span>${t('Razem')}</span><span class="amount-col"><span>${fmtC(t2.grand)}</span>${cur() !== 'PLN' && rateT ? `<span class="details">≈ ${fmt(t2.grand * rateT)} zł (${rateT.toFixed(4)})</span>` : ''}</span>`;
  box.appendChild(totalRow);
  if (cur() !== 'PLN' && !rateT) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = '⚠️ Podaj kurs albo kwotę zapłaconą w PLN, aby przeliczyć na złotówki.';
    box.appendChild(w);
  }

  if (t2.unassignedSum > 0.005) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = `⚠️ ${t('Nieprzypisane pozycje')}: ${fmtC(t2.unassignedSum)} ${t('(nie wliczone do podziału)')}`;
    box.appendChild(w);
  }

  renderSettlement(t2);
}

// kto komu ile oddaje (na podstawie wplat)
function renderSettlement(tot) {
  const box = $('settlement');
  if (!box || (!payments.length && !tipPayerIds().length)) return;

  const paid = paidByPerson();
  const paidTotal = Object.values(paid).reduce((s, x) => s + x, 0);

  const h = document.createElement('h3');
  h.className = 'settle-title';
  h.textContent = t('Rozliczenie');
  box.appendChild(h);

  if (Math.abs(paidTotal - tot.billTotal) > 0.01) {
    const info = document.createElement('p');
    info.className = 'warn';
    info.textContent = `⚠️ Wpłaty (${fmtC(paidTotal)}) różnią się od rachunku (${fmtC(tot.billTotal)}) — popraw kwoty.`;
    box.appendChild(info);
  }

  // net > 0: nadplacil (dostaje zwrot), net < 0: oddaje
  const nets = people.map(p => ({ name: p.name, net: Math.round((paid[p.id] - tot.owed[p.id]) * 100) / 100 }));
  const debtors = nets.filter(x => x.net < -0.005).map(x => ({ ...x, net: -x.net })).sort((a, b) => b.net - a.net);
  const creditors = nets.filter(x => x.net > 0.005).sort((a, b) => b.net - a.net);

  if (!debtors.length) {
    const ok = document.createElement('p');
    ok.className = 'muted small';
    ok.textContent = t('Wszystko rozliczone ✅');
    box.appendChild(ok);
    return;
  }

  let di = 0, ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const amount = Math.min(debtors[di].net, creditors[ci].net);
    if (amount > 0.005) {
      const row = document.createElement('div');
      row.className = 'settle-row';
      row.innerHTML = `<span>${escapeHtml(debtors[di].name)} → ${escapeHtml(creditors[ci].name)}</span><strong>${fmtC(amount)}</strong>`;
      box.appendChild(row);
    }
    debtors[di].net -= amount;
    creditors[ci].net -= amount;
    if (debtors[di].net <= 0.005) di++;
    if (creditors[ci].net <= 0.005) ci++;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
