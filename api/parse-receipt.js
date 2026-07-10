// Vercel Serverless Function - wywoluje Gemini API (klucz w env var GEMINI_API_KEY)
// Retry + fallback: gemini-2.5-flash -> gemini-2.5-flash-lite (przy 503/429)
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Brak GEMINI_API_KEY w zmiennych srodowiskowych Vercel' });
  }
  const { image, mimeType } = req.body || {};
  if (!image) {
    return res.status(400).json({ error: 'Brak obrazu' });
  }
  const prompt = 'Przeanalizuj zdjecie paragonu (rachunku) z restauracji lub sklepu. Wyodrebnij WYLACZNIE pozycje zakupow. Pomin sumy, podatki, rabaty calosciowe, dane sklepu. Dla kazdej pozycji podaj: name (nazwa pozycji, popraw oczywiste bledy OCR, zachowaj polski jezyk), qty (ilosc sztuk jako liczba, np. przy "4x Piwo" qty=4), unit_price (cena za sztuke w zlotych jako liczba; jesli na paragonie jest tylko cena laczna pozycji, podziel ja przez qty). Zwroc czysty JSON: {"items":[{"name":"...","qty":1,"unit_price":12.50}]}. Jesli to nie jest paragon, zwroc {"items":[]}.';
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
      return {
        name: String(it.name || '').slice(0, 120),
        qty: Math.max(1, Math.round(Number(it.qty) || 1)),
        unit_price: Math.max(0, Number(it.unit_price) || 0)
      };
    }).filter(function(it) { return it.name; });
    return res.status(200).json({ items: items });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Blad serwera', detail: String(e).slice(0, 300) });
  }
}
