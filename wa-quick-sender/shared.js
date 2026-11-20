/* shared.js — pure helpers used by the side panel, the background worker, the content script
   and the Node tests. No DOM and no chrome.* calls in here. */
var WAQS = (function () {
  'use strict';

  var MEDIA_MAX = 16 * 1024 * 1024;   // photos / videos sent as media
  var DOC_MAX = 100 * 1024 * 1024;    // everything else is sent as a document
  var CAPTION_MAX = 1024;             // WhatsApp caption limit
  var MIN_DELAY = 1;                  // seconds
  var MAX_DELAY = 20;

  // Country code -> expected length of the national number (used to tell "91 98765 43210" from "9123456789").
  var NATIONAL_LEN = { '91': 10, '1': 10, '44': 10, '971': 9, '966': 9, '92': 10, '880': 10, '977': 10, '94': 9, '61': 9, '65': 8 };

  var COUNTRIES = [
    ['91', 'India (+91)'], ['1', 'US / Canada (+1)'], ['44', 'UK (+44)'], ['971', 'UAE (+971)'],
    ['966', 'Saudi Arabia (+966)'], ['92', 'Pakistan (+92)'], ['880', 'Bangladesh (+880)'],
    ['94', 'Sri Lanka (+94)'], ['977', 'Nepal (+977)'], ['61', 'Australia (+61)'], ['65', 'Singapore (+65)'],
    ['60', 'Malaysia (+60)'], ['49', 'Germany (+49)'], ['33', 'France (+33)'], ['55', 'Brazil (+55)'],
    ['27', 'South Africa (+27)'], ['234', 'Nigeria (+234)'], ['254', 'Kenya (+254)']
  ];

  /* ---------- text helpers ---------- */

  // NFC, strip invisible direction marks WhatsApp likes to add, collapse whitespace.
  function normalizeName(s) {
    return String(s == null ? '' : s).normalize('NFC')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')
      .replace(/[\s\u00a0]+/g, ' ').trim();
  }
  function nameKey(s) { return normalizeName(s).toLowerCase(); }

  // Letters+digits only, lower-case. Used to compare text loosely (WhatsApp turns *bold* into bold, etc.).
  function alnumKey(s) {
    return String(s == null ? '' : s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  }

  function dedupeBy(arr, keyFn) {
    var seen = new Set(), out = [];
    arr.forEach(function (x) {
      var k = keyFn(x);
      if (!seen.has(k)) { seen.add(k); out.push(x); }
    });
    return out;
  }

  // One chat/group name per line, de-duplicated (case-insensitive).
  function parseNames(text) {
    var names = String(text || '').split(/\r?\n/).map(normalizeName).filter(Boolean);
    return dedupeBy(names, nameKey);
  }

  // {name} placeholder. When the name is unknown the placeholder is removed and the spacing/punctuation tidied.
  function applyPlaceholders(template, name) {
    var n = String(name == null ? '' : name).trim();
    var out = String(template == null ? '' : template).replace(/\{\s*name\s*\}/gi, function () { return n; });
    if (!n) {
      out = out.replace(/^[ \t]*[,;:][ \t]*/, '')
        .replace(/[ \t]+([,.!?:;])/g, '$1')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/[ \t]+$/gm, '');
    }
    return out;
  }

  /* ---------- phone numbers ---------- */

  function bad(raw, reason) { return { ok: false, raw: raw, reason: reason }; }

  // Returns { ok, number (digits only, with country code), raw, reason }.
  function cleanPhone(raw, cc) {
    cc = String(cc || '91').replace(/\D/g, '') || '91';
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return bad(s, 'Empty');
    if (/\p{L}/u.test(s)) return bad(s, 'Contains letters');
    var stripped = s.replace(/[\s\-().\u00a0]/g, '');
    if (/[^\d+]/.test(stripped) || stripped.indexOf('+', 1) !== -1) return bad(s, 'Unexpected characters');
    var plus = stripped.charAt(0) === '+';
    var digits = stripped.replace(/\D/g, '');
    if (!digits) return bad(s, 'No digits');

    var natLen = NATIONAL_LEN[cc] || 10;
    var num;
    if (plus) {
      num = digits;                                   // +91 98765 43210
    } else if (digits.indexOf('00') === 0) {
      num = digits.slice(2);                          // 0091 98765 43210
    } else if (digits.length > natLen && digits.indexOf(cc) === 0) {
      var rest = digits.slice(cc.length);             // 91 98765 43210  /  91 098765 43210
      if (rest.charAt(0) === '0' && rest.length === natLen + 1) rest = rest.slice(1);
      num = cc + rest;
    } else {
      num = cc + (digits.charAt(0) === '0' ? digits.slice(1) : digits);   // 098765 43210 / 98765 43210
    }

    if (num.charAt(0) === '0') return bad(s, 'Invalid country code');
    if (num.length < 8) return bad(s, 'Too short');
    if (num.length > 15) return bad(s, 'Too long');
    if (num.indexOf('91') === 0) {                    // India: 91 + 10 digits starting 6-9
      if (num.length !== 12) return bad(s, 'Indian numbers need 10 digits');
      if (!/^[6-9]/.test(num.slice(2))) return bad(s, 'Indian mobile numbers start with 6-9');
    }
    return { ok: true, number: num, raw: s };
  }

  // Splits on new lines / commas / semicolons, cleans, de-duplicates.
  function parseNumbers(text, cc) {
    var tokens = String(text || '').split(/[\n\r,;]+/).map(function (t) { return t.trim(); }).filter(Boolean);
    var valid = [], invalid = [], seen = new Set(), duplicates = 0;
    tokens.forEach(function (t) {
      var r = cleanPhone(t, cc);
      if (!r.ok) { invalid.push({ raw: t, reason: r.reason }); return; }
      if (seen.has(r.number)) { duplicates++; return; }
      seen.add(r.number);
      valid.push({ number: r.number, raw: t });
    });
    return { valid: valid, invalid: invalid, duplicates: duplicates };
  }

  /* ---------- CSV ---------- */

  // Small RFC-4180 style parser: quotes, escaped quotes, CRLF, BOM, auto-detected , ; or tab delimiter.
  function parseCSV(text) {
    text = String(text || '').replace(/^\uFEFF/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = ',', best = 0;
    [',', ';', '\t'].forEach(function (d) {
      var c = first.split(d).length - 1;
      if (c > best) { best = c; delim = d; }
    });
    var rows = [], row = [], field = '', inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);
      if (inQ) {
        if (c === '"') {
          if (text.charAt(i + 1) === '"') { field += '"'; i++; } else inQ = false;
        } else field += c;
      } else if (c === '"' && field === '') {
        inQ = true;
      } else if (c === delim) {
        row.push(field); field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text.charAt(i + 1) === '\n') i++;
        row.push(field); field = ''; rows.push(row); row = [];
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows
      .map(function (r) { return r.map(function (x) { return String(x).trim(); }); })
      .filter(function (r) { return r.some(function (x) { return x !== ''; }); });
  }

  function looksLikeNumber(v) {
    v = String(v || '');
    return /^[\d\s+\-().]+$/.test(v) && v.replace(/\D/g, '').length >= 7;
  }

  // rows -> [{ name, raw }]. Accepts one column of numbers, or name + number (any order, header optional).
  function csvToContacts(rows) {
    if (!rows || !rows.length) return [];
    var header = rows[0];
    var hasHeader = !header.some(looksLikeNumber);
    var numCol = -1, nameCol = -1;
    if (hasHeader) {
      header.forEach(function (h, i) {
        var l = String(h).toLowerCase();
        if (numCol < 0 && /phone|number|mobile|whatsapp|tel|cell|msisdn/.test(l)) numCol = i;
        else if (nameCol < 0 && /name/.test(l)) nameCol = i;
      });
    }
    var data = hasHeader ? rows.slice(1) : rows;
    if (numCol < 0) {
      var sample = data[0] || [];
      for (var i = 0; i < sample.length; i++) if (looksLikeNumber(sample[i])) { numCol = i; break; }
      if (numCol < 0) numCol = 0;
    }
    if (nameCol < 0) {
      var width = Math.max.apply(null, [1].concat(data.map(function (r) { return r.length; })));
      if (width > 1) nameCol = numCol === 0 ? 1 : 0;
    }
    var out = [];
    data.forEach(function (r) {
      var raw = r[numCol] || '';
      if (!raw) return;
      out.push({ name: nameCol >= 0 ? (r[nameCol] || '') : '', raw: raw });
    });
    return out;
  }

  /* ---------- results CSV ---------- */

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // spreadsheet formula-injection guard
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function statusLabel(st) {
    return st === 'sent' ? 'Sent' : st === 'failed' ? 'Failed' : 'Not sent';
  }

  function buildResultsCsv(campaign) {
    var lines = [['#', 'Type', 'Recipient', 'Number or chat name', 'Status', 'Reason', 'Time'].join(',')];
    (campaign.recipients || []).forEach(function (r, i) {
      var st = r.status === 'sending' ? 'failed' : r.status;
      var reason = r.reason || (r.status === 'skipped' ? 'Stopped before sending' : r.status === 'waiting' ? 'Not reached' : '');
      lines.push([
        i + 1, r.type === 'number' ? 'Number' : 'Chat', r.name || '', r.value,
        statusLabel(st), reason, r.time ? new Date(r.time).toISOString() : ''
      ].map(csvCell).join(','));
    });
    return lines.join('\r\n') + '\r\n';
  }

  /* ---------- files ---------- */

  // Types WhatsApp's "Photos & videos" input accepts; everything else goes through the "Document" input.
  function isMediaType(type) {
    return /^image\/(jpeg|png|gif|webp)$/i.test(type || '') || /^video\/(mp4|3gpp|quicktime)$/i.test(type || '');
  }
  function limitFor(type) { return isMediaType(type) ? MEDIA_MAX : DOC_MAX; }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  // Random whole-second delay between min and max (both inclusive).
  function randomDelay(min, max, rnd, floor) {
    floor = Math.min(MAX_DELAY, floor == null ? MIN_DELAY : floor);
    min = Math.min(MAX_DELAY, Math.max(floor, Math.floor(Number(min) || floor)));
    max = Math.min(MAX_DELAY, Math.max(min, Math.floor(Number(max) || min)));
    var r = typeof rnd === 'function' ? rnd() : Math.random();
    return Math.min(max, min + Math.floor(r * (max - min + 1)));
  }
  function todayKey(d) {
    d = d || new Date();
    var p = function (x) { return (x < 10 ? '0' : '') + x; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  return {
    MEDIA_MAX: MEDIA_MAX, DOC_MAX: DOC_MAX, CAPTION_MAX: CAPTION_MAX,
    MIN_DELAY: MIN_DELAY, MAX_DELAY: MAX_DELAY, COUNTRIES: COUNTRIES,
    normalizeName: normalizeName, nameKey: nameKey, alnumKey: alnumKey, dedupeBy: dedupeBy, parseNames: parseNames,
    applyPlaceholders: applyPlaceholders, cleanPhone: cleanPhone, parseNumbers: parseNumbers,
    parseCSV: parseCSV, csvToContacts: csvToContacts, csvCell: csvCell, buildResultsCsv: buildResultsCsv,
    isMediaType: isMediaType, limitFor: limitFor, formatBytes: formatBytes, todayKey: todayKey, randomDelay: randomDelay
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = WAQS;
