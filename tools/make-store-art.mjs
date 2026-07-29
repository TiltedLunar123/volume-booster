/*
 * Renders the Chrome Web Store screenshots and promo tiles.
 *
 * The popup in these images is the real thing: the same markup out of
 * popup.html and the same popup.css that ships, laid out by Chromium. Nothing
 * here is a drawing of the UI, so the screenshots cannot drift away from what
 * users actually see.
 *
 * Drives a headless Chromium over the DevTools protocol using the WebSocket
 * built into Node 22 and later, so there is still nothing to npm install.
 *
 * Run: node tools/make-store-art.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toOpaquePng } from './png.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'store');
const PORT = 9333;

/* ------------------------------ browser ------------------------------ */

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const roots = [
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright')
  ];
  const names = [
    path.join('chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    path.join('chrome-headless-shell-linux', 'chrome-headless-shell'),
    path.join('chrome-headless-shell-mac', 'chrome-headless-shell'),
    path.join('chrome-win', 'chrome.exe'),
    path.join('chrome-linux', 'chrome')
  ];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    for (const dir of fs.readdirSync(root).sort().reverse()) {
      for (const name of names) {
        const candidate = path.join(root, dir, name);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }

  const installed = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium'
  ];
  for (const candidate of installed) if (fs.existsSync(candidate)) return candidate;

  throw new Error(
    'No Chromium found. Set CHROME_PATH to a Chrome or chrome-headless-shell binary.'
  );
}

async function waitForDevTools(deadlineMs = 20000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    if (Date.now() - started > deadlineMs) throw new Error('Chromium never opened its debug port');
    await new Promise((r) => setTimeout(r, 120));
  }
}

class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.waiters = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      for (const waiter of this.waiters.slice()) {
        if (waiter.method === message.method) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message.params);
        }
      }
    });
  }

  static async open(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => reject(new Error('devtools socket failed')), { once: true });
    });
    return new Devtools(socket);
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.socket.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  once(method, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) {
          this.waiters.splice(at, 1);
          reject(new Error(`timed out waiting for ${method}`));
        }
      }, timeoutMs);
    });
  }
}

/* ------------------------------- markup ------------------------------ */

const popupCss = fs.readFileSync(path.join(SRC, 'popup.css'), 'utf8')
  // popup.css sizes the popup through `body`. Inside a promo frame the popup is
  // one element on a much larger page, so that rule is rehomed onto its wrapper.
  .replace(/\bbody\s*\{/, '.popup {');

const popupMarkup = fs.readFileSync(path.join(SRC, 'popup.html'), 'utf8')
  .match(/<main[\s\S]*<\/main>/)[0];

const iconDataUri =
  'data:image/png;base64,' +
  fs.readFileSync(path.join(SRC, 'icons', 'icon-128.png')).toString('base64');

const PIVOT = 400;
const RAW_MAX = 1000;

function gainToRaw(gain) {
  return gain <= 1 ? Math.round(gain * PIVOT) : Math.round(PIVOT + ((gain - 1) / 5) * (RAW_MAX - PIVOT));
}

/**
 * Paints one popup into the state it would be in, using the same numbers
 * popup.js would compute.
 */
function popup({ gain = 1, host = '', status = '', notice = null, muted = false, light = false, scale = 1.65 }) {
  const raw = gainToRaw(gain);
  const shown = muted ? 0 : Math.round(gain * 100);
  const clip = 100 - (raw / RAW_MAX) * 100;
  const hot = !muted && gain > 3 && gain <= 5 ? ' is-hot' : '';
  const max = !muted && gain > 5 ? ' is-max' : '';
  const state = {
    shown, clip, raw, host, status, notice, muted,
    presets: [1, 1.5, 2, 3, 5].map((g) => !muted && Math.abs(g - gain) < 0.005),
    readout: `readout${muted ? ' is-muted' : ''}${hot}${max}`
  };

  return `
<div class="popup${light ? ' light' : ''}" style="zoom:${scale}">
  ${popupMarkup}
  <script type="application/json" class="state">${JSON.stringify(state)}</script>
</div>`;
}

const APPLY_STATE = `
for (const root of document.querySelectorAll('.popup')) {
  const s = JSON.parse(root.querySelector('script.state').textContent);
  const q = (sel) => root.querySelector(sel);
  q('.app').classList.remove('is-booting');
  q('#host').textContent = s.host;
  q('#value').textContent = String(s.shown);
  q('#readout').className = s.readout;
  q('#grad').style.clipPath = 'inset(0 ' + s.clip + '% 0 0)';
  q('#range').value = String(s.raw);
  q('#status').textContent = s.status;
  q('#mute').setAttribute('aria-pressed', s.muted ? 'true' : 'false');
  q('#muteLabel').textContent = s.muted ? 'Unmute' : 'Mute';
  q('#waves').hidden = s.muted;
  q('#cross').hidden = !s.muted;
  root.querySelectorAll('.presets button').forEach((b, i) => {
    b.setAttribute('aria-pressed', s.presets[i] ? 'true' : 'false');
  });
  const notice = q('#notice');
  if (s.notice) {
    notice.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = s.notice[0];
    notice.appendChild(strong);
    notice.appendChild(document.createTextNode(s.notice[1]));
    notice.hidden = false;
  } else {
    notice.hidden = true;
  }
}`;

const FRAME_CSS = `
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
  body {
    background: #0b0d10;
    color: #eef0f3;
    font: 16px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
    overflow: hidden;
  }
  .frame {
    position: absolute; inset: 0;
    background:
      radial-gradient(900px 620px at 78% 42%, rgba(34,197,94,0.16), transparent 62%),
      radial-gradient(700px 500px at 8% 88%, rgba(34,197,94,0.07), transparent 60%),
      linear-gradient(160deg, #10141a 0%, #0a0c0f 100%);
    display: flex; align-items: center; box-sizing: border-box;
  }
  .copy { flex: 1; padding: 0 0 0 92px; max-width: 620px; }
  h1 {
    font-size: 54px; line-height: 1.08; letter-spacing: -0.03em;
    font-weight: 700; margin: 0 0 22px;
  }
  h1 .accent { color: #34d76f; }
  p.sub { font-size: 21px; line-height: 1.5; color: #9aa2ad; margin: 0; max-width: 30ch; }
  ul.points { margin: 26px 0 0; padding: 0; list-style: none; }
  ul.points li {
    font-size: 18px; color: #c3c9d1; margin: 0 0 12px; padding-left: 28px; position: relative;
  }
  ul.points li::before {
    content: ''; position: absolute; left: 0; top: 8px;
    width: 9px; height: 9px; border-radius: 50%; background: #34d76f;
  }
  .stage {
    flex: none; display: flex; align-items: center; justify-content: center;
    gap: 34px; padding-right: 92px;
  }
  .popup {
    border-radius: 16px; overflow: hidden;
    box-shadow: 0 34px 80px rgba(0,0,0,0.62), 0 0 0 1px rgba(255,255,255,0.06);
  }
  .popup.light {
    --bg:#ffffff; --surface:#f6f7f8; --surface-2:#eceef1; --line:#e1e4e8; --text:#14161a;
    --dim:#5f6570; --accent:#16a34a; --hot:#d97706; --danger:#dc2626;
    --ring:rgba(22,163,74,.3); --shadow:0 2px 8px rgba(20,22,26,.12);
    color-scheme: light;
  }
  .popup .app { padding: 14px 16px 12px; }
  .kbd { display: grid; gap: 12px; }
  .kbd div { display: flex; align-items: center; gap: 12px; font-size: 16px; color: #c3c9d1; }
  .kbd b {
    font: 600 14px/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
    background: #191d23; border: 1px solid #2b3138; border-radius: 7px;
    padding: 8px 10px; color: #eef0f3; white-space: nowrap;
  }
`;

function frame({ width, height, body, css = '' }) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<style>${popupCss}</style>
<style>${FRAME_CSS}${css}</style>
</head><body><div class="frame" style="width:${width}px;height:${height}px">${body}</div>
<script>${APPLY_STATE}</script></body></html>`;
}

/* ------------------------------- assets ------------------------------ */

const SHOT = { width: 1280, height: 800 };

const ASSETS = [
  {
    file: 'screenshot-1-slider.png',
    ...SHOT,
    html: frame({
      ...SHOT,
      body: `
        <div class="copy">
          <h1>One slider.<br><span class="accent">0% to 600%.</span></h1>
          <p class="sub">Drag it and the tab gets louder straight away. Nothing to set up and no account to make.</p>
        </div>
        <div class="stage">${popup({
          gain: 2.4, host: 'youtube.com', status: '3 sources boosted'
        })}</div>`
    })
  },
  {
    file: 'screenshot-2-per-site.png',
    ...SHOT,
    html: frame({
      ...SHOT,
      body: `
        <div class="copy">
          <h1>Every site<br><span class="accent">remembers.</span></h1>
          <p class="sub">Set a level once and it comes back on your next visit. Each tab keeps its own, so two tabs never fight.</p>
        </div>
        <div class="stage">${popup({
          gain: 3, host: 'podcast.example', status: '1 source boosted', light: true
        })}</div>`
    })
  },
  {
    file: 'screenshot-3-controls.png',
    ...SHOT,
    html: frame({
      ...SHOT,
      body: `
        <div class="copy">
          <h1>Presets, mute,<br><span class="accent">shortcuts.</span></h1>
          <div class="kbd">
            <div><b>Alt+Shift+Up</b> louder by 25%</div>
            <div><b>Alt+Shift+Down</b> quieter by 25%</div>
            <div><b>Alt+Shift+0</b> back to 100%</div>
            <div><b>Alt+Shift+M</b> mute</div>
          </div>
        </div>
        <div class="stage">${popup({
          gain: 5, host: 'twitch.tv', status: '2 sources boosted'
        })}</div>`
    })
  },
  {
    file: 'screenshot-4-honest.png',
    ...SHOT,
    html: frame({
      ...SHOT,
      body: `
        <div class="copy">
          <h1>Honest when it<br><span class="accent">cannot help.</span></h1>
          <p class="sub">DRM services cannot be boosted by any extension. This one says so instead of failing quietly, and you can still turn them down.</p>
        </div>
        <div class="stage">${popup({
          gain: 1, host: 'a DRM service', status: 'Protected audio',
          notice: ['Protected audio', 'This site uses DRM, so its audio cannot be routed through the booster. Lowering the volume still works.']
        })}</div>`
    })
  },
  {
    file: 'screenshot-5-privacy.png',
    ...SHOT,
    html: frame({
      ...SHOT,
      body: `
        <div class="copy">
          <h1>Nothing leaves<br><span class="accent">your device.</span></h1>
          <ul class="points">
            <li>No network requests of any kind</li>
            <li>No analytics, no ads, no account</li>
            <li>Three permissions, no access to all sites requested</li>
            <li>Open source and unminified, MIT licensed</li>
          </ul>
        </div>
        <div class="stage">${popup({
          gain: 1.5, host: 'radio.example', status: '1 source boosted'
        })}</div>`
    })
  },
  {
    // YouTube thumbnail. Sized so the hook and the percentage still read at the
    // ~210px wide the browse feed actually shows, which is the only size that
    // matters. Two colours, four words, one focal element.
    file: 'youtube-thumb-1280x720.png',
    width: 1280,
    height: 720,
    html: frame({
      width: 1280,
      height: 720,
      css: `
        /* Keep the shared flex:1 here. Pinning it to flex:none collapses the
           gap and lets the popup sit on top of the headline. */
        .copy { padding: 0 0 0 76px; max-width: 560px; }
        h1 { font-size: 106px; line-height: 0.92; letter-spacing: -0.045em; margin: 0 0 30px;
             text-shadow: 0 8px 28px rgba(0,0,0,0.6); }
        h1 .accent { color: #f59e0b; }
        .tag { display: inline-block; font-size: 23px; font-weight: 700; color: #0b0d10;
               background: #22c55e; border-radius: 999px; padding: 11px 22px;
               letter-spacing: -0.01em; }
        .stage { flex: none; padding-right: 56px; }
        .popup { border-radius: 18px;
                 box-shadow: 0 40px 90px rgba(0,0,0,0.72), 0 0 0 1px rgba(255,255,255,0.07); }`,
      body: `
        <div class="copy">
          <h1>MAKE IT<br><span class="accent">LOUDER</span></h1>
          <span class="tag">Chrome + Firefox</span>
        </div>
        <div class="stage">${popup({
          gain: 4.8, host: 'youtube.com', status: '3 sources boosted', scale: 1.78
        })}</div>`
    })
  },
  {
    file: 'promo-small-440x280.png',
    width: 440,
    height: 280,
    html: frame({
      width: 440,
      height: 280,
      css: `
        .frame { flex-direction: column; justify-content: center; text-align: center; }
        /* The shared rule gives .copy flex:1, which stretches it in a column and
           pins the stack to the top instead of centring it. */
        .copy { flex: none; padding: 0; max-width: none; }
        img.mark { width: 92px; height: 92px; border-radius: 21px; margin: 0 auto 18px; display: block;
                   box-shadow: 0 14px 30px rgba(0,0,0,0.45); }
        h1 { font-size: 33px; line-height: 1.1; margin: 0 0 9px; }
        p.sub { font-size: 16px; margin: 0 auto; max-width: none; }`,
      body: `
        <div class="copy">
          <img class="mark" src="${iconDataUri}" alt="">
          <h1>Volume Booster</h1>
          <p class="sub">Up to <span style="color:#34d76f;font-weight:600">600%</span> on one slider</p>
        </div>`
    })
  },
  {
    file: 'promo-marquee-1400x560.png',
    width: 1400,
    height: 560,
    html: frame({
      width: 1400,
      height: 560,
      css: `
        .frame { align-items: center; }
        .copy { padding-left: 110px; max-width: 760px; }
        h1 { font-size: 76px; margin: 0 0 20px; }
        p.sub { font-size: 26px; max-width: 34ch; }
        .stage { padding-right: 110px; }
        img.mark { width: 260px; height: 260px; border-radius: 58px;
                   box-shadow: 0 30px 70px rgba(0,0,0,0.55); }`,
      body: `
        <div class="copy">
          <h1>Volume <span class="accent">Booster</span></h1>
          <p class="sub">One slider, 0% to 600%, remembered for every site. No tracking.</p>
        </div>
        <div class="stage"><img class="mark" src="${iconDataUri}" alt=""></div>`
    })
  }
];

/* -------------------------------- run -------------------------------- */

const binary = findChromium();
console.log(`chromium: ${binary}`);

const child = spawn(binary, [
  '--headless',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--no-first-run',
  '--no-sandbox',
  `--user-data-dir=${path.join(os.tmpdir(), 'vb-store-art')}`,
  'about:blank'
], { stdio: 'ignore' });

let devtools;
try {
  const wsUrl = await waitForDevTools();
  devtools = await Devtools.open(wsUrl);

  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  await devtools.send('Page.enable', {}, sessionId);
  await devtools.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }]
  }, sessionId);

  fs.mkdirSync(OUT, { recursive: true });

  for (const asset of ASSETS) {
    await devtools.send('Emulation.setDeviceMetricsOverride', {
      width: asset.width,
      height: asset.height,
      deviceScaleFactor: 1,
      mobile: false
    }, sessionId);

    const loaded = devtools.once('Page.loadEventFired');
    await devtools.send('Page.navigate', {
      url: 'data:text/html;charset=utf-8;base64,' + Buffer.from(asset.html, 'utf8').toString('base64')
    }, sessionId);
    await loaded;
    // Let webfont-free system text settle before grabbing the frame.
    await new Promise((r) => setTimeout(r, 260));

    const shot = await devtools.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    }, sessionId);

    const opaque = toOpaquePng(Buffer.from(shot.data, 'base64'));
    const file = path.join(OUT, asset.file);
    fs.writeFileSync(file, opaque);
    console.log(`wrote store/${asset.file} (${asset.width}x${asset.height}, 24 bit, no alpha)`);
  }
} finally {
  if (devtools) devtools.socket.close();
  child.kill();
}
