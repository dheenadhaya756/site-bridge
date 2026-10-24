// Preview shell: the customer's live website (served through the preview proxy) with the
// Site Bridge agent already living inside it. This page only provides a thin address bar.
(async function () {
  const siteId = location.pathname.split('/').filter(Boolean).pop();
  const frame = document.getElementById('site');
  const urlInput = document.getElementById('url');
  const loading = document.getElementById('loading');
  const toastEl = document.getElementById('toast');

  const onDemoHost = location.pathname.startsWith('/__sb/');
  const apiBase = onDemoHost ? '/__sb' : '';
  // The demo pass arrives in the address (#sbpass=…) from Site Bridge; keep it for reloads and the chat
  let pass = '';
  try {
    const h = new URLSearchParams(location.hash.slice(1)).get('sbpass');
    if (h) { localStorage.setItem('sb:pass:' + siteId, h); localStorage.setItem('sb:pass', h); history.replaceState(null, '', location.pathname + location.search); }
    pass = localStorage.getItem('sb:pass:' + siteId) || '';
    if (pass) localStorage.setItem('sb:pass', pass);
  } catch (e) { /* storage blocked */ }
  const openP = onDemoHost ? fetch(`/__sb/open/${siteId}?pass=${encodeURIComponent(pass)}`, { credentials: 'same-origin', headers: { 'x-sb-visitor': (function () { try { return localStorage.getItem('sb:visitor') || ''; } catch (e) { return ''; } })() } }).catch(() => {}) : null;
  const cfg = await fetch(`${apiBase}/api/sites/${siteId}/public`).then(r => (r.ok ? r.json() : null));
  // Tell the demo host which client site to show in this browser
  function sbVisitor() { try { var v = localStorage.getItem('sb:visitor'); if (!v) { v = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); localStorage.setItem('sb:visitor', v); } return v; } catch (e) { return ''; } }
  if (openP) {
    const opened = await openP;
    if (!opened || opened.status === 403) {
      const app = (cfg && cfg.appUrl ? cfg.appUrl : '').replace(/\/$/, '');
      document.querySelector('.frame-wrap').innerHTML = `<div style="max-width:520px;margin:80px auto;padding:0 20px;font:15px/1.6 'Inter Tight',system-ui,sans-serif;color:#0b0c10">
        <h2 style="font-weight:400;font-size:26px;margin:0 0 10px">Open this live demo from Site Bridge</h2>
        <p style="color:#4b4f5c;margin:0 0 18px">Live demos open from your Site Bridge account. Sign in, then click <b>Open Live Demo</b> on this site's results.</p>
        <a href="${app}/sites/${encodeURIComponent(siteId)}" style="display:inline-block;padding:10px 16px;background:#0b0c10;color:#fff;text-decoration:none;font-size:12px;letter-spacing:.06em;text-transform:uppercase">Go to Site Bridge</a></div>`;
      return;
    }
  }
  if (!cfg) { document.body.innerHTML = '<p style="padding:40px">This site hasn&#39;t been scanned yet. <a href="/">Go back</a></p>'; return; }
  document.title = `${cfg.name} · Live agent preview`;
  // Site Bridge home and this site's results live on the main app, not on the demo address
  const app = (cfg.appUrl || '').replace(/\/$/, '');
  document.getElementById('home').href = `${app}/`;
  document.getElementById('results').href = `${app}/sites/${encodeURIComponent(siteId)}`;
  if (!cfg.previewOrigin) {
    // Hosted without a wildcard preview domain: the agent still works through the embed and MCP
    document.querySelector('.frame-wrap').innerHTML = `<div style="max-width:560px;margin:80px auto;padding:0 20px;font:15px/1.6 'Inter Tight',system-ui,sans-serif;color:#0b0c10">
      <h2 style="font-weight:400;font-size:26px;margin:0 0 10px">The live demo runs on a preview domain</h2>
      <p style="color:#4b4f5c;margin:0 0 18px">This hosted copy doesn't have one set up yet, so the website can't be shown here with its agent. The knowledge base, MCP server and embed code for <b>${cfg.name.replace(/[<>&]/g, '')}</b> are ready.</p>
      <a href="/sites/${encodeURIComponent(siteId)}" style="display:inline-block;padding:10px 16px;background:#0b0c10;color:#fff;text-decoration:none;font-size:12px;letter-spacing:.06em;text-transform:uppercase">Back to the results</a></div>`;
    document.getElementById('loading')?.remove();
    return;
  }
  const previewOrigin = cfg.previewOrigin;
  const siteHost = new URL(cfg.origin).hostname.replace(/^www\./, '');
  let current = cfg.startUrl;

  function toPreview(url) {
    let u;
    try { u = new URL(url, cfg.origin); } catch { return null; }
    if (u.origin === previewOrigin) return u.href;
    if (u.hostname.replace(/^www\./, '') !== siteHost) return null;
    return previewOrigin + u.pathname + u.search + u.hash;
  }
  function toast(text) {
    toastEl.textContent = text; toastEl.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { toastEl.hidden = true; }, 3000);
  }
  function open(url) {
    const local = toPreview(url);
    if (!local) return false;
    loading.classList.remove('hide');
    frame.src = local;
    return true;
  }

  // The in-page bridge reports page loads and route changes so the address bar stays in sync
  window.addEventListener('message', e => {
    if (e.source !== frame.contentWindow || e.origin !== previewOrigin) return;
    const d = e.data;
    if (!d || !d.agentify) return;
    if (d.type === 'ready' || d.type === 'urlchange') {
      current = d.url;
      if (document.activeElement !== urlInput) urlInput.value = d.url;
      document.getElementById('share').href = toPreview(d.url);
      loading.classList.add('hide');
    } else if (d.type === 'notice') toast(d.text);
  });

  document.getElementById('addr').addEventListener('submit', e => {
    e.preventDefault();
    if (!open(urlInput.value.trim())) toast('Only pages of this website can be opened here.');
    urlInput.blur();
  });
  document.getElementById('reload').addEventListener('click', () => open(current));
  document.getElementById('back').addEventListener('click', () => frame.contentWindow.postMessage({ agentify: true, type: 'cmd', id: 0, cmd: 'back' }, previewOrigin));

  urlInput.value = cfg.startUrl;
  document.getElementById('share').href = toPreview(cfg.startUrl);
  open(cfg.startUrl);
  frame.addEventListener('load', () => setTimeout(() => loading.classList.add('hide'), 300));
})();
