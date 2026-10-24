import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { config, previewOriginFor, demoPageFor } from './lib/config.js';
import { buildSite } from './lib/builder.js';
import { getSite, getIndex, listSites, deleteSite } from './lib/store.js';
import { handleMcp, publicTools } from './lib/mcp.js';
import { chatTurn } from './lib/agent.js';
import { llmsTxt } from './lib/knowledge.js';
import { sendToAgenticOrg, agenticOrgReady } from './lib/agenticorg.js';
import { createPreviewApp } from './lib/proxy.js';
import { hasKey } from './lib/gemini.js';
import { rateLimiter, cleanText } from './lib/guardrails.js';
import { spend } from './lib/budget.js';
import { track, usageStats, authConfig, userFrom, recentHandoffs, registeredUsers } from './lib/usage.js';
import { payConfig, paymentsReady, balance, claim, startDemo, paymentStats, setPaymentStatus, isUnlimited, useChat } from './lib/payments.js';
import { signPass, verifyPass } from './lib/guardrails.js';
import { sendLoginEmail } from './lib/authmail.js';
import crypto2 from 'node:crypto';

// One failed request (a slow website in the preview, a dropped connection) must never stop the server
process.on('unhandledRejection', e => console.error('[unhandled]', e?.name || '', e?.message || e));
process.on('uncaughtException', e => console.error('[uncaught]', e?.name || '', e?.message || e));

const app = express();
app.disable('x-powered-by');

// Live demo host on Vercel: /__sb/* is Site Bridge itself (API for the demo page), everything
// else is the client's site through the proxy
if (config.demoHost) {
  const demo = createPreviewApp({ byCookie: true });
  app.use((req, res, next) => {
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase().split(':')[0];
    if (host !== config.demoHost) return next();
    if (req.url.startsWith('/__sb/api/')) { req.url = req.url.slice(5); return next(); }
    return demo(req, res, next);
  });
}
if (config.trustProxy) app.set('trust proxy', config.trustProxy);
app.use(express.json({ limit: '4mb' }));

const cors = (req, res, next) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, mcp-session-id, mcp-protocol-version, authorization, x-sb-visitor, x-sb-pass');
  res.setHeader('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('access-control-expose-headers', 'mcp-session-id');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
};

app.use(express.static(path.join(config.root, 'public'), {
  setHeaders: res => res.setHeader('access-control-allow-origin', '*'),
}));

// ---------- build jobs (crawl + understand) with live progress over SSE ----------

const jobs = new Map();

// Scan with progress streamed back in the same response (works on serverless hosts too)
app.post('/api/build/stream', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a website URL first' });
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  const send = ev => { try { res.write(`data: ${JSON.stringify({ t: Date.now(), ...ev })}\n\n`); } catch { /* client left */ } };
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* client left */ } }, 10000);
  try {
    const site = await buildSite(url, { maxPages: config.maxPages, onProgress: send });
    send({ stage: 'done', message: 'Your agentic website is ready', siteId: site.id });
    track(req, 'scan', { siteId: site.id, meta: { url: site.startUrl, pages: site.stats.pages } });
  } catch (e) {
    send({ stage: 'error', message: e.message });
    track(req, 'scan_failed', { meta: { url: url.slice(0, 200) } });
  } finally {
    clearInterval(ping);
    res.end();
  }
});

app.post('/api/build', (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (!url) return res.status(400).json({ error: 'Paste a website URL first' });
  const maxPages = Math.min(Math.max(Number(req.body?.maxPages) || config.maxPages, 3), 100);
  const id = crypto.randomUUID();
  const job = { id, events: [], listeners: new Set(), done: false };
  jobs.set(id, job);
  const emit = ev => {
    const e = { t: Date.now(), ...ev };
    job.events.push(e);
    for (const l of job.listeners) l(e);
  };
  buildSite(url, { maxPages, onProgress: emit })
    .then(site => emit({ stage: 'done', message: 'Your agentic website is ready', siteId: site.id }))
    .catch(e => emit({ stage: 'error', message: e.message }))
    .finally(() => { job.done = true; setTimeout(() => jobs.delete(id), 10 * 60_000); });
  res.json({ jobId: id });
});

app.get('/api/jobs/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const send = e => res.write(`data: ${JSON.stringify(e)}\n\n`);
  job.events.forEach(send);
  if (job.done) return res.end();
  const l = e => { send(e); if (e.stage === 'done' || e.stage === 'error') res.end(); };
  job.listeners.add(l);
  req.on('close', () => job.listeners.delete(l));
});

// ---------- sites ----------

function siteLinks(site) {
  return {
    preview: demoPageFor(site.id),
    proxy: previewOriginFor(site.id),
    mcp: `${config.publicUrl}/mcp/${site.id}`,
    llms: `${config.publicUrl}/sites/${site.id}/llms.txt`,
    manifest: `${config.publicUrl}/sites/${site.id}/agent.json`,
    widget: `<script src="${config.publicUrl}/widget.js" data-site="${site.id}" defer></script>`,
  };
}

// auth holds only the public URL and publishable key; secret keys never leave the server
app.get('/api/status', (req, res) => res.json({ ai: hasKey(), contact: process.env.CONTACT_EMAIL || null, spend: spend(), auth: authConfig, agenticorg: agenticOrgReady,
  payments: paymentsReady ? { upiId: payConfig.upiId, payee: payConfig.payee, amount: payConfig.amount, credits: payConfig.credits, free: payConfig.free } : null }));
app.get('/api/sites', async (req, res) => res.json(await listSites()));

// Email sign-in: sends a one-time link through Resend (5 requests per 10 minutes per IP)
const authLimit = rateLimiter({ perMinute: 3, perHour: 12, keyOf: req => `auth:${req.ip}`, message: 'Too many sign-in requests. Please wait a few minutes.' });
app.post('/api/auth/email', authLimit, async (req, res) => {
  const origin = config.onVercel ? config.publicUrl : `${req.protocol}://${req.get('host')}`;
  const r = await sendLoginEmail(req.body?.email, origin).catch(e => ({ ok: false, status: 500, error: 'Could not send the email right now.', e }));
  if (r.e) console.error('[auth]', r.e.message);
  res.status(r.ok ? 200 : r.status).json(r.ok ? { ok: true } : { error: r.error });
});

// Live demo credits and UPI payments (signed-in users only)
const payLimit = rateLimiter({ perMinute: 10, perHour: 60, keyOf: req => `pay:${req.ip}`, message: 'Too many attempts. Please wait a minute.' });
async function needUser(req, res) {
  const user = await userFrom(req);
  if (!user) res.status(401).json({ error: 'Please sign in first.' });
  return user;
}
app.post('/api/me/credits', payLimit, async (req, res) => {
  const user = await needUser(req, res); if (!user) return;
  res.json({ balance: isUnlimited(user) ? { paid: 0, used: 0, free: 0, left: 9999, unlimited: true } : await balance(user.id) });
});
app.post('/api/pay/claim', payLimit, async (req, res) => {
  const user = await needUser(req, res); if (!user) return;
  try { const r = await claim(user, req.body?.utr); res.status(r.ok ? 200 : r.status).json(r.ok ? r : { error: r.error }); }
  catch (e) { console.error('[pay]', e.message); res.status(500).json({ error: 'Could not record the payment right now.' }); }
});
app.post('/api/demo/start/:id', payLimit, async (req, res) => {
  const user = await needUser(req, res); if (!user) return;
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'This site has not been scanned.' });
  try {
    const r = await startDemo(user, site.id);
    // A one-day pass for this account and site: the demo address only opens with it
    if (r.ok) r.pass = signPass({ u: user.id, s: site.id, m: user.email || '', e: Date.now() + 24 * 3600_000 });
    res.status(r.ok ? 200 : r.status).json(r.ok ? r : { error: r.error, balance: r.balance });
  }
  catch (e) { console.error('[demo]', e.message); res.status(500).json({ error: 'Could not open the demo right now.' }); }
});

// Anonymous usage: the browser reports visits; the admin page reads the totals
app.options('/api/track', cors);
app.post('/api/track', cors, (req, res) => {
  const kind = String(req.body?.kind || '');
  if (kind === 'visit' || kind === 'results_view') track(req, kind, { siteId: typeof req.body?.siteId === 'string' ? req.body.siteId.slice(0, 80) : null });
  res.status(204).end();
});
app.get('/api/admin/usage', async (req, res) => {
  const want = process.env.ADMIN_KEY || '';
  const got = String(req.headers['x-admin-key'] || '');
  const ok = want.length >= 12 && got.length === want.length && crypto2.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return res.status(401).json({ error: want ? 'Wrong admin key.' : 'Set ADMIN_KEY on the server first.' });
  try { res.json({ ...(await usageStats()), payments: await paymentStats().catch(() => null), handoffs: await recentHandoffs(), users: await registeredUsers() }); } catch (e) { console.error('[usage]', e.message); res.status(500).json({ error: 'Could not read usage data.' }); }
});
// Admin: remove a registered user (signs them out everywhere and deletes the account)
app.post('/api/admin/users/:id/remove', async (req, res) => {
  const want = process.env.ADMIN_KEY || '';
  const got = String(req.headers['x-admin-key'] || '');
  if (!(want.length >= 12 && got.length === want.length && crypto2.timingSafeEqual(Buffer.from(got), Buffer.from(want)))) return res.status(401).json({ error: 'Wrong admin key.' });
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'Bad user id.' });
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, ''), key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return res.status(503).json({ error: 'Accounts are not connected.' });
  const h = { apikey: key }; if (key.split('.').length === 3) h.authorization = `Bearer ${key}`;
  const r = await fetch(`${url}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: h }).catch(() => null);
  if (!r || !r.ok) return res.status(502).json({ error: 'Could not remove the user.' });
  res.json({ ok: true });
});

app.post('/api/admin/payments/:id', async (req, res) => {
  const want = process.env.ADMIN_KEY || '';
  const got = String(req.headers['x-admin-key'] || '');
  if (!(want.length >= 12 && got.length === want.length && crypto2.timingSafeEqual(Buffer.from(got), Buffer.from(want)))) return res.status(401).json({ error: 'Wrong admin key.' });
  res.json({ ok: await setPaymentStatus(req.params.id, String(req.body?.status || '')) });
});
app.get('/usage', (req, res) => res.sendFile(path.join(config.root, 'public', 'usage.html'), err => { if (err && !res.headersSent) res.redirect(302, '/usage.html'); }));

app.get('/api/sites/:id', async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const { pages, chunks, shared, cost, ...rest } = site;
  res.json({
    ...rest,
    pageList: pages.map(p => ({ url: p.url, title: p.title, forms: p.forms.length, words: p.text.split(/\s+/).length })),
    tools: publicTools(site),
    links: siteLinks(site),
  });
});

app.delete('/api/sites/:id', async (req, res) => { await deleteSite(req.params.id); res.json({ ok: true }); });

// Push this site's knowledge into the Pine Labs AgenticOrg knowledge base
const aoLimit = rateLimiter({ perMinute: 4, perHour: 40, keyOf: req => `ao:${req.ip}`, message: 'Please wait a moment before sending again.' });
app.post('/api/sites/:id/agenticorg', aoLimit, async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  try {
    const r = await sendToAgenticOrg(site);
    res.status(r.ok ? 200 : r.status || 502).json(r.ok ? r : { error: r.error });
  } catch (e) {
    console.error('[agenticorg]', e.message);
    res.status(502).json({ error: 'Could not reach AgenticOrg right now.' });
  }
});

// Public config for the chat panel and the embeddable widget
app.get('/api/sites/:id/public', cors, async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const m = site.manifest;
  res.json({
    id: site.id, name: m.name, origin: site.origin, startUrl: site.startUrl, favicon: site.favicon,
    themeColor: site.themeColor, greeting: m.greeting, suggestions: m.suggested_questions,
    previewOrigin: config.previewEnabled ? previewOriginFor(site.id) : null, ai: hasKey(), appUrl: config.publicUrl,
  });
});

// Chat guardrails: per-visitor and per-site rate limits here; input validation, signed
// history, prompt-injection and leak defences in lib/guardrails.js via chatTurn.
const chatLimitByIp = rateLimiter({ perMinute: config.chatRatePerMin, perHour: config.chatRatePerHour, keyOf: req => req.ip });
const chatLimitBySite = rateLimiter({
  perMinute: config.chatSiteRatePerMin, perHour: config.chatSiteRatePerHour,
  keyOf: req => `site:${req.body?.siteId || ''}`,
  message: 'The assistant is very busy right now. Please try again in a few minutes.',
});

app.options('/api/chat', cors);
app.post('/api/chat', cors, chatLimitByIp, chatLimitBySite, async (req, res) => {
  const { siteId, contents, token, currentUrl, title, lang } = req.body || {};
  if (typeof siteId !== 'string') return res.status(400).json({ error: 'Unknown site' });
  const [site, index] = await Promise.all([getSite(siteId), getIndex(siteId)]);
  if (!site) return res.status(404).json({ error: 'Unknown site' });
  try {
    // Count a chat message when the visitor typed something (not for the agent's own page steps)
    const lastTurn = Array.isArray(contents) ? contents[contents.length - 1] : null;
    const typed = lastTurn?.role === 'user' && lastTurn.parts?.some(p => typeof p?.text === 'string');
    // Live demos (on the demo address) need the account's demo pass, and typed messages count
    // against the account's chat allowance
    if (config.demoHost && String(req.headers.origin || '').toLowerCase() === `https://${config.demoHost}`) {
      const pass = verifyPass(req.headers['x-sb-pass']);
      if (!pass || pass.s !== siteId) return res.status(401).json({ error: 'Please open this live demo from Site Bridge after signing in.' });
      if (typed) {
        const c = await useChat({ id: pass.u, email: pass.m }, siteId).catch(e => { console.error('[chats]', e.message); return { ok: true }; });
        if (!c.ok) return res.status(402).json({ error: `You've used all ${c.limit} chats on your account. ${c.paid ? 'Pay ₹' + payConfig.amount + ' on Site Bridge for 10 more.' : 'Pay ₹' + payConfig.amount + ' on Site Bridge to get 10 more chats.'}` });
      }
    }
    if (lastTurn?.role === 'user' && lastTurn.parts?.some(p => typeof p?.text === 'string')) track(req, 'chat', { siteId });
    res.json(await chatTurn(site, index, { contents, token, currentUrl: cleanText(currentUrl, 2000), title: cleanText(title, 300), lang: cleanText(lang, 40) }));
  } catch (e) {
    if (e.code === 'EXPIRED') return res.status(409).json({ error: e.message, reset: true });
    if (e.code === 'BAD_REQUEST') return res.status(400).json({ error: e.message });
    // Daily spend cap reached: visitors get a polite note, never the budget or cost
    if (e.code === 'BUDGET') return res.status(503).json({ error: 'The assistant is taking a short break. Please try again a little later.' });
    console.error('[chat]', e.message);
    res.status(500).json({ error: 'The assistant is unavailable right now.' });
  }
});

// ---------- agent-readable outputs ----------

app.get('/sites/:id/llms.txt', async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).type('text').send('Not found');
  res.type('text/plain; charset=utf-8').send(llmsTxt(site));
});

app.get('/sites/:id/agent.json', cors, async (req, res) => {
  const site = await getSite(req.params.id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  res.json({ schema: 'sitebridge/1', site: site.origin, ...site.manifest, mcp: siteLinks(site).mcp, tools: publicTools(site) });
});

// MCP over Streamable HTTP (stateless JSON responses)
app.options('/mcp/:id', cors);
app.get('/mcp/:id', cors, (req, res) => res.status(405).set('allow', 'POST').json({ error: 'Use POST with JSON-RPC 2.0 (MCP Streamable HTTP).' }));
app.delete('/mcp/:id', cors, (req, res) => res.status(405).end());
app.post('/mcp/:id', cors, async (req, res) => {
  const [site, index] = await Promise.all([getSite(req.params.id), getIndex(req.params.id)]);
  if (!site) return res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unknown site' } });
  const out = handleMcp(site, index, req.body);
  if (!out) return res.status(202).end();
  res.json(out);
});

// ---------- pages ----------

// Home page. On Vercel, public/ is served by the CDN and may not be inside the function, so fall
// back to that copy when the file isn't here.
app.get('/', (req, res) => res.sendFile(path.join(config.root, 'public', 'index.html'), err => { if (err && !res.headersSent) res.redirect(302, '/index.html'); }));
app.get('/preview/:id', (req, res) => res.sendFile(path.join(config.root, 'public', 'preview.html')));
app.get('/sites/:id', (req, res) => res.sendFile(path.join(config.root, 'public', 'index.html')));

const portError = port => e => {
  console.error(e.code === 'EADDRINUSE' ? `\n  Port ${port} is already in use. Set PORT / PREVIEW_PORT in .env to free ports.\n` : e);
  process.exit(1);
};
export default app;

// On Vercel the platform runs the app; locally we listen on our own ports
if (!config.onVercel) app.listen(config.port, () => {
  console.log(`\n  Site Bridge       ${config.publicUrl}`);
  console.log(`  Live previews  ${previewOriginFor('<site-id>')}`);
  const sp = spend();
  console.log(`  Daily budget   ₹${sp.inr} of ₹${sp.budget} used today`);
  console.log(`  Gemini         ${hasKey() ? `ready (${config.geminiModel})` : 'NOT CONFIGURED: add GEMINI_API_KEY to .env'}\n`);
}).on('error', portError(config.port));
if (!config.onVercel) createPreviewApp().listen(config.previewPort).on('error', portError(config.previewPort));
