/**
 * Period Pass — student pass page.
 *
 * Only ever needed on a DYNAMIC DAY. On any ordinary day this page says so and sends the
 * student away with their printed card, because a rotating code that worked every day would
 * be a way to self-issue attendance from anywhere.
 *
 * What it deliberately does NOT do: take a roll number, accept one, or display anyone else's.
 * The server derives the roll from the Google-verified address and there is nowhere in the
 * request to put a different one. That is the only reason this cannot become a code oracle
 * for a friend sitting at home.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var state = { idToken: null, timer: null, tick: null, backoff: 0 };

  // ---------------------------------------------------------------------------

  function show(which) {
    ['signin', 'card', 'notice'].forEach(function (id) {
      $(id).classList.toggle('hidden', id !== which);
    });
  }

  function notice(text) {
    $('msg').textContent = text;
    show('notice');
    stopTimers();
  }

  function stopTimers() {
    if (state.timer) { clearTimeout(state.timer); state.timer = null; }
    if (state.tick) { clearInterval(state.tick); state.tick = null; }
  }

  function api(action) {
    return fetch(CFG.EXEC_URL, {
      method: 'POST',
      // text/plain avoids a CORS preflight, which Apps Script cannot answer.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: action, idToken: state.idToken })
    }).then(function (r) { return r.json(); });
  }

  // ---------------------------------------------------------------------------

  function draw(code) {
    var box = $('qrbox');
    box.textContent = '';
    try {
      // Error correction is kept LOW on purpose: it packs fewer modules into the same area,
      // so each module is larger and reads more reliably off a phone screen at arm's length.
      // A screen has no smudges or creases to recover from — the redundancy buys nothing here.
      new QRCode(box, {
        text: code, width: 236, height: 236,
        colorDark: '#000000', colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.L
      });
    } catch (e) {
      box.textContent = 'Could not draw the code — reload the page.';
    }
  }

  function countdown(ms) {
    var ends = Date.now() + ms;
    stopTimers();
    state.tick = setInterval(function () {
      var left = Math.max(0, Math.ceil((ends - Date.now()) / 1000));
      $('ttl').textContent = 'changes in ' + left + 's';
    }, 500);
    // Refresh a little BEFORE expiry, never after: a volunteer holding a phone at the moment
    // a code lapses would otherwise be shown an expired one and told to try again.
    //
    // The jitter is not cosmetic. Every phone refreshing at exactly (window - 2s) converges
    // into one synchronised herd within a couple of cycles even if the students opened the
    // page at staggered times — four hundred requests arriving in the same second, every
    // minute, forever. A random spread turns that into a flat trickle, and it is the single
    // highest-leverage line in this file for surviving a full cohort.
    // Proportional to the window, not a fixed four seconds. At a 60-second code that constant
    // was a 7% spread; at 15 seconds it would be 27%, and at anything shorter the jitter plus
    // the safety margin would exceed the code's whole life and every refresh would hit the
    // floor below — the herd this line exists to break would re-form.
    var jitter = Math.floor(Math.random() * Math.max(1000, ms * 0.25));
    var lead = Math.max(1000, ms * 0.15);
    state.timer = setTimeout(refresh, Math.max(1500, ms - lead - jitter));
  }

  function refresh() {
    api('code').then(function (r) {
      if (!r.ok) {
        if (r.error === 'TOKEN_EXPIRED' || r.error === 'TOKEN_INVALID') {
          notice('Your sign-in expired. Reload the page.');
          return;
        }
        // BUSY is a queue, not a verdict, and it arrives as a perfectly good HTTP response —
        // so the catch() below never sees it. Without this the page would treat a momentary
        // rate limit as permanent and stop, exactly when a whole cohort is retrying and the
        // limit is most likely to be brushed. Back off and try again, spread out.
        if (r.error === 'BUSY') {
          state.backoff = Math.min((state.backoff || 1000) * 2, 15000);
          $('ttl').textContent = 'busy — retrying';
          state.timer = setTimeout(refresh, state.backoff + Math.floor(Math.random() * 2000));
          return;
        }
        notice(r.message || 'No code available.');
        return;
      }
      state.backoff = 0;
      $('roll').textContent = r.roll;
      $('name').textContent = r.name || '';
      draw(r.code);
      show('card');

      // Branch on `kind`, never on which timing field happens to be present. The server decides
      // which pass this student may hold today; the page has no opinion and no way to prefer
      // one — that is what stops a printed pass being reachable on a dynamic day.
      if (r.kind === 'static') {
        // A printed pass does not expire, so no countdown. The re-ask is about the OFFICE
        // declaring a dynamic day while this page sits in a pocket: without it a student who
        // opened the page at 08:50 would present a perfectly rendered, silently dead QR at
        // 09:05 and the volunteer would see what looks like tampering.
        $('ttl').textContent = 'Your usual pass — same as your card';
        clearTimeout(state.timer);
        state.timer = setTimeout(refresh, r.recheckInMs || 300000);
        return;
      }

      // 15000 matches the default rotating TTL. A 60000 fallback here would have shown a
      // countdown four times the code's real life if the field ever went missing.
      countdown(r.expiresInMs || 15000);
    }).catch(function () {
      $('ttl').textContent = 'no signal — retrying';
      // Keep trying rather than giving up: the student may be in a hall with poor reception
      // and the volunteer is standing in front of them.
      state.timer = setTimeout(refresh, 3000);
    });
  }

  // ---------------------------------------------------------------------------

  function onCredential(resp) {
    state.idToken = resp.credential;
    refresh();
  }

  function initGsi() {
    if (!window.google || !google.accounts || !google.accounts.id) {
      setTimeout(initGsi, 200);
      return;
    }
    try {
      google.accounts.id.initialize({
        client_id: CFG.CLIENT_ID,
        callback: onCredential,
        auto_select: true
      });
      google.accounts.id.renderButton($('gsiBtn'), {
        theme: 'filled_blue', size: 'large', text: 'signin_with', width: 260
      });
    } catch (e) {
      $('signinError').textContent = 'Sign-in could not start. Tell the office.';
      $('signinError').classList.remove('hidden');
    }
  }

  // A screen at half brightness in a lit lecture hall is the commonest reason a code will not
  // scan, and the student has no way to know that is the problem.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && state.idToken) refresh();
  });

  show('signin');
  initGsi();
})();
