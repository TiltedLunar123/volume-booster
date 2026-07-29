/*
 * End to end tests against a real browser.
 *
 * Everything here is a thing unit tests cannot reach: whether the content
 * script actually attaches, whether a level survives a navigation, and whether
 * a page restored from the back/forward cache still has working audio. The
 * back/forward cache case in particular is invisible to a unit test, because
 * the failure is a browser lifecycle event rather than a branch in our code.
 *
 * Runs in a throwaway profile with this extension and nothing else, so other
 * volume extensions on the machine cannot fight it for the same media element.
 *
 * Run: node test/e2e.mjs [path-to-unpacked-extension]
 * Needs Edge. Branded Chrome ignores --load-extension.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT = process.argv[2] || path.join(HERE, '..', 'dist', 'chrome');

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
];

let passed = 0;
let failed = 0;

function is(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; console.log(`  ok    ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}\n          expected ${b}\n          actual   ${a}`); }
}

function ok(condition, label) { is(!!condition, true, label); }

function describe(name) { console.log(`\n${name}`); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/* -------------------------------------------------------------------- *
 * Fixture pages
 * -------------------------------------------------------------------- */

function silentWav() {
  const samples = 8000;
  const buf = Buffer.alloc(44 + samples);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(16000, 28);
  buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34); buf.write('data', 36);
  buf.writeUInt32LE(samples, 40);
  return buf;
}

function serve(port) {
  const wav = silentWav();
  const doc = (title, body = '') =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<h1>${title}</h1><audio controls src="/tone.wav"></audio>${body}`;

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/tone.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(wav);
    }
    if (url === '/frame.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(doc('SUBFRAME'));
    }
    if (url === '/framed.html') {
      // 127.0.0.1 is a different origin from localhost, so this covers the
      // cross-origin embed that real pages are full of.
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(doc('FRAMED',
        `<iframe src="http://127.0.0.1:${port}/frame.html"></iframe>` +
        `<iframe src="/frame.html"></iframe>`));
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(doc(url === '/b.html' ? 'PAGE B' : 'PAGE A'));
  });
  return new Promise((r) => server.listen(port, () => r(server)));
}

/* -------------------------------------------------------------------- *
 * Chrome DevTools Protocol
 * -------------------------------------------------------------------- */

let seq = 0;

function connect(url, onEvent = () => {}) {
  const ws = new WebSocket(url);
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result, msg.error); pending.delete(msg.id); }
    else if (msg.method) onEvent(msg);
  });
  return {
    ready: new Promise((r) => ws.addEventListener('open', r)),
    close: () => ws.close(),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (result, error) => {
        if (error) reject(new Error(`${method}: ${error.message || JSON.stringify(error)}`));
        else resolve(result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    })
  };
}

async function waitForTarget(cdp, pred, label, ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const list = await fetch(`http://127.0.0.1:${cdp}/json/list`).then((r) => r.json()).catch(() => []);
    const hit = list.find(pred);
    if (hit) return hit;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/* -------------------------------------------------------------------- *
 * Run
 * -------------------------------------------------------------------- */

const browser = BROWSERS.find((p) => fs.existsSync(p));
if (!browser) {
  console.log('no Edge found, skipping the end to end run');
  process.exit(0);
}
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.log(`no unpacked extension at ${EXT}, run tools/build.mjs first`);
  process.exit(1);
}

const PORT = await freePort();
const CDP = await freePort();
const server = await serve(PORT);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vb-e2e-'));

const proc = spawn(browser, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${CDP}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-sync',
  `http://localhost:${PORT}/a.html`
], { stdio: 'ignore' });

const site = `http://localhost:${PORT}`;
let swConn = null;
let pageConn = null;
const consoleErrors = [];

try {
  await sleep(3000);

  const sw = await waitForTarget(CDP,
    (t) => t.type === 'service_worker' && t.url.endsWith('/background.js'),
    'the extension service worker');

  swConn = connect(sw.webSocketDebuggerUrl, (msg) => {
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      consoleErrors.push(msg.params.entry.text);
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });
  await swConn.ready;
  await swConn.send('Runtime.enable');
  await swConn.send('Log.enable');

  /** Evaluates in the service worker and returns the value. */
  async function inWorker(expression) {
    const res = await swConn.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (res?.exceptionDetails) throw new Error(expression + ' -> ' + JSON.stringify(res.exceptionDetails));
    return res?.result?.value;
  }

  const state = () => inWorker(
    `(function () {
       var id = Array.from(tabs.keys())[0];
       if (id === undefined) return null;
       var st = tabs.get(id);
       return JSON.stringify({ tabId: id, gain: st.gain, muted: st.muted,
         origin: st.origin, agg: aggregate(st) });
     })()`).then((v) => (v ? JSON.parse(v) : null));

  const target = await waitForTarget(CDP, (t) => t.type === 'page' && t.url.includes('localhost'), 'page');
  pageConn = connect(target.webSocketDebuggerUrl);
  await pageConn.ready;
  await pageConn.send('Page.enable');

  const goto = async (url, settle = 2000) => {
    await pageConn.send('Page.navigate', { url });
    await sleep(settle);
  };

  /* ---------------------------------------------------------------- */
  describe('attach');

  await goto(`${site}/a.html`);
  let snap = await state();
  ok(snap && snap.agg.frames >= 1, 'the content script attaches and opens a port');
  is(snap && snap.origin, site, 'the background records the top frame origin');
  ok(snap && snap.agg.media >= 1, 'the audio element on the page is found');

  /* ---------------------------------------------------------------- */
  describe('boost');

  await inWorker(`applyLevel(${snap.tabId}, 2, false)`);
  await sleep(1200);
  snap = await state();
  is(snap.gain, 2, 'the level is applied');
  ok(snap.agg.boosted >= 1, 'the audio graph is built and the element is routed');
  is(await inWorker(`chrome.action.getBadgeText({tabId: ${snap.tabId}})`), '200%',
    'the badge shows the level');
  is(await inWorker(`chrome.storage.local.get('sites').then(function (r) {
       return (r.sites && r.sites['${site}'] || {}).g; })`), 2,
    'the level is remembered against the origin');

  /* ---------------------------------------------------------------- */
  describe('back/forward cache');

  const boostedBefore = snap.agg.boosted;
  await pageConn.send('Runtime.evaluate', { expression: 'window.__marker = 42' });
  await goto(`${site}/b.html`);

  const history = await pageConn.send('Page.getNavigationHistory');
  await pageConn.send('Page.navigateToHistoryEntry', {
    entryId: history.entries[history.currentIndex - 1].id
  });
  await sleep(3000);

  const marker = await pageConn.send('Runtime.evaluate', {
    expression: 'window.__marker || 0', returnByValue: true
  });
  ok(marker.result?.value === 42,
    'the page really came back from the cache rather than reloading');

  snap = await state();
  ok(snap.agg.frames >= 1, 'the port is reopened after a cache restore');
  is(snap.agg.boosted, boostedBefore,
    'the audio graph survives the cache, so restored pages are not silent');
  is(snap.gain, 2, 'and the level is still applied');

  const bfcacheNoise = consoleErrors.filter((t) => /back\/forward cache/i.test(t));
  is(bfcacheNoise.length, 0, 'the worker logs no back/forward cache port errors');

  /* ---------------------------------------------------------------- */
  describe('frames');

  await goto(`${site}/framed.html`, 2500);
  snap = await state();
  is(snap.agg.frames, 3, 'every frame attaches, including the cross-origin one');
  ok(snap.agg.media >= 3, 'media in subframes is found');

  /* ---------------------------------------------------------------- */
  describe('controls');

  await inWorker(`applyLevel(${snap.tabId}, 2, true)`);
  await sleep(600);
  is(await inWorker(`chrome.action.getBadgeText({tabId: ${snap.tabId}})`), 'MUTE',
    'muting is shown on the badge');

  await inWorker(`applyLevel(${snap.tabId}, 1, false)`);
  await sleep(600);
  is(await inWorker(`chrome.action.getBadgeText({tabId: ${snap.tabId}})`), '',
    'the badge clears at 100%');
  is(await inWorker(`chrome.storage.local.get('sites').then(function (r) {
       return r.sites && r.sites['${site}']; })`), undefined,
    'returning to 100% drops the stored entry');

  /* ---------------------------------------------------------------- */
  describe('worker console');

  const unchecked = consoleErrors.filter((t) => /Unchecked runtime\.lastError/i.test(t));
  is(unchecked, [], 'nothing was left unchecked across the whole run');
  is(consoleErrors, [], 'the worker logged no errors at all');
} catch (e) {
  failed++;
  console.log(`\n  FAIL  harness error: ${e.message}`);
} finally {
  try { swConn?.close(); pageConn?.close(); } catch { /* already gone */ }
  proc.kill();
  server.close();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* locked, temp dir */ }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
