/* api.js — tiny client for the WA Quick Sender server. Used by the side panel and the background worker. */
var WAQS_API = (function () {
  'use strict';

  function base() {
    return String((typeof WAQS_CONFIG !== 'undefined' && WAQS_CONFIG.API_BASE) || '').replace(/\/+$/, '');
  }
  function configured() {
    var b = base();
    return /^https?:\/\//i.test(b) && !/YOUR-DOMAIN/i.test(b);
  }

  // POST JSON to <API_BASE>/<endpoint>. Resolves { status, data } for ANY HTTP status (data is {} if not JSON).
  // Rejects only when the server cannot be reached.
  async function call(endpoint, body, token) {
    if (!configured()) throw new Error('server address is not set (edit config.js)');
    var ctl = new AbortController();
    var timer = setTimeout(function () { ctl.abort(); }, 15000);
    try {
      var headers = { 'Content-Type': 'application/json' };
      if (token) headers.Authorization = 'Bearer ' + token;
      var payload = Object.assign({}, body || {}, token ? { token: token } : {});
      var r = await fetch(base() + '/' + endpoint, {
        method: 'POST', headers: headers, body: JSON.stringify(payload), signal: ctl.signal, cache: 'no-store'
      });
      var data = null;
      try { data = await r.json(); } catch (e) { data = null; }
      return { status: r.status, data: data || {} };
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? 'the server took too long to answer' : 'network error');
    } finally {
      clearTimeout(timer);
    }
  }

  return { call: call, configured: configured, base: base };
})();
