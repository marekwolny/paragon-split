import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.APP_CONFIG;
const db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- stan ----------
let sessionId = null;
let session = null;
let people = [];
let items = [];
let assignments = []; // {item_id, person_id}
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
init();

async function init() {
  const params = new URLSearchParams(location.search);
  sessionId = params.get('s');

  if (!sessionId) {
    $('view-landing').classList.remove('hidden');
    $('btn-new').onclick = createSession;
    return;
  }

  $('view-session').classList.remove('hidden');
  $('btn-share').classList.remove('hidden');
  bindUI();
  await loadAll();
  subscribeRealtime();
}

async function createSession() {
  const { data, error } = await db.from('sessions').insert({}).select().single();
  if (error) return toast('Błąd: ' + error.message);
  location.search = '?s=' + data.id;
}

// ---------- dane ----------
async function loadAll() {
  const [s, p, i, a] = await Promise.all([
    db.from('sessions').select('*').eq('id', sessionId).single(),
    db.from('people').select('*').eq('session_id', sessionId).order('created_at'),
    db.from('items').select('*').eq('session_id', sessionId).order('position').order('created_at'),
    db.from('assignments').select('*').eq('session_id', sessionId),
  ]);
  if (s.error) { toast('Nie znaleziono sesji'); return; }
  session = s.data;
  people = p.data || [];
  items = i.data || [];
  assignments = a.data || [];
  render();
}

function subscribeRealtime() {
  const reload = debounce(loadAll, 300);
  db.channel('session-' + sessionId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `session_id=eq.${sessionId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'people', filter: `session_id=eq.${sessionId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'assignments', filter: `session_id=eq.${sessionId}` }, reload)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions', filter: `id=eq.${sessionId}` }, reload)
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
  $('file-input').addEventListener('change', onPhoto);
  $('tip-input').addEventListener('change', async (e) => {
    const tip = Math.max(0, parseFloat(String(e.target.value).replace(',', '.')) || 0);
    await db.from('sessions').update({ tip }).eq('id', sessionId);
  });
  $('tip-prop').onclick = () => setTipMode('proportional');
  $('tip-equal').onclick = () => setTipMode('equal');
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
  const { error } = await db.from('people').insert({ session_id: sessionId, name });
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
    await db.from('assignments').insert({ item_id: itemId, person_id: personId, session_id: sessionId });
  }
  loadAll();
}

// ---------- zdjęcie -> Gemini ----------
async function onPhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = '';
  const status = $('upload-status');
  status.innerHTML = '<span class="spinner">🤖 Analizuję paragon…</span>';

  try {
    const base64 = await downscale(file);
    const r = await fetch('/api/parse-receipt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: base64, mimeType: 'image/jpeg' }),
    });
    const data = await r.json();
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
      resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- render ----------
function render() {
  // nie nadpisuj, gdy ktoś właśnie edytuje pole
  const ae = document.activeElement;
  if (ae && ae.tagName === 'INPUT' && ae.closest('#items-list')) {
    if (!renderPending) {
      renderPending = true;
      ae.addEventListener('blur', () => { renderPending = false; render(); }, { once: true });
    }
    return;
  }

  renderPeople();
  renderItems();
  renderTip();
  renderSummary();
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
    const assigned = assignments.filter(a => a.item_id === item.id).map(a => a.person_id);
    const div = document.createElement('div');
    div.className = 'item' + (assigned.length ? '' : ' unassigned');

    const top = document.createElement('div');
    top.className = 'item-top';

    const iName = mkInput('text', item.name, 'i-name');
    iName.oninput = () => saveItem(item.id, { name: iName.value });

    const iQty = mkInput('number', item.qty, 'i-qty');
    iQty.min = 1; iQty.step = 1;
    iQty.oninput = () => saveItem(item.id, { qty: Math.max(1, Math.round(Number(iQty.value) || 1)) });

    const iPrice = mkInput('number', item.unit_price, 'i-price');
    iPrice.min = 0; iPrice.step = 0.01; iPrice.inputMode = 'decimal';
    iPrice.oninput = () => saveItem(item.id, { unit_price: Math.max(0, Number(iPrice.value) || 0) });

    const total = document.createElement('span');
    total.className = 'item-total';
    total.textContent = fmt(item.qty * item.unit_price) + ' zł';

    const del = document.createElement('button');
    del.className = 'btn-del';
    del.textContent = '✕';
    del.onclick = () => removeItem(item.id);

    top.append(iName, iQty, iPrice, total, del);

    const actions = document.createElement('div');
    actions.className = 'item-actions chips';
    for (const p of people) {
      const chip = document.createElement('button');
      chip.className = 'chip assignable' + (assigned.includes(p.id) ? ' on' : '');
      chip.textContent = p.name;
      chip.onclick = () => toggleAssign(item.id, p.id);
      actions.appendChild(chip);
    }
    if (Math.round(item.qty) > 1) {
      const split = document.createElement('button');
      split.className = 'btn-split';
      split.textContent = `Rozdziel na ${Math.round(item.qty)} × 1 szt.`;
      split.onclick = () => splitItem(item);
      actions.appendChild(split);
    }

    div.append(top, actions);
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

function renderSummary() {
  const box = $('summary');
  box.innerHTML = '';

  const shares = {}; // person_id -> kwota z pozycji
  for (const p of people) shares[p.id] = 0;

  let unassignedSum = 0;
  for (const item of items) {
    const cost = item.qty * item.unit_price;
    const assigned = assignments.filter(a => a.item_id === item.id && shares[a.person_id] !== undefined);
    if (!assigned.length) { unassignedSum += cost; continue; }
    const per = cost / assigned.length;
    for (const a of assigned) shares[a.person_id] += per;
  }

  const itemsTotal = items.reduce((s, it) => s + it.qty * it.unit_price, 0);
  const assignedTotal = itemsTotal - unassignedSum;
  const tip = Number(session.tip) || 0;

  if (!people.length || !items.length) {
    box.innerHTML = '<p class="muted small">Dodaj osoby i pozycje, aby zobaczyć podział.</p>';
    return;
  }

  let grand = 0;
  for (const p of people) {
    let tipShare = 0;
    if (tip > 0) {
      tipShare = session.tip_mode === 'equal'
        ? tip / people.length
        : (assignedTotal > 0 ? (shares[p.id] / assignedTotal) * tip : tip / people.length);
    }
    const totalP = shares[p.id] + tipShare;
    grand += totalP;

    const row = document.createElement('div');
    row.className = 'summary-row';
    row.innerHTML = `<span>${escapeHtml(p.name)}${tip > 0 ? `<span class="details">pozycje ${fmt(shares[p.id])} zł + napiwek ${fmt(tipShare)} zł</span>` : ''}</span><strong>${fmt(totalP)} zł</strong>`;
    box.appendChild(row);
  }

  const totalRow = document.createElement('div');
  totalRow.className = 'summary-row total';
  totalRow.innerHTML = `<span>Razem</span><span>${fmt(grand)} zł</span>`;
  box.appendChild(totalRow);

  if (unassignedSum > 0.005) {
    const w = document.createElement('p');
    w.className = 'warn';
    w.textContent = `⚠️ Nieprzypisane pozycje: ${fmt(unassignedSum)} zł (nie wliczone do podziału)`;
    box.appendChild(w);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
