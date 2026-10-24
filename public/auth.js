/* Email sign-in (Supabase magic link) for the Site Bridge site.
 * Optional for now: signing in links your scans and demos to your account in the usage data.
 * Exposes window.sbAuth = { token(): Promise<string|null>, user(): object|null }. */
(function () {
  var client = null, current = null, listeners = [];
  window.sbAuth = {
    token: async function () { if (!client) return null; try { var s = (await client.auth.getSession()).data.session; return s ? s.access_token : null; } catch (e) { return null; } },
    user: function () { return current; },
    onChange: function (fn) { listeners.push(fn); },
    open: function (note) { if (!client) return; msg.className = 'lx-auth-msg'; msg.textContent = note || ''; step('email'); dlg.showModal(); input.focus(); },
  };

  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  // ---- sign-in dialog ----
  var dlg = el('<dialog class="lx-auth" aria-labelledby="lx-auth-title">' +
    '<form method="dialog" class="lx-auth-x"><button aria-label="Close">×</button></form>' +
    '<div class="lx-eyebrow lx-eyebrow-left"><i></i>Sign in</div>' +
    '<h2 id="lx-auth-title">Sign in to Site Bridge</h2>' +
    '<p class="lx-auth-sub">Enter your email and we\'ll send you a sign-in code. No password needed.</p>' +
    '<form class="lx-auth-form"><input type="email" required autocomplete="email" placeholder="you@company.com" aria-label="Email address">' +
    '<button type="submit" class="lx-btn lx-btn-dark">Send code</button></form>' +
    '<form class="lx-auth-form lx-code-form" hidden><input class="lx-code" inputmode="numeric" autocomplete="one-time-code" maxlength="10" placeholder="Code from your email" aria-label="Sign-in code">' +
    '<button type="submit" class="lx-btn lx-btn-dark">Sign in</button><button type="button" class="lx-auth-back">Use a different email</button></form>' +
    '<p class="lx-auth-msg" role="status" aria-live="polite"></p></dialog>');
  document.body.appendChild(dlg);
  var form = dlg.querySelector('.lx-auth-form'), input = form.querySelector('input'), msg = dlg.querySelector('.lx-auth-msg'), sendBtn = form.querySelector('button');
  var codeForm = dlg.querySelector('.lx-code-form'), codeInput = codeForm.querySelector('input'), codeBtn = codeForm.querySelector('button[type=submit]');
  var sentTo = '';
  function step(which) { form.hidden = which !== 'email'; codeForm.hidden = which !== 'code'; (which === 'code' ? codeInput : input).focus(); }
  codeForm.querySelector('.lx-auth-back').addEventListener('click', function () { msg.textContent = ''; codeInput.value = ''; step('email'); });
  codeForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var code = codeInput.value.replace(/\D/g, '');
    if (code.length < 6) { msg.className = 'lx-auth-msg err'; msg.textContent = 'Enter the full code from the email.'; return; }
    codeBtn.disabled = true; msg.className = 'lx-auth-msg'; msg.textContent = 'Signing in…';
    var r = await client.auth.verifyOtp({ email: sentTo, token: code, type: 'email' });
    codeBtn.disabled = false;
    if (r.error) { msg.className = 'lx-auth-msg err'; msg.textContent = /expired|invalid/i.test(r.error.message) ? 'That code is wrong or has expired. Check the latest email, or send a new code.' : 'Could not sign in. Please try again.'; return; }
    msg.className = 'lx-auth-msg ok'; msg.textContent = 'Signed in.';
    setTimeout(function () { dlg.close(); codeInput.value = ''; step('email'); msg.textContent = ''; }, 500);
  });

  // ---- nav button ----
  var cta = document.querySelector('.lx-nav-cta');
  var navBtn = el('<button type="button" class="lx-btn lx-btn-line lx-auth-btn" hidden>Sign in</button>');
  if (cta) cta.insertBefore(navBtn, cta.firstChild);

  function paint() {
    if (!client) return;
    navBtn.hidden = false;
    if (current) { navBtn.textContent = (current.email || 'Account').split('@')[0] + ' · Sign out'; navBtn.title = current.email || ''; }
    else { navBtn.textContent = 'Sign in'; navBtn.title = ''; }
    listeners.forEach(function (fn) { try { fn(current); } catch (e) { /* ignore */ } });
  }

  navBtn.addEventListener('click', async function () {
    if (current) { await client.auth.signOut(); return; }
    msg.textContent = ''; msg.className = 'lx-auth-msg';
    step('email'); dlg.showModal(); input.focus();
  });

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    var email = input.value.trim();
    if (!email) return;
    sendBtn.disabled = true; msg.className = 'lx-auth-msg'; msg.textContent = 'Sending…';
    var res = await fetch('/api/auth/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: email }) }).catch(function () { return null; });
    var data = res ? await res.json().catch(function () { return {}; }) : {};
    sendBtn.disabled = false;
    if (!res || !res.ok) {
      msg.className = 'lx-auth-msg err';
      msg.textContent = data.error || 'Could not send the code. Please try again.';
      return;
    }
    sentTo = email.toLowerCase();
    msg.className = 'lx-auth-msg ok';
    msg.innerHTML = 'We sent a code to <b>' + esc(email) + '</b>. It can take a minute; check spam too.';
    step('code');
  });

  // ---- start: read the public Supabase settings from the server ----
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
    if (!s.auth || !s.auth.url || !s.auth.key || !window.supabase) return;
    client = window.supabase.createClient(s.auth.url, s.auth.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
    client.auth.onAuthStateChange(function (_event, session) { current = session ? session.user : null; paint(); });
    // Arriving from the email link: exchange the one-time token for a session, then tidy the address bar
    var q = new URLSearchParams(location.search), tok = q.get('sb_token');
    var ready = tok
      ? client.auth.verifyOtp({ token_hash: tok, type: q.get('sb_type') || 'magiclink' }).then(function (r) {
          q.delete('sb_token'); q.delete('sb_type');
          history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
          if (r.error) { msg.className = 'lx-auth-msg err'; msg.textContent = 'That sign-in link has expired or was already used. Please ask for a new one.'; dlg.showModal(); }
        })
      : Promise.resolve();
    ready.then(function () { return client.auth.getSession(); }).then(function (r) { current = r.data.session ? r.data.session.user : null; paint(); });
  }).catch(function () { /* sign-in unavailable */ });
})();
