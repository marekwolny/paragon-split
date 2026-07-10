import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- stan ----------
let sessionId = null;
let session = null;
let people = [];
let items = [];
let assignments = []; // {item_id, person_id, shares}
let payments = []; // {session_id, person_id, amount}
let renderPending = false;

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
    $('btn-new').onclick = createSession;
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
  const payload = groupId ? { group_id: groupId } : {};
  const { data, error } = await db.from('sessions').insert(payload).select().single();
  if (error) return toast('Błąd: ' + error.message);
  location.search = '?s=' + data.id;
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

async function renderGroupsList() {
  const box = $('groups-list');
  box.innerHTML = '';

  // lista grup widoczna tylko po zalogowaniu
  if (!currentUser) {
    box.innerHTML = '<p class="muted small">Zaloguj się, aby zobaczyć swoje grupy. Do cudzej grupy dołączysz przez otrzymany link.</p>';
    return;
  }

  const { data } = await db.from('groups').select('id,name').eq('owner', currentUser.id).order('created_at', { ascending: false });
  const mine = data || [];
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
  const { data, error } = await db.from('groups').insert({ name, owner: currentUser.id }).select().single();
  if (error) return toast('Błąd: ' + error.message);
  location.href = 'group.html?g=' + data.id;
}

// ---------- dane ----------
async function loadAll() {
  const s = await db.from('sessions').select('*').eq('id', sessionId).single();
  if (s.error) { toast('Nie znaleziono sesji'); return; }
  session = s.data;

  const peopleQuery = session.group_id
    ? db.from('people').select('*').eq('group_id', session.group_id).order('created_at')
    : db.from('people').select('*').eq('session_id', sessionId).order('created_at');

  const [p, i, a, pay] = await Promise.all([
    peopleQuery,
    db.from('items').select('*').eq('session_id', sessionId).order('position').order('created_at'),
    db.from('assignments').select('*').eq('session_id', sessionId),
    db.from('payments').select('*').eq('session_id', sessionId),
  ]);
  people = p.data || [];
  items = i.data || [];
  assignments = a.data || [];
  payments = pay.data || [];

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
  const totalItems = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const pb = Number(session.paid_base) || 0;
  if (pb > 0 && totalItems > 0) return pb / totalItems;
  return Number(session.fx_rate) || null;
}
const fmtC = (n) => fmt(n) + ' ' + (cur() === 'PLN' ? 'zł' : cur());

async function fetchNbpRate(code) {
  try {
    const r = await fetch('https://api.nbp.pl/api/exchangerates/rates/a/' + code.toLowerCase() + '/?format=json');
    if (!r.ok) return null;
    const d = await r.json();
    return d.rates && d.rates[0] ? d.rates[0].mid : null;
  } catch { return null; }
}

function subscribeRealtime() {
  const reload = debounce(loadAll, 300);
  db.channel('session-' + sessionId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `session_id=eq.${sessionId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'people', filter: `session_id=eq.${sessionId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments', filter: `session_id=eq.${sessionId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'payments', filter: `session_id=eq.${sessionId}` }, reload)
    .subscribe();
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
  $('category').addEventListener('change', async (e) => {
    await db.from('sessions').update({ category: e.target.value }).eq('id', sessionId);
  });
  $('tip-input').addEventListener('change', async (e) => {
    const tip = Math.max(0, parseFloat(String(e.target.value).replace(',', '.')) || 0);
    await db.from('sessions').update({ tip }).eq('id', sessionId);
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
    const c = e.target.value;
    let patch = { currency: c };
    if (c !== 'PLN') {
      const mid = await fetchNbpRate(c);
      if (mid) patch.fx_rate = mid;
    } else {
      patch.fx_rate = null;
      patch.paid_base = null;
    }
    await db.from('sessions').update(patch).eq('id', sessionId);
    loadAll();
  });
  $('fx-rate').addEventListener('change', async (e) => {
    const v = Number(e.target.value) || null;
    await db.from('sessions').update({ fx_rate: v }).eq('id', sessionId);
    loadAll();
  });
  $('paid-base').addEventListener('change', async (e) => {
    const v = Number(e.target.value) || null;
    await db.from('sessions').update({ paid_base: v }).eq('id', sessionId);
    loadAll();
  });
}

function renderCurrency() {
  const c = cur();
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
  const t = computeTotals();
  const lines = ['🧾 Rozliczenie rachunku', ''];
  const rate = effectiveRate();
  for (const p of people) {
    const plnTxt = cur() !== 'PLN' && rate ? ` (≈ ${fmt(t.owed[p.id] * rate)} zł)` : '';
    lines.push(`${p.name} — do zapłaty ${fmtC(t.owed[p.id])}${plnTxt}`);
    for (const item of items) {
      const as = assignments.filter(a => a.item_id === item.id);
      const mine = as.find(a => a.person_id === p.id);
      if (!mine) continue;
      const totalSh = as.reduce((s, a) => s + (a.shares || 1), 0);
      const cost = item.qty * item.unit_price * (mine.shares || 1) / totalSh;
      const shareTxt = totalSh > 1 ? ` (${mine.shares || 1}/${totalSh})` : '';
      lines.push(`  • ${item.name}${shareTxt}: ${fmtC(cost)}`);
    }
    if (t.tipShares[p.id] > 0.005) lines.push(`  • napiwek: ${fmtC(t.tipShares[p.id])}`);
    lines.push('');
  }
  lines.push(`Razem: ${fmtC(t.grand)}${cur() !== 'PLN' && rate ? ` ≈ ${fmt(t.grand * rate)} zł (kurs ${rate.toFixed(4)})` : ''}`);
  if (t.unassignedSum > 0.005) lines.push(`⚠️ Nieprzypisane: ${fmt(t.unassignedSum)} zł`);

  if (payments.length) {
    const paid = {};
    for (const p of people) paid[p.id] = 0;
    for (const pay of payments) if (paid[pay.person_id] !== undefined) paid[pay.person_id] += Number(pay.amount) || 0;
    const nets = people.map(p => ({ name: p.name, net: Math.round((paid[p.id] - t.owed[p.id]) * 100) / 100 }));
    const debtors = nets.filter(x => x.net < -0.005).map(x => ({ ...x, net: -x.net })).sort((a, b) => b.net - a.net);
    const creditors = nets.filter(x => x.net > 0.005).sort((a, b) => b.net - a.net);
    if (debtors.length && creditors.length) {
      lines.push('', 'Kto komu oddaje:');
      let di = 0, ci = 0;
      while (di < debtors.length && ci < creditors.length) {
        const amount = Math.min(debtors[di].net, creditors[ci].net);
        if (amount > 0.005) lines.push(`  ${debtors[di].name} → ${creditors[ci].name}: ${fmt(amount)} zł`);
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
  await db.from('sessions').update({ tip_mode: mode }).eq('id', sessionId);
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
  const payload = session && session.group_id ? { group_id: session.group_id, name } : { session_id: sessionId, name };
  const { error } = await db.from('people').insert(payload);
  if (error) toast('Błąd: ' + error.message); else loadAll();
}

async function removePerson(id) {
  if (!confirm('Usunąć osobę i jej przypisania?')) return;
  await db.from('people').delete().eq('id', id);
  loadAll();
}

// ---------- pozycje ----------
async function addItemManual() {
  const { error } = await db.from('items').insert({
    session_id: sessionId, name: 'Nowa pozycja', qty: 1, unit_price: 0,
    position: items.length,
  });
  if (error) toast('Błąd: ' + error.message); else loadAll();
}

async function removeItem(id) {
  await db.from('items').delete().eq('id', id);
  loadAll();
}

const saveItem = debounce(async (id, patch) => {
  await db.from('items').update(patch).eq('id', id);
}, 500);

// "4x Piwo" -> 4 osobne pozycje po 1 szt.
async function splitItem(item) {
  const qty = Math.round(item.qty);
  if (qty < 2) return;
  const rows = [];
  for (let k = 0; k < qty - 1; k++) {
    rows.push({ session_id: sessionId, name: item.name, qty: 1, unit_price: item.unit_price, position: item.position });
  }
  const { error } = await db.from('items').insert(rows);
  if (error) return toast('Błąd: ' + error.message);
  await db.from('items').update({ qty: 1 }).eq('id', item.id);
  loadAll();
}

async function toggleAssign(itemId, personId) {
  const exists = assignments.some(a => a.item_id === itemId && a.person_id === personId);
  if (exists) {
    await db.from('assignments').delete().eq('item_id', itemId).eq('person_id', personId);
  } else {
    await db.from('assignments').insert({ item_id: itemId, person_id: personId, session_id: sessionId, shares: 1 });
  }
  loadAll();
}

// jednym tapnieciem: kazda pozycja podzielona rowno na wszystkich
async function assignEveryoneToEverything() {
  if (!people.length || !items.length) return toast('Brak osób lub pozycji');
  if (!confirm('Przypisać WSZYSTKIE osoby do WSZYSTKICH pozycji (po równo)? Istniejące przypisania zostaną zachowane.')) return;
  const rows = [];
  for (const item of items) {
    for (const p of people) {
      if (!assignments.some(a => a.item_id === item.id && a.person_id === p.id)) {
        rows.push({ item_id: item.id, person_id: p.id, session_id: sessionId, shares: 1 });
      }
    }
  }
  if (!rows.length) return toast('Wszystko już przypisane');
  const { error } = await db.from('assignments').insert(rows);
  if (error) return toast('Błąd: ' + error.message);
  toast(`Przypisano ${rows.length} pozycji 👥`);
  loadAll();
}

// zwieksz udzial osoby w pozycji (np. para je za dwoje): 1 -> 2 -> 3 ... max 9
async function bumpShares(itemId, personId) {
  const a = assignments.find(x => x.item_id === itemId && x.person_id === personId);
  if (!a) return;
  const next = Math.min(9, (a.shares || 1) + 1);
  await db.from('assignments').update({ shares: next }).eq('item_id', itemId).eq('person_id', personId);
  loadAll();
}

// ---------- kto zaplacil ----------
async function togglePayer(personId) {
  const exists = payments.some(x => x.person_id === personId);
  if (exists) {
    await db.from('payments').delete().eq('session_id', sessionId).eq('person_id', personId);
  } else {
    const t = computeTotals();
    const paidSoFar = payments.reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const remaining = Math.max(0, Math.round((t.grand - paidSoFar) * 100) / 100);
    await db.from('payments').insert({ session_id: sessionId, person_id: personId, amount: remaining });
  }
  loadAll();
}

const savePayment = debounce(async (personId, amount) => {
  await db.from('payments').update({ amount }).eq('session_id', sessionId).eq('person_id', personId);
  loadAll();
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
async function onPhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const status = $('upload-status');
  status.innerHTML = '<span class="spinner">🤖 Analizuję paragon…</span>';

  try {
    const { base64, blob } = await downscale(file);

    // zapisz zdjecie paragonu do podgladu (nie blokuje analizy przy bledzie)
    try {
      const path = sessionId + '/' + Date.now() + '.jpg';
      const up = await db.storage.from('receipts').upload(path, blob, { contentType: 'image/jpeg' });
      if (!up.error) {
        const url = SUPABASE_URL + '/storage/v1/object/public/receipts/' + path;
        const urls = Array.isArray(session.receipt_urls) ? session.receipt_urls : [];
        await db.from('sessions').update({ receipt_urls: [...urls, url] }).eq('id', sessionId);
      }
    } catch (e2) { console.warn('Nie udalo sie zapisac podgladu paragonu', e2); }

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
      body: JSON.stringify({ image: base64, mimeType: 'image/jpeg', userKey }),
    });
    const data = await r.json();
    if (r.status === 403 && data.needKey) {
      status.innerHTML = '🔑 Analiza AI wymaga własnego (darmowego) klucza Gemini. Pozycje możesz też dodać ręcznie.';
      setupAiKey();
      return;
    }
    if (!r.ok) throw new Error(data.error || 'Błąd API');
    if (!data.items.length) { status.textContent = 'Nie rozpoznano pozycji — spróbuj wyraźniejszego zdjęcia.'; return; }

    const rows = data.items.map((it, idx) => ({
      session_id: sessionId, name: it.name, qty: it.qty, unit_price: it.unit_price,
      position: items.length + idx,
    }));
    const { error } = await db.from('items').insert(rows);
    if (error) throw new Error(error.message);
    status.textContent = `✅ Rozpoznano ${data.items.length} pozycji — sprawdź i popraw w razie potrzeby.`;
    loadAll();
  } catch (err) {
    status.textContent = '❌ ' + err.message;
  }
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
  if (!people.length) box.innerHTML = '<span class="muted small">Dodaj osoby, które się składają</span>';
  for (const p of people) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.innerHTML = escapeHtml(p.name) + '<span class="x">✕</span>';
    chip.onclick = () => removePerson(p.id);
    box.appendChild(chip);
  }
}

function renderItems() {
  const box = $('items-list');
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = '<p class="muted small">Brak pozycji — wgraj zdjęcie paragonu lub dodaj ręcznie.</p>';
    return;
  }
  for (const item of items) {
    const itemAssignments = assignments.filter(a => a.item_id === item.id);
    const assigned = itemAssignments.map(a => a.person_id);
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
      split.textContent = `Rozdziel na ${Math.round(item.qty)} × 1 szt.`;
      split.onclick = () => splitItem(item);
      actions.appendChild(split);
    }

    div.append(top, mid, actions);
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

  const owed = {}; // person_id -> laczna kwota do zaplaty (pozycje + napiwek)
  const tipShares = {};
  let grand = 0;
  for (const p of people) {
    let tipShare = 0;
    if (tip > 0) {
      tipShare = session.tip_mode === 'equal'
        ? tip / people.length
        : (assignedTotal > 0 ? (shares[p.id] / assignedTotal) * tip : tip / people.length);
    }
    owed[p.id] = shares[p.id] + tipShare;
    tipShares[p.id] = tipShare;
    grand += owed[p.id];
  }
  return { shares, tipShares, owed, grand, unassignedSum, tip };
}

function renderPayers() {
  const chipsBox = $('payer-chips');
  const rowsBox = $('payer-rows');
  if (!chipsBox || !rowsBox) return;
  chipsBox.innerHTML = '';
  rowsBox.innerHTML = '';

  if (!people.length) {
    chipsBox.innerHTML = '<span class="muted small">Najpierw dodaj osoby</span>';
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
    box.innerHTML = '<p class="muted small">Dodaj osoby i pozycje, aby zobaczyć podział.</p>';
    return;
  }

  const t = computeTotals();

  for (const p of people) {
    const rate = effectiveRate();
    const plnTxt = cur() !== 'PLN' && rate ? `<span class="details">≈ ${fmt(t.owed[p.id] * rate)} zł</span>` : '';
    const row = document.createElement('div');
    row.className = 'summary-row clickable';
    row.innerHTML = `<span><span class="chev">▸</span> ${escapeHtml(p.name)}${t.tip > 0 ? `<span class="details">pozycje ${fmtC(t.shares[p.id])} + napiwek ${fmtC(t.tipShares[p.id])}</span>` : ''}</span><span class="amount-col"><strong>${fmtC(t.owed[p.id])}</strong>${plnTxt}</span>`;

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
      const shareTxt = totalSh > 1 ? ` <span class="muted">(${mine.shares || 1}/${totalSh} udz.)</span>` : '';
      lines.push(`<div class="pd-row"><span>${escapeHtml(item.name)}${shareTxt}</span><span>${fmtC(cost)}</span></div>`);
    }
    if (t.tipShares[p.id] > 0.005) lines.push(`<div class="pd-row"><span>Napiwek</span><span>${fmtC(t.tipShares[p.id])}</span></div>`);
    det.innerHTML = lines.join('') || '<div class="pd-row"><span class="muted">Brak przypisanych pozycji</span></div>';

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
  totalRow.innerHTML = `<span>Razem</span><span class="amount-col"><span>${fmtC(t.grand)}</span>${cur() !== 'PLN' && rateT ? `<span class="details">≈ ${fmt(t.grand * rateT)} zł (kurs ${rateT.toFixed(4)})</span>` : ''}</span>`;
  box.appendChild(totalRow);
  if (cur() !== 'PLN' && !rateT) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = '⚠️ Podaj kurs albo kwotę zapłaconą w PLN, aby przeliczyć na złotówki.';
    box.appendChild(w);
  }

  if (t.unassignedSum > 0.005) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = `⚠️ Nieprzypisane pozycje: ${fmt(t.unassignedSum)} zł (nie wliczone do podziału)`;
    box.appendChild(w);
  }

  renderSettlement(t);
}

// kto komu ile oddaje (na podstawie wplat)
function renderSettlement(t) {
  const box = $('settlement');
  if (!box || !payments.length) return;

  const paid = {};
  for (const p of people) paid[p.id] = 0;
  for (const pay of payments) if (paid[pay.person_id] !== undefined) paid[pay.person_id] += Number(pay.amount) || 0;
  const paidTotal = Object.values(paid).reduce((s, x) => s + x, 0);

  const h = document.createElement('h3');
  h.className = 'settle-title';
  h.textContent = 'Rozliczenie';
  box.appendChild(h);

  if (Math.abs(paidTotal - t.grand) > 0.01) {
    const info = document.createElement('p');
    info.className = 'warn';
    info.textContent = `⚠️ Wpłaty (${fmtC(paidTotal)}) różnią się od rachunku (${fmtC(t.grand)}) — popraw kwoty.`;
    box.appendChild(info);
  }

  // net > 0: nadplacil (dostaje zwrot), net < 0: oddaje
  const nets = people.map(p => ({ name: p.name, net: Math.round((paid[p.id] - t.owed[p.id]) * 100) / 100 }));
  const debtors = nets.filter(x => x.net < -0.005).map(x => ({ ...x, net: -x.net })).sort((a, b) => b.net - a.net);
  const creditors = nets.filter(x => x.net > 0.005).sort((a, b) => b.net - a.net);

  if (!debtors.length) {
    const ok = document.createElement('p');
    ok.className = 'muted small';
    ok.textContent = 'Wszystko rozliczone ✅';
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
