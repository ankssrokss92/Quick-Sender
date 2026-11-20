/* Smoke test of the side panel's login logic with a tiny fake DOM, fake chrome.* and a fake server.
   It checks the wiring (no ReferenceErrors, login/logout/limit display), NOT the visual layout.
   Run with:  node tests/panel-smoke.js */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const assert = require('assert');
const root = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(initialStorage, serverReply) {
  const els = {};
  const makeEl = (id) => ({
    id, style: {}, dataset: {}, children: [], textContent: '', value: '', hidden: false, disabled: false, title: '', href: '', _l: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(t, f) { this._l[t] = f; }, removeEventListener() {}, setAttribute() {}, getAttribute() { return null; },
    append() {}, replaceChildren() {}, showModal() {}, scrollIntoView() {}, remove() {}, click() {}
  });
  const el = (id) => els[id] || (els[id] = makeEl(id));
  const document = { getElementById: el, createElement: (t) => makeEl('new-' + t), createTextNode: (t) => ({ nodeType: 3, t }), documentElement: { dataset: {} }, body: makeEl('body') };
  const store = JSON.parse(JSON.stringify(initialStorage || {}));
  const fetched = [];
  const chrome = {
    storage: {
      local: {
        get: async (keys) => { const o = {}; (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (k in store) o[k] = JSON.parse(JSON.stringify(store[k])); }); return o; },
        set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
        remove: async (k) => { delete store[k]; }
      },
      onChanged: { addListener() {} }
    },
    runtime: { onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) },
    tabs: { query: async () => [{ id: 1, active: true }], sendMessage: async () => ({ ok: true, ready: true }) }
  };
  const fetchMock = async (url, opts) => {
    const ep = url.split('/').pop();
    fetched.push(ep);
    const r = serverReply(ep, JSON.parse(opts.body));
    return { status: r.status, json: async () => r.data };
  };
  const ctx = vm.createContext({
    document, chrome, fetch: fetchMock, AbortController, window: { matchMedia: () => ({ matches: false }) }, matchMedia: () => ({ matches: false }),
    setTimeout, clearTimeout, setInterval: () => 0, console, indexedDB: { open() { return {}; } }, URL, Blob, Promise, Date
  });
  ['shared.js', 'config.js', 'api.js'].forEach((f) => vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f }));
  vm.runInContext("WAQS_CONFIG.API_BASE = 'https://example.test/api'; WAQS_CONFIG.REGISTER_URL = 'https://example.test/register.php';", ctx);
  process.on('unhandledRejection', (e) => { console.error('UNHANDLED', e); process.exitCode = 1; });
  vm.runInContext(fs.readFileSync(path.join(root, 'panel.js'), 'utf8'), ctx, { filename: 'panel.js' });
  return { el, store, fetched };
}

const user = { email: 'a@b.co', name: 'A', daily_cap: 50, used_today: 3, expires_at: null };
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

(async () => {
  console.log('Side panel (fake DOM)');

  await test('logged out: shows the login form, hides the app', async () => {
    const w = run({}, () => ({ status: 200, data: {} }));
    await sleep(50);
    assert.strictEqual(w.el('loginView').hidden, false);
    assert.strictEqual(w.el('appView').hidden, true);
    assert.strictEqual(w.el('userBar').hidden, true);
    assert.strictEqual(w.el('startBtn').disabled, true);
  });

  await test('login success: stores the token, shows the app and the daily limit', async () => {
    const w = run({}, (ep) => (ep === 'login.php' ? { status: 200, data: { ok: true, token: 't'.repeat(64), user } } : { status: 200, data: { ok: true, user } }));
    await sleep(50);
    w.el('loginEmail').value = 'a@b.co';
    w.el('loginPass').value = 'secret123';
    await w.el('loginForm')._l.submit({ preventDefault() {} });
    await sleep(50);
    assert.strictEqual(w.store.auth.token, 't'.repeat(64));
    assert.strictEqual(w.el('appView').hidden, false);
    assert.strictEqual(w.el('loginView').hidden, true);
    assert.match(w.el('limitInfo').textContent, /50 messages per day.*Used today: 3 \(47 left\)/);
    assert.strictEqual(w.el('loginPass').value, '', 'password field must be cleared');
  });

  await test('login failure (email not registered): shows the server message, stays logged out', async () => {
    const w = run({}, () => ({ status: 401, data: { ok: false, error: 'Wrong email or password, or this email is not registered with us.' } }));
    await sleep(50);
    w.el('loginEmail').value = 'x@y.co';
    w.el('loginPass').value = 'nope';
    await w.el('loginForm')._l.submit({ preventDefault() {} });
    await sleep(50);
    assert.match(w.el('loginErr').textContent, /not registered/);
    assert.ok(!w.store.auth);
    assert.strictEqual(w.el('appView').hidden, true);
  });

  await test('saved login that the server rejects (blocked): returns to the login form with the reason', async () => {
    const w = run({ auth: { token: 't'.repeat(64), email: 'a@b.co', daily_cap: 5, used_today: 0 } },
      () => ({ status: 403, data: { ok: false, code: 'blocked', error: 'Your account is disabled. Please contact the administrator.' } }));
    await sleep(100);
    assert.ok(!w.store.auth, 'login must be forgotten');
    assert.strictEqual(w.el('loginView').hidden, false);
    assert.match(w.el('loginErr').textContent, /disabled/);
  });

  await test('server offline at startup: keeps the cached login', async () => {
    const w = run({ auth: { token: 't'.repeat(64), email: 'a@b.co', daily_cap: 5, used_today: 0 } }, () => { throw new Error('offline'); });
    await sleep(100);
    assert.ok(w.store.auth);
    assert.strictEqual(w.el('appView').hidden, false);
  });

  await test('old settings (delaySec) are migrated and capped to the supported range', async () => {
    const w = run({ auth: { token: 't'.repeat(64), email: 'a@b.co', daily_cap: 5, used_today: 0 }, settings: { delaySec: 25 } }, () => ({ status: 200, data: { ok: true, user } }));
    await sleep(100);
    assert.strictEqual(w.el('delayMinInput').value, 20);
    assert.strictEqual(w.el('delayMaxInput').value, 20);
  });

  await test('delay inputs are validated (range 1-20, max >= min) and saved', async () => {
    const w = run({ auth: { token: 't'.repeat(64), email: 'a@b.co', daily_cap: 5, used_today: 0 } }, () => ({ status: 200, data: { ok: true, user } }));
    await sleep(100);
    w.el('delayMinInput').value = '0'; w.el('delayMaxInput').value = '0';
    w.el('delayMinInput')._l.change();
    await sleep(30);
    assert.strictEqual(w.store.settings.delayMin, 1);
    assert.strictEqual(w.store.settings.delayMax, 1);
    w.el('delayMinInput').value = '20'; w.el('delayMaxInput').value = '45';
    w.el('delayMaxInput')._l.change();
    await sleep(30);
    assert.deepStrictEqual([w.store.settings.delayMin, w.store.settings.delayMax], [20, 20]);
  });

  await test('logout clears the stored login and calls the server', async () => {
    const w = run({ auth: { token: 't'.repeat(64), email: 'a@b.co', daily_cap: 5, used_today: 0 } }, () => ({ status: 200, data: { ok: true, user } }));
    await sleep(100);
    await w.el('logoutBtn')._l.click();
    await sleep(30);
    assert.ok(!w.store.auth);
    assert.ok(w.fetched.includes('logout.php'));
    assert.strictEqual(w.el('loginView').hidden, false);
  });

  console.log('\n' + passed + ' panel tests passed' + (process.exitCode ? ' — SOME FAILED' : ''));
  process.exit(process.exitCode || 0);
})();
