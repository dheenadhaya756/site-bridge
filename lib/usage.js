// Anonymous usage tracking in Supabase (Postgres): visits, scans, live-demo opens and chat
// messages. Each browser gets a random visitor id; no names, emails or IP addresses are stored.
// Turns itself on when POSTGRES_URL (added by the Vercel Supabase integration) or
// SUPABASE_DB_URL is set, and does nothing otherwise.
import { waitUntil } from '@vercel/functions';

const DB_URL = process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL || process.env.DATABASE_URL || '';
export const usageEnabled = Boolean(DB_URL);

let sqlPromise = null;
async function db() {
  if (!usageEnabled) return null;
  if (!sqlPromise) {
    sqlPromise = (async () => {
      const { default: postgres } = await import('postgres');
      // prepare:false works with Supabase's pooled (transaction mode) connection
      const sql = postgres(DB_URL.replace(/[?&]supa=[^&]*/, ''), { ssl: 'require', prepare: false, max: 3, idle_timeout: 20, connect_timeout: 8 });
      await sql`create table if not exists usage_events (
        id bigserial primary key,
        at timestamptz not null default now(),
        kind text not null,
        site_id text,
        visitor text,
        country text,
        meta jsonb
      )`;
      await sql`create index if not exists usage_events_at_idx on usage_events (at desc)`;
      await sql`create index if not exists usage_events_kind_idx on usage_events (kind)`;
      await sql`alter table usage_events add column if not exists user_id uuid`;
      // Only the server (database owner) may read or write usage data; never the public API
      await sql`alter table usage_events enable row level security`;
      return sql;
    })().catch(e => { console.error('[usage] database unavailable:', e.message); sqlPromise = null; return null; });
  }
  return sqlPromise;
}

const KINDS = new Set(['visit', 'scan', 'scan_failed', 'demo_open', 'chat', 'results_view']);

// ---- signed-in users: check the Supabase access token with Supabase itself (cached briefly) ----
const AUTH_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const AUTH_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
export const authConfig = AUTH_URL && AUTH_KEY ? { url: AUTH_URL, key: AUTH_KEY } : null;
const tokenCache = new Map(); // token -> { user, until }
/** The signed-in Supabase user ({ id, email }) for this request, or null. */
export async function userFrom(req) {
  const m = /^Bearer\s+(\S{20,4096})$/.exec(String(req?.headers?.authorization || ''));
  if (!m || !authConfig) return null;
  const hit = tokenCache.get(m[1]);
  if (hit && hit.until > Date.now()) return hit.user;
  try {
    const r = await fetch(`${AUTH_URL}/auth/v1/user`, { headers: { authorization: `Bearer ${m[1]}`, apikey: AUTH_KEY }, signal: AbortSignal.timeout(4000) });
    const u = r.ok ? await r.json() : null;
    const user = u && u.id ? { id: u.id, email: u.email || null } : null;
    if (tokenCache.size > 5000) tokenCache.clear();
    tokenCache.set(m[1], { user, until: Date.now() + 5 * 60_000 });
    return user;
  } catch { return null; }
}
export async function userIdFrom(req) { return (await userFrom(req))?.id || null; }

/** Shared database connection for other modules (null when no database is set). */
export async function dbSql() { return db(); }
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

/** Record one event. Never throws and never delays the response. */
export function track(req, kind, { siteId = null, meta = null } = {}) {
  if (!usageEnabled || !KINDS.has(kind)) return;
  const visitor = clip(req?.headers?.['x-sb-visitor'] || req?.body?.visitor || null, 64);
  const country = clip(req?.headers?.['x-vercel-ip-country'] || null, 8);
  const job = (async () => {
    const sql = await db();
    if (!sql) return;
    const userId = await userIdFrom(req);
    await sql`insert into usage_events (kind, site_id, visitor, country, meta, user_id)
              values (${kind}, ${clip(siteId, 80)}, ${visitor && /^[a-z0-9-]{8,64}$/i.test(visitor) ? visitor : null}, ${country}, ${meta ? sql.json(meta) : null}, ${userId})`;
  })().catch(e => console.error('[usage] track failed:', e.message));
  try { waitUntil(job); } catch { /* not on Vercel: the promise just runs */ }
}

/** Save a support hand-off (shown on the admin dashboard). */
export async function saveHandoff(h) {
  const sql = await db();
  if (!sql) return;
  await sql`create table if not exists handoffs (
    id bigserial primary key, at timestamptz not null default now(), site_id text, issue text, contact text,
    category text, priority text, team text, summary text, run_id text)`;
  await sql`alter table handoffs enable row level security`;
  await sql`insert into handoffs (site_id, issue, contact, category, priority, team, summary, run_id)
    values (${h.siteId}, ${clip(h.issue, 2000)}, ${clip(h.contact, 200)}, ${clip(h.category, 200)}, ${clip(h.priority, 40)}, ${clip(h.team, 200)}, ${clip(h.summary, 2000)}, ${clip(h.runId, 80)})`;
}
/** Registered users (Supabase Auth) with their demo use and payments, newest first. */
export async function registeredUsers() {
  const sql = await db();
  if (!sql) return [];
  try {
    const [t] = await sql`select to_regclass('public.demo_uses') is not null as demos, to_regclass('public.payments') is not null as pays`;
    return await sql`
      select u.id, u.email, u.created_at, u.last_sign_in_at,
        ${t.demos ? sql`(select count(*)::int from demo_uses d where d.user_id = u.id)` : sql`0`} as demos,
        ${t.pays ? sql`(select coalesce(sum(amount), 0)::int from payments p where p.user_id = u.id and p.status <> 'rejected')` : sql`0`} as paid
      from auth.users u order by u.created_at desc limit 500`;
  } catch (e) { console.error('[users]', e.message); return []; }
}
export async function recentHandoffs() {
  const sql = await db();
  if (!sql) return [];
  try { return await sql`select at, site_id, issue, contact, category, priority, team from handoffs order by at desc limit 30`; } catch { return []; }
}

/** Numbers for the usage page. */
export async function usageStats() {
  const sql = await db();
  if (!sql) return { enabled: false };
  const [totals] = await sql`
    select
      count(distinct visitor) filter (where visitor is not null)                                   as visitors_all,
      count(distinct visitor) filter (where visitor is not null and at > now() - interval '1 day')  as visitors_24h,
      count(distinct visitor) filter (where visitor is not null and at > now() - interval '7 days') as visitors_7d,
      count(*) filter (where kind = 'visit')       as visits,
      count(*) filter (where kind = 'scan')        as scans,
      count(*) filter (where kind = 'scan_failed') as scans_failed,
      count(*) filter (where kind = 'demo_open')   as demos,
      count(*) filter (where kind = 'chat')        as chats
    from usage_events`;
  const daily = await sql`
    select to_char(date_trunc('day', at at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as day,
           count(distinct visitor) as visitors,
           count(*) filter (where kind = 'scan') as scans,
           count(*) filter (where kind = 'demo_open') as demos,
           count(*) filter (where kind = 'chat') as chats
    from usage_events where at > now() - interval '14 days'
    group by 1 order by 1 desc`;
  const sites = await sql`
    select site_id, count(*) filter (where kind = 'chat') as chats, count(*) filter (where kind = 'demo_open') as demos,
           count(distinct visitor) as visitors, max(at) as last_used
    from usage_events where site_id is not null
    group by site_id order by max(at) desc limit 25`;
  const [people] = await sql`
    select (select count(*) from auth.users) as registered,
           (select count(*) from auth.users where created_at > now() - interval '7 days') as registered_7d,
           (select count(*) from auth.users where last_sign_in_at > now() - interval '1 day') as signed_in_24h,
           count(distinct user_id) filter (where user_id is not null and at > now() - interval '7 days') as active_users_7d
    from usage_events`;
  const signups = await sql`
    select to_char(date_trunc('day', created_at at time zone 'Asia/Kolkata'), 'YYYY-MM-DD') as day, count(*) as signups
    from auth.users where created_at > now() - interval '14 days' group by 1 order by 1 desc`;
  const countries = await sql`
    select coalesce(country, '–') as country, count(distinct visitor) as visitors
    from usage_events where visitor is not null group by 1 order by 2 desc limit 10`;
  const num = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' || /^\d+$/.test(String(v)) && k !== 'day' && k !== 'site_id' && k !== 'country' ? Number(v) : v]));
  return { enabled: true, totals: { ...num(totals), ...num(people) }, daily: daily.map(num), signups: signups.map(num), sites: sites.map(num), countries: countries.map(num) };
}
