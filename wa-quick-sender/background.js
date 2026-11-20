/* background.js — runs the campaign. State lives in chrome.storage.local ("campaign"), so Pause/Resume works
   and a service-worker restart never loses progress. The side panel only sends commands and renders that state. */
importScripts('shared.js', 'config.js', 'api.js');

const WA_URL = 'https://web.whatsapp.com/*';
const DB_NAME = 'waqs';
const STORE = 'files';
const CHUNK = 3 * 1024 * 1024; // bytes per message when handing the attachment to the page

class PauseError extends Error {}

/* ---------- side panel opens on toolbar-icon click ---------- */
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

/* ---------- tiny helpers ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errText = (e) => String((e && e.message) || e || 'Unknown error').slice(0, 200);

let lock = Promise.resolve(); // serialises every read-modify-write of "campaign"
function withLock(fn) {
  const p = lock.then(fn);
  lock = p.catch(() => {});
  return p;
}
async function getCampaign() {
  const { campaign } = await chrome.storage.local.get('campaign');
  return campaign || null;
}
function updateCampaign(fn) {
  return withLock(async () => {
    const { campaign } = await chrome.storage.local.get('campaign');
    if (!campaign) return null;
    fn(campaign);
    await chrome.storage.local.set({ campaign });
    return campaign;
  });
}
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const s = settings || {};
  const min = Math.min(WAQS.MAX_DELAY, Math.max(WAQS.MIN_DELAY, Number(s.delayMin) || Number(s.delaySec) || WAQS.MIN_DELAY));
  const max = Math.min(WAQS.MAX_DELAY, Math.max(min, Number(s.delayMax) || min));
  return { delayMin: min, delayMax: max };
}

/* ---------- daily limit: counted by the server, per user ---------- */
async function saveUsage(d) {
  const { auth } = await chrome.storage.local.get('auth');
  if (auth && d && typeof d.used === 'number') {
    auth.used_today = d.used;
    auth.daily_cap = d.cap;
    await chrome.storage.local.set({ auth });
  }
}

// Reserves one message slot on the server BEFORE the recipient is processed.
async function reserveSlot() {
  const { auth } = await chrome.storage.local.get('auth');
  if (!auth || !auth.token) return { ok: false, note: 'You are logged out. Log in in the side panel, then press Resume.' };
  let res;
  try {
    res = await WAQS_API.call('usage.php', { action: 'reserve' }, auth.token);
  } catch (e) {
    return { ok: false, note: 'Cannot reach the server (' + errText(e) + '). Check your internet, then press Resume.' };
  }
  const d = res.data || {};
  if (res.status === 200 && d.ok) { await saveUsage(d); return { ok: true }; }
  if (d.code === 'cap_reached') {
    await saveUsage(d);
    return { ok: false, note: 'Daily limit reached (' + d.used + ' of ' + d.cap + ' messages today). The limit is set by your administrator. Press Resume tomorrow, or ask them to raise it.' };
  }
  if (res.status === 401 || res.status === 403) {
    await chrome.storage.local.remove('auth');
    return { ok: false, note: (d.error || 'Your session ended.') + ' Log in again in the side panel, then press Resume.' };
  }
  return { ok: false, note: 'Server problem: ' + (d.error || ('HTTP ' + res.status)) + '. Press Resume to retry.' };
}

// Gives the slot back when nothing was actually sent (chat not found, number not on WhatsApp, ...).
async function releaseSlot() {
  try {
    const { auth } = await chrome.storage.local.get('auth');
    if (!auth || !auth.token) return;
    const res = await WAQS_API.call('usage.php', { action: 'refund' }, auth.token);
    if (res.data && res.data.ok) await saveUsage(res.data);
  } catch (e) { /* best effort */ }
}

/* ---------- keep the worker alive while a campaign runs ---------- */
let keepTimer = null;
function startKeepAlive() {
  if (keepTimer) return;
  keepTimer = setInterval(() => { chrome.runtime.getPlatformInfo().catch(() => {}); }, 20000);
}
function stopKeepAlive() {
  if (keepTimer) { clearInterval(keepTimer); keepTimer = null; }
}

/* ---------- IndexedDB (attachment storage, shared with the panel) ---------- */
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const q = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    q.onsuccess = () => { db.close(); resolve(q.result); };
    q.onerror = () => { db.close(); reject(q.error); };
  });
}

/* ---------- talking to the WhatsApp tab ---------- */
async function findTab() {
  const tabs = await chrome.tabs.query({ url: WA_URL });
  if (!tabs.length) return null;
  return tabs.find((t) => t.active) || tabs[0];
}

async function cmd(tabId, msg, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      chrome.tabs.sendMessage(tabId, Object.assign({ target: 'content' }, msg)),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Timed out waiting for WhatsApp Web')), timeoutMs || 30000); })
    ]);
  } catch (e) {
    if (/Receiving end does not exist|Could not establish connection/i.test(e.message || '')) {
      throw new PauseError('The extension is not active in the WhatsApp tab yet. Reload that tab (F5), then press Resume.');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForContent(tabId, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await cmd(tabId, { type: 'ping' }, 2000);
      if (r && r.ok) return true;
    } catch (e) { /* page still loading */ }
    await sleep(500);
  }
  return false;
}

function toBase64(u8) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < u8.length; i += step) s += String.fromCharCode.apply(null, u8.subarray(i, i + step));
  return btoa(s);
}

// Hands the stored attachment to the content script in chunks (messages are JSON, so Blobs can't be sent).
async function ensureFile(tabId, file) {
  const has = await cmd(tabId, { type: 'hasFile', id: file.id }, 10000);
  if (has && has.ok) return { ok: true };
  const blob = await idbGet(file.id);
  if (!blob) return { ok: false, reason: 'Attachment is missing from local storage. Re-attach the file.' };
  const total = Math.max(1, Math.ceil(blob.size / CHUNK));
  for (let i = 0; i < total; i++) {
    const buf = await blob.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer();
    const r = await cmd(tabId, {
      type: 'fileChunk', id: file.id, name: file.name, mime: file.type || 'application/octet-stream',
      index: i, total, b64: toBase64(new Uint8Array(buf))
    }, 60000);
    if (!r || !r.ok) return { ok: false, reason: 'Could not pass the attachment to WhatsApp Web' };
  }
  return { ok: true };
}

/* ---------- one recipient ---------- */
async function processRecipient(c, r) {
  const tab = await findTab();
  if (!tab) throw new PauseError('No WhatsApp Web tab found. Open web.whatsapp.com, then press Resume.');
  const tabId = tab.id;
  const text = WAQS.applyPlaceholders(c.message, r.name);

  let res;
  if (r.type === 'number') {
    res = await cmd(tabId, { type: 'openPhone', phone: r.value }, 100000);
  } else {
    if (!(await waitForContent(tabId, 5000))) {
      throw new PauseError('The extension is not active in the WhatsApp tab yet. Reload that tab (F5), then press Resume.');
    }
    res = await cmd(tabId, { type: 'openChat', name: r.value }, 45000);
  }
  if (res && res.pause) throw new PauseError(res.reason);
  if (!res || !res.ok) return { ok: false, reason: (res && res.reason) || 'Could not open the chat' };

  if (c.file) {
    const f = await ensureFile(tabId, c.file);
    if (!f.ok) return f;
  }
  const out = await cmd(tabId, { type: 'send', text, file: c.file || null }, 240000);
  if (out && out.pause) throw new PauseError(out.reason);
  return out || { ok: false, reason: 'No answer from WhatsApp Web' };
}

/* ---------- the loop ---------- */
let loopRunning = false;

async function waitDelay(seconds) {
  const until = Date.now() + seconds * 1000;
  await updateCampaign((c) => { c.nextAt = until; });
  while (Date.now() < until) {
    await sleep(500);
    const c = await getCampaign();
    if (!c || c.status !== 'running') break;
  }
  await updateCampaign((c) => { delete c.nextAt; });
}

async function runLoop() {
  if (loopRunning) return;
  loopRunning = true;
  startKeepAlive();
  try {
    for (;;) {
      const c = await getCampaign();
      if (!c || c.status !== 'running') break;
      const idx = c.recipients.findIndex((r) => r.status === 'waiting');
      if (idx < 0) {
        await updateCampaign((x) => { x.status = 'done'; x.finishedAt = Date.now(); x.note = ''; x.current = -1; delete x.nextAt; });
        break;
      }
      const settings = await getSettings();
      const gate = await reserveSlot();
      if (!gate.ok) {
        await updateCampaign((x) => { if (x.status === 'running') { x.status = 'paused'; x.note = gate.note; } });
        break;
      }

      await updateCampaign((x) => { x.recipients[idx].status = 'sending'; x.current = idx; delete x.nextAt; });
      let result;
      try {
        result = await processRecipient(c, c.recipients[idx]);
      } catch (e) {
        if (e instanceof PauseError) {
          await releaseSlot();
          await updateCampaign((x) => {
            x.recipients[idx].status = x.status === 'stopped' ? 'skipped' : 'waiting';
            x.current = -1;
            if (x.status === 'running') { x.status = 'paused'; x.note = e.message; }
          });
          break;
        }
        result = { ok: false, reason: errText(e) };
      }

      await updateCampaign((x) => {
        const r = x.recipients[idx];
        r.status = result.ok ? 'sent' : 'failed';
        r.reason = result.ok ? '' : (result.reason || 'Unknown error');
        r.time = Date.now();
        x.current = -1;
      });
      if (!(result.ok || result.attempted)) await releaseSlot();

      // Random delay (between the min and max the user chose) only after something was actually sent.
      const after = await getCampaign();
      if (after && after.status === 'running' && after.recipients.some((r) => r.status === 'waiting') &&
          (result.ok || result.attempted)) {
        await waitDelay(WAQS.randomDelay(settings.delayMin, settings.delayMax, null, WAQS.MIN_DELAY));
      }
    }
  } catch (e) {
    await updateCampaign((x) => {
      x.recipients.forEach((r) => { if (r.status === 'sending') { r.status = 'failed'; r.reason = errText(e); r.time = Date.now(); } });
      if (x.status === 'running') { x.status = 'paused'; x.note = 'Unexpected error: ' + errText(e) + '. Press Resume to continue.'; }
    }).catch(() => {});
  } finally {
    loopRunning = false;
    stopKeepAlive();
    // If the person pressed Resume in the instant the loop was exiting, pick it back up.
    const c = await getCampaign().catch(() => null);
    if (c && c.status === 'running' && c.recipients.some((r) => r.status === 'waiting')) setTimeout(runLoop, 0);
  }
}

/* ---------- recovery after a worker restart ---------- */
async function recover() {
  await updateCampaign((c) => {
    if (c.status !== 'running') return;
    c.recipients.forEach((r) => {
      if (r.status === 'sending') { r.status = 'failed'; r.reason = 'Interrupted (extension restarted). Check this chat manually.'; r.time = Date.now(); }
    });
    c.status = 'paused';
    c.note = 'Interrupted because the extension restarted. Press Resume to continue.';
    c.current = -1;
    delete c.nextAt;
  });
}
const bootReady = recover().catch(() => {});

/* ---------- commands from the side panel ---------- */
async function handle(msg) {
  await bootReady;
  switch (msg.type) {
    case 'start': {
      const { auth } = await chrome.storage.local.get('auth');
      if (!auth || !auth.token) return { ok: false, error: 'Please log in first.' };
      const recipients = Array.isArray(msg.recipients) ? msg.recipients : [];
      if (!recipients.length) return { ok: false, error: 'No recipients' };
      const result = await withLock(async () => {
        const { campaign } = await chrome.storage.local.get('campaign');
        if (campaign && (campaign.status === 'running' || campaign.status === 'paused')) {
          return { ok: false, error: 'A campaign is already active' };
        }
        const fresh = {
          id: Date.now().toString(36),
          status: 'running',
          startedAt: Date.now(),
          message: String(msg.message || ''),
          file: msg.file || null,
          note: '',
          current: -1,
          recipients: recipients.map((r, i) => ({
            id: i, type: r.type === 'number' ? 'number' : 'chat', label: String(r.label || r.value),
            value: String(r.value), name: String(r.name || ''), status: 'waiting', reason: ''
          }))
        };
        await chrome.storage.local.set({ campaign: fresh });
        return { ok: true };
      });
      if (result.ok) runLoop();
      return result;
    }
    case 'pause':
      await updateCampaign((c) => { if (c.status === 'running') { c.status = 'paused'; c.note = 'Paused. The current message (if any) will finish first.'; } });
      return { ok: true };
    case 'resume': {
      let resumed = false;
      await updateCampaign((c) => { if (c.status === 'paused') { c.status = 'running'; c.note = ''; resumed = true; } });
      if (resumed) runLoop();
      return { ok: true };
    }
    case 'stop':
      await updateCampaign((c) => {
        if (c.status !== 'running' && c.status !== 'paused') return;
        c.status = 'stopped';
        c.note = 'Stopped by you.';
        c.finishedAt = Date.now();
        delete c.nextAt;
        c.recipients.forEach((r) => { if (r.status === 'waiting') { r.status = 'skipped'; r.reason = 'Stopped before sending'; } });
      });
      return { ok: true };
    case 'clear':
      await withLock(async () => {
        const { campaign } = await chrome.storage.local.get('campaign');
        if (campaign && campaign.status !== 'running' && campaign.status !== 'paused') await chrome.storage.local.remove('campaign');
      });
      return { ok: true };
    default:
      return { ok: false, error: 'Unknown command' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'background') return false;
  handle(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: errText(e) }));
  return true;
});
