# Toros Chrome Worker extension

Load this directory as an unpacked extension in `chrome://extensions` after
enabling Developer mode. Open an allowed HTTPS site, open the extension popup,
and enter the one-time pairing code shown in Toros Cockpit.

The extension requests access to the current origin only when the operator
presses **Grant this site and pair** or **Use the current tab**. It does not read
cookies, local storage, passwords, or browser history.

It does hold Chrome's `tabs` permission, which would allow it to see the URL and title of any
open tab. The code reads only the active tab, when the popup opens, and the one paired tab; it
does not enumerate other tabs. Whether `tabs` can be narrowed to `activeTab` is an open
question, not a settled design. The raw worker token is
kept in `chrome.storage.local`; Node Core persists only its SHA-256 digest.
