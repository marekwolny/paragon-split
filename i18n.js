// Tlumaczenia PL -> EN + motyw jasny/ciemny (window.t, przelaczniki w naglowku)
(function () {
  const EN = {
    // wspolne
    '🔗 Udostępnij': '🔗 Share',
    '📲 Zainstaluj': '📲 Install',
    'Imię': 'Name',
    'Dodaj': 'Add',
    'Utwórz': 'Create',
    'Dołącz': 'Join',
    'Razem': 'Total',
    'Napiwek': 'Tip',
    'napiwek': 'tip',
    'pozycje': 'items',
    'Rozliczenie': 'Settlement',
    'Kto komu oddaje': 'Who pays whom',
    'Kto komu oddaje:': 'Who pays whom:',
    'Błąd: ': 'Error: ',

    // landing
    'Zaloguj się, aby tworzyć grupy wyjazdowe (dołączanie przez link nie wymaga konta).': 'Sign in to create trip groups (joining via link requires no account).',
    'Zaloguj przez Google': 'Sign in with Google',
    'Wyloguj': 'Sign out',
    '🏕️ Grupy wyjazdowe': '🏕️ Trip groups',
    'Nazwa wyjazdu, np. Chorwacja 2026': 'Trip name, e.g. Croatia 2026',
    'Szybki pojedynczy rachunek bez grupy i logowania:': 'Quick single bill — no group, no sign-in:',
    '➕ Nowy rachunek': '➕ New bill',
    'Zaloguj się, aby zobaczyć swoje grupy. Do cudzej grupy dołączysz przez otrzymany link.': 'Sign in to see your groups. Join others’ groups via a shared link.',
    'Brak grup — utwórz pierwszą poniżej.': 'No groups yet — create one below.',
    ' (dołączono z linku)': ' (joined via link)',
    'Zaloguj się, aby utworzyć grupę': 'Sign in to create a group',

    // sesja / paragon
    '1. Paragon': '1. Receipt',
    '📷 Zrób zdjęcie / wybierz plik': '📷 Take a photo / choose file',
    'Waluta:': 'Currency:',
    'Zapłacono łącznie w PLN (opcjonalnie, nadpisze kurs):': 'Total paid in PLN (optional, overrides the rate):',
    '2. Osoby': '2. People',
    '3. Pozycje': '3. Items',
    '— dotknij imienia, by przypisać': '— tap a name to assign',
    '➕ Dodaj pozycję ręcznie': '➕ Add item manually',
    '👥 Wszyscy na wszystko': '👥 Everyone on everything',
    '4. Napiwek': '4. Tip',
    'Proporcjonalnie': 'Proportional',
    'Po równo': 'Split equally',
    '5. Kto zapłacił?': '5. Who paid?',
    '— dotknij imienia, kwotę można poprawić': '— tap a name, amount can be edited',
    '6. Podsumowanie': '6. Summary',
    '— dotknij osoby, by zobaczyć jej pozycje': '— tap a person to see their items',
    '▾ Rozwiń wszystkich': '▾ Expand all',
    '▴ Zwiń wszystkich': '▴ Collapse all',
    '📋 Kopiuj rozliczenie': '📋 Copy settlement',
    '← wróć do grupy': '← back to group',
    '🔑 Własny klucz AI': '🔑 Your own AI key',
    'Dodaj osoby, które się składają': 'Add the people splitting the bill',
    'Brak pozycji — wgraj zdjęcie paragonu lub dodaj ręcznie.': 'No items — upload a receipt photo or add manually.',
    'Dodaj osoby i pozycje, aby zobaczyć podział.': 'Add people and items to see the split.',
    'Brak przypisanych pozycji': 'No items assigned',
    'Wszystko rozliczone ✅': 'All settled ✅',
    'Nowa pozycja': 'New item',
    'udz.': 'sh.',
    'Rozdziel na': 'Split into',
    'szt.': 'pcs',
    'Nieprzypisane pozycje': 'Unassigned items',
    '(nie wliczone do podziału)': '(not included in the split)',
    'Link skopiowany 📋': 'Link copied 📋',
    'Rozliczenie skopiowane 📋 — wklej na czacie': 'Settlement copied 📋 — paste it in your chat',
    'Ta osoba już jest': 'This person already exists',
    '🧾 Rozliczenie rachunku': '🧾 Bill settlement',
    '— do zapłaty': '— owes',

    // grupa
    'Nazwa wyjazdu': 'Trip name',
    'Uczestnicy': 'Participants',
    'Paragony i wydatki': 'Receipts & expenses',
    '➕ Dodaj wydatek (zdjęcie paragonu)': '➕ Add expense (receipt photo)',
    '⚡ Szybki wydatek bez paragonu': '⚡ Quick expense (no receipt)',
    'Co? np. Taxi z lotniska': 'What? e.g. Taxi from the airport',
    'Kwota': 'Amount',
    'Kto zapłacił? (dzielone równo na wszystkich)': 'Who paid? (split equally among everyone)',
    'Dodaj wydatek': 'Add expense',
    'Wydatki wg kategorii': 'Spending by category',
    '(PLN)': '(PLN)',
    'Rozliczenie wyjazdu': 'Trip settlement',
    '(wszystko w PLN)': '(everything in PLN)',
    '📋 Kopiuj': '📋 Copy',
    '🖨️ Drukuj / PDF': '🖨️ Print / PDF',
    '🕒 Historia aktywności': '🕒 Activity history',
    '← strona główna': '← home',
    'Ty w tej grupie:': 'You in this group:',
    '✏️ zmień imię': '✏️ change name',
    'to nie ja': 'not me',
    '👋 Kim jesteś w tej grupie?': '👋 Who are you in this group?',
    'Jesteś już na liście? Dotknij swojego imienia:': 'Already on the list? Tap your name:',
    'Albo dopisz nowe imię': 'Or add a new name',
    'Twoje imię': 'Your name',
    'Dodaj uczestników wyjazdu — będą widoczni we wszystkich paragonach': 'Add trip participants — visible on all receipts',
    'Brak paragonów — dodaj pierwszy.': 'No receipts yet — add the first one.',
    'Dodaj uczestników i paragony, aby zobaczyć rozliczenie.': 'Add participants and receipts to see the settlement.',
    'Brak wydatków.': 'No expenses yet.',
    'Brak aktywności.': 'No activity yet.',
    'wydał': 'spent',
    'zapłacił': 'paid',
    'Razem wydatki': 'Total spending',
    'Spłacone ✓': 'Settled ✓',
    '✓ oddane': '✓ paid back',
    '📱 nr do przelewów': '📱 payment number',
    'Wydatek dodany ⚡': 'Expense added ⚡',
    'CSV pobrany ⬇️': 'CSV downloaded ⬇️',
    'Link do grupy skopiowany 📋': 'Group link copied 📋',
    'Wpisz, czego dotyczy wydatek': 'Describe the expense',
    'Wpisz kwotę': 'Enter the amount',
    'Najpierw dodaj uczestników': 'Add participants first',
    'Zaznacz, kto zapłacił': 'Select who paid',
    'jedzenie': 'food', 'transport': 'transport', 'nocleg': 'lodging', 'rozrywka': 'fun', 'zakupy': 'shopping', 'inne': 'other',
    '🍕 jedzenie': '🍕 food', '🚗 transport': '🚗 transport', '🏨 nocleg': '🏨 lodging', '🎉 rozrywka': '🎉 fun', '🛒 zakupy': '🛒 shopping', '📦 inne': '📦 other',
    'inna…': 'other…'
  };

  const saved = localStorage.getItem('lang');
  const lang = saved || ((navigator.language || 'pl').toLowerCase().startsWith('pl') ? 'pl' : 'en');
  window.APP_LANG = lang;
  window.t = function (s) {
    if (lang === 'pl') return s;
    return EN[s] !== undefined ? EN[s] : s;
  };

  // ---------- motyw ----------
  function applyTheme() {
    const th = localStorage.getItem('theme'); // 'dark' | 'light' | null (auto)
    if (th) document.documentElement.setAttribute('data-theme', th);
    else document.documentElement.removeAttribute('data-theme');
  }
  applyTheme();

  function effectiveDark() {
    const th = localStorage.getItem('theme');
    if (th) return th === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  document.addEventListener('DOMContentLoaded', function () {
    // przetlumacz statyczny HTML: wszystkie wezly tekstowe + placeholdery + opcje
    if (lang !== 'pl') {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const v = node.nodeValue.trim();
        if (v && EN[v] !== undefined) node.nodeValue = node.nodeValue.replace(v, EN[v]);
      }
      document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(function (el) {
        el.placeholder = window.t(el.placeholder);
      });
    }

    // przyciski: motyw + jezyk
    const btns = document.querySelector('.header-btns');
    if (btns) {
      const themeBtn = document.createElement('button');
      themeBtn.className = 'btn-small';
      themeBtn.textContent = effectiveDark() ? '☀️' : '🌙';
      themeBtn.title = lang === 'pl' ? 'Jasny / ciemny motyw' : 'Light / dark theme';
      themeBtn.onclick = function () {
        localStorage.setItem('theme', effectiveDark() ? 'light' : 'dark');
        applyTheme();
        themeBtn.textContent = effectiveDark() ? '☀️' : '🌙';
      };
      const langBtn = document.createElement('button');
      langBtn.className = 'btn-small';
      langBtn.textContent = lang === 'pl' ? 'EN' : 'PL';
      langBtn.title = lang === 'pl' ? 'Switch to English' : 'Przełącz na polski';
      langBtn.onclick = function () {
        localStorage.setItem('lang', lang === 'pl' ? 'en' : 'pl');
        location.reload();
      };
      btns.prepend(langBtn);
      btns.prepend(themeBtn);
    }
  });
})();
