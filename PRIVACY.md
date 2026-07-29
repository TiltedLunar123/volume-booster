# Privacy policy

**Volume Booster does not collect, transmit, or sell any data.**

## What is stored

One thing: a list of website origins and the volume level you chose for each,
for example `https://www.youtube.com -> 240%`. It is kept in the browser's own
extension storage on your device, capped at 300 entries, with the oldest dropped
when the cap is reached.

Nothing else is stored. No browsing history, no page content, no audio, no
identifiers, no usage statistics.

## What is transmitted

Nothing. The extension makes no network requests. It has no server, no analytics,
no error reporting, and no remote configuration. The build fails if `fetch`,
`XMLHttpRequest`, `WebSocket`, `eval`, or `importScripts` appear anywhere in the
shipped code, so this is enforced rather than promised.

## Permissions and why

| Permission | Why |
| --- | --- |
| `storage` | Saves your level for each site so it comes back when you return. Stays on your device. |
| `activeTab` | Lets the popup see which page you are on so the level goes to the right tab. Access ends when the popup closes. |
| `scripting` | Applies the control to a tab that was already open before the extension was installed. |

The extension deliberately does **not** request the `tabs` permission, broad
`host_permissions`, or `tabCapture`.

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
