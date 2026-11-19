(function () {
  var d = document.documentElement, g = function (k, v) { try { return localStorage.getItem('ada_' + k) || v; } catch (e) { return v; } };
  var t = g('theme', 'system'), m = g('motion', 'system');
  d.dataset.theme = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  d.dataset.motion = m === 'reduced' || (m === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches) ? 'reduced' : 'full';
  d.dataset.size = g('size', 'normal');
})();
