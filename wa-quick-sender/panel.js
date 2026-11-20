/* panel.js — the one-screen UI. It never sends anything itself: it prepares the list, asks background.js to run
   the campaign, and renders the "campaign" state that background.js keeps in chrome.storage.local. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let settings = { delayMin: WAQS.MIN_DELAY, delayMax: WAQS.MAX_DELAY, theme: null, cc: '91' };
  let auth = null; // { token, email, name, daily_cap, used_today, expires_at } after login
  let draft = { tab: 'chats', message: '', numbersText: '', manualNames: '', selected: [], chats: [], names: {}, file: null };
  let campaign = null;
  let chatFilter = '';
  let previewUrl = null;
  let runRows = new Map();
  let runRowsFor = null;
  let loadLabel = null;

  /* ---------- tiny DOM helper (no innerHTML anywhere: all user text goes through textContent) ---------- */
  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'checked') e.checked = !!v;
        else if (v === true) e.setAttribute(k, '');
        else e.setAttribute(k, v);
      }
    }
    kids.flat().forEach((c) => { if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c))); });
    return e;
  }

  function toast(msg, kind) {
    const t = h('div', { class: 'toast ' + (kind || ''), text: msg });
    $('toasts').append(t);
    setTimeout(() => t.remove(), kind === 'err' ? 6000 : 3500);
  }

  /* ---------- persistence ---------- */
  let saveTimer = null;
  function saveDraft() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => chrome.storage.local.set({ draft }).catch(() => {}), 250);
  }
  function saveSettings() { chrome.storage.local.set({ settings }).catch(() => {}); }

  /* IndexedDB: the attachment lives here so it survives panel and service-worker restarts. */
  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open('waqs', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('files');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idb(mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => { db.close(); resolve(req && req.result); };
      tx.onerror = () => { db.close(); reject(tx.error); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    });
  }
  const idbPut = (k, v) => idb('readwrite', (s) => s.put(v, k));
  const idbGet = (k) => idb('readonly', (s) => s.get(k));
  const idbDel = (k) => idb('readwrite', (s) => s.delete(k));

  /* ---------- talking to the WhatsApp tab ---------- */
  async function waCmd(msg, timeoutMs) {
    const tabs = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
    const tab = tabs.find((t) => t.active) || tabs[0];
    if (!tab) throw new Error('Open web.whatsapp.com in a tab and log in first.');
    let timer;
    try {
      return await Promise.race([
        chrome.tabs.sendMessage(tab.id, Object.assign({ target: 'content' }, msg)),
        new Promise((_, rej) => {
          timer = setTimeout(() => rej(new Error('WhatsApp Web did not answer in time. Reload the WhatsApp tab (F5) and try again.')), timeoutMs || 30000);
        })
      ]);
    } catch (e) {
      if (/Receiving end|Could not establish/i.test(e.message || '')) {
        throw new Error('Reload the WhatsApp Web tab (F5) once, then try again.');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ---------- recipients ---------- */
  function computeRecipients() {
    const out = [];
    const chatNames = WAQS.dedupeBy(draft.selected.concat(WAQS.parseNames(draft.manualNames)), WAQS.nameKey);
    chatNames.forEach((n) => out.push({ type: 'chat', label: n, value: n, name: n }));
    WAQS.parseNumbers(draft.numbersText, settings.cc).valid.forEach((v) => {
      out.push({ type: 'number', label: '+' + v.number, value: v.number, name: draft.names[v.number] || '' });
    });
    return out;
  }

  function visibleChats() {
    const f = WAQS.nameKey(chatFilter);
    return draft.chats.filter((n) => !f || WAQS.nameKey(n).includes(f));
  }

  function renderChats() {
    const list = $('chatList');
    const shown = visibleChats();
    const selected = new Set(draft.selected.map(WAQS.nameKey));
    list.replaceChildren();
    if (!draft.chats.length) {
      list.append(h('div', { class: 'empty', text: 'No chats loaded yet. Open WhatsApp Web, then press "Load my chats" — or type names below.' }));
    } else if (!shown.length) {
      list.append(h('div', { class: 'empty', text: 'No chat matches your search.' }));
    } else {
      shown.slice(0, 2000).forEach((n) => {
        const cb = h('input', { type: 'checkbox', 'data-name': n, checked: selected.has(WAQS.nameKey(n)) });
        list.append(h('label', { class: 'chat-row', role: 'listitem' }, cb, h('span', { text: n, title: n })));
      });
    }
    const manual = WAQS.parseNames(draft.manualNames).length;
    $('chatSummary').textContent = draft.chats.length + ' found, ' + draft.selected.length + ' selected' +
      (manual ? ' (+ ' + manual + ' typed by name)' : '');
  }

  function renderNumbers() {
    const res = WAQS.parseNumbers(draft.numbersText, settings.cc);
    const sum = $('numSummary');
    sum.replaceChildren(
      h('span', { class: 'ok', text: res.valid.length + ' valid' }), ', ',
      h('span', { class: res.invalid.length ? 'err' : 'muted', text: res.invalid.length + ' invalid' })
    );
    if (res.duplicates) sum.append(', ' + res.duplicates + ' duplicate' + (res.duplicates > 1 ? 's' : '') + ' removed');
    const inv = $('invalidList');
    inv.replaceChildren();
    res.invalid.slice(0, 40).forEach((i) => inv.append(h('span', { class: 'chip', title: i.reason, text: i.raw + ' — ' + i.reason })));
    if (res.invalid.length > 40) inv.append(h('span', { class: 'chip', text: '+' + (res.invalid.length - 40) + ' more' }));
  }

  function renderTabs() {
    const chats = draft.tab !== 'numbers';
    $('tabChats').setAttribute('aria-selected', String(chats));
    $('tabNumbers').setAttribute('aria-selected', String(!chats));
    $('paneChats').hidden = !chats;
    $('paneNumbers').hidden = chats;
  }

  /* ---------- message + preview ---------- */
  function renderMessage() {
    const len = draft.message.length;
    $('charCount').textContent = len + ' characters';
    const tooLong = !!draft.file && len > WAQS.CAPTION_MAX;
    $('msgErr').textContent = tooLong ? 'Captions are limited to ' + WAQS.CAPTION_MAX + ' characters.' : '';
    const recs = computeRecipients();
    const named = recs.find((r) => r.name);
    const sample = named ? named.name : 'Alex';
    $('previewNote').textContent = 'Preview' + (/\{\s*name\s*\}/i.test(draft.message) ? ' (name: ' + sample + (named ? '' : ', sample') + ')' : '');
    const text = WAQS.applyPlaceholders(draft.message, sample);
    const box = $('previewBox');
    box.textContent = text || 'Your message will appear here.';
    box.classList.toggle('empty-bubble', !text);
  }

  /* ---------- attachment ---------- */
  function renderFile() {
    const f = draft.file;
    $('fileInfo').hidden = !f;
    if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; }
    $('filePreview').hidden = true;
    if (!f) return;
    $('fileName').textContent = f.name;
    $('fileMeta').textContent = WAQS.formatBytes(f.size) + ' · ' + (WAQS.isMediaType(f.type) ? 'sent as photo/video (max 16 MB)' : 'sent as document (max 100 MB)');
    if (/^image\//.test(f.type)) {
      idbGet(f.id).then((blob) => {
        if (!blob || !draft.file || draft.file.id !== f.id) return;
        previewUrl = URL.createObjectURL(blob);
        $('filePreview').src = previewUrl;
        $('filePreview').hidden = false;
      }).catch(() => {});
    }
  }

  async function onFilePicked(file) {
    if (!file) return;
    const limit = WAQS.limitFor(file.type);
    if (file.size > limit) {
      toast(file.name + ' is ' + WAQS.formatBytes(file.size) + '. The limit is ' + WAQS.formatBytes(limit) + ' for this file type.', 'err');
      return;
    }
    if (file.size === 0) { toast('That file is empty.', 'err'); return; }
    try {
      const old = draft.file;
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await idbPut(id, file);
      draft.file = { id, name: file.name, size: file.size, type: file.type || 'application/octet-stream' };
      if (old) idbDel(old.id).catch(() => {});
      saveDraft(); renderFile(); renderMessage(); renderStart();
    } catch (e) {
      toast('Could not store the file: ' + (e.message || e), 'err');
    }
  }

  async function removeFile() {
    const old = draft.file;
    draft.file = null;
    if (old) idbDel(old.id).catch(() => {});
    saveDraft(); renderFile(); renderMessage(); renderStart();
  }

  /* ---------- settings ---------- */
  function renderSettings() {
    $('delayMinInput').value = settings.delayMin;
    $('delayMaxInput').value = settings.delayMax;
    $('darkToggle').checked = settings.theme === 'dark';
    $('ccSelect').value = settings.cc;
    if (auth) {
      const left = Math.max(0, (auth.daily_cap || 0) - (auth.used_today || 0));
      $('limitInfo').textContent = 'Set by your administrator: ' + auth.daily_cap + ' messages per day. Used today: ' + (auth.used_today || 0) + ' (' + left + ' left).' +
        (auth.expires_at ? ' Plan ends ' + auth.expires_at + '.' : '');
    } else {
      $('limitInfo').textContent = '';
    }
  }
  function applyTheme() {
    const t = settings.theme || (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = t;
    $('darkToggle').checked = t === 'dark';
  }

  /* ---------- start gate ---------- */
  const isActive = () => !!campaign && (campaign.status === 'running' || campaign.status === 'paused');

  function renderStart() {
    const recs = computeRecipients();
    const chats = recs.filter((r) => r.type === 'chat').length;
    const nums = recs.length - chats;
    $('totalRecipients').textContent = recs.length
      ? 'Recipients: ' + recs.length + ' (' + chats + ' chat' + (chats === 1 ? '' : 's') + ', ' + nums + ' number' + (nums === 1 ? '' : 's') + ')'
      : '';
    let hint = '';
    if (!recs.length) hint = 'Add at least one recipient.';
    else if (!draft.message.trim() && !draft.file) hint = 'Write a message or attach a file.';
    else if (draft.file && draft.message.length > WAQS.CAPTION_MAX) hint = 'Shorten the message to ' + WAQS.CAPTION_MAX + ' characters (caption limit).';
    $('startHint').textContent = hint;
    $('startBtn').disabled = !!hint || isActive() || !auth;
  }

  function confirmDialog(recs) {
    return new Promise((resolve) => {
      const d = $('confirmDlg');
      const left = auth ? Math.max(0, (auth.daily_cap || 0) - (auth.used_today || 0)) : 0;
      $('confirmText').textContent = 'Send to ' + recs.length + ' recipient' + (recs.length === 1 ? '' : 's') +
        '? Only message people who agreed to receive your messages.';
      const avg = (settings.delayMin + settings.delayMax) / 2;
      let note = 'About ' + Math.max(1, Math.round(recs.length * avg / 60)) + ' min, with a random ' + settings.delayMin + '-' + settings.delayMax + ' s wait between messages.';
      if (left < recs.length) note += ' Your daily limit allows only ' + left + ' more today; sending will pause when it is reached.';
      $('confirmNote').textContent = note;
      const onClose = () => { d.removeEventListener('close', onClose); resolve(d.returnValue === 'ok'); };
      d.addEventListener('close', onClose);
      d.returnValue = '';
      d.showModal();
    });
  }

  /* ---------- login / account ---------- */
  function setLoginErr(msg) { $('loginErr').textContent = msg || ''; }

  function renderAuth() {
    const logged = !!auth;
    $('loginView').hidden = logged;
    $('appView').hidden = !logged;
    $('userBar').hidden = !logged;
    $('userEmail').textContent = logged ? auth.email : '';
    $('userEmail').title = logged ? auth.email : '';
    $('cfgWarn').hidden = WAQS_API.configured();
    const reg = (typeof WAQS_CONFIG !== 'undefined' && WAQS_CONFIG.REGISTER_URL) || '';
    const regOk = /^https?:\/\//i.test(reg) && !/YOUR-DOMAIN/i.test(reg);
    $('registerLink').hidden = !regOk;
    if (regOk) $('registerLink').href = reg;
  }

  async function forgetLogin(message) {
    auth = null;
    await chrome.storage.local.remove('auth').catch(() => {});
    setLoginErr(message || '');
    renderAll();
  }

  async function doLogin(e) {
    e.preventDefault();
    const email = $('loginEmail').value.trim();
    const password = $('loginPass').value;
    if (!email || !password) { setLoginErr('Enter your email and password.'); return; }
    const btn = $('loginBtn');
    btn.disabled = true;
    btn.replaceChildren(h('span', { class: 'spinner' }), 'Logging in…');
    setLoginErr('');
    try {
      const r = await WAQS_API.call('login.php', { email, password });
      if (r.status === 200 && r.data.ok) {
        const u = r.data.user;
        auth = { token: r.data.token, email: u.email, name: u.name, daily_cap: u.daily_cap, used_today: u.used_today, expires_at: u.expires_at };
        await chrome.storage.local.set({ auth });
        $('loginPass').value = '';
        renderAll();
        toast('Logged in.', 'ok');
      } else {
        setLoginErr(r.data.error || 'Login failed (HTTP ' + r.status + ').');
      }
    } catch (err) {
      setLoginErr('Cannot reach the server (' + err.message + '). Check your internet and the server address in config.js.');
    } finally {
      btn.disabled = false;
      btn.replaceChildren('Log in');
    }
  }

  async function doLogout() {
    if (isActive()) { toast('Stop or finish the current campaign before logging out.', 'err'); return; }
    const token = auth && auth.token;
    if (token) WAQS_API.call('logout.php', {}, token).catch(() => {});
    await forgetLogin('');
    toast('Logged out.', 'ok');
  }

  // Asks the server whether this login is still valid and refreshes the daily limit. Network errors are ignored.
  async function refreshMe() {
    if (!auth || !auth.token) return true;
    try {
      const r = await WAQS_API.call('me.php', {}, auth.token);
      if (r.status === 200 && r.data.ok) {
        const u = r.data.user;
        Object.assign(auth, { email: u.email, name: u.name, daily_cap: u.daily_cap, used_today: u.used_today, expires_at: u.expires_at });
        await chrome.storage.local.set({ auth });
        renderSettings(); renderStart();
        return true;
      }
      if (r.status === 401 || r.status === 403) { await forgetLogin(r.data.error || 'Please log in again.'); return false; }
    } catch (e) { /* offline: keep the cached login */ }
    return true;
  }

  async function onStart() {
    const recs = computeRecipients();
    if (!auth) { toast('Please log in first.', 'err'); return; }
    if (!(await refreshMe())) return;
    if (auth && auth.daily_cap - (auth.used_today || 0) <= 0) {
      toast('Your daily limit (' + auth.daily_cap + ') is used up. Ask your administrator to raise it, or try again tomorrow.', 'err');
      return;
    }
    try {
      const st = await waCmd({ type: 'status' });
      if (!st || !st.ok) throw new Error('WhatsApp Web did not answer. Reload the tab (F5).');
      if (st.qr) { toast('Scan the QR code in WhatsApp Web first.', 'err'); return; }
      if (!st.ready) { toast('WhatsApp Web is still loading. Try again in a moment.', 'err'); return; }
    } catch (e) { toast(e.message, 'err'); return; }
    if (!(await confirmDialog(recs))) return;
    try {
      const res = await chrome.runtime.sendMessage({ target: 'background', type: 'start', recipients: recs, message: draft.message, file: draft.file });
      if (!res || !res.ok) toast((res && res.error) || 'Could not start.', 'err');
    } catch (e) { toast('Could not start: ' + (e.message || e), 'err'); }
  }

  async function command(type) {
    try {
      const res = await chrome.runtime.sendMessage({ target: 'background', type });
      if (!res || !res.ok) toast((res && res.error) || 'Command failed.', 'err');
    } catch (e) { toast(e.message || String(e), 'err'); }
  }

  /* ---------- live run view ---------- */
  const STATUS_TEXT = { waiting: 'Waiting', sending: 'Sending', sent: 'Sent', failed: 'Failed', skipped: 'Not sent' };

  function renderRun() {
    const c = campaign;
    $('formSections').inert = isActive();
    $('startBox').hidden = !!c;
    $('runBox').hidden = !c;
    renderStart();
    if (!c) { runRows.clear(); runRowsFor = null; return; }

    const total = c.recipients.length;
    const count = (s) => c.recipients.filter((r) => r.status === s).length;
    const sent = count('sent'), failed = count('failed');
    const done = sent + failed + count('skipped');
    const pct = total ? Math.round((done / total) * 100) : 0;
    $('barInner').style.width = pct + '%';
    $('barOuter').setAttribute('aria-valuenow', String(pct));
    $('progressText').textContent = done + ' of ' + total + ' done · ' + sent + ' sent · ' + failed + ' failed';

    const finished = c.status === 'done' || c.status === 'stopped';
    $('runButtons').hidden = finished;
    $('pauseBtn').disabled = c.status !== 'running';
    $('resumeBtn').disabled = c.status !== 'paused';
    $('finishBox').hidden = !finished;
    $('h-run').textContent = finished ? (c.status === 'done' ? 'Finished' : 'Stopped') : 'Sending';
    if (finished) {
      const notSent = total - sent - failed;
      $('finishText').textContent = sent + ' sent, ' + failed + ' failed' + (notSent ? ', ' + notSent + ' not sent' : '') +
        '. "Sent" means Send was clicked — not that it was delivered or read.';
    }
    renderCurrentLine();

    if (runRowsFor !== c.id) {
      runRowsFor = c.id; runRows.clear();
      const ul = $('runList');
      ul.replaceChildren();
      c.recipients.forEach((r) => {
        const badge = h('span', { class: 'badge' });
        const why = h('span', { class: 'rwhy' });
        const who = h('span', { class: 'rname' }, r.name && r.type === 'number' ? r.name + ' · ' : '', r.label, why);
        const li = h('li', null, who, badge);
        ul.append(li);
        runRows.set(r.id, { badge, why, li });
      });
    }
    c.recipients.forEach((r) => {
      const row = runRows.get(r.id);
      if (!row) return;
      row.badge.textContent = STATUS_TEXT[r.status] || r.status;
      row.badge.className = 'badge st-' + r.status;
      row.why.textContent = r.status === 'failed' || r.status === 'skipped' ? r.reason || '' : '';
      row.why.hidden = !row.why.textContent;
      if (r.status === 'sending') row.li.scrollIntoView({ block: 'nearest' });
    });
  }

  function renderCurrentLine() {
    const c = campaign;
    if (!c) return;
    const el = $('currentLine');
    if (c.status === 'running') {
      const left = c.nextAt ? Math.max(0, Math.ceil((c.nextAt - Date.now()) / 1000)) : 0;
      const cur = c.recipients[c.current];
      if (c.nextAt && left > 0) el.textContent = 'Next message in ' + left + ' s';
      else if (cur && cur.status === 'sending') el.textContent = 'Sending to ' + cur.label + '…';
      else el.textContent = 'Working…';
    } else if (c.status === 'paused') {
      el.textContent = c.note || 'Paused.';
    } else {
      el.textContent = c.note || '';
    }
  }

  function downloadCsv() {
    if (!campaign) return;
    const blob = new Blob(['\ufeff' + WAQS.buildResultsCsv(campaign)], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    const d = new Date(campaign.startedAt || Date.now());
    const p = (n) => String(n).padStart(2, '0');
    a.href = URL.createObjectURL(blob);
    a.download = 'wa-quick-sender-results-' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.csv';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* ---------- actions ---------- */
  async function loadChats() {
    const btn = $('loadChatsBtn');
    const label = btn.textContent;
    btn.disabled = true;
    loadLabel = h('span', { text: 'Loading chats…' });
    btn.replaceChildren(h('span', { class: 'spinner' }), loadLabel);
    try {
      const st = await waCmd({ type: 'status' }, 8000);
      if (st && st.qr) { toast('Scan the QR code in WhatsApp Web first.', 'err'); return; }
      if (!st || !st.ready) { toast('WhatsApp Web is still loading. Try again in a moment.', 'err'); return; }
      const r = await waCmd({ type: 'getChats' }, 100000);
      if (!r || !r.ok) { toast((r && r.reason) || 'Could not read the chat list.', 'err'); return; }
      draft.chats = r.chats;
      saveDraft(); renderChats(); renderStart();
      toast(r.chats.length + ' chats loaded' + (r.partial ? ' (stopped after 60 s; list may be incomplete — type missing names below)' : '.'), 'ok');
    } catch (e) {
      toast(e.message || String(e), 'err');
    } finally {
      loadLabel = null;
      btn.disabled = false;
      btn.replaceChildren(label);
    }
  }

  async function importCsv(file) {
    if (!file) return;
    try {
      const rows = WAQS.parseCSV(await file.text());
      const contacts = WAQS.csvToContacts(rows);
      if (!contacts.length) { toast('No numbers found in that CSV.', 'err'); return; }
      const lines = [];
      contacts.forEach((c) => {
        lines.push(c.raw);
        const r = WAQS.cleanPhone(c.raw, settings.cc);
        if (r.ok && c.name) draft.names[r.number] = c.name;
      });
      draft.numbersText = (draft.numbersText.trim() ? draft.numbersText.replace(/\s+$/, '') + '\n' : '') + lines.join('\n');
      $('numbersText').value = draft.numbersText;
      saveDraft(); renderNumbers(); renderStart(); renderMessage();
      toast('Imported ' + contacts.length + ' row' + (contacts.length === 1 ? '' : 's') + '.', 'ok');
    } catch (e) {
      toast('Could not read the CSV: ' + (e.message || e), 'err');
    }
  }

  function toggleChat(name, on) {
    const k = WAQS.nameKey(name);
    draft.selected = draft.selected.filter((n) => WAQS.nameKey(n) !== k);
    if (on) draft.selected.push(name);
    saveDraft(); renderChats(); renderStart();
  }

  /* ---------- wiring ---------- */
  function wire() {
    $('tabChats').addEventListener('click', () => { draft.tab = 'chats'; saveDraft(); renderTabs(); });
    $('tabNumbers').addEventListener('click', () => { draft.tab = 'numbers'; saveDraft(); renderTabs(); });
    $('loadChatsBtn').addEventListener('click', loadChats);
    $('chatSearch').addEventListener('input', (e) => { chatFilter = e.target.value; renderChats(); });
    $('chatList').addEventListener('change', (e) => {
      const t = e.target;
      if (t && t.matches('input[type="checkbox"]')) toggleChat(t.getAttribute('data-name'), t.checked);
    });
    $('selectVisibleBtn').addEventListener('click', () => {
      const keys = new Set(draft.selected.map(WAQS.nameKey));
      visibleChats().forEach((n) => { if (!keys.has(WAQS.nameKey(n))) draft.selected.push(n); });
      saveDraft(); renderChats(); renderStart();
    });
    $('clearSelBtn').addEventListener('click', () => { draft.selected = []; saveDraft(); renderChats(); renderStart(); });
    $('manualNames').addEventListener('input', (e) => { draft.manualNames = e.target.value; saveDraft(); renderChats(); renderStart(); renderMessage(); });

    const ccSel = $('ccSelect');
    WAQS.COUNTRIES.forEach(([code, label]) => ccSel.append(h('option', { value: code, text: label })));
    ccSel.addEventListener('change', () => { settings.cc = ccSel.value; saveSettings(); renderNumbers(); renderStart(); });
    $('numbersText').addEventListener('input', (e) => { draft.numbersText = e.target.value; saveDraft(); renderNumbers(); renderStart(); renderMessage(); });
    $('importCsvBtn').addEventListener('click', () => $('csvInput').click());
    $('csvInput').addEventListener('change', (e) => { importCsv(e.target.files[0]); e.target.value = ''; });

    $('message').addEventListener('input', (e) => { draft.message = e.target.value; saveDraft(); renderMessage(); renderStart(); });

    $('attachBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => { onFilePicked(e.target.files[0]); e.target.value = ''; });
    $('removeFileBtn').addEventListener('click', removeFile);

    const saveDelays = () => {
      const min = Math.min(WAQS.MAX_DELAY, Math.max(WAQS.MIN_DELAY, Math.floor(Number($('delayMinInput').value)) || WAQS.MIN_DELAY));
      let max = Math.min(WAQS.MAX_DELAY, Math.floor(Number($('delayMaxInput').value)) || min);
      if (max < min) max = min;
      settings.delayMin = min; settings.delayMax = max;
      $('delayMinInput').value = min; $('delayMaxInput').value = max;
      saveSettings();
    };
    $('delayMinInput').addEventListener('change', saveDelays);
    $('delayMaxInput').addEventListener('change', saveDelays);
    $('loginForm').addEventListener('submit', doLogin);
    $('logoutBtn').addEventListener('click', doLogout);
    $('darkToggle').addEventListener('change', (e) => { settings.theme = e.target.checked ? 'dark' : 'light'; saveSettings(); applyTheme(); });

    $('startBtn').addEventListener('click', onStart);
    $('pauseBtn').addEventListener('click', () => command('pause'));
    $('resumeBtn').addEventListener('click', () => command('resume'));
    $('stopBtn').addEventListener('click', () => command('stop'));
    $('downloadBtn').addEventListener('click', downloadCsv);
    $('newBtn').addEventListener('click', () => command('clear'));

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.campaign) { campaign = changes.campaign.newValue || null; renderRun(); }
      if (changes.auth) {
        auth = changes.auth.newValue || null;
        renderAuth(); renderSettings(); renderStart();
      }
    });
    chrome.runtime.onMessage.addListener((m) => {
      if (m && m.target === 'panel' && m.type === 'chatProgress' && loadLabel) loadLabel.textContent = 'Loading chats… ' + m.count + ' found';
    });
    setInterval(renderCurrentLine, 1000);
    setInterval(() => { if (auth) refreshMe(); }, 60000);
  }

  /* ---------- boot ---------- */
  function renderAll() {
    renderAuth(); renderSettings(); renderTabs(); renderChats(); renderNumbers(); renderMessage(); renderFile(); renderRun();
  }

  async function init() {
    wire();
    const st = await chrome.storage.local.get(['settings', 'draft', 'campaign', 'auth']);
    const saved = st.settings || {};
    settings = Object.assign(settings, saved);
    if (saved.delayMin == null && saved.delaySec) {          // settings saved by an older version
      settings.delayMin = Math.min(WAQS.MAX_DELAY, Math.max(WAQS.MIN_DELAY, saved.delaySec));
      settings.delayMax = Math.min(WAQS.MAX_DELAY, settings.delayMin * 2);
    }
    settings.delayMin = Math.min(WAQS.MAX_DELAY, Math.max(WAQS.MIN_DELAY, Math.floor(Number(settings.delayMin) || WAQS.MIN_DELAY)));
    settings.delayMax = Math.min(WAQS.MAX_DELAY, Math.max(settings.delayMin, Math.floor(Number(settings.delayMax) || settings.delayMin)));
    draft = Object.assign(draft, st.draft || {});
    draft.names = draft.names || {};
    campaign = st.campaign || null;
    auth = st.auth && st.auth.token ? st.auth : null;
    if (draft.file) {
      const blob = await idbGet(draft.file.id).catch(() => null);
      if (!blob) draft.file = null;
    }
    $('message').value = draft.message;
    $('manualNames').value = draft.manualNames;
    $('numbersText').value = draft.numbersText;
    applyTheme();
    renderAll();
    refreshMe();
  }
  init().catch((e) => toast('Could not start the panel: ' + (e.message || e), 'err'));
})();
