// Pine Labs AgenticOrg: push a scanned site's knowledge into the AgenticOrg knowledge base, so
// AgenticOrg agents (sales, support, operations) can answer from that client's website.
// API as used by the official agenticorg-sdk: Bearer key, POST /api/v1/knowledge/upload (multipart).
import { llmsTxt } from './knowledge.js';

const KEY = process.env.AGENTICORG_API_KEY || '';
const BASE = (process.env.AGENTICORG_BASE_URL || 'https://agenticorg.hackathon.pinelabs.com').replace(/\/$/, '');

/** Run an AgenticOrg agent by type (A2A task). Returns the run, or throws with a readable message. */
export async function runAgent(agentType, inputs, timeoutMs = 60000) {
  if (!KEY) throw new Error('AgenticOrg is not connected.');
  const r = await fetch(`${BASE}/api/v1/a2a/tasks`, {
    method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agent_type: agentType, inputs }), signal: AbortSignal.timeout(timeoutMs),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`AgenticOrg ${agentType} failed (HTTP ${r.status})`);
  return d;
}

const pick = (lines, re) => { for (const l of lines) { const m = re.exec(l); if (m) return m[1].trim().replace(/[.;]+$/, ''); } return null; };

/** Hand a visitor's problem to AgenticOrg's Support Triage agent. */
export async function supportHandoff({ site, issue, contact }) {
  const run = await runAgent('support_triage', {
    task: 'Triage this customer message from a website visitor: category, priority and the team that should handle it.',
    message: issue, customer_contact: contact || null,
    website: site.origin, business: site.manifest?.name, source: 'Site Bridge on-site AI agent',
  });
  const out = run.output || {};
  const trace = Array.isArray(out.processing_trace) ? out.processing_trace.map(String) : [];
  return {
    runId: run.run_id || run.id || null,
    status: out.status || run.status || null,
    category: pick(trace, /classified as (?:an? )?([^.,]+)/i),
    priority: pick(trace, /priority (?:assessed |set )?as ([a-z]+)/i),
    team: pick(trace, /(?:recommended )?team:\s*([^,.(]+)/i),
    summary: trace.slice(0, 3).join(' '),
    raw: out,
  };
}
export const agenticOrgReady = Boolean(KEY);

/** One readable document: the knowledge pack (llms.txt) plus the text of every page read. */
function knowledgeDocument(site) {
  const parts = [llmsTxt(site), '', '## Page content', ''];
  let size = parts.join('\n').length;
  for (const p of site.pages || []) {
    const block = `### ${p.title || p.url}\nSource: ${p.url}\n\n${(p.text || '').slice(0, 6000)}\n`;
    if (size + block.length > 400_000) break;
    parts.push(block);
    size += block.length;
  }
  return parts.join('\n');
}

const reason = (status, body) => {
  if (status === 401 || status === 403) return 'AgenticOrg did not accept the API key. Check that the key is active for this workspace.';
  if (status === 413) return 'The knowledge pack is too large for AgenticOrg.';
  return `AgenticOrg could not take the upload (HTTP ${status}). ${String(body?.detail || body?.error || '').slice(0, 160)}`.trim();
};

/** Upload (or replace) the site's knowledge document. Returns { ok, document?, error? }. */
export async function sendToAgenticOrg(site) {
  if (!KEY) return { ok: false, status: 503, error: 'AgenticOrg is not connected. Add AGENTICORG_API_KEY on the server.' };
  const text = knowledgeDocument(site);
  const filename = `${(site.hostname || site.id).replace(/[^a-z0-9.-]+/gi, '-')}-site-bridge-knowledge.md`;
  const attempt = async (name, type) => {
    const form = new FormData();
    form.append('file', new Blob([text], { type }), name);
    const r = await fetch(`${BASE}/api/v1/knowledge/upload?replace=true&allow_duplicate=false`, {
      method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: form, signal: AbortSignal.timeout(45000),
    });
    const body = await r.json().catch(() => ({}));
    return { r, body };
  };
  let { r, body } = await attempt(filename, 'text/markdown');
  if (r.status === 415 || (r.status === 400 && /type|extension|format/i.test(JSON.stringify(body)))) {
    ({ r, body } = await attempt(filename.replace(/\.md$/, '.txt'), 'text/plain'));
  }
  if (!r.ok) {
    console.error('[agenticorg] upload failed', r.status, JSON.stringify(body).slice(0, 200));
    return { ok: false, status: r.status === 401 || r.status === 403 ? 502 : 502, error: reason(r.status, body) };
  }
  return { ok: true, document: { id: body.id || body.document_id || body.document?.id || null, name: filename, chars: text.length } };
}
