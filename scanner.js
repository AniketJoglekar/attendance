/**
 * Period Pass — scanner client
 *
 * Runs as a static page on GitHub Pages, not inside Apps Script. That matters: an
 * HtmlService page lives in an iframe whose origin changes on every load, which Google
 * Identity Services cannot be registered against and which makes the browser re-ask for
 * camera permission every session. A fixed Pages origin fixes both.
 *
 * It talks to the backend over a single cross-origin POST with Content-Type text/plain, so
 * the request stays "simple" and skips the CORS preflight — Apps Script cannot answer an
 * OPTIONS call.
 *
 * Offline-first. Every decode is written to a local queue and shown immediately using the
 * roll number read out of the pass itself; the server verifies signature, roll and
 * duplicates when the queue drains. A dead network delays verification, it does not lose
 * the scan.
 *
 * Shape of this file:
 *   local queue        localStorage, purged at 36 hours because items hold live passes
 *   Google sign-in     GIS ID token, renewed by hand when the hour is up
 *   server calls       one POST helper, with a timeout and a clock-offset measurement
 *   draining           batches of up to 50, results matched back by id
 *   class picker       only when several courses share a slot
 *   camera and decode  BarcodeDetector where available, jsQR everywhere else
 *   verdict card       roll number first; the photo loads only when asked for
 */
(function () {
  'use strict';

  var CFG = window.PASS_CONFIG || {};
  var $ = function (id) { return document.getElementById(id); };
  var QUEUE_KEY = 'pp_queue_v1';
  var OFFSET_KEY = 'pp_clock_offset_v1';

  /**
   * Photographs arrive as bytes over the authenticated channel, never from a URL.
   *
   * There is no address here to leak, share, or leave in a browser history — the verdict
   * carries a short-lived ticket, and the photo button exchanges it for the image itself.
   * Held in a plain variable so it never reaches the HTTP cache or disk, and dropped on
   * sign-out with the rest of the verdict state. A pass that is scanned but never inspected
   * is never transmitted at all.
   */
  var photoCache = {};                       // roll -> data URI, this session only

  // The outstanding forced check, or null. While set, scanning is suspended.
  // {roll, course, ticket, id, timer, deadline}

  var state = {
    check: null,                           // outstanding forced photo check; blocks scanning
    idToken: null,
    expiresAt: 0,
    queue: [],
    results: {},        // id -> verdict
    chips: {},          // id -> element
    chipOrder: [],      // ids in the order they were added, for trimming
    showing: null,      // id of the verdict on screen
    periodKey: '',      // chosen class when several share a slot
    candidateSig: '',   // which classes were running when the choice was made
    candidates: [],
    bannerSticky: false,
    email: '',
    timers: [],         // every interval this session owns, so sign-out can cancel them
    clockOffset: 0,     // server clock minus this phone's clock, in ms
    clockKnown: false,
    sessionId: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    recorded: 0,
    draining: false,
    scanning: false,
    loop: 0,            // generation counter, so only one decode loop survives
    seen: new Map(),    // decoded text -> timestamp
    autoClear: null,
    stream: null,
    track: null,
    devices: [],
    deviceIndex: 0,
    detector: null,
    audio: null
  };

  // =========================================================================
  // Local queue
  // =========================================================================

  var MAX_QUEUE_AGE_MS = 36 * 60 * 60 * 1000;   // matches the server's filing window

  function loadQueue() {
    try {
      var raw = localStorage.getItem(QUEUE_KEY);
      state.queue = raw ? JSON.parse(raw) : [];
    } catch (e) { state.queue = []; }
    purgeQueue();
  }

  /**
   * Each queued item holds a student's signed pass. Once an item is too old for the server
   * to file it is useless, so leaving it on the phone only keeps live student credentials
   * sitting in browser storage. Dropped items are counted so the volunteer is told rather
   * than the scans disappearing quietly.
   */
  function purgeQueue() {
    var cutoff = Date.now() - MAX_QUEUE_AGE_MS;
    var before = state.queue.length;
    state.queue = state.queue.filter(function (i) {
      var t = Date.parse(i.at);
      // An unreadable timestamp is DROPPED, not kept. Keeping it meant a live pass token sat
      // in localStorage for the rest of the semester and was re-sent on every drain, and the
      // server refused it every time.
      if (!isFinite(t)) return false;
      return t >= cutoff;
    });
    var dropped = before - state.queue.length;
    if (dropped) {
      saveQueue();
      banner('alarm', dropped + ' scan(s) were held too long to be filed and have been ' +
        'discarded. Enter those students by hand if it still matters.', true);
    }
    return dropped;
  }

  function saveQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(state.queue)); } catch (e) {}
  }

  function enqueue(payload, manual, noDevice) {
    var item = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      payload: payload,
      manual: !!manual,
      // Vouching for a student with no working phone on a dynamic day. Capped server-side
      // and named in the log — see NO_DEVICE_CAP_PER_DAY.
      noDevice: !!noDevice,
      at: new Date().toISOString(),
      // The clock error known at the moment of the scan, and the page session it belongs
      // to. The server ignores the offset for items scanned in the session that is syncing
      // — it can measure that itself — and uses it only across a reload or reboot, which is
      // when the device clock may have changed underneath the queue.
      offsetMs: state.clockOffset,
      sess: state.sessionId,
      // The class chosen AT SCAN TIME, not at sync time. The server already reads
      // item.periodKey and falls back to the batch's key; the client simply never set it,
      // so a batch taken in one shared slot and synced during another was attributed to
      // whatever was selected when the queue happened to drain. Silent, and only when two
      // courses share a slot — which is exactly when attribution matters.
      periodKey: state.periodKey || ''
    };
    state.queue.push(item);
    saveQueue();
    updateQueueBadge();
    return item;
  }

  function updateQueueBadge() {
    var el = $('queued');
    if (state.queue.length) {
      el.textContent = state.queue.length + ' queued';
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  // =========================================================================
  // Google sign-in
  // =========================================================================

  waitFor(function () { return window.google && google.accounts && google.accounts.id; }, initGsi,
    function () { signinError('Google sign-in did not load. Check the connection and reload.'); });

  function initGsi() {
    if (!/\.apps\.googleusercontent\.com$/.test(CFG.CLIENT_ID || '')) {
      signinError('CLIENT_ID is not set in config.js.');
      return;
    }
    $('signinTitle').textContent = CFG.EVENT_NAME || 'Period Pass';
    google.accounts.id.initialize({
      client_id: CFG.CLIENT_ID,
      callback: onCredential,
      auto_select: true,
      cancel_on_tap_outside: false
    });
    ['gsiButton', 'gsiButton2'].forEach(function (id) {
      google.accounts.id.renderButton($(id), {
        theme: 'filled_black', size: 'large', shape: 'pill', text: 'signin_with', width: 260
      });
    });
    google.accounts.id.prompt();
  }

  function onCredential(resp) {
    var claims = decodeJwt(resp.credential);
    if (!claims) { signinError('That sign-in could not be read. Try again.'); return; }
    state.idToken = resp.credential;
    state.expiresAt = (claims.exp || 0) * 1000;
    $('reauth').classList.remove('show');
    signinError('');
    startSession();
  }

  function decodeJwt(jwt) {
    try {
      var b64 = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      var bin = atob(b64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) { return null; }
  }

  function tokenUsable() { return !!state.idToken && Date.now() < state.expiresAt - 60000; }

  function requireReauth() {
    $('reauth').classList.add('show');
    if (window.google && google.accounts) google.accounts.id.prompt();
  }

  function signinError(msg) { $('signinError').textContent = msg || ''; }

  // =========================================================================
  // Signing out
  // =========================================================================

  /**
   * Needed for two reasons that are easy to miss until they bite.
   *
   * A phone handed to a second TA would otherwise keep recording under the first one's name,
   * because auto_select silently reuses the last account. And anyone who signs in with the
   * wrong account — a personal address rather than the institute one — is otherwise stuck
   * with "not on the volunteer list" and no way back.
   */
  $('who').addEventListener('click', function () {
    if (!state.idToken) return;
    $('signoutWho').textContent = state.email || '(unknown account)';

    var warn = $('signoutWarn');
    if (state.queue.length) {
      // Queued scans carry no identity of their own; whoever is signed in when they sync is
      // the name recorded against them. Sending them first keeps the log honest.
      warn.textContent = state.queue.length + ' scan(s) have not been sent yet. Sign out now ' +
        'and they will be recorded under whoever signs in next. Stay online for a moment first.';
      warn.classList.remove('hidden');
      drain();
    } else {
      warn.classList.add('hidden');
    }
    $('signout').classList.add('show');
  });

  $('signoutCancel').addEventListener('click', function () {
    $('signout').classList.remove('show');
  });

  $('signoutGo').addEventListener('click', function () {
    state.scanning = false;
    stopSessionTimers();
    stopStream();
    cancelAutoClear();

    state.idToken = null;
    state.expiresAt = 0;
    state.email = '';
    state.periodKey = '';
    state.candidateSig = '';
    state.candidates = [];
    state.seen.clear();
    state.draining = false;
    state.showing = null;
    state.bannerSticky = false;

    // The outgoing volunteer's scans must not be readable by whoever picks up the phone.
    // Every chip is tappable and shows a student's name and roll number, so clearing the
    // strip is not cosmetic. The queue itself is kept: those scans still have to be sent.
    state.recorded = 0;
    state.chips = {};
    state.chipOrder = [];
    state.results = {};
    photoCache = {};                       // faces must not survive the volunteer who saw them
    if (state.check && state.check.timer) clearTimeout(state.check.timer);
    state.check = null;                    // an outstanding check must not block the next session
    $('recent').innerHTML = '';
    $('count').textContent = '0';
    banner('');

    // Without this the next sign-in silently reuses the same account, which is exactly the
    // problem someone is trying to solve by signing out.
    try { google.accounts.id.disableAutoSelect(); } catch (e) {}

    $('signout').classList.remove('show');
    $('verdict').className = '';
    ['hdr', 'stage', 'ftr'].forEach(function (id) { $(id).classList.add('hidden'); });
    $('signin').classList.remove('hidden');
    signinError(state.queue.length
      ? state.queue.length + ' scan(s) are still held on this phone. Whoever signs in next ' +
        'will have them recorded in their name.'
      : '');
  });

  // =========================================================================
  // Server calls
  // =========================================================================

  function api(action, extra) {
    if (!tokenUsable()) { requireReauth(); return Promise.reject(new Error('SIGNIN_EXPIRED')); }

    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, CFG.REQUEST_TIMEOUT_MS || 10000);
    var sentAt = Date.now();

    return fetch(CFG.EXEC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign(
        { action: action, idToken: state.idToken, clientNow: sentAt }, extra || {})),
      redirect: 'follow',
      signal: ctl.signal
    }).then(function (r) {
      if (!r.ok) throw new Error('Server returned ' + r.status);
      return r.json();
    }).then(function (data) {
      noteClock(data, sentAt);
      return data;
    }).finally(function () { clearTimeout(timer); });
  }

  /**
   * Every reply carries the server's clock. Comparing it with ours — allowing for half the
   * round trip — gives the error on this phone's clock, which is then stamped onto each
   * scan so the server can place it in the right class regardless of what the device
   * thinks the time is.
   */
  function noteClock(data, sentAt) {
    if (!data || typeof data.serverNow !== 'number') return;
    var rtt = Date.now() - sentAt;
    var offset = data.serverNow - (sentAt + rtt / 2);
    state.clockOffset = Math.round(offset);
    state.clockKnown = true;
    try { localStorage.setItem(OFFSET_KEY, String(state.clockOffset)); } catch (e) {}

    if (Math.abs(state.clockOffset) > 120000) {
      banner('caution', 'This phone\u2019s clock is ' + Math.round(state.clockOffset / 60000) +
        ' min out. Scans are being corrected, but turn on automatic date and time.');
    }
  }

  function loadClockOffset() {
    try {
      var raw = localStorage.getItem(OFFSET_KEY);
      if (raw !== null && isFinite(Number(raw))) state.clockOffset = Number(raw);
    } catch (e) {}
  }

  function startSession() {
    api('session').then(function (s) {
      if (!s.ok) {
        if (s.error === 'TOKEN_EXPIRED' || s.error === 'TOKEN_INVALID') { requireReauth(); return; }
        // NOT_CONFIGURED is the backend saying setup is unfinished. Showing it verbatim
        // saves the volunteer reporting "it does not work" and the office guessing.
        signinError((s.error === 'NOT_CONFIGURED' ? 'Setup incomplete. ' : '') +
                    (s.message || 'Sign-in refused.'));
        return;
      }
      if (s.event && CFG.EVENT_CODE && s.event !== CFG.EVENT_CODE) {
        signinError('This page is set to ' + CFG.EVENT_CODE + ' but the log expects ' + s.event +
          '. Fix EVENT_CODE in config.js before scanning.');
        return;
      }
      $('signin').classList.add('hidden');
      ['hdr', 'stage', 'ftr'].forEach(function (id) { $(id).classList.remove('hidden'); });
      $('who').textContent = s.volunteer + ' · ' + s.email;
      state.email = s.email;
      setPeriod(s);
      if (s.manualEntry) $('tools').classList.remove('hidden');

      loadClockOffset();
      loadQueue();
      updateQueueBadge();
      startCamera();
      // Tracked, because signing out and back in would otherwise leave the previous
      // session's timers running: three sign-ins meant three drain loops racing one queue.
      startSessionTimers();
    }).catch(function (err) {
      if (err.message !== 'SIGNIN_EXPIRED') {
        signinError('Could not reach the log (' + err.message + '). Check EXEC_URL in config.js.');
      }
    });
  }

  function startSessionTimers() {
    stopSessionTimers();
    state.timers.push(setInterval(function () {
      purgeQueue();
      if (tokenUsable()) drain();
    }, CFG.SYNC_INTERVAL_MS || 6000));
    state.timers.push(setInterval(pollPeriod, 45000));
    state.timers.push(setInterval(function () { if (!tokenUsable()) requireReauth(); }, 30000));
  }

  function stopSessionTimers() {
    state.timers.forEach(clearInterval);
    state.timers = [];
  }

  function pollPeriod() {
    if (!tokenUsable() || state.draining) return;
    api('period').then(function (p) { if (p.ok) setPeriod(p); }).catch(function () {});
  }

  function setPeriod(s) {
    // Authoritative value from the server; config.js is only a fallback.
    if (s && s.photoCheckWindowMs) state.photoCheckWindowMs = s.photoCheckWindowMs;
    var el = $('period');
    var cands = s.candidates || [];
    var sig = cands.map(function (c) { return c.key; }).sort().join('|');

    // The set of running classes changed, so any earlier choice is stale.
    if (sig !== state.candidateSig) {
      state.candidateSig = sig;
      state.periodKey = '';
      $('picker').classList.remove('show');
    }

    state.candidates = cands;

    if (!cands.length) {
      el.textContent = 'No class running';
      el.className = 'period none';
      $('hint').textContent = s.nextPeriod ? 'Next: ' + s.nextPeriod : 'Nothing else timetabled today';
    } else if (cands.length === 1) {
      el.textContent = cands[0].name + (cands[0].slot ? ' · ' + cands[0].slot : '');
      el.className = 'period';
      $('hint').textContent = 'Recording ' + cands[0].name +
        (cands[0].room ? ' · ' + cands[0].room : '') + ' until ' + cands[0].ends;
    } else {
      var chosen = cands.filter(function (c) { return c.key === state.periodKey; })[0];
      el.textContent = chosen ? chosen.name + ' · ' + chosen.slot
                              : cands.length + ' classes in slot ' + (cands[0].slot || '?');
      el.className = 'period pick';
      $('hint').textContent = chosen
        ? 'Recording ' + chosen.name + '. Tap the title to change.'
        : 'Tap the title to pick a class, or scan and let the roll number decide.';
    }

    if (s.timetableWarning) {
      banner('alarm', s.timetableWarning);
    } else if (s.period && s.tabReady === false) {
      banner('alarm', 'No log tab for “' + s.period + '”. Ask the desk to run Create all period tabs.');
    } else if (s.endingSoon && s.period) {
      banner('caution', s.minutesLeft + ' min left in ' + s.period +
        '. Scans after that are recorded against the next class.');
    } else if (!s.period) {
      banner('caution', s.nextPeriod
        ? 'No class running. Next: ' + s.nextPeriod
        : 'No class running. Nothing will be recorded.');
    } else {
      banner('');
    }
  }

  /**
   * @param sticky  A notice that data was lost. It outranks status messages and stays until
   *                the volunteer taps it. Ordering fixes alone are not enough here: any
   *                later caller of banner('') would otherwise erase the only record that
   *                scans were discarded, which is the one message that must not vanish.
   */
  function banner(tone, msg, sticky) {
    var b = $('banner');
    if (!msg && state.bannerSticky) return;          // routine updates cannot clear a loss notice
    if (state.bannerSticky && !sticky) return;
    state.bannerSticky = !!sticky && !!msg;
    b.className = msg ? 'show ' + tone + (sticky ? ' sticky' : '') : '';
    b.textContent = msg ? (sticky ? msg + '  (tap to dismiss)' : msg) : '';
  }

  $('banner').addEventListener('click', function () {
    if (!state.bannerSticky) return;
    state.bannerSticky = false;
    banner('');
  });

  // =========================================================================
  // Draining the queue
  // =========================================================================

  function drain() {
    if (state.draining || !state.queue.length || !tokenUsable()) return;
    state.draining = true;

    var batch = state.queue.slice(0, 50);
    var ids = batch.map(function (i) { return i.id; });

    api('sync', { items: batch, periodKey: state.periodKey, sessionId: state.sessionId })
      .then(function (resp) {
        if (!resp.ok) {
          if (resp.error === 'TOKEN_EXPIRED' || resp.error === 'TOKEN_INVALID') { requireReauth(); return; }
          banner('caution', resp.message + ' Scans stay queued.');
          return;
        }
        state.queue = state.queue.filter(function (i) { return ids.indexOf(i.id) === -1; });
        saveQueue();
        updateQueueBadge();
        banner('');

        // setPeriod is allowed to clear the banner, so the period is refreshed BEFORE the
        // results are applied. Otherwise a notice about a queued scan that came back a
        // problem is raised and wiped in the same tick, and the volunteer never sees it.
        setPeriod(resp);
        (resp.results || []).forEach(applyResult);
      })
      .catch(function (err) {
        if (err.message === 'SIGNIN_EXPIRED') return;
        banner('caution', 'Offline — ' + state.queue.length + ' scan(s) held on this phone.');
      })
      .finally(function () { state.draining = false; });
  }

  /**
   * Forced photo check.
   *
   * The photo is fetched automatically rather than waiting for a tap: the point is that the
   * volunteer looks, and a button they must press first is a button they can learn to press
   * without looking. Fetching also records the view in the audit trail, so an answer given
   * with no corresponding fetch is visible afterwards.
   *
   * The countdown is not decoration. An answer given two minutes later is a guess, and a
   * guess recorded as a pass would quietly destroy the meaning of every honest answer beside
   * it — so an unanswered prompt records as TIMEOUT, which is a different fact from "matches".
   */
  function startCheck(v) {
    cancelAutoClear();
    state.check = {
      roll: v.roll, ticket: v.photoTicket, id: v.id, timer: null,
      // Set when the photograph is actually DISPLAYED, not now. api() can take its full
      // timeout on a weak signal, and a window that short exists because a late answer is a
      // guess — spending it on network latency produces exactly the rushed answers the timer
      // is meant to prevent. The course is not carried at all: the server wrote it on the
      // ASKED row and joins the two by scan id.
      deadline: null
    };
    state.scanning = false;

    $('photoBtn').classList.add('hidden');
    $('vNext').classList.add('hidden');
    $('checkBox').classList.remove('hidden');
    $('checkYes').disabled = true;
    $('checkNo').disabled = true;
    $('checkAsk').textContent = 'Fetching photo…';

    fetchPhoto(v).then(function () {
      if (!state.check) return;
      $('checkAsk').textContent = 'Check this face against the person in front of you.';
      $('checkYes').disabled = false;
      $('checkNo').disabled = false;
      state.check.deadline = Date.now() + (state.photoCheckWindowMs || CFG.PHOTO_CHECK_WINDOW_MS || 30000);
      tick();
    }).catch(function () {
      if (!state.check) return;
      // No photo means no check is possible. Recording MATCH here would be a lie, so it
      // closes as TIMEOUT — an unanswerable prompt and an ignored one are both "not checked",
      // which is the honest category.
      state.check.unanswerable = true;
      $('checkAsk').textContent = 'Photo unavailable — cannot check. Carry on.';
      $('checkYes').disabled = true;
      $('checkNo').disabled = false;
      $('checkNo').textContent = 'Continue';
    });

    function tick() {
      if (!state.check || !state.check.deadline) return;
      var left = Math.max(0, Math.ceil((state.check.deadline - Date.now()) / 1000));
      $('checkTimer').textContent = left + 's — after this it records as not checked';
      if (left <= 0) { answerCheck('TIMEOUT'); return; }
      state.check.timer = setTimeout(tick, 500);
    }
    $('checkTimer').textContent = '';
  }

  function answerCheck(answer) {
    var c = state.check;
    if (!c) return;
    if (c.timer) clearTimeout(c.timer);
    state.check = null;

    $('checkBox').classList.add('hidden');
    $('checkNo').textContent = "Doesn't match";
    $('photoBtn').classList.remove('hidden');
    $('vNext').classList.remove('hidden');

    if (answer === 'MISMATCH') {
      banner('alarm', 'Recorded as not matching. The scan still counts; the office is told ' +
        'tonight. Do not confront anyone.', true);
    }

    // Fire and forget: the answer must not hold up scanning, and a failed send is visible
    // afterwards as an ASKED row with no outcome.
    api('verify', { roll: c.roll, answer: answer, id: c.id, ticket: c.ticket })
      .catch(function () { /* the gap in the trail is the record */ });

    clearVerdict();
    if (tokenUsable()) beginLoop();
  }

  $('checkYes').addEventListener('click', function () { answerCheck('MATCH'); });
  $('checkNo').addEventListener('click', function () {
    // Doubles as "Continue" when no photo could be fetched. That case is not a mismatch —
    // nothing was compared — so it records as TIMEOUT, the honest "not checked".
    answerCheck(state.check && state.check.unanswerable ? 'TIMEOUT' : 'MISMATCH');
  });

  function applyResult(v) {
    state.results[v.id] = v;
    var tone = toneFor(v.status);
    if (v.status === 'OK') { state.recorded++; $('count').textContent = state.recorded; }

    var chip = state.chips[v.id];
    if (chip) {
      chip.className = 'chip ' + tone;
      chip.textContent = v.roll || v.status;
    }
    if (state.showing === v.id) {
      showVerdict(v);
      signal(tone);
      // The server chose this scan for a forced check. Only ever set on a fresh, online
      // verdict, so this cannot fire for a scan the queue held while the student walked off.
      if (v.verifyPhoto && !state.check) startCheck(v);
    } else if (v.verifyPhoto) {
      // Chosen, but the volunteer has already moved to another verdict. Checking a face that
      // is no longer on screen proves nothing, so it closes honestly as not checked rather
      // than dragging them back to a stale card.
      api('verify', { roll: v.roll, answer: 'TIMEOUT', id: v.id, ticket: v.photoTicket })
        .catch(function () {});
    } else if (tone === 'bad' || tone === 'warn') {
      // A queued scan came back a problem after the person has moved on.
      banner('caution', (v.roll || 'A queued scan') + ': ' + v.headline + ' — tap the list below to review.');
    }
  }

  function toneFor(status) {
    if (status === 'OK') return 'ok';
    if (status === 'DUPLICATE') return 'warn';
    if (status === 'PENDING') return 'pend';
    return 'bad';
  }

  // =========================================================================
  // Choosing between classes that share a slot
  // =========================================================================

  function openPicker() {
    var cands = state.candidates || [];
    if (cands.length < 2) return;
    $('pickerWhy').textContent = cands.length +
      ' courses share slot ' + (cands[0].slot || '') +
      '. Pick one, or leave it on automatic and each scan is filed by the student\u2019s enrolment.';

    var list = $('pickerList');
    list.innerHTML = '';

    list.appendChild(pickerButton('Automatic', 'Decide by roll number', '', true));
    cands.forEach(function (c) {
      list.appendChild(pickerButton(c.name, (c.title || '') +
        (c.room ? ' · ' + c.room : '') + ' · ends ' + c.ends, c.key, false));
    });
    $('picker').classList.add('show');
  }

  function pickerButton(code, meta, key, isAuto) {
    var b = document.createElement('button');
    b.type = 'button';
    if (isAuto) b.className = 'auto';
    var c = document.createElement('span'); c.className = 'code'; c.textContent = code;
    var m = document.createElement('span'); m.className = 'meta'; m.textContent = meta;
    b.appendChild(c); b.appendChild(m);
    b.addEventListener('click', function () {
      state.periodKey = key;
      $('picker').classList.remove('show');
      pollPeriod();
    });
    return b;
  }

  $('period').addEventListener('click', openPicker);

  // =========================================================================
  // Camera
  // =========================================================================

  function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      banner('alarm', 'This browser cannot open the camera. Use Chrome on Android or Safari on iPhone.');
      return;
    }
    openStream({ facingMode: { ideal: 'environment' } })
      .then(listCameras)
      .then(prepareDecoder)
      .then(beginLoop)
      .catch(function (err) {
        banner('alarm', 'Camera blocked (' + err.name + '). Allow camera access for this site, then reload.');
      });
  }

  function openStream(video) {
    stopStream();
    return navigator.mediaDevices.getUserMedia({ video: video, audio: false }).then(function (stream) {
      state.stream = stream;
      state.track = stream.getVideoTracks()[0];
      var v = $('video');
      v.srcObject = stream;
      v.setAttribute('playsinline', '');
      return v.play().then(function () { setTimeout(setupTorch, 400); });
    });
  }

  function stopStream() {
    if (state.stream) state.stream.getTracks().forEach(function (t) { t.stop(); });
    state.stream = null; state.track = null;
  }

  function listCameras() {
    if (!navigator.mediaDevices.enumerateDevices) return;
    return navigator.mediaDevices.enumerateDevices().then(function (all) {
      state.devices = all.filter(function (d) { return d.kind === 'videoinput'; });
      if (state.devices.length > 1) $('swapBtn').classList.remove('hidden');
    }).catch(function () {});
  }

  function setupTorch() {
    var btn = $('torchBtn');
    btn.classList.add('hidden');
    btn.classList.remove('on');
    if (!state.track || !state.track.getCapabilities) return;
    try {
      var caps = state.track.getCapabilities();
      if (caps && caps.torch) btn.classList.remove('hidden');
    } catch (e) {}
  }

  $('torchBtn').addEventListener('click', function () {
    if (!state.track) return;
    var on = !this.classList.contains('on');
    state.track.applyConstraints({ advanced: [{ torch: on }] })
      .then(function () { $('torchBtn').classList.toggle('on', on); })
      .catch(function () { $('torchBtn').classList.add('hidden'); });
  });

  $('swapBtn').addEventListener('click', function () {
    if (state.devices.length < 2) return;
    state.scanning = false;
    state.deviceIndex = (state.deviceIndex + 1) % state.devices.length;
    openStream({ deviceId: { exact: state.devices[state.deviceIndex].deviceId } })
      .then(beginLoop)
      .catch(function () {
        banner('caution', 'That camera would not open. Falling back to the main one.');
        openStream({ facingMode: { ideal: 'environment' } }).then(beginLoop)
          .catch(function () { banner('alarm', 'Camera lost. Reload the page.'); });
      });
  });

  // =========================================================================
  // Decode loop — native BarcodeDetector where available, jsQR everywhere else
  // =========================================================================

  function prepareDecoder() {
    if (!('BarcodeDetector' in window)) return;
    return BarcodeDetector.getSupportedFormats().then(function (formats) {
      if (formats.indexOf('qr_code') !== -1) state.detector = new BarcodeDetector({ formats: ['qr_code'] });
    }).catch(function () {});
  }

  /** Bumps the generation counter so any earlier loop exits on its next turn. */
  function beginLoop() {
    // A forced check blocks NEW scans only. The queue keeps draining in the background, so a
    // volunteer is never waiting on the network to get past a prompt.
    if (state.check) return;
    state.scanning = true;
    state.loop++;
    tick(state.loop);
  }

  function tick(generation) {
    if (!state.scanning || generation !== state.loop) return;
    decodeFrame().then(function (text) {
      if (text) handleDecoded(text);
    }).catch(function () {}).finally(function () {
      pruneSeen();
      setTimeout(function () { tick(generation); }, CFG.DECODE_INTERVAL_MS || 120);
    });
  }

  function decodeFrame() {
    var v = $('video');
    if (!v.videoWidth) return Promise.resolve(null);

    if (state.detector) {
      return state.detector.detect(v).then(function (codes) {
        return codes.length ? codes[0].rawValue : null;
      }).catch(function () { state.detector = null; return null; });
    }

    var canvas = $('work');
    var scale = Math.min(1, 640 / v.videoWidth);
    var w = Math.round(v.videoWidth * scale);
    var h = Math.round(v.videoHeight * scale);
    canvas.width = w; canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, w, h);
    var img = ctx.getImageData(0, 0, w, h);
    var found = window.jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
    return Promise.resolve(found ? found.data : null);
  }

  /**
   * Suppression is keyed on the decoded text and lives independently of the verdict card,
   * so dismissing a verdict while the pass is still in frame does not re-submit it.
   */
  function handleDecoded(text) {
    var now = Date.now();
    var seenAt = state.seen.get(text);
    if (seenAt && now - seenAt < 15000) return;
    state.seen.set(text, now);
    submit(text, false);
  }

  function pruneSeen() {
    var cutoff = Date.now() - 60000;
    state.seen.forEach(function (ts, key) { if (ts < cutoff) state.seen.delete(key); });
  }

  // =========================================================================
  // Submitting
  // =========================================================================

  /** Reads the roll number straight off the pass so the card is instant, even offline. */
  function localRoll(text) {
    var parts = String(text).split('.');
    if (parts.length !== 4 || parts[0] !== CFG.EVENT_CODE) return null;
    return parts[1];
  }

  function submit(payload, manual, noDevice) {
    var item = enqueue(payload, manual, noDevice);
    var roll = manual ? String(payload).toUpperCase() : localRoll(payload);

    addChip(item.id, roll || '?', 'pend');
    state.showing = item.id;
    cancelAutoClear();

    if (!manual && !roll) {
      showVerdict({ id: item.id, status: 'INVALID', headline: 'Not this event’s pass',
        detail: 'The code does not carry an ' + CFG.EVENT_CODE + ' pass. Sending it to the log anyway.' });
      signal('bad');
    } else {
      showVerdict({ id: item.id, status: 'PENDING', headline: 'Checking…', roll: roll || '',
        detail: 'Verifying against today\u2019s log.' });
    }
    drain();
  }

  // =========================================================================
  // Verdict card
  // =========================================================================

  function showVerdict(v) {
    var tone = toneFor(v.status);
    $('verdict').className = 'show ' + tone;
    $('vHead').textContent = v.headline || '';
    $('vRoll').textContent = v.roll || '';
    $('vName').textContent = v.name || '';
    $('vProg').textContent = v.programme || '';
    $('vDetail').textContent = v.detail || '';

    // Photo is loaded only when a volunteer asks for it — it never delays a scan.
    $('photoWrap').classList.add('hidden');
    $('photoNote').classList.add('hidden');
    $('vPhoto').removeAttribute('src');

    // The photo is available on EVERY resolved scan, not only sampled ones — sampling decides
    // what is compulsory, never what is possible. It matters most on REVOKED and NOT_ENROLLED,
    // where a volunteer is about to refuse someone.
    //
    // The three unavailable cases say WHY, because they are different facts and a volunteer
    // acts differently on each. Labelling them all "No photo on file" told them nothing to
    // check when the truth was that no photo could be requested here.
    var btn = $('photoBtn');
    if (v.status === 'PENDING') {
      btn.disabled = true; btn.textContent = 'Photo';
    } else if (v.hasPhoto && v.photoTicket) {
      btn.disabled = false; btn.textContent = 'Show photo';
    } else if (v.hasPhoto && !v.photoTicket) {
      btn.disabled = true; btn.textContent = 'Photo n/a (typed entry)';
    } else if (v.roll) {
      btn.disabled = true; btn.textContent = 'No photo on file';
    } else {
      btn.disabled = true; btn.textContent = 'No photo';
    }

    cancelAutoClear();
    if (v.status === 'OK') state.autoClear = setTimeout(clearVerdict, 2600);
    if (v.status === 'AMBIGUOUS') setTimeout(openPicker, 400);
  }

  /**
   * Photographs arrive as bytes over the authenticated channel, never from a URL.
   *
   * There is no address here to leak, share or put in a browser history — the verdict carries
   * a short-lived ticket, and this exchanges it for the image itself. Held in a plain variable
   * so it never reaches the HTTP cache or disk, and dropped on sign-out with the rest of the
   * verdict state. A pass that is scanned but never inspected is never transmitted at all.
   */
  $('photoBtn').addEventListener('click', function () {
    var v = state.results[state.showing];
    if (!v || !v.hasPhoto || !v.photoTicket) return;
    cancelAutoClear();                       // the volunteer is inspecting; stop the timer

    var btn = this;
    var wrap = $('photoWrap'), img = $('vPhoto'), note = $('photoNote');
    wrap.classList.remove('hidden');
    note.classList.remove('hidden');
    img.removeAttribute('src');
    btn.disabled = true;

    img.onload = function () { note.classList.add('hidden'); };
    img.onerror = function () {
      note.textContent = 'Photo could not be displayed. The record is still valid.';
      img.removeAttribute('src');
    };

    note.textContent = photoCache[v.roll] ? 'Loading photo…' : 'Fetching photo…';
    btn.textContent = 'Fetching…';

    fetchPhoto(v).then(function () {
      btn.textContent = 'Photo shown';
    }).catch(function (err) {
      note.textContent = err.message || 'Photo unavailable.';
      // Re-enable: a ticket can expire while the verdict is still on screen, and the
      // volunteer should be able to try again after rescanning rather than be stuck.
      btn.disabled = false;
      btn.textContent = 'Show photo';
    });
  });

  /**
   * Fetches a photograph and puts it on screen. One path for both the manual button and the
   * forced check, so the caching, the error shape and the audit trail cannot drift apart.
   * Resolves once the image is displayed; rejects with a message worth showing.
   */
  function fetchPhoto(v) {
    var wrap = $('photoWrap'), img = $('vPhoto'), note = $('photoNote');
    wrap.classList.remove('hidden');
    note.classList.remove('hidden');

    var show = function (uri) {
      return new Promise(function (resolve, reject) {
        img.onload = function () { note.classList.add('hidden'); resolve(); };
        img.onerror = function () { img.removeAttribute('src'); reject(new Error('Photo could not be displayed.')); };
        img.src = uri;
      });
    };

    if (photoCache[v.roll]) return show(photoCache[v.roll]);
    if (!v.photoTicket) return Promise.reject(new Error('No photo available for this scan.'));

    // api() resolves to the PARSED body, not a Response — resp.ok is the server's own flag.
    return api('photo', { roll: v.roll, ticket: v.photoTicket }).then(function (resp) {
      if (!resp.ok) {
        if (resp.error === 'TOKEN_EXPIRED' || resp.error === 'TOKEN_INVALID') requireReauth();
        throw new Error(resp.message || 'Photo unavailable.');
      }
      var uri = 'data:' + resp.mime + ';base64,' + resp.data;
      photoCache[v.roll] = uri;
      return show(uri);
    });
  }

  function cancelAutoClear() {
    if (state.autoClear) { clearTimeout(state.autoClear); state.autoClear = null; }
  }

  function clearVerdict() {
    cancelAutoClear();
    $('verdict').className = '';
    state.showing = null;
  }
  $('vNext').addEventListener('click', clearVerdict);

  // =========================================================================
  // Recent list
  // =========================================================================

  function addChip(id, label, tone) {
    var c = document.createElement('button');
    c.type = 'button';
    c.className = 'chip ' + tone;
    c.textContent = label;
    c.addEventListener('click', function () {
      var v = state.results[id];
      if (!v) return;
      state.showing = id;
      showVerdict(v);
    });
    state.chips[id] = c;
    state.chipOrder.push(id);
    $('recent').prepend(c);

    // The strip is trimmed to 30, and the lookup maps are trimmed with it. Leaving entries
    // behind would grow both maps for the whole shift with no way to reach them.
    var kids = $('recent').children;
    while (kids.length > 30) $('recent').removeChild(kids[kids.length - 1]);
    while (state.chipOrder.length > 30) {
      var gone = state.chipOrder.shift();
      delete state.chips[gone];
      delete state.results[gone];
    }
  }

  function signal(tone) {
    if (navigator.vibrate) navigator.vibrate(tone === 'ok' ? 45 : [70, 60, 70]);
    try {
      state.audio = state.audio || new (window.AudioContext || window.webkitAudioContext)();
      var osc = state.audio.createOscillator();
      var gain = state.audio.createGain();
      osc.connect(gain); gain.connect(state.audio.destination);
      osc.frequency.value = tone === 'ok' ? 1080 : 340;
      gain.gain.setValueAtTime(0.18, state.audio.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, state.audio.currentTime + 0.16);
      osc.start(); osc.stop(state.audio.currentTime + 0.17);
    } catch (e) {}
  }

  // =========================================================================
  // Manual entry
  // =========================================================================

  $('manualGo').addEventListener('click', function () {
    var v = $('manualRoll').value.trim();
    if (!v) return;
    $('manualRoll').value = '';
    submit(v, true, false);
  });

  // Separate button, not a checkbox on the one above. Vouching is a different act from an
  // ordinary typed entry — it is capped, it names you in the log, and on a dynamic day it is
  // the only typed entry accepted at all. A tick box beside "Record manually" would get
  // clicked by habit; a button you have to reach for does not.
  $('noDeviceGo').addEventListener('click', function () {
    var v = $('manualRoll').value.trim();
    if (!v) return;
    $('manualRoll').value = '';
    submit(v, true, true);
  });
  $('manualRoll').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') $('manualGo').click();
  });

  // =========================================================================
  // Lifecycle
  // =========================================================================

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      state.scanning = false;
    } else if (state.stream && tokenUsable()) {
      $('video').play().catch(function () {});
      beginLoop();
      drain();
      pollPeriod();
    }
  });

  window.addEventListener('online', function () { banner(''); drain(); });
  window.addEventListener('offline', function () {
    banner('caution', 'Offline — scans are held on this phone and sent when the signal returns.');
  });

  window.addEventListener('beforeunload', function (e) {
    if (state.queue.length) { e.preventDefault(); e.returnValue = ''; }
  });

  function waitFor(test, ok, giveUp) {
    var tries = 0;
    (function loop() {
      if (test()) return ok();
      if (++tries > 100) return giveUp();
      setTimeout(loop, 100);
    })();
  }
})();
