/* Chat panel + agent loop (white-label). Used by widget.js inside the customer's site.
 * Agentify.mountChat(hostEl, { apiBase, siteId, exec, getContext, unloadsOnNavigate, onLinkClick, accent, onAccent, font, onConfig }) */
(function () {
  if (window.Agentify && window.Agentify.mountChat) return;

  var CSS = [
    ':host{all:initial;display:block;height:100%}',
    '*{box-sizing:border-box}',
    '.ag{--accent:#2238f5;--on-accent:#fff;--ink:#0d0f1a;--muted:#4b5163;height:100%;display:flex;flex-direction:column;color:var(--ink);font:14px/1.5 var(--font,"Inter Tight"),"Inter Tight",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:transparent}',
    'header{display:flex;align-items:center;gap:10px;padding:14px 12px 12px 16px;border-bottom:1px solid rgba(15,23,42,.07)}',
    '.orb{position:relative;width:34px;height:34px;border-radius:50%;flex:none;display:grid;place-items:center;color:var(--on-accent);background:radial-gradient(circle at 32% 28%,color-mix(in srgb,var(--accent) 55%,#fff) 0%,var(--accent) 55%,color-mix(in srgb,var(--accent) 70%,#000) 100%);box-shadow:inset 0 1px 2px rgba(255,255,255,.6),0 4px 12px rgba(15,23,42,.18)}',
    '.orb::after{content:"";position:absolute;right:-1px;bottom:-1px;width:10px;height:10px;border-radius:50%;background:#22c55e;border:2px solid #fff}',
    '.orb.off::after{background:#f59e0b}',
    '.title{flex:1;min-width:0}',
    '.name{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-.01em}',
    '.st{font-size:11.5px;color:var(--muted)}',
    '.icon-btn{border:0;background:rgba(255,255,255,.5);color:var(--muted);width:30px;height:30px;border-radius:50%;cursor:pointer;display:grid;place-items:center;transition:background .2s,color .2s}',
    '.icon-btn:hover{background:rgba(255,255,255,.9);color:var(--ink)}',
    '.msgs{flex:1;overflow-y:auto;padding:14px 12px 6px;display:flex;flex-direction:column;gap:8px;scrollbar-width:thin;scrollbar-color:rgba(15,23,42,.18) transparent}',
    '.msg{max-width:86%;padding:9px 12px;border-radius:16px;word-wrap:break-word;font-size:13.5px;animation:pop .25s cubic-bezier(.22,1,.36,1)}',
    '@keyframes pop{from{opacity:0;transform:translateY(4px)}}',
    '.msg p{margin:0 0 5px}.msg p:last-child{margin:0}',
    '.msg ul{margin:3px 0 5px;padding-left:17px}.msg li{margin:2px 0}',
    '.msg a{color:var(--accent);font-weight:600;text-decoration:underline;text-underline-offset:2px;text-decoration-thickness:1px}',
    '.msg code{background:rgba(15,23,42,.06);padding:1px 5px;border-radius:5px;font-size:12.5px}',
    '.agent{align-self:flex-start;background:#fff;border:1px solid rgba(15,23,42,.07);border-bottom-left-radius:5px;box-shadow:0 1px 2px rgba(15,23,42,.05)}',
    '.user{align-self:flex-end;background:var(--accent);color:var(--on-accent);border-bottom-right-radius:5px}',
    '.user a{color:inherit}',
    '.error{align-self:stretch;background:rgba(254,242,242,.9);color:#991b1b;font-size:12.5px}',
    '.step{align-self:flex-start;display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);padding:3px 9px 3px 6px;background:rgba(255,255,255,.55);border-radius:999px}',
    '.step .ic{width:14px;height:14px;flex:none;display:grid;place-items:center}',
    '.step.done .ic{color:#15803d}.step.failed .ic{color:#dc2626}',
    '.spin{width:10px;height:10px;border:2px solid rgba(15,23,42,.15);border-top-color:var(--accent);border-radius:50%;animation:sp .7s linear infinite}',
    '@keyframes sp{to{transform:rotate(360deg)}}',
    '.typing{align-self:flex-start;display:flex;gap:4px;padding:11px 13px;background:rgba(255,255,255,.82);border-radius:16px;border-bottom-left-radius:5px}',
    '.typing i{width:6px;height:6px;border-radius:50%;background:var(--accent);opacity:.5;animation:bl 1.2s infinite}',
    '.typing i:nth-child(2){animation-delay:.15s}.typing i:nth-child(3){animation-delay:.3s}',
    '@keyframes bl{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:.9;transform:translateY(-3px)}}',
    '.sugg{display:flex;flex-wrap:wrap;gap:6px;padding:2px 12px 8px}',
    '.chip{border:1px solid rgba(255,255,255,.9);background:rgba(255,255,255,.6);color:var(--ink);border-radius:999px;padding:5px 11px;font:inherit;font-size:12px;cursor:pointer;transition:background .2s,border-color .2s}',
    '.chip:hover{background:#fff;border-color:var(--accent)}',
    'form{display:flex;align-items:flex-end;gap:6px;margin:4px 10px 10px;padding:5px 5px 5px 14px;border-radius:22px;background:#fff;border:1px solid rgba(15,23,42,.1);box-shadow:0 2px 10px rgba(15,23,42,.06);transition:box-shadow .2s}',
    'form:focus-within{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 22%,transparent)}',
    'textarea{flex:1;border:0;outline:0;resize:none;font:inherit;font-size:13.5px;color:var(--ink);background:transparent;max-height:96px;padding:6px 0}',
    'textarea::placeholder{color:#6b7080}',
    '.send{width:32px;height:32px;border-radius:50%;border:0;background:var(--accent);color:var(--on-accent);cursor:pointer;display:grid;place-items:center;flex:none;transition:transform .15s}',
    '.send:hover{transform:scale(1.06)}',
    '.send:disabled{opacity:.45;cursor:default;transform:none}',
    '.lang{height:30px;max-width:92px;border:0;border-radius:999px;background:rgba(15,23,42,.05);color:var(--muted);font:inherit;font-size:12px;padding:0 8px;cursor:pointer;outline:0}',
    '.lang:focus-visible,.icon-btn:focus-visible,.mic:focus-visible{box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 30%,transparent)}',
    '.icon-btn.on{background:var(--accent);color:var(--on-accent)}',
    '.mic{width:32px;height:32px;border-radius:50%;border:0;background:transparent;color:var(--muted);cursor:pointer;display:grid;place-items:center;flex:none;transition:background .2s,color .2s}',
    '.mic:hover{background:rgba(15,23,42,.06);color:var(--ink)}',
    '.mic.rec{background:#ef4444;color:#fff;animation:recp 1.2s ease-in-out infinite}',
    '@keyframes recp{50%{box-shadow:0 0 0 6px rgba(239,68,68,.18)}}',
    '.mic[hidden],.speak[hidden]{display:none}'
  ].join('\n');

  var ICON = {
    send: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    reset: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
    mic: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>',
    speaker: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    x: '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    agent: '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l1.7 5.1 5.1 1.7-5.1 1.7L12 16.1l-1.7-5.1-5.1-1.7 5.1-1.7z"/><path d="M18.5 14.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" opacity=".8"/></svg>'
  };

  // [speech/recognition code, label shown, name sent to the agent]
  var LANGS = [
    ['auto', 'Auto', ''], ['en-IN', 'English', 'English'], ['hi-IN', 'हिन्दी', 'Hindi'], ['ta-IN', 'தமிழ்', 'Tamil'],
    ['te-IN', 'తెలుగు', 'Telugu'], ['kn-IN', 'ಕನ್ನಡ', 'Kannada'], ['ml-IN', 'മലയാളം', 'Malayalam'], ['bn-IN', 'বাংলা', 'Bengali'],
    ['mr-IN', 'मराठी', 'Marathi'], ['gu-IN', 'ગુજરાતી', 'Gujarati'], ['pa-IN', 'ਪੰਜਾਬੀ', 'Punjabi'], ['ur-IN', 'اردو', 'Urdu'],
    ['es-ES', 'Español', 'Spanish'], ['fr-FR', 'Français', 'French'], ['de-DE', 'Deutsch', 'German'], ['ar-SA', 'العربية', 'Arabic'],
    ['zh-CN', '中文', 'Chinese'], ['ja-JP', '日本語', 'Japanese'],
  ];

  function sbVisitor() { try { var v = localStorage.getItem('sb:visitor'); if (!v) { v = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); localStorage.setItem('sb:visitor', v); } return v; } catch (e) { return ''; } }

  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function inline(s) {
    return s
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function md(src) {
    var out = [], list = false;
    esc(src).split('\n').forEach(function (line) {
      var m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
      if (m) { if (!list) { out.push('<ul>'); list = true; } out.push('<li>' + inline(m[1]) + '</li>'); return; }
      if (list) { out.push('</ul>'); list = false; }
      if (line.trim()) out.push('<p>' + inline(line) + '</p>');
    });
    if (list) out.push('</ul>');
    return out.join('');
  }
  function shortUrl(u) { try { var x = new URL(u, 'https://x.invalid'); return (x.pathname + x.search) || '/'; } catch (e) { return u; } }
  function q(s) { return s ? '“' + String(s).slice(0, 34) + '”' : ''; }
  function stepLabel(s) {
    var a = s.args || {};
    switch (s.name) {
      case 'search_site': return 'Searching ' + q(a.query);
      case 'escalate_to_support': return 'Passing this to the support team';
      case 'get_page_content': return 'Reading ' + shortUrl(a.url);
      case 'read_current_page': return 'Looking at this page';
      case 'navigate': return 'Opening ' + shortUrl(a.url);
      case 'click': return 'Clicking ' + (q(a.label) || 'the element');
      case 'fill': return 'Typing into ' + (q(a.label) || 'a field');
      case 'highlight': return 'Pointing at ' + (q(a.label) || 'it');
      case 'scroll': return 'Scrolling ' + (a.direction || '');
      case 'go_back': return 'Going back';
      default: return 'Working';
    }
  }
  function toPart(s) {
    var r = s.response;
    var response = r && typeof r === 'object' && !Array.isArray(r) ? r : { result: r === undefined ? null : r };
    var fr = { name: s.name, response: response };
    if (s.id) fr.id = s.id;
    return { functionResponse: fr };
  }
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function usableAccent(hex) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return false;
    var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    var rgb = [0, 2, 4].map(function (i) { var v = parseInt(h.substr(i, 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    var lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    return lum > 0.02 && lum < 0.3;
  }

  function mountChat(host, opts) {
    var api = (opts.apiBase || '').replace(/\/$/, '');
    var key = 'agentify:' + opts.siteId;
    var root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + CSS + '</style>' +
      '<div class="ag"><header><div class="orb">' + ICON.agent + '</div><div class="title"><div class="name">Assistant</div>' +
      '<div class="st">AI Agent · Online</div></div>' +
      '<select class="lang" aria-label="Reply language" title="Reply language">' + LANGS.map(function (l) { return '<option value="' + l[0] + '">' + l[1] + '</option>'; }).join('') + '</select>' +
      '<button class="icon-btn speak" type="button" title="Read replies aloud" aria-label="Read replies aloud" aria-pressed="false">' + ICON.speaker + '</button>' +
      '<button class="icon-btn reset" title="New conversation" aria-label="New conversation">' + ICON.reset + '</button>' +
      (opts.onClose ? '<button class="icon-btn close" title="Close" aria-label="Close assistant">' + ICON.close + '</button>' : '') +
      '</header><div class="msgs" role="log" aria-live="polite"></div><div class="sugg"></div>' +
      '<form><textarea rows="1" placeholder="Ask me anything…" aria-label="Message"></textarea><button class="mic" type="button" aria-label="Speak your message" title="Speak your message">' + ICON.mic + '</button><button class="send" type="submit" aria-label="Send">' + ICON.send + '</button></form></div>';

    var $ = function (s) { return root.querySelector(s); };
    var shell = $('.ag'), msgs = $('.msgs'), sugg = $('.sugg'), form = $('form'), input = $('textarea'), sendBtn = $('.send');
    if (opts.accent) { shell.style.setProperty('--accent', opts.accent); shell.style.setProperty('--on-accent', opts.onAccent || '#fff'); }
    if (opts.font) shell.style.setProperty('--font', opts.font);
    var cfg = { name: 'Assistant', greeting: 'Hi! How can I help?', suggestions: [] };
    var state = load() || { contents: [], log: [], resume: null, token: null };
    var busy = false, unloading = false;
    window.addEventListener('pagehide', function () { unloading = true; });
    window.addEventListener('beforeunload', function () { unloading = true; });

    function load() { try { return JSON.parse(sessionStorage.getItem(key)); } catch (e) { return null; } }
    function save() { try { sessionStorage.setItem(key, JSON.stringify(state)); } catch (e) { /* storage full or blocked */ } }

    function render() {
      var html = '<div class="msg agent">' + md(cfg.greeting || '') + '</div>';
      state.log.forEach(function (e) {
        if (e.kind === 'step') {
          html += '<div class="step ' + (e.failed ? 'failed' : e.done ? 'done' : '') + '"><span class="ic">' +
            (e.failed ? ICON.x : e.done ? ICON.check : '<span class="spin"></span>') + '</span>' + esc(e.text) + '</div>';
        } else html += '<div class="msg ' + e.kind + '">' + (e.kind === 'user' ? esc(e.text) : md(e.text)) + '</div>';
      });
      var last = state.log[state.log.length - 1];
      if (busy && !(last && last.kind === 'step' && !last.done)) html += '<div class="typing"><i></i><i></i><i></i></div>';
      msgs.innerHTML = html;
      msgs.scrollTop = msgs.scrollHeight;
      var fresh = !state.log.some(function (e) { return e.kind === 'user'; });
      sugg.innerHTML = fresh ? (cfg.suggestions || []).slice(0, 3).map(function (s) { return '<button class="chip" type="button">' + esc(s) + '</button>'; }).join('') : '';
      sendBtn.disabled = busy;
    }

    function setBusy(b) { busy = b; render(); }

    async function post(path, body) {
      var pass = ''; try { pass = localStorage.getItem('sb:pass') || ''; } catch (e) { /* blocked */ }
      var res = await fetch(api + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-sb-visitor': sbVisitor(), 'x-sb-pass': pass }, body: JSON.stringify(body) });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        // The server could not trust this conversation any more: start a fresh one
        if (data.reset) state = { contents: [], log: [], resume: null, token: null };
        throw new Error(data.error || 'Sorry, I couldn’t answer that just now. Please try again.');
      }
      return data;
    }

    async function context() {
      try { return (await opts.getContext()) || {}; } catch (e) { return {}; }
    }

    async function runPending(slots) {
      for (var i = 0; i < slots.length; i++) {
        var s = slots[i];
        if (!s.client || s.response !== undefined) continue;
        var entry = { kind: 'step', text: stepLabel(s), done: false };
        state.log.push(entry); render();
        var leaves = s.name === 'navigate' || s.name === 'go_back';
        if (opts.unloadsOnNavigate) { state.resume = { slots: slots, index: i }; save(); }
        try { s.response = await opts.exec(s.name, s.args || {}); }
        catch (e) { s.response = { ok: false, error: e.message }; }
        if (opts.unloadsOnNavigate) {
          if (leaves && s.response && s.response.ok !== false) { delete s.response; return true; }
          await sleep(700);
          if (unloading) { delete s.response; return true; }
          state.resume = null;
        }
        entry.done = true;
        if (s.response && s.response.ok === false) entry.failed = true;
        render(); save();
      }
      state.contents.push({ role: 'user', parts: slots.map(toPart) });
      save();
      return false;
    }

    async function loop() {
      setBusy(true);
      try {
        for (var guard = 0; guard < 12; guard++) {
          var ctx = await context();
          var data = await post('/api/chat', { siteId: opts.siteId, contents: state.contents, token: state.token || null, currentUrl: ctx.url, title: ctx.title, lang: langName() });
          state.contents = data.contents;
          state.token = data.token || null;
          (data.steps || []).forEach(function (s) { state.log.push({ kind: 'step', text: stepLabel(s), done: true }); });
          if (data.reply) { state.log.push({ kind: 'agent', text: data.reply }); speak(data.reply); }
          render(); save();
          if (!data.pending) break;
          if (await runPending(data.pending)) return;
        }
      } catch (e) {
        state.log.push({ kind: 'error', text: e.message });
      } finally {
        busy = false; save(); render();
        // When the agent is done, put the cursor back in the chat box so the visitor can keep typing
        if (!unloading && window.matchMedia && matchMedia('(pointer: fine)').matches) {
          try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
        }
      }
    }

    async function resume() {
      var r = state.resume;
      state.resume = null;
      var s = r.slots[r.index];
      var snap = null;
      try { snap = await opts.exec('read_current_page', {}); } catch (e) { /* page not ready */ }
      s.response = { ok: true, page: snap };
      for (var i = state.log.length - 1; i >= 0; i--) if (state.log[i].kind === 'step') { state.log[i].done = true; break; }
      setBusy(true);
      if (!(await runPending(r.slots))) await loop();
    }

    async function send(text) {
      text = String(text || '').trim();
      if (!text || busy) return;
      state.log.push({ kind: 'user', text: text });
      state.contents.push({ role: 'user', parts: [{ text: text }] });
      save();
      await loop();
    }

    function reset() { state = { contents: [], log: [], resume: null, token: null }; save(); render(); input.focus(); }

    form.addEventListener('submit', function (e) { e.preventDefault(); var t = input.value; input.value = ''; input.style.height = ''; send(t); });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
    input.addEventListener('input', function () { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 96) + 'px'; });
    sugg.addEventListener('click', function (e) { var b = e.target.closest('.chip'); if (b) send(b.textContent); });
    $('.reset').addEventListener('click', reset);

    // ---- language, voice input and read-aloud ----
    var prefKey = 'agentify:prefs';
    var prefs = (function () { try { return JSON.parse(localStorage.getItem(prefKey)) || {}; } catch (e) { return {}; } })();
    function savePrefs() { try { localStorage.setItem(prefKey, JSON.stringify(prefs)); } catch (e) { /* blocked */ } }
    var langSel = $('.lang'), speakBtn = $('.speak'), micBtn = $('.mic');
    langSel.value = prefs.lang && LANGS.some(function (l) { return l[0] === prefs.lang; }) ? prefs.lang : 'auto';
    function langCode() { return langSel.value === 'auto' ? (navigator.language || 'en-IN') : langSel.value; }
    function langName() { var l = LANGS.find(function (x) { return x[0] === langSel.value; }); return l && l[0] !== 'auto' ? l[2] : ''; }
    langSel.addEventListener('change', function () { prefs.lang = langSel.value; savePrefs(); });

    var canSpeak = 'speechSynthesis' in window;
    speakBtn.hidden = !canSpeak;
    function setSpeak(on) { prefs.speak = on; savePrefs(); speakBtn.classList.toggle('on', on); speakBtn.setAttribute('aria-pressed', String(on)); if (!on && canSpeak) speechSynthesis.cancel(); }
    setSpeak(Boolean(prefs.speak) && canSpeak);
    speakBtn.addEventListener('click', function () { setSpeak(!prefs.speak); });
    function speak(text) {
      if (!canSpeak || !prefs.speak) return;
      var plain = String(text).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/https?:\/\/\S+/g, '').replace(/[*_`#>]/g, '').trim();
      if (!plain) return;
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(plain);
      var code = langCode();
      u.lang = code;
      var voice = speechSynthesis.getVoices().find(function (v) { return v.lang && v.lang.toLowerCase().indexOf(code.toLowerCase().slice(0, 2)) === 0; });
      if (voice) u.voice = voice;
      speechSynthesis.speak(u);
    }

    var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
    micBtn.hidden = !Rec;
    var rec = null;
    micBtn.addEventListener('click', function () {
      if (rec) { rec.stop(); return; }
      if (busy) return;
      if (canSpeak) speechSynthesis.cancel();
      rec = new Rec();
      rec.lang = langCode();
      rec.interimResults = true;
      rec.continuous = false;
      var finalText = '';
      micBtn.classList.add('rec'); micBtn.setAttribute('aria-label', 'Stop listening');
      rec.onresult = function (ev) {
        var interim = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript; else interim += ev.results[i][0].transcript;
        }
        input.value = (finalText + interim).trim();
      };
      rec.onerror = function () { /* no permission or no speech: leave the text box as it is */ };
      rec.onend = function () {
        micBtn.classList.remove('rec'); micBtn.setAttribute('aria-label', 'Speak your message');
        rec = null;
        var t = input.value.trim();
        if (finalText.trim() && t) { input.value = ''; send(t); }
      };
      try { rec.start(); } catch (e) { rec = null; micBtn.classList.remove('rec'); }
    });
    if (opts.onClose) $('.close').addEventListener('click', function () { opts.onClose(); });
    msgs.addEventListener('click', function (e) {
      var a = e.target.closest('a[href]');
      if (a && opts.onLinkClick && opts.onLinkClick(a.href)) e.preventDefault();
    });

    render();
    (opts.configPromise || fetch(api + '/api/sites/' + opts.siteId + '/public').then(function (r) { return r.json(); })).then(function (c) {
      cfg = c;
      $('.name').textContent = c.name || 'Assistant';
      if (!opts.accent && usableAccent(c.themeColor)) shell.style.setProperty('--accent', c.themeColor);
      if (!c.ai) { $('.st').textContent = 'AI Agent · Offline'; $('.orb').classList.add('off'); }
      if (opts.onConfig) opts.onConfig(c);
      render();
      if (state.resume) resume();
    }).catch(function () { if (state.resume) resume(); });

    return { send: send, reset: reset, focus: function () { input.focus(); }, root: root };
  }

  window.Agentify = Object.assign(window.Agentify || {}, { mountChat: mountChat });
})();
