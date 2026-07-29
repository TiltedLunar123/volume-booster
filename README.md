# Volume Booster

Boost any tab's volume up to 600% with one slider. Works in Chrome and Firefox.
No accounts, no tracking, no network calls, no build step.

```
  Volume Booster                    youtube.com

                   240%

  [==============================o-------------]
                  |100%
  [ 100 ][ 150 ][ 200 ][ 300 ][ 500 ]
  [ Mute ]                    3 sources boosted
  Remember levels  (o)               Reset all
```

## What it does

- **0% to 600%** on a single slider, with a detent at 100% so normal is easy to
  find again. It reduces as well as boosts.
- **Remembers the level per site.** Come back to a site, get your level back.
- **A limiter above 100%**, so high gain gets louder instead of turning to
  crackle.
- **Presets and mute**, plus keyboard shortcuts.
- **Per tab.** Two tabs on the same site keep their own levels.
- **Tells you when it cannot help** instead of silently doing nothing.

## Install

Not on the Chrome Web Store or AMO yet. To run it now:

```bash
node tools/build.mjs
```

That writes `dist/chrome/` and `dist/firefox/` plus a zip of each.

**Chrome, Edge, Brave, Opera**

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked**, choose `dist/chrome`

**Firefox**

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on**, choose `dist/firefox/manifest.json`

Firefox unloads temporary add-ons when it restarts. Signing through AMO is what
makes it permanent.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Alt+Shift+Up` | Up 25% |
| `Alt+Shift+Down` | Down 25% |
| `Alt+Shift+0` | Back to 100% |
| `Alt+Shift+M` | Mute or unmute |

Rebind them at `chrome://extensions/shortcuts`.

## Where it works, and where it does not

It boosts anything the browser will let it route through Web Audio, which covers
most of the web: YouTube, YouTube Music, Twitch, SoundCloud, Bandcamp, Vimeo,
podcast players, and ordinary `<audio>` and `<video>` tags. Same-origin and
cross-origin iframes both work, because each frame boosts its own audio.

Two things cannot be boosted by any extension using this approach, and the popup
says so when it hits them:

**DRM-protected services.** Netflix, Spotify, Amazon Prime Video, Apple Music
and anything else using Encrypted Media Extensions. Protected audio is not
allowed to enter Web Audio at all. Any extension claiming to boost Netflix is
either capturing the whole tab a different way or not telling the truth.

**Audio served from another domain without CORS headers.** If a site streams
from a CDN that does not send `Access-Control-Allow-Origin`, the browser refuses
to expose those samples. Attaching anyway would produce silence rather than an
error, so the extension checks first and leaves the audio alone.

In both cases you can still turn the volume **down**, which does not need Web
Audio. Boosting above 100% is what is unavailable.

Also unavailable: browser pages like `chrome://` and `about:`, the extension
stores, and the built-in PDF viewer. Browsers block extensions there.

### One case it cannot prevent, only report

If a site serves audio from a same-origin URL that redirects to another domain,
nothing in the page reveals that until the audio is already routed, at which
point it goes silent permanently. The extension watches for a connected element
that produces digital silence while playing and tells you to reload. It is rare,
and reloading always fixes it.

## Privacy

The extension makes no network requests of any kind. There is no analytics, no
remote config, no remote code, and nothing is ever sent anywhere. The only thing
stored is a list of sites and the level you picked for each, in the browser's own
extension storage, capped at 300 entries. **Reset all** in the popup erases it.

The build has a check that fails if `fetch`, `XMLHttpRequest`, `WebSocket`,
`eval`, or `importScripts` ever appear in the shipped code, so this stays true.

See [PRIVACY.md](PRIVACY.md).

## How it works

Each frame runs a content script that finds media elements and routes them
through `MediaElementSource -> GainNode -> DynamicsCompressor -> destination`.
The content script opens a port to the background, which owns the toolbar badge
and per-site storage and pushes levels back down that port.

The one rule the design is built around: `createMediaElementSource()`
permanently reroutes an element, and if the audio is not allowed through Web
Audio the result is silence with no exception thrown. So elements are classified
before being connected, never after, and an element at exactly 100% is never
touched at all.

Full reasoning, including what was wrong in the first draft of the plan, is in
[PLAN.md](PLAN.md).

## Development

```bash
node tools/make-icons.mjs   # regenerate the png icons from code
node tools/build.mjs --check # syntax, manifests, and the no-network check
node test/unit.mjs           # 59 tests over classification, mapping, and state
node tools/build.mjs         # build dist/ and the zips
```

There is no `package.json` and no dependencies. Node is used only to draw the
icons and write the zips; the extension itself is the plain JS in `src/`.

`test/fixtures/media.html` is a manual test page that generates its own audio, so
it works offline. It covers dynamically added elements, elements never added to
the DOM, open shadow roots, iframes, and the cross-origin case.

```
src/          the extension, shipped as-is
tools/        icon renderer, zip writer, packager
test/         unit tests and the manual fixture
PLAN.md       architecture and the decisions behind it
```

## License

MIT. See [LICENSE](LICENSE).
