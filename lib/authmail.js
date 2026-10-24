// Email sign-in links sent through Resend instead of Supabase's built-in mailer (which allows only
// 2 emails an hour on free projects). Supabase still owns the accounts and sessions:
// the server asks Supabase for a one-time token, emails a link containing it, and the browser
// exchanges the token for a session with supabase.auth.verifyOtp().
const SB_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SB_SECRET = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const RESEND_KEY = process.env.RESEND_API_KEY || '';
const FROM = process.env.RESEND_FROM || 'Site Bridge <onboarding@resend.dev>';
// Gmail (or any SMTP) sends to any address without owning a domain: SMTP_USER + an app password
const SMTP = {
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT) || 465,
  user: process.env.SMTP_USER || '',
  pass: (process.env.SMTP_PASS || '').replace(/s+/g, ''), // Google shows app passwords with spaces
  from: process.env.SMTP_FROM || '',
};
const useSmtp = Boolean(SMTP.user && SMTP.pass);
let transport = null;
async function smtpSend(msg) {
  if (!transport) {
    const { default: nodemailer } = await import('nodemailer');
    transport = nodemailer.createTransport({ host: SMTP.host, port: SMTP.port, secure: SMTP.port === 465, auth: { user: SMTP.user, pass: SMTP.pass }, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
  }
  // Plain, consistent headers: same sender name, a real reply-to, no tracking, no links
  await transport.sendMail({ from: SMTP.from || `Site Bridge <${SMTP.user}>`, replyTo: SMTP.user, headers: { 'X-Entity-Ref-ID': String(Date.now()) }, ...msg });
}

export const emailLoginReady = Boolean(SB_URL && SB_SECRET && (useSmtp || RESEND_KEY));

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,24}$/i;
const lastSent = new Map(); // email -> time, one link per minute per address

function adminHeaders() {
  const h = { apikey: SB_SECRET, 'content-type': 'application/json' };
  // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys go in apikey only
  if (SB_SECRET.split('.').length === 3) h.authorization = `Bearer ${SB_SECRET}`;
  return h;
}

async function generate(email) {
  const r = await fetch(`${SB_URL}/auth/v1/admin/generate_link`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ type: 'magiclink', email }), signal: AbortSignal.timeout(8000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function createUser(email) {
  const r = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: 'POST', headers: adminHeaders(), body: JSON.stringify({ email, email_confirm: true }), signal: AbortSignal.timeout(8000),
  });
  return r.ok || r.status === 422; // 422: already exists
}

const page = (code) => `<!doctype html><html><body style="margin:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif;color:#0b0c10">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;padding:32px">
<tr><td style="font-size:20px;font-weight:600;padding-bottom:6px">Sign in to Site Bridge</td></tr>
<tr><td style="font-size:15px;line-height:1.6;color:#4b4f5c;padding-bottom:18px">Enter this code in the Site Bridge sign-in window. It works once and expires in one hour.</td></tr>
<tr><td style="font-size:34px;font-weight:700;letter-spacing:.32em;font-family:'Courier New',monospace;color:#0b0c10;background:#f4f6fb;padding:16px 18px;text-align:center">${code}</td></tr>
<tr><td style="font-size:12px;line-height:1.6;color:#6b6f7b;padding-top:24px">If you didn't try to sign in to Site Bridge, you can ignore this email.</td></tr>
</table></td></tr></table></body></html>`;

/** Send a sign-in link. Returns { ok } or { ok:false, status, error } with a visitor-friendly message. */
export async function sendLoginEmail(email, origin) {
  email = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { ok: false, status: 400, error: 'Please enter a valid email address.' };
  if (!emailLoginReady) return { ok: false, status: 503, error: 'Email sign-in is not set up yet.' };
  const prev = lastSent.get(email) || 0;
  if (Date.now() - prev < 60_000) return { ok: false, status: 429, error: 'A link was just sent. Please wait a minute before asking again.' };

  let g = await generate(email);
  if (!g.ok && (g.status === 404 || g.status === 422 || /not found/i.test(JSON.stringify(g.data)))) {
    if (await createUser(email)) g = await generate(email);
  }
  const code = g.data?.properties?.email_otp || g.data?.email_otp;
  if (!g.ok || !code) {
    console.error('[auth] generate_link failed', g.status, JSON.stringify(g.data).slice(0, 200));
    return { ok: false, status: 502, error: 'Could not create a sign-in link. Please try again.' };
  }
  const subject = `${code} is your Site Bridge sign-in code`;
  const text = `Your Site Bridge sign-in code: ${code}\n\nEnter it in the sign-in window. It works once and expires in one hour.`;
  if (useSmtp) {
    try { await smtpSend({ to: email, subject, html: page(code), text }); }
    catch (e) {
      console.error('[auth] smtp failed', e.code || '', e.message);
      return { ok: false, status: 502, error: 'Could not send the email right now. Please try again.' };
    }
    lastSent.set(email, Date.now());
    return { ok: true };
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${RESEND_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [email], subject, html: page(code), text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    console.error('[auth] resend failed', r.status, body.slice(0, 300));
    const testingOnly = /testing emails|verify a domain|own email/i.test(body);
    return { ok: false, status: 502, error: testingOnly ? 'Sign-in emails can only go to the Site Bridge owner until a sending domain is verified.' : 'Could not send the email right now. Please try again.' };
  }
  lastSent.set(email, Date.now());
  if (lastSent.size > 10000) lastSent.clear();
  return { ok: true };
}
