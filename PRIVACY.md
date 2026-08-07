# Privacy policy

**Nothing leaves your device. Volume Booster transmits no data, sells no data,
and shares no data with anyone.**

## What is stored

One thing: a list of website origins and the volume level you chose for each,
for example `https://www.youtube.com -> 240%`, along with a timestamp used to
drop the oldest entry once 300 sites are stored. It is kept in the browser's own
extension storage on your device.

Nothing else is stored. No page content, no audio, no identifiers, no usage
statistics, no clicks or keystrokes.

Because that list records which sites you set a level on, Chrome's disclosure
categories classify it as browsing activity, and it is declared as such on the
Chrome Web Store listing. It is worth being precise about what that does and
does not mean here: the list only ever contains sites where you deliberately
changed the volume, it never leaves your device, and nothing reads it except
this extension. Sites you visit without touching the slider are never recorded.

## What is transmitted

Nothing. The extension makes no network requests. It has no server, no analytics,
no error reporting, and no remote configuration. The build fails if `fetch`,
`XMLHttpRequest`, `WebSocket`, `eval`, or `importScripts` appear anywhere in the
shipped code, so this is enforced rather than promised.

The popup footer carries one ordinary link, to a tip page. Clicking it opens
that site in a new tab exactly as a link on any page would, and nothing about
you, your settings or your stored levels goes with it. Nothing is loaded from
there unless you click it, so leaving it alone costs nothing.

## Permissions and why

| Permission | Why |
| --- | --- |
| `storage` | Saves your level for each site so it comes back when you return. Stays on your device. |
| `activeTab` | Lets the popup see which page you are on so the level goes to the right tab. Access ends when the popup closes. |
| `scripting` | Applies the control to a tab that was already open before the extension was installed. |
| a content script on every site | Reaches the audio, which is on the page rather than in the extension. It looks for audio and video elements and changes how loud they are. |

The extension deliberately does **not** request the `tabs` permission,
`host_permissions`, or `tabCapture`.

That last row is the one worth being straight about, because it is what the
install prompt is describing when it says the extension can read and change
your data on every website. Running on every page is what makes a volume
slider work anywhere, and there is no narrower way to ask for it. What the
script does with that reach is bounded by the rest of this page: it reads no
page content, and it has no way to send anything anywhere.

The Firefox build declares this in the manifest itself, as
`browser_specific_settings.gecko.data_collection_permissions.required` set to
`["none"]`, which is what Firefox shows users on the install prompt. The build
fails if that value ever stops saying `none` while this page claims otherwise.

## Deleting your data

**Reset all** in the popup erases every stored site level. Removing the
extension deletes its storage entirely.

## Contact

Open an issue at
<https://github.com/TiltedLunar123/volume-booster/issues>.
