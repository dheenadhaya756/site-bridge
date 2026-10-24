// Read-only knowledge operations shared by the MCP server and the chat agent.
import { normalizeUrl } from './crawler.js';

const clip = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

export function findPage(site, urlOrPath) {
  if (!urlOrPath) return null;
  const abs = normalizeUrl(String(urlOrPath), site.origin);
  if (!abs) return null;
  const path = new URL(abs).pathname.replace(/\/$/, '') || '/';
  return site.pages.find(p => p.url === abs) ||
    site.pages.find(p => (new URL(p.url).pathname.replace(/\/$/, '') || '/') === path) || null;
}

export function searchSite(site, index, query, limit = 5) {
  const hits = index.search(query || '', Math.min(Number(limit) || 5, 10));
  return hits.map(h => ({ url: h.url, page: h.title, excerpt: clip(h.text, 700) }));
}

export function getPage(site, urlOrPath, maxChars = 6000) {
  const p = findPage(site, urlOrPath);
  if (!p) return { error: `No crawled page matches "${urlOrPath}". Use search_site or list_pages.` };
  return {
    url: p.url, title: p.title, description: p.description,
    headings: p.headings.map(h => `${'#'.repeat(h.level)} ${h.text}`),
    text: clip(p.text, maxChars),
    forms: p.forms.map(f => ({ name: f.heading || f.submit, method: f.method, fields: f.fields })),
  };
}

export function uniqueForms(site) {
  const seen = new Set(); const out = [];
  for (const p of site.pages) for (const f of p.forms) {
    const sig = f.fields.map(x => x.name || x.label).join('|');
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(f);
  }
  return out;
}

export function overview(site) {
  const m = site.manifest;
  return {
    name: m.name, website: site.origin, tagline: m.tagline, category: m.category, summary: m.summary,
    audience: m.audience, key_facts: m.key_facts, contact: m.contact,
    things_you_can_do: m.tasks.map(t => t.name),
  };
}

export function llmsTxt(site) {
  const m = site.manifest;
  const lines = [`# ${m.name}`, '', `> ${m.summary || m.tagline || ''}`, ''];
  if (m.key_facts.length) lines.push('## Key facts', ...m.key_facts.map(f => `- ${f}`), '');
  if (m.offerings.length) lines.push('## Offerings', ...m.offerings.map(o => `- [${o.name}](${o.url || site.origin})${o.price ? ` (${o.price})` : ''}: ${o.description || ''}`), '');
  lines.push('## Pages', ...m.pages.map(p => `- [${p.title || p.url}](${p.url}): ${p.purpose || ''}`), '');
  if (m.tasks.length) lines.push('## Tasks', ...m.tasks.map(t => `- ${t.name}${t.start_url ? ` (${t.start_url})` : ''}: ${t.steps.join(' → ')}`), '');
  if (m.faqs.length) lines.push('## FAQ', ...m.faqs.map(f => `- **${f.q}** ${f.a}`), '');
  const c = m.contact || {};
  const contact = [c.email && `Email: ${c.email}`, c.phone && `Phone: ${c.phone}`, c.address && `Address: ${c.address}`, c.hours && `Hours: ${c.hours}`].filter(Boolean);
  if (contact.length) lines.push('## Contact', ...contact.map(x => `- ${x}`), '');
  return lines.join('\n');
}
