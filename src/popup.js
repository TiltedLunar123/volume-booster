/*
 * Volume Booster popup.
 *
 * Two goals: never show a spinner, and never lie about what happened. The level
 * is painted from storage on the first frame and corrected by the background a
 * moment later, and anything the engine could not boost is stated plainly
 * instead of being silently ignored.
 */
'use strict';

var api = (typeof browser !== 'undefined' && browser.runtime) ? browser : chrome;

/* The slider is piecewise so the everyday range is not squashed into a sixth of
   the track: the first 40% covers 0 to 100%, the rest covers 100 to 600%. */
var PIVOT = 400;
var RAW_MAX = 1000;
var SNAP = 12;
var MAX_GAIN = 6;

var RESTRICTED = /^(chrome|edge|brave|opera|vivaldi|about|moz-extension|chrome-extension|devtools|view-source|resource|chrome-untrusted):/i;
var STORE = /^https?:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org|microsoftedge\.microsoft\.com\/addons)/i;

var app = document.getElementById('app');
var hostEl = document.getElementById('host');
var valueEl = document.getElementById('value');
var readoutEl = document.getElementById('readout');
var gradEl = document.getElementById('grad');
var rangeEl = document.getElementById('range');
var presetsEl = document.getElementById('presets');
var muteEl = document.getElementById('mute');
var muteLabelEl = document.getElementById('muteLabel');
var wavesEl = document.getElementById('waves');
var crossEl = document.getElementById('cross');
var statusEl = document.getElementById('status');
var rememberEl = document.getElementById('remember');
var resetAllEl = document.getElementById('resetAll');
var noticeEl = document.getElementById('notice');

var state = {
  tabId: null,
  gain: 1,
  muted: false,
  origin: null,
  connected: false,
  agg: null
};

var userTouched = false;
var settled = false;
var sendQueued = false;
var pollTimer = 0;

/* -------------------------------------------------------------------- *
 * Slider mapping
 * -------------------------------------------------------------------- */

function rawToGain(raw) {
  if (raw <= PIVOT) return raw / PIVOT;
  return 1 + ((raw - PIVOT) / (RAW_MAX - PIVOT)) * (MAX_GAIN - 1);
}

function gainToRaw(gain) {
  if (gain <= 1) return Math.round(gain * PIVOT);
  return Math.round(PIVOT + ((gain - 1) / (MAX_GAIN - 1)) * (RAW_MAX - PIVOT));
}

function percent(gain) {
  return Math.round(gain * 100);
}

/* -------------------------------------------------------------------- *
 * Render
 * -------------------------------------------------------------------- */

function statusText() {
  if (!state.connected) return 'Not available here';
  var a = state.agg;
  if (!a) return '';
  if (a.media === 0) return 'No audio yet';
  if (a.silenced > 0) return 'No signal, reload page';
  if (a.boosted === 0 && a.protectedCount > 0) return 'Protected audio';
  if (a.boosted === 0 && a.taintedCount > 0) return 'Boost blocked';
  if (a.suspended) return 'Press play to apply';
  if (a.boosted > 0) {
    return a.boosted === 1 ? '1 source boosted' : a.boosted + ' sources boosted';
  }
  return a.media === 1 ? '1 audio source' : a.media + ' audio sources';
}

function showNotice(title, body) {
  noticeEl.textContent = '';
  var heading = document.createElement('strong');
  heading.textContent = title;
  noticeEl.appendChild(heading);
  noticeEl.appendChild(document.createTextNode(body));
  noticeEl.hidden = false;
}

function renderNotice() {
  var a = state.agg;
  if (!state.connected || !a) {
    noticeEl.hidden = true;
    return;
  }

  // Checked before the boosted count, because a silenced element is a connected
  // element: the graph is live and producing nothing.
  if (a.silenced > 0) {
    showNotice('No audio coming through',
      'This page redirects its audio to another domain, which cuts the signal ' +
      'once the booster attaches. Reload the page to get sound back, and leave ' +
      'the level at 100% here.');
    return;
  }

  if (a.boosted > 0) {
    noticeEl.hidden = true;
    return;
  }
  if (a.protectedCount > 0) {
    showNotice('Protected audio',
      'This site uses DRM, so its audio cannot be routed through the booster. ' +
      'Lowering the volume still works.');
    return;
  }
  if (a.taintedCount > 0) {
    showNotice('Boost unavailable',
      'This page loads its audio from another domain without the header that ' +
      'permits boosting. Lowering the volume still works.');
    return;
  }
  noticeEl.hidden = true;
}

function render(skipSlider) {
  var shown = state.muted ? 0 : state.gain;
  var raw = gainToRaw(state.gain);

  if (!skipSlider) rangeEl.value = String(raw);
  rangeEl.setAttribute('aria-valuetext', percent(shown) + '%');

  valueEl.textContent = String(percent(shown));
  gradEl.style.clipPath = 'inset(0 ' + (100 - (raw / RAW_MAX) * 100) + '% 0 0)';

  readoutEl.classList.toggle('is-muted', state.muted);
  readoutEl.classList.toggle('is-hot', !state.muted && state.gain > 3 && state.gain <= 5);
  readoutEl.classList.toggle('is-max', !state.muted && state.gain > 5);

  var buttons = presetsEl.querySelectorAll('button');
  for (var i = 0; i < buttons.length; i++) {
    var g = parseFloat(buttons[i].getAttribute('data-gain'));
    var on = !state.muted && Math.abs(g - state.gain) < 0.005;
    buttons[i].setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  muteEl.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
  muteLabelEl.textContent = state.muted ? 'Unmute' : 'Mute';
  wavesEl.hidden = state.muted;
  crossEl.hidden = !state.muted;

  statusEl.textContent = statusText();
  renderNotice();
}

function paintHost() {
  if (!state.origin) return;
  try {
    hostEl.textContent = new URL(state.origin).host;
  } catch (e) {
    hostEl.textContent = '';
  }
}

/* -------------------------------------------------------------------- *
 * Messaging
 * -------------------------------------------------------------------- */

function send(msg) {
  try {
    return Promise.resolve(api.runtime.sendMessage(msg)).catch(function () { return null; });
  } catch (e) {
    return Promise.resolve(null);
  }
}

function adopt(snapshot) {
  if (!snapshot) return;
  state.connected = !!snapshot.connected;
  state.agg = snapshot.agg || null;
  if (snapshot.origin) {
    state.origin = snapshot.origin;
    paintHost();
  }
  if (snapshot.opts) rememberEl.checked = snapshot.opts.remember !== false;
  if (!userTouched) {
    state.gain = typeof snapshot.gain === 'number' ? snapshot.gain : state.gain;
    state.muted = !!snapshot.muted;
  }
  render();
}

/* Coalesce to roughly one message per frame while dragging. The readout still
   updates on every input event, so the UI never feels throttled. This uses a
   timer rather than requestAnimationFrame on purpose: rAF never fires in a
   document the compositor considers hidden, and a slider that silently stops
   sending is a worse bug than one extra message. */
function queueSend() {
  if (sendQueued) return;
  sendQueued = true;
  setTimeout(function () {
    sendQueued = false;
    send({ t: 'set', tabId: state.tabId, gain: state.gain, muted: state.muted })
      .then(function (snapshot) {
        if (!snapshot) return;
        state.connected = !!snapshot.connected;
        state.agg = snapshot.agg || null;
        statusEl.textContent = statusText();
        renderNotice();
      });
  }, 16);
}

function blocked(message) {
  state.connected = false;
  app.classList.add('is-blocked');
  app.classList.remove('is-booting');
  statusEl.textContent = 'Not available here';
  showNotice('Cannot run on this page', message);
}

/* -------------------------------------------------------------------- *
 * Input
 * -------------------------------------------------------------------- */

rangeEl.addEventListener('input', function () {
  userTouched = true;
  var raw = parseInt(rangeEl.value, 10);
  if (Math.abs(raw - PIVOT) <= SNAP) {
    raw = PIVOT;
    rangeEl.value = String(raw);
  }
  state.gain = rawToGain(raw);
  state.muted = false;
  render(true);
  queueSend();
});

presetsEl.addEventListener('click', function (event) {
  var button = event.target.closest('button[data-gain]');
  if (!button) return;
  userTouched = true;
  state.gain = parseFloat(button.getAttribute('data-gain'));
  state.muted = false;
  render();
  queueSend();
});

muteEl.addEventListener('click', function () {
  userTouched = true;
  state.muted = !state.muted;
  render();
  queueSend();
});

rememberEl.addEventListener('change', function () {
  var on = rememberEl.checked;
  send({ t: 'opts', tabId: state.tabId, patch: { remember: on } });
  if (!on) send({ t: 'forget', tabId: state.tabId });
});

resetAllEl.addEventListener('click', function () {
  userTouched = true;
  state.gain = 1;
  state.muted = false;
  render();
  send({ t: 'resetAll', tabId: state.tabId }).then(adopt);
});

/* -------------------------------------------------------------------- *
 * Boot
 * -------------------------------------------------------------------- */

function poll() {
  pollTimer = setTimeout(function () {
    send({ t: 'get', tabId: state.tabId }).then(function (snapshot) {
      if (snapshot) {
        state.connected = !!snapshot.connected;
        state.agg = snapshot.agg || null;
        if (!userTouched && typeof snapshot.gain === 'number') {
          state.gain = snapshot.gain;
          state.muted = !!snapshot.muted;
        }
        render();
      }
      poll();
    });
  }, 800);
}

function boot() {
  Promise.resolve(api.tabs.query({ active: true, currentWindow: true }))
    .then(function (found) {
      var tab = found && found[0];
      if (!tab || typeof tab.id !== 'number') {
        blocked('No active tab was found.');
        return;
      }
      state.tabId = tab.id;

      var url = tab.url || '';
      if (url && (RESTRICTED.test(url) || STORE.test(url))) {
        blocked('Browsers do not allow extensions to run on internal pages or ' +
          'extension stores.');
        return;
      }

      if (url) {
        try { state.origin = new URL(url).origin; } catch (e) { /* opaque */ }
        paintHost();
      }

      // Optimistic paint: whatever this site was last set to, straight from
      // storage, so the popup never flashes 100% before correcting itself.
      if (state.origin) {
        Promise.resolve(api.storage.local.get('sites')).then(function (res) {
          if (settled || userTouched) return;
          var hit = res && res.sites && res.sites[state.origin];
          if (!hit) return;
          state.gain = hit.g;
          state.muted = !!hit.m;
          render();
        }).catch(function () {});
      }

      return send({ t: 'get', tabId: tab.id }).then(function (snapshot) {
        settled = true;
        adopt(snapshot);
        if (snapshot && snapshot.connected) return null;
        // The page was probably open before the extension was installed.
        return send({ t: 'inject', tabId: tab.id }).then(function (res) {
          if (res && res.ok && res.state) adopt(res.state);
          if (!state.connected) {
            blocked('This page was loaded before the extension could attach, ' +
              'or the browser blocks extensions here. Try reloading the page.');
          }
        });
      });
    })
    .catch(function () {
      blocked('Something went wrong reading the current tab.');
    })
    .then(function () {
      setTimeout(function () { app.classList.remove('is-booting'); }, 0);
      if (!app.classList.contains('is-blocked')) poll();
    });
}

window.addEventListener('unload', function () {
  if (pollTimer) clearTimeout(pollTimer);
});

render();
boot();
