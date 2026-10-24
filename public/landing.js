/* Pixel-gradient art for the landing page: vertical bands of blue squares, drawn once per
   canvas (re-drawn on resize). Each canvas gets its own pattern from data-seed. */
(function () {
  function rand(seed) {
    var s = seed >>> 0;
    return function () { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  }
  // Light lavender to deep electric blue
  var STOPS = [[226, 231, 255], [176, 190, 255], [120, 145, 252], [74, 104, 248], [52, 82, 240], [39, 64, 226]];
  function mix(t) {
    t = Math.max(0, Math.min(0.999, t)) * (STOPS.length - 1);
    var i = Math.floor(t), f = t - i, a = STOPS[i], b = STOPS[i + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }
  function draw(canvas) {
    var r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    var cell = r.width < 600 ? 14 : 20;
    var cols = Math.ceil(r.width / cell), rows = Math.ceil(r.height / cell);
    canvas.width = cols; canvas.height = rows; // one pixel per square, scaled up with pixelated rendering
    var ctx = canvas.getContext('2d');
    var rnd = rand(Number(canvas.dataset.seed) || 1);
    // Column "bands": each column has a base brightness that drifts smoothly across the width
    var bands = [], v = rnd();
    for (var c = 0; c < cols; c++) { v += (rnd() - 0.5) * 0.35; v = Math.max(0, Math.min(1, v)); bands.push(v); }
    for (var x = 0; x < cols; x++) {
      for (var y = 0; y < rows; y++) {
        var fy = y / rows;
        // Brighter towards the top middle, deeper blue at the edges and bottom, with square-level noise
        var t = 0.55 * bands[x] + 0.35 * Math.abs(fy - 0.35) * 1.6 + (rnd() - 0.5) * 0.18;
        ctx.fillStyle = mix(1 - t * 0.95);
        ctx.fillRect(x, y, 1, 1);
      }
    }
  }
  var canvases = document.querySelectorAll('canvas.lx-pixels');
  function all() { for (var i = 0; i < canvases.length; i++) draw(canvases[i]); }
  all();
  var t;
  addEventListener('resize', function () { clearTimeout(t); t = setTimeout(all, 150); });
})();
