/*
 * Renders the promo video.
 *
 * Same idea as make-store-art.mjs: the popup on screen is the real popup.html
 * markup styled by the real popup.css, laid out by Chromium. Frames are stepped
 * deterministically rather than captured in real time, so the output does not
 * depend on how fast this machine happens to be.
 *
 * Narration is Kokoro running locally. Each sentence is synthesised on its own,
 * and each scene is sized to the sentence it belongs with, so the picture and
 * the voice cannot drift apart. No timing guesswork, no manual sync.
 *
 * Run: node tools/make-promo-video.mjs
 * Out: store/volume-booster-promo.mp4
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'store');
const WORK = path.join(os.tmpdir(), 'vb-promo');
const PORT = 9334;

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const LEAD = 0.7;
const GAP = 0.5;
const TAIL = 2.0;

/* ------------------------------- script ------------------------------ */

const SCENES = [
  {
    id: 'intro',
    vo: 'Most video on the web is too quiet. Volume Booster fixes that with one slider.',
    head: ['Volume Booster'],
    sub: 'Quiet tabs, sorted.'
  },
  {
    id: 'slider',
    vo: 'Drag it and the tab gets louder, up to six hundred percent. A limiter keeps the loud end from turning into crackle.',
    head: ['One slider.', '0% to 600%.'],
    sub: 'A limiter above 100% keeps it clean.'
  },
  {
    id: 'controls',
    vo: 'Pick a preset, or nudge it from the keyboard without opening anything.',
    head: ['Presets and', 'shortcuts.'],
    sub: 'Alt and Shift with the arrow keys.'
  },
  {
    id: 'memory',
    vo: 'Set a level once and the site keeps it. Come back tomorrow and it is still there. Every tab keeps its own.',
    head: ['Every site', 'remembers.'],
    sub: 'Set it once. It comes back.'
  },
  {
    id: 'honest',
    vo: 'Some sites cannot be boosted at all. Anything using DRM is off limits to every extension, so this one says so instead of failing quietly.',
    head: ['Honest when it', 'cannot help.'],
    sub: 'You can still turn those down.'
  },
  {
    id: 'privacy',
    vo: 'Nothing leaves your device. No network requests, no analytics, no account. The whole thing is open source.',
    head: ['Nothing leaves', 'your device.'],
    sub: 'github.com/TiltedLunar123/volume-booster'
  }
];

/* ------------------------------- helpers ----------------------------- */

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function findPython() {
  const candidates = [
    path.join(os.homedir(), '.local', 'media-tools', 'Scripts', 'python.exe'),
    path.join(os.homedir(), '.local', 'media-tools', 'bin', 'python')
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error('media-tools python not found, needed for Kokoro narration');
}

function findChromium() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const roots = [
    path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright')
  ];
  const names = [
    path.join('chrome-headless-shell-win64', 'chrome-headless-shell.exe'),
    path.join('chrome-headless-shell-linux', 'chrome-headless-shell'),
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
  throw new Error('no Chromium found, set CHROME_PATH');
}

function duration(file) {
  return parseFloat(run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file
  ]).trim());
}

async function waitForDevTools(deadlineMs = 20000) {
  const started = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
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

  once(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve };
      this.waiters.push(waiter);
      setTimeout(() => {
        const at = this.waiters.indexOf(waiter);
        if (at >= 0) { this.waiters.splice(at, 1); reject(new Error(`timed out waiting for ${method}`)); }
      }, timeoutMs);
    });
  }
}

/* ----------------------------- narration ----------------------------- */

// --reuse-frames keeps the rendered frames and narration from the last run, for
// iterating on the encode without waiting out a full capture again.
const reuseFrames = process.argv.includes('--reuse-frames');

if (!reuseFrames) fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, 'frames'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const python = findPython();
console.log(reuseFrames ? 'reusing narration' : 'narrating with Kokoro');

for (const [index, scene] of SCENES.entries()) {
  const wav = path.join(WORK, `vo-${index}.wav`);
  if (!reuseFrames || !fs.existsSync(wav)) {
    run(python, [
      path.join(os.homedir(), '.local', 'media-tools', 'kokoro_tts.py'),
      '--text', scene.vo,
      '--out', wav
    ]);
  }
  scene.voDuration = duration(wav);
  console.log(`  scene ${index + 1} ${scene.id}: ${scene.voDuration.toFixed(2)}s`);
}

// Each scene lasts exactly as long as its own sentence plus the pause after it,
// which is what keeps the picture locked to the voice.
let cursor = LEAD;
for (const scene of SCENES) {
  scene.start = cursor;
  scene.end = cursor + scene.voDuration + GAP;
  cursor = scene.end;
}
SCENES[0].start = 0;
SCENES[SCENES.length - 1].end += TAIL;

const total = SCENES[SCENES.length - 1].end;
const frameCount = Math.round(total * FPS);
console.log(`timeline: ${total.toFixed(2)}s, ${frameCount} frames at ${FPS}fps`);

/* ------------------------------- page -------------------------------- */

const popupCss = fs.readFileSync(path.join(SRC, 'popup.css'), 'utf8').replace(/\bbody\s*\{/, '.popup {');
const popupMarkup = fs.readFileSync(path.join(SRC, 'popup.html'), 'utf8').match(/<main[\s\S]*<\/main>/)[0];
const iconDataUri = 'data:image/png;base64,' +
  fs.readFileSync(path.join(SRC, 'icons', 'icon-128.png')).toString('base64');

const timeline = SCENES.map((s) => ({
  id: s.id, start: s.start, end: s.end, head: s.head, sub: s.sub
}));

const page = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<style>${popupCss}</style>
<style>
  html, body { margin:0; padding:0; width:${WIDTH}px; height:${HEIGHT}px; overflow:hidden; }
  body {
    background:
      radial-gradient(1300px 900px at 74% 46%, rgba(34,197,94,0.17), transparent 62%),
      radial-gradient(1000px 700px at 6% 92%, rgba(34,197,94,0.07), transparent 60%),
      linear-gradient(160deg, #10141a 0%, #090b0e 100%);
    color:#eef0f3;
    font:16px/1.5 ui-sans-serif, system-ui, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .copy { position:absolute; left:132px; top:50%; transform:translateY(-50%); width:660px; }
  h1 { font-size:82px; line-height:1.06; letter-spacing:-0.032em; font-weight:700; margin:0 0 26px; }
  h1 .accent { color:#34d76f; }
  p.sub { font-size:27px; line-height:1.45; color:#98a0ab; margin:0; }
  .stage { position:absolute; right:150px; top:50%; transform:translateY(-50%); }
  .popup { border-radius:20px; overflow:hidden;
           box-shadow:0 46px 110px rgba(0,0,0,0.66), 0 0 0 1px rgba(255,255,255,0.06); }
  .kbd { position:absolute; left:0; top:100%; margin-top:34px; display:grid; gap:14px; }
  .kbd div { display:flex; align-items:center; gap:14px; font-size:21px; color:#c3c9d1; }
  .kbd b { font:600 17px/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
           background:#191d23; border:1px solid #2b3138; border-radius:8px; padding:10px 12px; }
  .mark { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); text-align:center; }
  .mark img { width:180px; height:180px; border-radius:40px; display:block; margin:0 auto 26px;
              box-shadow:0 26px 60px rgba(0,0,0,0.5); }
  .mark h2 { font-size:58px; margin:0 0 12px; letter-spacing:-0.03em; }
  .mark p { font-size:24px; color:#98a0ab; margin:0; }
  .cursor { position:absolute; width:26px; height:26px; pointer-events:none; }
  .cursor svg { display:block; filter: drop-shadow(0 3px 6px rgba(0,0,0,.6)); }
</style></head><body>
  <div class="copy" id="copy"><h1 id="head"></h1><p class="sub" id="sub"></p>
    <div class="kbd" id="kbd" style="opacity:0">
      <div><b>Alt+Shift+Up</b> louder by 25%</div>
      <div><b>Alt+Shift+Down</b> quieter by 25%</div>
      <div><b>Alt+Shift+0</b> back to 100%</div>
    </div>
  </div>
  <div class="stage" id="stage"><div class="popup" id="popup" style="zoom:2.5">${popupMarkup}</div>
    <div class="cursor" id="cursor" style="opacity:0">
      <svg viewBox="0 0 24 24" width="26" height="26"><path d="M5 2l14 9-6 1.2 3.2 6.3-2.6 1.3L10.5 13 5 17z"
        fill="#fff" stroke="#0b0d10" stroke-width="1.2" stroke-linejoin="round"/></svg>
    </div>
  </div>
  <div class="mark" id="mark" style="opacity:0">
    <img src="${iconDataUri}" alt=""><h2>Volume Booster</h2>
    <p>Free and open source</p>
  </div>
<script>
const SCENES = ${JSON.stringify(timeline)};
const PIVOT = 400, RAW_MAX = 1000;
const q = (s) => document.querySelector(s);
const app = q('.app'); app.classList.remove('is-booting');

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeOut = (t) => 1 - Math.pow(1 - clamp(t,0,1), 3);
const easeInOut = (t) => { t = clamp(t,0,1); return t < 0.5 ? 4*t*t*t : 1 - Math.pow(-2*t+2,3)/2; };
const lerp = (a, b, t) => a + (b - a) * clamp(t,0,1);
const gainToRaw = (g) => g <= 1 ? Math.round(g*PIVOT) : Math.round(PIVOT + ((g-1)/5)*(RAW_MAX-PIVOT));

function paint(state) {
  const raw = gainToRaw(state.gain);
  const shown = state.muted ? 0 : Math.round(state.gain * 100);
  q('#value').textContent = String(shown);
  q('#grad').style.clipPath = 'inset(0 ' + (100 - (raw/RAW_MAX)*100) + '% 0 0)';
  q('#range').value = String(raw);
  q('#host').textContent = state.host || '';
  q('#status').textContent = state.status || '';
  q('#readout').className = 'readout' +
    (state.muted ? ' is-muted' : state.gain > 5 ? ' is-max' : state.gain > 3 ? ' is-hot' : '');
  document.querySelectorAll('.presets button').forEach((b) => {
    const g = parseFloat(b.dataset.gain);
    b.setAttribute('aria-pressed', !state.muted && Math.abs(g - state.gain) < 0.005 ? 'true' : 'false');
  });
  const notice = q('#notice');
  if (state.notice) {
    notice.textContent = '';
    const strong = document.createElement('strong');
    strong.textContent = state.notice[0];
    notice.appendChild(strong);
    notice.appendChild(document.createTextNode(state.notice[1]));
    notice.hidden = false;
  } else { notice.hidden = true; }
  return raw;
}

function setCopy(scene, p) {
  // Copy slides up and fades in at the top of each scene, out at the very end.
  const inK = easeOut(p / 0.16);
  const outK = 1 - easeOut((p - 0.94) / 0.06);
  const k = Math.min(inK, p > 0.94 ? outK : 1);
  const copy = q('#copy');
  copy.style.opacity = String(k);
  copy.style.transform = 'translateY(calc(-50% + ' + ((1 - inK) * 26).toFixed(2) + 'px))';
  q('#head').innerHTML = scene.head
    .map((line, i) => i === scene.head.length - 1 && scene.head.length > 1
      ? '<span class="accent">' + line + '</span>' : line).join('<br>');
  q('#sub').textContent = scene.sub;
}

function render(t) {
  let index = 0;
  for (let i = 0; i < SCENES.length; i++) if (t >= SCENES[i].start) index = i;
  const scene = SCENES[index];
  const p = clamp((t - scene.start) / (scene.end - scene.start), 0, 1);

  setCopy(scene, p);

  const state = { gain: 1, host: 'youtube.com', status: '', muted: false, notice: null };
  let stageOpacity = 1, markOpacity = 0, cursorOpacity = 0, kbdOpacity = 0;

  if (scene.id === 'intro') {
    state.gain = 1;
    state.status = '2 sources boosted';
    stageOpacity = easeOut((p - 0.12) / 0.3);
  } else if (scene.id === 'slider') {
    // Sweep to the top of the range while the voice says six hundred, then
    // settle somewhere people would actually leave it.
    const up = easeInOut((p - 0.08) / 0.42);
    const back = easeInOut((p - 0.62) / 0.3);
    state.gain = p < 0.62 ? lerp(1, 6, up) : lerp(6, 2.4, back);
    state.status = '2 sources boosted';
    cursorOpacity = p > 0.05 && p < 0.9 ? 1 : 0;
  } else if (scene.id === 'controls') {
    const steps = [2, 3, 5];
    const step = clamp(Math.floor((p - 0.1) / 0.22), 0, 2);
    state.gain = p < 0.1 ? 2.4 : steps[step];
    state.status = '2 sources boosted';
    kbdOpacity = easeOut((p - 0.42) / 0.25);
  } else if (scene.id === 'memory') {
    state.host = p < 0.42 ? 'youtube.com' : 'podcast.example';
    state.gain = p < 0.42 ? 5 : (p < 0.55 ? 1 : 3);
    state.status = p < 0.42 ? '2 sources boosted' : '1 source boosted';
  } else if (scene.id === 'honest') {
    state.host = 'a DRM service';
    state.gain = 1;
    state.status = 'Protected audio';
    if (p > 0.3) {
      state.notice = ['Protected audio',
        'This site uses DRM, so its audio cannot be routed through the booster. Lowering the volume still works.'];
    }
  } else if (scene.id === 'privacy') {
    state.host = 'radio.example';
    state.gain = 1.5;
    state.status = '1 source boosted';
    // Hand off to the end card once the last line of narration is done. This
    // has to finish well before the scene does, or the popup and the headline
    // sit ghosting behind the end card instead of clearing out of it.
    const hand = clamp((p - 0.56) / 0.13, 0, 1);
    const fade = 1 - easeOut(hand);
    stageOpacity = hand >= 1 ? 0 : fade;
    markOpacity = easeOut((p - 0.66) / 0.12);
    q('#copy').style.opacity = String(hand >= 1 ? 0 : fade * Number(q('#copy').style.opacity));
  }

  const raw = paint(state);
  q('#stage').style.opacity = String(clamp(stageOpacity, 0, 1));
  q('#mark').style.opacity = String(clamp(markOpacity, 0, 1));
  q('#kbd').style.opacity = String(clamp(kbdOpacity, 0, 1));

  // Park the pointer on the slider thumb while it is being dragged.
  const cursor = q('#cursor');
  cursor.style.opacity = String(clamp(cursorOpacity, 0, 1));
  const track = q('.track').getBoundingClientRect();
  const stageBox = q('#stage').getBoundingClientRect();
  const x = track.left - stageBox.left + (raw / RAW_MAX) * track.width;
  const y = track.top - stageBox.top + track.height / 2;
  cursor.style.left = (x - 3) + 'px';
  cursor.style.top = (y - 2) + 'px';
}

window.render = render;
render(0);
</script></body></html>`;

fs.writeFileSync(path.join(WORK, 'promo.html'), page);

/* ------------------------------ capture ------------------------------ */

const alreadyCaptured = reuseFrames &&
  fs.readdirSync(path.join(WORK, 'frames')).filter((f) => f.endsWith('.jpg')).length === frameCount;

if (alreadyCaptured) {
  console.log(`reusing ${frameCount} captured frames`);
}

const binary = alreadyCaptured ? null : findChromium();
if (binary) console.log(`chromium: ${binary}`);

const child = alreadyCaptured ? null : spawn(binary, [
  '--headless',
  `--remote-debugging-port=${PORT}`,
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--no-first-run',
  '--no-sandbox',
  `--user-data-dir=${path.join(os.tmpdir(), 'vb-promo-profile')}`,
  'about:blank'
], { stdio: 'ignore' });

let devtools;
try {
  if (!alreadyCaptured) {
  devtools = await Devtools.open(await waitForDevTools());
  const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
  await devtools.send('Page.enable', {}, sessionId);
  await devtools.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: 'dark' }]
  }, sessionId);
  await devtools.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false
  }, sessionId);

  const loaded = devtools.once('Page.loadEventFired');
  await devtools.send('Page.navigate', {
    url: 'file:///' + path.join(WORK, 'promo.html').replace(/\\/g, '/')
  }, sessionId);
  await loaded;
  await new Promise((r) => setTimeout(r, 400));

  console.log('capturing frames');
  for (let frame = 0; frame < frameCount; frame++) {
    const t = frame / FPS;
    await devtools.send('Runtime.evaluate', {
      expression: `render(${t})`, awaitPromise: false
    }, sessionId);
    const shot = await devtools.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 96, captureBeyondViewport: false
    }, sessionId);
    fs.writeFileSync(
      path.join(WORK, 'frames', String(frame).padStart(5, '0') + '.jpg'),
      Buffer.from(shot.data, 'base64')
    );
    if (frame % 90 === 0) {
      process.stdout.write(`  ${frame}/${frameCount} (${((frame / frameCount) * 100).toFixed(0)}%)\r`);
    }
  }
  console.log(`  ${frameCount}/${frameCount} (100%)   `);
  }
} finally {
  if (devtools) devtools.socket.close();
  if (child) child.kill();
}

/* ------------------------------- encode ------------------------------ */

console.log('building the audio track');

// Must match what Kokoro actually writes, not what its docstring claims. It
// says 24 kHz mono float and emits signed 16 bit. The concat demuxer does not
// check: hand it a mismatch and it reinterprets the samples, producing audio
// that is silently the wrong length rather than an error.
const AUDIO = ['-c:a', 'pcm_s16le', '-ar', '24000', '-ac', '1'];

const silence = (seconds, file) => run('ffmpeg', [
  '-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(seconds),
  ...AUDIO, file
]);

const pieces = [];
silence(LEAD, path.join(WORK, 'lead.wav'));
pieces.push('lead.wav');
for (const [index] of SCENES.entries()) {
  pieces.push(`vo-${index}.wav`);
  const gapFile = `gap-${index}.wav`;
  silence(index === SCENES.length - 1 ? GAP + TAIL : GAP, path.join(WORK, gapFile));
  pieces.push(gapFile);
}

fs.writeFileSync(
  path.join(WORK, 'concat.txt'),
  pieces.map((p) => `file '${p}'`).join('\n')
);

run('ffmpeg', [
  '-y', '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
  ...AUDIO, 'voice.wav'
], { cwd: WORK });

// The narration has to be exactly as long as the picture, because every scene
// boundary was derived from it. Check rather than trust: a desynced promo video
// is not obvious from a log line.
const voiceDuration = duration(path.join(WORK, 'voice.wav'));
if (Math.abs(voiceDuration - total) > 0.15) {
  throw new Error(
    `narration is ${voiceDuration.toFixed(2)}s but the timeline is ${total.toFixed(2)}s. ` +
    'The concatenated pieces do not line up, so the video would be out of sync.'
  );
}
console.log(`  narration ${voiceDuration.toFixed(2)}s matches the ${total.toFixed(2)}s timeline`);

console.log('encoding');
const output = path.join(OUT, 'volume-booster-promo.mp4');
run('ffmpeg', [
  '-y',
  '-framerate', String(FPS), '-i', path.join(WORK, 'frames', '%05d.jpg'),
  '-i', path.join(WORK, 'voice.wav'),
  '-filter:a', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
  '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '192k', '-ac', '2',
  '-shortest', output
]);

const seconds = duration(output);
const size = fs.statSync(output).size / (1024 * 1024);
console.log(`\nwrote store/volume-booster-promo.mp4`);
console.log(`  ${WIDTH}x${HEIGHT}, ${FPS}fps, ${seconds.toFixed(1)}s, ${size.toFixed(1)} MB`);
