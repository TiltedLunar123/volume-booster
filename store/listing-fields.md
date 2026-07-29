# Store listing fields

Every text field for the Chrome Web Store developer console, kept here so a
resubmission does not mean rewriting them. The description lives separately in
`listing-description.txt`.

Most of it transfers to AMO as well. AMO additionally needs the data collection
declaration, which is already in `src/manifest.firefox.json` as
`browser_specific_settings.gecko.data_collection_permissions`.

## Store listing

| Field | Value |
| --- | --- |
| Title | from package: `Volume Booster` |
| Summary | from package, 111 chars, under the 132 limit |
| Description | `listing-description.txt` |
| Category | Tools |
| Language | English (United States) |
| Official URL | none, it needs a domain verified in Search Console |
| Homepage URL | https://github.com/TiltedLunar123/volume-booster |
| Support URL | https://github.com/TiltedLunar123/volume-booster/issues |
| Mature content | no |
| Item support | on |

## Graphic assets

| Asset | Spec | Status |
| --- | --- | --- |
| Store icon | 128x128, a 96x96 tile with 16px transparent padding per side | `store-icon-128.png` |
| Screenshots | 1280x800 or 640x400, JPEG or 24-bit PNG, no alpha, full bleed, 1 to 5 | needed |
| Small promo tile | 440x280, no alpha | optional |
| Marquee promo tile | 1400x560, no alpha | optional |

The toolbar icons in `src/icons/` are full bleed and are the wrong shape for the
listing. `tools/make-icons.mjs` generates both.

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
    - DRM services (Netflix, Spotify, Prime Video, Apple Music) cannot be
      boosted. Encrypted Media Extensions audio cannot be routed through the Web
      Audio API by any extension. The popup shows "Protected audio" on these
      sites. Volume can still be lowered.
    - Sites serving audio cross-origin without an Access-Control-Allow-Origin
      header also cannot be boosted, for the same browser security reason. The
      popup shows "Boost unavailable".
    - Browser pages (chrome://, the Web Store) show a "Cannot run on this page"
      state.

    Full source, including the same unminified JavaScript in the package:
    https://github.com/TiltedLunar123/volume-booster

## Why the broad match is not avoidable

Worth having ready if a reviewer pushes back. Injecting on demand with
`activeTab` alone would mean the user has to open the popup on every page before
their saved level applied, which removes the per-site memory the extension
exists to provide. The declared content script is what makes the level apply as
the page loads.
