// Live preview: a reverse proxy that serves the customer's real site on
// http://{siteId}.localhost:4101/* with the agent bridge injected into every HTML page.
// Paths map 1:1 to the original site, so client-side routers keep working, and the
// site's scripts run on their own origin, isolated from the Site Bridge app.
import express from 'express';
import { Readable } from 'node:stream';
import { getSite } from './store.js';
import { config } from './config.js';
import { bareHost } from './net.js';
import { track } from './usage.js';
import { verifyPass } from './guardrails.js';

const DROP_REQ = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'accept-encoding', 'content-length', 'origin', 'referer', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);
const DROP_RES = new Set(['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'content-encoding', 'content-length', 'transfer-encoding', 'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy', 'cross-origin-resource-policy', 'permissions-policy', 'connection', 'keep-alive', 'alt-svc', 'report-to', 'nel', 'set-cookie', 'clear-site-data', 'public-key-pins']);
const REWRITE_TYPES = /text\/html|text\/css|javascript|application\/json|application\/manifest|text\/xml|application\/xml/i;

const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function hostVariants(host) {
  const bare = bareHost(host);
  return [...new Set([host.toLowerCase(), bare, `www.${bare}`])];
}

function rewriteOrigins(text, site, previewOrigin) {
  const escaped = previewOrigin.replace(/\//g, '\\/');
  for (const h of hostVariants(site.hostname)) {
    const eh = escRe(h);
    text = text.replace(new RegExp(`(?:https?:)?//${eh}(?![\\w.-])`, 'gi'), previewOrigin);
    text = text.replace(new RegExp(`(?:https?:)?\\\\/\\\\/${eh}(?![\\w.-])`, 'gi'), escaped);
  }
  return text;
}

function rewriteCookie(c) {
  return c.split(';').map(s => s.trim()).filter(s => !/^(domain|secure|partitioned)(=|$)/i.test(s))
    .map(s => (/^samesite=none$/i.test(s) ? 'SameSite=Lax' : s)).join('; ');
}

function bridgeTag(site, appOrigin = config.publicUrl) {
  const a = s => String(s).replace(/"/g, '&quot;');
  // The bridge maps URLs for the preview; the widget puts the agent inside the site itself,
  // exactly as it will look once the customer embeds it.
  // Inline, so the docked layout is in place before the page first paints (no jump on navigation)
  const early = `<script>(function(){try{if(sessionStorage.getItem(${JSON.stringify(`agentify:open:${site.id}`)})!=="1")return;` +
    `var w=innerWidth<=640?innerWidth:Math.round(Math.min(420,Math.max(340,innerWidth*0.3))),d=document.documentElement,s=document.createElement("style");` +
    `s.id="agentify-early";s.textContent='html.agw-docked{margin-right:var(--agw-w,400px)!important;overflow-x:hidden!important}html.agw-docked::after{content:"";position:fixed;top:0;right:0;bottom:0;width:var(--agw-w,400px);z-index:2147483640;pointer-events:none;background:linear-gradient(180deg,#fff 0%,#f5f6fa 100%);border-left:1px solid rgba(15,23,42,.09)}@media (max-width:640px){html.agw-docked{margin-right:0!important}}';` +
    `(document.head||d).appendChild(s);d.style.setProperty("--agw-w",w+"px");d.classList.add("agw-docked")}catch(e){}})();</script>`;
  const hints = `<link rel="preconnect" href="${a(config.publicUrl)}" crossorigin>` +
    `<link rel="preload" as="script" href="${a(config.publicUrl)}/widget.js">` +
    `<link rel="preload" as="script" href="${a(config.publicUrl)}/agent-client.js">` +
    `<link rel="preload" as="fetch" crossorigin href="${a(config.publicUrl)}/api/sites/${a(site.id)}/public">`;
  return early + hints + `<script src="${a(config.publicUrl)}/bridge.js" data-mode="widget" data-proxy="1" data-app-origin="${a(appOrigin)}" data-site-origin="${a(site.origin)}" data-site-id="${a(site.id)}"></script>` +
    `<script src="${a(config.publicUrl)}/widget.js" data-site="${a(site.id)}" data-demo="1" defer></script>`;
}

function notFound(res, msg) {
  res.status(404).type('html').send(`<!doctype html><meta charset="utf-8"><title>Preview not found</title>
<body style="font:16px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#334">
<div style="text-align:center"><h2>Preview not found</h2><p>${msg}</p><a href="${config.publicUrl}">Open Site Bridge</a></div>`);
}

const DEMO_COOKIE = 'sb_demo';
const cookieOf = (req, name) => (String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([a-z0-9-]{1,63})')) || [])[1];

export function createPreviewApp({ byCookie = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');

  app.use(async (req, res) => {
    const host = req.headers.host || '';
    // Demo host: /__sb/open/<id> picks the client site for this browser, then every path maps 1:1 to it
    if (byCookie) {
      const m = /^\/__sb\/open\/([a-z0-9-]{1,63})/.exec(req.path);
      if (m) {
        if (!(await getSite(m[1]))) return notFound(res, 'This site has not been scanned yet.');
        const pass = verifyPass(req.query?.pass || req.headers['x-sb-pass']);
        if (!pass || pass.s !== m[1]) return res.status(403).json({ error: 'pass_required' });
        res.setHeader('set-cookie', `${DEMO_COOKIE}=${m[1]}; Path=/; SameSite=Lax; Secure; HttpOnly; Max-Age=86400`);
        track(req, 'demo_open', { siteId: m[1] });
        return res.status(204).end();
      }
    }
    const id = byCookie ? cookieOf(req, DEMO_COOKIE) : host.split('.')[0].toLowerCase();
    if (byCookie && !id) return notFound(res, 'Open a live demo from Site Bridge first.');
    const site = id ? await getSite(id) : null;
    if (!site) return notFound(res, 'This preview link has expired or was never created.');

    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const previewOrigin = `${proto}://${host}`;
    const target = new URL(req.originalUrl, site.origin);
    if (req.method === 'GET' && /\.(png|jpe?g|gif|webp|avif|ico|bmp|mp4|webm|mov|mp3|wav|ogg)$/i.test(target.pathname)) {
      res.setHeader('cache-control', 'public, max-age=86400');
      return res.redirect(302, target.href);
    }

    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROP_REQ.has(k)) headers[k] = v;
    if (req.headers.origin) headers.origin = site.origin;
    if (req.headers.referer) headers.referer = req.headers.referer.replace(previewOrigin, site.origin);
    // Our demo cookie is ours alone; don't send it to the client's site
    if (byCookie && headers.cookie) headers.cookie = headers.cookie.split(/;\s*/).filter(c => !c.startsWith(`${DEMO_COOKIE}=`)).join('; ') || undefined;
    if (headers.cookie === undefined) delete headers.cookie;

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = Buffer.concat(chunks);
    }

    let upstream;
    try {
      upstream = await fetch(target, { method: req.method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    } catch (e) {
      return res.status(502).type('text').send(`Could not reach ${site.origin}: ${e.cause?.code || e.message}`);
    }

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => { if (!DROP_RES.has(k)) res.setHeader(k, v); });
    const cookies = upstream.headers.getSetCookie?.() || [];
    if (cookies.length) res.setHeader('set-cookie', cookies.map(rewriteCookie));

    const loc = upstream.headers.get('location');
    if (loc) {
      try {
        const u = new URL(loc, target);
        if (hostVariants(site.hostname).includes(u.hostname.toLowerCase())) res.setHeader('location', previewOrigin + u.pathname + u.search + u.hash);
      } catch { /* keep as-is */ }
    }

    const type = upstream.headers.get('content-type') || '';
    if (req.method === 'HEAD' || !upstream.body) return res.end();

    if (REWRITE_TYPES.test(type)) {
      let text;
      try { text = await upstream.text(); }
      catch (e) { if (!res.headersSent) res.status(504); return res.end(); } // body timed out or the site hung up
      text = rewriteOrigins(text, site, previewOrigin);
      if (/text\/html/i.test(type)) {
        text = text
          .replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '')
          .replace(/\sintegrity=("[^"]*"|'[^']*')/gi, '');
        // On the demo host the demo page shares this origin, so the bridge reports to it
        const tag = bridgeTag(site, byCookie ? previewOrigin : config.publicUrl);
        text = /<head[^>]*>/i.test(text) ? text.replace(/<head[^>]*>/i, m => m + tag) : tag + text;
        res.setHeader('cache-control', 'no-store');
      }
      return res.send(text);
    }
    Readable.fromWeb(upstream.body).on('error', () => res.end()).pipe(res);
  });

  return app;
}
