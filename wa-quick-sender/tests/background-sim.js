/* Simulates background.js with a mocked chrome.* API and a scripted "WhatsApp tab".
   It tests the campaign state machine (sent/failed, pause/resume, stop, daily cap, no-tab pause).
   It does NOT test WhatsApp Web itself. Run with:  node tests/background-sim.js */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;

function makeWorld(script, initialStore) {
  const store = initialStore ? JSON.parse(JSON.stringify(initialStore)) : {};  // pre-filled storage = state left by a previous worker
  if (!('auth' in store)) store.auth = { token: 'a'.repeat(64), email: 'u@example.com', daily_cap: 100, used_today: 0 };
  // Mocked server: reserve/refund like api/usage.php. Set server.down / server.status to simulate problems.
  const server = { cap: 100, used: 0, down: false, forceStatus: 0, calls: [] };
  const fetchMock = async (url, opts) => {
    if (server.down) throw new Error('offline');
    const action = JSON.parse(opts.body).action;
    server.calls.push(action);
    const reply = (status, data) => ({ status, json: async () => data });
    if (server.forceStatus) return reply(server.forceStatus, { ok: false, code: 'bad_token', error: 'Your session has expired.' });
    if (action === 'reserve') {
      if (server.used >= server.cap) return reply(429, { ok: false, code: 'cap_reached', used: server.used, cap: server.cap });
      server.used++;
      return reply(200, { ok: true, used: server.used, cap: server.cap });
    }
    if (action === 'refund') { server.used = Math.max(0, server.used - 1); return reply(200, { ok: true, used: server.used, cap: server.cap }); }
    return reply(400, { ok: false });
  };
  const updated = new Set();
  const log = [];
  let onMessage = null;
  let tabs = [{ id: 1, active: true }];
  const clone = (x) => JSON.parse(JSON.stringify(x));

  const chrome = {
    storage: { local: {
      get: async (keys) => { const ks = Array.isArray(keys) ? keys : [keys]; const o = {}; ks.forEach((k) => { if (k in store) o[k] = clone(store[k]); }); return o; },
      set: async (o) => { Object.assign(store, clone(o)); },
      remove: async (k) => { delete store[k]; }
    } },
    sidePanel: { setPanelBehavior: async () => {} },
    runtime: {
      onInstalled: { addListener() {} },
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      getPlatformInfo: async () => ({})
    },
    tabs: {
      query: async () => tabs,
      update: async (id, info) => {
        log.push('navigate ' + info.url);
        setTimeout(() => updated.forEach((f) => f(id, { status: 'loading' })), 5);
        setTimeout(() => updated.forEach((f) => f(id, { status: 'complete' })), 15);
      },
      onUpdated: { addListener: (f) => updated.add(f), removeListener: (f) => updated.delete(f) },
      sendMessage: async (id, msg) => script(msg, log)
    }
  };
  const ctx = vm.createContext({ chrome, fetch: fetchMock, AbortController, console, setTimeout, clearTimeout, setInterval, clearInterval, Date, Promise, btoa, atob });
  ctx.importScripts = (...files) => files.forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f }));
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  vm.runInContext("WAQS_CONFIG.API_BASE = 'https://example.test/api';", ctx); // the shipped config.js holds a placeholder
  ctx.WAQS.MIN_DELAY = 0; // so the simulation can use a 1-second delay
  const call = (msg) => new Promise((resolve) => onMessage(Object.assign({ target: 'background' }, msg), {}, resolve));
  return { store, log, call, server, setTabs: (t) => { tabs = t; } };
}

// Scripted WhatsApp: number 919000000001 is "not on WhatsApp", everything else works.
function okScript(msg, log) {
  switch (msg.type) {
    case 'ping': return { ok: true };
    case 'openPhone':
      log.push('openPhone ' + msg.phone);
      return msg.phone === '919000000001' ? { ok: false, reason: 'Number is not on WhatsApp (or is invalid)' } : { ok: true };
    case 'openChat': return { ok: true };
    case 'send': log.push('send ' + JSON.stringify(msg.text)); return { ok: true, attempted: true };
    default: return { ok: false, reason: 'unknown' };
  }
}

const recs = (n) => n.map((x) => (x.startsWith('9') ? { type: 'number', label: '+' + x, value: x, name: '' } : { type: 'chat', label: x, value: x, name: x }));
async function waitStatus(w, status, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < (ms || 15000)) { if (w.store.campaign && w.store.campaign.status === status) return w.store.campaign; await sleep(100); }
  throw new Error('timed out waiting for status ' + status + ' (now ' + (w.store.campaign && w.store.campaign.status) + ')');
}
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

(async () => {
  console.log('Background campaign runner (simulated)');

  await test('sends to chats and numbers, records failures, personalises {name}', async () => {
    const w = makeWorld(okScript);
    w.store.settings = { delaySec: 1, dailyCap: 100 };
    await w.call({ type: 'start', recipients: recs(['Family', '919000000002', '919000000001', 'Work']), message: 'Hi {name}!', file: null });
    const c = await waitStatus(w, 'done');
    assert.deepStrictEqual(c.recipients.map((r) => r.status), ['sent', 'sent', 'failed', 'sent']);
    assert.strictEqual(c.recipients[2].reason, 'Number is not on WhatsApp (or is invalid)');
    assert.ok(w.log.includes('send "Hi Family!"'));
    assert.ok(w.log.includes('send "Hi !"') || w.log.includes('send "Hi!"'));
    assert.ok(w.log.includes('openPhone 919000000002'));
    assert.ok(!w.log.some((l) => l.startsWith('navigate ')), 'opening a number must not reload the WhatsApp tab');
    assert.strictEqual(w.server.used, 3, 'failed recipient must give its slot back');
    assert.ok(w.server.calls.includes('refund'));
  });

  await test('does not reload or send when the in-page route cannot open a number', async () => {
    const w = makeWorld((msg, log) => msg.type === 'openPhone'
      ? { ok: false, reason: 'WhatsApp did not open this number in the current page.' }
      : okScript(msg, log));
    w.store.settings = { delayMin: 1, delayMax: 1 };
    await w.call({ type: 'start', recipients: recs(['919000000002']), message: 'x' });
    const c = await waitStatus(w, 'done');
    assert.strictEqual(c.recipients[0].status, 'failed');
    assert.ok(!w.log.some((l) => l.startsWith('navigate ')));
    assert.ok(!w.log.some((l) => l.startsWith('send ')));
  });

  await test('sends each number in order without navigating the WhatsApp tab', async () => {
    const w = makeWorld(okScript);
    w.store.settings = { delayMin: 1, delayMax: 1 };
    const numbers = ['919000000002', '919000000003', '919000000004'];
    await w.call({ type: 'start', recipients: recs(numbers), message: 'Hello' });
    const c = await waitStatus(w, 'done');
    assert.deepStrictEqual(c.recipients.map((r) => r.status), ['sent', 'sent', 'sent']);
    assert.deepStrictEqual(
      w.log.filter((line) => line.startsWith('openPhone ') || line.startsWith('send ')),
      numbers.flatMap((number) => ['openPhone ' + number, 'send "Hello"'])
    );
    assert.ok(!w.log.some((line) => line.startsWith('navigate ')), 'sending each number must not reload the WhatsApp tab');
  });

  await test('a second start is refused while a campaign is active', async () => {
    const w = makeWorld(okScript);
    w.store.settings = { delaySec: 1, dailyCap: 100 };
    await w.call({ type: 'start', recipients: recs(['A', 'B']), message: 'x' });
    const r = await w.call({ type: 'start', recipients: recs(['C']), message: 'y' });
    assert.strictEqual(r.ok, false);
    await w.call({ type: 'stop' });
  });

  await test('pause holds progress, resume continues', async () => {
    const w = makeWorld(okScript);
    w.store.settings = { delaySec: 1, dailyCap: 100 };
    await w.call({ type: 'start', recipients: recs(['A', 'B', 'C']), message: 'x' });
    await w.call({ type: 'pause' });
    const paused = await waitStatus(w, 'paused');
    await sleep(1800);
    const sentWhilePaused = w.store.campaign.recipients.filter((r) => r.status === 'sent').length;
    assert.ok(sentWhilePaused <= 1, 'progress continued while paused: ' + sentWhilePaused);
    await w.call({ type: 'resume' });
    const c = await waitStatus(w, 'done');
    assert.deepStrictEqual(c.recipients.map((r) => r.status), ['sent', 'sent', 'sent']);
  });

  await test('stop marks the rest as skipped ("Not sent")', async () => {
    const w = makeWorld(okScript);
    w.store.settings = { delaySec: 1, dailyCap: 100 };
    await w.call({ type: 'start', recipients: recs(['A', 'B', 'C', 'D']), message: 'x' });
    await sleep(300);
    await w.call({ type: 'stop' });
    await sleep(1500);
    const c = w.store.campaign;
    assert.strictEqual(c.status, 'stopped');
    assert.ok(c.recipients.some((r) => r.status === 'skipped'));
    assert.ok(!c.recipients.some((r) => r.status === 'waiting' || r.status === 'sending'));
  });

  await test('server-side daily limit pauses the campaign', async () => {
    const w = makeWorld(okScript);
    w.store.settings = { delayMin: 1, delayMax: 1 };
    w.server.cap = 1;
    await w.call({ type: 'start', recipients: recs(['A', 'B']), message: 'x' });
    const c = await waitStatus(w, 'paused');
    assert.match(c.note, /Daily limit reached \(1 of 1/);
    assert.strictEqual(w.store.auth.used_today, 1);
    assert.deepStrictEqual(c.recipients.map((r) => r.status), ['sent', 'waiting']);
  });

  await test('no WhatsApp tab: pauses and keeps the recipient waiting', async () => {
    const w = makeWorld(okScript);
    w.setTabs([]);
    w.store.settings = { delaySec: 1, dailyCap: 100 };
    await w.call({ type: 'start', recipients: recs(['A']), message: 'x' });
    const c = await waitStatus(w, 'paused');
    assert.strictEqual(c.recipients[0].status, 'waiting');
    assert.match(c.note, /No WhatsApp Web tab/);
  });

  await test('content script missing: pauses instead of failing everyone', async () => {
    const w = makeWorld(() => { throw new Error('Could not establish connection. Receiving end does not exist.'); });
    w.store.settings = { delaySec: 1, dailyCap: 100 };
    await w.call({ type: 'start', recipients: recs(['A', 'B']), message: 'x' });
    const c = await waitStatus(w, 'paused');
    assert.deepStrictEqual(c.recipients.map((r) => r.status), ['waiting', 'waiting']);
  });

  await test('unexpected error on one recipient: Failed with reason, next one continues', async () => {
    let n = 0;
    const w = makeWorld((msg, log) => { if (msg.type === 'send' && ++n === 1) throw new Error('boom'); return okScript(msg, log); });
    w.store.settings = { delaySec: 1, dailyCap: 100 };
    await w.call({ type: 'start', recipients: recs(['A', 'B']), message: 'x' });
    const c = await waitStatus(w, 'done');
    assert.deepStrictEqual(c.recipients.map((r) => r.status), ['failed', 'sent']);
    assert.strictEqual(c.recipients[0].reason, 'boom');
  });

  await test('not logged in: start is refused', async () => {
    const w = makeWorld(okScript, { auth: null });
    delete w.store.auth;
    const r = await w.call({ type: 'start', recipients: recs(['A']), message: 'x' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /log in/i);
  });

  await test('expired/blocked login (401): pauses, forgets the login, sends nothing', async () => {
    const w = makeWorld(okScript);
    w.store.settings = { delayMin: 1, delayMax: 1 };
    w.server.forceStatus = 401;
    await w.call({ type: 'start', recipients: recs(['A', 'B']), message: 'x' });
    const c = await waitStatus(w, 'paused');
    assert.match(c.note, /Log in again/);
    assert.ok(!w.store.auth, 'stored login must be removed');
    assert.ok(!w.log.some((l) => l.startsWith('send')));
  });

  await test('server unreachable: pauses instead of sending without a count', async () => {
    const w = makeWorld(okScript);
    w.store.settings = { delayMin: 1, delayMax: 1 };
    w.server.down = true;
    await w.call({ type: 'start', recipients: recs(['A']), message: 'x' });
    const c = await waitStatus(w, 'paused');
    assert.match(c.note, /Cannot reach the server/);
    assert.deepStrictEqual(c.recipients.map((r) => r.status), ['waiting']);
    assert.ok(!w.log.some((l) => l.startsWith('send')));
  });

  await test('random delay: waits between min and max seconds', async () => {
    const w = makeWorld(okScript);
    w.store.settings = { delayMin: 1, delayMax: 2 };
    const t0 = Date.now();
    await w.call({ type: 'start', recipients: recs(['A', 'B']), message: 'x' });
    await waitStatus(w, 'done', 8000);
    const took = (Date.now() - t0) / 1000;
    assert.ok(took >= 0.9 && took < 4, 'took ' + took + 's for one 1-2 s delay');
  });

  await test('worker restart mid-send: sending recipient marked Failed, campaign paused (not auto-resumed)', async () => {
    const left = { id: 'x', status: 'running', message: 'x', file: null, note: '', current: 0, recipients: [
      { id: 0, type: 'chat', label: 'A', value: 'A', name: 'A', status: 'sending', reason: '' },
      { id: 1, type: 'chat', label: 'B', value: 'B', name: 'B', status: 'waiting', reason: '' }] };
    const w = makeWorld(okScript, { campaign: left, settings: { delaySec: 1, dailyCap: 100 } });
    const r = await w.call({ type: 'pause' }); // any message waits for the boot-time recovery to finish first
    assert.ok(r.ok);
    const c = w.store.campaign;
    assert.strictEqual(c.status, 'paused');
    assert.deepStrictEqual(c.recipients.map((x) => x.status), ['failed', 'waiting']);
    assert.match(c.recipients[0].reason, /check this chat manually/i);
    assert.ok(!w.log.some((l) => l.startsWith('send')), 'nothing may be sent after a restart until the user resumes');
  });

  console.log('\n' + passed + ' simulation tests passed' + (process.exitCode ? ' — SOME FAILED' : ''));
  process.exit(process.exitCode || 0);
})();
