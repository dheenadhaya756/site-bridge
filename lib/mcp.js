// Minimal MCP server (JSON-RPC 2.0 over Streamable HTTP, stateless) generated per site.
import { searchSite, getPage, overview, uniqueForms } from './knowledge.js';

const SUPPORTED = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const toolName = s => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);

export function buildTools(site) {
  const m = site.manifest;
  const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
  const tools = [
    { name: 'get_site_overview', description: `What ${m.name} is, who it serves, key facts and contact details.`, inputSchema: obj(), run: () => overview(site) },
    {
      name: 'search_site',
      description: `Search every public page of ${site.hostname}. Returns the most relevant passages with their source URLs.`,
      inputSchema: obj({ query: { type: 'string', description: 'What to look for' }, limit: { type: 'number', description: 'Max results (default 5)' } }, ['query']),
      run: (a, index) => searchSite(site, index, a.query, a.limit),
    },
    { name: 'list_pages', description: `The important pages of ${site.hostname} and what each is for.`, inputSchema: obj(), run: () => m.pages },
    {
      name: 'get_page',
      description: 'Full text, headings and forms of one page, by URL or path (e.g. "/pricing").',
      inputSchema: obj({ url: { type: 'string', description: 'Absolute URL or path on this site' } }, ['url']),
      run: a => getPage(site, a.url),
    },
    { name: 'get_contact_info', description: `How to reach ${m.name}: email, phone, address, hours, social links.`, inputSchema: obj(), run: () => m.contact },
  ];
  if (m.offerings.length) tools.push({ name: 'list_offerings', description: `Products, services or plans offered by ${m.name}, with prices when published.`, inputSchema: obj(), run: () => m.offerings });
  if (m.faqs.length) tools.push({ name: 'list_faqs', description: `Frequently asked questions about ${m.name}, answered from the site.`, inputSchema: obj(), run: () => m.faqs });

  const used = new Set(tools.map(t => t.name));
  const add = t => { if (!t.name || used.has(t.name)) return; used.add(t.name); tools.push(t); };
  for (const t of m.tasks) {
    add({
      name: toolName(`how_to_${t.id}`),
      description: `${t.name}. ${t.description || ''} Returns the steps and the page to start on.`.trim(),
      inputSchema: obj(),
      run: () => ({ task: t.name, start_url: t.start_url, steps: t.steps }),
    });
  }
  for (const f of uniqueForms(site).slice(0, 8)) {
    const isSearch = f.fields.length <= 2 && f.fields.some(x => x.type === 'search' || /^(q|s|query|search)$/i.test(x.name));
    const label = isSearch ? 'site search' : f.heading || f.submit || new URL(f.page).pathname.split('/').filter(Boolean).pop() || 'home page';
    add({
      name: toolName(`form_${label}`),
      description: `Describes the "${label}" form on ${f.page}: the fields it needs and where it lives. Read-only, it does not submit anything.`,
      inputSchema: obj(),
      run: () => ({ page: f.page, method: f.method, fields: f.fields, submit_button: f.submit }),
    });
  }
  return tools;
}

export function publicTools(site) {
  return buildTools(site).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

/** Handles one JSON-RPC message or batch. Returns null when there is nothing to send back (notifications). */
export function handleMcp(site, index, body) {
  const tools = buildTools(site);
  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  const one = msg => {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(msg?.id, -32600, 'Invalid Request');
    const { id, method, params = {} } = msg;
    if (id === undefined || id === null) return null; // notification, e.g. notifications/initialized
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: `sitebridge-${site.id}`, title: `${site.manifest.name} (Site Bridge)`, version: '0.1.0' },
          instructions: `Tools for ${site.manifest.name} (${site.origin}). ${site.manifest.summary || ''}`.trim(),
        });
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
      case 'tools/call': {
        const tool = tools.find(t => t.name === params.name);
        if (!tool) return ok(id, { content: [{ type: 'text', text: `Unknown tool: ${params.name}` }], isError: true });
        try {
          const result = tool.run(params.arguments || {}, index);
          return ok(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], isError: Boolean(result?.error) });
        } catch (e) {
          return ok(id, { content: [{ type: 'text', text: `Tool failed: ${e.message}` }], isError: true });
        }
      }
      case 'resources/list': return ok(id, { resources: [] });
      case 'prompts/list': return ok(id, { prompts: [] });
      default:
        return fail(id, -32601, `Method not found: ${method}`);
    }
  };

  if (Array.isArray(body)) {
    const out = body.map(one).filter(Boolean);
    return out.length ? out : null;
  }
  return one(body);
}
