// Vercel Serverless Function - Gemini API
// Dostep: wlasny klucz uzytkownika (userKey) LUB zalogowany user z whitelisty (klucz z env)
const SUPA_URL = 'https://glclenuamkgzizcfyuus.supabase.co';
const SUPA_ANON = 'sb_publishable_WdzmE1U3h3a_S837L8OePg_Bnogeb3w'; // klucz publiczny (nie sekret)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const { image, mimeType, userKey } = req.body || {};
  if (!image) {
    return res.status(400).json({ error: 'Brak obrazu' });
  }
  let apiKey = null;
  if (userKey && typeof userKey === 'string' && userKey.trim().length > 20) {
    apiKey = userKey.trim();
  } else {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      try {
        const u = await fetch(SUPA_URL + '/auth/v1/user', { headers: { apikey: SUPA_ANON, Authorization: auth } });
        if (u.ok) {
          const usr = await u.json();
          const allowed = (process.env.ALLOWED_EMAILS || 'marek.wolny@gmail.com,mareczek85@gmail.com,ela.sermet@gmail.com').toLowerCase().split(',').map(function(x) { return x.trim(); });
          if (usr.email && allowed.indexOf(usr.email.toLowerCase()) !== -1) {
            apiKey = process.env.GEMINI_API_KEY;
          }
        }
      } catch (e) { console.error('auth check failed', e); }
    }
  }
  if (!apiKey) {
    return res.status(403).json({ error: 'Analiza AI wymaga wlasnego klucza Gemini', needKey: true });
  }
  const prompt = [
    'Przeanalizuj zdjecie paragonu (rachunku) z restauracji lub sklepu.',
    '',
    'Wyodrebnij pozycje zakupow. Pomin sumy, podatki, rabaty calosciowe, dane kontaktowe.',
    'Dla KAZDEJ pozycji podaj:',
    '- name: nazwa DOKLADNIE tak, jak jest wydrukowana na paragonie (zachowaj oryginalny jezyk i pisownie; popraw tylko oczywiste bledy odczytu OCR, np. brakujaca litere). NIE tlumacz tego pola.',
    '- name_pl: ta sama pozycja przetlumaczona na jezyk polski, krotko i naturalnie (np. "Birra Korca" -> "Piwo Korca", "Tave kosi" -> "Zapiekanka jagnieca z jogurtem"). Jesli nazwa juz jest po polsku, powtorz ja bez zmian.',
    '- qty: ilosc sztuk jako liczba (przy "4x Piwo" qty=4).',
    '- unit_price: cena za JEDNA sztuke jako liczba; jesli na paragonie jest tylko cena laczna pozycji, podziel ja przez qty.',
    '',
    'Podaj tez:',
    '- merchant: nazwa lokalu/sklepu z naglowka paragonu (bez formy prawnej typu Sp. z o.o., sh.p.k., Ltd; bez adresu). Jesli nie widac, pusty string.',
    '- category: jedna z wartosci "jedzenie", "transport", "nocleg", "rozrywka", "zakupy", "inne" - dopasowana do charakteru calego paragonu (restauracja/bar/kawiarnia = jedzenie, taxi/paliwo/bilety = transport, hotel/apartament = nocleg, atrakcje/kluby/wycieczki = rozrywka, sklep/pamiatki = zakupy).',
    '- currency: 3-literowy kod ISO waluty widocznej na paragonie (np. PLN, EUR, ALL, HRK). Jesli nie da sie ustalic, pusty string.',
    '',
    'Zwroc czysty JSON, bez komentarzy:',
    '{"merchant":"...","category":"jedzenie","currency":"ALL","items":[{"name":"Birra Korca","name_pl":"Piwo Korca","qty":2,"unit_price":250}]}',
    'Jesli to nie jest paragon, zwroc {"merchant":"","category":"inne","currency":"","items":[]}.'
  ].join('\n');
  const payload = JSON.stringify({
    contents: [{ parts: [ { text: prompt }, { inline_data: { mime_type: mimeType || 'image/jpeg', data: image } } ] }],
    generationConfig: { response_mime_type: 'application/json', temperature: 0.1 }
  });
  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];
  try {
    let r = null;
    let errText = '';
    for (let i = 0; i < models.length; i++) {
      r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + models[i] + ':generateContent?key=' + apiKey, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload
      });
      if (r.ok) break;
      errText = await r.text();
      console.error('Gemini error (' + models[i] + ', status ' + r.status + '):', errText.slice(0, 300));
      if (r.status === 400 || r.status === 401 || r.status === 403) {
        return res.status(403).json({ error: 'Klucz Gemini nieprawidlowy lub bez uprawnien - sprawdz klucz', needKey: !!userKey });
      }
      if (r.status !== 503 && r.status !== 429 && r.status !== 500) break;
      if (i < models.length - 1) {
        await new Promise(function(resolve) { setTimeout(resolve, 2000); });
      }
    }
    if (!r || !r.ok) {
      return res.status(502).json({ error: 'Gemini jest chwilowo przeciazone - sprobuj ponownie za minute', detail: errText.slice(0, 500) });
    }
    const data = await r.json();
    const text = (data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) || '{"items":[]}';
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : { items: [] };
    }
    const items = (parsed.items || []).map(function(it) {
      const orig = String(it.name || '').slice(0, 120).trim();
      const pl = String(it.name_pl || '').slice(0, 120).trim();
      return {
        name: orig,
        name_pl: pl || orig,
        qty: Math.max(1, Math.round(Number(it.qty) || 1)),
        unit_price: Math.max(0, Number(it.unit_price) || 0)
      };
    }).filter(function(it) { return it.name; });
    const CATS = ['jedzenie', 'transport', 'nocleg', 'rozrywka', 'zakupy', 'inne'];
    const cat = String(parsed.category || '').toLowerCase().trim();
    const code = String(parsed.currency || '').toUpperCase().trim();
    return res.status(200).json({
      items: items,
      merchant: String(parsed.merchant || '').slice(0, 60).trim(),
      category: CATS.indexOf(cat) !== -1 ? cat : null,
      currency: /^[A-Z]{3}$/.test(code) ? code : null
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Blad serwera', detail: String(e).slice(0, 300) });
  }
}
