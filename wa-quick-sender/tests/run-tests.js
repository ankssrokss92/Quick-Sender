/* Run with:  node tests/run-tests.js   (no dependencies) */
'use strict';
const assert = require('assert');
const W = require('../shared.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
const num = (raw, cc) => { const r = W.cleanPhone(raw, cc); return r.ok ? r.number : 'INVALID:' + r.reason; };

console.log('Phone cleaning');
test('10 digits get +91', () => assert.strictEqual(num('9876543210'), '919876543210'));
test('spaces and dashes removed', () => assert.strictEqual(num('98765 43210'), '919876543210'));
test('+91 with dashes', () => assert.strictEqual(num('+91 98765-43210'), '919876543210'));
test('brackets', () => assert.strictEqual(num('(+91) 98765 43210'), '919876543210'));
test('91 prefix without plus', () => assert.strictEqual(num('919876543210'), '919876543210'));
test('0091 prefix', () => assert.strictEqual(num('0091 9876543210'), '919876543210'));
test('leading 0', () => assert.strictEqual(num('09876543210'), '919876543210'));
test('91 followed by trunk 0', () => assert.strictEqual(num('91 09876543210'), '919876543210'));
test('10-digit number that starts with 91 is national', () => assert.strictEqual(num('9123456789'), '919123456789'));
test('dots as separators', () => assert.strictEqual(num('98765.43210'), '919876543210'));
test('other country with plus (US)', () => assert.strictEqual(num('+1 (415) 555-2671'), '14155552671'));
test('UK with plus', () => assert.strictEqual(num('+44 7911 123456'), '447911123456'));
test('UK national number with trunk 0 and cc=44', () => assert.strictEqual(num('07911 123456', '44'), '447911123456'));
test('US national number with cc=1', () => assert.strictEqual(num('415-555-2671', '1'), '14155552671'));
test('too short', () => assert.strictEqual(num('12345'), 'INVALID:Too short'));
test('Indian number needs 10 digits', () => assert.strictEqual(num('+91 98765'), 'INVALID:Too short'));
test('Indian number starting with 5', () => assert.strictEqual(num('5876543210'), 'INVALID:Indian mobile numbers start with 6-9'));
test('too long', () => assert.strictEqual(num('98765432101234567'), 'INVALID:Too long'));
test('letters rejected', () => assert.strictEqual(num('98765abc10'), 'INVALID:Contains letters'));
test('empty rejected', () => assert.strictEqual(num('   '), 'INVALID:Empty'));
test('stray characters rejected', () => assert.strictEqual(num('9876#543210'), 'INVALID:Unexpected characters'));
test('plus in the middle rejected', () => assert.strictEqual(num('98765+43210'), 'INVALID:Unexpected characters'));
test('+0 rejected', () => assert.strictEqual(num('+0123456789'), 'INVALID:Invalid country code'));

console.log('Number list parsing');
test('mixed separators, dedupe and invalid', () => {
  const r = W.parseNumbers('9876543210, +91 98765 43210\n09876543211;abc\n\n919876543212\n12345', '91');
  assert.deepStrictEqual(r.valid.map((v) => v.number), ['919876543210', '919876543211', '919876543212']);
  assert.strictEqual(r.duplicates, 1);
  assert.deepStrictEqual(r.invalid.map((i) => i.raw), ['abc', '12345']);
});
test('empty input', () => {
  const r = W.parseNumbers('', '91');
  assert.strictEqual(r.valid.length + r.invalid.length + r.duplicates, 0);
});

console.log('CSV parsing');
test('quotes, embedded comma, CRLF, BOM', () => {
  const rows = W.parseCSV('\uFEFFName,Phone\r\nAsha,98765 43210\r\n"Roy, Jr",+91 99999 88888\r\n');
  assert.deepStrictEqual(rows, [['Name', 'Phone'], ['Asha', '98765 43210'], ['Roy, Jr', '+91 99999 88888']]);
});
test('escaped quote and embedded newline', () => {
  const rows = W.parseCSV('a,b\n"he said ""hi""","line1\nline2"\n');
  assert.deepStrictEqual(rows[1], ['he said "hi"', 'line1\nline2']);
});
test('semicolon delimiter', () => {
  assert.deepStrictEqual(W.parseCSV('Name;Number\nAsha;9876543210'), [['Name', 'Number'], ['Asha', '9876543210']]);
});
test('blank lines are skipped', () => assert.strictEqual(W.parseCSV('1\n\n\n2\n').length, 2));
test('single column of numbers (no header)', () => {
  const c = W.csvToContacts(W.parseCSV('9876543210\n9123456789'));
  assert.deepStrictEqual(c, [{ name: '', raw: '9876543210' }, { name: '', raw: '9123456789' }]);
});
test('single column with header', () => {
  const c = W.csvToContacts(W.parseCSV('number\n9876543210'));
  assert.deepStrictEqual(c, [{ name: '', raw: '9876543210' }]);
});
test('name + number with header', () => {
  const c = W.csvToContacts(W.parseCSV('Name,Phone\nAsha,98765 43210\n"Roy, Jr",+91 99999 88888'));
  assert.deepStrictEqual(c, [{ name: 'Asha', raw: '98765 43210' }, { name: 'Roy, Jr', raw: '+91 99999 88888' }]);
});
test('number + name without header', () => {
  const c = W.csvToContacts(W.parseCSV('9876543210,Asha\n9123456789,Ravi'));
  assert.deepStrictEqual(c, [{ name: 'Asha', raw: '9876543210' }, { name: 'Ravi', raw: '9123456789' }]);
});
test('"Contact Name" header is the name column', () => {
  const c = W.csvToContacts(W.parseCSV('Contact Name,Mobile Number\nAsha,9876543210'));
  assert.deepStrictEqual(c, [{ name: 'Asha', raw: '9876543210' }]);
});

console.log('Placeholders');
test('{name} replaced', () => assert.strictEqual(W.applyPlaceholders('Hi {name}, offer!', 'Asha'), 'Hi Asha, offer!'));
test('case-insensitive and spaced', () => assert.strictEqual(W.applyPlaceholders('{ NAME } / {Name}', 'Raj'), 'Raj / Raj'));
test('unknown name tidies punctuation', () => assert.strictEqual(W.applyPlaceholders('Hi {name}, offer!', ''), 'Hi, offer!'));
test('unknown name at the start', () => assert.strictEqual(W.applyPlaceholders('{name}, hello', ''), 'hello'));
test('newlines are preserved', () => assert.strictEqual(W.applyPlaceholders('Hi {name}\n\nBye', ''), 'Hi\n\nBye'));
test('special replacement patterns in names are literal', () => assert.strictEqual(W.applyPlaceholders('Hi {name}', 'A$&B'), 'Hi A$&B'));
test('no placeholder: text untouched', () => assert.strictEqual(W.applyPlaceholders('Hello  world', ''), 'Hello world'));

console.log('De-duplication and names');
test('dedupeBy keeps first', () => assert.deepStrictEqual(W.dedupeBy([1, 2, 1, 3, 2], (x) => x), [1, 2, 3]));
test('parseNames dedupes case-insensitively and trims', () => {
  assert.deepStrictEqual(W.parseNames('  Family  Group \nfamily group\n\nPriya'), ['Family Group', 'Priya']);
});
test('normalizeName strips invisible marks', () => assert.strictEqual(W.normalizeName('\u200eAsha\u00a0 Rao\u200f'), 'Asha Rao'));
test('alnumKey ignores formatting', () => assert.strictEqual(W.alnumKey('*Hello*, World! 123'), 'helloworld123'));

console.log('Files, limits and results CSV');
test('media vs document limits', () => {
  assert.strictEqual(W.limitFor('image/jpeg'), 16 * 1024 * 1024);
  assert.strictEqual(W.limitFor('video/mp4'), 16 * 1024 * 1024);
  assert.strictEqual(W.limitFor('application/pdf'), 100 * 1024 * 1024);
  assert.strictEqual(W.limitFor('video/x-matroska'), 100 * 1024 * 1024);
});
test('formatBytes', () => assert.strictEqual(W.formatBytes(1536), '1.5 KB'));
test('results CSV: quoting, injection guard and honest labels', () => {
  const csv = W.buildResultsCsv({ recipients: [
    { type: 'chat', name: 'Say "hi", team', value: 'Say "hi", team', status: 'sent', reason: '', time: 0 },
    { type: 'number', name: '=cmd()', value: '919876543210', status: 'failed', reason: 'Number is not on WhatsApp', time: 0 },
    { type: 'number', name: '', value: '919876543211', status: 'skipped', reason: '' }
  ] });
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines[0], '#,Type,Recipient,Number or chat name,Status,Reason,Time');
  assert.ok(lines[1].includes('"Say ""hi"", team"') && lines[1].includes(',Sent,'));
  assert.ok(lines[2].includes("'=cmd()") && lines[2].includes(',Failed,Number is not on WhatsApp,'));
  assert.ok(lines[3].includes(',Not sent,Stopped before sending'));
  assert.ok(!/Delivered|Read/.test(csv));
});

console.log('Random delay');
test('always within [min, max] and the supported 1-20 s range', () => {
  for (let i = 0; i < 2000; i++) { const d = W.randomDelay(1, 20); assert.ok(d >= 1 && d <= 20 && Number.isInteger(d)); }
  for (let i = 0; i < 500; i++) { assert.ok(W.randomDelay(0, 5) >= 1); }
  assert.strictEqual(W.randomDelay(15, 40, () => 0.999999), 20);
});
test('hits both ends of the range', () => {
  assert.strictEqual(W.randomDelay(1, 20, () => 0), 1);
  assert.strictEqual(W.randomDelay(1, 20, () => 0.999999), 20);
  assert.strictEqual(W.randomDelay(1, 20, () => 1), 20);
});
test('max below min is treated as min; junk input falls back to the floor', () => {
  assert.strictEqual(W.randomDelay(30, 12, () => 0.5), 20);
  assert.strictEqual(W.randomDelay('x', undefined, () => 0.5), 1);
});
test('can use a custom floor', () => assert.strictEqual(W.randomDelay(1, 1, () => 0.5, 0), 1));
test('is not constant (it really is random)', () => {
  const seen = new Set(); for (let i = 0; i < 300; i++) seen.add(W.randomDelay(1, 20));
  assert.ok(seen.size > 10);
});

console.log('\n' + passed + ' tests passed' + (process.exitCode ? ' — SOME FAILED' : ''));
