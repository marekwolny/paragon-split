// Wersja wgranej paczki + stopka na dole strony.
//
// PODBIJ `number` PRZY KAZDYM DEPLOYU. Stopka pokazuje ten numer, wiec od razu widac,
// czy przegladarka ma nowa wersje, czy stara z cache PWA.
window.APP_VERSION = {
  number: '2026.08.28.12',
  date: '2026-08-28',
  notes: 'napiwek spojny z grupa, waluta wszedzie, retry AI, tlumaczenie pozycji, platnicy napiwku, auto-nazwa i kategoria, dostep przez RPC'
};

(function () {
  document.addEventListener('DOMContentLoaded', function () {
    var v = window.APP_VERSION;
    var foot = document.createElement('footer');
    foot.className = 'app-version';

    var line = document.createElement('button');
    line.className = 'app-version-line';
    line.textContent = 'ParagonSplit ' + v.number + '  ⓘ';
    line.title = 'Dotknij, aby sprawdzić, co jest faktycznie wgrane';

    var box = document.createElement('div');
    box.className = 'app-version-details hidden';

    line.onclick = async function () {
      if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
      box.classList.remove('hidden');
      box.textContent = 'sprawdzam…';
      var rows = [];
      rows.push('Wersja pliku: ' + v.number + ' (' + v.date + ')');

      // cache PWA — zmienia sie przy kazdym deployu, wiec pokazuje, czy service worker sie odswiezyl
      try {
        var keys = await caches.keys();
        var mine = keys.filter(function (k) { return k.indexOf('paragonsplit') === 0; });
        rows.push('Cache PWA: ' + (mine.length ? mine.join(', ') : 'brak'));
      } catch (e) {
        rows.push('Cache PWA: nie da się odczytać');
      }
      try {
        var reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
        rows.push('Service worker: ' + (reg ? (reg.active ? 'aktywny' : 'instaluje się') : 'brak'));
      } catch (e) { /* trudno */ }

      // stan bazy
      if (typeof window.__psDiag === 'function') {
        try {
          var d = await window.__psDiag();
          rows.push('Dostęp do bazy: ' + (d.rpc ? 'przez RPC ✓' : 'stary tryb — uruchom rls-hardening.sql'));
          rows.push('Kolumna items.orig_name: ' + (d.origName ? '✓' : 'brak — uruchom migration-2026-08.sql'));
          rows.push('Kolumna sessions.tip_payers: ' + (d.tipPayers ? '✓' : 'brak — uruchom migration-2026-08.sql'));
        } catch (e) {
          rows.push('Stan bazy: nie udało się sprawdzić (' + e.message + ')');
        }
      }

      rows.push('', v.notes);
      box.textContent = '';
      rows.forEach(function (r) {
        var p = document.createElement('div');
        p.textContent = r;
        box.appendChild(p);
      });
    };

    foot.appendChild(line);
    foot.appendChild(box);
    document.body.appendChild(foot);
  });
})();
