/* Live demo access: sign in, then use a demo credit. When credits run out, pay ₹50 by UPI
 * (QR or UPI app), enter the 12-digit UTR, and 2 more demos unlock.
 * window.sbPay.openDemo(siteId, demoUrl) is called by the "Open Live Demo" buttons. */
(function () {
  var cfg = null;
  fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) { cfg = s.payments || null; }).catch(function () {});

  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
  var dlg = el('<dialog class="lx-auth lx-pay" aria-labelledby="lx-pay-title">' +
    '<form method="dialog" class="lx-auth-x"><button aria-label="Close">×</button></form>' +
    '<div class="lx-eyebrow lx-eyebrow-left"><i></i>Live demos</div>' +
    '<h2 id="lx-pay-title"></h2><p class="lx-auth-sub lx-pay-sub"></p>' +
    '<div class="lx-pay-step"><b>Step 1</b> Pay <span class="lx-pay-amt"></span> with any UPI app: scan the QR code, or tap the button on your phone.</div>' +
    '<div class="lx-pay-qr" aria-label="UPI QR code"></div>' +
    '<a class="lx-btn lx-btn-line lx-pay-app" target="_blank" rel="noopener">Pay with UPI app</a>' +
    '<p class="lx-pay-upi"></p>' +
    '<div class="lx-pay-step"><b>Step 2</b> After paying, paste the <b>transaction ID</b> here. Find it in the payment details: GPay "UPI transaction ID", PhonePe "UTR" or "Transaction ID", Paytm "UPI Ref. No."</div>' +
    '<form class="lx-auth-form lx-pay-form"><input autocomplete="off" maxlength="40" placeholder="Paste transaction ID, e.g. 412345678901" aria-label="UPI transaction ID">' +
    '<button type="submit" class="lx-btn lx-btn-dark">Submit transaction ID</button></form>' +
    '<button type="button" class="lx-btn lx-btn-dark lx-pay-continue" hidden>Continue</button>' +
    '<p class="lx-auth-msg" role="status" aria-live="polite"></p></dialog>');
  document.body.appendChild(dlg);
  var msg = dlg.querySelector('.lx-auth-msg'), form = dlg.querySelector('.lx-pay-form'), input = form.querySelector('input'), btn = form.querySelector('button');
  var pending = null; // { siteId, url } to open once paid
  var cont = dlg.querySelector('.lx-pay-continue');
  // Nothing happens on its own after paying: the visitor carries on when they're ready
  cont.addEventListener('click', function () {
    dlg.close();
    if (afterPay) { var f = afterPay; afterPay = null; f(); }
    else if (pending) { var p = pending; pending = null; openDemo(p.siteId, p.url); }
  });

  async function api(path, body) {
    var token = window.sbAuth ? await window.sbAuth.token() : null;
    var r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: token ? 'Bearer ' + token : '' }, body: JSON.stringify(body || {}) });
    var d = await r.json().catch(function () { return {}; });
    return { status: r.status, ok: r.ok, d: d };
  }

  function showPay(reason) {
    if (!cfg || !cfg.upiId) { alert('Payments are not set up yet. Please contact Site Bridge.'); return; }
    var link = 'upi://pay?pa=' + encodeURIComponent(cfg.upiId) + '&pn=' + encodeURIComponent(cfg.payee) + '&am=' + cfg.amount + '&cu=INR&tn=' + encodeURIComponent('Site Bridge ' + cfg.credits + ' live demos');
    dlg.querySelector('#lx-pay-title').textContent = 'Get ' + cfg.credits + ' live demos for ₹' + cfg.amount;
    dlg.querySelector('.lx-pay-sub').textContent = (reason || 'Your free live demo is used.') + ' Pay ₹' + cfg.amount + ' by UPI for ' + cfg.credits + ' more live demos.';
    dlg.querySelector('.lx-pay-app').href = link;
    dlg.querySelector('.lx-pay-upi').textContent = 'UPI ID: ' + cfg.upiId + ' · ' + cfg.payee;
    dlg.querySelector('.lx-pay-amt').textContent = '₹' + cfg.amount;
    form.hidden = false; cont.hidden = true;
    var box = dlg.querySelector('.lx-pay-qr');
    box.innerHTML = '';
    if (window.QRCode) new window.QRCode(box, { text: link, width: 168, height: 168, correctLevel: window.QRCode.CorrectLevel.M });
    msg.textContent = ''; msg.className = 'lx-auth-msg'; input.value = '';
    if (dlg.open) dlg.close();
    dlg.show();
    input.focus({ preventScroll: true });
  }

  function go(url) { var w = window.open(url, '_blank', 'noopener'); if (!w) location.href = url; }

  form.addEventListener('submit', async function (e) {
    e.preventDefault();
    btn.disabled = true; msg.className = 'lx-auth-msg'; msg.textContent = 'Checking…';
    var r = await api('/api/pay/claim', { utr: input.value });
    btn.disabled = false;
    if (!r.ok) { msg.className = 'lx-auth-msg err'; msg.textContent = r.d.error || 'Could not record the payment.'; return; }
    msg.className = 'lx-auth-msg ok';
    msg.textContent = 'Thank you. Transaction ID received; you now have ' + r.d.balance.left + ' live demos. We check every payment against our bank record.';
    refreshNote();
    form.hidden = true;
    cont.textContent = afterPay ? 'Continue to scan' : pending ? 'Continue to the live demo' : 'Done';
    cont.hidden = false; cont.focus();
  });

  async function openDemo(siteId, url) {
    if (!window.sbAuth || !window.sbAuth.user()) {
      pending = { siteId: siteId, url: url };
      if (window.sbAuth && window.sbAuth.open) window.sbAuth.open('Sign in to open live demos. Your first demo is free.');
      return;
    }
    var r = await api('/api/demo/start/' + encodeURIComponent(siteId));
    if (r.ok) { go(url + (r.d.pass ? '#sbpass=' + encodeURIComponent(r.d.pass) : '')); return; }
    if (r.status === 402) { pending = { siteId: siteId, url: url }; showPay(); return; }
    if (r.status === 401) { pending = { siteId: siteId, url: url }; window.sbAuth.open('Please sign in again to open live demos.'); return; }
    alert(r.d.error || 'Could not open the demo right now.');
  }

  // After signing in, carry on with the demo the visitor asked for
  if (window.sbAuth && window.sbAuth.onChange) window.sbAuth.onChange(function (u) { if (u && pending) { var p = pending; pending = null; openDemo(p.siteId, p.url); } });

  // ---- pricing shown before scanning, and pay-before-scan when out of credits ----
  var afterPay = null;
  async function credits() {
    if (!window.sbAuth || !window.sbAuth.user()) return null;
    var r = await api('/api/me/credits');
    return r.ok ? r.d.balance : null;
  }
  async function refreshNote() {
    var note = document.getElementById('price-note');
    if (!note) return;
    var tries = 0;
    while (!cfg && tries++ < 20) await new Promise(function (r) { setTimeout(r, 150); });
    if (!cfg) return;
    var b = await credits();
    var price = 'First live demo free, then ₹' + cfg.amount + ' for ' + cfg.credits + ' demos (UPI).';
    if (b && b.unlimited) note.textContent = 'Unlimited live demos on your account.';
    else if (b) note.textContent = b.left > 0 ? 'You have ' + b.left + ' live demo' + (b.left === 1 ? '' : 's') + ' left. ' + (b.paid ? '' : 'After that, ₹' + cfg.amount + ' for ' + cfg.credits + ' demos.') : 'Your free demo is used. Next: ₹' + cfg.amount + ' for ' + cfg.credits + ' live demos (UPI).';
    else note.textContent = price + ' Sign in to start.';
    note.hidden = false;
  }
  /** Before a scan: signed-in users with no credits pay first. Returns true if the scan may start now. */
  async function beforeScan(start) {
    var b = await credits();
    if (b && !b.unlimited && b.left < 1) { afterPay = start; showPay('Your free live demo is used.'); return false; }
    return true;
  }
  if (window.sbAuth && window.sbAuth.onChange) window.sbAuth.onChange(function () { refreshNote(); });
  refreshNote();

  window.sbPay = { openDemo: openDemo, beforeScan: beforeScan, refreshNote: refreshNote };
})();
