# WA Quick Sender

A Chrome side panel that sends one message (with an optional file) to many WhatsApp chats through **WhatsApp Web**. One screen, no accounts, no servers: everything stays in your browser.

> **Use it responsibly.** Only message people who agreed to receive your messages. Sending many automated messages can get your WhatsApp account restricted, and automation may go against WhatsApp's terms. Use small batches.

## Before you install: connect it to your server

Only emails registered on **your** server can use the extension, and each user's daily limit is set by you in the admin portal. Set the server up first (see `wa-quick-sender-server`, file `README-SERVER.md`), then edit **`config.js`** in this folder:

```js
var WAQS_CONFIG = {
  API_BASE: 'https://your-domain.com/wa-server/api',
  REGISTER_URL: 'https://your-domain.com/wa-server/register.php'
};
```

Until `API_BASE` is set, the extension shows "The server address is not set yet" on its login screen.

## Install (Chrome 114 or newer)

1. Unzip the download into a **new folder** (for example `wa-quick-sender`) — the ZIP has `manifest.json` at its top level. Keep that folder; Chrome reads the extension from it.
2. Open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder you unzipped into (the one that contains `manifest.json`).
5. Open <https://web.whatsapp.com> and log in. If the tab was already open before you installed the extension, **reload it once (F5)**.
6. Click the green extension icon in the toolbar. The side panel opens.

## Use it in 4 steps

0. **Log in** with the email and password registered with us (no account yet? use *Request an account*; an admin must approve it).
1. **Recipients.** *Chats & Groups*: press **Load my chats**, tick the ones you want (or type exact names, one per line). *Numbers*: paste numbers (one per line or comma separated, default +91, or import a CSV).
2. **Message.** Type your text. `{name}` becomes the recipient's name when it is known (chat name, or the name column of an imported CSV). Optionally **Attach file**; your message then becomes the caption.
3. **Settings** (collapsed): the **random delay range** (default 1-20 s; every wait is a random number of seconds in that range), dark mode. The **daily limit** is shown there but set by your administrator.
4. **Start Sending.** Confirm the dialog. Keep the WhatsApp Web tab open and **don't click inside it** while it runs. Use **Pause / Resume / Stop** any time, and **Download results CSV** at the end.

## What the statuses mean

* **Sent** = the extension clicked Send and the message box / preview screen closed. It does **not** mean delivered or read, and it is not double-checked against the chat history.
* **Failed** = something could not be verified (chat not found, number not on WhatsApp, file did not attach). The reason is shown, and the next recipient continues.
* If WhatsApp Web logs out, the tab is closed, or the extension is not active in the tab, the campaign **pauses** instead of failing everyone. Fix it and press Resume.
* If the browser restarts the extension mid-send, the recipient being processed is marked Failed with "check this chat manually" (it may or may not have gone out), and the campaign pauses.

## Details worth knowing

* Numbers are opened with WhatsApp Web's in-page `/send?phone=…` route. The extension verifies the number in the chat header before sending and never reloads the WhatsApp tab.
* Names must match **exactly** (case-insensitive, extra spaces ignored). If two chats share a name, the first search result is used and the opened chat's title is verified before sending.
* Attachments: photos/videos (JPEG, PNG, GIF, WebP, MP4, 3GP, MOV) up to **16 MB** go through *Photos & videos*; everything else up to **100 MB** goes through *Document*. Captions are limited to **1024 characters**.
* The delay is a random number of seconds inside the 1-20 second range you choose. This does not make bulk sending safe: WhatsApp can still restrict accounts that send many automated messages.
* The daily limit is counted **on the server** before every message (a slot is reserved, and given back if nothing was sent). If the limit is reached, the server is unreachable, or the login is no longer valid, the campaign **pauses** and shows why.
* Sending into a chat replaces any unsent draft text in that chat's message box.
* Permissions: `storage`, `sidePanel`, and access to `web.whatsapp.com` only. The only other network traffic is to **your own server** (`API_BASE`): login, a periodic session check, and the per-message limit counter. Nothing about your recipients or message text is sent to it.

## Known limitations

* **WhatsApp changes its page layout often.** Opening chats, sending, and especially **file attaching** can break after an update. See below.
* Pop-up detection uses English wording; in another UI language a "not on WhatsApp" number is reported as a timeout or an unknown pop-up instead.
* Group vs. contact is not distinguished in the chat list; archived chats may not be listed (type their names manually).
* Large attachments are re-sent to the page after every reload (every number), which takes extra seconds.
* Keep the computer awake and the WhatsApp tab open, **ideally visible in its own window**: Chrome slows down background tabs and that can make loading chats or sending very slow.
* Images are handed to WhatsApp like a paste into the message box (then drag-and-drop, then the attach menu as fallbacks), so the preview screen opens by itself and the caption is added and sent automatically.
* **Load my chats** stops after 60 seconds and keeps what it found; type any missing names manually.

## How to fix selectors when WhatsApp changes its layout

Everything that depends on WhatsApp's page structure is in **one block at the top of `content.js`**, between the banner comments `SELECTORS` and `end of SELECTORS`. Each entry (`composer`, `sendButton`, `attachButton`, `captionBox`, `previewSend`, `chatRows`, `searchBox`, …) is a list of strategies tried in order: a CSS selector string, or a small function that returns an element.

1. Open WhatsApp Web, right-click the element that is no longer found (for example the message box) and choose **Inspect**.
2. Look for something stable: `aria-label`, `role`, `data-testid`, `data-icon`, or its position in the structure. Avoid random-looking class names.
3. Add a new strategy **at the start** of the matching list in `SELECTORS`. You can test it in the DevTools console with `document.querySelector('your selector')`.
4. On `chrome://extensions`, click the reload icon on WA Quick Sender, reload the WhatsApp tab (F5), and test with one recipient (yourself).

Quick guide to symptoms: *"Chat not found"* → `searchBox`, `chatRows`, `rowTitle`, `chatHeaderTitle`. *"Message box not found"* → `composer`. *Message not actually sent* → `sendButton`. *"File input of the attach menu not found"* → `attachButton`, `pickFileInput`. *"Preview screen did not appear"* / *"Caption box not found"* → `captionBox`, `previewSend`.

## Developer notes

```
manifest.json    Manifest V3 (side panel, content script on web.whatsapp.com)
background.js    campaign runner + persistence (chrome.storage.local), pause/resume/stop
content.js       WhatsApp Web automation, selectors at the top
shared.js        pure helpers (phone cleaning, CSV, placeholders…) shared with the tests
panel.html/css/js  the one-screen UI
icons/           generated by tools/make_icons.py
config.js        server address (edit this)
api.js           small client for the server API
tests/run-tests.js       node tests/run-tests.js        (phone cleaning, CSV, placeholders, de-dup, random delay)
tests/panel-smoke.js     node tests/panel-smoke.js      (login / logout / limit display with a fake DOM and server)
tests/background-sim.js  node tests/background-sim.js   (campaign runner with a mocked chrome API)
```
