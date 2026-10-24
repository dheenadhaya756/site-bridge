// Site Bridge builder UI: paste a URL -> live crawl progress -> results with demo, MCP and embed.
(function () {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const STAGES = ['crawl', 'understand', 'tools', 'done'];
  function sbVisitor() { try { var v = localStorage.getItem('sb:visitor'); if (!v) { v = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); localStorage.setItem('sb:visitor', v); } return v; } catch (e) { return ''; } }
  const vh = { 'x-sb-visitor': sbVisitor() };
  // Count one home-page visit per browser session
  try { if (!sessionStorage.getItem('sb:visited')) { sessionStorage.setItem('sb:visited', '1'); fetch('/api/track', { method: 'POST', headers: { 'content-type': 'application/json', ...vh }, body: JSON.stringify({ kind: 'visit' }), keepalive: true }).catch(() => {}); } } catch (e) { /* storage blocked */ }

  // ---------- status ----------
  fetch('/api/status').then(r => r.json()).then(s => {
    const el = $('#ai-status');
    el.textContent = s.ai ? 'AI engine ready' : 'AI engine offline';
    if (s.contact) document.querySelectorAll('[data-contact]').forEach(a => { a.href = `mailto:${s.contact}`; });
    el.className = 'status ' + (s.ai ? 'ok' : 'warn');
  }).catch(() => {});

  // ---------- recent ----------
  async function loadRecent() {
    const sites = await fetch('/api/sites').then(r => r.json()).catch(() => []);
    $('#recent-wrap').hidden = !sites.length;
    $('#recent').innerHTML = sites.map(s => `
      <a class="card rcard" href="/sites/${esc(s.id)}">
        <div class="fav">${s.favicon ? `<img src="${esc(s.favicon)}" alt="" onerror="this.remove()">` : ''}</div>
        <div><b>${esc(s.name)}</b><span>${esc(host(s.url))} · ${s.pages} pages</span></div>
      </a>`).join('');
    if (window.revealNew) window.revealNew();
  }

  // ---------- build ----------
  $('#build').addEventListener('submit', async e => {
    e.preventDefault();
    const url = $('#url').value.trim();
    if (!url) return;
    const btn = e.submitter || $('#build button');
    if (window.sbPay && window.sbPay.beforeScan && !(await window.sbPay.beforeScan(() => $('#build').requestSubmit()))) return;
    btn.disabled = true;
    $('#result').hidden = true;
    showProgress(url);
    try {
      await streamBuild(url, btn);
    } catch (err) {
      logLine(err.message, 'error');
      $('#p-title').textContent = 'Something went wrong';
      btn.disabled = false;
    }
  });

  function showProgress(url) {
    $('#progress').hidden = false;
    $('#p-title').textContent = `Building an agent for ${host(/^https?:/.test(url) ? url : 'https://' + url)}`;
    $('#p-sub').textContent = 'Reading the public pages. This usually takes 20 to 60 seconds.';
    $('#p-count').textContent = '';
    $('#p-log').innerHTML = '';
    $('#p-bar').style.width = '3%';
    setStage('crawl');
    $('#progress').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setStage(stage) {
    const i = STAGES.indexOf(stage);
    document.querySelectorAll('.stages li').forEach((li, j) => {
      li.className = j < i || stage === 'done' ? 'done' : j === i ? 'active' : '';
    });
  }

  function logLine(text, level) {
    const li = document.createElement('li');
    li.textContent = text;
    if (level) li.className = level;
    $('#p-log').appendChild(li);
    $('#p-log').scrollTop = $('#p-log').scrollHeight;
  }

  // Progress arrives as server-sent events in the response of the scan request itself
  async function streamBuild(url, btn) {
    const token = window.sbAuth ? await window.sbAuth.token() : null;
    const res = await fetch('/api/build/stream', { method: 'POST', headers: { 'content-type': 'application/json', ...vh, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ url }) });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Could not start');
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', finished = false;
    const es = { close() { finished = true; try { reader.cancel(); } catch (e) { /* done */ } } };
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split('\n').find(l => l.startsWith('data: '));
        if (line) handle(JSON.parse(line.slice(6)), es, btn);
      }
    }
    btn.disabled = false;
  }

  function handle(e, es, btn) {
    {
      if (e.stage && e.stage !== 'error') setStage(e.stage);
      logLine(e.message, e.level || (e.stage === 'error' ? 'error' : ''));
      if (e.pages) {
        $('#p-count').textContent = `${e.pages} ${e.pages === 1 ? 'page' : 'pages'} read`;
        $('#p-bar').style.width = `${5 + (e.pages / e.total) * 65}%`;
      }
      if (e.stage === 'understand') $('#p-bar').style.width = '80%';
      if (e.stage === 'tools') $('#p-bar').style.width = '92%';
      if (e.stage === 'done') {
        es.close();
        $('#p-bar').style.width = '100%';
        $('#p-title').textContent = 'Done!';
        btn.disabled = false;
        history.pushState({}, '', `/sites/${e.siteId}`);
        if (window.sbPay && window.sbPay.refreshNote) window.sbPay.refreshNote();
        showSite(e.siteId);
        loadRecent();
      }
      if (e.stage === 'error') {
        es.close();
        $('#p-title').textContent = 'Could not build an agent for this site';
        $('#p-sub').textContent = e.message;
        btn.disabled = false;
      }
    }
  }

  // ---------- result ----------
  const copyBtn = text => `<button class="copy" data-copy="${esc(text)}">Copy</button>`;
  const code = text => `<pre class="code">${copyBtn(text)}${esc(text)}</pre>`;

  async function showSite(id) {
    const res = await fetch(`/api/sites/${id}`);
    if (!res.ok) return;
    const s = await res.json();
    const m = s.manifest;
    const mcpConfig = JSON.stringify({ mcpServers: { [s.id]: { type: 'http', url: s.links.mcp } } }, null, 2);
    const mcpRemote = JSON.stringify({ mcpServers: { [s.id]: { command: 'npx', args: ['-y', 'mcp-remote', s.links.mcp] } } }, null, 2);

    $('#result').innerHTML = `
      <div class="card">
        <div class="site-head">
          <div class="fav">${s.favicon ? `<img src="${esc(s.favicon)}" alt="" onerror="this.remove()">` : ''}</div>
          <div class="site-meta">
            <h2>${esc(m.name)}</h2>
            <a href="${esc(s.startUrl)}" target="_blank" rel="noopener">${esc(s.startUrl)}</a>
            <p>${esc(m.tagline || m.summary || '')}</p>
          </div>
          <div class="actions">
            <a class="btn-pill" href="${esc(s.links.preview)}" target="_blank">Open Live Demo <span class="arr">→</span></a>
            <button class="btn-pill ghost" id="rebuild">Re-scan <span class="arr">↻</span></button>
          </div>
        </div>
      </div>
      <div class="stats">
        <div class="card stat"><div class="k">Pages read</div><div class="v">${s.stats.pages}</div><div class="s">${s.stats.discovered} URLs discovered</div></div>
        <div class="card stat"><div class="k">Knowledge chunks</div><div class="v">${s.stats.chunks}</div><div class="s">searchable passages</div></div>
        <div class="card stat"><div class="k">MCP tools</div><div class="v">${s.tools.length}</div><div class="s">generated for this site</div></div>
                <div class="card stat"><div class="k">Visitor tasks</div><div class="v">${m.tasks.length}</div><div class="s">actions the agent can carry out</div></div>
      </div>
      <div class="card">
        <div class="tabs">
          <button class="tab on" data-tab="overview">Overview</button>
          <button class="tab" data-tab="mcp">MCP server</button>
          <button class="tab" data-tab="embed">Embed on your site</button>
          <button class="tab" data-tab="knowledge">Knowledge</button>
          <button class="tab" data-tab="pages">Pages (${s.pageList.length})</button>
        </div>

        <div class="pane" data-pane="overview">
          ${!m.ai ? `<p class="note" style="margin:0 0 18px;color:#b45309">This is a basic profile because the AI step was unavailable during the scan. Re-scan to build the full knowledge pack.</p>` : ''}
          <div class="grid2">
            <section><h4>What the agent knows</h4><p style="margin:0">${esc(m.summary)}</p>
              ${m.key_facts.length ? `<ul class="facts" style="margin-top:12px">${m.key_facts.map(f => `<li>${esc(f)}</li>`).join('')}</ul>` : ''}</section>
            <section><h4>What visitors can ask the agent to do</h4>
              <div class="list">${(m.tasks.length ? m.tasks : [{ name: 'Answer questions about the site' }, { name: 'Navigate to any page and point things out' }])
                .map(t => `<div class="item"><b>${esc(t.name)}</b>${t.steps?.length ? `<div class="d">${esc(t.steps.join(' → '))}</div>` : ''}</div>`).join('')}</div>
              <h4 style="margin-top:22px">Try asking</h4>
              <div class="chips">${m.suggested_questions.map(q => `<span class="chip">${esc(q)}</span>`).join('')}</div>
            </section>
          </div>
        </div>

        <div class="pane" data-pane="mcp" hidden>
          <section><h4>Endpoint (MCP Streamable HTTP)</h4>${code(s.links.mcp)}</section>
          <section><h4>Claude Code / Cursor / VS Code</h4>${code(mcpConfig)}
            <p class="note">Or run: <code>claude mcp add --transport http ${esc(s.id)} ${esc(s.links.mcp)}</code></p></section>
          <section><h4>Claude Desktop (via mcp-remote)</h4>${code(mcpRemote)}
            <p class="note">For other people to use it, deploy Site Bridge on a public URL and set PUBLIC_URL.</p></section>
          <section><h4>Generated tools</h4><div class="list">${s.tools.map(t => `<div class="tool"><code>${esc(t.name)}</code><div class="d">${esc(t.description)}</div></div>`).join('')}</div></section>
          <section><h4>Pine Labs AgenticOrg</h4>
            <p style="margin:0">The live agent hands visitors' order, payment, refund and delivery problems to AgenticOrg's Support Triage agent, which picks the team and priority. Hand-offs appear on the admin dashboard.</p></section>
          <section><h4>Also generated</h4>
            <div class="actions"><a class="btn-pill ghost sm" href="${esc(s.links.llms)}" target="_blank">llms.txt</a><a class="btn-pill ghost sm" href="${esc(s.links.manifest)}" target="_blank">agent.json</a></div></section>
        </div>

        <div class="pane" data-pane="embed" hidden>
          <section><h4>Add the agent to your website</h4>
            <p style="margin:0 0 12px">Paste this before <code>&lt;/body&gt;</code>. The agent appears inside your site in your brand colour, as an "Ask AI" button that opens a side panel. It answers from your content and can move around your pages for the visitor.</p>
            ${code(s.links.widget)}</section>
          <section><h4>Preview it first</h4><p style="margin:0 0 12px">The live demo is your real website with the agent already living inside it. Nothing to install.</p>
            <a class="btn-pill sm" href="${esc(s.links.preview)}" target="_blank">Open Live Demo <span class="arr">→</span></a></section>
        </div>

        <div class="pane" data-pane="knowledge" hidden>
          <div class="grid2">
            <section><h4>Offerings</h4>${m.offerings.length ? `<div class="list">${m.offerings.map(o => `<div class="item"><b>${esc(o.name)}</b>${o.price ? ` · ${esc(o.price)}` : ''}<div class="d">${esc(o.description || '')}</div></div>`).join('')}</div>` : '<p class="muted">None detected.</p>'}</section>
            <section><h4>FAQs</h4>${m.faqs.length ? `<div class="list">${m.faqs.map(f => `<div class="item"><b>${esc(f.q)}</b><div class="d">${esc(f.a)}</div></div>`).join('')}</div>` : '<p class="muted">None detected.</p>'}</section>
          </div>
          <section><h4>Contact</h4><div class="chips">${['email', 'phone', 'address', 'hours'].filter(k => m.contact?.[k]).map(k => `<span class="chip">${esc(m.contact[k])}</span>`).join('') || '<span class="muted">Not found.</span>'}</div></section>
        </div>

        <div class="pane" data-pane="pages" hidden>
          <div class="list">${s.pageList.map(p => `<div class="item"><b>${esc(p.title || p.url)}</b><div class="d"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a> · ${p.words} words${p.forms ? ` · ${p.forms} form${p.forms > 1 ? 's' : ''}` : ''}</div></div>`).join('')}</div>
        </div>
      </div>`;
    $('#result').hidden = false;
    if (window.revealNew) window.revealNew();
    $('#progress').hidden = true;
    $('#url').value = s.startUrl;
    $('#rebuild').addEventListener('click', () => { $('#build').requestSubmit(); });
    document.querySelectorAll('#result a[href="' + CSS.escape(s.links.preview) + '"]').forEach(a => a.addEventListener('click', e => {
      if (!window.sbPay) return;
      e.preventDefault();
      window.sbPay.openDemo(s.id, s.links.preview);
    }));
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  document.addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (tab) {
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t === tab));
      document.querySelectorAll('.pane').forEach(p => { p.hidden = p.dataset.pane !== tab.dataset.tab; });
    }
    const copy = e.target.closest('.copy');
    if (copy) {
      navigator.clipboard.writeText(copy.dataset.copy).then(() => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy'; }, 1400); });
    }
  });

  const m = location.pathname.match(/^\/sites\/([a-z0-9-]+)$/);
  if (m) showSite(m[1]);
  loadRecent();
})();
