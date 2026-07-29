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

function loadOpts() {
  return Promise.resolve(api.storage.local.get('opts')).then(function (res) {
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
}

function saveOpts(patch) {
  opts = Object.assign({}, opts, patch);
  return Promise.resolve(api.storage.local.set({ opts: opts })).catch(function () {});
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
  if (!key || !opts.remember) return Promise.resolve();
  return Promise.resolve(api.storage.local.get('sites')).then(function (res) {
    var sites = (res && res.sites) || {};

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

    return api.storage.local.set({ sites: sites });
  }).catch(function () {});
}

/* -------------------------------------------------------------------- *
 * Tab state
 * -------------------------------------------------------------------- */

function stateFor(tabId) {
  var st = tabs.get(tabId);
  if (!st) {
    st = { gain: 1, muted: false, origin: null, frames: new Map() };
    tabs.set(tabId, st);
  }
  return st;
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

    if (!msg.top) {
      // A subframe just needs whatever the tab is currently set to.
      pushTo(port, cur);
      return;
    }

    if (cur.origin === msg.origin) {
      // Same site, probably an in-page navigation or a re-injection.
      pushTo(port, cur);
      updateBadge(tabId, cur);
      return;
    }

    // The top frame moved to a different site. Adopt that site's saved level.
    cur.origin = msg.origin;
    loadSite(msg.origin).then(function (saved) {
      var latest = tabs.get(tabId);
      if (!latest || latest.origin !== msg.origin) return;
      latest.gain = saved && opts.remember ? saved.gain : 1;
      latest.muted = saved && opts.remember ? saved.muted : false;
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
  broadcast(st);
  updateBadge(tabId, st);
  if (st.origin) saveSite(st.origin, st.gain, st.muted);
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
    Promise.resolve(api.storage.local.get('sites')).then(function (res) {
      var sites = (res && res.sites) || {};
      delete sites[key];
      return api.storage.local.set({ sites: sites });
    }).catch(function () {}).then(function () {
      sendResponse(snapshot(msg.tabId));
    });
    return true;
  }

  if (msg.t === 'resetAll') {
    Promise.resolve(api.storage.local.set({ sites: {} })).catch(function () {})
      .then(function () {
        tabs.forEach(function (st, tabId) {
          st.gain = 1;
          st.muted = false;
          broadcast(st);
          updateBadge(tabId, st);
        });
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
