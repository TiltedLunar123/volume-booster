/*
 * Tests for the parts that are easy to get quietly wrong.
 *
 * These pull the real functions out of the shipped source rather than copying
 * them, so a test cannot keep passing against code that no longer exists.
 *
 * Run: node test/unit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src');

let passed = 0;
let failed = 0;
let group = '';

function describe(name) {
  group = name;
  console.log(`\n${name}`);
}

function is(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}\n          expected ${b}\n          actual   ${a}`);
  }
}

function ok(condition, label) {
  is(!!condition, true, label);
}

/** Lets queued promise chains resolve before asserting on their effects. */
const settle = () => new Promise((r) => setTimeout(r, 5));

/** Pulls `function name(...) { ... }` out of a source file by brace matching. */
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

const contentSource = fs.readFileSync(path.join(SRC, 'content.js'), 'utf8');
const popupSource = fs.readFileSync(path.join(SRC, 'popup.js'), 'utf8');
const backgroundSource = fs.readFileSync(path.join(SRC, 'background.js'), 'utf8');

/* ==================================================================== *
 * classify(): the guard that decides whether an element may be routed.
 * Getting this wrong does not throw, it permanently silences the page.
 * ==================================================================== */

describe('content.js classify()');

const safeScheme = contentSource.match(/var SAFE_SCHEME = (\/.*\/i);/)[1];
const classify = new Function(
  'location',
  `var SAFE_SCHEME = ${safeScheme}; ${extract(contentSource, 'classify')} return classify;`
)({ origin: 'https://example.com', href: 'https://example.com/watch' });

const cases = [
  ['same-origin file', { currentSrc: 'https://example.com/a.mp3' }, 'ok'],
  ['root-relative path', { currentSrc: '/audio/a.mp3' }, 'ok'],
  ['blob from MSE (YouTube, Twitch)', { currentSrc: 'blob:https://example.com/uuid' }, 'ok'],
  ['data uri', { currentSrc: 'data:audio/wav;base64,AAAA' }, 'ok'],
  ['MediaStream source', { srcObject: {} }, 'ok'],
  ['cross-origin CDN, no CORS', { currentSrc: 'https://cdn.other.com/a.mp3' }, 'tainted'],
  ['protocol-relative cross-origin', { currentSrc: '//cdn.other.com/a.mp3' }, 'tainted'],
  ['different port is a different origin', { currentSrc: 'https://example.com:8443/a.mp3' }, 'tainted'],
  ['http vs https is a different origin', { currentSrc: 'http://example.com/a.mp3' }, 'tainted'],
  ['cross-origin with crossorigin=anonymous', { currentSrc: 'https://cdn.other.com/a.mp3', crossOrigin: 'anonymous' }, 'ok'],
  ['cross-origin with use-credentials', { currentSrc: 'https://cdn.other.com/a.mp3', crossOrigin: 'use-credentials' }, 'ok'],
  ['encrypted media', { currentSrc: 'blob:https://example.com/uuid', mediaKeys: {} }, 'protected'],
  ['no source yet', { currentSrc: '' }, 'pending'],
  // Anything that resolves against the page URL is same-origin, so it is safe.
  ['odd but resolvable relative path', { currentSrc: '::::' }, 'ok'],
  // An unparseable absolute URL falls through to pending rather than being
  // guessed at, because guessing wrong here silences the page.
  ['unparseable absolute url', { currentSrc: 'https://[' }, 'pending']
];

for (const [label, element, expected] of cases) {
  is(classify(element), expected, `${label} -> ${expected}`);
}

ok(classify({ currentSrc: 'https://cdn.other.com/a.mp3' }) !== 'ok',
  'a tainted element is never reported as routable');
ok(classify({ currentSrc: 'blob:https://example.com/x', mediaKeys: {} }) === 'protected',
  'DRM outranks an otherwise routable source');

/* ==================================================================== *
 * The back/forward cache lifecycle.
 *
 * A cached page comes back with this script's state intact and its port
 * dead, so the two failure modes are a frame that never reconnects and a
 * frame that reconnects twice. The third is worse and silent: the audio
 * graph is the only route a routed element has left, and closing the
 * context on the way into the cache takes it away permanently.
 *
 * This boots the real content script in a fake frame rather than testing a
 * copy of its logic, and drives it with the events the browser sends.
 * ==================================================================== */

describe('content.js back/forward cache');

function loadContent(options = {}) {
  const windowEvents = {};
  const docEvents = {};
  const ports = [];
  const contexts = [];
  const timers = [];
  const intervals = [];
  const observers = [];
  const signal = { level: 0 };
  let lastErrorReads = 0;
  let connectCalls = 0;
  let sourceCalls = 0;
  let runtimeId = 'test';

  function node() {
    return { connect() {}, disconnect() {} };
  }

  function FakeAudioContext() {
    this.state = 'running';
    this.currentTime = 0;
    this.destination = node();
    this.closed = false;
    this.resumes = 0;
    this.gains = [];
    contexts.push(this);
  }
  FakeAudioContext.prototype.resume = function () {
    this.resumes++;
    this.state = 'running';
    return Promise.resolve();
  };
  FakeAudioContext.prototype.close = function () {
    this.closed = true;
    this.state = 'closed';
    return Promise.resolve();
  };
  FakeAudioContext.prototype.createMediaElementSource = function () {
    // Another AudioContext already owning the element is a real failure mode,
    // and the only signal is this exact throw.
    if (options.failSourceOnce && ++sourceCalls === 1) {
      throw new Error('InvalidStateError: already connected');
    }
    return node();
  };
  FakeAudioContext.prototype.createAnalyser = function () {
    return Object.assign(node(), {
      fftSize: 256,
      // The silence detector reads peaks from here. `signal.level` is what the
      // fake element is "playing", so a test can cut and restore the audio.
      getFloatTimeDomainData(buffer) { buffer[0] = signal.level; }
    });
  };
  FakeAudioContext.prototype.createGain = function () {
    const g = Object.assign(node(), {
      gain: {
        value: 1,
        targets: [],
        setTargetAtTime(v) { this.value = v; this.targets.push(v); }
      }
    });
    this.gains.push(g);
    return g;
  };
  FakeAudioContext.prototype.createDynamicsCompressor = function () {
    return Object.assign(node(), {
      threshold: {}, knee: {}, ratio: {}, attack: {}, release: {}
    });
  };

  function HTMLMediaElement() {}
  function makeMedia(props) {
    return Object.assign(new HTMLMediaElement(), {
      currentSrc: 'https://example.com/a.mp3',
      volume: 1,
      muted: false,
      paused: false,
      readyState: 4,
      isConnected: true,
      addEventListener() {}
    }, props);
  }
  const media = makeMedia();
  const mediaList = [media];

  const chrome = {
    runtime: {
      get id() { return runtimeId; },
      // The property the browser sets when it closes a port itself. Reading it
      // is the whole contract, so the test counts reads.
      get lastError() { lastErrorReads++; return undefined; },
      connect() {
        // The background can refuse a connection while it is starting.
        if (options.refuseFirstConnect && ++connectCalls === 1) {
          throw new Error('receiving end does not exist');
        }
        const port = {
          disconnected: false,
          sent: [],
          postMessage(msg) { port.sent.push(msg); },
          disconnect() { port.disconnected = true; },
          onMessage: { addListener: (fn) => { port.receive = fn; } },
          onDisconnect: { addListener: (fn) => { port.drop = fn; } }
        };
        ports.push(port);
        return port;
      }
    }
  };

  const win = {
    AudioContext: FakeAudioContext,
    addEventListener(type, fn) {
      (windowEvents[type] = windowEvents[type] || []).push(fn);
    }
  };
  win.top = win;

  const doc = {
    documentElement: {},
    addEventListener(type, fn) {
      (docEvents[type] = docEvents[type] || []).push(fn);
    },
    querySelectorAll: (sel) => (sel === 'audio,video' ? mediaList.slice() : [])
  };
  if (options.prerendering) doc.prerendering = true;

  function FakeMutationObserver(cb) {
    observers.push(cb);
    this.observe = function () {};
    this.disconnect = function () {};
  }

  new Function(
    'window', 'document', 'location', 'chrome',
    'HTMLMediaElement', 'MutationObserver', 'setInterval', 'setTimeout',
    contentSource
  )(
    win, doc,
    { origin: 'https://example.com', href: 'https://example.com/watch' },
    chrome, HTMLMediaElement, FakeMutationObserver,
    (fn) => { intervals.push(fn); return 99; },
    (fn) => timers.push(fn)
  );

  return {
    ports,
    contexts,
    media,
    signal,
    makeMedia,
    addMedia: (props) => { const el = makeMedia(props); mediaList.push(el); return el; },
    lastErrorReads: () => lastErrorReads,
    setRuntimeId: (v) => { runtimeId = v; },
    fire: (type, event) => (windowEvents[type] || []).forEach((fn) => fn(event)),
    docFire: (type, event) => (docEvents[type] || []).forEach((fn) => fn(event)),
    /** One tick of the 2.5s discovery/health sweep. */
    sweep: () => intervals.forEach((fn) => fn()),
    /** Fires the MutationObserver callbacks, as if the DOM changed. */
    mutate: () => observers.forEach((cb) => cb()),
    /** Runs whatever the script has queued, so retries are deterministic. */
    flush: () => timers.splice(0).forEach((fn) => fn())
  };
}

{
  const vb = loadContent();
  is(vb.ports.length, 1, 'the frame opens one port on boot');
  is(vb.ports[0].sent[0].t, 'hello', 'and announces itself to the background');

  // Boost something, so there is a live graph and a context worth keeping.
  vb.ports[0].receive({ t: 'set', gain: 2, muted: false, limiter: true });
  is(vb.contexts.length, 1, 'boosting builds the audio graph');

  vb.fire('pagehide', { persisted: true });
  ok(vb.ports[0].disconnected,
    'entering the cache closes the port from this side, so the browser does not');
  is(vb.contexts[0].closed, false,
    'the context survives the cache, because a routed element cannot be routed again');

  // The browser suspends a context while the page is frozen and leaves it that
  // way on the way back, so the graph is wired up but passing nothing.
  vb.contexts[0].state = 'suspended';

  vb.fire('pageshow', { persisted: true });
  is(vb.ports.length, 2, 'coming back opens a fresh port');
  is(vb.ports[1].sent[0].t, 'hello', 'and re-announces the frame');
  is(vb.contexts.length, 1, 'without building a second context');
  ok(vb.contexts[0].resumes > 0, 'the frozen context is resumed');

  // The frozen frame's own disconnect can be delivered after the restore has
  // already reconnected. It must not take the new port down with it.
  vb.ports[0].drop();
  ok(vb.lastErrorReads() > 0,
    'a disconnect reads lastError, which is what stops the unchecked-error log');
  vb.flush();
  is(vb.ports.length, 2, 'a stale disconnect neither drops nor duplicates the live port');
  is(vb.ports[1].disconnected, false, 'the live port is still open');
}

{
  const vb = loadContent();
  vb.ports[0].receive({ t: 'set', gain: 2, muted: false, limiter: true });
  vb.fire('pagehide', { persisted: false });
  ok(vb.contexts[0].closed, 'a page that is really leaving still closes its context');
}

{
  const vb = loadContent();
  vb.ports[0].drop();
  is(vb.ports.length, 1, 'an evicted worker is retried on a timer, not instantly');
  vb.flush();
  is(vb.ports.length, 2, 'and the frame reconnects');

  vb.fire('pageshow', { persisted: true });
  is(vb.ports.length, 2, 'a restore with a live port does not register the frame twice');
}

{
  // A frame that gives up here is a page where the slider silently does
  // nothing, with no event left that would make it try again.
  const vb = loadContent({ refuseFirstConnect: true });
  is(vb.ports.length, 0, 'a refused connection opens no port');
  vb.flush();
  is(vb.ports.length, 1, 'and is retried rather than abandoning the frame');
  is(vb.ports[0]?.sent[0]?.t, 'hello', 'the retry announces itself normally');
}

/* ==================================================================== *
 * Orphaning. An extension update or removal invalidates every running
 * content script: runtime.id disappears and no port can ever come back.
 * Whatever such a script leaves applied is applied until the page reloads,
 * with nothing left that can change it.
 * ==================================================================== */

describe('content.js orphaned context');

{
  const vb = loadContent();
  vb.ports[0].receive({ t: 'set', gain: 3, muted: false, limiter: true });
  const gain = vb.contexts[0].gains[0].gain;
  is(gain.value, 3, 'the tab is boosted');

  vb.setRuntimeId(undefined);
  vb.ports[0].drop();
  vb.flush();

  is(gain.value, 1, 'an orphaned script hands the audio back at 100%');
  is(vb.ports.length, 1, 'and stops trying to reconnect');
}

{
  // The same teardown must unmute: a page stuck silent is as bad as one
  // stuck loud.
  const vb = loadContent();
  vb.ports[0].receive({ t: 'set', gain: 2, muted: true, limiter: true });
  const gain = vb.contexts[0].gains[0].gain;
  is(gain.value, 0, 'the tab is muted');

  vb.setRuntimeId(undefined);
  vb.ports[0].drop();
  vb.flush();

  is(gain.value, 1, 'an orphaned script unmutes on its way out');
}

/* ==================================================================== *
 * Prerendering. Chrome renders omnibox predictions and speculation-rules
 * targets as invisible top-level documents inside the live tab. One of
 * those saying hello reads to the background exactly like a navigation,
 * which resets the page the user is actually looking at.
 * ==================================================================== */

describe('content.js prerendering');

{
  const vb = loadContent({ prerendering: true });
  is(vb.ports.length, 0, 'an invisible prerendered document does not announce itself');

  vb.docFire('prerenderingchange');
  is(vb.ports.length, 1, 'being shown is what opens the port');
  is(vb.ports[0].sent[0].t, 'hello', 'and the now-visible page announces normally');
}

/* ==================================================================== *
 * The applied level.
 *
 * Everything above proves messages arrive. None of it proved the audio
 * graph actually moves: a build that parsed the message and then dropped it
 * on the floor passed every test. These read the gain node itself.
 * ==================================================================== */

describe('content.js applied gain');

{
  const vb = loadContent();
  vb.ports[0].receive({ t: 'set', gain: 2, muted: false, limiter: true });
  const gain = vb.contexts[0].gains[0].gain;
  is(gain.value, 2, 'the requested level lands on the gain node');

  vb.ports[0].receive({ t: 'set', gain: 2, muted: true, limiter: true });
  is(gain.value, 0, 'muting drives the gain to zero, whatever the level says');

  vb.ports[0].receive({ t: 'set', gain: 2, muted: false, limiter: true });
  is(gain.value, 2, 'unmuting restores the level, not 100%');

  vb.ports[0].receive({ t: 'set', gain: 9, muted: false, limiter: true });
  is(gain.value, 6, 'a level beyond the ceiling is clamped, not applied');

  vb.ports[0].receive({ t: 'set', gain: 0.5, muted: false, limiter: true });
  is(gain.value, 0.5, 'reduction below 100% reaches the node too');
}

/* ==================================================================== *
 * Discovery.
 *
 * Three separate paths find media the initial scan missed: the capture
 * listeners on the document, the MutationObserver, and the periodic sweep.
 * A page whose player appears late depends on whichever fires first.
 * ==================================================================== */

describe('content.js discovery');

{
  const vb = loadContent();
  vb.ports[0].receive({ t: 'set', gain: 2, muted: false, limiter: true });
  is(vb.contexts[0].gains.length, 1, 'boot found the element that was already there');

  // A media element created after load announces itself by playing.
  const late = vb.makeMedia();
  vb.docFire('play', { type: 'play', target: late });
  is(vb.contexts[0].gains.length, 2, 'an element discovered by its play event is routed');
  is(vb.contexts[0].gains[1].gain.value, 2, 'and it gets the level already chosen for the tab');

  // One inserted silently, found by the MutationObserver.
  vb.addMedia();
  vb.mutate();
  vb.flush();
  is(vb.contexts[0].gains.length, 3, 'an element found via the observer is routed');

  // And one the observer missed, caught by the periodic sweep.
  vb.addMedia();
  vb.sweep();
  is(vb.contexts[0].gains.length, 4, 'an element found by the sweep is routed');
}

/* ==================================================================== *
 * The silence detector.
 *
 * A same-origin URL that redirects cross-origin wires in cleanly and then
 * emits zeroes forever. The only mitigation is noticing and telling the
 * user to reload, which is worthless if the noticing never runs.
 * ==================================================================== */

describe('content.js silence detector');

{
  const vb = loadContent();
  vb.ports[0].receive({ t: 'set', gain: 2, muted: false, limiter: true });
  vb.flush();

  vb.signal.level = 0.5;
  vb.sweep();
  vb.flush();
  let sent = vb.ports[0].sent.filter((m) => m.t === 'status');
  is(sent[sent.length - 1].status.silenced, 0, 'audible playback is not flagged');

  vb.signal.level = 0;
  vb.sweep();
  vb.sweep();
  vb.flush();
  sent = vb.ports[0].sent.filter((m) => m.t === 'status');
  is(sent[sent.length - 1].status.silenced, 0, 'two silent checks are not yet a verdict');

  vb.sweep();
  vb.flush();
  sent = vb.ports[0].sent.filter((m) => m.t === 'status');
  is(sent[sent.length - 1].status.silenced, 1, 'three consecutive silent checks flag the element');

  vb.signal.level = 0.5;
  vb.sweep();
  vb.flush();
  sent = vb.ports[0].sent.filter((m) => m.t === 'status');
  is(sent[sent.length - 1].status.silenced, 0, 'sound coming back clears the flag');
}

/* ==================================================================== *
 * Slider mapping
 * ==================================================================== */

describe('popup.js slider mapping');

/** Reads `var NAME = <number>` out of a shipped source file. */
function constant(source, name) {
  const hit = source.match(new RegExp(`var ${name} = ([0-9.]+)`));
  if (!hit) throw new Error(`constant ${name} not found`);
  return parseFloat(hit[1]);
}

// The mapping is tested with the constants the product actually ships, not a
// copy of them: a copy would keep passing after the real ones drifted.
const PIVOT = constant(popupSource, 'PIVOT');
const RAW_MAX = constant(popupSource, 'RAW_MAX');
const MAX_GAIN = constant(popupSource, 'MAX_GAIN');

is(constant(contentSource, 'MAX_GAIN'), MAX_GAIN,
  'content.js clamps to the same ceiling the slider offers');
is(constant(backgroundSource, 'MAX_GAIN'), MAX_GAIN,
  'background.js clamps to the same ceiling the slider offers');

const popupHtml = fs.readFileSync(path.join(SRC, 'popup.html'), 'utf8');
const rangeTag = popupHtml.match(/<input id="range"[^>]*>/s)[0];
is(parseInt(rangeTag.match(/max="(\d+)"/)[1], 10), RAW_MAX,
  'the html track length matches RAW_MAX');
is(parseInt(rangeTag.match(/value="(\d+)"/)[1], 10), PIVOT,
  'the html initial position is the 100% detent');

const mapping = new Function(
  `var PIVOT = ${PIVOT}, RAW_MAX = ${RAW_MAX}, MAX_GAIN = ${MAX_GAIN};
   ${extract(popupSource, 'rawToGain')}
   ${extract(popupSource, 'gainToRaw')}
   return { rawToGain: rawToGain, gainToRaw: gainToRaw };`
)();

is(mapping.rawToGain(0), 0, 'raw 0 is silence');
is(mapping.rawToGain(PIVOT), 1, `the detent at raw ${PIVOT} is exactly 100%`);
is(mapping.rawToGain(RAW_MAX), MAX_GAIN, `raw ${RAW_MAX} is ${MAX_GAIN * 100}%`);
is(mapping.gainToRaw(1), PIVOT, '100% maps back to the detent');
is(mapping.gainToRaw(MAX_GAIN), RAW_MAX, `${MAX_GAIN * 100}% maps to the end of the track`);

for (const gain of [0, 0.25, 0.5, 1, 1.5, 2, 3, 4, 5, MAX_GAIN]) {
  const round = mapping.rawToGain(mapping.gainToRaw(gain));
  ok(Math.abs(round - gain) < 0.005, `${gain} survives a round trip (got ${round.toFixed(4)})`);
}

ok(mapping.gainToRaw(1) / RAW_MAX === 0.4,
  'the 100% detent sits at 40% of the track, matching the CSS marker');

/* ==================================================================== *
 * The popup, booted for real.
 *
 * Everything the popup promises happens in popup.js, and none of it ran
 * under test before this: the userTouched guard, the status line, the
 * notices, and the blocked-page path all regress silently without this.
 * ==================================================================== */

describe('popup.js');

function loadPopup(options = {}) {
  const timers = [];
  const messages = [];
  const els = {};

  function fakeEl(id) {
    const listeners = {};
    const set = new Set();
    return {
      id,
      _text: '',
      get textContent() { return this._text; },
      set textContent(v) { this._text = v; if (v === '') this.children = []; },
      value: '',
      checked: false,
      hidden: false,
      style: {},
      children: [],
      attrs: {},
      classList: {
        add(c) { set.add(c); },
        remove(c) { set.delete(c); },
        toggle(c, force) { force ? set.add(c) : set.delete(c); },
        contains(c) { return set.has(c); }
      },
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
      addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
      fire(t, ev) { (listeners[t] || []).forEach((fn) => fn(ev || {})); },
      appendChild(c) { this.children.push(c); },
      querySelectorAll() { return this.id === 'presets' ? presetButtons : []; },
      closest() { return this; }
    };
  }

  const presetButtons = ['1', '1.5', '2', '3', '5'].map((g) => {
    const b = fakeEl('preset-' + g);
    b.setAttribute('data-gain', g);
    return b;
  });

  for (const id of ['app', 'host', 'value', 'readout', 'grad', 'range', 'presets',
    'mute', 'muteLabel', 'waves', 'cross', 'status', 'remember', 'resetAll', 'notice']) {
    els[id] = fakeEl(id);
  }
  els.app.classList.add('is-booting');

  const doc = {
    getElementById: (id) => els[id],
    createElement: (tag) => fakeEl(tag),
    createTextNode: (text) => ({ text })
  };
  const win = { addEventListener() {} };

  const chrome = {
    runtime: {
      sendMessage(msg) {
        messages.push(msg);
        return Promise.resolve(options.handle ? options.handle(msg) : null);
      }
    },
    tabs: {
      query: () => Promise.resolve([options.tab || { id: 1, url: 'https://a.example/watch' }])
    },
    storage: {
      local: { get: () => Promise.resolve({ sites: options.stored || {} }) }
    }
  };

  new Function(
    'window', 'document', 'chrome', 'setTimeout',
    popupSource
  )(win, doc, chrome, (fn) => { timers.push(fn); return timers.length; });

  return {
    els,
    messages,
    presetButtons,
    flush: () => timers.splice(0).forEach((fn) => fn())
  };
}

/** A background that answers every popup message from one snapshot. */
function answering(snapshot) {
  return (msg) => {
    if (msg.t === 'inject') return snapshot.connected ? { ok: true, state: snapshot } : { ok: false };
    return snapshot;
  };
}

{
  const snapshot = {
    connected: true, gain: 3, muted: false, origin: 'https://a.example',
    agg: { media: 1, boosted: 1, silenced: 0, protectedCount: 0, taintedCount: 0, suspended: false },
    opts: { remember: true }
  };
  const popup = loadPopup({ handle: answering(snapshot) });
  await settle();
  popup.flush();

  is(popup.els.value.textContent, '300', 'the saved level is painted');
  is(popup.els.host.textContent, 'a.example', 'the host is painted');
  is(popup.els.status.textContent, '1 source boosted', 'the status counts what is boosted');
  is(popup.els.notice.hidden, true, 'a healthy page shows no notice');
}

{
  // The bug this repo already shipped a fix for, popup side: a stale read
  // must never overwrite a level the user is in the middle of setting.
  const snapshot = {
    connected: true, gain: 1, muted: false, origin: 'https://a.example',
    agg: { media: 1, boosted: 1, silenced: 0, protectedCount: 0, taintedCount: 0, suspended: false },
    opts: { remember: true }
  };
  const popup = loadPopup({ handle: answering(snapshot) });
  await settle();
  popup.flush();

  popup.els.range.value = '520';
  popup.els.range.fire('input');
  is(popup.els.value.textContent, '200', 'dragging paints immediately');

  // The 800ms poll answers with the stale pre-drag level.
  popup.flush();
  await settle();
  is(popup.els.value.textContent, '200', 'a stale poll does not roll the slider back');
  ok(popup.messages.some((m) => m.t === 'set' && m.gain === 2),
    'and the dragged level was sent to the background');
}

{
  const popup = loadPopup({ tab: { id: 2, url: 'chrome://extensions/' } });
  await settle();
  popup.flush();

  ok(popup.els.app.classList.contains('is-blocked'), 'an internal page blocks the popup');
  is(popup.els.status.textContent, 'Not available here', 'and says so in the status line');
  is(popup.els.notice.hidden, false, 'with an explanation');
}

{
  const snapshot = {
    connected: true, gain: 2, muted: false, origin: 'https://drm.example',
    agg: { media: 1, boosted: 0, silenced: 0, protectedCount: 1, taintedCount: 0, suspended: false },
    opts: { remember: true }
  };
  const popup = loadPopup({ handle: answering(snapshot) });
  await settle();
  popup.flush();

  is(popup.els.status.textContent, 'Protected audio', 'DRM is named in the status line');
  is(popup.els.notice.hidden, false, 'and explained in the notice');
  is(popup.els.notice.children[0].textContent, 'Protected audio', 'with the right heading');
}

/* ==================================================================== *
 * Background: storage, badge, and the port state machine
 * ==================================================================== */

describe('background.js');

function loadBackground(options = {}) {
  const store = {};
  const badges = {};
  const listeners = {};
  const injections = [];
  let lastErrorReads = 0;

  const api = {
    runtime: {
      id: 'test',
      get lastError() { lastErrorReads++; return undefined; },
      onConnect: { addListener: (fn) => { listeners.connect = fn; } },
      onMessage: { addListener: (fn) => { listeners.message = fn; } }
    },
    tabs: {
      onRemoved: { addListener: (fn) => { listeners.removed = fn; } },
      query: () => Promise.resolve([{ id: 1 }])
    },
    commands: { onCommand: { addListener: (fn) => { listeners.command = fn; } } },
    storage: {
      local: {
        get: (key) => Promise.resolve(key in store ? { [key]: store[key] } : {}),
        set: (patch) => { Object.assign(store, patch); return Promise.resolve(); }
      }
    },
    action: {
      setBadgeText: ({ tabId, text }) => { badges[tabId] = text; },
      setBadgeBackgroundColor: () => {},
      setBadgeTextColor: () => {}
    },
    scripting: {
      executeScript: (spec) => {
        injections.push(spec);
        return options.injectFails
          ? Promise.reject(new Error('cannot access the page'))
          : Promise.resolve([]);
      }
    }
  };

  new Function('browser', backgroundSource)(api);

  /**
   * Simulates a content script frame opening its port. `live` is what the
   * frame is already set to, which is how a frame that outlived the background
   * reports a level nothing else remembers.
   */
  function openFrame(tabId, origin, top = true, live = {}) {
    const sent = [];
    const port = {
      name: 'vb',
      sender: { tab: { id: tabId }, frameId: top ? 0 : 1 },
      postMessage: (msg) => sent.push(msg),
      onDisconnect: { addListener: (fn) => { port.disconnect = fn; } },
      onMessage: { addListener: (fn) => { port.receive = fn; } }
    };
    listeners.connect(port);
    port.receive({
      t: 'hello', origin, top,
      gain: live.gain, muted: live.muted,
      status: { media: 1, boosted: 0 }
    });
    return { port, sent };
  }

  const send = (msg) => new Promise((resolve) => {
    listeners.message(msg, {}, resolve);
  });

  return {
    store, badges, listeners, openFrame, send, injections,
    lastErrorReads: () => lastErrorReads
  };
}

{
  const bg = loadBackground();
  const frame = bg.openFrame(1, 'https://youtube.com');
  await settle();

  await bg.send({ t: 'set', tabId: 1, gain: 2.5, muted: false });
  await settle();

  is(frame.sent[frame.sent.length - 1].gain, 2.5, 'setting a level reaches the content script');
  is(bg.badges[1], '250%', 'the badge shows the level');
  is(bg.store.sites['https://youtube.com'].g, 2.5, 'the level is stored against the origin');

  await bg.send({ t: 'set', tabId: 1, gain: 2.5, muted: true });
  await settle();
  is(bg.badges[1], 'MUTE', 'muting is shown on the badge');

  await bg.send({ t: 'set', tabId: 1, gain: 1, muted: false });
  await settle();
  is(bg.badges[1], '', 'the badge clears at 100%');
  is(bg.store.sites['https://youtube.com'], undefined,
    'returning to 100% removes the stored entry instead of saving a no-op');
}

{
  const bg = loadBackground();
  bg.store.sites = { 'https://twitch.tv': { g: 3, m: false, t: 1 } };
  const frame = bg.openFrame(2, 'https://twitch.tv');
  await settle();

  const push = frame.sent[frame.sent.length - 1];
  is(push.gain, 3, 'a returning visit restores the saved level without the popup opening');
  is(bg.badges[2], '300%', 'the badge is restored too');
}

{
  const bg = loadBackground();
  const top = bg.openFrame(3, 'https://site.example');
  const sub = bg.openFrame(3, 'https://widget.other', false);
  await settle();

  await bg.send({ t: 'set', tabId: 3, gain: 4, muted: false });
  await settle();

  is(top.sent[top.sent.length - 1].gain, 4, 'the top frame is updated');
  is(sub.sent[sub.sent.length - 1].gain, 4, 'a cross-origin subframe gets the same level');
  is(bg.store.sites['https://site.example'].g, 4,
    'the tab is stored under the top frame origin, not the subframe');
  is(bg.store.sites['https://widget.other'], undefined,
    'a subframe origin never becomes a stored site');
}

{
  const bg = loadBackground();
  const sites = {};
  for (let i = 0; i < 305; i++) sites[`https://s${i}.example`] = { g: 2, m: false, t: i };
  bg.store.sites = sites;

  bg.openFrame(4, 'https://fresh.example');
  await settle();
  await bg.send({ t: 'set', tabId: 4, gain: 2, muted: false });
  await settle();

  const stored = Object.keys(bg.store.sites);
  is(stored.length, 300, 'the site list is capped at 300');
  ok(!stored.includes('https://s0.example'), 'the oldest entry is evicted first');
  ok(stored.includes('https://s304.example'), 'the newest entries survive');
  ok(stored.includes('https://fresh.example'), 'the site being written survives');
}

{
  const bg = loadBackground();
  bg.store.sites = { 'https://a.example': { g: 2, m: false, t: 1 } };
  const frame = bg.openFrame(5, 'https://a.example');
  await settle();

  await bg.send({ t: 'resetAll', tabId: 5 });
  await settle();

  is(bg.store.sites, {}, 'reset clears every stored site');
  is(frame.sent[frame.sent.length - 1].gain, 1, 'reset pushes 100% to open tabs');
  is(bg.badges[5], '', 'reset clears the badge');
}

{
  const bg = loadBackground();
  const frame = bg.openFrame(6, 'chrome://extensions');
  await settle();
  await bg.send({ t: 'set', tabId: 6, gain: 2, muted: false });
  await settle();

  is(bg.store.sites, undefined, 'a non-http origin is never written to storage');
  is(frame.sent[frame.sent.length - 1].gain, 2, 'but the live tab still responds');
}

{
  const bg = loadBackground();
  bg.openFrame(7, 'https://b.example');
  await settle();
  await bg.send({ t: 'set', tabId: 7, gain: 3, muted: false });
  await settle();

  bg.listeners.removed(7);
  const after = await bg.send({ t: 'get', tabId: 7 });
  is(after.gain, 1, 'closing a tab drops its state');
  is(after.connected, false, 'and reports nothing connected');
}

{
  const bg = loadBackground();
  bg.store.sites = { 'https://race.example': { g: 3, m: false, t: 1 } };
  bg.openFrame(9, 'https://race.example');

  // No settle: the user moves the slider while the storage read for this site
  // is still in flight, which is a few milliseconds wide on every page load.
  await bg.send({ t: 'set', tabId: 9, gain: 5, muted: false });
  await settle();

  const after = await bg.send({ t: 'get', tabId: 9 });
  is(after.gain, 5, 'a level chosen during the storage read survives it');
  is(bg.badges[9], '500%', 'and the badge is not rolled back either');
}

{
  const bg = loadBackground();
  // Nothing stored is what a restarted background sees when remembering is
  // off, and the frame is then the only thing that knows the level.
  const frame = bg.openFrame(10, 'https://live.example', true, { gain: 4, muted: false });
  await settle();

  const after = await bg.send({ t: 'get', tabId: 10 });
  is(after.gain, 4, 'a frame that is already boosted keeps its level across a restart');
  is(bg.badges[10], '400%', 'and the badge comes back with it');
  ok(!frame.sent.some((m) => m.t === 'set' && m.gain === 1),
    'the frame is never told to drop back to 100%');

  // The same path on a real navigation, where the new page reports 100%.
  const fresh = bg.openFrame(10, 'https://elsewhere.example', true, { gain: 1 });
  await settle();
  is(fresh.sent[fresh.sent.length - 1].gain, 1, 'a new site still starts at 100%');
}

{
  const bg = loadBackground();
  const frame = bg.openFrame(8, 'https://cached.example');
  await settle();

  // The browser closes a frame's port when the page goes into the back/forward
  // cache and reports that here as an error, which is logged as unchecked
  // unless the listener reads it.
  frame.port.disconnect();
  ok(bg.lastErrorReads() > 0, 'a dropped frame reads lastError');

  const after = await bg.send({ t: 'get', tabId: 8 });
  is(after.connected, false, 'and is removed from the tab');
}

{
  const bg = loadBackground();
  const frame = bg.openFrame(1, 'https://c.example');
  await settle();

  bg.listeners.command('boost-up');
  await settle();
  is(frame.sent[frame.sent.length - 1].gain, 1.25, 'the keyboard shortcut nudges up');

  bg.listeners.command('boost-mute');
  await settle();
  is(frame.sent[frame.sent.length - 1].muted, true, 'the keyboard shortcut mutes');

  bg.listeners.command('boost-reset');
  await settle();
  is(frame.sent[frame.sent.length - 1].gain, 1, 'the keyboard shortcut resets');
}

/* ==================================================================== *
 * Origin integrity. The background can only trust st.origin while a top
 * frame is connected to vouch for it. Outside that window a save either
 * has to wait for the next hello or not happen at all.
 * ==================================================================== */

describe('background.js origin integrity');

{
  // The worker was just evicted, so the tab state is fresh and has no
  // origin yet. A level chosen in that gap used to be discarded when the
  // first hello adopted the saved level over it.
  const bg = loadBackground();
  bg.store.sites = { 'https://gap.example': { g: 3, m: false, t: 1 } };

  await bg.send({ t: 'set', tabId: 15, gain: 5, muted: false });
  const frame = bg.openFrame(15, 'https://gap.example', true, { gain: 3 });
  await settle();

  const after = await bg.send({ t: 'get', tabId: 15 });
  is(after.gain, 5, 'a level set before the first hello survives it');
  is(bg.store.sites['https://gap.example'].g, 5, 'and is saved once the origin is known');
  is(frame.sent[frame.sent.length - 1].gain, 5, 'and reaches the frame');
}

{
  // Navigating to a page the content script cannot run on leaves the last
  // origin behind with nothing to correct it. A keyboard shortcut pressed
  // there must not edit that site's stored level.
  // Tab 1, because the command handler resolves the active tab and the
  // harness answers every tabs.query with tab 1.
  const bg = loadBackground();
  const frame = bg.openFrame(1, 'https://site-a.example');
  await settle();
  await bg.send({ t: 'set', tabId: 1, gain: 3, muted: false });
  await settle();
  is(bg.store.sites['https://site-a.example'].g, 3, 'the level is saved while the site is live');

  frame.port.disconnect();
  bg.listeners.command('boost-up');
  await settle();
  is(bg.store.sites['https://site-a.example'].g, 3,
    'a shortcut with no frame connected leaves the old site alone');
}

{
  // The page is in the back/forward cache while the popup changes the tab.
  // The save waits for the frame to come back and confirm the origin.
  const bg = loadBackground();
  const first = bg.openFrame(17, 'https://back.example');
  await settle();
  await bg.send({ t: 'set', tabId: 17, gain: 3, muted: false });
  await settle();

  first.port.disconnect();
  await bg.send({ t: 'set', tabId: 17, gain: 4, muted: false });
  await settle();

  bg.openFrame(17, 'https://back.example', true, { gain: 3 });
  await settle();
  is(bg.store.sites['https://back.example'].g, 4,
    'a parked change is saved when the same site reconnects');
}

/* ==================================================================== *
 * The restore window. Between the background waking and the saved level
 * being read back, the tab state briefly holds the default. Frames that
 * reconnect inside that window must not be handed the default as if it
 * were the answer.
 * ==================================================================== */

describe('background.js restore window');

{
  // After an eviction every frame reconnects at once, in no particular
  // order. A boosted iframe player whose hello wins the race used to be
  // told 100%, audibly dipping until the top frame's restore broadcast.
  const bg = loadBackground();
  bg.store.sites = { 'https://player.example': { g: 3, m: false, t: 1 } };

  const sub = bg.openFrame(18, 'https://embed.other', false, { gain: 3 });
  bg.openFrame(18, 'https://player.example', true, { gain: 3 });
  await settle();

  ok(!sub.sent.some((m) => m.t === 'set' && m.gain === 1),
    'a subframe reconnecting first is never told to drop to 100%');
  is(sub.sent[sub.sent.length - 1].gain, 3, 'it gets the restored level instead');
}

{
  // The same dip through the other door: the top frame reconnects first,
  // and the subframe's hello lands while the storage read is in flight.
  const bg = loadBackground();
  bg.store.sites = { 'https://player.example': { g: 3, m: false, t: 1 } };

  bg.openFrame(19, 'https://player.example', true, { gain: 3 });
  const sub = bg.openFrame(19, 'https://embed.other', false, { gain: 3 });
  await settle();

  ok(!sub.sent.some((m) => m.t === 'set' && m.gain === 1),
    'a subframe arriving during the storage read is not told 100% either');
  is(sub.sent[sub.sent.length - 1].gain, 3, 'the restore broadcast reaches it');
}

/* ==================================================================== *
 * Remembering is a promise about storage, made both ways: save when it is
 * on, and keep hands off the disk when it is off. Neither direction had a
 * test, so either could regress without a gate going red.
 * ==================================================================== */

describe('background.js remember and forget');

{
  const bg = loadBackground();
  bg.openFrame(11, 'https://quiet.example');
  await settle();

  await bg.send({ t: 'opts', tabId: 11, patch: { remember: false } });
  await bg.send({ t: 'set', tabId: 11, gain: 2, muted: false });
  await settle();

  ok(!(bg.store.sites && bg.store.sites['https://quiet.example']),
    'with remembering off, a level is never written to disk');

  const after = await bg.send({ t: 'get', tabId: 11 });
  is(after.gain, 2, 'but the live tab still gets the level');
}

{
  const bg = loadBackground();
  bg.store.sites = {
    'https://drop.example': { g: 3, m: false, t: 1 },
    'https://keep.example': { g: 2, m: false, t: 2 }
  };
  bg.openFrame(12, 'https://drop.example');
  await settle();

  await bg.send({ t: 'forget', tabId: 12 });
  is(bg.store.sites['https://drop.example'], undefined,
    'forget removes the stored entry for the current site');
  is(bg.store.sites['https://keep.example'].g, 2,
    'and leaves every other site alone');
}

/* ==================================================================== *
 * The inject fallback: the popup's only way to attach to a page that was
 * open before the extension was installed.
 * ==================================================================== */

describe('background.js inject');

{
  const bg = loadBackground();
  const res = await bg.send({ t: 'inject', tabId: 13 });
  is(bg.injections.length, 1, 'the inject message injects');
  is(bg.injections[0].target.tabId, 13, 'into the requested tab');
  is(bg.injections[0].target.allFrames, true, 'across every frame');
  is(bg.injections[0].files[0], 'content.js', 'with the real content script');
  is(res.ok, true, 'and reports success');
}

{
  const bg = loadBackground({ injectFails: true });
  const res = await bg.send({ t: 'inject', tabId: 14 });
  is(res.ok, false, 'a page the browser refuses reports failure instead of hanging');
}

/* ==================================================================== */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
