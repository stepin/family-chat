/* Appearance and language before the first paint.
 *
 * A classic script loaded from <head> of index.html, before the stylesheet:
 * the Content-Security-Policy forbids inline scripts, but a same-origin file
 * is allowed and runs synchronously, so the page is never drawn in the
 * default theme first. It reads what src/lib/appearance.ts and
 * src/lib/locale.ts keep in localStorage and sets the same attributes on
 * <html> (keep the rules in step with appearance.ts: a unit test compares
 * them). Anything unexpected is ignored: the defaults stay.
 */
(function () {
  var THEMES = ['system', 'light', 'dark'];
  var PALETTES = ['green', 'blue', 'violet', 'rose', 'orange', 'graphite'];
  var RADII = ['small', 'medium', 'large'];
  var BACKGROUNDS = ['plain', 'tint', 'dots', 'grid', 'diagonal', 'waves'];
  var SCALES = [0.875, 1, 1.125, 1.25, 1.4];
  var COLORS = {
    green: ['#1e4e41', '#1c211f'],
    blue: ['#1e5aa0', '#1a2029'],
    violet: ['#5b3d99', '#1f1b26'],
    rose: ['#a3325a', '#251b1e'],
    orange: ['#a34a12', '#241d16'],
    graphite: ['#3d4250', '#1c1d21'],
  };
  function pick(v, list, fallback) {
    return list.indexOf(v) >= 0 ? v : fallback;
  }
  var root = document.documentElement;
  var o = {};
  var lang = null;
  try {
    var raw = window.localStorage.getItem('fc.appearance');
    if (raw) {
      var v = JSON.parse(raw);
      if (v && typeof v === 'object' && !Array.isArray(v)) o = v;
    }
    lang = window.localStorage.getItem('fc.lang');
  } catch (e) {
    o = {};
  }
  var theme = pick(o.theme, THEMES, 'system');
  var palette = pick(o.palette, PALETTES, 'green');
  var radius = pick(o.radius, RADII, 'medium');
  var bg = pick(o.background, BACKGROUNDS, 'plain');
  var size = typeof o.textSize === 'number' && o.textSize % 1 === 0 && o.textSize >= 0 && o.textSize < SCALES.length ? o.textSize : 1;
  if (theme !== 'system') root.setAttribute('data-theme', theme);
  if (palette !== 'green') root.setAttribute('data-palette', palette);
  if (radius !== 'medium') root.setAttribute('data-radius', radius);
  if (bg !== 'plain') root.setAttribute('data-chat-bg', bg);
  if (size !== 1) root.style.setProperty('--chat-scale', String(SCALES[size]));
  var colors = COLORS[palette];
  var forced = theme === 'light' ? colors[0] : theme === 'dark' ? colors[1] : null;
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) {
    var dark = (metas[i].getAttribute('media') || '').indexOf('dark') >= 0;
    metas[i].setAttribute('content', forced || (dark ? colors[1] : colors[0]));
  }
  // The language: the person's choice, else the first of ru/en in the system list, else Russian.
  if (lang !== 'ru' && lang !== 'en') {
    lang = 'ru';
    var list = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || ''];
    for (var j = 0; j < list.length; j++) {
      var p = String(list[j]).toLowerCase().split(/[-_]/)[0];
      if (p === 'ru' || p === 'en') {
        lang = p;
        break;
      }
    }
  }
  root.setAttribute('lang', lang);
})();
