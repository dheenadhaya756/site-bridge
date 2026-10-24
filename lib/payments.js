// Simple UPI payments for live demos (no gateway): the visitor pays ₹50 to the owner's UPI ID,
// enters the 12-digit UTR from their UPI app, and gets 2 demo credits at once. The owner checks the
// UTRs against their bank app on the usage page. Accounts come from Supabase sign-in.
import { dbSql } from './usage.js';

export const payConfig = {
  upiId: process.env.UPI_ID || '',
  payee: process.env.UPI_PAYEE || 'Site Bridge',
  amount: Number(process.env.DEMO_PACK_PRICE) || 50,
  credits: Number(process.env.DEMO_PACK_CREDITS) || 2,
  free: Number(process.env.FREE_DEMOS ?? 1),
};
export const paymentsReady = Boolean(payConfig.upiId);

let ready = null;
async function db() {
  const sql = await dbSql();
  if (!sql) return null;
  if (!ready) {
    ready = (async () => {
      await sql`create table if not exists payments (
        id bigserial primary key, at timestamptz not null default now(),
        user_id uuid not null, email text, amount integer not null, credits integer not null,
        utr text not null unique, status text not null default 'claimed')`;
      await sql`create table if not exists demo_uses (
        id bigserial primary key, at timestamptz not null default now(),
        user_id uuid not null, site_id text not null)`;
      await sql`create index if not exists demo_uses_user_idx on demo_uses (user_id)`;
      // Server-only tables: never reachable through Supabase's public API
      await sql`alter table payments enable row level security`;
      await sql`alter table demo_uses enable row level security`;
      await sql`revoke all on payments, demo_uses from anon, authenticated`;
    })().catch(e => { ready = null; throw e; });
  }
  await ready;
  return sql;
}

/** Credits left for a user: free demos + paid credits (not rejected) - demos opened. */
export async function balance(userId) {
  const sql = await db();
  if (!sql) return null;
  const [r] = await sql`
    select coalesce((select sum(credits) from payments where user_id = ${userId} and status <> 'rejected'), 0)::int as paid,
           (select count(*) from demo_uses where user_id = ${userId})::int as used`;
  return { paid: r.paid, used: r.used, free: payConfig.free, left: Math.max(0, payConfig.free + r.paid - r.used) };
}

/** Record a UPI payment by its UTR and add credits. */
export async function claim(user, utr) {
  const sql = await db();
  if (!sql) return { ok: false, status: 503, error: 'Payments are not available right now.' };
  utr = String(utr || '').replace(/\s+/g, '').toUpperCase();
  // 12-digit UTR (GPay, Paytm, BHIM) or an app transaction ID such as PhonePe's T2410…
  if (!/^\d{12}$/.test(utr) && !/^[A-Z0-9]{12,35}$/.test(utr)) return { ok: false, status: 400, error: 'Please paste the transaction ID from your UPI app\'s payment details (usually 12 digits).' };
  try {
    await sql`insert into payments (user_id, email, amount, credits, utr) values (${user.id}, ${user.email || null}, ${payConfig.amount}, ${payConfig.credits}, ${utr})`;
  } catch (e) {
    if (e.code === '23505') return { ok: false, status: 409, error: 'This UTR has already been used.' };
    throw e;
  }
  return { ok: true, balance: await balance(user.id) };
}

/** Use one credit to open a site's live demo. */
const UNLIMITED = new Set(String(process.env.UNLIMITED_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean));
export const isUnlimited = user => Boolean(user?.email && UNLIMITED.has(user.email.toLowerCase()));

export async function startDemo(user, siteId) {
  const sql = await db();
  if (!sql) return { ok: false, status: 503, error: 'Demos are not available right now.' };
  if (isUnlimited(user)) {
    await sql`insert into demo_uses (user_id, site_id) values (${user.id}, ${siteId})`;
    return { ok: true, balance: { paid: 0, used: 0, free: 0, left: 9999, unlimited: true } };
  }
  const b = await balance(user.id);
  // Re-opening a site this user already opened today doesn't use another credit
  const [again] = await sql`select 1 as x from demo_uses where user_id = ${user.id} and site_id = ${siteId} and at > now() - interval '1 day' limit 1`;
  if (again) return { ok: true, balance: b, reused: true };
  if (b.left < 1) return { ok: false, status: 402, error: 'No demo credits left.', balance: b };
  await sql`insert into demo_uses (user_id, site_id) values (${user.id}, ${siteId})`;
  return { ok: true, balance: await balance(user.id) };
}

// Demo chats: free accounts get FREE_CHATS messages, each payment adds CHATS_PER_PACK more
const FREE_CHATS = Number(process.env.FREE_CHATS ?? 5);
const CHATS_PER_PACK = Number(process.env.CHATS_PER_PACK ?? 10);
/** Count one visitor message for this account if allowed. Returns { ok, used, limit }. */
export async function useChat(user, siteId) {
  if (isUnlimited(user)) return { ok: true, used: 0, limit: Infinity };
  const sql = await db();
  if (!sql) return { ok: true, used: 0, limit: Infinity };
  await sql`create table if not exists chat_uses (id bigserial primary key, at timestamptz not null default now(), user_id uuid not null, site_id text)`;
  await sql`alter table chat_uses enable row level security`;
  const [r] = await sql`
    select (select count(*)::int from chat_uses where user_id = ${user.id}) as used,
           (select count(*)::int from payments where user_id = ${user.id} and status <> 'rejected') as packs`;
  const limit = FREE_CHATS + CHATS_PER_PACK * r.packs;
  if (r.used >= limit) return { ok: false, used: r.used, limit, paid: r.packs > 0 };
  await sql`insert into chat_uses (user_id, site_id) values (${user.id}, ${siteId})`;
  return { ok: true, used: r.used + 1, limit };
}

export async function paymentStats() {
  const sql = await db();
  if (!sql) return null;
  const [t] = await sql`select count(*)::int as payments, coalesce(sum(amount) filter (where status <> 'rejected'), 0)::int as revenue,
                               count(distinct user_id)::int as payers from payments`;
  const [d] = await sql`select count(*)::int as demos_opened from demo_uses`;
  const list = await sql`select id, at, email, amount, utr, status from payments order by at desc limit 50`;
  return { ...t, ...d, list };
}

export async function setPaymentStatus(id, status) {
  const sql = await db();
  if (!sql || !['claimed', 'verified', 'rejected'].includes(status)) return false;
  const r = await sql`update payments set status = ${status} where id = ${Number(id)} returning id`;
  return r.length > 0;
}
