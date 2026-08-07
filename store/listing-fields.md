# Store listing fields

Every text field for the Chrome Web Store developer console, kept here so a
resubmission does not mean rewriting them. The description lives separately in
`listing-description.txt` (Chrome) and `listing-description-amo.txt` (AMO).

Most of it transfers to AMO as well. AMO additionally needs the data collection
declaration, which is already in `src/manifest.firefox.json` as
`browser_specific_settings.gecko.data_collection_permissions`.

## No third party site names in the public description

The Chrome Web Store rejected the 1.0.2 listing on 2026-07-31 for keyword spam,
citing one line: the "WHERE IT WORKS" list of "YouTube, YouTube Music, Twitch,
SoundCloud, Bandcamp, Vimeo". Naming sites the extension merely happens to work
on reads as keyword stuffing to a reviewer, however true it is, because none of
those names describe the extension itself.

So the public description names no third party service at all, and the categories
carry the meaning instead: "video sites, music and podcast players, live
streams". The DRM limitation is stated the same way, as major paid video and
music subscriptions rather than a list of four brands. The point survives, since
a reader who is subscribed to one knows they are.

The names still belong in the fields only a reviewer sees, where they are
instructions rather than metadata: the test instructions below, and
`reviewer-notes-1.0.2.txt`. Keep them there and out of the description.

The same rule covers the tag list further down, which is public metadata by any
reading and was carrying "youtube volume booster" and "twitch volume" until
1.0.4. Those two are gone. Being rejected twice for the same thing in different
fields is not a risk worth two keywords.

## Store listing

| Field | Value |
| --- | --- |
| Title | from package: `Volume Booster` |
| Summary | from package, 111 chars, under the 132 limit |
| Description | `listing-description.txt` (Chrome) and `listing-description-amo.txt` (AMO) |
| Category | Tools |
| Language | English (United States) |
| Official URL | none, it needs a domain verified in Search Console |
| Homepage URL | https://github.com/TiltedLunar123/volume-booster |
| Support URL | https://github.com/TiltedLunar123/volume-booster/issues |
| Mature content | no |
| Item support | on |

## Graphic assets

| Asset | Spec | File |
| --- | --- | --- |
| Store icon | 128x128, a 96x96 tile with 16px transparent padding per side | `store-icon-128.png` |
| Screenshot 1 | 1280x800, 24-bit RGB, no alpha | `screenshot-1-slider.png` |
| Screenshot 2 | same, shown in light theme | `screenshot-2-per-site.png` |
| Screenshot 3 | same | `screenshot-3-controls.png` |
| Screenshot 4 | same | `screenshot-4-honest.png` |
| Screenshot 5 | same | `screenshot-5-privacy.png` |
| Small promo tile | 440x280, no alpha | `promo-small-440x280.png` |
| Marquee promo tile | 1400x560, no alpha | `promo-marquee-1400x560.png` |
| Promo video | optional YouTube URL | `volume-booster-promo.mp4`, upload then paste the URL |

`tools/make-icons.mjs` draws the icons. The toolbar set in `src/icons/` is full
bleed; the listing icon needs the padded variant, and both come out of that one
script.

`tools/make-store-art.mjs` renders the screenshots and tiles by driving a
headless Chromium over the DevTools protocol. The popup inside those images is
the real `popup.html` markup styled by the real `popup.css`, so a UI change plus
a re-run keeps the listing honest. Nothing in them is a drawing of the interface.

Screenshots and tiles are written as 24-bit RGB because the store rejects an
alpha channel. The store icon keeps its alpha, which is allowed and is what
gives it transparent corners.

`tools/make-promo-video.mjs` renders the promo video, 1920x1080 at 30fps, about
44 seconds, with narration from a local Kokoro model. The mp4 is not committed
because it rebuilds from one command.

## YouTube upload

The store field wants a YouTube URL, so the video goes up there first.

**Title**

    Volume Booster: turn any tab up to 600%

**Description**

    A Chrome and Firefox extension that boosts the volume of any tab with one
    slider, up to 600%, and remembers the level for each site.

    A limiter above 100% keeps the loud end from turning to crackle. Presets,
    mute, and keyboard shortcuts are built in.

    DRM services like Netflix and Spotify cannot be boosted by any extension,
    because their audio is encrypted and browsers keep it out of the Web Audio
    API. This one tells you when it hits that instead of failing quietly.

    No tracking, no analytics, no account, and no network requests at all.
    Open source under the MIT license.

    https://github.com/TiltedLunar123/volume-booster

Set it to unlisted or public, whichever you prefer. The store accepts both.

## Privacy

**Single purpose**

    Volume Booster does one thing: it changes the playback volume of audio and
    video in the tab the user is viewing, from 0% up to 600%, and remembers the
    level chosen for each site so it is restored on the next visit.

**Host permission justification**

Chrome asks for this even though the extension does not declare
`host_permissions`, because the `<all_urls>` match on the declared content
script counts as host access. It is also why the install warning mentions all
websites.

    Volume Booster changes the volume of audio and video on the page the user is
    viewing, so it has to run on the pages where they play media. People play
    audio on arbitrary sites, so no fixed list of hosts can cover it.

    The access comes from a content script matching <all_urls>. The extension
    does not request the host_permissions key. That content script does one
    thing: find the audio and video elements in its frame and route them through
    a Web Audio gain node so the level can go above 100%. It runs at
    document_start in all frames so that a level the user already saved for a
    site is applied as the page loads, without them having to open the popup
    every time.

    It does not read, collect, or transmit page content, form input, cookies, or
    browsing history. The extension makes no network requests of any kind, so
    nothing can leave the browser.

**storage**

    Saves the volume level the user picks for each website so it is restored
    when they return. The data is a list of site origins and a number for each.
    It stays in local extension storage on the user's own device and is never
    transmitted anywhere.

**activeTab**

    The popup needs to know which tab the user is currently viewing so it can
    apply the volume level to that tab and display the level for that site.
    Access is limited to the tab the user invoked the extension on and ends when
    the popup closes.

**scripting**

    Used only to attach the volume control to a tab that was already open before
    the extension was installed or updated, so the user does not have to reload
    the page first. It injects content.js, a file that ships inside the package.
    No remote or generated code is ever executed.

**Remote code:** no.

**The tip link.** The popup footer links to https://buymeacoffee.com/judeh1l.
Both stores allow a donation link; what they do not allow is one that nags,
gates a feature, or looks like a purchase flow. This one is a single line of
plain text at the same weight as the rest of the footer, it never appears
twice, and nothing in the extension is withheld behind it. It is an `<a href>`,
so nothing is loaded from that domain unless the user clicks it, and the
extension still makes no requests of its own. That is why the data answers
below are unchanged.

**Data usage:** check **Web history** and nothing else.

Google's User Data FAQ requires disclosure "even when data is processed or
stored locally on a user's device and is not transmitted to external servers",
and it defines browsing activity as including "the domains or URLs the browser
interacts with". The stored site list is exactly that, so it gets declared even
though it never leaves the device.

| Category | Answer | Why |
| --- | --- | --- |
| Personally identifiable information | no | no names, addresses, emails, ages or IDs |
| Health information | no | none touched |
| Financial and payment information | no | none touched |
| Authentication information | no | none touched |
| Personal communications | no | none touched |
| Location | no | no GPS, no region lookup, and no network requests so no IP is ever sent |
| **Web history** | **yes** | the per-site level list is a record of origins the user set a level on, with a timestamp |
| User activity | no | no click, scroll, mouse or keystroke logging. The slider is the extension's own UI, not the page |
| Website content | no | audio is processed in real time inside the page's audio graph and never captured, retained or transmitted. The silence check derives a single boolean and stores no samples |

The line drawn between the last two rows and Web history: retained data counts
as collected, real-time processing with no retention does not. If a reviewer
disagrees on Website content, the fix is to tick it, not to change the code.

Tick all three certifications (no selling or transferring, no use unrelated to
the single purpose, no creditworthiness use).

**Privacy policy URL:**
https://github.com/TiltedLunar123/volume-booster/blob/main/PRIVACY.md

## Distribution

Public, all regions, free.

## Test instructions

    No account or login is needed. Nothing to configure.

    To test: open any page with audio or video (youtube.com works), start
    playback, click the Volume Booster icon, and drag the slider. The audio
    level changes as you drag. The toolbar badge shows the current percentage.
    Reload the page and the level you set is restored automatically.

    Expected limitations, which the popup reports rather than failing silently:
    DRM services (Netflix, Spotify, Prime Video, Apple Music) cannot be
      boosted. Encrypted Media Extensions audio cannot be routed through the Web
      Audio API by any extension. The popup shows "Protected audio" on these
      sites. Volume can still be lowered.
    Sites serving audio cross-origin without an Access-Control-Allow-Origin
      header also cannot be boosted, for the same browser security reason. The
      popup shows "Boost unavailable".
    Browser pages (chrome://, the Web Store) show a "Cannot run on this page"
      state.

    Full source, including the same unminified JavaScript in the package:
    https://github.com/TiltedLunar123/volume-booster

## Why the broad match is not avoidable

Worth having ready if a reviewer pushes back. Injecting on demand with
`activeTab` alone would mean the user has to open the popup on every page before
their saved level applied, which removes the per-site memory the extension
exists to provide. The declared content script is what makes the level apply as
the page loads.

**Tags** (344 of the 500 character allowance)

    volume booster,chrome extension,volume booster extension,increase volume chrome,boost volume browser,sound booster,volume amplifier,firefox addon,browser extension,volume control,audio boost,make video louder,quiet video fix,louder video player,stream volume boost,web audio api,open source extension,manifest v3,privacy extension,chrome web store

**Thumbnail:** `youtube-thumb-1280x720.png`, rendered by
`tools/make-store-art.mjs` alongside the store images. 1280x720, 24-bit RGB,
about 217 KB against YouTube's 2 MB limit.

Hook is MAKE IT / LOUDER, white over amber, with the real popup at 480% on the
right so the readout and the warmed slider carry the colour. Checked at 210px
wide, the size the browse feed actually renders: the hook and the percentage
both still read, and everything else drops to texture, which is the intent.

---

# AMO (addons.mozilla.org) submission

Fields differ enough from the Chrome console to be worth recording separately.
The description, privacy policy and reviewer notes are pasted as text on AMO,
not linked.

| Field | Value |
| --- | --- |
| Name | Volume Booster |
| Slug | `volume-booster-slider`. Plain `volume-booster` is taken, as are `volume-booster-600` and `tab-volume-booster` |
| Summary | prefilled from the manifest, 111 chars against a 250 limit |
| Experimental | no |
| Requires payment or hardware | no |
| Categories | Photos, Music & Videos, and nothing else |
| Support email | blank, it would be published |
| Support website | https://github.com/TiltedLunar123/volume-booster/issues |
| License | MIT |
| Has a privacy policy | yes, paste the text |

The slug keeps the exact phrase "volume booster" at the front, since that is
what people search, and differentiates on the actual feature. It does not affect
the add-on name, which stays Volume Booster in search results and the install
prompt. Also free when checked on 2026-07-29: one-slider-volume-booster,
simple-volume-booster, volume-boost-slider, volume-booster-tab,
volume-slider-booster, boost-tab-volume.

Only one category genuinely fits. Tabs means tab management and Privacy &
Security describes how it behaves rather than what it does, so filling all three
slots would be category padding.

The description is the Chrome copy with the Firefox differences applied:
`about:` pages instead of `chrome://`, and Firefox named as the thing enforcing
the CORS rule. AMO wants the most important points inside the first 250
characters, which the opening paragraph covers.

The privacy policy text is PRIVACY.md flattened to plain text.

## Reviewer notes

The paragraph that matters is the one about source code. AMO flags submissions
that look built, and this one is not: the package is byte-identical to `src/`
with the manifest renamed, `tools/build.mjs` only copies and zips, and nothing
is minified or transpiled. Saying so up front avoids a round trip asking for
sources.

Also worth stating for a reviewer: both unboostable cases (DRM and
cross-origin-without-CORS) are checked before `createMediaElementSource`, not
after, because that node outputs silence rather than throwing and its routing is
permanent. A reviewer seeing the guard might otherwise read it as unnecessary.

## Screenshots

The five 1280x800 PNGs already in `store/` upload as they are. AMO has no fixed
dimensions and accepts alpha, so nothing needs re-exporting.
