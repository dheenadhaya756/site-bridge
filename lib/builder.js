import crypto from 'node:crypto';
import { crawl } from './crawler.js';
import { generate, costOf, parseJson, hasKey } from './gemini.js';
import { config } from './config.js';
import { bareHost } from './net.js';
import { saveSite } from './store.js';

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

function makeId(host) {
  const slug = bareHost(host).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return `${slug}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Lines repeated on most pages (menus, footers) are stored once instead of on every page. */
function splitBoilerplate(pages) {
  const freq = new Map();
  for (const p of pages) for (const l of new Set(p.lines)) freq.set(l, (freq.get(l) || 0) + 1);
  const threshold = pages.length >= 4 ? Math.ceil(pages.length * 0.5) : Infinity;
  const boiler = new Set([...freq].filter(([l, n]) => n >= threshold && l.length > 1).map(([l]) => l));
  const shared = pages[0].lines.filter(l => boiler.has(l));
  for (const p of pages) p.text = p.lines.filter(l => !boiler.has(l)).join('\n');
  return shared.join('\n');
}

function chunkPages(pages, shared) {
  const chunks = [];
  const push = (page, text) => chunks.push({ id: chunks.length, url: page.url, title: page.title, text });
  for (const p of pages) {
    let buf = p.description ? p.description + '\n' : '';
    for (const line of p.text.split('\n')) {
      if (buf.length + line.length > 900 && buf.length > 200) { push(p, buf.trim()); buf = ''; }
      buf += line + '\n';
    }
    if (buf.trim()) push(p, buf.trim());
  }
  if (shared) push({ url: pages[0].url, title: 'Site-wide header & footer' }, clip(shared, 3000));
  return chunks;
}

function summarizeJsonLd(pages) {
  const out = [];
  const walk = (node, url) => {
    if (!node || typeof node !== 'object' || out.length > 40) return;
    if (Array.isArray(node)) return node.forEach(n => walk(n, url));
    if (node['@graph']) return walk(node['@graph'], url);
    const type = [].concat(node['@type'] || []).join('/');
    if (type && !/^(WebPage|WebSite|BreadcrumbList|ImageObject|SiteNavigationElement|ListItem|SearchAction|ReadAction)$/.test(type)) {
      const bits = [type, node.name, node.description && clip(node.description, 160)];
      const offer = [].concat(node.offers || [])[0];
      if (offer?.price) bits.push(`price ${offer.priceCurrency || ''} ${offer.price}`);
      if (node.telephone) bits.push(`tel ${node.telephone}`);
      if (node.address) bits.push(`address ${typeof node.address === 'string' ? node.address : [node.address.streetAddress, node.address.addressLocality, node.address.addressCountry].filter(Boolean).join(', ')}`);
      if (node.openingHours) bits.push(`hours ${[].concat(node.openingHours).join('; ')}`);
      out.push(`- ${bits.filter(Boolean).join(' | ')} (${url})`);
    }
  };
  for (const p of pages) for (const j of p.jsonld) walk(j, p.url);
  return [...new Set(out)].join('\n');
}

function buildDigest(crawlResult, shared) {
  const { pages } = crawlResult;
  const budget = config.digestChars;
  const per = Math.max(500, Math.floor((budget - 6000) / pages.length));
  const parts = [`SITE: ${crawlResult.origin}`];
  const ld = summarizeJsonLd(pages);
  if (ld) parts.push(`STRUCTURED DATA:\n${clip(ld, 3000)}`);
  if (shared) parts.push(`SITE-WIDE HEADER/FOOTER TEXT:\n${clip(shared, 2000)}`);
  for (const p of pages) {
    const forms = p.forms.map(f => `form "${f.heading || f.submit}" fields: ${f.fields.map(x => x.label || x.name).join(', ')}`).join('; ');
    parts.push([
      `--- PAGE ${p.url}`,
      `title: ${p.title}`,
      p.description && `description: ${p.description}`,
      p.headings.length && `headings: ${p.headings.slice(0, 12).map(h => h.text).join(' | ')}`,
      forms && `forms: ${forms}`,
      clip(p.text, per),
    ].filter(Boolean).join('\n'));
  }
  return clip(parts.join('\n\n'), budget);
}

const MANIFEST_PROMPT = `You are converting a website into an "agent-ready" knowledge pack that an AI agent and an MCP server will use.
Using ONLY the crawled content provided, return JSON with exactly this shape:
{
  "name": "brand or business name",
  "tagline": "one short line",
  "category": "e.g. SaaS, restaurant, e-commerce, agency, education, healthcare, portfolio",
  "summary": "3-5 sentences: what they do, for whom, what makes them different",
  "audience": "who the site serves",
  "tone": "how the brand talks, in a few words",
  "key_facts": ["concrete facts: offerings, prices, hours, locations, numbers, policies (max 20)"],
  "offerings": [{"name": "", "description": "", "price": "", "url": ""}],
  "pages": [{"url": "", "title": "", "purpose": "what a visitor finds or does here"}],
  "tasks": [{"id": "snake_case_id", "name": "e.g. Book a demo", "description": "", "start_url": "", "steps": ["step 1", "step 2"]}],
  "faqs": [{"q": "", "a": "", "url": ""}],
  "contact": {"email": "", "phone": "", "address": "", "hours": "", "social": []},
  "greeting": "the on-site agent's first message, 1-2 sentences, in the brand's voice",
  "suggested_questions": ["4 short things a visitor would ask or ask the agent to do"]
}
Rules: never invent facts; use "" or [] when unknown. Every URL must be one that appears in the crawl.
"pages": the most important pages (max 30). "tasks": real actions a visitor can take on this site (max 10).
"offerings" max 20, "faqs" max 12 with answers grounded in the content. Write in the site's primary language.`;

function fallbackManifest(crawlResult, shared) {
  const home = crawlResult.pages[0];
  const name = home.siteName || home.title.split(/[|\-–—:]/)[0].trim() || bareHost(crawlResult.host);
  const c = crawlResult.pages.reduce((acc, p) => {
    p.contacts.emails.forEach(e => acc.emails.add(e)); p.contacts.phones.forEach(e => acc.phones.add(e)); p.contacts.social.forEach(e => acc.social.add(e));
    return acc;
  }, { emails: new Set(), phones: new Set(), social: new Set() });
  return {
    name, tagline: home.description, category: '', summary: home.description || clip(home.text, 400), audience: '', tone: 'friendly',
    key_facts: [], offerings: [],
    pages: crawlResult.pages.map(p => ({
      url: p.url, title: p.title,
      purpose: (p !== home && p.description === home.description ? '' : p.description) || p.headings.slice(0, 3).map(h => h.text).join(' · '),
    })),
    tasks: [], faqs: [],
    contact: { email: [...c.emails][0] || '', phone: [...c.phones][0] || '', address: '', hours: '', social: [...c.social] },
    greeting: `Hi! I'm the ${name} assistant. Ask me anything about this site, or tell me where you want to go.`,
    suggested_questions: ['What do you offer?', 'Show me your pricing', 'How can I contact you?', 'Take me to the about page'],
  };
}

function sanitizeManifest(m, crawlResult) {
  const known = new Set(crawlResult.pages.map(p => p.url));
  const arr = v => (Array.isArray(v) ? v : []);
  m.key_facts = arr(m.key_facts).filter(x => typeof x === 'string').slice(0, 20);
  m.offerings = arr(m.offerings).slice(0, 20);
  m.pages = arr(m.pages).filter(p => p && p.url).slice(0, 30);
  if (!m.pages.length) m.pages = crawlResult.pages.map(p => ({ url: p.url, title: p.title, purpose: p.description }));
  m.tasks = arr(m.tasks).filter(t => t && t.name).slice(0, 10).map((t, i) => ({
    ...t,
    id: String(t.id || t.name || `task_${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || `task_${i}`,
    steps: arr(t.steps).map(String),
  }));
  m.faqs = arr(m.faqs).slice(0, 12);
  m.contact = m.contact && typeof m.contact === 'object' ? m.contact : {};
  m.suggested_questions = arr(m.suggested_questions).slice(0, 4);
  m.unverifiedUrls = m.pages.filter(p => !known.has(p.url)).length;
  return m;
}

/** Full pipeline: crawl -> dedupe -> chunk -> Gemini manifest -> save. */
export async function buildSite(url, { maxPages, onProgress = () => {} } = {}) {
  const t0 = Date.now();
  const result = await crawl(url, { maxPages, onProgress });
  const shared = splitBoilerplate(result.pages);
  const chunks = chunkPages(result.pages, shared);
  onProgress({ stage: 'understand', message: `Crawled ${result.pages.length} pages into ${chunks.length} knowledge chunks` });

  let manifest, usage = { input: 0, output: 0 }, model = null;
  if (hasKey()) {
    onProgress({ stage: 'understand', message: 'Our AI is reading the site and mapping what visitors can do…' });
    try {
      const digest = buildDigest(result, shared);
      // One retry: an occasional bad or failed reply shouldn't cost the whole knowledge base
      for (let attempt = 1; attempt <= 2 && !manifest; attempt++) {
        try {
          const r = await generate({
            system: MANIFEST_PROMPT,
            contents: [{ role: 'user', parts: [{ text: digest }] }],
            json: true, temperature: 0.2, maxOutputTokens: 8192,
          });
          usage = { input: usage.input + r.usage.input, output: usage.output + r.usage.output };
          const parsed = parseJson(r.text);
          if (!parsed) {
            console.error(`[understand] unreadable JSON (attempt ${attempt}): finish=${r.finishReason} chars=${r.text.length}`);
            throw new Error('Gemini returned unreadable JSON');
          }
          model = r.model;
          manifest = sanitizeManifest(parsed, result);
        } catch (e) {
          if (e.code === 'BUDGET' || attempt === 2) throw e;
          console.error(`[understand] attempt ${attempt} failed: ${e.message}, retrying`);
        }
      }
    } catch (e) {
      console.error('[understand]', e.message);
      onProgress({ stage: 'understand', message: e.code === 'BUDGET' ? `${e.message} A basic profile was built instead.` : 'The AI step is unavailable right now, so a basic profile was built. Try re-scanning shortly.', level: 'warn' });
    }
  } else {
    onProgress({ stage: 'understand', message: 'The AI engine is offline, so a basic profile was built.', level: 'warn' });
  }
  manifest ||= sanitizeManifest(fallbackManifest(result, shared), result);
  manifest.ai = Boolean(model);

  onProgress({ stage: 'tools', message: 'Generating MCP tools, llms.txt and the live agent…' });
  const home = result.pages[0];
  const cost = costOf(usage);
  const site = {
    id: makeId(result.host),
    inputUrl: url,
    startUrl: result.startUrl,
    origin: result.origin,
    hostname: result.host,
    favicon: home.favicon,
    themeColor: /^#[0-9a-f]{3,8}$/i.test(home.themeColor || '') ? home.themeColor : null,
    lang: home.lang,
    createdAt: new Date().toISOString(),
    manifest,
    shared,
    pages: result.pages.map(p => ({
      url: p.url, title: p.title, description: p.description, headings: p.headings, text: p.text, forms: p.forms,
    })),
    chunks,
    stats: { ...result.stats, pages: result.pages.length, chunks: chunks.length, ms: Date.now() - t0 },
    cost: { model, inputTokens: usage.input, outputTokens: usage.output, usd: cost.usd, inr: cost.inr },
  };
  await saveSite(site);
  return site;
}
