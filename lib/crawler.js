import * as cheerio from 'cheerio';
import { assertPublicUrl, sameSite } from './net.js';
import { config } from './config.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 SiteBridgeBot/0.1';
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|zip|rar|gz|mp4|mov|webm|mp3|wav|css|js|mjs|json|xml|rss|txt|woff2?|ttf|eot|docx?|xlsx?|pptx?|csv|exe|dmg|apk)$/i;
const SKIP_PATH = /\/(wp-admin|wp-json|cart|checkout|login|logout|signin|sign-in|register|account|my-account|feed|cdn-cgi)(\/|$)|[?&](add-to-cart|replytocom|share)=/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const clean = s => (s || '').replace(/\s+/g, ' ').trim();

export function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|_ga|ref$|source$)/i.test(k)) u.searchParams.delete(k);
    }
    let s = u.toString();
    if (u.pathname !== '/' && s.endsWith('/') && !u.search) s = s.slice(0, -1);
    return s;
  } catch { return null; }
}

async function fetchText(url, { timeout = 8000, accept = 'text/html,application/xhtml+xml', signal } = {}) {
  await assertPublicUrl(url);
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept, 'accept-language': 'en-US,en;q=0.9' },
    redirect: 'follow',
    signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout),
  });
  const type = res.headers.get('content-type') || '';
  const text = res.ok ? await res.text() : '';
  return { ok: res.ok, status: res.status, url: res.url || url, type, text: text.slice(0, 3_000_000) };
}

// ---------- robots.txt & sitemap ----------

function parseRobots(txt) {
  const rules = []; const sitemaps = [];
  let applies = false, sawRule = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === 'sitemap') { sitemaps.push(val); continue; }
    if (key === 'user-agent') {
      if (sawRule) { applies = false; sawRule = false; }
      if (val === '*' || /sitebridge/i.test(val)) applies = true;
      continue;
    }
    if (key === 'disallow' || key === 'allow') {
      sawRule = true;
      if (applies && val) {
        const re = new RegExp('^' + val.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
        rules.push({ allow: key === 'allow', re, len: val.length });
      }
    }
  }
  return {
    sitemaps,
    allowed(path) {
      let best = null;
      for (const r of rules) if (r.re.test(path) && (!best || r.len > best.len)) best = r;
      return !best || best.allow;
    },
  };
}

async function readSitemaps(urls, host, limit) {
  const found = [];
  const queue = [...urls];
  let fetched = 0;
  while (queue.length && fetched < 6 && found.length < limit) {
    const sm = queue.shift(); fetched++;
    try {
      const r = await fetchText(sm, { timeout: 10000, accept: 'application/xml,text/xml,*/*' });
      if (!r.ok) continue;
      const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi)].map(m => m[1].trim());
      if (/<sitemapindex/i.test(r.text)) {
        // Prefer page/post sitemaps over image/video ones
        queue.push(...locs.filter(l => !/image|video/i.test(l)).slice(0, 5));
      } else {
        for (const l of locs) {
          const n = normalizeUrl(l);
          if (n && sameSite(new URL(n).hostname, host)) found.push(n);
        }
      }
    } catch { /* ignore broken sitemaps */ }
  }
  return found.slice(0, limit);
}

// ---------- page extraction ----------

export function extractPage(html, url) {
  const $ = cheerio.load(html);
  const jsonld = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try { jsonld.push(JSON.parse($(el).text())); } catch { /* skip invalid */ }
  });

  const meta = n => $(`meta[name="${n}"]`).attr('content') || $(`meta[property="${n}"]`).attr('content') || '';
  const title = clean($('title').first().text()) || clean(meta('og:title'));
  const description = clean(meta('description') || meta('og:description'));
  const siteName = clean(meta('og:site_name'));
  const themeColor = meta('theme-color');
  const lang = $('html').attr('lang') || '';
  const iconHref = $('link[rel~="icon"]').first().attr('href') || $('link[rel="apple-touch-icon"]').first().attr('href') || '/favicon.ico';
  const favicon = normalizeUrl(iconHref, url);

  const links = []; const navLinks = []; const emails = new Set(); const phones = new Set(); const social = new Set();
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (href.startsWith('mailto:')) { emails.add(href.slice(7).split('?')[0]); return; }
    if (href.startsWith('tel:')) { phones.add(href.slice(4)); return; }
    const abs = normalizeUrl(href, url);
    if (!abs) return;
    if (/(facebook|instagram|twitter|x|linkedin|youtube|tiktok|pinterest|github)\.com\//i.test(abs)) social.add(abs);
    const text = clean($(el).text() || $(el).attr('aria-label') || $(el).attr('title')).slice(0, 80);
    links.push({ url: abs, text });
    if ($(el).closest('nav, header, [role="navigation"]').length) navLinks.push({ url: abs, text });
  });

  const forms = [];
  $('form').each((_, f) => {
    const fields = [];
    $(f).find('input, select, textarea').each((__, el) => {
      const type = ($(el).attr('type') || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) return;
      const id = $(el).attr('id');
      let label = '';
      if (id) { try { label = clean($(`label[for="${id.replace(/"/g, '')}"]`).text()); } catch { /* odd id */ } }
      label = label || clean($(el).closest('label').text()) || $(el).attr('aria-label') || $(el).attr('placeholder') || $(el).attr('name') || '';
      const field = { name: $(el).attr('name') || id || '', type, label: clean(label).slice(0, 80), required: $(el).is('[required]') };
      if (el.tagName === 'select') field.options = $(el).find('option').map((___, o) => clean($(o).text())).get().filter(Boolean).slice(0, 20);
      fields.push(field);
    });
    if (!fields.length) return;
    const submit = clean($(f).find('button, input[type="submit"]').first().text() || $(f).find('input[type="submit"]').attr('value'));
    const heading = clean($(f).closest('section, div').find('h1, h2, h3').first().text()).slice(0, 80);
    forms.push({
      action: normalizeUrl($(f).attr('action') || url, url),
      method: ($(f).attr('method') || 'get').toLowerCase(),
      fields, submit: submit.slice(0, 40), heading, page: url,
    });
  });

  $('script, style, noscript, svg, iframe, template, canvas, video, audio, picture source').remove();
  const headings = $('h1, h2, h3').map((_, el) => ({ level: Number(el.tagName[1]), text: clean($(el).text()).slice(0, 120) })).get().filter(h => h.text).slice(0, 40);
  $('img[alt]').each((_, el) => { const alt = clean($(el).attr('alt')); if (alt.length > 3) $(el).replaceWith(` [image: ${alt}] `); });

  $('br').replaceWith('\n');
  $('p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article, header, footer, nav, aside, main, dd, dt, blockquote, pre, figcaption, ul, ol, table, form').each((_, el) => { $(el).append('\n'); });
  $('td, th, a, button, span, label').each((_, el) => { $(el).append(' '); });

  const lines = [];
  const seen = new Set();
  for (const raw of ($('body').text() || $.root().text()).split('\n')) {
    const line = clean(raw);
    if (!line || line.length < 2 || seen.has(line)) continue;
    seen.add(line); lines.push(line);
  }
  for (const m of lines.join(' ').matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+\w/g)) if (!/\.(png|jpe?g|webp|svg)$/i.test(m[0])) emails.add(m[0]);

  return {
    url, title, description, siteName, themeColor, favicon, lang, headings, lines, forms, jsonld,
    links: dedupeLinks(links).slice(0, 300), navLinks: dedupeLinks(navLinks).slice(0, 60),
    contacts: { emails: [...emails].slice(0, 10), phones: [...phones].slice(0, 10), social: [...social].slice(0, 12) },
  };
}

function dedupeLinks(list) {
  const seen = new Set();
  return list.filter(l => !seen.has(l.url) && seen.add(l.url));
}

// ---------- headless rendering for JS-only and bot-checked sites ----------
// Uses the full `playwright` package if installed, otherwise `playwright-core` driving the
// Chrome or Edge already on this machine (no browser download needed).

const BROWSER_PATHS = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

let browserPromise = null;
let browserMissing = false;
async function launchBrowser() {
  try {
    const { chromium } = await import('playwright');
    return await chromium.launch();
  } catch { /* full playwright not installed or no bundled browser */ }
  const { chromium } = await import('playwright-core');
  const fs = await import('node:fs');
  const executablePath = BROWSER_PATHS.find(p => { try { return fs.existsSync(p); } catch { return false; } });
  if (!executablePath) throw new Error('Cannot find module: no Chrome or Edge installed');
  return chromium.launch({ executablePath, headless: true });
}
async function getContext() {
  if (!browserPromise) browserPromise = launchBrowser().then(b => b.newContext({ locale: 'en-IN', viewport: { width: 1280, height: 900 } }));
  return browserPromise;
}

async function renderWithBrowser(url, { timeout = 12000 } = {}) {
  if (!config.renderJs || browserMissing) return null;
  try {
    const ctx = await getContext();
    const page = await ctx.newPage();
    try {
      // Don't wait for every image and tracker: the HTML and links are enough to learn the page
      await page.route('**/*', r => (/^(image|media|font)$/.test(r.request().resourceType()) ? r.abort() : r.continue()));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      await page.waitForFunction(() => document.querySelectorAll('a[href]').length > 15 && document.body.innerText.length > 600, null, { timeout: 6000 }).catch(() => {});
      return { html: await page.content(), url: page.url() };
    } finally { await page.close().catch(() => {}); }
  } catch (e) {
    if (/Cannot find (package|module)/i.test(e.message)) browserMissing = true;
    return null;
  }
}

export async function closeBrowser() {
  if (browserPromise) {
    const p = browserPromise; browserPromise = null;
    try { await (await p).browser().close(); } catch { /* already closed */ }
  }
}

// A home page with almost no text or links is a JS app or a bot check (e.g. Amazon's 202 page)
const looksEmpty = page => page.lines.join(' ').length < 300 || page.links.length < 3;

/** Other pages only need their basics: title, description, headings and the opening text. */
function basics(page, maxChars = 1800) {
  const keep = [];
  let n = 0;
  for (const l of page.lines) { if (n + l.length > maxChars) break; keep.push(l); n += l.length + 1; }
  page.lines = keep;
  return page;
}

// ---------- crawl ----------

/**
 * Start from the home page and read it fully, then pick up the basics of the pages it links to
 * (navigation first), all inside a fixed time budget so a scan finishes in well under a minute.
 */
export async function crawl(inputUrl, { maxPages = config.maxPages, seconds = config.crawlSeconds, onProgress = () => {} } = {}) {
  let start = inputUrl.trim();
  if (!/^https?:\/\//i.test(start)) start = 'https://' + start;
  start = normalizeUrl(start);
  if (!start) throw new Error('That does not look like a valid URL');

  const t0 = Date.now();
  const deadline = t0 + seconds * 1000;
  const stop = new AbortController();
  const stopTimer = setTimeout(() => stop.abort(), seconds * 1000);
  const left = () => deadline - Date.now();

  onProgress({ stage: 'crawl', message: `Opening ${new URL(start).hostname}…` });
  // Home page and robots.txt load together
  const startOrigin = new URL(start).origin;
  const robotsP = fetchText(`${startOrigin}/robots.txt`, { timeout: 5000, accept: 'text/plain,*/*', signal: stop.signal })
    .then(r => (r.ok && !/<html/i.test(r.text) ? parseRobots(r.text) : parseRobots('')))
    .catch(() => parseRobots(''));
  let first = await fetchText(start, { timeout: 12000, signal: stop.signal }).catch(e => ({ ok: false, status: 0, error: e }));
  if (!first.ok) {
    // Some sites never answer a plain request; try once in a real browser before giving up
    onProgress({ stage: 'crawl', message: 'The site is slow to answer, opening it in a browser…' });
    const r = await renderWithBrowser(start, { timeout: Math.max(5000, Math.min(15000, left())) });
    if (r) first = { ok: true, status: 200, url: r.url, type: 'text/html', text: r.html, viaBrowser: true };
  }
  if (!first.ok) {
    clearTimeout(stopTimer); await closeBrowser();
    if (first.error) throw new Error(`Could not reach the site: ${first.error.cause?.code || first.error.message}`);
    throw new Error(`The site responded with HTTP ${first.status}`);
  }
  const robots = await robotsP;

  let origin = new URL(first.url).origin;
  let host = new URL(first.url).hostname;

  // Priority buckets: 0 = start, 1 = navigation links, 2 = in-page links, 3 = sitemap
  const buckets = [[], [], [], []];
  const seen = new Set();
  const enqueue = (url, prio) => {
    const n = normalizeUrl(url);
    if (!n || seen.has(n)) return;
    const u = new URL(n);
    if (!sameSite(u.hostname, host) || SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname + u.search)) return;
    if (!robots.allowed(u.pathname + u.search)) return;
    seen.add(n); buckets[prio].push(n);
  };
  const next = () => { for (const b of buckets) if (b.length) return b.shift(); return null; };

  const pages = []; const finalSeen = new Set(); const contentSeen = new Set();
  let inflight = 0, failures = 0, rendered = 0, useBrowser = false;

  function accept(page, finalUrl) {
    if (!sameSite(new URL(finalUrl).hostname, host) || finalSeen.has(finalUrl)) return null;
    finalSeen.add(finalUrl);
    const sig = page.lines.slice(0, 40).join('|');
    if (sig && contentSeen.has(sig)) return null;
    contentSeen.add(sig);
    return page;
  }

  async function processUrl(url) {
    if (useBrowser) {
      const r = await renderWithBrowser(url, { timeout: Math.max(3000, Math.min(12000, left())) });
      if (!r) return null;
      rendered++;
      const finalUrl = normalizeUrl(r.url) || url;
      return accept(basics(extractPage(r.html, finalUrl)), finalUrl);
    }
    const res = await fetchText(url, { timeout: Math.max(2000, Math.min(8000, left())), signal: stop.signal });
    if (!res.ok || !/html/i.test(res.type)) return null;
    const finalUrl = normalizeUrl(res.url) || url;
    return accept(basics(extractPage(res.text, finalUrl)), finalUrl);
  }

  // ---- the home page, read in full ----
  seen.add(start);
  let home = extractPage(first.text, normalizeUrl(first.url) || start);
  if (looksEmpty(home)) {
    onProgress({ stage: 'crawl', message: 'This site builds its pages with JavaScript, opening it in a browser…' });
    const r = await renderWithBrowser(first.url, { timeout: Math.max(5000, Math.min(15000, left())) });
    if (r) {
      const h = extractPage(r.html, normalizeUrl(r.url) || first.url);
      if (!looksEmpty(h) || h.lines.length > home.lines.length) { home = h; rendered++; useBrowser = true; origin = new URL(r.url).origin; host = new URL(r.url).hostname; }
    }
  }
  if (first.viaBrowser) { useBrowser = true; rendered++; }
  const blocked = /^\s*(4\d\d|5\d\d)\b|service unavailable|access denied|request blocked|robot check|are you a (human|robot)|captcha|attention required|just a moment/i;
  if ((!home.lines.length && !home.links.length) || (blocked.test(home.title || '') && home.links.length < 15)) {
    clearTimeout(stopTimer); await closeBrowser();
    throw new Error(`${host.replace(/^www\./, '')} blocks automated visits, so it can't be scanned. Try another site, or one you own.`);
  }
  finalSeen.add(home.url);
  contentSeen.add(home.lines.slice(0, 40).join('|'));
  pages.push(home);
  onProgress({ stage: 'crawl', message: `Read the home page: ${home.title || home.url}`, pages: pages.length, total: maxPages });
  home.navLinks.forEach(l => enqueue(l.url, 1));
  home.links.forEach(l => enqueue(l.url, 2));

  // ---- sitemap in the background: only fills gaps if the home page links to few pages ----
  let sitemapPending = true;
  (async () => {
    try {
      if (seen.size > maxPages * 2) return;
      const sitemapUrls = robots.sitemaps.length ? robots.sitemaps.slice(0, 2) : [`${origin}/sitemap.xml`];
      const found = await Promise.race([readSitemaps(sitemapUrls, host, maxPages * 2), new Promise(r => setTimeout(() => r([]), Math.min(6000, Math.max(0, left()))))]);
      found.forEach(u => enqueue(u, 3));
    } catch { /* no sitemap */ } finally { sitemapPending = false; }
  })();

  // ---- linked pages: basics only, many at once, until the time budget runs out ----
  const concurrency = useBrowser ? 4 : 10;
  async function worker() {
    while (true) {
      if (pages.length >= maxPages || left() < 1500) return;
      if (pages.length + inflight >= maxPages) { if (!inflight) return; await sleep(80); continue; }
      const url = next();
      if (!url) { if (!inflight && !sitemapPending) return; await sleep(80); continue; }
      inflight++;
      try {
        const page = await processUrl(url);
        if (page && pages.length < maxPages) {
          pages.push(page);
          onProgress({ stage: 'crawl', message: `Read ${page.title || new URL(page.url).pathname}`, pages: pages.length, total: maxPages });
          page.navLinks.forEach(l => enqueue(l.url, 1));
        }
      } catch { failures++; }
      finally { inflight--; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  clearTimeout(stopTimer);
  stop.abort();
  await closeBrowser();

  return {
    origin, host, startUrl: home.url, pages,
    stats: { failures, rendered, sitemapUrls: 0, discovered: seen.size, seconds: Math.round((Date.now() - t0) / 100) / 10 },
  };
}
