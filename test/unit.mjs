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
 * Slider mapping
 * ==================================================================== */

describe('popup.js slider mapping');

const mapping = new Function(
  `var PIVOT = 400, RAW_MAX = 1000, MAX_GAIN = 6;
   ${extract(popupSource, 'rawToGain')}
   ${extract(popupSource, 'gainToRaw')}
   return { rawToGain: rawToGain, gainToRaw: gainToRaw };`
)();

is(mapping.rawToGain(0), 0, 'raw 0 is silence');
is(mapping.rawToGain(400), 1, 'the detent at raw 400 is exactly 100%');
is(mapping.rawToGain(1000), 6, 'raw 1000 is 600%');
is(mapping.gainToRaw(1), 400, '100% maps back to the detent');
is(mapping.gainToRaw(6), 1000, '600% maps to the end of the track');

for (const gain of [0, 0.25, 0.5, 1, 1.5, 2, 3, 4, 5, 6]) {
  const round = mapping.rawToGain(mapping.gainToRaw(gain));
  ok(Math.abs(round - gain) < 0.005, `${gain} survives a round trip (got ${round.toFixed(4)})`);
}

ok(mapping.gainToRaw(1) / 1000 === 0.4,
  'the 100% detent sits at 40% of the track, matching the CSS marker');

/* ==================================================================== *
 * Background: storage, badge, and the port state machine
 * ==================================================================== */

describe('background.js');

function loadBackground() {
  const store = {};
  const badges = {};
  const listeners = {};

  const api = {
    runtime: {
      id: 'test',
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
    scripting: { executeScript: () => Promise.resolve([]) }
  };

  new Function('browser', backgroundSource)(api);

  /** Simulates a content script frame opening its port. */
  function openFrame(tabId, origin, top = true) {
    const sent = [];
    const port = {
      name: 'vb',
      sender: { tab: { id: tabId }, frameId: top ? 0 : 1 },
      postMessage: (msg) => sent.push(msg),
      onDisconnect: { addListener: (fn) => { port.disconnect = fn; } },
      onMessage: { addListener: (fn) => { port.receive = fn; } }
    };
    listeners.connect(port);
    port.receive({ t: 'hello', origin, top, status: { media: 1, boosted: 0 } });
    return { port, sent };
  }

  const send = (msg) => new Promise((resolve) => {
    listeners.message(msg, {}, resolve);
  });

  return { store, badges, listeners, openFrame, send };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

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

/* ==================================================================== */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
