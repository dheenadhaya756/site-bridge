/* Site Bridge bridge: lets the agent see and operate the page it is loaded into.
 * mode="frame"  : injected by the preview proxy; talks to the Site Bridge app via postMessage.
 * mode="widget" : loaded by widget.js on the customer's real site; called directly. */
(function () {
  if (window.__agentifyBridge) return;
  var script = document.currentScript || {};
  var ds = script.dataset || {};
  var MODE = ds.mode || 'frame';
  var APP_ORIGIN = ds.appOrigin || '*';
  var SITE_ORIGIN = ds.siteOrigin || location.origin;
  // Proxy behaviours (URL mapping, link capture, demo form blocking) apply whenever the
  // page is served through the Site Bridge preview, whether the agent runs in-page or not.
  var IN_PROXY = MODE === 'frame' || ds.proxy === '1';
  var bare = function (h) { return String(h).toLowerCase().replace(/^www\./, ''); };
  var SITE_HOST = bare(new URL(SITE_ORIGIN).hostname);
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // ---- URL mapping between the original site and the page we are on ----
  function logicalUrl(href) {
    var u = new URL(href || location.href, location.href);
    return IN_PROXY ? SITE_ORIGIN + u.pathname + u.search + u.hash : u.href;
  }
  function localUrl(url) {
    var u;
    try { u = new URL(url, IN_PROXY ? SITE_ORIGIN : location.href); } catch (e) { return null; }
    if (u.origin === location.origin) return u.href;
    if (bare(u.hostname) !== SITE_HOST) return null;
    return location.origin + u.pathname + u.search + u.hash;
  }

  // ---- messaging (frame mode) ----
  function post(msg) {
    if (!IN_PROXY || window.parent === window) return;
    msg.agentify = true;
    try { window.parent.postMessage(msg, APP_ORIGIN); } catch (e) { /* parent gone */ }
  }

  if (IN_PROXY) {
    // The preview must not install service workers on the preview origin
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = function () { return Promise.reject(new Error('Disabled in Site Bridge preview')); };
        navigator.serviceWorker.getRegistrations().then(function (rs) { rs.forEach(function (r) { r.unregister(); }); }).catch(function () {});
      }
    } catch (e) { /* ignore */ }

    // Report client-side route changes so the address bar stays in sync
    ['pushState', 'replaceState'].forEach(function (fn) {
      var orig = history[fn];
      history[fn] = function () {
        var r = orig.apply(this, arguments);
        post({ type: 'urlchange', url: logicalUrl(), title: document.title });
        return r;
      };
    });
    window.addEventListener('popstate', function () { post({ type: 'urlchange', url: logicalUrl(), title: document.title }); });

    // Keep same-site links inside the preview; open external links in a new tab
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a || e.defaultPrevented || a.hasAttribute('download')) return;
      var href = a.getAttribute('href') || '';
      if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return;
      var local = localUrl(a.href);
      if (!local) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); return; }
      var sameOrigin = new URL(a.href).origin === location.origin;
      if (!sameOrigin || (a.target && a.target !== '_self')) { e.preventDefault(); location.href = local; }
    }, true);

    // Do not send real form data from the demo (search-style GET forms are fine)
    document.addEventListener('submit', function (e) {
      var f = e.target;
      if ((f.method || 'get').toLowerCase() === 'get') return;
      e.preventDefault();
      toast('Demo preview: this form was not sent.');
      post({ type: 'notice', text: 'Form submission is disabled in the demo preview.' });
    }, true);

    window.addEventListener('pagehide', function () { post({ type: 'unload' }); });
    window.addEventListener('message', function (e) {
      if (APP_ORIGIN !== '*' && e.origin !== APP_ORIGIN) return;
      var d = e.data;
      if (!d || !d.agentify || d.type !== 'cmd') return;
      run(d.cmd, d.args || {}).then(
        function (result) { post({ type: 'result', id: d.id, result: result }); },
        function (err) { post({ type: 'result', id: d.id, error: String(err && err.message || err) }); }
      );
    });
  }

  // ---- overlay: cursor, highlight, toast ----
  var overlay, cursor, styleEl;
  function ensureOverlay() {
    if (overlay && document.documentElement.contains(overlay)) return;
    styleEl = document.createElement('style');
    styleEl.textContent = [
      '#agentify-overlay{position:fixed;inset:0;pointer-events:none;z-index:2147483646}',
      '#agentify-overlay .ag-cursor{position:fixed;left:-60px;top:-60px;width:26px;height:26px;transition:left .7s cubic-bezier(.22,1,.36,1),top .7s cubic-bezier(.22,1,.36,1);filter:drop-shadow(0 2px 6px rgba(0,0,0,.35))}',
      '#agentify-overlay .ag-cursor.tap{animation:agTap .35s ease}',
      '@keyframes agTap{50%{transform:scale(.8)}}',
      '#agentify-overlay .ag-box{position:fixed;border:2.5px solid var(--ag-accent,#4f46e5);border-radius:10px;box-shadow:0 0 0 6px color-mix(in srgb,var(--ag-accent,#4f46e5) 22%,transparent),0 0 0 9999px rgba(15,18,40,.18);transition:all .35s ease;animation:agPulse 1.6s ease-in-out infinite}',
      '@keyframes agPulse{50%{box-shadow:0 0 0 12px color-mix(in srgb,var(--ag-accent,#4f46e5) 10%,transparent),0 0 0 9999px rgba(15,18,40,.18)}}',
      '#agentify-overlay .ag-note{position:fixed;max-width:260px;background:#111827;color:#fff;font:600 13px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;padding:8px 11px;border-radius:9px;box-shadow:0 8px 24px rgba(0,0,0,.25)}',
      '#agentify-overlay .ag-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#111827;color:#fff;font:500 13px system-ui,sans-serif;padding:10px 14px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25)}'
    ].join('\n');
    document.documentElement.appendChild(styleEl);
    overlay = document.createElement('div');
    overlay.id = 'agentify-overlay';
    overlay.innerHTML = '<svg class="ag-cursor" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.6-3.6 6.9z" fill="var(--ag-accent,#4f46e5)" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    document.documentElement.appendChild(overlay);
    cursor = overlay.querySelector('.ag-cursor');
  }
  function toast(text) {
    ensureOverlay();
    var t = document.createElement('div');
    t.className = 'ag-toast'; t.textContent = text;
    overlay.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  async function moveCursorTo(el) {
    ensureOverlay();
    var r = el.getBoundingClientRect();
    cursor.style.left = (r.left + Math.min(r.width / 2, 40)) + 'px';
    cursor.style.top = (r.top + r.height / 2) + 'px';
    await sleep(720);
  }
  function tap() { cursor.classList.remove('tap'); void cursor.offsetWidth; cursor.classList.add('tap'); }

  var activeHighlight = null;
  function clearHighlight() { if (activeHighlight) { activeHighlight.stop(); activeHighlight = null; } }
  function highlightEl(el, note, ms) {
    ensureOverlay(); clearHighlight();
    var box = document.createElement('div'); box.className = 'ag-box';
    overlay.appendChild(box);
    var tip = null;
    if (note) { tip = document.createElement('div'); tip.className = 'ag-note'; tip.textContent = note; overlay.appendChild(tip); }
    var alive = true;
    (function frame() {
      if (!alive) return;
      var r = el.getBoundingClientRect(), pad = 6;
      box.style.left = (r.left - pad) + 'px'; box.style.top = (r.top - pad) + 'px';
      box.style.width = (r.width + pad * 2) + 'px'; box.style.height = (r.height + pad * 2) + 'px';
      if (tip) {
        var below = r.bottom + 14 + 40 < innerHeight;
        tip.style.left = Math.max(8, Math.min(r.left, innerWidth - 270)) + 'px';
        tip.style.top = (below ? r.bottom + 14 : Math.max(8, r.top - 50)) + 'px';
      }
      requestAnimationFrame(frame);
    })();
    var h = { stop: function () { alive = false; box.remove(); if (tip) tip.remove(); } };
    activeHighlight = h;
    setTimeout(function () { if (activeHighlight === h) clearHighlight(); }, ms || 6000);
  }

  // ---- page snapshot ----
  var nextId = 1;
  var SELECTOR = 'a[href],button,label,h1,h2,h3,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=switch],[onclick],[contenteditable=true]';
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }
  function labelOf(el) {
    var t = el.getAttribute('aria-label') || '';
    if (!t && el.labels && el.labels[0]) t = el.labels[0].innerText;
    if (!t && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) t = el.getAttribute('placeholder') || el.getAttribute('name') || '';
    if (!t) t = el.innerText || el.value || el.getAttribute('title') || '';
    if (!t) { var img = el.querySelector && el.querySelector('img[alt]'); if (img) t = img.alt; }
    return String(t).replace(/\s+/g, ' ').trim().slice(0, 80);
  }
  function isOurs(el) { return el.closest('#agentify-overlay,#agentify-widget'); }
  function byId(id) { return document.querySelector('[data-agentify-id="' + Number(id) + '"]'); }

  function snapshot() {
    var vh = innerHeight, seen = {}, items = [];
    var els = document.querySelectorAll(SELECTOR);
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (isOurs(el) || !visible(el)) continue;
      var label = labelOf(el);
      var tag = el.tagName.toLowerCase();
      var href = tag === 'a' ? logicalUrl(el.href) : undefined;
      if (!label && !href && !/^(input|textarea|select)$/.test(tag)) continue;
      var key = tag + '|' + label + '|' + (href || '');
      if (seen[key]) continue;
      seen[key] = 1;
      var id = el.getAttribute('data-agentify-id');
      if (!id) { id = String(nextId++); el.setAttribute('data-agentify-id', id); }
      var r = el.getBoundingClientRect();
      var item = { id: Number(id), tag: tag, text: label };
      var role = el.getAttribute('role'); if (role) item.role = role;
      if (href) item.href = href;
      if (/^(input|textarea|select)$/.test(tag)) {
        item.type = el.type || tag;
        if (el.name) item.name = el.name;
        if (el.value && item.type !== 'password') item.value = String(el.value).slice(0, 60);
        if (el.required) item.required = true;
        if (tag === 'select') item.options = Array.prototype.slice.call(el.options, 0, 15).map(function (o) { return o.text.trim(); });
      }
      item.inView = r.bottom > 0 && r.top < vh;
      items.push(item);
    }
    items.sort(function (a, b) { return (b.inView - a.inView); });
    // One compact line per element reads far better for the model than nested JSON
    var lines = items.slice(0, 120).map(function (it) {
      var s = '[' + it.id + '] ' + (it.role || it.tag) + (it.type && it.type !== it.tag ? ':' + it.type : '') + ' "' + it.text + '"';
      if (it.href) { try { var hu = new URL(it.href); s += ' -> ' + (bare(hu.hostname) === SITE_HOST ? hu.pathname + hu.search : hu.href); } catch (e) { /* skip */ } }
      if (it.value) s += ' value="' + it.value + '"';
      if (it.required) s += ' required';
      if (it.options) s += ' options: ' + it.options.join(' | ');
      if (!it.inView) s += ' (below the fold)';
      return s;
    });
    var root = document.querySelector('main,[role=main]') || document.body;
    var text = (root.innerText || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    var headings = Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3'), 0, 30)
      .map(function (h) { return h.innerText.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
    var maxScroll = Math.max(1, document.documentElement.scrollHeight - vh);
    return {
      url: logicalUrl(), title: document.title,
      scrolled: Math.round(Math.min(1, scrollY / maxScroll) * 100) + '%',
      headings: headings, text: text.slice(0, 3500), elements: lines,
    };
  }

  // ---- actions ----
  function words(s) { return String(s || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || []; }
  function overlap(a, b) {
    var wa = words(a), wb = words(b);
    if (!wa.length || !wb.length) return 0;
    var hit = wb.filter(function (w) { return wa.indexOf(w) >= 0; }).length;
    return hit / wb.length;
  }
  // Resolve by id, but if the model's label clearly doesn't match that element,
  // fall back to the visible element whose text matches the label best.
  function need(id, label) {
    var el = byId(id);
    if (label && (!el || overlap(labelOf(el), label) < 0.5)) {
      var best = null, bestScore = 0;
      var els = document.querySelectorAll(SELECTOR + ',label,h1,h2,h3,h4,[class*=plan],[class*=card]');
      for (var i = 0; i < els.length; i++) {
        var c = els[i];
        if (isOurs(c) || !visible(c)) continue;
        var t = labelOf(c);
        var sc = overlap(t, label) - Math.min(t.length, 400) / 4000;
        if (sc > bestScore) { bestScore = sc; best = c; }
      }
      if (best && bestScore >= 0.5) el = best;
    }
    if (!el) throw new Error('Element ' + id + ' is not on the page any more. Call read_current_page for fresh ids.');
    return el;
  }
  async function focusOn(el) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(450);
    await moveCursorTo(el);
  }
  function setValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // Fields the agent must never fill: the visitor types these themselves.
  var SENSITIVE_FIELD = /\b(password|passwd|passcode|otp|one[-\s]?time|verification code|security code|cvv|cvc|card\s*(number|no\.?|num)|credit\s*card|debit\s*card|expiry|expiration|ssn|social security|aadha?ar|pan\s*(number|card|no\.?)|passport|iban|swift|routing|account\s*(number|no\.?)|upi\s*pin|atm\s*pin|mpin)\b/i;
  function isSensitiveField(el) {
    if (el.type === 'password') return true;
    var ac = String(el.autocomplete || el.getAttribute('autocomplete') || '');
    if (/^(cc-|one-time-code)/.test(ac)) return true;
    return SENSITIVE_FIELD.test([el.name, el.id, el.placeholder, el.getAttribute('aria-label'), labelOf(el)].join(' '));
  }

  var actions = {
    snapshot: function () { return snapshot(); },
    click: async function (a) {
      var el = need(a.element_id, a.label);
      var label = labelOf(el);
      await focusOn(el); tap();
      highlightEl(el, null, 900);
      await sleep(250);
      if (IN_PROXY && el.tagName === 'A' && el.href) {
        var local = localUrl(el.href);
        if (!local) return { ok: false, error: 'That link leaves this website, so I opened it in a new tab.', opened: window.open(el.href, '_blank', 'noopener') && true };
      }
      el.click();
      return { ok: true, clicked: label };
    },
    fill: async function (a) {
      var el = need(a.element_id, a.label);
      if (isSensitiveField(el)) return { ok: false, error: 'That field holds a password, one-time code or payment detail, so the visitor must type it themselves.' };
      var value = String(a.value == null ? '' : a.value);
      await focusOn(el); tap();
      el.focus();
      if (el.tagName === 'SELECT') {
        var opt = Array.prototype.find.call(el.options, function (o) { return o.value === value || o.text.trim().toLowerCase() === value.toLowerCase(); }) ||
          Array.prototype.find.call(el.options, function (o) { return o.text.toLowerCase().indexOf(value.toLowerCase()) >= 0; });
        if (!opt) return { ok: false, error: 'No option matches "' + value + '"', options: Array.prototype.map.call(el.options, function (o) { return o.text.trim(); }) };
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, selected: opt.text.trim() };
      }
      if (el.type === 'checkbox' || el.type === 'radio') {
        var want = !/^(false|no|0|off|uncheck)$/i.test(value);
        if (el.checked !== want) el.click();
        return { ok: true, checked: el.checked };
      }
      if (el.isContentEditable) { el.textContent = value; el.dispatchEvent(new Event('input', { bubbles: true })); return { ok: true }; }
      setValue(el, '');
      if (value.length <= 60) {
        for (var i = 1; i <= value.length; i++) { setValue(el, value.slice(0, i)); await sleep(22); }
      } else setValue(el, value);
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, field: labelOf(el), value: el.type === 'password' ? '••••' : value };
    },
    highlight: async function (a) {
      var el = need(a.element_id, a.label);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(500);
      highlightEl(el, a.note, 7000);
      moveCursorTo(el);
      return { ok: true, highlighted: labelOf(el) };
    },
    scroll: async function (a) {
      var d = a.direction || 'down';
      if (d === 'top') scrollTo({ top: 0, behavior: 'smooth' });
      else if (d === 'bottom') scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' });
      else scrollBy({ top: (d === 'up' ? -1 : 1) * innerHeight * 0.8, behavior: 'smooth' });
      await sleep(600);
      return { ok: true, scrolled: Math.round(scrollY) };
    },
    navigate: function (a) {
      var local = localUrl(a.url);
      if (!local) return { ok: false, error: 'That URL is not part of this website.' };
      setTimeout(function () { location.href = local; }, 50);
      return { ok: true, navigating: logicalUrl(local) };
    },
    back: function () { setTimeout(function () { history.back(); }, 50); return { ok: true }; },
    ping: function () { return { url: logicalUrl(), title: document.title }; },
  };

  function run(cmd, args) {
    var fn = actions[cmd];
    if (!fn) return Promise.reject(new Error('Unknown command ' + cmd));
    try { return Promise.resolve(fn(args)); } catch (e) { return Promise.reject(e); }
  }

  window.__agentifyBridge = { run: run, snapshot: snapshot, logicalUrl: logicalUrl, localUrl: localUrl, toast: toast, mode: MODE };

  function announce() { post({ type: 'ready', url: logicalUrl(), title: document.title }); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announce);
  else announce();
  window.addEventListener('load', announce);
})();
