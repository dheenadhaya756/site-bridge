import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { SearchIndex } from './search.js';

const cache = new Map(); // id -> { site, index }
const ID_RE = /^[a-z0-9-]{1,63}$/;

const fileFor = id => path.join(config.dataDir, `${id}.json`);

// On Vercel, sites live in Blob storage so every server sees every scan
const useBlob = Boolean(config.onVercel && process.env.BLOB_READ_WRITE_TOKEN);
let blobLib = null;
const blob = async () => (blobLib ||= await import('@vercel/blob'));
const summary = s => ({ id: s.id, name: s.manifest.name, url: s.startUrl, favicon: s.favicon, createdAt: s.createdAt, pages: s.stats.pages });
async function blobPut(pathname, data) {
  const { put } = await blob();
  await put(pathname, JSON.stringify(data), { access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60 });
}
async function blobGet(pathname) {
  const { head } = await blob();
  try {
    const { url } = await head(pathname);
    const res = await fetch(url, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

// First use on a fresh server: copy the bundled example sites into the writable folder
let seeded = false;
async function seed() {
  if (seeded) return;
  seeded = true;
  if (config.bundledDataDir === config.dataDir) return;
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    for (const f of await fs.readdir(config.bundledDataDir)) {
      if (!f.endsWith('.json')) continue;
      const to = path.join(config.dataDir, f);
      try { await fs.access(to); } catch { await fs.copyFile(path.join(config.bundledDataDir, f), to); }
    }
  } catch { /* nothing bundled */ }
}

export async function saveSite(site) {
  cache.set(site.id, { site, index: new SearchIndex(site.chunks) });
  try { await fs.mkdir(config.dataDir, { recursive: true }); await fs.writeFile(fileFor(site.id), JSON.stringify(site)); } catch { /* read-only */ }
  if (useBlob) await Promise.all([blobPut(`sites/${site.id}.json`, site), blobPut(`index/${site.id}.json`, summary(site))]);
}

async function load(id) {
  if (!ID_RE.test(id || '')) return null;
  await seed();
  if (cache.has(id)) return cache.get(id);
  let site = null;
  try { site = JSON.parse(await fs.readFile(fileFor(id), 'utf8')); } catch { /* not on this server */ }
  if (!site && useBlob) site = await blobGet(`sites/${id}.json`);
  if (!site) return null;
  const entry = { site, index: new SearchIndex(site.chunks) };
  cache.set(id, entry);
  return entry;
}

export async function getSite(id) { return (await load(id))?.site || null; }
export async function getIndex(id) { return (await load(id))?.index || null; }

export async function listSites() {
  await seed();
  try {
    const files = (await fs.readdir(config.dataDir).catch(() => [])).filter(f => f.endsWith('.json'));
    const local = (await Promise.all(files.map(f => getSite(f.slice(0, -5))))).filter(Boolean).map(summary);
    let shared = [];
    if (useBlob) {
      const { list } = await blob();
      const { blobs } = await list({ prefix: 'index/', limit: 200 });
      shared = (await Promise.all(blobs.map(b => fetch(b.url, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null)))).filter(Boolean);
    }
    const byId = new Map([...local, ...shared].map(s => [s.id, s]));
    return [...byId.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  } catch { return []; }
}

export async function deleteSite(id) {
  if (!ID_RE.test(id || '')) return;
  cache.delete(id);
  await fs.rm(fileFor(id), { force: true });
  if (useBlob) { const { del } = await blob(); await del([`sites/${id}.json`, `index/${id}.json`]).catch(() => {}); }
}
