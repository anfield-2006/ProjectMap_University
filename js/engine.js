/*
 * ArriveWise — planning engine (pure functions, no DOM).
 * Works in the browser (window.AWEngine) and in Node (require) for tests.
 *
 * Algorithms used:
 *  1. Haversine distance                     — straight-line km between two GPS points
 *  2. Piecewise-linear traffic profile       — congestion factor by weekday + time of day
 *  3. Trip-window integration                — average congestion over the whole trip, not one instant
 *  4. Fixed-point backward solve             — departure depends on travel time, travel time depends on departure
 *  5. Exponential smoothing (EWMA) learning  — corrects the profile from the user's real trips
 *  6. Monte Carlo simulation (lognormal + Poisson incidents) — accident/incident safety buffer + on-time probability
 *  7. Backward scheduling                    — wake-up time = arrival − buffer − travel − prep steps
 *  8. Sleep-cycle (90 min) bedtime suggestion
 *  9. Sweep-line interval overlap            — schedule conflict detection, O(n log n)
 * 10. Binary min-heap                        — reminder/alarm queue
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AWEngine = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MIN = 60000;
  const DAY = 86400000;

  // ---------------------------------------------------------------- helpers
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const ceilTo = (v, step) => Math.ceil(v / step) * step;
  const addMin = (date, m) => new Date(date.getTime() + m * MIN);
  const pad2 = (n) => String(n).padStart(2, '0');
  const fmtHM = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  function parseYMD(s) {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function atTime(dateLike, hhmm) {
    const d = dateLike instanceof Date ? new Date(dateLike) : parseYMD(dateLike);
    const [h, m] = String(hhmm).split(':').map(Number);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
  }

  // ------------------------------------------------------------ 1. geo
  function haversineKm(a, b) {
    const R = 6371;
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /** Estimate road distance/time when no routing API is available. */
  function estimateRoute(a, b) {
    const straight = haversineKm(a, b);
    const km = straight * 1.35; // typical detour index for Thai urban roads
    const freeFlowKmh = km < 5 ? 28 : km < 20 ? 38 : 55;
    return { km, baseMin: (km / freeFlowKmh) * 60, source: 'estimate' };
  }

  // ------------------------------------------------------- travel modes
  const MODES = {
    car: { label: 'รถยนต์', emoji: '🚗', congestion: true, scale: 1, extra: 0, gmaps: 'driving' },
    motorbike: { label: 'มอเตอร์ไซค์', emoji: '🛵', congestion: true, scale: 0.85, extra: 2, gmaps: 'two-wheeler', congestionWeight: 0.55 },
    bus: { label: 'รถสาธารณะ', emoji: '🚌', congestion: true, scale: 1.45, extra: 10, gmaps: 'transit' },
    bicycle: { label: 'จักรยาน', emoji: '🚲', congestion: false, kmh: 14, extra: 0, gmaps: 'bicycling' },
    walk: { label: 'เดิน', emoji: '🚶', congestion: false, kmh: 4.8, extra: 0, gmaps: 'walking' },
  };

  /** Free-flow minutes for a mode, from a car-based route (OSRM gives car durations). */
  function modeBaseMinutes(route, mode) {
    const m = MODES[mode] || MODES.car;
    if (!m.congestion) return (route.km / m.kmh) * 60 + m.extra;
    return route.baseMin * m.scale + m.extra;
  }

  // ------------------------------------------------- 2. traffic profile
  // Control points [hour, congestion multiplier]. 1.0 = free flow.
  const PROFILES = {
    weekday: [
      [0, 1.0], [5, 1.0], [6, 1.15], [6.5, 1.35], [7, 1.6], [7.5, 1.78], [8, 1.7], [8.5, 1.5], [9, 1.32],
      [10, 1.15], [11.5, 1.2], [12, 1.28], [13, 1.2], [15, 1.2], [15.5, 1.32], [16, 1.42], [16.5, 1.55],
      [17, 1.68], [17.5, 1.78], [18, 1.72], [18.5, 1.55], [19, 1.38], [20, 1.15], [21, 1.05], [22, 1.0], [24, 1.0],
    ],
    weekend: [
      [0, 1.0], [8, 1.0], [9, 1.08], [10, 1.15], [11, 1.25], [12, 1.32], [14, 1.25], [16, 1.25],
      [17, 1.35], [18, 1.4], [19, 1.3], [20, 1.15], [21, 1.05], [24, 1.0],
    ],
  };
  // Day-specific emphasis applied to the excess over free flow.
  function dayEmphasis(dow, hour) {
    if (dow === 1 && hour < 12) return 1.1; // Monday morning rush
    if (dow === 5 && hour >= 15) return 1.15; // Friday evening exodus
    if (dow === 0 && hour >= 16) return 1.08; // Sunday return trips
    return 1;
  }

  function interp(points, h) {
    for (let i = 1; i < points.length; i++) {
      if (h <= points[i][0]) {
        const [h0, f0] = points[i - 1];
        const [h1, f1] = points[i];
        return f0 + ((f1 - f0) * (h - h0)) / (h1 - h0 || 1);
      }
    }
    return points[points.length - 1][1];
  }

  function dayType(dow) {
    return dow === 0 || dow === 6 ? 'weekend' : 'weekday';
  }

  /** Raw congestion multiplier at an instant. */
  function profileFactor(date) {
    const dow = date.getDay();
    const h = date.getHours() + date.getMinutes() / 60;
    const base = interp(PROFILES[dayType(dow)], h);
    return 1 + (base - 1) * dayEmphasis(dow, h);
  }

  // ------------------------------------------------ 5. EWMA learning
  const learnKey = (date) => `${dayType(date.getDay()) === 'weekend' ? 'we' : 'wd'}-${date.getHours()}`;

  function learnedFactor(learned, date) {
    if (!learned) return 1;
    const v = learned[learnKey(date)];
    return typeof v === 'number' ? v : 1;
  }

  /**
   * Update correction factor with an observed trip.
   * ratio = actual / predicted, smoothed with alpha (EWMA), clamped to a sane range.
   */
  function learnFromTrip(learned, departure, predictedMin, actualMin, alpha = 0.3) {
    const out = { ...(learned || {}) };
    if (!(predictedMin > 0) || !(actualMin > 0)) return out;
    const ratio = clamp(actualMin / predictedMin, 0.5, 2.5);
    const key = learnKey(departure);
    const prev = typeof out[key] === 'number' ? out[key] : 1;
    out[key] = +clamp(prev + alpha * (ratio * prev - prev), 0.6, 2).toFixed(4);
    return out;
  }

  // ------------------------------------------- 3. trip-window integration
  /** Average congestion over [departure, departure + minutes], sampled every 5 min. */
  function windowFactor(departure, minutes) {
    const steps = Math.max(1, Math.round(minutes / 5));
    let sum = 0;
    for (let i = 0; i <= steps; i++) sum += profileFactor(addMin(departure, (minutes * i) / steps));
    return sum / (steps + 1);
  }

  /**
   * Expected door-to-door minutes for a departure time.
   * opts: { mode, rain, learned }
   */
  function predictDuration(freeMin, departure, opts = {}) {
    const mode = MODES[opts.mode] || MODES.car;
    if (!mode.congestion) {
      return { minutes: freeMin * (opts.rain ? 1.1 : 1), factor: 1, peak: profileFactor(departure) };
    }
    const weight = mode.congestionWeight ?? 1; // motorbikes filter through jams
    // fixed point: the window length depends on the predicted duration itself
    let minutes = freeMin;
    let factor = 1;
    for (let i = 0; i < 6; i++) {
      const raw = windowFactor(departure, minutes);
      factor = 1 + (raw - 1) * weight;
      factor *= learnedFactor(opts.learned, departure);
      if (opts.rain) factor *= 1.2;
      const next = freeMin * factor;
      if (Math.abs(next - minutes) < 0.25) { minutes = next; break; }
      minutes = next;
    }
    return { minutes, factor, peak: profileFactor(departure) };
  }

  // ------------------------------------------- 4. fixed-point backward solve
  /** Find the departure time that arrives at `arrival` given time-dependent traffic. */
  function solveDeparture(arrival, freeMin, opts = {}) {
    let departure = addMin(arrival, -freeMin);
    let pred = predictDuration(freeMin, departure, opts);
    for (let i = 0; i < 12; i++) {
      const next = addMin(arrival, -pred.minutes);
      const moved = Math.abs(next - departure) / MIN;
      departure = next;
      pred = predictDuration(freeMin, departure, opts);
      if (moved < 0.5) break;
    }
    return { departure, minutes: pred.minutes, factor: pred.factor, peak: pred.peak };
  }

  // ------------------------------------------- 6. Monte Carlo risk model
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hashSeed(str) {
    let h = 2166136261;
    for (const ch of String(str)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    return h >>> 0;
  }

  const IMPORTANCE = {
    normal: { label: 'ทั่วไป', q: 0.85 },
    important: { label: 'สำคัญ', q: 0.95 },
    critical: { label: 'ห้ามสาย', q: 0.98 },
  };

  /**
   * Simulate trip duration.
   *  - day-to-day variability: lognormal with sigma growing with congestion and distance
   *  - incidents (accident, breakdown, road works): Poisson arrivals per km, exponential delay
   */
  function simulateTrip(meanMin, { factor = 1, km = 5, seed = 1, n = 4000, mode = 'car' } = {}) {
    const rand = mulberry32(seed);
    const congestive = (MODES[mode] || MODES.car).congestion;
    // calibrated so a ~20 min city trip gets ~5-10 min buffer (not hours)
    const sigma = clamp(0.06 + 0.1 * (factor - 1) + 0.002 * Math.min(km, 50), 0.06, 0.22);
    const median = meanMin / Math.exp((sigma * sigma) / 2);
    const lambda = congestive ? Math.min(km, 60) * 0.0015 * Math.min(factor, 1.8) : Math.min(km, 60) * 0.0005;
    const pIncident = 1 - Math.exp(-lambda);
    const incidentMean = clamp(5 + 0.3 * km, 5, 25);
    const samples = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const u1 = Math.max(rand(), 1e-12);
      const u2 = rand();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      let t = median * Math.exp(sigma * z);
      if (rand() < pIncident) t += -incidentMean * Math.log(Math.max(rand(), 1e-12));
      samples[i] = t;
    }
    samples.sort();
    const q = (p) => samples[Math.min(n - 1, Math.floor(p * n))];
    const probWithin = (budget) => {
      let lo = 0, hi = n; // binary search on sorted samples
      while (lo < hi) { const mid = (lo + hi) >> 1; if (samples[mid] <= budget) lo = mid + 1; else hi = mid; }
      return lo / n;
    };
    // histogram for the UI
    const bins = 24;
    const minV = samples[0];
    const maxV = q(0.995);
    const width = (maxV - minV) / bins || 1;
    const hist = new Array(bins).fill(0);
    for (let i = 0; i < n; i++) {
      const b = Math.min(bins - 1, Math.floor((samples[i] - minV) / width));
      if (samples[i] <= maxV) hist[b]++;
    }
    return {
      sigma, pIncident, incidentMean,
      p50: q(0.5), p85: q(0.85), p95: q(0.95), p98: q(0.98),
      quantile: q, probWithin,
      hist: { bins: hist, min: minV, width },
    };
  }

  /** Buffer from the risk quantile, capped to a sane share of the trip (10–60 min, ≤ 30% of travel, min 5). */
  function capBuffer(raw, travelMin) {
    const cap = clamp(Math.round(travelMin * 0.3), 10, 60);
    return Math.max(5, Math.min(ceilTo(raw, 5), ceilTo(cap, 5)));
  }

  // ------------------------------------------- 7. backward scheduling
  /**
   * Build the full morning plan for one activity occurrence.
   * input: {
   *   eventStart: Date, arriveEarlyMin, freeMin, km, mode, importance,
   *   prepTasks: [{id,label,min,emoji}], wakeBufferMin, learned, rain, seed
   * }
   */
  function buildPlan(input) {
    const {
      eventStart, arriveEarlyMin = 10, freeMin = 20, km = 5, mode = 'car', importance = 'normal',
      prepTasks = [], wakeBufferMin = 5, learned = null, rain = false, seed = 1,
      fixedTravelMin = null, // traffic-aware minutes from Google Maps (already includes congestion)
    } = input;
    const opts = { mode, learned, rain };
    const arrival = addMin(eventStart, -arriveEarlyMin);
    const q = (IMPORTANCE[importance] || IMPORTANCE.normal).q;

    const solve = (arr) => {
      if (fixedTravelMin > 0) {
        // trust Google's duration; only apply the user's learned correction and rain
        let minutes = fixedTravelMin * (rain ? 1.2 : 1);
        let dep = addMin(arr, -minutes);
        minutes *= learnedFactor(learned, dep);
        dep = addMin(arr, -minutes);
        return { departure: dep, minutes, factor: Math.max(1, profileFactor(dep)), peak: profileFactor(dep) };
      }
      return solveDeparture(arr, freeMin, opts);
    };
    let sol = solve(arrival);
    let risk = simulateTrip(sol.minutes, { factor: sol.factor, km, seed, mode });
    let buffer = capBuffer(risk.quantile(q) - sol.minutes, sol.minutes);

    // leaving earlier by `buffer` changes the traffic we meet → re-solve once more
    for (let i = 0; i < 2; i++) {
      sol = solve(addMin(arrival, -buffer));
      risk = simulateTrip(sol.minutes, { factor: sol.factor, km, seed, mode });
      buffer = capBuffer(risk.quantile(q) - sol.minutes, sol.minutes);
    }
    const travelMin = Math.ceil(sol.minutes);
    const departure = addMin(arrival, -(travelMin + buffer));

    // walk backwards through the prep steps
    const active = prepTasks.filter((t) => t.on !== false && t.min > 0);
    const steps = [];
    let cursor = departure;
    for (let i = active.length - 1; i >= 0; i--) {
      const t = active[i];
      const start = addMin(cursor, -t.min);
      steps.unshift({ id: t.id, label: t.label, emoji: t.emoji || '•', min: t.min, start, end: cursor, kind: 'prep' });
      cursor = start;
    }
    const wake = addMin(cursor, -wakeBufferMin);
    steps.unshift({ id: 'wake', label: 'ตื่นนอน / ลุกจากเตียง', emoji: '⏰', min: wakeBufferMin, start: wake, end: cursor, kind: 'wake' });
    steps.push({ id: 'depart', label: 'ออกเดินทาง', emoji: (MODES[mode] || MODES.car).emoji, min: travelMin + buffer, start: departure, end: arrival, kind: 'travel' });
    steps.push({ id: 'arrive', label: 'ถึงที่หมาย', emoji: '📍', min: arriveEarlyMin, start: arrival, end: eventStart, kind: 'arrive' });

    const prepMin = active.reduce((s, t) => s + t.min, 0) + wakeBufferMin;
    return {
      eventStart, arrival, departure, wake,
      travelMin, bufferMin: buffer, freeMin: Math.round(fixedTravelMin > 0 ? fixedTravelMin : freeMin), prepMin,
      travelSource: fixedTravelMin > 0 ? 'google' : 'model',
      factor: sol.factor, peakAtDeparture: profileFactor(departure),
      onTimeProb: risk.probWithin(travelMin + buffer),
      risk, steps, importance, mode,
      bedtimes: suggestBedtimes(wake),
      alarms: [
        { kind: 'wake', at: wake, label: 'ตื่นนอน' },
        { kind: 'depart', at: addMin(departure, -5), label: 'อีก 5 นาทีต้องออกจากบ้าน' },
      ],
      traffic: describeTraffic(departure, sol.factor),
    };
  }

  /** Human explanation of why the travel time is what it is. */
  function describeTraffic(departure, factor) {
    const days = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
    const h = departure.getHours() + departure.getMinutes() / 60;
    const weekend = dayType(departure.getDay()) === 'weekend';
    let period;
    if (!weekend && h >= 6.5 && h < 9.5) period = 'ช่วงรถติดเช้า (คนไปทำงาน/ไปเรียน)';
    else if (!weekend && h >= 16 && h < 19.5) period = 'ช่วงรถติดเย็น (เลิกงาน/เลิกเรียน)';
    else if (h >= 11.5 && h < 13.5) period = 'ช่วงพักเที่ยง รถหนาแน่นปานกลาง';
    else if (weekend && h >= 10 && h < 20) period = 'วันหยุด ห้างและแหล่งท่องเที่ยวคนเยอะ';
    else if (h >= 21 || h < 5.5) period = 'กลางคืน ถนนโล่ง';
    else period = 'การจราจรปกติ';
    const level = factor >= 1.6 ? 'ติดหนัก' : factor >= 1.3 ? 'ติดปานกลาง' : factor >= 1.1 ? 'หนาแน่นเล็กน้อย' : 'คล่องตัว';
    return { day: days[departure.getDay()], period, level, factor };
  }

  // ------------------------------------------- re-plan from "now"
  /** Given progress, estimate arrival if the user continues from now. */
  function replanFromNow(plan, doneIds, now, opts = {}) {
    const done = new Set(doneIds || []);
    const remainingPrep = plan.steps
      .filter((s) => (s.kind === 'prep' || s.kind === 'wake') && !done.has(s.id))
      .reduce((sum, s) => sum + s.min, 0);
    let leaveAt;
    if (done.has('depart')) {
      return { status: 'travelling', leaveAt: null, eta: null, lateMin: 0 };
    }
    leaveAt = addMin(now, remainingPrep);
    if (leaveAt < plan.departure && now < plan.wake) leaveAt = plan.departure;
    const pred = plan.travelSource === 'google' ? { minutes: plan.travelMin } : predictDuration(plan.freeMin, leaveAt, opts);
    const eta = addMin(leaveAt, pred.minutes);
    const lateMin = Math.round((eta - plan.eventStart) / MIN);
    const slackMin = Math.round((plan.departure - leaveAt) / MIN);
    let status = 'ontrack';
    if (lateMin > 0) status = 'late';
    else if (slackMin < 0) status = 'tight';
    return { status, leaveAt, eta, lateMin, slackMin };
  }

  // ------------------------------------------- 8. sleep cycles
  function suggestBedtimes(wake, fallAsleepMin = 15) {
    return [6, 5, 4].map((cycles) => ({
      cycles,
      hours: (cycles * 90) / 60,
      at: addMin(wake, -(cycles * 90 + fallAsleepMin)),
    }));
  }

  // ------------------------------------------- recurrence
  /** Next occurrence (event start) at or after `from`. */
  function nextOccurrence(activity, from = new Date()) {
    if (!activity.repeat || !activity.repeat.length) {
      if (!activity.date) return null;
      const d = atTime(activity.date, activity.time);
      return d >= from ? d : null;
    }
    for (let i = 0; i < 8; i++) {
      const day = new Date(from.getFullYear(), from.getMonth(), from.getDate() + i);
      if (activity.repeat.includes(day.getDay())) {
        const d = atTime(day, activity.time);
        if (d >= from) return d;
      }
    }
    return null;
  }

  // ------------------------------------------- 9. sweep-line conflicts
  /** items: [{id, start: Date|number, end: Date|number}] → overlapping pairs. */
  function findConflicts(items) {
    const sorted = items
      .map((it) => ({ ...it, s: +it.start, e: +it.end }))
      .sort((a, b) => a.s - b.s);
    const conflicts = [];
    const active = []; // items whose interval is still open
    for (const cur of sorted) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i].e <= cur.s) active.splice(i, 1);
      for (const other of active) conflicts.push({ a: other.id, b: cur.id, overlapMin: Math.round((Math.min(other.e, cur.e) - cur.s) / MIN) });
      active.push(cur);
    }
    return conflicts;
  }

  // ------------------------------------------- 10. min-heap
  class MinHeap {
    constructor(key = (x) => x) { this.a = []; this.key = key; }
    get size() { return this.a.length; }
    peek() { return this.a[0]; }
    push(x) {
      const a = this.a; a.push(x);
      let i = a.length - 1;
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.key(a[p]) <= this.key(a[i])) break;
        [a[p], a[i]] = [a[i], a[p]]; i = p;
      }
    }
    pop() {
      const a = this.a; if (!a.length) return undefined;
      const top = a[0]; const last = a.pop();
      if (a.length) {
        a[0] = last; let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < a.length && this.key(a[l]) < this.key(a[m])) m = l;
          if (r < a.length && this.key(a[r]) < this.key(a[m])) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]]; i = m;
        }
      }
      return top;
    }
  }

  /** Reminder events for an occurrence: 7/3/1 days before + wake + depart alarms. */
  function buildReminders(activity, occurrence, plan) {
    const out = [];
    const key = `${activity.id}@${ymd(occurrence)}`;
    const r = activity.reminders || {};
    const oneOff = !activity.repeat || !activity.repeat.length;
    [[7, r.d7], [3, r.d3], [1, r.d1]].forEach(([days, on]) => {
      if (!on || !oneOff) return;
      out.push({ id: `${key}#d${days}`, at: new Date(occurrence.getTime() - days * DAY), kind: 'advance', days, activityId: activity.id });
    });
    if (plan) {
      if (activity.alarm !== false) out.push({ id: `${key}#wake`, at: plan.wake, kind: 'alarm', activityId: activity.id });
      out.push({ id: `${key}#depart`, at: addMin(plan.departure, -5), kind: 'depart', activityId: activity.id });
    }
    return out;
  }

  // ------------------------------------------- calendar export (.ics)
  function icsDate(d) {
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}T${pad2(d.getHours())}${pad2(d.getMinutes())}00`;
  }
  function icsEscape(s) { return String(s || '').replace(/[\\;,]/g, (m) => `\\${m}`).replace(/\n/g, '\\n'); }

  function makeICS(entries) {
    const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//ArriveWise//TH', 'CALSCALE:GREGORIAN'];
    for (const { activity, occurrence, plan } of entries) {
      const end = addMin(occurrence, activity.durationMin || 60);
      lines.push('BEGIN:VEVENT', `UID:${activity.id}@arrivewise.local`, `DTSTAMP:${icsDate(new Date())}`,
        `DTSTART:${icsDate(occurrence)}`, `DTEND:${icsDate(end)}`, `SUMMARY:${icsEscape(activity.title)}`);
      if (activity.place && activity.place.label) lines.push(`LOCATION:${icsEscape(activity.place.label)}`);
      if (plan) lines.push(`DESCRIPTION:${icsEscape(`ตื่น ${fmtHM(plan.wake)} · ออกจากบ้าน ${fmtHM(plan.departure)} · เผื่อเวลา ${plan.bufferMin} นาที`)}`);
      if (activity.repeat && activity.repeat.length) lines.push(`RRULE:FREQ=WEEKLY;BYDAY=${activity.repeat.map((d) => BYDAY[d]).join(',')}`);
      const r = activity.reminders || {};
      [[7, r.d7], [3, r.d3], [1, r.d1]].forEach(([d, on]) => {
        if (on) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:อีก ${d} วัน: ${icsEscape(activity.title)}`, `TRIGGER:-P${d}D`, 'END:VALARM');
      });
      if (plan) {
        const before = Math.round((occurrence - plan.wake) / MIN);
        lines.push('BEGIN:VALARM', 'ACTION:AUDIO', `DESCRIPTION:ตื่นนอน (${icsEscape(activity.title)})`, `TRIGGER:-PT${before}M`, 'END:VALARM');
        const leave = Math.round((occurrence - plan.departure) / MIN);
        lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:ได้เวลาออกจากบ้าน', `TRIGGER:-PT${leave}M`, 'END:VALARM');
      }
      lines.push('END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  /** Google Maps directions deep link (works on desktop + opens the app on phones). */
  function googleMapsLink(dest, origin, mode = 'car') {
    const p = new URLSearchParams({ api: '1', destination: dest.lat != null ? `${dest.lat},${dest.lng}` : dest.label });
    if (origin) p.set('origin', `${origin.lat},${origin.lng}`);
    const travel = (MODES[mode] || MODES.car).gmaps;
    p.set('travelmode', travel === 'two-wheeler' ? 'driving' : travel);
    return `https://www.google.com/maps/dir/?${p.toString()}`;
  }

  return {
    MIN, DAY, MODES, IMPORTANCE, PROFILES,
    clamp, ceilTo, addMin, fmtHM, ymd, parseYMD, atTime, pad2,
    haversineKm, estimateRoute, modeBaseMinutes,
    profileFactor, windowFactor, predictDuration, solveDeparture,
    learnFromTrip, learnedFactor, learnKey,
    mulberry32, hashSeed, simulateTrip,
    buildPlan, capBuffer, replanFromNow, describeTraffic, suggestBedtimes,
    nextOccurrence, findConflicts, MinHeap, buildReminders,
    makeICS, googleMapsLink,
  };
});
