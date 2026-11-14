/* Colour themes: five accents, remembered per browser and applied before paint. */
(function () {
  var KEY = 'messenger-theme';
  var THEMES = ['blue', 'forest', 'violet', 'sunset', 'rose'];

  function read() {
    try {
      var t = localStorage.getItem(KEY);
      return THEMES.indexOf(t) >= 0 ? t : 'blue';
    } catch (e) {
      return 'blue';
    }
  }

  function paint(theme) {
    document.documentElement.dataset.theme = theme;
    var rows = document.querySelectorAll('.theme-row');
    for (var i = 0; i < rows.length; i++) {
      rows[i].classList.toggle('on', rows[i].dataset.theme === theme);
    }
  }

      function set(theme) {
      if (THEMES.indexOf(theme) < 0) return;
      try { localStorage.setItem(KEY, theme); } catch (e) {}
      paint(theme);
      // Also keep it on the account: the public port changes between sessions,
      // and localStorage is per origin, so this is what survives a new port.
      try {
        fetch('/api/theme', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: theme })
        }).catch(function () {});
      } catch (e) {}
    }

    // Applied once the app has loaded the signed-in account's saved theme.
    window.syncThemeFromServer = function (theme) {
      if (!theme || THEMES.indexOf(theme) < 0) return;
      if (theme === read()) return;
      try { localStorage.setItem(KEY, theme); } catch (e) {}
      paint(theme);
    };

  paint(read());
  window.applyTheme = set;
  window.currentTheme = read;

  window.initThemePicker = function () {
    var btn = document.getElementById('btnTheme');
    var pop = document.getElementById('themePop');
    if (!btn || !pop) return;
    paint(read());

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      pop.classList.toggle('open');
    });
    pop.addEventListener('click', function (e) {
      var row = e.target.closest('.theme-row');
      if (!row) return;
      set(row.dataset.theme);
      pop.classList.remove('open');
    });
    document.addEventListener('click', function () { pop.classList.remove('open'); });
  };
})();
