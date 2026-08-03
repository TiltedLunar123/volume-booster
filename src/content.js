/*
 * Volume Booster: per-frame audio engine.
 *
 * Runs in the isolated world of every frame. Owns one AudioContext and one
 * gain/limiter chain per media element.
 *
 * The single most important rule in this file: createMediaElementSource()
 * permanently reroutes an element's audio and there is no way to undo it. If we
 * connect an element whose audio cannot legally flow through Web Audio, the page
 * goes silent until it is reloaded, and nothing throws to warn us. So every
 * element is classified before it is connected, never after.
 */
'use strict';

(function () {
  var api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;
  if (!api || !api.runtime || !api.runtime.id) return;

  // Guard against running twice (declared content script plus the injected
  // fallback both landing in the same frame).
  if (window.__volumeBoosterActive) return;
  window.__volumeBoosterActive = true;

  var MAX_GAIN = 6;
  var SWEEP_MS = 2500;
  var RAMP_SEC = 0.02;
  var DEEP_SCAN_EVERY = 4;

  // Limiter, not a mix compressor. It sits in the chain only above unity so that
  // 100% is bit-identical to having no extension installed.
  var LIMITER = {
    threshold: -3,
    knee: 0,
    ratio: 20,
    attack: 0.003,
    release: 0.15
  };

  var desired = 1;
  var muted = false;
  var limiterOn = true;

  var ctx = null;
  var tracked = new Set();
  var graphs = new WeakMap();
  var permanentlyFailed = new WeakSet();
  var originalVolume = new WeakMap();

  var port = null;
  var portRetries = 0;
  var sweepCount = 0;
  var mutationTimer = 0;
  var statusTimer = 0;
  var lastStatusKey = '';

  /* ------------------------------------------------------------------ *
   * Classification
   * ------------------------------------------------------------------ */

  var SAFE_SCHEME = /^(blob:|data:|mediasource:|filesystem:|file:)/i;

  /**
   * ok        routable through Web Audio, safe to connect
   * protected encrypted media, cannot enter Web Audio
   * tainted   CORS-cross-origin, the node would output zeroes
   * pending   no source resolved yet, ask again later
   */
  function classify(el) {
    if (el.mediaKeys) return 'protected';

    // A MediaStream source (WebRTC, captureStream) is never CORS tainted.
    if (el.srcObject) return 'ok';

    var src = el.currentSrc || el.src || '';
    if (!src) return 'pending';
    if (SAFE_SCHEME.test(src)) return 'ok';

    var url;
    try {
      url = new URL(src, location.href);
    } catch (e) {
      return 'pending';
    }
    if (url.origin === location.origin) return 'ok';

    // Cross-origin. Only safe if the page asked for CORS, in which case the
    // server's response headers decided it and the browser already enforced it.
    var co = el.crossOrigin;
    if (co === 'anonymous' || co === 'use-credentials' || co === '') return 'ok';
    return 'tainted';
  }

  /* ------------------------------------------------------------------ *
   * Audio graph
   * ------------------------------------------------------------------ */

  function audioContext() {
    if (!ctx) {
      var Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      try {
        ctx = new Ctor();
      } catch (e) {
        return null;
      }
    }
    if (ctx.state === 'suspended' && ctx.resume) {
      var p = ctx.resume();
      if (p && p.catch) p.catch(function () {});
    }
    return ctx;
  }

  function connect(el) {
    var existing = graphs.get(el);
    if (existing) return existing;
    if (permanentlyFailed.has(el)) return null;

    var c = audioContext();
    if (!c) return null;

    var source;
    try {
      source = c.createMediaElementSource(el);
    } catch (e) {
      // Already owned by another AudioContext, most likely another extension.
      permanentlyFailed.add(el);
      return null;
    }

    var gain = c.createGain();
    gain.gain.value = 1;

    var limiter = c.createDynamicsCompressor();
    limiter.threshold.value = LIMITER.threshold;
    limiter.knee.value = LIMITER.knee;
    limiter.ratio.value = LIMITER.ratio;
    limiter.attack.value = LIMITER.attack;
    limiter.release.value = LIMITER.release;
    limiter.connect(c.destination);

    // A tap, not a stage: nothing is connected downstream of the analyser, so it
    // cannot colour the audio. It exists to catch the one failure we cannot
    // prevent, described at checkSilence() below.
    var analyser = null;
    try {
      analyser = c.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
    } catch (e) {
      analyser = null;
    }

    source.connect(gain);
    gain.connect(c.destination);

    var entry = {
      source: source,
      gain: gain,
      limiter: limiter,
      analyser: analyser,
      buffer: null,
      zeroRuns: 0,
      silent: false,
      limited: false
    };
    graphs.set(el, entry);
    return entry;
  }

  /*
   * classify() runs before we connect, so CORS-tainted media never enters the
   * graph. One case slips past it: a same-origin URL that redirects to another
   * origin. currentSrc still reads same-origin, the element is already wired in,
   * and the source node quietly emits zeroes forever with no exception.
   *
   * Nothing can undo the routing at that point, so instead we notice it. If a
   * playing, unmuted element produces digital silence across three consecutive
   * checks, the popup tells the user to reload rather than leaving them to think
   * the site is broken.
   */
  function checkSilence() {
    if (!ctx || ctx.state !== 'running') return;
    var level = muted ? 0 : desired;
    if (level === 0) return;

    tracked.forEach(function (el) {
      var entry = graphs.get(el);
      if (!entry || !entry.analyser) return;

      if (el.paused || el.muted || el.volume === 0 || el.readyState < 2) {
        entry.zeroRuns = 0;
        entry.silent = false;
        return;
      }

      if (!entry.buffer) entry.buffer = new Float32Array(entry.analyser.fftSize);
      try {
        entry.analyser.getFloatTimeDomainData(entry.buffer);
      } catch (e) {
        return;
      }

      var peak = 0;
      for (var i = 0; i < entry.buffer.length; i++) {
        var v = entry.buffer[i] < 0 ? -entry.buffer[i] : entry.buffer[i];
        if (v > peak) peak = v;
      }

      entry.zeroRuns = peak === 0 ? entry.zeroRuns + 1 : 0;
      entry.silent = entry.zeroRuns >= 3;
    });
  }

  function routeLimiter(entry, on) {
    if (entry.limited === on) return;
    try {
      entry.gain.disconnect();
    } catch (e) { /* nothing was connected */ }
    entry.gain.connect(on ? entry.limiter : ctx.destination);
    entry.limited = on;
  }

  // Reduce-only fallback for elements we must not route: protected and tainted
  // media. Boost is impossible there, but turning the volume down is not.
  function setFallback(el, level) {
    if (!originalVolume.has(el)) originalVolume.set(el, el.volume);
    try { el.volume = Math.max(0, Math.min(1, level)); } catch (e) {}
  }

  function clearFallback(el) {
    if (!originalVolume.has(el)) return;
    try { el.volume = originalVolume.get(el); } catch (e) {}
    originalVolume.delete(el);
  }

  function setGain(entry, level) {
    routeLimiter(entry, limiterOn && level > 1);
    var target = Math.max(0, Math.min(MAX_GAIN, level));
    try {
      entry.gain.gain.setTargetAtTime(target, ctx.currentTime, RAMP_SEC);
    } catch (e) {
      entry.gain.gain.value = target;
    }
  }

  function apply() {
    var level = muted ? 0 : desired;
    var unity = level === 1;

    tracked.forEach(function (el) {
      var kind = classify(el);
      var entry = graphs.get(el);

      // Never build a graph just to set unity gain. An element that has not been
      // connected stays untouched, which keeps 100% a true no-op.
      if (!entry && unity) {
        clearFallback(el);
        return;
      }

      if (!entry && kind === 'ok') entry = connect(el);

      if (entry) {
        // Once connected the element's audio only exists inside the graph, so
        // the graph stays authoritative even if the source later changes.
        clearFallback(el);
        setGain(entry, level);
        return;
      }

      // An element with no resolved source yet makes no sound, so leave its
      // volume alone rather than writing a value we would have to put back. The
      // page may adjust its own volume in the meantime, and restoring a stale
      // reading over the top of that would be worse than doing nothing.
      if (kind === 'pending') return;

      // Protected, tainted, or refused by another extension: reduce only.
      setFallback(el, Math.min(1, level));
    });

    scheduleStatus();
  }

  /* ------------------------------------------------------------------ *
   * Discovery
   * ------------------------------------------------------------------ */

  function track(el) {
    if (!el || tracked.has(el)) return false;
    if (!(el instanceof HTMLMediaElement)) return false;
    tracked.add(el);
    el.addEventListener('loadstart', onMediaEvent, true);
    el.addEventListener('emptied', onMediaEvent, true);
    return true;
  }

  function collect(root, out, deep) {
    var found;
    try {
      found = root.querySelectorAll('audio,video');
    } catch (e) {
      return out;
    }
    for (var i = 0; i < found.length; i++) out.push(found[i]);

    if (!deep) return out;
    var all;
    try {
      all = root.querySelectorAll('*');
    } catch (e) {
      return out;
    }
    for (var j = 0; j < all.length; j++) {
      if (all[j].shadowRoot) collect(all[j].shadowRoot, out, true);
    }
    return out;
  }

  function scan(deep) {
    if (!document.documentElement) return false;
    var found = collect(document, [], deep);
    var added = false;
    for (var i = 0; i < found.length; i++) {
      if (track(found[i])) added = true;
    }
    return added;
  }

  function prune() {
    var dead = [];
    tracked.forEach(function (el) {
      // A detached element that is not playing will never be heard again. A
      // detached element that IS playing is legitimate: `new Audio()` is never
      // in the DOM.
      if (!el.isConnected && el.paused && !graphs.get(el)) dead.push(el);
    });
    for (var i = 0; i < dead.length; i++) tracked.delete(dead[i]);
  }

  function onMediaEvent(event) {
    var el = event.target;
    if (!(el instanceof HTMLMediaElement)) return;
    var isNew = track(el);
    // A play event is a real user gesture in the page, which is the only thing
    // that reliably unlocks a suspended AudioContext.
    if (event.type === 'play' || event.type === 'playing') audioContext();
    if (isNew || desired !== 1 || muted) apply();
  }

  function onMutation() {
    if (mutationTimer) return;
    mutationTimer = setTimeout(function () {
      mutationTimer = 0;
      if (scan(false)) apply();
    }, 150);
  }

  /* ------------------------------------------------------------------ *
   * Status reporting
   * ------------------------------------------------------------------ */

  function status() {
    var media = 0;
    var boosted = 0;
    var silenced = 0;
    var reasons = { protected: 0, tainted: 0 };

    tracked.forEach(function (el) {
      media++;
      var entry = graphs.get(el);
      if (entry) {
        boosted++;
        if (entry.silent) silenced++;
        return;
      }
      var kind = classify(el);
      if (kind === 'protected') reasons.protected++;
      else if (kind === 'tainted') reasons.tainted++;
    });

    return {
      media: media,
      boosted: boosted,
      silenced: silenced,
      protectedCount: reasons.protected,
      taintedCount: reasons.tainted,
      suspended: !!(ctx && ctx.state === 'suspended'),
      origin: location.origin,
      top: window.top === window
    };
  }

  function scheduleStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(function () {
      statusTimer = 0;
      sendStatus();
    }, 120);
  }

  function sendStatus() {
    if (!port) return;
    var s = status();
    var key = s.media + '/' + s.boosted + '/' + s.protectedCount + '/' +
      s.taintedCount + '/' + s.silenced + '/' + (s.suspended ? 1 : 0);
    if (key === lastStatusKey) return;
    lastStatusKey = key;
    try {
      port.postMessage({ t: 'status', status: s });
    } catch (e) {
      port = null;
    }
  }

  /* ------------------------------------------------------------------ *
   * Background link
   * ------------------------------------------------------------------ */

  function closePort() {
    if (!port) return;
    try { port.disconnect(); } catch (e) { /* the other end went first */ }
    port = null;
    lastStatusKey = '';
  }

  // An extension update or removal orphans this script for good: runtime.id
  // is gone and no port can ever come back, so whatever is applied right now
  // is applied until the page reloads. Hand the audio back instead of leaving
  // the page stuck loud, quiet, or silent with the slider unable to reach it.
  function neutralize() {
    desired = 1;
    muted = false;
    clearInterval(sweepTimer);
    apply();
  }

  // The background being unloaded is routine, so every failed link has to lead
  // back to another attempt. A frame that stops trying is a page the slider
  // silently does nothing on.
  function retryPort() {
    if (!api.runtime.id) { neutralize(); return; }
    if (portRetries > 12) return;
    portRetries++;
    setTimeout(openPort, Math.min(500 * portRetries, 5000));
  }

  function openPort() {
    if (!api.runtime.id) { neutralize(); return; }
    // A live port means someone already reconnected. Restoring from the
    // back/forward cache and retrying after the worker was evicted can both
    // land here, and a second port would register this frame twice in the
    // background, which doubles every count the popup shows.
    if (port) return;

    var opened;
    try {
      opened = api.runtime.connect({ name: 'vb' });
    } catch (e) {
      retryPort();
      return;
    }
    port = opened;
    portRetries = 0;

    opened.onMessage.addListener(function (msg) {
      if (!msg) return;
      if (msg.t === 'set') {
        if (typeof msg.gain === 'number') {
          desired = Math.max(0, Math.min(MAX_GAIN, msg.gain));
        }
        if (typeof msg.muted === 'boolean') muted = msg.muted;
        if (typeof msg.limiter === 'boolean') limiterOn = msg.limiter;
        if (desired !== 1 || muted) audioContext();
        scan(false);
        apply();
        lastStatusKey = '';
        sendStatus();
      }
    });

    opened.onDisconnect.addListener(function () {
      // Reading lastError is what marks it handled. The browser sets it when it
      // closes the channel itself, and logs "Unchecked runtime.lastError" if
      // nobody looks. Both causes are routine here: the worker was evicted, or
      // the page was moved into the back/forward cache.
      if (api.runtime.lastError) { /* expected, and nothing to do about it */ }

      // A disconnect that arrives after we already reconnected belongs to a
      // port we have replaced. Acting on it would drop the live one.
      if (port !== opened) return;
      port = null;
      lastStatusKey = '';
      // The service worker being evicted is normal and frequent. Reconnect with
      // backoff, but give up if the extension itself is gone.
      retryPort();
    });

    try {
      opened.postMessage({
        t: 'hello',
        origin: location.origin,
        top: window.top === window,
        // What this frame is currently set to. After the background has been
        // unloaded it has no memory of the tab, and if remembering is off there
        // is nothing on disk either, so this is the only surviving record.
        gain: desired,
        muted: muted,
        status: status()
      });
    } catch (e) {
      port = null;
      retryPort();
    }
  }

  /* ------------------------------------------------------------------ *
   * Boot
   * ------------------------------------------------------------------ */

  ['play', 'playing', 'loadedmetadata', 'canplay', 'durationchange'].forEach(function (type) {
    document.addEventListener(type, onMediaEvent, true);
  });

  function startObserver() {
    if (!document.documentElement) return;
    try {
      new MutationObserver(onMutation).observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } catch (e) { /* observer unavailable, the sweep still covers us */ }
  }

  if (document.documentElement) {
    startObserver();
  } else {
    document.addEventListener('readystatechange', startObserver, { once: true });
  }

  var sweepTimer = setInterval(function () {
    sweepCount++;
    var deep = sweepCount % DEEP_SCAN_EVERY === 0;
    var added = scan(deep);
    prune();
    checkSilence();
    if (added) apply();
    else scheduleStatus();
  }, SWEEP_MS);

  /*
   * A page can leave two ways: for good, or into the back/forward cache, from
   * which it returns with this script's state intact but its port dead. The
   * browser closes the port on the way in and reports that to the background as
   * an error, so hand it back ourselves and make the teardown an ordinary one.
   */
  window.addEventListener('pagehide', function (event) {
    closePort();

    // createMediaElementSource() cannot be undone, so closing the context is
    // permanent silence for every element already routed through it. On a real
    // teardown that costs nothing, the page is going away. On the way into the
    // cache the same page comes back, and it comes back mute.
    if (event.persisted) return;
    if (ctx && ctx.close) {
      try { ctx.close(); } catch (e) {}
      ctx = null;
    }
  });

  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    portRetries = 0;
    openPort();
    // Frozen contexts come back suspended. audioContext() resumes the one we
    // have and, deliberately, is only called when there is one to resume: a
    // page that was never boosted should not get a context on the way back.
    if (ctx) audioContext();
    lastStatusKey = '';
    scheduleStatus();
  });

  scan(true);

  /*
   * A prerendered document (omnibox preloads, speculation rules) is a second
   * top-level frame in the same tab. If it says hello while it is still
   * invisible, the background reads that as a navigation: it adopts this
   * document's origin and pushes its level over the page the user is actually
   * looking at. So the announcement waits until the browser shows this one.
   */
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', function () {
      openPort();
    }, { once: true });
  } else {
    openPort();
  }
})();
