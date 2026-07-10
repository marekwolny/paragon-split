# ParagonSplit — instrukcja wdrożenia (wszystko darmowe)

Aplikacja: zdjęcie paragonu → AI rozpoznaje pozycje → każdy na swoim telefonie zaznacza co jego → podsumowanie kto ile płaci. Działa jako PWA (instalacja na Androidzie i iOS).

Potrzebujesz 3 darmowych kont: **Supabase** (baza), **Google AI Studio** (klucz Gemini), **Vercel** (hosting). Całość ~15 minut.

---

## Krok 1: Supabase (baza danych, ~5 min)

1. Wejdź na https://supabase.com → zaloguj się GitHubem → **New project**
   - Nazwa dowolna (np. `paragon-split`), hasło do bazy wygeneruj i zapisz, region: `Central EU (Frankfurt)`.
2. Po utworzeniu projektu: lewe menu → **SQL Editor** → **New query** → wklej całą zawartość pliku `supabase-setup.sql` → **Run**. Powinno pokazać "Success".
3. Lewe menu → ikona koła zębatego (**Project Settings**) → **API**:
   - skopiuj **Project URL** (np. `https://abcdefgh.supabase.co`)
   - skopiuj klucz **anon public**
4. Otwórz plik `config.js` w tym projekcie i wklej oba do środka:

```js
window.APP_CONFIG = {
  SUPABASE_URL: 'https://abcdefgh.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...'
};
```

Klucz anon jest publiczny z założenia — może być w kodzie strony.

## Krok 2: Klucz Gemini (AI do paragonów, ~2 min)

1. Wejdź na https://aistudio.google.com/apikey → zaloguj się kontem Google.
2. **Create API key** → skopiuj klucz (zaczyna się od `AIza...`).
3. Nigdzie go nie wklejaj do kodu — trafi do Vercel jako zmienna środowiskowa (krok 3).

Darmowy limit Gemini Flash wystarcza na setki paragonów miesięcznie.

## Krok 3: Vercel (hosting, ~5 min)

1. Wrzuć folder projektu na GitHub jako nowe repozytorium (np. `paragon-split`):
   ```
   git init
   git add .
   git commit -m "ParagonSplit"
   git branch -M main
   git remote add origin https://github.com/TWOJ-LOGIN/paragon-split.git
   git push -u origin main
   ```
2. Wejdź na https://vercel.com → zaloguj się GitHubem → **Add New → Project** → wybierz repo `paragon-split` → **Import**.
3. Przed kliknięciem Deploy rozwiń **Environment Variables** i dodaj:
   - Name: `GEMINI_API_KEY`
   - Value: klucz z kroku 2
4. **Deploy**. Po ~1 min dostaniesz adres typu `https://paragon-split.vercel.app`.

Każdy `git push` automatycznie wdraża nową wersję.

## Krok 4: Instalacja jak aplikacja (PWA)

- **Android (Chrome):** otwórz adres aplikacji → menu ⋮ → **Dodaj do ekranu głównego** / **Zainstaluj aplikację**. Chrome często sam zaproponuje instalację.
- **iOS (Safari):** otwórz adres → przycisk Udostępnij (kwadrat ze strzałką) → **Dodaj do ekranu początkowego**.

---

## Jak się używa

1. Otwórz aplikację → **Nowy rachunek** → powstaje unikalny link (`...?s=UUID`).
2. **Udostępnij** → wyślij link znajomym (WhatsApp/Messenger itd.). Każdy widzi to samo na żywo.
3. Zrób zdjęcie paragonu → AI wypisze pozycje (możesz je poprawić, usunąć, dodać ręcznie).
4. Dodaj imiona osób.
5. Przy każdej pozycji dotknij imion, które się na nią składają — koszt dzieli się równo między zaznaczonych.
   - Pozycja typu **4 × Piwo**: przypisz całość jednej osobie albo kliknij **„Rozdziel na 4 × 1 szt."** i przypisuj każdą sztukę osobno.
6. Wpisz napiwek (opcjonalnie) — dzielony **proporcjonalnie** do zamówień albo **po równo**.
7. Podsumowanie na dole pokazuje, kto ile płaci.

## Uwagi

- Bezpieczeństwo sesji: link zawiera niezgadywalny UUID — kto ma link, ten ma dostęp. Nie wrzucaj linku publicznie.
- Darmowe limity: Supabase (500 MB bazy), Vercel (100 GB transferu/mies.), Gemini (limit dzienny darmowego tier) — na prywatne użycie aż nadto.
- Stare sesje możesz czyścić w Supabase: Table Editor → sessions → usuń wiersze (kasują się kaskadowo z pozycjami).
