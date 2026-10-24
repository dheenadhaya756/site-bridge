// The on-site agent. Server tools run here; UI tools are handed back to the browser,
// which runs them in the live page and posts the results on the next request.
// Guardrails (input validation, signed history, prompt-injection and leak defences,
// tool argument checks) live in guardrails.js and are applied at every step below.
import { generate } from './gemini.js';
import { config } from './config.js';
import { searchSite, getPage } from './knowledge.js';
import { supportHandoff } from './agenticorg.js';
import { saveHandoff } from './usage.js';
import {
  verifyHistory, signHistory, screenMessage, checkClientTool, sanitizeReply,
  leakWindows, guardrailRules, politeReplies, cleanText,
} from './guardrails.js';

const str = (description) => ({ type: 'string', description });
const num = (description) => ({ type: 'number', description });
const LABEL = str('The exact visible text of that element as listed in the snapshot (used to double-check the id)');

export const TOOL_DECLARATIONS = [
  { name: 'search_site', description: 'Full-text search across every crawled page of this website. Use it before answering anything not covered in your instructions.', parameters: { type: 'object', properties: { query: str('Keywords to search for') }, required: ['query'] } },
  { name: 'get_page_content', description: 'Read the full crawled text and forms of a page of this site without opening it for the visitor.', parameters: { type: 'object', properties: { url: str('URL or path, e.g. /pricing') }, required: ['url'] } },
  { name: 'read_current_page', description: 'Look at the page the visitor is on right now: URL, headings, visible text and the interactive elements with their element_id. Call it before click, fill or highlight.' },
  { name: 'escalate_to_support', description: 'Pass a visitor\'s problem to the business\'s support team (via Pine Labs AgenticOrg Support Triage). Use when the visitor reports a problem with an order, payment, refund, delivery or account, or asks for a human. Returns the category, priority and team.', parameters: { type: 'object', properties: { issue: str('The visitor\'s problem in their own words, with any order number they gave'), contact: str('Email or phone the visitor shared for follow-up, if any') }, required: ['issue'] } },
  { name: 'navigate', description: 'Open a page of this website in the visitor\'s view. Returns a snapshot of the new page.', parameters: { type: 'object', properties: { url: str('URL or path on this site') }, required: ['url'] } },
  { name: 'click', description: 'Click a link or button on the current page.', parameters: { type: 'object', properties: { element_id: num('element_id from read_current_page'), label: LABEL }, required: ['element_id', 'label'] } },
  { name: 'fill', description: 'Type a value into an input, textarea or select on the current page. Only use values the visitor gave you.', parameters: { type: 'object', properties: { element_id: num('element_id from read_current_page'), value: str('Text to enter, or option to choose'), label: LABEL }, required: ['element_id', 'value', 'label'] } },
  { name: 'highlight', description: 'Point at an element so the visitor sees it: scrolls to it, draws a highlight and shows a short note.', parameters: { type: 'object', properties: { element_id: num('element_id from read_current_page'), note: str('Short note shown next to it (max 8 words)'), label: LABEL }, required: ['element_id', 'label'] } },
  { name: 'scroll', description: 'Scroll the current page.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] } }, required: ['direction'] } },
  { name: 'go_back', description: 'Go back to the previous page in the visitor\'s view.' },
];

const SERVER_TOOLS = new Set(['search_site', 'get_page_content', 'escalate_to_support']);
const SNAPSHOT_TOOLS = new Set(['read_current_page', 'navigate', 'click', 'go_back']);
const KNOWN_TOOLS = new Set(TOOL_DECLARATIONS.map(t => t.name));
const SNAPSHOT_SYNTAX = /\s*\[\d+\]\s+[\w:-]+\s+"[^"\n]*"/g;

function siteFacts(site, currentUrl, title) {
  const m = site.manifest;
  const c = m.contact || {};
  const list = (arr, f) => arr.map(f).filter(Boolean).join('\n');
  return `You are the built-in AI agent of the website "${m.name}" (${site.origin}). You live in a side panel next to the live site, and you can answer questions AND operate the website for the visitor: open pages, scroll, highlight things, click and fill in forms.

ABOUT THE SITE
${m.summary || m.tagline || ''}
${m.audience ? `Audience: ${m.audience}` : ''}

KEY FACTS
${list(m.key_facts, f => `- ${f}`) || '- (none extracted, use search_site)'}

${m.offerings.length ? `OFFERINGS\n${list(m.offerings, o => `- ${o.name}${o.price ? ` (${o.price})` : ''}: ${o.description || ''} ${o.url || ''}`)}\n` : ''}
PAGES
${list(m.pages, p => `- ${p.url} : ${p.title || ''}${p.purpose ? ` (${p.purpose})` : ''}`)}

${m.tasks.length ? `THINGS VISITORS CAN DO\n${list(m.tasks, t => `- ${t.name}${t.start_url ? ` [start: ${t.start_url}]` : ''}: ${t.steps.join(' > ')}`)}\n` : ''}
CONTACT
${[c.email && `Email: ${c.email}`, c.phone && `Phone: ${c.phone}`, c.address && `Address: ${c.address}`, c.hours && `Hours: ${c.hours}`].filter(Boolean).join('\n') || 'Not listed.'}

THE VISITOR IS ON: ${currentUrl || site.startUrl}${title ? ` ("${title}")` : ''}`;
}

function workRules(site) {
  const m = site.manifest;
  return `HOW TO WORK
- Ground every answer in this site's content. If the facts above don't cover it, call search_site or get_page_content first. Never invent prices, policies, features or availability. If the site doesn't say, tell them and point to the contact options.
- Be a guide, not a search box. When the visitor wants to see, find or do something, take them there: navigate, then highlight the relevant element with a short note. Element ids come from the "elements" list of the latest snapshot (read_current_page; navigate and page-changing clicks already return one), written as [id] type "text". Snapshot ids and syntax are internal: never write them in replies. Never guess an id: find the line whose text matches what you want and use that id plus its text as label. If nothing matches, call read_current_page or scroll first. Ids change after every page load.
- When the visitor asks you to show, find or point out something, your last action before replying must be highlight on that element (a heading, card, button or label naming it). Prefer read_current_page over repeated scrolling to locate it.
- For multi-step tasks (sign up, book, enquire, buy), walk through them in the UI: open the right page, fill in only details the visitor gave you, highlight the next step. Ask for confirmation before any final submit, purchase or payment, and never make up personal details.
- SUPPORT HAND-OFF: if the visitor reports a problem with an order, payment, refund, delivery or their account, or asks for a human, call escalate_to_support with their words (ask for an email or phone for follow-up if they haven't given one, but don't block on it). Then tell them which team has it and how urgent it was marked. Never promise a refund, a timeline or an outcome.
- Keep replies short (1-4 sentences or a tight list), warm, in the brand's tone${m.tone ? ` (${m.tone})` : ''}. Reply in the visitor's language. Link to pages with markdown links using full URLs.`;
}

/** Returns the full system prompt plus the rules-only part used for leak detection. */
// Languages the chat panel offers; anything else is ignored
const LANGUAGES = new Set(['English', 'Hindi', 'Tamil', 'Telugu', 'Kannada', 'Malayalam', 'Bengali', 'Marathi', 'Gujarati', 'Punjabi', 'Urdu', 'Spanish', 'French', 'German', 'Arabic', 'Chinese', 'Japanese']);

function systemPrompt(site, currentUrl, title, lang) {
  const language = LANGUAGES.has(lang) ? `\n- LANGUAGE: the visitor chose ${lang}. Always reply in ${lang}, even if they type in another language or the site is in English. Keep product names, prices and links as they are.` : '';
  const rules = `${workRules(site)}${language}\n\n${guardrailRules(site)}`;
  return { text: `${siteFacts(site, currentUrl, title)}\n\n${rules}`, rules };
}

/** Keep only the two most recent page snapshots in the history to control token cost. */
function compact(contents) {
  let seen = 0;
  for (let i = contents.length - 1; i >= 0; i--) {
    for (const part of contents[i].parts || []) {
      const fr = part.functionResponse;
      if (!fr || !SNAPSHOT_TOOLS.has(fr.name)) continue;
      if (++seen > 2 && fr.response?.page !== '[older snapshot removed]') {
        fr.response = { ok: fr.response?.ok ?? true, page: '[older snapshot removed]' };
      }
    }
  }
  // Also cap the number of turns sent
  if (contents.length > 40) contents.splice(0, contents.length - 40);
  while (contents.length && contents[0].role !== 'user') contents.shift();
  while (contents.length && contents[0].parts?.some(p => p.functionResponse)) contents.shift();
}

async function runServerTool(site, index, name, args) {
  if (name === 'escalate_to_support') {
    const issue = cleanText(args.issue, 1500), contact = cleanText(args.contact, 200);
    if (!issue) return { ok: false, error: 'Describe the problem first.' };
    try {
      const h = await supportHandoff({ site, issue, contact });
      saveHandoff({ siteId: site.id, issue, contact, ...h }).catch(e => console.error('[handoff] save', e.message));
      return { ok: true, passed_to: h.team || 'the support team', priority: h.priority || 'normal', category: h.category || null, note: 'Logged for the team. Do not promise outcomes or timelines.' };
    } catch (e) {
      console.error('[handoff]', e.message);
      return { ok: false, error: 'The support hand-off is unavailable right now. Point the visitor to the contact details instead.' };
    }
  }
  if (name === 'search_site') return { results: searchSite(site, index, cleanText(args.query, 300), 5) };
  if (name === 'get_page_content') return getPage(site, String(args.url || '').slice(0, 2000), 5000);
  return { error: `Unknown tool ${name}` };
}

export function toResponsePart(slot) {
  const r = slot.response;
  const response = r && typeof r === 'object' && !Array.isArray(r) ? r : { result: r ?? null };
  return { functionResponse: { name: slot.name, ...(slot.id ? { id: slot.id } : {}), response } };
}

const fail = (message, code) => Object.assign(new Error(message), { code });

export async function chatTurn(site, index, { contents, token, currentUrl, title, lang }) {
  const name = site.manifest.name;
  const polite = politeReplies(name);

  // 1. Only trust history this server signed; drop forged turns and oversized or stray tool results
  const verified = verifyHistory(contents, token, { maxText: config.chatMaxChars });
  if (verified.expired) throw fail(polite.expired, 'EXPIRED');
  if (verified.flag) console.warn(`[guard] history ${verified.flag} site=${site.id}`);
  contents = verified.contents;
  if (!contents.length) throw fail('A message is required.', 'BAD_REQUEST');
  compact(contents);
  const finish = extra => ({ contents, ...extra, token: signHistory(contents) });

  // 2. Prompt-extraction and jailbreak attempts get a polite, fixed reply without calling the model
  const last = contents[contents.length - 1];
  const lastText = last.role === 'user' ? last.parts.filter(p => p.text).map(p => p.text).join('\n') : '';
  const hit = screenMessage(lastText);
  if (hit) {
    console.warn(`[guard] message ${hit} site=${site.id}`);
    const text = polite[hit];
    contents.push({ role: 'model', parts: [{ text }] });
    return finish({ steps: [], reply: text, guard: hit });
  }

  const { text: system, rules } = systemPrompt(site, currentUrl, title, lang);
  const windows = leakWindows(rules);
  const usage = { input: 0, output: 0 };
  const steps = [];
  const replies = [];

  for (let i = 0; i < 6; i++) {
    const r = await generate({ model: config.chatModel, system, contents, tools: TOOL_DECLARATIONS, temperature: 0.3, safety: true });
    usage.input += r.usage.input; usage.output += r.usage.output;
    let parts = r.parts;
    if (r.blocked) { console.warn(`[guard] blocked ${r.blocked} site=${site.id}`); parts = [{ text: polite.unsafe }]; }
    else if (!parts.length) parts = [{ text: polite.unclear }];

    // 3. Nothing reaches the visitor before it is checked: strip snapshot syntax that leaks into
    //    prose, redact anything that looks like a key, and replace replies that quote the instructions
    const raw = parts.filter(p => p.text && !p.thought).map(p => p.text).join('').replace(SNAPSHOT_SYNTAX, '').trim();
    const { text, flagged } = sanitizeReply(raw, { windows, siteName: name });
    if (flagged) {
      console.warn(`[guard] reply ${flagged} site=${site.id}`);
      let kept = false; // keep the first text part (it may carry a thought signature), drop the rest
      parts = parts.filter(p => {
        if (!p.text || p.thought) return true;
        if (kept) return false;
        kept = true; p.text = text; return true;
      });
      if (!kept) parts.push({ text });
    }
    contents.push({ role: 'model', parts });
    if (text) replies.push(text);

    const calls = parts.filter(p => p.functionCall).map(p => p.functionCall);
    if (!calls.length) break;

    // 4. Tool calls: unknown tools are refused, UI tools are checked (same site only, no sensitive fields)
    const slots = calls.map(c => ({ name: c.name, id: c.id, args: c.args && typeof c.args === 'object' ? c.args : {}, client: !SERVER_TOOLS.has(c.name) }));
    for (const s of slots) {
      if (!KNOWN_TOOLS.has(s.name)) { s.client = false; s.response = { ok: false, error: `Unknown tool ${s.name}` }; continue; }
      if (s.client) {
        const err = checkClientTool(site, s.name, s.args);
        if (err) { console.warn(`[guard] tool ${s.name} site=${site.id}`); s.client = false; s.response = { ok: false, error: err }; }
        continue;
      }
      s.response = await runServerTool(site, index, s.name, s.args);
      steps.push({ name: s.name, args: s.args });
    }
    if (slots.some(s => s.client)) {
      return finish({ pending: slots, steps, reply: replies.join('\n\n') });
    }
    contents.push({ role: 'user', parts: slots.map(toResponsePart) });
  }
  return finish({ steps, reply: replies.join('\n\n') });
}
