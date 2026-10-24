// Site motion: smooth scrolling, reveal-on-scroll with stagger, count-up numbers, sticky header.
(function () {
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('motion-ready');

  // ---- smooth scrolling (Lenis), with in-page anchors handled ----
  if (!reduced && window.Lenis) {
    var lenis = new window.Lenis({ lerp: 0.12, wheelMultiplier: 1, smoothWheel: true, syncTouch: false, anchors: { offset: -80 } });
    (function raf(time) { lenis.raf(time); requestAnimationFrame(raf); })(performance.now());
    window.__lenis = lenis;
  }

  // ---- sticky glass header ----
  var nav = document.querySelector('.nav');
  function onScroll() { nav.classList.toggle('scrolled', scrollY > 12); }
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- reveal on scroll ----
  var groups = [
    '.trust > *', '.band > .band-card', '.band > .band-stat',
    '.caps-intro > *', '.cap',
    '.how-sec > .badge-sq', '.how-sec > h2', '.how-sec > .sec-sub', '.how-card',
    '.impact-head > *', '.impact-row',
    '.pricing-head > *', '.price',
    '.faq-head > *', '.faq-list > details',
    '.recent-wrap > .badge-sq', '.recent-wrap > h2',
    '.cta-ic', '.cta-grid > *', '.foot-card', '.foot-line',
  ];
  var targets = document.querySelectorAll(groups.join(','));
  targets.forEach(function (el) {
    el.classList.add('reveal');
    var sibs = Array.prototype.filter.call(el.parentElement.children, function (c) { return c.classList.contains('reveal'); });
    el.style.setProperty('--d', (Math.min(sibs.indexOf(el), 6) * 90) + 'ms');
  });
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      e.target.classList.add('in');
      io.unobserve(e.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
  targets.forEach(function (el) { io.observe(el); });

  // Reveal items added later (recent sites, results)
  window.revealNew = function (root) {
    (root || document).querySelectorAll('.rcard, .result > *').forEach(function (el, i) {
      if (el.classList.contains('reveal')) return;
      el.classList.add('reveal');
      el.style.setProperty('--d', (Math.min(i, 8) * 70) + 'ms');
      io.observe(el);
    });
  };

  // ---- count-up numbers ----
  var counters = document.querySelectorAll('[data-count]');
  var cio = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      cio.unobserve(e.target);
      var el = e.target, end = Number(el.dataset.count), pre = el.dataset.pre || '', suf = el.dataset.suf || '';
      if (reduced) { el.textContent = pre + end + suf; return; }
      var t0 = performance.now(), dur = 1400;
      (function tick(now) {
        var p = Math.min(1, (now - t0) / dur), eased = 1 - Math.pow(1 - p, 3);
        el.textContent = pre + Math.round(end * eased) + suf;
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    });
  }, { threshold: 0.6 });
  counters.forEach(function (el) { cio.observe(el); });

  // ---- subtle parallax on the blue fluid art ----
  if (!reduced) {
    var arts = document.querySelectorAll('.fluid-art');
    addEventListener('scroll', function () {
      arts.forEach(function (a) {
        var r = a.parentElement.getBoundingClientRect();
        if (r.bottom < 0 || r.top > innerHeight) return;
        a.style.transform = 'translate3d(0,' + ((r.top - innerHeight / 2) * -0.06).toFixed(1) + 'px,0) scale(1.15)';
      });
    }, { passive: true });
  }
})();
