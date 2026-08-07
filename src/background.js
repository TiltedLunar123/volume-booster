/*
 * Volume Booster: background.
 *
 * Runs as a service worker in Chrome and as an event page in Firefox, from the
 * same file, so it is a classic script with no imports.
 *
 * It owns three things: the port registry, the toolbar badge, and storage.
 * It deliberately owns no audio state that it cannot rebuild, because Chrome
 * evicts the service worker constantly. When it comes back, every content
 * script reconnects and re-announces itself, and the map refills itself.
 */
'use strict';

var api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

var MAX_GAIN = 6;
var STEP = 0.25;
var MAX_SITES = 300;

var DEFAULT_OPTS = { remember: true, limiter: true };
var opts = { remember: true, limiter: true };

// tabId -> { gain, muted, origin, frames: Map<number, {port, status}> }
var tabs = new Map();
var frameSeq = 0;

/* -------------------------------------------------------------------- *
 * Storage
 * -------------------------------------------------------------------- */

// Read once per worker, then kept in memory. Until that read lands `opts` holds
// the defaults, which say remembering is on: the opposite of what a user who
// turned it off asked for. Everything that acts on the setting waits for this.
var optsLoaded = null;

function loadOpts() {
  if (optsLoaded) return optsLoaded;
  optsLoaded = Promise.resolve(api.storage.local.get('opts')).then(function (res) {
    var stored = (res && res.opts) || {};
    opts = {
      remember: stored.remember !== false,
      limiter: stored.limiter !== false
    };
    return opts;
  }).catch(function () {
    opts = Object.assign({}, DEFAULT_OPTS);
    return opts;
  });
  return optsLoaded;
}

function saveOpts(patch) {
  opts = Object.assign({}, opts, patch);
  return Promise.resolve(api.storage.local.set({ opts: opts })).catch(function () {});
}

/*
 * Every writer of the site list reads the whole thing, changes one entry, and
 * writes it all back. Two of those overlapping means the slower one puts back a
 * picture of the list that was already out of date, and whatever landed in
 * between is gone: a level saved over a Reset all, or another site's entry
 * dropped. One queue keeps them in the order they were asked for.
 *
 * `change` mutates the list it is handed and returns false to write nothing.
 */
var siteWrites = Promise.resolve();

function editSites(change) {
  siteWrites = siteWrites
    .then(loadOpts)
    .then(function () {
      return Promise.resolve(api.storage.local.get('sites'));
    })
    .then(function (res) {
      var sites = (res && res.sites) || {};
      if (change(sites) === false) return;
      return api.storage.local.set({ sites: sites });
    })
    .catch(function () {});
  return siteWrites;
}

function siteKey(origin) {
  if (!origin || origin === 'null') return null;
  if (origin.indexOf('http://') !== 0 && origin.indexOf('https://') !== 0) return null;
  return origin;
}

function loadSite(origin) {
  var key = siteKey(origin);
  if (!key) return Promise.resolve(null);
  return Promise.resolve(api.storage.local.get('sites')).then(function (res) {
    var sites = (res && res.sites) || {};
    var hit = sites[key];
    if (!hit) return null;
    return { gain: hit.g, muted: !!hit.m };
  }).catch(function () {
    return null;
  });
}

function saveSite(origin, gain, muted) {
  var key = siteKey(origin);
  if (!key) return Promise.resolve();
  return editSites(function (sites) {
    // Read in here rather than at the call site, so it is the setting that
    // came off the disk and not the default that stands in until it arrives.
    if (!opts.remember) return false;

    if (gain === 1 && !muted) {
      delete sites[key];
    } else {
      sites[key] = { g: gain, m: muted, t: Date.now() };
    }

    var keys = Object.keys(sites);
    if (keys.length > MAX_SITES) {
      keys.sort(function (a, b) { return (sites[a].t || 0) - (sites[b].t || 0); });
      var drop = keys.length - MAX_SITES;
      for (var i = 0; i < drop; i++) delete sites[keys[i]];
    }
  });
}

/* -------------------------------------------------------------------- *
 * Tab state
 * -------------------------------------------------------------------- */

function stateFor(tabId) {
  var st = tabs.get(tabId);
  if (!st) {
    // epoch counts deliberate changes, so an async read that started earlier
    // can tell whether it is about to overwrite a newer choice. dirty marks a
    // change that could not be saved yet because no connected top frame could
    // vouch for the origin.
    st = { gain: 1, muted: false, origin: null, epoch: 0, dirty: false, adopting: false, frames: new Map() };
    tabs.set(tabId, st);
  }
  return st;
}

function topConnected(st) {
  var found = false;
  st.frames.forEach(function (frame) { if (frame.top) found = true; });
  return found;
}

function pushTo(port, st) {
  try {
    port.postMessage({
      t: 'set',
      gain: st.gain,
      muted: st.muted,
      limiter: opts.limiter
    });
  } catch (e) { /* the frame is gone, onDisconnect will clean up */ }
}

function broadcast(st) {
  st.frames.forEach(function (frame) { pushTo(frame.port, st); });
}

function aggregate(st) {
  var out = {
    frames: st.frames.size,
    media: 0,
    boosted: 0,
    silenced: 0,
    protectedCount: 0,
    taintedCount: 0,
    busyCount: 0,
    suspended: false
  };
  st.frames.forEach(function (frame) {
    var s = frame.status;
    if (!s) return;
    out.media += s.media || 0;
    out.boosted += s.boosted || 0;
    out.silenced += s.silenced || 0;
    out.protectedCount += s.protectedCount || 0;
    out.taintedCount += s.taintedCount || 0;
    out.busyCount += s.busyCount || 0;
    if (s.suspended) out.suspended = true;
  });
  return out;
}

/* -------------------------------------------------------------------- *
 * Badge
 * -------------------------------------------------------------------- */

// Same level-meter ramp as the slider: green is normal, red is pushing it.
function badgeColor(gain, muted) {
  if (muted) return '#6b7280';
  if (gain < 1) return '#6b7280';
  if (gain <= 2) return '#16a34a';
  if (gain <= 3.5) return '#ca8a04';
  if (gain <= 5) return '#ea580c';
  return '#dc2626';
}

function updateBadge(tabId, st) {
  if (!api.action || !api.action.setBadgeText) return;
  var text = '';
  if (st.muted) text = 'MUTE';
  else if (st.gain !== 1) text = Math.round(st.gain * 100) + '%';

  try {
    api.action.setBadgeText({ tabId: tabId, text: text });
    if (text) {
      api.action.setBadgeBackgroundColor({
        tabId: tabId,
        color: badgeColor(st.gain, st.muted)
      });
      if (api.action.setBadgeTextColor) {
        api.action.setBadgeTextColor({ tabId: tabId, color: '#ffffff' });
      }
    }
  } catch (e) { /* the tab closed mid-update */ }
}

/* -------------------------------------------------------------------- *
 * Ports from content scripts
 * -------------------------------------------------------------------- */

api.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'vb') return;
  var sender = port.sender;
  if (!sender || !sender.tab || typeof sender.tab.id !== 'number') return;

  var tabId = sender.tab.id;
  var id = ++frameSeq;
  var st = stateFor(tabId);
  st.frames.set(id, { port: port, status: null });

  port.onDisconnect.addListener(function () {
    // The frame closing its own port is the common case, but the browser also
    // closes ports itself when a page enters the back/forward cache, and it
    // reports that as an error on this end. Reading lastError is what stops it
    // being logged as unchecked.
    if (api.runtime.lastError) { /* expected, the frame is gone either way */ }

    var cur = tabs.get(tabId);
    if (!cur) return;
    cur.frames.delete(id);
  });

  port.onMessage.addListener(function (msg) {
    if (!msg) return;
    var cur = tabs.get(tabId);
    if (!cur) return;
    var frame = cur.frames.get(id);
    if (!frame) return;

    if (msg.t === 'status') {
      frame.status = msg.status;
      return;
    }

    if (msg.t !== 'hello') return;
    frame.status = msg.status || null;
    // The frame reports what it can see from inside itself, but the browser is
    // the one that knows where the frame sits in the tab. A document can be
    // top level within its own tree and still be nested in the page, and
    // taking its word for it moves the whole tab onto that document's origin.
    frame.top = !!msg.top &&
      (typeof sender.frameId !== 'number' || sender.frameId === 0);

    if (!frame.top) {
      // A subframe just needs whatever the tab is currently set to. Unless
      // nothing is known yet: before the top frame's hello, and while its
      // saved level is still being read back, the state holds a default that
      // would audibly dip a boosted player. The restore broadcast is coming,
      // so silence beats a wrong answer.
      if (cur.origin !== null && !cur.adopting) pushTo(port, cur);
      return;
    }

    if (cur.origin === msg.origin) {
      // Same site, probably an in-page navigation or a re-injection. A top
      // frame vouching for the origin again also means a change parked while
      // nothing was connected can finally be written down.
      if (cur.dirty) {
        cur.dirty = false;
        saveSite(cur.origin, cur.gain, cur.muted);
      }
      pushTo(port, cur);
      updateBadge(tabId, cur);
      return;
    }

    // The top frame moved to a different site. Adopt that site's saved level.
    var fresh = cur.origin === null;
    cur.origin = msg.origin;
    cur.adopting = true;
    var epoch = cur.epoch;
    // The stored options decide whether the saved level is used at all, so the
    // restore waits for them rather than reading the default that stands in
    // until they arrive.
    Promise.all([loadSite(msg.origin), loadOpts()]).then(function (results) {
      var saved = results[0];
      var latest = tabs.get(tabId);
      if (!latest || latest.origin !== msg.origin) return;
      latest.adopting = false;

      // Reading storage takes long enough for the user to have moved the
      // slider in the meantime, and what they just chose beats what was on
      // disk when the page loaded.
      if (latest.epoch !== epoch) return;

      if (fresh && latest.dirty) {
        // The user set a level in the gap between the background starting
        // and this first hello, when no origin was known yet. The only tab
        // that gap belongs to is this one, so their choice outranks what was
        // on disk when the page loaded, and it can be saved now.
        latest.dirty = false;
        saveSite(msg.origin, latest.gain, latest.muted);
      } else if (saved && opts.remember) {
        latest.gain = saved.gain;
        latest.muted = saved.muted;
        latest.dirty = false;
      } else {
        // Nothing saved for this site, either because it is new or because
        // remembering is off. A frame that is already running knows what the
        // tab was set to, and after the background has been unloaded that is
        // the only record of it left. A freshly loaded page reports 100%, so
        // this resets on a real navigation the way it should.
        latest.gain = typeof msg.gain === 'number' ? msg.gain : 1;
        latest.muted = !!msg.muted;
        latest.dirty = false;
      }

      broadcast(latest);
      updateBadge(tabId, latest);
    });
  });
});

if (api.tabs && api.tabs.onRemoved) {
  api.tabs.onRemoved.addListener(function (tabId) { tabs.delete(tabId); });
}

/* -------------------------------------------------------------------- *
 * Popup messages
 * -------------------------------------------------------------------- */

function applyLevel(tabId, gain, muted) {
  var st = stateFor(tabId);
  if (typeof gain === 'number') st.gain = Math.max(0, Math.min(MAX_GAIN, gain));
  if (typeof muted === 'boolean') st.muted = muted;
  st.epoch++;
  broadcast(st);
  updateBadge(tabId, st);
  if (st.origin && topConnected(st)) {
    st.dirty = false;
    saveSite(st.origin, st.gain, st.muted);
  } else {
    // st.origin is a record of the last page that said hello, not of what
    // the tab shows now. Without a connected top frame the two can disagree,
    // most plainly on chrome:// pages where no content script ever runs, and
    // writing through a stale origin edits some other site's level. Park the
    // change until a hello proves where we are.
    st.dirty = true;
  }
  return st;
}

function snapshot(tabId) {
  var st = stateFor(tabId);
  return {
    gain: st.gain,
    muted: st.muted,
    origin: st.origin,
    connected: st.frames.size > 0,
    agg: aggregate(st),
    opts: opts
  };
}

api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'get') {
    loadOpts().then(function () { sendResponse(snapshot(msg.tabId)); });
    return true;
  }

  if (msg.t === 'set') {
    applyLevel(msg.tabId, msg.gain, msg.muted);
    sendResponse(snapshot(msg.tabId));
    return true;
  }

  if (msg.t === 'opts') {
    saveOpts(msg.patch || {}).then(function () {
      var st = tabs.get(msg.tabId);
      if (st) broadcast(st);
      sendResponse(snapshot(msg.tabId));
    });
    return true;
  }

  if (msg.t === 'forget') {
    // "Remember" was switched off for this site: drop the stored entry.
    var st = tabs.get(msg.tabId);
    var origin = st && st.origin;
    var key = siteKey(origin);
    if (!key) { sendResponse(snapshot(msg.tabId)); return true; }
    editSites(function (sites) { delete sites[key]; }).then(function () {
      sendResponse(snapshot(msg.tabId));
    });
    return true;
  }

  if (msg.t === 'resetAll') {
    // Every open tab goes back to 100% now, not when the disk catches up, and
    // it counts as a deliberate change like any other: a restore that started
    // reading before the reset must not land on top of it afterwards.
    tabs.forEach(function (st, tabId) {
      st.gain = 1;
      st.muted = false;
      st.dirty = false;
      st.epoch++;
      broadcast(st);
      updateBadge(tabId, st);
    });
    editSites(function (sites) {
      Object.keys(sites).forEach(function (site) { delete sites[site]; });
    }).then(function () {
      sendResponse(snapshot(msg.tabId));
    });
    return true;
  }

  if (msg.t === 'inject') {
    if (!api.scripting || !api.scripting.executeScript) {
      sendResponse({ ok: false });
      return true;
    }
    Promise.resolve(api.scripting.executeScript({
      target: { tabId: msg.tabId, allFrames: true },
      files: ['content.js']
    })).then(function () {
      // Give the freshly injected frames a moment to open their ports.
      setTimeout(function () { sendResponse({ ok: true, state: snapshot(msg.tabId) }); }, 250);
    }).catch(function () {
      sendResponse({ ok: false });
    });
    return true;
  }
});

/* -------------------------------------------------------------------- *
 * Keyboard shortcuts
 * -------------------------------------------------------------------- */

if (api.commands && api.commands.onCommand) {
  api.commands.onCommand.addListener(function (command) {
    Promise.resolve(api.tabs.query({ active: true, currentWindow: true }))
      .then(function (found) {
        var tab = found && found[0];
        if (!tab || typeof tab.id !== 'number') return;
        var st = stateFor(tab.id);

        if (command === 'boost-up') applyLevel(tab.id, st.gain + STEP, false);
        else if (command === 'boost-down') applyLevel(tab.id, st.gain - STEP, false);
        else if (command === 'boost-reset') applyLevel(tab.id, 1, false);
        else if (command === 'boost-mute') applyLevel(tab.id, st.gain, !st.muted);
      })
      .catch(function () {});
  });
}

loadOpts();
