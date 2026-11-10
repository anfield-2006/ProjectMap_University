const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../js/engine.js');

const MON = (h, m = 0) => new Date(2026, 10, 16, h, m); // Monday 16 Nov 2026

test('traffic profile: weekday morning rush is heavier than evening-before-rush and night', () => {
  const am = E.profileFactor(MON(7, 30));
  const pm5 = E.profileFactor(MON(17, 0));
  const night = E.profileFactor(MON(23, 0));
  const satAm = E.profileFactor(new Date(2026, 10, 21, 7, 30));
  assert.ok(am > 1.7, `am=${am}`);
  assert.ok(pm5 > 1.5 && pm5 < am, `pm5=${pm5}`);
  assert.equal(night, 1);
  assert.ok(satAm < 1.1, 'Saturday morning is not a commute rush');
});

test('Monday 17:00 plan uses evening analysis, not the morning rush', () => {
  const free = 25;
  const morning = E.solveDeparture(MON(8, 0), free, { mode: 'car' });
  const evening = E.solveDeparture(MON(17, 0), free, { mode: 'car' });
  const late = E.solveDeparture(MON(21, 30), free, { mode: 'car' });
  assert.ok(morning.minutes > evening.minutes, `morning ${morning.minutes} vs evening ${evening.minutes}`);
  assert.ok(evening.minutes > late.minutes);
  // fixed point: departure + duration == arrival (within a minute)
  assert.ok(Math.abs(+morning.departure + morning.minutes * E.MIN - +MON(8, 0)) < E.MIN);
});

test('non-congestion modes ignore traffic', () => {
  const walk = E.predictDuration(30, MON(7, 30), { mode: 'walk' });
  assert.equal(walk.minutes, 30);
});

test('Monte Carlo is deterministic per seed and quantiles are ordered', () => {
  const a = E.simulateTrip(30, { factor: 1.6, km: 12, seed: 42 });
  const b = E.simulateTrip(30, { factor: 1.6, km: 12, seed: 42 });
  assert.equal(a.p95, b.p95);
  assert.ok(a.p50 < a.p85 && a.p85 < a.p95 && a.p95 < a.p98);
  assert.ok(Math.abs(a.probWithin(a.p95) - 0.95) < 0.01);
  const calm = E.simulateTrip(30, { factor: 1.0, km: 12, seed: 42 });
  assert.ok(a.p95 - 30 > calm.p95 - 30, 'rush hour needs a larger buffer');
});

test('buildPlan backward-schedules wake time (school at 08:00 example)', () => {
  const plan = E.buildPlan({
    eventStart: MON(8, 0), arriveEarlyMin: 10, freeMin: 20, km: 9, mode: 'car', importance: 'important',
    prepTasks: [
      { id: 'shower', label: 'อาบน้ำ', min: 15 },
      { id: 'dress', label: 'แต่งตัว', min: 10 },
      { id: 'eat', label: 'กินข้าว', min: 20 },
    ],
    wakeBufferMin: 5, seed: 7,
  });
  const ids = plan.steps.map((s) => s.id);
  assert.deepEqual(ids, ['wake', 'shower', 'dress', 'eat', 'depart', 'arrive']);
  // contiguous chain
  for (let i = 1; i < plan.steps.length; i++) assert.equal(+plan.steps[i].start, +plan.steps[i - 1].end);
  assert.equal(+plan.arrival, +MON(7, 50));
  assert.equal((plan.departure - plan.wake) / E.MIN, 50);
  assert.ok(plan.travelMin > 20, 'morning rush lengthens the trip');
  assert.ok(plan.bufferMin >= 5 && plan.bufferMin % 5 === 0);
  assert.ok(plan.onTimeProb >= 0.94);
  assert.ok(plan.wake < MON(7, 0));
  assert.equal(plan.bedtimes[0].cycles, 6);
});

test('a ~20 min city trip gets a small buffer, never hours', () => {
  const p = E.buildPlan({ eventStart: MON(8, 0), freeMin: 12, km: 8, importance: 'important', seed: 9, prepTasks: [] });
  assert.ok(p.bufferMin <= 10, `buffer ${p.bufferMin}`);
  // even a wrong 450 km route cannot explode the buffer beyond 60 min
  const far = E.buildPlan({ eventStart: MON(8, 0), freeMin: 400, km: 450, importance: 'critical', seed: 9, prepTasks: [] });
  assert.ok(far.bufferMin <= 60, `far buffer ${far.bufferMin}`);
});

test('Google Maps traffic-aware minutes are used as-is', () => {
  const p = E.buildPlan({ eventStart: MON(8, 0), freeMin: 12, km: 8, fixedTravelMin: 20, importance: 'important', seed: 9, prepTasks: [] });
  assert.equal(p.travelMin, 20);
  assert.equal(p.travelSource, 'google');
  assert.ok(p.bufferMin >= 5 && p.bufferMin <= 10, `buffer ${p.bufferMin}`);
});

test('critical importance yields a bigger buffer than normal', () => {
  const base = { eventStart: MON(8, 0), freeMin: 30, km: 15, seed: 3, prepTasks: [] };
  const n = E.buildPlan({ ...base, importance: 'normal' });
  const c = E.buildPlan({ ...base, importance: 'critical' });
  assert.ok(c.bufferMin > n.bufferMin);
});

test('EWMA learning moves the factor toward observed trips', () => {
  let learned = {};
  // the app predicts with the current learned factor, then feeds back the real duration
  for (let i = 0; i < 15; i++) {
    const predicted = 30 * E.learnedFactor(learned, MON(7, 10));
    learned = E.learnFromTrip(learned, MON(7, 10), predicted, 39);
  }
  const f = learned['wd-7'];
  assert.ok(f > 1.25 && f <= 1.31, `f=${f}`);
  const pred = E.predictDuration(20, MON(7, 10), { learned });
  const base = E.predictDuration(20, MON(7, 10), {});
  assert.ok(pred.minutes > base.minutes);
});

test('sweep-line finds overlaps only', () => {
  const c = E.findConflicts([
    { id: 'a', start: MON(8), end: MON(10) },
    { id: 'b', start: MON(9, 30), end: MON(11) },
    { id: 'c', start: MON(11), end: MON(12) },
  ]);
  assert.deepEqual(c.map((x) => `${x.a}-${x.b}`), ['a-b']);
  assert.equal(c[0].overlapMin, 30);
});

test('min-heap pops in time order', () => {
  const h = new E.MinHeap((x) => x);
  [5, 1, 9, 3, 7, 2].forEach((x) => h.push(x));
  const out = []; while (h.size) out.push(h.pop());
  assert.deepEqual(out, [1, 2, 3, 5, 7, 9]);
});

test('recurrence and reminders 7/3/1 days', () => {
  const act = { id: 'x', title: 'สอบ', date: '2026-11-25', time: '09:00', reminders: { d1: true, d3: true, d7: true } };
  const occ = E.nextOccurrence(act, new Date(2026, 10, 11));
  assert.equal(+occ, +new Date(2026, 10, 25, 9, 0));
  const rem = E.buildReminders(act, occ, null);
  assert.deepEqual(rem.map((r) => r.days), [7, 3, 1]);
  const weekly = { id: 'y', repeat: [1, 3], time: '08:00' };
  assert.equal(+E.nextOccurrence(weekly, new Date(2026, 10, 11, 9)), +new Date(2026, 10, 16, 8));
  assert.equal(+E.nextOccurrence(weekly, new Date(2026, 10, 11, 7)), +new Date(2026, 10, 11, 8));
});

test('ics export contains alarms and Google Maps link is well formed', () => {
  const act = { id: 'x', title: 'สอบ', date: '2026-11-25', time: '09:00', reminders: { d1: true, d7: true } };
  const occ = new Date(2026, 10, 25, 9);
  const plan = E.buildPlan({ eventStart: occ, freeMin: 20, km: 8, seed: 1, prepTasks: [{ id: 's', label: 's', min: 15 }] });
  const ics = E.makeICS([{ activity: act, occurrence: occ, plan }]);
  assert.match(ics, /TRIGGER:-P7D/);
  assert.match(ics, /TRIGGER:-P1D/);
  assert.match(ics, /ACTION:AUDIO/);
  const link = E.googleMapsLink({ lat: 7.89, lng: 98.35 }, { lat: 7.9, lng: 98.3 }, 'car');
  assert.match(link, /^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=7\.89%2C98\.35/);
});
