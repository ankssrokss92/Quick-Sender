/* content.js — runs inside https://web.whatsapp.com/*. It reads the chat list, opens chats and sends messages
   on request from the background worker. It never acts on its own. */
(function () {
  'use strict';
  if (window.__waqsLoaded) return;
  window.__waqsLoaded = true;

  /* =====================================================================================================
     SELECTORS — if WhatsApp changes its layout and something stops working, fix it HERE.
     Every entry is a list of strategies tried in order. A strategy is either
       - a CSS selector string, or
       - a function(root) that returns an element (or null).
     Rely on aria-label / role / data-* / document structure, not on generated class names.
     ===================================================================================================== */
  const lastOf = (arr) => (arr.length ? arr[arr.length - 1] : null);
  const clickable = (el) => (el ? (el.closest('button, [role="button"]') || el) : null);
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  const SEL = {
    // QR code screen (not logged in)
    qr: ['canvas[aria-label*="QR" i]', 'div[data-ref]', '[data-testid="qrcode"]'],

    // Left pane that scrolls the chat list
    chatPane: ['#pane-side', '[data-testid="chat-list"]', '[aria-label="Chat list"]'],

    // One element per chat in the list / in search results
    chatRows: [
      '#pane-side [role="listitem"]',
      '#pane-side [role="row"]',
      '#pane-side [data-testid="cell-frame-container"]',
      // structural fallback: climb from every titled span to its row
      () => Array.from(document.querySelectorAll('#pane-side span[title]')).map((s) => s.closest('[tabindex], [role]') || s.parentElement)
    ],

    // Chat name inside a row
    rowTitle: [
      (row) => row.querySelector('span[title]'),
      (row) => row.querySelector('[data-testid="cell-frame-title"]'),
      (row) => row.querySelector('span[dir="auto"]')
    ],

    // "New chat" button and its search box
    newChatButton: [
      '#side button[aria-label="New chat"]',
      '[data-testid="chat-list-new-chat"]',
      () => clickable(document.querySelector('#side span[data-icon="new-chat-outline"]')),
      () => clickable(document.querySelector('#side span[data-icon="chat"]'))
    ],
    newChatSearch: [
      '#app div[contenteditable="true"][role="textbox"][data-tab="3"]',
      '#side div[contenteditable="true"][role="textbox"]',
      '#side input[type="text"]'
    ],

    // Search box in the left pane
    searchBox: [
      '#side div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"][data-tab="3"]',
      '[data-testid="chat-list-search"]',
      '#side input[type="text"]',
      '#side input[role="textbox"]'
    ],

    // Header of the open chat, and the chat name inside it
    chatHeader: ['#main header', '[data-testid="conversation-header"]'],
    chatHeaderTitle: [
      '#main header [data-testid="conversation-info-header-chat-title"]',
      '#main header span[title]',
      '#main header span[dir="auto"]'
    ],

    // Message composer (bottom of the open chat)
    composer: [
      '#main footer div[contenteditable="true"][role="textbox"]',
      '#main footer div[contenteditable="true"]',
      'footer div[contenteditable="true"][data-tab]',
      'div[contenteditable="true"][data-tab="10"]'
    ],

    // Send button next to the composer (aria-label is localised, the icon name is not)
    sendButton: [
      '#main footer button[aria-label="Send"]',
      '#main footer [data-testid="compose-btn-send"]',
      () => clickable(document.querySelector('#main footer span[data-icon="send"]'))
    ],

    // "+" / paperclip button that opens the attach menu
    attachButton: [
      '#main footer button[aria-label="Attach"]',
      '#main footer [data-testid="clip"]',
      () => clickable(document.querySelector('#main footer span[data-icon="plus"]')),
      () => clickable(document.querySelector('#main footer span[data-icon="plus-rounded"]')),
      () => clickable(document.querySelector('#main footer span[data-icon="attach-menu-plus"]')),
      () => clickable(document.querySelector('#main footer span[data-icon="clip"]'))
    ],

    // Caption box on the attachment preview screen (anything editable that is outside the footer and the side pane)
    captionBox: [
      'div[contenteditable="true"][aria-label*="caption" i]',
      '[data-testid="media-caption-input-container"] div[contenteditable="true"]',
      () => Array.from(document.querySelectorAll('div[contenteditable="true"]'))
        .find((e) => !e.closest('footer') && !e.closest('#side') && visible(e)) || null
    ],

    // Send button on the attachment preview screen (the one that is NOT in the chat footer)
    previewSend: [
      '[data-testid="media-caption-send"]',
      () => lastOf(Array.from(document.querySelectorAll('[role="button"][aria-label="Send"], button[aria-label="Send"]'))
        .filter((e) => !e.closest('footer'))),
      () => lastOf(Array.from(document.querySelectorAll('span[data-icon="send"]'))
        .filter((e) => !e.closest('footer')).map(clickable))
    ],

    // Messages sent by me in the open chat (data-id of outgoing messages starts with "true_")
    outgoingMsgs: ['#main div[data-id^="true_"]', '#main .message-out', '#main [data-testid="msg-container"].message-out'],

    // Pop-ups / modal dialogs
    dialogs: ['[role="dialog"]', '[data-animate-modal-popup="true"]']
  };

  // The attach menu contains hidden <input type=file> elements. Media goes in the "Photos & videos" one,
  // everything else in the "Document" one.
  function pickFileInput(isMedia) {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const acc = (i) => (i.getAttribute('accept') || '').toLowerCase();
    if (isMedia) {
      return inputs.find((i) => acc(i).includes('video')) ||
             inputs.find((i) => acc(i).includes('image') && !acc(i).includes('webp')) || null;
    }
    return inputs.find((i) => ['', '*', '*/*'].includes(acc(i))) ||
           inputs.find((i) => !acc(i).includes('image') && !acc(i).includes('video')) || null;
  }

  // Phrases that identify pop-ups (English UI). Anything else is reported with its own text.
  const RX_INVALID_NUMBER = /invalid|shared via url|not on whatsapp|isn.t on whatsapp|not registered|not a whatsapp|doesn.t exist/i;
  const RX_ANOTHER_WINDOW = /open in another window|use here/i;
  // WhatsApp's 'Starting chat / Cancel' prompt can be a transient state while
  // the phone-number chat is being opened; do not classify it as a fatal dialog.
  const RX_STARTING_CHAT = /starting chat/i;
  /* ===================================== end of SELECTORS ===================================== */

  /* ---------- generic helpers ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function find(strategies, root) {
    root = root || document;
    for (const s of strategies) {
      try {
        const el = typeof s === 'string' ? root.querySelector(s) : s(root);
        if (el) return el;
      } catch (e) { /* try next strategy */ }
    }
    return null;
  }
  function findAll(strategies, root) {
    root = root || document;
    for (const s of strategies) {
      try {
        const list = typeof s === 'string' ? Array.from(root.querySelectorAll(s)) : (s(root) || []);
        if (list.length) return list;
      } catch (e) { /* try next strategy */ }
    }
    return [];
  }
  async function waitFor(fn, timeout, interval) {
    const t0 = Date.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - t0 >= (timeout || 10000)) return null;
      await sleep(interval || 150);
    }
  }
  function fireClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((t) => {
      const ev = t.startsWith('pointer') && window.PointerEvent ? new PointerEvent(t, opts) : new MouseEvent(t, opts);
      el.dispatchEvent(ev);
    });
  }
  function pressKey(el, key, keyCode, extra) {
    const o = Object.assign({ key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true }, extra || {});
    el.dispatchEvent(new KeyboardEvent('keydown', o));
    el.dispatchEvent(new KeyboardEvent('keyup', o));
  }
  const fail = (reason, extra) => Object.assign({ ok: false, reason }, extra || {});
  const pauseNow = (reason) => ({ ok: false, pause: true, reason });

  /* ---------- state of the page ---------- */
  function rowTitle(row) {
    const el = find(SEL.rowTitle, row);
    return el ? WAQS.normalizeName(el.getAttribute('title') || el.textContent) : '';
  }
  function headerTitleKey() {
    const el = find(SEL.chatHeaderTitle);
    return el ? WAQS.nameKey(el.getAttribute('title') || el.textContent) : '';
  }
  function headerMatchesPhone(phone) {
    const el = find(SEL.chatHeaderTitle);
    if (!el) return false;
    const digits = String(el.getAttribute('title') || el.textContent || '').replace(/\D/g, '');
    return digits.includes(String(phone || '').replace(/\D/g, ''));
  }
  function dialogsText() {
    return findAll(SEL.dialogs).filter(visible).map((d) => (d.innerText || '').trim()).filter(Boolean).join(' | ').slice(0, 300);
  }
  function closeDialogs() {
    findAll(SEL.dialogs).filter(visible).forEach((d) => {
      const b = d.querySelector('button, [role="button"]');
      if (b) fireClick(b);
    });
    pressKey(document.body, 'Escape', 27);
  }
  function loggedOutCheck() {
    if (find(SEL.qr)) return pauseNow('WhatsApp Web is not logged in (QR code is showing). Log in, then press Resume.');
    if (RX_ANOTHER_WINDOW.test(dialogsText())) return pauseNow('WhatsApp is open in another window. Click "Use here" in WhatsApp Web, then press Resume.');
    return null;
  }

  /* ---------- text entry ---------- */
  function isEditableInput(el) { return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'; }
  function selectAndDelete(el) {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }
  function pasteText(el, text) {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  function editorHas(el, text) {
    const have = WAQS.alnumKey(el.innerText || el.textContent || '');
    const want = WAQS.alnumKey(text);
    if (!want) return (el.innerText || el.textContent || '').trim().length > 0;
    return have.includes(want.slice(0, 30)) && have.includes(want.slice(-30));
  }

  // Puts (multi-line) text into a WhatsApp editor and verifies it is really there. Returns true/false.
  async function setEditorText(el, text) {
    selectAndDelete(el);
    await sleep(80);
    pasteText(el, text);                       // method 1: paste event keeps line breaks and registers with WhatsApp
    await sleep(200);
    if (editorHas(el, text)) return true;
    selectAndDelete(el);                       // method 2: type line by line with soft line breaks
    await sleep(80);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (i > 0 && !document.execCommand('insertLineBreak')) pressKey(el, 'Enter', 13, { shiftKey: true });
      if (lines[i]) document.execCommand('insertText', false, lines[i]);
    }
    await sleep(250);
    return editorHas(el, text);
  }

  async function setSearchText(box, text) {
    box.focus();
    if (isEditableInput(box)) {
      const proto = box.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(box, '');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      setter.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    selectAndDelete(box);
    await sleep(120);
    document.execCommand('insertText', false, text);
    await sleep(80);
    if (WAQS.nameKey(box.innerText || box.textContent) !== WAQS.nameKey(text)) { selectAndDelete(box); pasteText(box, text); }
  }
  async function clearSearch(box) {
    try {
      if (!box) return;
      if (isEditableInput(box)) { box.focus(); pressKey(box, 'Escape', 27); return; }
      selectAndDelete(box);
      pressKey(box, 'Escape', 27);
    } catch (e) { /* not critical */ }
  }

  /* ---------- chat list ---------- */
  function findScrollable(pane) {
    if (pane.scrollHeight > pane.clientHeight + 5) return pane;
    let best = null;
    pane.querySelectorAll('div').forEach((d) => {
      if (d.scrollHeight > d.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(d).overflowY)) {
        if (!best || d.clientHeight > best.clientHeight) best = d;
      }
    });
    return best || pane;
  }

  // The list is virtualised: scroll in steps, collect names as they appear, de-duplicate, restore position.
  // Always finishes: hard time cap, returns what it found, and reports progress to the side panel.
  async function getChats() {
    const pane = find(SEL.chatPane) || document.querySelector('#side');
    if (!pane) return fail('Chat list not found. Is WhatsApp Web open and logged in?');
    const scroller = findScrollable(pane);
    const startTop = scroller.scrollTop;
    const found = new Map();
    const add = (t) => {
      t = WAQS.normalizeName(t);
      if (t && !found.has(WAQS.nameKey(t))) { found.set(WAQS.nameKey(t), t); return 1; }
      return 0;
    };
    const collect = () => {
      let titled = 0, added = 0;
      findAll(SEL.chatRows).forEach((row) => {
        const t = rowTitle(row);
        if (t) { titled++; added += add(t); }
      });
      if (!titled) {   // fallback: any titled span inside the chat pane is a chat name
        pane.querySelectorAll('span[title]').forEach((s) => { added += add(s.getAttribute('title')); });
      }
      return added;
    };
    const progress = (n) => {
      try { chrome.runtime.sendMessage({ target: 'panel', type: 'chatProgress', count: n }).catch(() => {}); } catch (e) { /* panel closed */ }
    };

    const deadline = Date.now() + 60000;   // never spin forever
    let partial = false;
    try {
      scroller.scrollTop = 0;
      await sleep(400);
      let idle = 0;
      for (let i = 0; i < 800; i++) {
        if (Date.now() > deadline) { partial = true; break; }
        const added = collect();
        progress(found.size);
        const before = scroller.scrollTop;
        const atBottom = before + scroller.clientHeight >= scroller.scrollHeight - 4;
        if (added === 0) idle++; else idle = 0;
        if ((atBottom && idle >= 2) || idle >= 6) break;
        scroller.scrollTop = before + Math.max(200, Math.floor(scroller.clientHeight * 0.8));
        await sleep(220);
      }
      collect();
    } finally {
      scroller.scrollTop = startTop;
    }
    progress(found.size);
    if (!found.size) return fail('No chats found. WhatsApp may have changed its layout (see "How to fix selectors" in the README). You can still type chat names manually.');
    return { ok: true, chats: Array.from(found.values()), partial };
  }

  /* ---------- opening chats ---------- */
  function clickRow(row) {
    const target = find(SEL.rowTitle, row) || row;
    fireClick(target);
  }

  // By exact name (case-insensitive, whitespace-normalised) through WhatsApp's own search box.
  async function openChat(name) {
    const lo = loggedOutCheck();
    if (lo) return lo;
    const want = WAQS.nameKey(name);
    const box = await waitFor(() => find(SEL.searchBox), 15000);
    if (!box) return fail('WhatsApp search box not found. Is WhatsApp Web fully loaded?');
    await setSearchText(box, name);
    await sleep(900); // let the search results settle before looking at them
    const row = await waitFor(() => findAll(SEL.chatRows).find((r) => WAQS.nameKey(rowTitle(r)) === want) || null, 10000, 250);
    if (!row) { await clearSearch(box); return fail('Chat not found (no exact name match)'); }
    clickRow(row);
    const ok = await waitFor(() => headerTitleKey() === want && find(SEL.composer), 10000, 250);
    await clearSearch(box);
    if (!ok) return fail('Opened chat did not match the requested name');
    return { ok: true };
  }

  /* ---------- opening a number (saved OR unsaved) without ever reloading the page ----------
     WhatsApp Web ignores history.pushState tricks, so we use the same things a person would use:
       1. a real link click on a /send?phone= link (WhatsApp's own link handler opens the chat in-page;
          if WhatsApp does not handle it we cancel the click so the browser can NEVER navigate/reload)
       2. typing the number in the search box and clicking the "Message +91 ..." result
       3. the same through the "New chat" button
     Each strategy is verified; if it does not open the chat quickly we try the next one. */
  const digitsOf = (x) => String(x || '').replace(/\D/g, '');
  const headerSig = () => {
    const el = find(SEL.chatHeaderTitle);
    return el ? String(el.getAttribute('title') || el.textContent || '') : '';
  };

  // Returns 'OK' | 'INVALID' | 'PAUSE' | 'DIALOG' | null while waiting.
  function phoneState(phone, prevSig, t0, allowChangedHeader) {
    const lo = loggedOutCheck();
    if (lo) return { code: 'PAUSE', res: lo };
    const txt = dialogsText();
    if (txt && RX_INVALID_NUMBER.test(txt)) return { code: 'INVALID', txt };
    const comp = find(SEL.composer);
    if (comp && visible(comp) && find(SEL.chatHeader)) {
      if (headerMatchesPhone(phone)) return { code: 'OK' };
      // Saved contacts show their NAME in the header, not the number: accept a changed header when the
      // strategy itself targeted this exact number (link or exact search row).
      if (allowChangedHeader && headerSig() && headerSig() !== prevSig) return { code: 'OK' };
    }
    if (txt && !RX_STARTING_CHAT.test(txt) && Date.now() - t0 > 4000) return { code: 'DIALOG', txt };
    return null;
  }

  // Strategy 1: click a /send?phone= link. Must never navigate the tab.
  function clickPhoneLink(phone) {
    const a = document.createElement('a');
    a.href = 'https://web.whatsapp.com/send?phone=' + encodeURIComponent(phone);
    a.rel = 'noopener noreferrer';
    a.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;';
    a.textContent = 'wa';
    (document.querySelector('#app') || document.body).appendChild(a);
    // Runs after WhatsApp's own handlers (bubble phase on document). If nobody handled the click, cancel it.
    const guard = (e) => { if (e.target === a || a.contains(e.target)) e.preventDefault(); };
    document.addEventListener('click', guard, false);
    try { a.click(); } finally {
      setTimeout(() => { document.removeEventListener('click', guard, false); a.remove(); }, 1500);
    }
  }

  // Strategies 2 + 3: search by number.
  function numberRow(phone) {
    const want = digitsOf(phone);
    const rows = findAll(SEL.chatRows);
    const byTitle = rows.find((r) => { const d = digitsOf(rowTitle(r)); return d && d.endsWith(want.slice(-10)) && want.endsWith(d.slice(-10)); });
    if (byTitle) return byTitle;
    return rows.find((r) => {
      const d = digitsOf(r.innerText || '');
      return d.includes(want) && (r.innerText || '').length < 80;
    }) || null;
  }
  async function openViaSearch(phone, viaNewChat) {
    let box = null;
    if (viaNewChat) {
      const btn = find(SEL.newChatButton);
      if (!btn) return false;
      fireClick(btn);
      await sleep(600);
      box = await waitFor(() => find(SEL.newChatSearch), 4000, 200);
    } else {
      box = await waitFor(() => find(SEL.searchBox), 5000, 200);
    }
    if (!box) return false;
    const want = digitsOf(phone);
    await setSearchText(box, '+' + want);
    await sleep(1200);
    let row = await waitFor(() => numberRow(phone), 6000, 250);
    if (!row) { await setSearchText(box, want); await sleep(1200); row = await waitFor(() => numberRow(phone), 5000, 250); }
    if (!row) { await clearSearch(box); if (viaNewChat) closeOverlay(); return false; }
    clickRow(row);
    return box;
  }

  async function openPhone(phone) {
    phone = String(phone || '');
    if (!digitsOf(phone)) return fail('Invalid phone number');
    const lo0 = loggedOutCheck();
    if (lo0) return lo0;
    closeDialogs();
    const prevSig = headerSig();
    const finish = async (state, box) => {
      if (box) await clearSearch(box);
      if (state.code === 'PAUSE') return state.res;
      if (state.code === 'INVALID') { closeDialogs(); return fail('Number is not on WhatsApp (or is invalid)'); }
      if (state.code === 'DIALOG') { closeDialogs(); return fail('WhatsApp showed a pop-up: ' + state.txt.slice(0, 120)); }
      await sleep(500);
      return { ok: true };
    };

    // 1) link click
    clickPhoneLink(phone);
    let t0 = Date.now();
    let st = await waitFor(() => phoneState(phone, prevSig, t0, true), 9000, 300);
    if (st && st.code !== 'DIALOG') return finish(st, null);
    if (st && st.code === 'DIALOG') return finish(st, null);

    // 2) search box, 3) new-chat dialog
    for (const viaNewChat of [false, true]) {
      closeDialogs();
      const box = await openViaSearch(phone, viaNewChat);
      if (!box) continue;
      t0 = Date.now();
      st = await waitFor(() => phoneState(phone, prevSig, t0, true), 8000, 300);
      if (st) return finish(st, box);
      await clearSearch(box);
    }
    return fail('Could not open this number in WhatsApp Web (no message was sent, the page was not reloaded).');
  }

  /* ---------- verifying that a message really appeared ---------- */
  function snapshot() {
    const rows = findAll(SEL.outgoingMsgs);
    return { ids: new Set(rows.map((r) => r.getAttribute('data-id')).filter(Boolean)), count: rows.length };
  }
  function newOutgoing(before, text) {
    const rows = findAll(SEL.outgoingMsgs);
    let fresh = rows.filter((r) => { const id = r.getAttribute('data-id'); return id ? !before.ids.has(id) : false; });
    if (!fresh.length && rows.length > before.count) fresh = rows.slice(before.count);
    if (!fresh.length) return null;
    const key = WAQS.alnumKey(text || '').slice(0, 25);
    if (!key) return lastOf(fresh);
    return fresh.find((r) => WAQS.alnumKey(r.innerText || '').includes(key)) || null;
  }

  /* ---------- sending ---------- */
  async function clickSendOrEnter(buttonStrategies, editor) {
    const btn = await waitFor(() => find(buttonStrategies), 4000, 150);
    if (btn) { fireClick(btn); return 'button'; }
    editor.focus();
    pressKey(editor, 'Enter', 13);
    return 'enter';
  }

  async function sendTextOnly(text) {
    const composer = await waitFor(() => find(SEL.composer), 15000);
    if (!composer) return fail('Message box not found');
    const before = snapshot();
    if (!(await setEditorText(composer, text))) return fail('Could not insert the message text');
    await clickSendOrEnter(SEL.sendButton, composer);
    // Wait until the message shows up or the message box has emptied (Send worked). No error if neither can be seen.
    await waitFor(() => newOutgoing(before, text) || !(composer.innerText || '').trim(), 3000, 200);
    return { ok: true, attempted: true };
  }

  // Gives WhatsApp the file the way a person would: paste it into the message box (works for images),
  // or drop it on the chat. Both open WhatsApp's own preview screen with a caption box.
  function pasteFiles(el, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    el.focus();
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }
  function dropFiles(target, files) {
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    ['dragenter', 'dragover', 'drop'].forEach((t) => {
      target.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
  }
  const previewState = () => (find(SEL.captionBox) ? 'caption' : (find(SEL.previewSend) ? 'nocaption' : null));

  async function sendWithFile(text, file) {
    if (!fileStore || fileStore.id !== file.id || !fileStore.blob) return fail('Attachment was not received by the page');
    if (text.length > WAQS.CAPTION_MAX) return fail('Caption is longer than ' + WAQS.CAPTION_MAX + ' characters');
    const composer = await waitFor(() => find(SEL.composer), 15000);
    if (!composer) return fail('Message box not found');
    const before = snapshot();
    selectAndDelete(composer);                                  // drop any leftover draft so it does not become the caption
    const fileObj = new File([fileStore.blob], fileStore.name, { type: fileStore.type });
    const media = WAQS.isMediaType(fileStore.type);

    // Method 1: paste into the composer (no clicks). Method 2: drop on the chat. Method 3: attach menu.
    let preview = null;
    pasteFiles(composer, [fileObj]);
    preview = await waitFor(previewState, media ? 10000 : 5000, 250);
    if (!preview) {
      dropFiles(find(['#main']) || document.body, [fileObj]);
      preview = await waitFor(previewState, 6000, 250);
    }
    if (!preview) {
      const attach = find(SEL.attachButton);
      if (attach) {
        fireClick(attach);
        const input = await waitFor(() => pickFileInput(media), 6000, 200);
        if (input) {
          const dt = new DataTransfer();
          dt.items.add(fileObj);
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          preview = await waitFor(previewState, 30000, 300);
        }
      }
    }
    if (!preview) { closeOverlay(); return fail('Preview screen did not appear (file rejected, too large, or WhatsApp layout changed)'); }
    await sleep(400); // let the preview finish rendering

    const cap = find(SEL.captionBox);
    if (text) {
      if (!cap) { closeOverlay(); return fail('Caption box not found on the preview screen'); }
      if (!(await setEditorText(cap, text))) { closeOverlay(); return fail('Could not insert the caption'); }
    }
    await clickSendOrEnter(SEL.previewSend, cap || document.activeElement || document.body);

    // Give the upload time to finish before moving on: wait until the message appears, or the preview screen has closed.
    const t0 = Date.now();
    await waitFor(() => newOutgoing(before, text) || (Date.now() - t0 > 1500 && !previewState()), 25000, 300);
    await sleep(800);
    return { ok: true, attempted: true };
  }

  function closeOverlay() { pressKey(document.body, 'Escape', 27); pressKey(document, 'Escape', 27); }

  let busy = false;
  async function sendMessage(text, file) {
    if (busy) return fail('Another send is already in progress');
    busy = true;
    try {
      const lo = loggedOutCheck();
      if (lo) return lo;
      return file ? await sendWithFile(text || '', file) : await sendTextOnly(text || '');
    } finally { busy = false; }
  }

  /* ---------- attachment handed over in chunks by the background worker ---------- */
  let fileStore = null; // { id, name, type, parts, blob }
  function receiveChunk(m) {
    if (m.index === 0 || !fileStore || fileStore.id !== m.id) fileStore = { id: m.id, name: m.name, type: m.mime, parts: [], blob: null };
    const bin = atob(m.b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    fileStore.parts.push(u8);
    if (m.index === m.total - 1) { fileStore.blob = new Blob(fileStore.parts, { type: fileStore.type }); fileStore.parts = []; }
    return { ok: true };
  }

  /* ---------- messages from the background worker / side panel ---------- */
  async function handle(msg) {
    switch (msg.type) {
      case 'ping': return { ok: true };
      case 'status': return { ok: true, ready: !!find(SEL.chatPane), qr: !!find(SEL.qr) };
      case 'getChats': return getChats();
      case 'openChat': return openChat(String(msg.name || ''));
      case 'openPhone': return openPhone(String(msg.phone || ''));
      case 'hasFile': return { ok: !!(fileStore && fileStore.id === msg.id && fileStore.blob) };
      case 'fileChunk': return receiveChunk(msg);
      case 'send': return sendMessage(msg.text, msg.file);
      default: return fail('Unknown command');
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || msg.target !== 'content') return false;
    handle(msg).then(sendResponse).catch((e) => sendResponse(fail('Unexpected error: ' + ((e && e.message) || e))));
    return true;
  });
})();
