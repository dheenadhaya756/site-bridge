/* Embed: <script src="https://YOUR-HOST/widget.js" data-site="SITE_ID" defer></script>
 * A small, white-label AI agent inside the customer's own website: a round launcher in the
 * site's brand colour that opens a full-height panel docked on the right. The website moves
 * left to make room, so the panel never covers it. On phones the panel fills the screen.
 * Optional: data-color="#ff5a00" to force a brand colour. */
(function () {
  if (window.__agentifyWidget) return;
  window.__agentifyWidget = true;
  var me = document.currentScript || document.querySelector('script[src*="widget.js"][data-site]');
  var siteId = me && me.getAttribute('data-site');
  if (!siteId) return;
  var base = new URL(me.src).origin;
  var demo = me.getAttribute('data-demo') === '1';
  var OPEN_KEY = 'agentify:open:' + siteId;
  var SEEN_KEY = 'agentify:seen:' + siteId;

  function store(k, v) { try { if (v === undefined) return sessionStorage.getItem(k); sessionStorage.setItem(k, v); } catch (e) { return null; } }

  // If the panel was open on the previous page, make room for it right away, before the chat
  // scripts load, so the page doesn't show full width and then jump narrower on every navigation.
  // A plain panel-coloured block holds the space until the real panel appears on top of it.
  (function earlyDock() {
    if (store(OPEN_KEY) !== '1' || document.getElementById('agentify-early')) return;
    var w = innerWidth <= 640 ? innerWidth : Math.round(Math.min(420, Math.max(340, innerWidth * 0.3)));
    var st = document.createElement('style');
    st.id = 'agentify-early';
    st.textContent = 'html.agw-docked{margin-right:var(--agw-w,400px)!important;overflow-x:hidden!important}' +
      'html.agw-docked::after{content:"";position:fixed;top:0;right:0;bottom:0;width:var(--agw-w,400px);z-index:2147483640;pointer-events:none;' +
      'background:linear-gradient(180deg,#fff 0%,#f5f6fa 100%);border-left:1px solid rgba(15,23,42,.09)}' +
      '@media (max-width:640px){html.agw-docked{margin-right:0!important}}';
    (document.head || document.documentElement).appendChild(st);
    document.documentElement.style.setProperty('--agw-w', w + 'px');
    document.documentElement.classList.add('agw-docked');
  })();
  function load(src, attrs) {
    return new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      Object.keys(attrs || {}).forEach(function (k) { s.setAttribute(k, attrs[k]); });
      document.head.appendChild(s);
    });
  }

  // ---- brand detection: the most prominent saturated colour on buttons and links ----
  function parseRgb(c) {
    var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/.exec(c || '');
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  }
  function toHex(c) { return '#' + [c.r, c.g, c.b].map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join(''); }
  function hsl(c) {
    var r = c.r / 255, g = c.g / 255, b = c.b / 255, max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    var s = max === min ? 0 : (l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min));
    return { s: s, l: l };
  }
  function luminance(hex) {
    var h = hex.replace('#', '');
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    var rgb = [0, 2, 4].map(function (i) { var v = parseInt(h.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  }
  function detectBrand() {
    var score = {};
    var add = function (c, w) {
      if (!c || c.a < 0.6) return;
      var x = hsl(c);
      if (x.s < 0.28 || x.l < 0.12 || x.l > 0.88) return;
      var k = toHex(c);
      score[k] = (score[k] || 0) + w * (0.4 + x.s) * (x.l > 0.2 && x.l < 0.75 ? 1.3 : 0.7);
    };
    var els = document.querySelectorAll('button, a, [class*="btn"], [class*="button"], [class*="cta"], input[type="submit"]');
    for (var i = 0; i < els.length && i < 600; i++) {
      var el = els[i];
      if (el.closest('#agentify-widget')) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      var cs = getComputedStyle(el);
      add(parseRgb(cs.backgroundColor), 4 + Math.min(r.width * r.height, 30000) / 2500);
      if (el.tagName === 'A') add(parseRgb(cs.color), 1);
    }
    var best = null, bestScore = 0;
    for (var k in score) if (score[k] > bestScore) { best = k; bestScore = score[k]; }
    if (best) return best;
    var meta = document.querySelector('meta[name="theme-color"]');
    var mc = meta && meta.getAttribute('content');
    return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(mc || '') && luminance(mc) < 0.85 ? mc : null;
  }
  function siteFont() {
    var f = getComputedStyle(document.body).fontFamily || '';
    return f && !/^(times|serif)/i.test(f) ? f : null;
  }

  var AGENT_ICON = '<svg class="agw-ic agw-ic-agent" width="26" height="26" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2.5l1.7 5.1 5.1 1.7-5.1 1.7L12 16.1l-1.7-5.1-5.1-1.7 5.1-1.7z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" opacity=".8"/></svg>';
  var CLOSE_ICON = '<svg class="agw-ic agw-ic-close" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var ready = window.__agentifyBridge ? Promise.resolve() : load(base + '/bridge.js', { 'data-mode': 'widget', 'data-site-origin': location.origin });
  var configPromise = fetch(base + '/api/sites/' + siteId + '/public').then(function (r) { return r.json(); });
  Promise.all([ready, load(base + '/agent-client.js')]).then(function () {
    var accent = me.getAttribute('data-color') || detectBrand() || '#2238f5';
    var onAccent = luminance(accent) > 0.45 ? '#0f172a' : '#ffffff';
    var font = siteFont();

    var wrap = document.createElement('div');
    wrap.id = 'agentify-widget';
    wrap.style.setProperty('--agw-accent', accent);
    wrap.style.setProperty('--agw-on', onAccent);
    if (font) wrap.style.setProperty('--agw-font', font);
    wrap.innerHTML =
      '<style>' +
      '#agentify-widget{--agw-font:"Inter Tight",system-ui,-apple-system,"Segoe UI",sans-serif;font-family:var(--agw-font)}' +
      // Round agent launcher: brand-coloured orb with a soft glass ring
      '#agentify-widget .agw-launch{position:fixed;right:22px;bottom:22px;z-index:2147483645;width:62px;height:62px;border-radius:50%;border:0;padding:0;cursor:pointer;color:var(--agw-on);' +
        'background:radial-gradient(circle at 32% 26%,color-mix(in srgb,var(--agw-accent) 50%,#fff) 0%,var(--agw-accent) 52%,color-mix(in srgb,var(--agw-accent) 68%,#000) 100%);' +
        'box-shadow:0 0 0 5px rgba(255,255,255,.55),0 0 0 6px rgba(15,23,42,.06),0 14px 34px rgba(15,23,42,.28),inset 0 2px 3px rgba(255,255,255,.45);display:grid;place-items:center;transition:transform .25s cubic-bezier(.22,1,.36,1)}' +
      '#agentify-widget .agw-launch:hover{transform:scale(1.06)}' +
      '#agentify-widget .agw-launch::before{content:"";position:absolute;inset:-5px;border-radius:50%;border:1.5px solid var(--agw-accent);opacity:0;animation:agwPing 2.8s ease-out infinite}' +
      '#agentify-widget.open .agw-launch::before{animation:none}' +
      '@keyframes agwPing{0%{transform:scale(.92);opacity:.55}70%,100%{transform:scale(1.35);opacity:0}}' +
      '#agentify-widget .agw-ic{position:absolute;transition:transform .3s cubic-bezier(.22,1,.36,1),opacity .2s}' +
      '#agentify-widget .agw-ic-close{opacity:0;transform:rotate(-90deg) scale(.6)}' +
      '#agentify-widget.open .agw-ic-agent{opacity:0;transform:rotate(90deg) scale(.6)}' +
      '#agentify-widget.open .agw-ic-close{opacity:1;transform:none}' +
      // Greeting bubble
      '#agentify-widget .agw-teaser{position:fixed;right:22px;bottom:98px;z-index:2147483645;max-width:260px;color:#0d0f1a;font:500 13.5px/1.45 var(--agw-font);padding:11px 14px;border-radius:16px 16px 4px 16px;cursor:pointer;' +
        'background:rgba(255,255,255,.78);-webkit-backdrop-filter:blur(18px) saturate(170%);backdrop-filter:blur(18px) saturate(170%);border:1px solid rgba(255,255,255,.8);box-shadow:0 10px 30px rgba(15,23,42,.16);animation:agwIn .45s cubic-bezier(.22,1,.36,1)}' +
      '@keyframes agwIn{from{opacity:0;transform:translateY(8px)}}' +
      // Docked side panel: full height on the right. The website moves left to make room,
      // so the panel never covers the page.
      '#agentify-widget .agw-panel{position:fixed;top:0;right:0;bottom:0;z-index:2147483646;width:var(--agw-w,400px);height:100vh;height:100dvh;overflow:hidden;' +
        'background:linear-gradient(180deg,#ffffff 0%,#f5f6fa 100%);border-left:1px solid rgba(15,23,42,.09);box-shadow:-10px 0 34px rgba(15,23,42,.08);' +
        'transform:translateX(100%);visibility:hidden;transition:transform .34s cubic-bezier(.22,1,.36,1),visibility 0s .34s}' +
      '#agentify-widget .agw-panel::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 40% at 100% 0%,color-mix(in srgb,var(--agw-accent) 10%,transparent),transparent 60%)}' +
      '#agentify-widget.open .agw-panel{transform:none;visibility:visible;transition:transform .34s cubic-bezier(.22,1,.36,1)}' +
      '#agentify-widget.no-anim .agw-panel{transition:none}' +
      '#agentify-widget.open .agw-teaser{display:none}' +
      '#agentify-widget.open .agw-launch{opacity:0;pointer-events:none;transform:scale(.6)}' +
      'html.agw-docked{margin-right:var(--agw-w,400px)!important;overflow-x:hidden!important}' +
      'html.agw-docking{transition:margin-right .34s cubic-bezier(.22,1,.36,1)}' +
      '@media (max-width:640px){#agentify-widget .agw-panel{width:100%;border-left:0}html.agw-docked{margin-right:0!important}#agentify-widget .agw-launch{right:16px;bottom:16px;width:56px;height:56px}}' +
      '@media (prefers-reduced-motion:reduce){#agentify-widget *{animation:none!important;transition:none!important}}' +
      '</style>' +
      '<div class="agw-panel" role="dialog" aria-label="AI assistant"><div class="agw-chat" style="position:relative;height:100%"></div></div>' +
      '<button class="agw-launch" type="button" aria-label="Open AI assistant" aria-expanded="false">' + AGENT_ICON + CLOSE_ICON + '</button>';
    document.body.appendChild(wrap);

    var launch = wrap.querySelector('.agw-launch');
    var chat;
    var root = document.documentElement;
    var docked = false;
    var moved = []; // fixed elements we shifted left: [el, originalRight, originalWidth]

    function panelWidth() { return innerWidth <= 640 ? innerWidth : Math.round(Math.min(420, Math.max(340, innerWidth * 0.3))); }

    // The page's own fixed headers, bars and buttons sit against the viewport, not the page,
    // so margin alone doesn't move them. Shift the ones that would end up under the panel.
    function restoreFixed() {
      moved.forEach(function (m) { m[0].style.right = m[1]; m[0].style.width = m[2]; });
      moved = [];
    }
    function shiftFixed(w) {
      restoreFixed();
      if (innerWidth <= 640) return;
      var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, {
        acceptNode: function (node) { return node === wrap || node.id === 'agentify-overlay' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
      });
      var limit = innerWidth - w, n = 0, el;
      while ((el = walker.nextNode()) && n++ < 6000) {
        var cs = getComputedStyle(el);
        if (cs.position !== 'fixed') continue;
        var r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1 || r.right <= limit + 1) continue;
        var rec = [el, el.style.right, el.style.width];
        if (cs.right !== 'auto') {
          // Right-anchored (or stretched left-to-right): moving the right edge shifts or shrinks it
          el.style.right = (parseFloat(cs.right) || 0) + w + 'px';
        } else if (r.left < limit) {
          el.style.width = Math.max(0, r.width - (r.right - limit)) + 'px';  // left-anchored, too wide
        } else continue;
        moved.push(rec);
      }
    }
    function dock(v, animate) {
      var w = panelWidth();
      root.style.setProperty('--agw-w', w + 'px');
      wrap.style.setProperty('--agw-w', w + 'px');
      if (animate) { root.classList.add('agw-docking'); setTimeout(function () { root.classList.remove('agw-docking'); }, 400); }
      root.classList.toggle('agw-docked', v);
      docked = v;
      if (v) shiftFixed(w); else restoreFixed();
      // Let the page re-measure (sliders, sticky headers, charts) for its new width
      setTimeout(function () { try { window.dispatchEvent(new Event('resize')); } catch (e) { /* old browser */ } }, animate ? 380 : 0);
    }
    var resizeT;
    window.addEventListener('resize', function (e) {
      if (!docked || !e.isTrusted) return;
      clearTimeout(resizeT);
      resizeT = setTimeout(function () { dock(true, false); }, 150);
    });

    function setOpen(v) {
      wrap.classList.toggle('open', v);
      dock(v, true);
      launch.setAttribute('aria-expanded', String(v));
      launch.setAttribute('aria-label', v ? 'Close AI assistant' : 'Open AI assistant');
      store(OPEN_KEY, v ? '1' : '0');
      var t = wrap.querySelector('.agw-teaser'); if (t) t.remove();
      if (v && chat) setTimeout(chat.focus, 320);
    }
    launch.addEventListener('click', function () { setOpen(!wrap.classList.contains('open')); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && wrap.classList.contains('open')) setOpen(false); });

    var bridge = window.__agentifyBridge;
    chat = window.Agentify.mountChat(wrap.querySelector('.agw-chat'), {
      apiBase: base,
      siteId: siteId,
      accent: accent,
      onAccent: onAccent,
      font: font,
      unloadsOnNavigate: true,
      configPromise: configPromise,
      onClose: function () { setOpen(false); launch.focus(); },
      getContext: function () { return { url: bridge.logicalUrl(), title: document.title }; },
      exec: function (name, args) {
        var map = { read_current_page: 'snapshot', go_back: 'back' };
        return bridge.run(map[name] || name, args);
      },
      onLinkClick: function (href) {
        var local = bridge.localUrl(href);
        if (!local) return false;
        location.href = local;
        return true;
      },
      onConfig: function (cfg) {
        if (store(SEEN_KEY)) return;
        store(SEEN_KEY, '1');
        if (demo) { setTimeout(function () { setOpen(true); }, 900); return; }
        var t = document.createElement('div');
        t.className = 'agw-teaser';
        t.textContent = cfg.greeting || 'Hi! Ask me anything about this site.';
        t.addEventListener('click', function () { setOpen(true); });
        wrap.appendChild(t);
      },
    });

    if (store(OPEN_KEY) === '1') {
      wrap.classList.add('no-anim', 'open');
      dock(true, false);
      launch.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(function () { requestAnimationFrame(function () { wrap.classList.remove('no-anim'); }); });
      // Back in the chat box after the agent opened this page (not on touch screens: no keyboard pop-up)
      if (window.matchMedia && matchMedia('(pointer: fine)').matches) setTimeout(chat.focus, 60);
    }
  }).catch(function () { /* fail silently on the customer's site */ });
})();
