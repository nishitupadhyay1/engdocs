/* Theme: Light, Dark or System. Runs before the page paints so there is no flash of the wrong theme. */
(function () {
  var KEY = 'engdocs.theme', mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function read() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (e) { return 'system'; } }
  var pref = read();
  function resolved() { return pref === 'system' ? (mq && mq.matches ? 'dark' : 'light') : pref; }
  function apply() {
    var r = resolved();
    document.documentElement.setAttribute('data-theme', r);
    var m = document.querySelector('meta[name="theme-color"]'); if (m) m.setAttribute('content', r === 'dark' ? '#060b16' : '#0f172a');
    var b = document.getElementById('btnTheme');
    if (b) {
      b.textContent = pref === 'system' ? '🖥' : pref === 'dark' ? '🌙' : '☀';
      var name = pref === 'system' ? 'System (' + r + ')' : pref === 'dark' ? 'Dark' : 'Light';
      b.title = 'Theme: ' + name + '. Click to change.'; b.setAttribute('aria-label', 'Theme: ' + name);
    }
  }
  function set(p) { pref = p; try { localStorage.setItem(KEY, p); } catch (e) { /* blocked: applies for this visit only */ } apply(); }
  function cycle() { set(pref === 'system' ? 'light' : pref === 'light' ? 'dark' : 'system'); }
  if (mq) { var f = function () { if (pref === 'system') apply(); }; if (mq.addEventListener) mq.addEventListener('change', f); else if (mq.addListener) mq.addListener(f); }
  window.EngTheme = { get: function () { return pref; }, resolved: resolved, set: set, cycle: cycle, apply: apply };
  apply();
  document.addEventListener('DOMContentLoaded', function () { apply(); var b = document.getElementById('btnTheme'); if (b) b.addEventListener('click', cycle); });
})();
