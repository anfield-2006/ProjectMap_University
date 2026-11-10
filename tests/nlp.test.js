const test = require('node:test');
const assert = require('node:assert/strict');
const N = require('../js/nlp.js');

// Wednesday 11 Nov 2026, 20:00
const NOW = new Date(2026, 10, 11, 20, 0);

test('number words only convert in numeric context', () => {
  assert.equal(N.thaiWordToNum('สิบห้า'), 15);
  assert.equal(N.thaiWordToNum('ยี่สิบ'), 20);
  assert.equal(N.thaiWordToNum('สามสิบห้า'), 35);
  assert.match(N.normalize('ไปห้างเซ็นทรัล'), /ห้าง/);
  assert.match(N.normalize('แปดโมงเช้า'), /8 โมงเช้า/);
});

test('parseDuration handles Thai phrasing', () => {
  assert.equal(N.parseDuration('ครึ่งชั่วโมง'), 30);
  assert.equal(N.parseDuration('ชั่วโมงนึง'), 60);
  assert.equal(N.parseDuration('1 ชม. 20 นาที'), 80);
  assert.equal(N.parseDuration('15-20 นาที'), 20);
  assert.equal(N.parseDuration('สิบห้านาที'), 15);
  assert.equal(N.parseDuration('ไม่กิน'), 0);
  assert.equal(N.parseDuration('๒๕'), 25);
  assert.equal(N.parseDuration('ชั่วโมงครึ่ง'), 90);
  assert.equal(N.parseDuration('อะไรนะ'), null);
});

test('parseTime handles Thai clock', () => {
  const t = (s) => { const r = N.parseTime(s); return r && `${r.h}:${String(r.m).padStart(2, '0')}`; };
  assert.equal(t('8 โมงเช้า'), '8:00');
  assert.equal(t('แปดโมงครึ่ง'), '8:30');
  assert.equal(t('บ่ายสอง'), '14:00');
  assert.equal(t('บ่ายโมง'), '13:00');
  assert.equal(t('4 โมงเย็น'), '16:00');
  assert.equal(t('สองทุ่ม'), '20:00');
  assert.equal(t('ทุ่มนึง'), '19:00');
  assert.equal(t('ตีห้า'), '5:00');
  assert.equal(t('เที่ยง'), '12:00');
  assert.equal(t('17.00 น.'), '17:00');
  assert.equal(t('09:30'), '9:30');
  assert.equal(t('เที่ยงคืน'), '0:00');
});

test('parseDate handles relative, weekday, explicit and repeat', () => {
  const d = (s) => { const r = N.parseDate(s, NOW); return r.date ? r.date.toDateString() : JSON.stringify(r.repeat); };
  assert.equal(d('พรุ่งนี้'), new Date(2026, 10, 12).toDateString());
  assert.equal(d('มะรืนนี้'), new Date(2026, 10, 13).toDateString());
  assert.equal(d('วันจันทร์'), new Date(2026, 10, 16).toDateString());
  assert.equal(d('วันพุธหน้า'), new Date(2026, 10, 18).toDateString());
  assert.equal(d('25/11'), new Date(2026, 10, 25).toDateString());
  assert.equal(d('3 ธ.ค. 69'), new Date(2026, 11, 3).toDateString());
  assert.equal(d('อีก 3 วัน'), new Date(2026, 10, 14).toDateString());
  assert.equal(d('ทุกวันจันทร์ถึงศุกร์'), '[1,2,3,4,5]');
  assert.equal(d('ทุกวันอังคาร พฤหัส'), '[2,4]');
});

test('classify by lexicon', () => {
  assert.equal(N.classify('สอบมิดเทอมวิชาแคลคูลัส').id, 'exam');
  assert.equal(N.classify('ไปเรียนที่มหาลัย').id, 'class');
  assert.equal(N.classify('ไปสนามบินขึ้นเครื่อง').id, 'flight');
  assert.equal(N.classify('นัดหมอฟัน').id, 'health');
});

test('parseActivity end-to-end (Intl.Segmenter fallback)', () => {
  const r = N.parseActivity('พรุ่งนี้ไปเรียนที่ ม.อ.ภูเก็ต 8 โมงเช้า', { now: NOW });
  assert.equal(r.time, '08:00');
  assert.equal(r.date, '2026-11-12');
  assert.equal(r.category.id, 'class');
  assert.match(r.place, /ม\.?อ\.?ภูเก็ต/);
  assert.match(r.placeQuery, /มหาวิทยาลัยสงขลานครินทร์/);
  assert.match(r.title, /เรียน/);

  const r2 = N.parseActivity('สอบไฟนอลวันจันทร์ บ่ายโมงครึ่ง ที่ตึก LRC', { now: NOW });
  assert.equal(r2.time, '13:30');
  assert.equal(r2.date, '2026-11-16');
  assert.equal(r2.category.importance, 'critical');
  assert.match(r2.place, /LRC/);
});

test('parseActivity with PyThaiNLP-style tokens', () => {
  const tokens = ['ประชุม', 'ที่', 'เซ็นทรัล', 'ภูเก็ต', 'วัน', 'จันทร์', 'หน้า', 'บ่าย', 'สอง', 'โมง', 'ครึ่ง'];
  const r = N.parseActivity('ประชุมที่เซ็นทรัลภูเก็ตวันจันทร์หน้าบ่ายสองโมงครึ่ง', { now: NOW, tokens, engine: 'pythainlp' });
  assert.equal(r.time, '14:30');
  assert.equal(r.place, 'เซ็นทรัลภูเก็ต');
  assert.equal(r.title, 'ประชุม');
  assert.equal(r.category.id, 'work');
});
