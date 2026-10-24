import { config } from './config.js';
import { reserve, record } from './budget.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const FALLBACKS = ['gemini-flash-lite-latest', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-2.5-flash'];
const resolved = new Map(); // requested model -> model that actually worked
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Chat safety filters. Blocked replies are replaced by a polite message in agent.js.
const SAFETY_SETTINGS = ['HARM_CATEGORY_HARASSMENT', 'HARM_CATEGORY_HATE_SPEECH', 'HARM_CATEGORY_SEXUALLY_EXPLICIT', 'HARM_CATEGORY_DANGEROUS_CONTENT']
  .map(category => ({ category, threshold: 'BLOCK_MEDIUM_AND_ABOVE' }));
const BLOCKED_FINISH = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII']);

export const hasKey = () => Boolean(config.geminiKey);

/**
 * One generateContent call over REST. Returns the raw parts (kept intact so thought
 * signatures survive multi-turn function calling), the plain text and token usage.
 */
export async function generate({ model = config.geminiModel, system, contents, tools, json = false, temperature = 0.3, maxOutputTokens, safety = false }) {
  if (!config.geminiKey) throw new Error('GEMINI_API_KEY is not set. Add it to the .env file and restart the server.');
  const body = { contents, generationConfig: { temperature } };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools?.length) body.tools = [{ functionDeclarations: tools }];
  if (json) body.generationConfig.responseMimeType = 'application/json';
  if (maxOutputTokens) body.generationConfig.maxOutputTokens = maxOutputTokens;
  if (safety) body.safetySettings = SAFETY_SETTINGS;

  const payload = JSON.stringify(body);
  reserve(payload.length); // daily ₹ cap: refuse before spending anything
  const candidates = resolved.has(model) ? [resolved.get(model)] : [model, ...FALLBACKS.filter(m => m !== model)];
  let lastErr;
  for (const m of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${BASE}/${m}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': config.geminiKey },
        body: payload,
        signal: AbortSignal.timeout(90000),
      });
      if (res.status === 404) { lastErr = new Error(`Gemini model "${m}" is not available`); break; }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) { await sleep(1200 * (attempt + 1)); continue; }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Gemini error ${res.status}: ${data.error?.message || res.statusText}`);
      resolved.set(model, m);
      const cand = data.candidates?.[0];
      const parts = cand?.content?.parts || [];
      const u = data.usageMetadata || {};
      record(u.promptTokenCount || 0, (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0));
      return {
        parts,
        text: parts.filter(p => p.text && !p.thought).map(p => p.text).join(''),
        usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
        model: m,
        finishReason: cand?.finishReason,
        blocked: data.promptFeedback?.blockReason || (BLOCKED_FINISH.has(cand?.finishReason) ? cand.finishReason : undefined),
      };
    }
  }
  throw lastErr || new Error('Gemini request failed');
}

export function costOf(usage) {
  const usd = (usage.input / 1e6) * config.priceIn + (usage.output / 1e6) * config.priceOut;
  return { usd, inr: usd * config.usdInr };
}

export function parseJson(text) {
  const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}
