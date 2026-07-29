# Volume Booster: build plan

Cross-browser (Chrome MV3 + Firefox MV3) volume booster. Zero build step for the
extension itself, plain HTML/CSS/JS, no runtime dependencies, no network calls.

The first draft of this plan was produced by Grok 4.5 (xAI) as a second opinion,
then reviewed and revised. The revisions are listed in "Changes from the draft"
at the bottom, because two of them are correctness issues rather than taste.

---

## A. Architecture

### Decision: content script + Web Audio graph. Not `tabCapture`.

```
<video> / <audio>
  -> MediaElementAudioSourceNode
  -> GainNode            (0.0 to 6.0)
  -> DynamicsCompressor  (limiter, only in-chain above 1.0)
  -> AudioContext.destination
```

`chrome.tabCapture` is rejected: Firefox has no equivalent, it needs a user
gesture, and in MV3 it needs an offscreen document because a service worker has
no `AudioContext`. One architecture that works in both browsers beats two.

### Trade-off accepted

`createMediaElementSource()` permanently reroutes an element's audio. There is no
way to undo it. So the rule is: **never connect an element unless we are certain
the graph will carry sound.** Connecting the wrong element makes the page silent
with no recovery short of a reload. Two cases must be excluded *before* connecting:

| Case | Detection | Behaviour if connected anyway |
| --- | --- | --- |
| CORS-cross-origin media | compare `currentSrc` origin to `location.origin` | node outputs **zeroes**, page goes silent, no exception thrown |
| EME / DRM media | `el.mediaKeys != null` | protected audio cannot enter Web Audio |

This is why the code pre-classifies every element instead of wrapping
`createMediaElementSource` in a `try/catch` and hoping.

### What works and what does not

| Target | Boost above 100% | Note |
| --- | --- | --- |
| YouTube, YouTube Music | yes | MSE `blob:` source, same-origin |
| Twitch | yes | MSE |
| SoundCloud, Bandcamp | yes | MSE, progressive falls back if the CDN sends no CORS header |
| Vimeo, generic `<video>`/`<audio>` | yes | |
| Same-origin iframes | yes | `all_frames: true`, each frame runs its own graph |
| Cross-origin iframes | yes | the iframe gets its own content script and boosts itself |
| Cross-origin media, no CORS header | no | reduce-only fallback via `el.volume` |
| Netflix, Spotify, Prime Video, Apple Music (EME) | no | reduce-only fallback via `el.volume` |
| `chrome://`, `about:`, Web Store, AMO, PDF viewer | no | popup shows an explicit "cannot run here" state |

Where boost is impossible we still support 0 to 100% by driving `el.volume`, and
the popup says so rather than pretending it worked.

### Messaging: ports, opened by the content script

The content script calls `runtime.connect()` on load. Everything the background
pushes travels back down that port.

This matters for three reasons:

1. A port opened by the content script needs **no host permission**, so the
   extension ships without `host_permissions` at all.
2. Every frame has its own port, so "apply to all frames" and "count media
   across all frames" are both trivial. `tabs.sendMessage` frame semantics are
   ambiguous enough that the draft plan argued with itself about them mid-table.
3. The content script announces `location.origin` on connect, so restoring a
   saved level after navigation is race-free. No `tabs.onUpdated`, no polling.

```
popup  --runtime.sendMessage-->  background  --port.postMessage-->  content (per frame)
popup  <--------reply----------  background  <----port.postMessage--  content (status)
```

The content script is the source of truth for live audio state. The background
holds a rebuildable `Map` for the badge, and owns all storage writes.

### Permissions

```json
"permissions": ["storage", "activeTab", "scripting"]
```

No `host_permissions`. No `tabs`. No `tabCapture`. No `webNavigation`.

- `storage`: per-site level memory.
- `activeTab`: lets the popup read the current tab's URL and lets `scripting`
  inject into a page that was already open when the extension was installed.
  Granted by opening the popup or by pressing a keyboard shortcut.
- `scripting`: the late-injection fallback only.

Declared `content_scripts` run from their `matches` and do not need a matching
`host_permissions` entry.

---

## B. File tree

```
volume-booster/
  src/
    manifest.chrome.json   Chrome MV3: background.service_worker
    manifest.firefox.json  Firefox MV3: background.scripts + gecko id
    background.js          ports, badge, storage, keyboard commands
    content.js             media discovery, classification, audio graph
    popup.html             popup markup
    popup.css              popup styling, light and dark
    popup.js               slider mapping, optimistic render, messaging
    icons/                 16/32/48/128 png, generated
  tools/
    make-icons.mjs         renders the png icons from code
    zip.mjs                dependency-free zip writer
    build.mjs              produces dist/chrome, dist/firefox and both zips
  test/fixtures/media.html manual test page, generates its own audio
  .github/workflows/ci.yml syntax check, manifest validation, builds artifacts
```

Node is used only to build icons and zips. The extension itself is plain JS.

---

## C. Implementation notes

### content.js (isolated world, every frame)

State: `desired` (linear gain), `muted`, one `AudioContext` per frame, a `Set` of
tracked elements, a `WeakMap` element -> graph, a `WeakSet` of failed elements.

| Function | Role |
| --- | --- |
| `classify(el)` | `ok` / `protected` / `tainted` / `pending`. Runs before every connect. |
| `connect(el)` | Builds source -> gain -> compressor -> destination once. Guarded by the WeakMap so it is never called twice on one element. |
| `setLimiter(entry, on)` | Routes gain through the compressor only above 1.0, so 100% is bit-identical to no extension. |
| `apply()` | Ramps every gain with `setTargetAtTime` to avoid zipper noise. |
| `fallbackVolume(el, g)` | For `protected` / `tainted`: drives `el.volume` for 0 to 100%, remembers and restores the original value. |
| `scan(deep)` | `querySelectorAll('audio,video')`, plus a walk into open shadow roots every fourth sweep. |
| `track(el)` | Adds to the tracked set and applies. |

Discovery is three overlapping mechanisms, because no single one is enough:

1. Capture-phase `play`, `playing`, `loadedmetadata`, `canplay`, `loadstart`
   listeners on `document`. Capture fires for non-bubbling media events.
2. `MutationObserver` on `documentElement`, debounced, for SPA navigation.
3. A 2.5s sweep as a backstop, with the shadow-root walk on every fourth pass.

`AudioContext` is created lazily and only when the level is not 100%. At exactly
100% with no prior connection the extension touches nothing at all.

### Autoplay policy

A click in the popup is not a user gesture in the page, and no message can carry
one across. So: create the context lazily, call `resume()` on every incoming
command and on every captured `play`/`playing` event, set the gain value
regardless (it takes effect when the context starts), and report
`ctx.state === 'suspended'` up to the popup so it can say "press play on the page".
In practice the page has already played audio by the time anyone opens a volume
booster, so the context starts in `running`.

### background.js (classic script: works as a Chrome SW and a Firefox event page)

`tabState: Map<tabId, {gain, muted, origin, ports}>`. Rebuilt automatically when
a killed service worker restarts, because every content script reconnects its
port and re-announces its origin.

Storage: `{ sites: { "<origin>": {g, m, t} }, opts: {remember, limiter} }`, capped
at 300 origins, evicting the oldest `t`.

Badge: `action.setBadgeText({tabId, text})`, which needs no `tabs` permission.
Blank at 100%, `MUTE` when muted, otherwise `250%`. The colour warms from indigo
to amber to red as the level climbs.

Commands: `Alt+Shift+Up` / `Down` nudge by 25%, `Alt+Shift+0` resets,
`Alt+Shift+M` toggles mute. Invoking a command grants `activeTab`.

### popup.js

Two requests fire in parallel on open: `storage.local` for the last known level
(painted immediately) and the background for authoritative state (repaints).
There is no spinner and no flash of 100%.

The slider is piecewise so the useful range is not squashed into a sixth of the
track:

- raw 0 to 400 maps to 0 to 100%
- raw 400 to 1000 maps to 100 to 600%

with a magnetic detent at exactly 100%. Messages to the background are throttled
to one animation frame while dragging; the readout updates 1:1.

---

## D. Manifest strategy

Two manifests, one shared source tree, one Node script that assembles
`dist/chrome/` and `dist/firefox/` and zips both. A single manifest cannot
express Chrome's `background.service_worker` and Firefox's `background.scripts`
without shipping keys that one of the two browsers will warn about, and store
reviewers do notice.

Differences, and only these:

| Key | Chrome | Firefox |
| --- | --- | --- |
| `background` | `{"service_worker": "background.js"}` | `{"scripts": ["background.js"]}` |
| `browser_specific_settings` | absent | `{"gecko": {"id": "...", "strict_min_version": "115.0"}}` |

Everything else is byte-identical. Both use `action` (not `browser_action`);
MV3 uses `action` in Firefox too.

Code targets `browser` when present and falls back to `chrome`, so the same
files run unmodified in both browsers with promise-based APIs everywhere.

---

## E. UI

320px wide. One screen, no scrolling, no tabs, no settings page.

```
Volume Booster                      youtube.com
                240%
  [========================o------------------]
                 |100%
  [ 100% ][ 150% ][ 200% ][ 300% ][ 500% ]
  [ Mute ]                     3 boosted
  Remember for this site  (o )    Reset all
```

Tokens, dark (default) then light:

Neutral greys plus a level-meter ramp. No blue or violet anywhere: the colour is
carrying meaning, so it runs green at normal and warms as the gain is pushed.

| Token | Dark | Light |
| --- | --- | --- |
| `--bg` | `#0e1013` | `#ffffff` |
| `--surface` | `#17191e` | `#f6f7f8` |
| `--surface-2` | `#202329` | `#eceef1` |
| `--line` | `#2b2f36` | `#e1e4e8` |
| `--text` | `#eef0f3` | `#14161a` |
| `--dim` | `#8d939c` | `#5f6570` |
| `--accent` | `#22c55e` | `#16a34a` |
| `--hot` | `#f59e0b` | `#d97706` |
| `--danger` | `#ef4444` | `#dc2626` |

The slider fill is one gradient anchored to the full track and revealed with
`clip-path`, so the colour under the thumb encodes the level: flat green up to
the 100% detent at 40%, then amber through red across the boost range. The badge
and the icon use the same ramp. Readout is 46px, 700 weight, tabular numerals so
it does not jitter while dragging.

Accessibility: the slider is a real `<input type="range">` so arrows and
Home/End work. Presets are buttons with `aria-pressed`. Mute is a toggle with
`aria-pressed`. Focus rings are 2px at 2px offset. Transitions are dropped under
`prefers-reduced-motion`.

---

## F. Gotchas

| # | Issue | Handling |
| --- | --- | --- |
| 1 | CORS-cross-origin media outputs zeroes, silently | classify before connecting, never connect a tainted element |
| 2 | EME/DRM audio cannot enter Web Audio | `el.mediaKeys` check, reduce-only fallback |
| 3 | `createMediaElementSource` twice throws `InvalidStateError` | WeakMap guard plus a WeakSet of permanently failed elements |
| 4 | Rerouting is permanent | only connect when the level is not 100% |
| 5 | Same-origin URL that redirects cross-origin | unpreventable and undetectable up front, so an AnalyserNode tap watches for a playing element producing digital silence and the popup says to reload |
| 6 | `new Audio()` never appended to the DOM | capture-phase `play` on `document` catches it |
| 7 | Media inside an open shadow root | shadow-root walk on every fourth sweep |
| 8 | Page's own volume slider | never write `el.volume` on the Web Audio path; effective level is `el.volume * gain` |
| 9 | Zipper noise when dragging | `setTargetAtTime` with a 20ms constant |
| 10 | Clipping at high gain | compressor at -3dB, ratio 20, 3ms attack, in-chain only above 1.0 |
| 11 | AudioContext leak | one context per frame, closed on `pagehide` only when the page is really leaving (`persisted === false`) |
| 12 | Service worker eviction | ports reconnect and re-announce, state rebuilds itself |
| 16 | Back/forward cache | the port is closed on `pagehide` and reopened on a `persisted` `pageshow`; the context is deliberately kept, because a cached page comes back with its graph wired to elements that can never be routed again |
| 13 | Extension installed while pages are open | `scripting.executeScript` fallback on popup open |
| 14 | Two tabs on one origin | per-tab level is live and independent, per-origin value is the default for new loads |
| 15 | Detached elements held forever | sweep prunes elements that are disconnected and paused |

Note on 10: at 600% a loud source will not sound six times louder, because the
limiter is doing its job. That is correct behaviour, not a bug.

---

## G. Tests

`node tools/build.mjs --check` runs `node --check` on every JS file and validates
both manifests as JSON with the required keys present. That runs in CI.

`node test/unit.mjs` covers the pure logic and the port state machine.

`node test/e2e.mjs` drives a real browser over the DevTools protocol: it loads
the built extension into a throwaway profile with nothing else in it, boosts a
page, navigates away and back, and asserts the audio graph survived the
back/forward cache and the worker console stayed clean. It needs Edge, because
branded Chrome ignores `--load-extension`, so it is not part of CI. Anything
below that it covers is worth trusting to it rather than repeating by hand.

Manual matrix, both browsers:

| Scenario | Expect |
| --- | --- |
| `test/fixtures/media.html` | all controls work, page generates its own audio so no assets needed |
| YouTube, drag while playing | smooth, no crackle at the top of the range |
| YouTube, navigate to next video | level persists |
| Twitch, SoundCloud, Vimeo | boost works |
| Netflix or Spotify | popup says protected, audio still plays, 0 to 100% still works |
| Cross-origin iframe embed | the iframe boosts itself |
| `chrome://extensions`, `about:addons` | popup shows the cannot-run state |
| Reload after setting 300% | level restored |
| 301st origin | oldest evicted |
| Keyboard only | tab to slider, arrows, Home/End, Enter on presets |
| `Alt+Shift+Up`/`Down`/`0`/`M` | nudge, reset, mute |
| OS light and dark | both themes correct |

---

## H. Store listing

Rejection risks for this category, and the response:

- **Broad host access.** Sidestepped: this ships with no `host_permissions`.
- **Claiming DRM sites work.** The listing states plainly that they do not.
- **Remote code.** None. No `fetch`, no `XMLHttpRequest`, no CDN, no `eval`.
- **Unnecessary permissions.** Three, each justified below.
- **Single purpose.** Adjust tab volume. Nothing else is in the extension.

Justification strings:

- `storage`: "Stores your preferred volume level for each website so it is
  restored when you return. Everything stays on your device."
- `activeTab`: "Lets the popup see which page you are on so it can apply the
  volume level to that tab. Access ends when you close the popup."
- `scripting`: "Applies the volume control to a tab that was already open before
  the extension was installed."
- Data collection: none.

---

## Changes from the Grok draft

Kept: the content-script Web Audio architecture and the reasoning for rejecting
`tabCapture`, the two-manifest packaging decision, per-origin storage with an
eviction cap, the badge-from-background requirement, the layered discovery
strategy, and the store-listing risk analysis.

Changed:

1. **CORS behaviour was wrong and the fix was unsafe.** The draft said
   `createMediaElementSource` "throws `InvalidStateError` / SecurityError on
   CORS-tainted elements" and to catch it. It does not throw. Per the Web Audio
   spec the node outputs silence, and Chrome logs
   `MediaElementAudioSource outputs zeroes due to CORS access restrictions`.
   Following the draft would have silently muted any site serving media from a
   CDN without a CORS header, permanently, with a `catch` block that never ran.
   Replaced with pre-flight classification.
2. **EME was never checked.** The draft detected DRM by noticing zero elements
   after the fact. Added an explicit `el.mediaKeys` guard, same failure mode as
   above.
3. **Messaging.** The draft's `tabs.sendMessage` frame-delivery table contradicts
   itself twice in one cell and needed `host_permissions: ["<all_urls>"]`.
   Replaced with content-script-initiated ports, which removed
   `host_permissions` entirely and made cross-frame status aggregation trivial.
4. **Compressor settings.** `-24dB / ratio 12 / knee 30` is a mix-bus compressor
   and pumps audibly on music. Changed to `-3dB / ratio 20 / knee 0 / 3ms` and
   bypassed below 1.0.
5. **Slider range.** The draft's `min=100` makes the extension boost-only.
   Changed to 0 to 600% with a piecewise mapping and a detent at 100%, so it also
   works as a volume reducer, which is what the fallback path needs anyway.
6. **API namespace.** The draft committed to `chrome.*` only. Firefox's `chrome`
   alias is callback-based; `browser` is not. Added a two-line shim.
7. **Packaging.** Two shell scripts became one cross-platform Node script with a
   dependency-free zip writer, plus generated icons, so there is nothing binary
   checked into the repo that cannot be rebuilt.

Added: keyboard shortcuts, the reduce-only fallback for protected media, the
shadow-root walk, gain ramping, the per-site remember toggle, silence detection
for the redirect case, generated icons, a unit suite that extracts the real
functions from the shipped source, and CI.

One thing the draft got right that is worth keeping visible: rejecting
`tabCapture` costs the ability to boost DRM audio, and no amount of cleverness in
this architecture buys it back. That limitation is stated in the popup, the
README, and the store listing rather than glossed over.
