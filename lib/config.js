import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try { process.loadEnvFile(path.join(root, '.env')); } catch { /* no .env yet */ }
// From .env.local (written by `vercel env pull`) take only the Supabase keys; its other values are for production
try {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split(/\r?\n/)) {
    const m = /^((?:NEXT_PUBLIC_)?SUPABASE_[A-Z_]+|POSTGRES_URL)="?(.*?)"?$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* optional */ }

const env = process.env;
// On Vercel the code folder is read-only; only /tmp can be written
const onVercel = Boolean(env.VERCEL);
const stateDir = onVercel ? '/tmp/sitebridge' : path.join(root, 'data');
const vercelUrl = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
const port = Number(env.PORT) || 4100;
const previewPort = Number(env.PREVIEW_PORT) || 4101;

export const config = {
  root,
  port,
  previewPort,
  onVercel,
  stateDir,
  publicUrl: (env.PUBLIC_URL || (onVercel && vercelUrl ? `https://${vercelUrl}` : `http://localhost:${port}`)).replace(/\/$/, ''),
  previewUrlTemplate: env.PREVIEW_URL_TEMPLATE || `http://{id}.localhost:${previewPort}`,
  geminiKey: env.GEMINI_API_KEY || '',
  geminiModel: env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  chatModel: env.GEMINI_CHAT_MODEL || env.GEMINI_MODEL || 'gemini-flash-lite-latest',
  priceIn: Number(env.GEMINI_PRICE_IN_PER_M) || 0.10,
  priceOut: Number(env.GEMINI_PRICE_OUT_PER_M) || 0.40,
  usdInr: Number(env.USD_INR) || 88,
  // Scans start at the home page and read linked pages until the time budget runs out
  maxPages: Number(env.MAX_PAGES) || 40,
  crawlSeconds: Number(env.CRAWL_SECONDS) || 25,
  digestChars: Number(env.DIGEST_CHARS) || 48000,
  allowPrivate: env.ALLOW_PRIVATE_URLS === '1',
  renderJs: env.RENDER_JS !== '0',
  dataDir: path.join(stateDir, 'sites'),
  bundledDataDir: path.join(root, 'data', 'sites'),
  // The live demo needs wildcard subdomains (a custom domain); off on plain vercel.app
  // On Vercel the live demo runs on its own address (DEMO_HOST); the client site is chosen by cookie
  demoHost: (env.DEMO_HOST || '').toLowerCase(),
  previewEnabled: !onVercel || Boolean(env.PREVIEW_URL_TEMPLATE || env.DEMO_HOST),
  // Hard cap on Gemini spend per day (India time), chat + scans. 0 turns the cap off.
  dailyBudgetInr: env.DAILY_BUDGET_INR === undefined || env.DAILY_BUDGET_INR === '' ? 10 : Number(env.DAILY_BUDGET_INR),
  // Chat guardrails (see lib/guardrails.js)
  chatSecret: env.CHAT_SECRET || '',
  chatMaxChars: Number(env.CHAT_MAX_MESSAGE_CHARS) || 2000,
  chatRatePerMin: Number(env.CHAT_RATE_PER_MIN) || 20,
  chatRatePerHour: Number(env.CHAT_RATE_PER_HOUR) || 300,
  chatSiteRatePerMin: Number(env.CHAT_SITE_RATE_PER_MIN) || 120,
  chatSiteRatePerHour: Number(env.CHAT_SITE_RATE_PER_HOUR) || 2000,
  trustProxy: env.TRUST_PROXY === '1' ? 1 : (env.TRUST_PROXY || false),
};

export function previewOriginFor(id) {
  if (config.demoHost) return `https://${config.demoHost}`;
  return config.previewUrlTemplate.replace('{id}', id);
}

/** The page that opens the live demo (address bar + site with its agent). */
export function demoPageFor(id) {
  if (config.demoHost) return `https://${config.demoHost}/__sb/preview/${id}`;
  return `${config.publicUrl}/preview/${id}`;
}
