/* ArriveWise — UI controller (classic script, no build step). */
(function () {
  'use strict';
  const E = window.AWEngine;
  const N = window.AWNLP;
  const MIN = E.MIN;

  // ================================================================ utils
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const hm = E.fmtHM;
  const DAY_SHORT = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  const DAY_LONG = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
  const fmtDate = (d) => d.toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'short' });
  const fmtShortDate = (d) => d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
  function fmtDur(min) {
    min = Math.max(0, Math.round(min));
    const h = Math.floor(min / 60), m = min % 60;
    if (!h) return `${m} นาที`;
    return m ? `${h} ชม. ${m} นาที` : `${h} ชม.`;
  }
  function fmtCountdown(ms) {
    if (ms <= 0) return 'ถึงเวลาแล้ว';
    const s = Math.floor(ms / 1000);
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d) return `${d} วัน ${h} ชม. ${m} นาที`;
    if (h) return `${h} ชม. ${m} นาที`;
    return `${m} นาที ${String(sec).padStart(2, '0')} วินาที`;
  }
  function toast(msg, type = '', ms = 4500) {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<div>${msg}</div><button class="x" aria-label="ปิด">×</button>`;
    $('#toasts').appendChild(el);
    const close = () => el.remove();
    $('.x', el).onclick = close;
    setTimeout(close, ms);
  }

  // ================================================================ store
  const KEY = 'arrivewise.v1';
  const DEFAULT_TASKS = (a) => [
    { id: 'shower', label: 'อาบน้ำ', emoji: '🚿', min: a.shower ?? 15, on: true },
    { id: 'dress', label: 'แต่งตัว + เตรียมของ', emoji: '👕', min: a.dress ?? 10, on: true },
    { id: 'eat', label: 'กินข้าว', emoji: '🍳', min: a.eat ?? 20, on: (a.eat ?? 20) > 0 },
  ];
  const fresh = () => ({
    profile: { onboarded: false, answers: { eat: null, shower: null, dress: null }, home: null, mode: 'car', wakeBuffer: 5 },
    activities: [], checks: {}, learned: {}, trips: [], fired: {}, focus: null,
    settings: { rain: false, sound: true },
  });
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.profile) return { ...fresh(), ...s, settings: { ...fresh().settings, ...(s.settings || {}) } };
    } catch (_) { /* ignore */ }
    return fresh();
  }
  let S = load();
  function save() { localStorage.setItem(KEY, JSON.stringify(S)); scheduler.rebuild(); }

  // ================================================================ api
  async function api(path, opts = {}, timeout = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(path, { ...opts, signal: ctl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally { clearTimeout(t); }
  }
  let nlpServer = null; // null = unknown, true/false
  async function checkHealth() {
    try { const h = await api('/api/health', {}, 4000); nlpServer = !!(h.nlp && h.nlp.available); googleServer = !!h.google; return h; }
    catch (_) { nlpServer = false; return null; }
  }
  /** PyThaiNLP tokens (server) → JS rule engine; fallback Intl.Segmenter. */
  async function analyzeText(text) {
    if (nlpServer !== false) {
      try {
        const r = await api('/api/nlp/tokenize', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) }, 5000);
        if (r.available) return N.parseActivity(text, { tokens: r.tokens, pos: r.pos, engine: r.engine });
      } catch (_) { nlpServer = false; }
    }
    return N.parseActivity(text, {});
  }
  async function geocode(q, near) {
    const nearQ = near ? `&near=${near.lat},${near.lng}` : '';
    try {
      const r = await api(`/api/geocode?q=${encodeURIComponent(q)}${nearQ}`);
      return r.results;
    } catch (_) {
      const r = await api(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=th&accept-language=th&q=${encodeURIComponent(q)}`);
      return r.map((x) => ({ label: x.display_name, name: x.name || x.display_name.split(',')[0], lat: +x.lat, lng: +x.lon }));
    }
  }
  async function reverseGeocode(p) {
    try { const r = await api(`/api/reverse?lat=${p.lat}&lng=${p.lng}`); return r.name || r.label.split(',').slice(0, 2).join(','); }
    catch (_) { return `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`; }
  }
  let googleServer = false;
  /** Route: Google Routes API (traffic-aware, when the server has a key) → OSRM → straight-line estimate. */
  async function getRoute(a, b, { mode = 'car', departure = null } = {}) {
    try {
      const dep = departure && departure > new Date() ? `&departure=${encodeURIComponent(departure.toISOString().replace(/\.\d+Z$/, 'Z'))}` : '';
      const r = await api(`/api/route?from=${a.lat},${a.lng}&to=${b.lat},${b.lng}&mode=${encodeURIComponent(mode)}${dep}`, {}, 15000);
      if (r.source === 'Google') return { km: r.km, baseMin: r.baseMin, trafficMin: r.trafficMin, line: r.line, source: 'Google', departure: r.departure, mode: r.mode };
      return { km: r.km, baseMin: r.baseMin, line: r.line, source: 'OSRM' };
    } catch (_) {
      return { ...E.estimateRoute(a, b), line: [[a.lat, a.lng], [b.lat, b.lng]] };
    }
  }
  function getGPS(opts = {}) {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('เบราว์เซอร์นี้ไม่รองรับ GPS'));
      navigator.geolocation.getCurrentPosition(
        (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        (e) => reject(new Error(e.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ตำแหน่ง' : 'หาตำแหน่งไม่สำเร็จ')),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000, ...opts });
    });
  }

  // ================================================================ planning
  function freeMinutes(act) {
    if (act.route && act.route.km) return E.modeBaseMinutes(act.route, act.mode);
    return act.manualTravelMin || 20;
  }
  /** Traffic-aware minutes from Google Maps (API or typed by the user), else null → internal model. */
  function googleMinutes(act, occ) {
    if (+act.googleMin > 0) return +act.googleMin;
    const r = act.route;
    if (!r || r.source !== 'Google' || !(r.trafficMin > 0) || (r.mode && r.mode !== act.mode)) return null;
    if (!r.departure) return r.trafficMin;
    // Google answered for one departure time; shift to this occurrence's time with the profile ratio
    const dep = new Date(+occ - ((+act.arriveEarly || 0) + r.trafficMin) * MIN);
    const ratio = E.clamp(E.profileFactor(dep) / E.profileFactor(new Date(r.departure)), 0.75, 1.4);
    return r.trafficMin * ratio;
  }
  function estimatedDeparture(act) {
    const occ = E.nextOccurrence(act, new Date());
    if (!occ) return null;
    return new Date(+occ - ((+act.arriveEarly || 0) + (act.route ? act.route.baseMin * 1.4 : 30)) * MIN);
  }
  const FAR_KM = 80;
  function farWarning(act) {
    const km = act.route && act.route.km;
    return km > FAR_KM ? `⚠️ ระยะทาง ${km.toFixed(0)} กม. ไกลผิดปกติ — พิกัดบ้านหรือปลายทางอาจผิด (เช่น ไปเจอสาขาอื่นต่างจังหวัด) <a href="#/settings">ปักหมุดบ้านใหม่</a> หรือแก้ปลายทาง` : '';
  }
  function planFor(act, occ) {
    return E.buildPlan({
      fixedTravelMin: googleMinutes(act, occ),
      eventStart: occ,
      arriveEarlyMin: +act.arriveEarly || 0,
      freeMin: freeMinutes(act),
      km: (act.route && act.route.km) || Math.max(2, (act.manualTravelMin || 20) / 3),
      mode: act.mode,
      importance: act.importance,
      prepTasks: act.prepTasks,
      wakeBufferMin: +S.profile.wakeBuffer || 5,
      learned: S.learned,
      rain: S.settings.rain,
      seed: E.hashSeed(act.id + E.ymd(occ)),
    });
  }
  /** Upcoming occurrences (including one currently in progress). */
  function upcoming(now = new Date(), limit = 20) {
    const out = [];
    for (const act of S.activities) {
      // look from 3h ago so an in-progress plan (wake passed, event not started) stays visible
      let occ = E.nextOccurrence(act, new Date(+now - 0));
      if (!occ) continue;
      out.push({ act, occ, plan: planFor(act, occ) });
    }
    return out.sort((a, b) => a.occ - b.occ).slice(0, limit);
  }
  const checkKey = (act, occ) => `${act.id}@${E.ymd(occ)}`;
  const doneMap = (act, occ) => S.checks[checkKey(act, occ)] || {};

  function currentStep(plan, done, now) {
    // first unfinished step whose time window has started, else the next upcoming one
    const open = plan.steps.filter((s) => !done[s.id]);
    const running = open.find((s) => s.start <= now);
    return running || open[0] || null;
  }

  /** Greedy: which remaining prep steps to skip to cover a deficit (largest first). */
  function skipSuggestion(plan, done, deficitMin) {
    const optional = plan.steps.filter((s) => s.kind === 'prep' && !done[s.id]).sort((a, b) => b.min - a.min);
    const pick = []; let saved = 0;
    for (const s of optional) { if (saved >= deficitMin) break; pick.push(s); saved += s.min; }
    return saved >= deficitMin ? pick : null;
  }

  // ================================================================ scheduler (min-heap)
  const scheduler = {
    heap: null,
    rebuild() {
      this.heap = new E.MinHeap((x) => +x.at);
      const now = Date.now();
      for (const { act, occ, plan } of upcoming(new Date(), 50)) {
        for (const r of E.buildReminders(act, occ, plan)) {
          if (+r.at > now - 60000 && !S.fired[r.id]) this.heap.push({ ...r, act, occ, plan });
        }
      }
      for (const sz of snoozes) this.heap.push(sz);
    },
    tick() {
      if (!this.heap) this.rebuild();
      const now = Date.now();
      while (this.heap.size && +this.heap.peek().at <= now) {
        const r = this.heap.pop();
        if (S.fired[r.id]) continue;
        S.fired[r.id] = now;
        localStorage.setItem(KEY, JSON.stringify(S));
        fire(r);
      }
    },
  };
  const snoozes = [];

  function notify(title, body) {
    try {
      if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, icon: '/favicon.svg' });
    } catch (_) { /* ignore */ }
  }
  function fire(r) {
    const { act, occ, plan } = r;
    if (r.kind === 'advance') {
      const msg = `อีก ${r.days} วัน: ${act.title} — ${fmtDate(occ)} ${hm(occ)}`;
      notify('ArriveWise แจ้งเตือนล่วงหน้า', msg);
      toast(`🔔 ${esc(msg)}`, 'blue', 9000);
      beep(2);
    } else if (r.kind === 'alarm') {
      openAlarm(act, occ, plan);
    } else if (r.kind === 'depart') {
      const msg = `อีก 5 นาทีต้องออกจากบ้าน (${hm(plan.departure)}) เพื่อไป ${act.title}`;
      notify('ArriveWise', msg);
      toast(`🚪 ${esc(msg)}`, 'blue', 12000);
      beep(3);
    }
  }

  // ================================================================ audio + alarm
  let audioCtx = null;
  function ensureAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (_) { /* ignore */ }
    return audioCtx;
  }
  document.addEventListener('pointerdown', ensureAudio, { once: true });
  function beep(count = 1, freq = 880) {
    if (!S.settings.sound) return;
    const ctx = ensureAudio(); if (!ctx) return;
    for (let i = 0; i < count; i++) {
      const t = ctx.currentTime + i * 0.28;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.25);
    }
  }
  let alarmLoop = null, alarmCtx = null;
  function openAlarm(act, occ, plan) {
    const dlg = $('#alarmDialog');
    alarmCtx = { act, occ, plan };
    $('#alarmClock').textContent = hm(new Date());
    $('#alarmText').innerHTML = `${esc(act.emoji)} <b>${esc(act.title)}</b> เริ่ม ${hm(occ)}<br>ต้องออกจากบ้าน <b>${hm(plan.departure)}</b> · เตรียมตัวรวม ${fmtDur(plan.prepMin)}`;
    const slack = Math.round((plan.departure - Date.now()) / MIN) - plan.prepMin;
    $('#alarmSnoozeNote').textContent = slack >= 5 ? `เลื่อนได้อีกประมาณ ${slack} นาทีโดยยังทันเวลา` : 'ไม่ควรเลื่อนแล้ว — เวลาเตรียมตัวจะไม่พอ';
    notify('⏰ ตื่นได้แล้ว!', `${act.title} ${hm(occ)} · ออกจากบ้าน ${hm(plan.departure)}`);
    if (!dlg.open) dlg.showModal();
    clearInterval(alarmLoop);
    beep(4, 990);
    alarmLoop = setInterval(() => { beep(4, 990); $('#alarmClock').textContent = hm(new Date()); }, 1600);
  }
  function closeAlarm() { clearInterval(alarmLoop); alarmLoop = null; $('#alarmDialog').close(); }
  $('#alarmStop').onclick = () => {
    if (alarmCtx) setCheck(alarmCtx.act, alarmCtx.occ, 'wake', true);
    closeAlarm();
  };
  $('#alarmSnooze').onclick = () => {
    if (alarmCtx) {
      const { act, occ, plan } = alarmCtx;
      snoozes.push({ id: `snooze-${uid()}`, at: new Date(Date.now() + 5 * MIN), kind: 'alarm', act, occ, plan });
      scheduler.rebuild();
      toast('😴 เลื่อนปลุกไป 5 นาที — แผนจะตึงขึ้น', '', 5000);
    }
    closeAlarm();
  };
  $('#alarmDialog').addEventListener('cancel', (e) => e.preventDefault());

  // ================================================================ checklist + learning
  function setCheck(act, occ, stepId, value) {
    const k = checkKey(act, occ);
    const m = { ...(S.checks[k] || {}) };
    if (value) m[stepId] = Date.now(); else delete m[stepId];
    S.checks[k] = m;
    if (value && stepId === 'arrive' && m.depart) {
      const plan = planFor(act, occ);
      const actual = (m.arrive - m.depart) / MIN;
      if (actual > 1 && actual < plan.travelMin * 4) {
        const predicted = plan.travelMin;
        S.learned = E.learnFromTrip(S.learned, new Date(m.depart), predicted, actual);
        S.trips.push({ at: m.depart, activityId: act.id, predicted, actual: Math.round(actual) });
        const diff = Math.round(((actual - predicted) / predicted) * 100);
        toast(`🧠 เรียนรู้จากการเดินทางจริง: ใช้ ${Math.round(actual)} นาที (${diff >= 0 ? '+' : ''}${diff}% จากที่คาด) — ครั้งหน้าจะคำนวณแม่นขึ้น`, 'blue', 8000);
      }
    }
    save();
    render();
  }

  // ================================================================ maps
  const maps = {};
  function destroyMaps() { for (const k of Object.keys(maps)) { try { maps[k].stop(); maps[k].off(); maps[k].remove(); } catch (_) {} delete maps[k]; } }
  const safeInvalidate = (map) => setTimeout(() => { if (map && map._container && map._container.isConnected && Object.values(maps).includes(map)) map.invalidateSize({ animate: false }); }, 200);
  function makeMap(el, center = [7.8804, 98.3923], zoom = 12) {
    if (!window.L || !el) return null;
    const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(center, zoom);
    // OSM standard tiles, darkened with a CSS filter (.leaflet-tile-pane) to match the black theme
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    maps[el.id] = map;
    return map;
  }
  const pin = (cls, emoji = '') => L.divIcon({ className: '', html: `<div class="pin ${cls}">${emoji}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] });

  // ================================================================ home pin picker
  /** Map where the user clicks or drags the 🏠 pin to set home. onSet(home) is called after reverse geocoding. */
  function homePicker(el, onSet) {
    const home = S.profile.home;
    const map = makeMap(el, home ? [home.lat, home.lng] : undefined, home ? 15 : 12);
    if (!map) return null;
    let marker = null;
    const place = async (latlng, label) => {
      const p = { lat: +latlng.lat.toFixed(6), lng: +latlng.lng.toFixed(6) };
      if (!marker) {
        marker = L.marker([p.lat, p.lng], { icon: pin('pin-home', '🏠'), draggable: true, autoPan: true }).addTo(map);
        marker.on('dragend', () => place(marker.getLatLng()));
      } else marker.setLatLng([p.lat, p.lng]);
      onSet({ ...p, label: label || 'กำลังหาชื่อสถานที่…' }, true);
      const name = label || (await reverseGeocode(p));
      onSet({ ...p, label: name }, false);
    };
    if (home) {
      marker = L.marker([home.lat, home.lng], { icon: pin('pin-home', '🏠'), draggable: true, autoPan: true }).addTo(map);
      marker.on('dragend', () => place(marker.getLatLng()));
    }
    map.on('click', (e) => place(e.latlng));
    safeInvalidate(map);
    return { map, place, center: (p, z = 16) => map.setView([p.lat, p.lng], z, { animate: false }) };
  }

  // ================================================================ GPS live tracking
  const gps = { watchId: null, pos: null, marker: null, lastRoute: 0, liveRoute: null };
  function stopGPS() {
    if (gps.watchId != null) navigator.geolocation.clearWatch(gps.watchId);
    gps.watchId = null; gps.marker = null;
  }
  function startGPS(entry) {
    if (!navigator.geolocation) return toast('เบราว์เซอร์นี้ไม่รองรับ GPS');
    stopGPS();
    gps.watchId = navigator.geolocation.watchPosition(
      (p) => { gps.pos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed }; updateLive(entry); },
      (e) => { toast(e.code === 1 ? 'ไม่ได้รับอนุญาตให้ใช้ GPS' : 'อ่านตำแหน่ง GPS ไม่สำเร็จ'); stopGPS(); renderLiveBox(entry); },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    renderLiveBox(entry);
  }
  async function updateLive(entry) {
    const { act, occ, plan } = entry;
    const map = maps.todayMap;
    if (map && gps.pos) {
      if (!gps.marker) gps.marker = L.marker([gps.pos.lat, gps.pos.lng], { icon: L.divIcon({ className: '', html: '<div class="pin pin-me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }) }).addTo(map);
      else gps.marker.setLatLng([gps.pos.lat, gps.pos.lng]);
    }
    if (!act.place || act.place.lat == null || !gps.pos) return renderLiveBox(entry);
    // refresh the real road route from the current position at most every 90 s
    if (Date.now() - gps.lastRoute > 90000) {
      gps.lastRoute = Date.now();
      gps.liveRoute = await getRoute(gps.pos, act.place);
    }
    renderLiveBox(entry);
  }
  function liveEstimate(entry) {
    const { act, occ, plan } = entry;
    if (!gps.pos || !act.place || act.place.lat == null) return null;
    const route = gps.liveRoute || { ...E.estimateRoute(gps.pos, act.place) };
    const free = E.modeBaseMinutes(route, act.mode);
    const pred = E.predictDuration(free, new Date(), { mode: act.mode, learned: S.learned, rain: S.settings.rain });
    const eta = new Date(Date.now() + pred.minutes * MIN);
    return { km: route.km, minutes: pred.minutes, eta, lateMin: Math.round((eta - occ) / MIN), source: route.source };
  }
  function renderLiveBox(entry) {
    const box = $('#liveBox'); if (!box) return;
    const btn = $('#gpsBtn');
    if (btn) btn.textContent = gps.watchId != null ? '⏹ หยุดติดตาม GPS' : '📡 ติดตาม GPS แบบเรียลไทม์';
    const est = liveEstimate(entry);
    if (gps.watchId == null && !est) { box.innerHTML = '<p class="explain">กดติดตาม GPS เพื่อดูระยะทางที่เหลือ เวลาถึงโดยประมาณ และสถานะว่าจะทันหรือไม่ แบบเรียลไทม์</p>'; return; }
    if (!est) { box.innerHTML = '<p class="explain">กำลังหาตำแหน่ง GPS…</p>'; return; }
    const ok = est.lateMin <= 0;
    const early = -est.lateMin > 120;
    const statusTxt = early ? 'ยังไม่ถึงเวลาออก' : ok ? `ทัน (+${-est.lateMin} น.)` : `สาย ${est.lateMin} น.`;
    box.innerHTML = `
      <div class="gps-live">
        <div class="metric-d"><div class="k">ระยะทางเหลือ</div><div class="v">${est.km.toFixed(1)} กม.</div></div>
        <div class="metric-d"><div class="k">${early ? 'ถ้าออกตอนนี้ ถึง' : 'ถึงประมาณ'}</div><div class="v">${hm(est.eta)}</div></div>
        <div class="metric-d"><div class="k">สถานะ</div><div class="v ${ok ? 'blue' : ''}" style="${ok ? '' : 'color:var(--danger)'}">${statusTxt}</div></div>
      </div>
      <p class="explain">ตำแหน่ง ±${Math.round(gps.pos.acc || 0)} ม. · เส้นทางจาก ${esc(est.source === 'OSRM' ? 'OSRM (ถนนจริง)' : 'การประมาณระยะ')} · ปรับตามสภาพจราจรขณะนี้</p>`;
    const link = $('#gmapsBtn');
    if (link) link.href = E.googleMapsLink(entry.act.place, gps.pos, entry.act.mode);
  }

  // ================================================================ charts
  function trafficChart(plan, act) {
    const W = 520, H = 170, padL = 30, padB = 22, padT = 12;
    const day = new Date(plan.eventStart); day.setHours(0, 0, 0, 0);
    const h0 = 5, h1 = 23;
    const x = (h) => padL + ((h - h0) / (h1 - h0)) * (W - padL - 8);
    const y = (f) => padT + (1 - (f - 1) / 1.0) * (H - padT - padB);
    const pts = [];
    for (let h = h0; h <= h1; h += 0.25) {
      const d = new Date(+day + h * 3600000);
      pts.push([x(h), y(Math.min(2, E.profileFactor(d) * (S.settings.rain ? 1.2 : 1) * E.learnedFactor(S.learned, d)))]);
    }
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');
    const area = `${line}L${x(h1)},${y(1)}L${x(h0)},${y(1)}Z`;
    const hd = (d) => d.getHours() + d.getMinutes() / 60 + (d - day >= 86400000 ? 24 : 0);
    const dep = hd(plan.departure), arr = hd(plan.arrival);
    const grid = [1, 1.25, 1.5, 1.75, 2].map((f) => `<line class="grid-l" x1="${padL}" x2="${W - 8}" y1="${y(f)}" y2="${y(f)}"/><text x="2" y="${y(f) + 3}">×${f}</text>`).join('');
    const ticks = [6, 9, 12, 15, 18, 21].map((h) => `<text x="${x(h) - 9}" y="${H - 6}">${h}:00</text>`).join('');
    const win = dep >= h0 && dep <= h1 ? `<rect class="win" x="${x(dep)}" y="${padT}" width="${Math.max(2, x(Math.min(arr, h1)) - x(dep))}" height="${H - padT - padB}" rx="3"/><line class="mark" x1="${x(dep)}" x2="${x(dep)}" y1="${padT}" y2="${H - padB}"/><text x="${Math.min(x(dep) + 4, W - 70)}" y="${padT + 10}" style="fill:var(--blue-2);font-weight:700">ออก ${hm(plan.departure)}</text>` : '';
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="กราฟความหนาแน่นจราจรวัน${DAY_LONG[day.getDay()]}">
      <defs><linearGradient id="gradWhite" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
      ${grid}${ticks}<path class="area" d="${area}"/><path class="curve" d="${line}"/>${win}</svg>`;
  }
  function histChart(plan) {
    const { bins, min, width } = plan.risk.hist;
    const W = 520, H = 130, pad = 18;
    const max = Math.max(...bins) || 1;
    const bw = (W - 2 * pad) / bins.length;
    const budget = plan.travelMin + plan.bufferMin;
    const bars = bins.map((c, i) => {
      const v0 = min + i * width;
      const h = (c / max) * (H - 2 * pad);
      return `<rect class="${v0 + width <= budget ? 'bar-in' : 'bar-out'}" x="${pad + i * bw + 1}" y="${H - pad - h}" width="${bw - 2}" height="${h}" rx="2"/>`;
    }).join('');
    const bx = pad + ((budget - min) / (width * bins.length)) * (W - 2 * pad);
    const mark = bx > pad && bx < W - pad ? `<line class="mark" x1="${bx}" x2="${bx}" y1="6" y2="${H - pad}"/><text x="${Math.min(bx + 4, W - 110)}" y="14" style="fill:var(--blue-2);font-weight:700">เผื่อถึง ${Math.round(budget)} นาที</text>` : '';
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="การกระจายเวลาเดินทางจากการจำลอง">${bars}${mark}
      <text x="${pad}" y="${H - 4}">${Math.round(min)} นาที</text><text x="${W - pad - 50}" y="${H - 4}">${Math.round(min + width * bins.length)} นาที</text></svg>`;
  }

  // ================================================================ router
  const views = { today: renderToday, activities: renderActivities, add: renderAdd, settings: renderSettings };
  function route() { return (location.hash.replace(/^#\//, '').split('?')[0] || 'today'); }
  function render() {
    const name = views[route()] ? route() : 'today';
    $$('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === name));
    if (name !== 'today') stopGPS();
    destroyMaps();
    gps.marker = null;
    views[name]();
    $('#app').firstElementChild?.classList.add('view');
    requestAnimationFrame(reveal);
  }
  function reveal() {
    const els = $$('.reveal:not(.in)');
    if (!('IntersectionObserver' in window)) return els.forEach((e) => e.classList.add('in'));
    const io = new IntersectionObserver((ents) => ents.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } }), { rootMargin: '0px 0px -5% 0px' });
    els.forEach((e, i) => { e.style.transitionDelay = `${Math.min(i, 6) * 50}ms`; io.observe(e); });
  }
  window.addEventListener('hashchange', () => { render(); window.scrollTo({ top: 0 }); });

  // ================================================================ TODAY
  let todayEntry = null;
  function renderToday() {
    const app = $('#app');
    const list = upcoming();
    if (!list.length) {
      todayEntry = null;
      app.innerHTML = `<section>
        <div class="card empty">
          <div class="big-emoji">🗓️</div>
          <h2>ยังไม่มีกิจกรรม</h2>
          <p class="muted">เพิ่มสิ่งที่ต้องไป เช่น “พรุ่งนี้ไปเรียนที่ ม.อ.ภูเก็ต 8 โมงเช้า” แล้ว ArriveWise จะคำนวณเวลาตื่นให้</p>
          <div class="row" style="justify-content:center;margin-top:16px"><a class="btn btn-primary" href="#/add">+ เพิ่มกิจกรรมแรก</a></div>
        </div></section>`;
      return;
    }
    const entry = list.find((e) => e.act.id === S.focus) || list[0];
    todayEntry = entry;
    const { act, occ, plan } = entry;
    const now = new Date();
    const done = doneMap(act, occ);
    const cur = currentStep(plan, done, now);
    const rp = E.replanFromNow(plan, Object.keys(done), now, { mode: act.mode, learned: S.learned, rain: S.settings.rain });
    const doneCount = plan.steps.filter((s) => done[s.id]).length;
    const pct = Math.round((doneCount / plan.steps.length) * 100);
    const totalSpan = (plan.eventStart - plan.wake) / MIN;
    const seg = (m) => ((m / totalSpan) * 100).toFixed(2);
    const started = now >= plan.wake;
    const mode = E.MODES[act.mode] || E.MODES.car;

    let statusHtml;
    if (!started) {
      statusHtml = `<div class="status ontrack">ยังไม่ถึงเวลาเตรียมตัว · เริ่มเตรียมตัวอีก <b data-cd="${+plan.wake}"></b></div>`;
    } else if (rp.status === 'travelling') {
      statusHtml = `<div class="status travelling">🚗 กำลังเดินทาง · ควรถึงก่อน <b>${hm(plan.arrival)}</b> — เมื่อถึงแล้วกด “ถึงที่หมาย” เพื่อให้ระบบเรียนรู้เวลาเดินทางจริง</div>`;
    } else if (rp.status === 'late') {
      const fix = skipSuggestion(plan, done, rp.lateMin);
      statusHtml = `<div class="status late">⚠️ ช้ากว่าแผน — ถ้าทำต่อตามนี้จะถึงประมาณ <b>${hm(rp.eta)}</b> (สาย ${rp.lateMin} นาที)
        ${fix ? `<br>แนะนำ: ข้าม <b>${fix.map((s) => esc(s.label)).join(' + ')}</b> เพื่อให้ทันเวลา` : '<br>แนะนำ: ออกเดินทางทันที หรือแจ้งผู้เกี่ยวข้องว่าจะสาย'}</div>`;
    } else if (rp.status === 'tight') {
      statusHtml = `<div class="status tight">⏱ เริ่มตึง — ใช้เวลาเผื่อไปแล้ว ${-rp.slackMin} นาที แต่ยังคาดว่าจะถึง <b>${hm(rp.eta)}</b> ทันเวลา</div>`;
    } else {
      statusHtml = `<div class="status ontrack">✓ ตามแผน · คาดว่าจะถึง <b>${hm(rp.eta)}</b> (ก่อนเวลา ${-rp.lateMin} นาที)</div>`;
    }

    const stepsHtml = plan.steps.map((s) => {
      const isDone = !!done[s.id];
      const isCur = cur && cur.id === s.id && started;
      const w = Math.min(100, (s.min / Math.max(...plan.steps.map((x) => x.min))) * 100);
      return `<li class="step ${isDone ? 'done' : ''} ${isCur ? 'current' : ''}">
        <button class="dot" data-check="${esc(s.id)}" aria-pressed="${isDone}" aria-label="${isDone ? 'ยกเลิกเช็ค' : 'เช็คว่าทำแล้ว'}: ${esc(s.label)}">${isDone ? '✓' : esc(s.emoji)}</button>
        <div class="body"><div class="name">${esc(s.label)}</div>
          <div class="when">${hm(s.start)} – ${hm(s.end)}${isDone ? ` · ทำแล้ว ${hm(new Date(done[s.id]))}` : ''}</div>
          <div class="bar"><span style="width:${w}%"></span></div></div>
        <div class="dur">${fmtDur(s.min)}${s.kind === 'travel' ? `<br><span class="dim">รวมเผื่อ ${plan.bufferMin}</span>` : ''}</div>
      </li>`;
    }).join('');

    const others = list.filter((e) => e !== entry).slice(0, 5);
    const tr = plan.traffic;
    const dayOcc = DAY_LONG[occ.getDay()];
    // compare: same trip at the opposite peak to show the time-of-day analysis
    const altDate = new Date(occ); altDate.setHours(occ.getHours() < 12 ? 17 : 7, 30, 0, 0);
    const alt = E.predictDuration(freeMinutes(act), altDate, { mode: act.mode, learned: S.learned, rain: S.settings.rain });
    const gLink = act.place && act.place.lat != null ? E.googleMapsLink(act.place, gps.pos || S.profile.home, act.mode) : (act.place ? E.googleMapsLink({ label: act.place.label }, null, act.mode) : null);

    $('#app').innerHTML = `<section>
      <div class="page-head">
        <div><h1>แผนของคุณ</h1><p>${esc(fmtDate(occ))} · ${esc(act.emoji)} ${esc(act.title)}</p></div>
        ${list.length > 1 ? `<label class="field" style="min-width:240px"><span class="sr-only">เลือกกิจกรรม</span>
          <select class="input" id="focusSel">${list.map((e) => `<option value="${esc(e.act.id)}" ${e === entry ? 'selected' : ''}>${esc(e.act.emoji)} ${esc(e.act.title)} · ${esc(fmtShortDate(e.occ))} ${hm(e.occ)}</option>`).join('')}</select></label>` : ''}
      </div>

      ${farWarning(act) ? `<div class="status late" style="margin-bottom:16px">${farWarning(act)}</div>` : ''}
      <div class="hero">
        <div class="card card-light hero-main reveal">
          <div class="eyebrow"><span class="pill pill-blue">${esc((E.IMPORTANCE[act.importance] || {}).label || '')}</span> กิจกรรมถัดไป · ${esc(act.category?.label || '')}</div>
          <div class="hero-title">${esc(act.emoji)} ${esc(act.title)}</div>
          <div class="muted">${esc(fmtDate(occ))} เวลา <b style="color:#0a0a0c">${hm(occ)}</b>${act.place ? ` · 📍 ${esc(act.place.name || act.place.label)}` : ''}</div>
          <div class="wake-big"><span class="t">${hm(plan.wake)}</span><span class="lbl">เวลาที่ควรตื่นนอน</span></div>
          <div class="countdown">${now < plan.wake ? `ปลุกในอีก <span class="blue" data-cd="${+plan.wake}"></span>` : now < plan.departure ? `ต้องออกจากบ้านในอีก <span class="blue" data-cd="${+plan.departure}"></span>` : `เริ่มกิจกรรมในอีก <span class="blue" data-cd="${+occ}"></span>`}</div>
          <div class="metrics">
            <div class="metric"><div class="k">ออกจากบ้าน</div><div class="v">${hm(plan.departure)}</div></div>
            <div class="metric"><div class="k">ถึงที่หมาย</div><div class="v">${hm(plan.arrival)}</div></div>
            <div class="metric accent"><div class="k">โอกาสถึงทันเวลา</div><div class="v">${Math.round(plan.onTimeProb * 100)}%</div></div>
          </div>
          <div class="budget-bar" aria-hidden="true">
            <span class="b-prep" style="flex-grow:${seg(plan.prepMin)}"></span>
            <span class="b-travel" style="flex-grow:${seg(plan.travelMin)}"></span>
            <span class="b-buffer" style="flex-grow:${seg(plan.bufferMin)}"></span>
            <span class="b-early" style="flex-grow:${seg(+act.arriveEarly || 0.01)}"></span>
          </div>
          <div class="budget-legend">
            <span><i style="background:#0a0a0c"></i>เตรียมตัว ${fmtDur(plan.prepMin)}</span>
            <span><i style="background:#8a8a94"></i>เดินทาง ${fmtDur(plan.travelMin)}</span>
            <span><i style="background:var(--blue)"></i>เผื่อรถติด/อุบัติเหตุ ${fmtDur(plan.bufferMin)}</span>
            <span><i style="background:#d4d4da"></i>ถึงก่อน ${fmtDur(+act.arriveEarly || 0)}</span>
          </div>
        </div>

        <div class="card now-card reveal">
          <div class="row between"><h3>⏱ ตอนนี้ต้องทำอะไร</h3><span class="pill mono">${doneCount}/${plan.steps.length}</span></div>
          ${cur ? `<div class="now-step"><div class="emoji">${esc(cur.emoji)}</div><div>
            <div class="big">${esc(cur.label)}</div>
            <div class="muted mono">${started ? (now < cur.end ? `ควรเสร็จภายใน <span data-cd="${+cur.end}"></span>` : `เลยเวลามา ${Math.round((now - cur.end) / MIN)} นาที`) : `เริ่ม ${hm(cur.start)}`}</div></div></div>` : '<div class="now-step"><div class="emoji">🎉</div><div class="big">ครบทุกขั้นตอนแล้ว</div></div>'}
          <div class="progress" aria-label="ความคืบหน้า ${pct}%"><span style="width:${pct}%"></span></div>
          ${statusHtml}
          <div class="row">
            ${cur && started ? `<button class="btn btn-primary btn-sm" data-check="${esc(cur.id)}">เสร็จแล้ว: ${esc(cur.label)}</button>` : ''}
            <button class="btn btn-sm" id="testAlarm">🔔 ทดสอบเสียงปลุก</button>
          </div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card reveal">
          <div class="card-head"><div><h3>✅ เช็คลิสต์ตามแผน</h3><div class="sub">กดวงกลมเพื่อเช็คว่าทำแล้ว — ระบบจะคำนวณใหม่ว่ายังทันไหม</div></div></div>
          <ol class="steps">${stepsHtml}</ol>
        </div>

        <div class="stack">
          <div class="card reveal">
            <div class="card-head"><div><h3>🚦 วิเคราะห์การจราจร</h3><div class="sub">วัน${esc(dayOcc)} · ${esc(tr.period)}</div></div><span class="pill ${tr.factor >= 1.5 ? 'pill-warn' : ''}">${esc(tr.level)} ×${tr.factor.toFixed(2)}</span></div>
            ${trafficChart(plan, act)}
            ${plan.travelSource === 'google' ? `<p class="explain">⏱ เวลาเดินทาง <b>${fmtDur(plan.travelMin)}</b> มาจาก <b>Google Maps</b>${+act.googleMin > 0 ? ' (ที่คุณกรอก)' : ' (รวมสภาพจราจร ณ เวลาออกเดินทาง)'} — กราฟด้านบนใช้ดูช่วงรถติดประกอบ</p>` : ''}
            <p class="explain" ${plan.travelSource === 'google' ? 'hidden' : ''}>คำนวณจาก <b>ช่วงเวลาที่คุณเดินทางจริง</b> (${hm(plan.departure)}–${hm(plan.arrival)}) ไม่ใช่ค่าเฉลี่ยทั้งวัน:
              ปกติใช้ ${fmtDur(plan.freeMin)} → ช่วงนี้ <b>${fmtDur(plan.travelMin)}</b>.
              ถ้าเป็นช่วง ${occ.getHours() < 12 ? 'เย็น 17:30' : 'เช้า 07:30'} ของวันเดียวกันจะใช้ประมาณ ${fmtDur(alt.minutes)}${S.settings.rain ? ' · รวมผลจากฝนตก +20%' : ''}.</p>
          </div>
          <div class="card reveal">
            <div class="card-head"><div><h3>🛡 เผื่อเวลาอุบัติเหตุ/เหตุไม่คาดคิด</h3><div class="sub">เผื่อไม่เกิน 30% ของเวลาเดินทาง (10–60 นาที) · Monte Carlo 4,000 รอบ · ระดับ ${esc((E.IMPORTANCE[act.importance] || {}).label)} (P${Math.round(E.IMPORTANCE[act.importance].q * 100)})</div></div><span class="pill pill-blue">+${plan.bufferMin} นาที</span></div>
            ${histChart(plan)}
            <dl class="kv" style="margin-top:10px">
              <dt>เวลาเดินทางกลาง (P50)</dt><dd>${fmtDur(plan.risk.p50)}</dd>
              <dt>กรณีแย่ (P95)</dt><dd>${fmtDur(plan.risk.p95)}</dd>
              <dt>โอกาสเกิดเหตุบนเส้นทาง</dt><dd>${(plan.risk.pIncident * 100).toFixed(1)}%</dd>
              <dt>ถ้าเกิดเหตุ จะช้าเฉลี่ย</dt><dd>${Math.round(plan.risk.incidentMean)} นาที</dd>
            </dl>
          </div>
        </div>

        <div class="card reveal span-2">
          <div class="card-head"><div><h3>🗺 เส้นทาง & GPS</h3><div class="sub">${act.place ? esc(act.place.label) : 'ยังไม่ได้ระบุพิกัดปลายทาง'} · ${mode.emoji} ${esc(mode.label)}${act.route ? ` · ${act.route.km.toFixed(1)} กม. (${act.route.source === 'Google' ? 'Google Maps' : act.route.source === 'OSRM' ? 'ถนนจริง' : 'ประมาณ'})` : ''}</div></div>
            <div class="row">${gLink ? `<a class="btn btn-blue btn-sm" id="gmapsBtn" href="${esc(gLink)}" target="_blank" rel="noopener">นำทางด้วย Google Maps ↗</a>` : ''}
              ${act.place && act.place.lat != null ? '<button class="btn btn-sm" id="gpsBtn">📡 ติดตาม GPS แบบเรียลไทม์</button>' : ''}</div></div>
          ${act.place && act.place.lat != null ? '<div class="map tall" id="todayMap"></div><div id="liveBox"></div>' : '<p class="explain">แก้ไขกิจกรรมแล้วค้นหาสถานที่ปลายทาง เพื่อดูแผนที่ เส้นทางจริง และติดตาม GPS</p>'}
        </div>

        <div class="card reveal">
          <div class="card-head"><div><h3>😴 นาฬิกาปลุก & การนอน</h3><div class="sub">ปลุกตามเวลาที่ระบบจัดสรรให้</div></div>
            <label class="switch"><input type="checkbox" id="alarmToggle" ${act.alarm !== false ? 'checked' : ''}><span class="track"></span><span class="sr-only">เปิดปลุก</span></label></div>
          <dl class="kv">
            <dt>⏰ ปลุก</dt><dd>${hm(plan.wake)}</dd>
            <dt>🚪 เตือนก่อนออกจากบ้าน</dt><dd>${hm(E.addMin(plan.departure, -5))}</dd>
            ${plan.bedtimes.map((b) => `<dt>🛏 เข้านอน (${b.cycles} รอบ · ${b.hours} ชม.)</dt><dd>${hm(b.at)}</dd>`).join('')}
          </dl>
          <p class="explain">แนะนำเวลานอนจาก <b>วงจรการนอน 90 นาที</b> + เวลาเคลิ้มหลับ 15 นาที เพื่อให้ตื่นตอนจบรอบ ไม่งัวเงีย. เสียงปลุกในเว็บทำงานเมื่อเปิดแท็บไว้ — ถ้าจะปิดเครื่อง ให้ <a href="#" id="icsOne">ส่งออกไปปฏิทินมือถือ (.ics)</a> ซึ่งมีปลุก/แจ้งเตือนในตัว</p>
        </div>

        <div class="card reveal">
          <div class="card-head"><div><h3>🔔 การแจ้งเตือนล่วงหน้า</h3><div class="sub">${act.repeat && act.repeat.length ? 'กิจกรรมประจำ: แจ้งเตือนเฉพาะปลุก/ก่อนออกจากบ้าน' : '1 / 3 / 7 วันก่อนกิจกรรม'}</div></div></div>
          <dl class="kv">
            ${E.buildReminders(act, occ, plan).map((r) => `<dt>${r.kind === 'advance' ? `📅 ล่วงหน้า ${r.days} วัน` : r.kind === 'alarm' ? '⏰ ปลุก' : '🚪 ก่อนออกจากบ้าน'}</dt><dd>${esc(fmtShortDate(r.at))} ${hm(r.at)} ${+r.at < Date.now() ? '<span class="dim">(ผ่านแล้ว)</span>' : ''}</dd>`).join('')}
          </dl>
          ${'Notification' in window && Notification.permission !== 'granted' ? '<button class="btn btn-sm" style="margin-top:12px" id="notifBtn">อนุญาตการแจ้งเตือนของเบราว์เซอร์</button>' : ''}
        </div>
      </div>

      ${others.length ? `<h3 style="margin:28px 0 12px;font-size:16px">ถัดไป</h3><div class="act-list">${others.map((e) => `
        <div class="card act reveal"><div class="emoji">${esc(e.act.emoji)}</div>
          <div><div class="title">${esc(e.act.title)}</div><div class="meta"><span>${esc(fmtShortDate(e.occ))} ${hm(e.occ)}</span><span>⏰ ตื่น ${hm(e.plan.wake)}</span><span>🚪 ออก ${hm(e.plan.departure)}</span></div></div>
          <div class="actions"><button class="btn btn-sm" data-focus="${esc(e.act.id)}">ดูแผน</button></div></div>`).join('')}</div>` : ''}
    </section>`;

    // wiring
    $$('[data-check]').forEach((b) => b.onclick = () => setCheck(act, occ, b.dataset.check, !done[b.dataset.check]));
    $$('[data-focus]').forEach((b) => b.onclick = () => { S.focus = b.dataset.focus; save(); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
    const fs = $('#focusSel'); if (fs) fs.onchange = () => { S.focus = fs.value; save(); render(); };
    $('#testAlarm').onclick = () => openAlarm(act, occ, plan);
    $('#alarmToggle').onchange = (e) => { act.alarm = e.target.checked; save(); toast(e.target.checked ? `⏰ เปิดปลุก ${hm(plan.wake)}` : 'ปิดปลุกแล้ว'); };
    const nb = $('#notifBtn'); if (nb) nb.onclick = async () => { await Notification.requestPermission(); render(); };
    $('#icsOne').onclick = (e) => { e.preventDefault(); downloadICS([entry]); };
    if (act.place && act.place.lat != null) {
      const map = makeMap($('#todayMap'), [act.place.lat, act.place.lng], 13);
      if (map) {
        const dest = L.marker([act.place.lat, act.place.lng], { icon: pin('pin-dest', '📍') }).addTo(map).bindPopup(esc(act.place.name || act.place.label));
        const bounds = [dest.getLatLng()];
        const origin = act.origin || S.profile.home;
        if (origin) { L.marker([origin.lat, origin.lng], { icon: pin('pin-home', '🏠') }).addTo(map); bounds.push(L.latLng(origin.lat, origin.lng)); }
        if (act.route && act.route.line && act.route.line.length > 1) L.polyline(act.route.line, { color: '#ffffff', weight: 4, opacity: 0.85 }).addTo(map);
        if (bounds.length > 1) map.fitBounds(L.latLngBounds(bounds).pad(0.25), { animate: false });
        safeInvalidate(map);
      }
      $('#gpsBtn').onclick = () => (gps.watchId != null ? (stopGPS(), renderLiveBox(entry)) : startGPS(entry));
      if (gps.watchId != null) { updateLive(entry); } else renderLiveBox(entry);
    }
    tickCountdowns();
  }

  // ================================================================ ACTIVITIES
  function scheduleText(act) {
    if (act.repeat && act.repeat.length) {
      const r = act.repeat;
      const label = r.length === 7 ? 'ทุกวัน' : r.join() === '1,2,3,4,5' ? 'จันทร์–ศุกร์' : r.join() === '0,6' ? 'เสาร์–อาทิตย์' : r.map((d) => DAY_SHORT[d]).join(' ');
      return `🔁 ${label} · ${act.time}`;
    }
    return `📅 ${fmtShortDate(E.parseYMD(act.date))} · ${act.time}`;
  }
  function renderActivities() {
    const now = new Date();
    const items = S.activities.map((act) => {
      const occ = E.nextOccurrence(act, now);
      return { act, occ, plan: occ ? planFor(act, occ) : null };
    });
    // sweep-line conflicts over the next week (from departure → end of activity)
    const intervals = [];
    for (const it of items) {
      for (let i = 0; i < 7; i++) {
        const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
        const occ = E.nextOccurrence(it.act, from);
        if (!occ || occ - from > 86400000) continue;
        const plan = planFor(it.act, occ);
        intervals.push({ id: `${it.act.id}|${+occ}`, start: plan.departure, end: E.addMin(occ, it.act.durationMin || 60) });
        if (!(it.act.repeat && it.act.repeat.length)) break;
      }
    }
    const uniq = new Map();
    for (const c of E.findConflicts(intervals)) {
      const a = c.a.split('|')[0], b = c.b.split('|')[0];
      if (a !== b) uniq.set([a, b].sort().join('+'), { a, b, at: new Date(+c.b.split('|')[1]), overlapMin: c.overlapMin });
    }
    const conflicts = [...uniq.values()];
    const conflictIds = new Set(conflicts.flatMap((c) => [c.a, c.b]));
    const byId = Object.fromEntries(S.activities.map((a) => [a.id, a]));

    $('#app').innerHTML = `<section>
      <div class="page-head"><div><h1>กิจกรรมทั้งหมด</h1><p>${S.activities.length} รายการ · เรียงตามเวลาที่จะถึง</p></div>
        <div class="row"><button class="btn btn-sm" id="icsAll" ${S.activities.length ? '' : 'disabled'}>⬇️ Export .ics (ปฏิทิน)</button><a class="btn btn-primary btn-sm" href="#/add">+ เพิ่มกิจกรรม</a></div></div>
      ${conflicts.length ? `<div class="status late" style="margin-bottom:16px">⚠️ พบเวลาชนกัน ${conflicts.length} คู่ (ตรวจด้วยอัลกอริทึม sweep-line ช่วง 7 วันข้างหน้า):<br>${conflicts.map((c) => `• <b>${esc(byId[c.a]?.title)}</b> กับ <b>${esc(byId[c.b]?.title)}</b> — ${esc(fmtShortDate(c.at))} ทับกัน ${c.overlapMin} นาที`).join('<br>')}</div>` : ''}
      ${items.length ? `<div class="act-list">${items.sort((a, b) => (a.occ || Infinity) - (b.occ || Infinity)).map(({ act, occ, plan }) => `
        <div class="card act reveal">
          <div class="emoji">${esc(act.emoji)}</div>
          <div><div class="title">${esc(act.title)} ${conflictIds.has(act.id) ? '<span class="pill pill-danger">เวลาชน</span>' : ''} ${!occ ? '<span class="pill">ผ่านไปแล้ว</span>' : ''}</div>
            <div class="meta"><span>${esc(scheduleText(act))}</span>${act.place ? `<span>📍 ${esc(act.place.name || act.place.label)}</span>` : ''}
              ${plan ? `<span>⏰ ตื่น ${hm(plan.wake)}</span><span>🚪 ออก ${hm(plan.departure)}</span>` : ''}
              <span>${esc((E.MODES[act.mode] || E.MODES.car).emoji)} ${esc((E.IMPORTANCE[act.importance] || {}).label)}</span></div></div>
          <div class="actions">
            ${occ ? `<button class="btn btn-sm" data-view="${esc(act.id)}">ดูแผน</button>` : ''}
            <a class="btn btn-sm" href="#/add?id=${esc(act.id)}">แก้ไข</a>
            <button class="btn btn-sm btn-danger btn-icon" data-del="${esc(act.id)}" aria-label="ลบ ${esc(act.title)}">🗑</button>
          </div>
        </div>`).join('')}</div>` : `<div class="card empty"><div class="big-emoji">✨</div><h2>ยังไม่มีกิจกรรม</h2><p class="muted">เริ่มจากสิ่งที่ต้องทำบ่อยที่สุด เช่น ไปเรียน/ไปทำงาน</p></div>`}
    </section>`;
    $$('[data-view]').forEach((b) => b.onclick = () => { S.focus = b.dataset.view; save(); location.hash = '#/today'; });
    $$('[data-del]').forEach((b) => b.onclick = () => {
      const a = byId[b.dataset.del];
      if (!confirm(`ลบ “${a.title}” ?`)) return;
      S.activities = S.activities.filter((x) => x.id !== a.id);
      save(); render(); toast('ลบแล้ว');
    });
    $('#icsAll').onclick = () => downloadICS(items.filter((i) => i.occ));
  }
  function downloadICS(entries) {
    const blob = new Blob([E.makeICS(entries)], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `arrivewise-${E.ymd(new Date())}.ics`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('⬇️ ดาวน์โหลด .ics แล้ว — เปิดไฟล์บนมือถือเพื่อเพิ่มลงปฏิทินพร้อมปลุก/แจ้งเตือน 1/3/7 วัน');
  }

  // ================================================================ ADD / EDIT
  function newActivityDraft() {
    const t = new Date(); t.setDate(t.getDate() + 1);
    return {
      id: uid(), title: '', emoji: '📌', category: { id: 'other', label: 'ทั่วไป' }, importance: 'important',
      date: E.ymd(t), repeat: null, time: '08:00', arriveEarly: 10, durationMin: 60,
      place: null, origin: null, mode: S.profile.mode || 'car', route: null, manualTravelMin: 20,
      reminders: { d1: true, d3: true, d7: true }, alarm: true,
      prepTasks: DEFAULT_TASKS(S.profile.answers).map((x) => ({ ...x })),
    };
  }
  function renderAdd() {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    const editing = params.get('id') && S.activities.find((a) => a.id === params.get('id'));
    const d = editing ? JSON.parse(JSON.stringify(editing)) : newActivityDraft();
    const prefill = params.get('text');

    $('#app').innerHTML = `<section>
      <div class="page-head"><div><h1>${editing ? 'แก้ไขกิจกรรม' : 'เพิ่มกิจกรรม'}</h1><p>พิมพ์เป็นภาษาไทยธรรมดา แล้วให้ NLP กรอกฟอร์มให้ หรือกรอกเองด้านล่าง</p></div></div>
      <div class="card reveal" style="margin-bottom:16px">
        <h3>✨ พิมพ์สิ่งที่ต้องทำ (Thai NLP)</h3>
        <div class="sub" id="nlpEngine">ตัดคำด้วย ${nlpServer ? 'PyThaiNLP (newmm) + POS tagging' : 'Intl.Segmenter (ภาษาไทย)'} → ดึงวัน/เวลา/สถานที่/ประเภทกิจกรรม</div>
        <div class="nlp-box" style="margin-top:12px">
          <input class="input" id="nlpInput" placeholder="เช่น พรุ่งนี้ไปเรียนที่ ม.อ.ภูเก็ต 8 โมงเช้า" value="${esc(prefill || '')}" aria-label="พิมพ์กิจกรรมเป็นภาษาไทย">
          <button class="btn btn-blue" id="nlpBtn">วิเคราะห์</button>
        </div>
        <div class="row" style="margin-top:10px">${['พรุ่งนี้ไปเรียนที่ ม.อ.ภูเก็ต 8 โมงเช้า', 'สอบไฟนอลวันจันทร์บ่ายโมงครึ่ง ที่มหาวิทยาลัยราชภัฏภูเก็ต', 'ทุกวันจันทร์ถึงศุกร์ เข้างานที่เซ็นทรัลภูเก็ต 9 โมง', 'นัดหมอฟัน 25/11 บ่ายสาม ที่โรงพยาบาลวชิระภูเก็ต']
          .map((x) => `<button class="chip" data-example="${esc(x)}" style="min-height:34px;font-size:12px;padding:4px 12px">${esc(x)}</button>`).join('')}</div>
        <div id="nlpOut"></div>
      </div>

      <form class="grid grid-2" id="actForm" novalidate>
        <div class="card stack reveal">
          <h3>📝 รายละเอียด</h3>
          <div class="field"><label for="fTitle">ชื่อกิจกรรม</label><input class="input" id="fTitle" required value="${esc(d.title)}" placeholder="เช่น ไปเรียน"></div>
          <div class="field"><span class="label">รูปแบบ</span><div class="seg" id="fKind">
            <button type="button" class="chip ${!d.repeat ? 'active' : ''}" data-kind="once">ครั้งเดียว</button>
            <button type="button" class="chip ${d.repeat ? 'active' : ''}" data-kind="repeat">ทำซ้ำทุกสัปดาห์</button></div></div>
          <div class="field ${d.repeat ? 'hidden' : ''}" id="fDateWrap"><label for="fDate">วันที่</label><input type="date" class="input" id="fDate" value="${esc(d.date || '')}"></div>
          <div class="field ${d.repeat ? '' : 'hidden'}" id="fDaysWrap"><span class="label">วันที่ทำซ้ำ</span><div class="seg" id="fDays">
            ${[1, 2, 3, 4, 5, 6, 0].map((x) => `<button type="button" class="chip ${(d.repeat || []).includes(x) ? 'active' : ''}" data-day="${x}">${DAY_SHORT[x]}</button>`).join('')}</div></div>
          <div class="form-grid">
            <div class="field"><label for="fTime">เวลาเริ่มกิจกรรม</label><input type="time" class="input" id="fTime" value="${esc(d.time)}"></div>
            <div class="field"><label for="fEarly">อยากถึงก่อน (นาที)</label><input type="number" min="0" max="240" class="input" id="fEarly" value="${esc(d.arriveEarly)}"></div>
            <div class="field"><label for="fDur">ระยะเวลากิจกรรม (นาที)</label><input type="number" min="5" max="1440" class="input" id="fDur" value="${esc(d.durationMin || 60)}"></div>
            <div class="field"><label for="fEmoji">ไอคอน</label><input class="input" id="fEmoji" maxlength="4" value="${esc(d.emoji)}"></div>
          </div>
          <div class="field"><span class="label">ความสำคัญ (ยิ่งสำคัญ ยิ่งเผื่อเวลามาก)</span><div class="seg" id="fImp">
            ${Object.entries(E.IMPORTANCE).map(([k, v]) => `<button type="button" class="chip ${d.importance === k ? 'active' : ''}" data-imp="${k}">${v.label} · P${Math.round(v.q * 100)}</button>`).join('')}</div></div>
          <div class="field"><span class="label">แจ้งเตือนล่วงหน้า</span><div class="row">
            ${[['d1', '1 วัน'], ['d3', '3 วัน'], ['d7', '7 วัน']].map(([k, l]) => `<label class="switch"><input type="checkbox" data-rem="${k}" ${d.reminders[k] ? 'checked' : ''}><span class="track"></span>${l}</label>`).join('')}
            <label class="switch"><input type="checkbox" id="fAlarm" ${d.alarm !== false ? 'checked' : ''}><span class="track"></span>ตั้งปลุก</label></div></div>
        </div>

        <div class="card stack reveal">
          <h3>📍 ปลายทาง & การเดินทาง</h3>
          <div class="field"><label for="fPlace">ค้นหาสถานที่</label>
            <div class="row" style="flex-wrap:nowrap"><input class="input" id="fPlace" placeholder="เช่น มหาวิทยาลัยสงขลานครินทร์ ภูเก็ต" value="${esc(d.place ? d.place.name || d.place.label : '')}"><button type="button" class="btn" id="fPlaceBtn">ค้นหา</button></div>
            <div class="search-results" id="placeResults"></div>
            <div class="sub" id="placePicked">${d.place ? `✓ ${esc(d.place.label)}` : 'หรือคลิกบนแผนที่เพื่อปักหมุดปลายทาง'}</div></div>
          <div class="map" id="addMap"></div>
          <div class="field"><span class="label">จุดเริ่มต้น</span><div class="seg" id="fOrigin">
            <button type="button" class="chip ${!d.origin ? 'active' : ''}" data-origin="home">🏠 บ้าน${S.profile.home ? '' : ' (ยังไม่ตั้ง)'}</button>
            <button type="button" class="chip ${d.origin ? 'active' : ''}" data-origin="gps">📡 ตำแหน่งปัจจุบัน</button></div></div>
          <div class="field"><span class="label">เดินทางด้วย</span><div class="seg" id="fMode">
            ${Object.entries(E.MODES).map(([k, m]) => `<button type="button" class="chip ${d.mode === k ? 'active' : ''}" data-mode="${k}">${m.emoji} ${m.label}</button>`).join('')}</div></div>
          <div class="field"><label for="fGoogle">⏱ เวลาเดินทางจาก Google Maps (นาที) — ถ้ากรอก จะใช้ค่านี้แทนการประมาณ</label>
            <div class="row" style="flex-wrap:nowrap"><input type="number" min="0" max="900" class="input" id="fGoogle" placeholder="${googleServer ? 'ดึงจาก Google อัตโนมัติแล้ว — กรอกเพื่อแก้เอง' : 'เช่น 20'}" value="${+d.googleMin > 0 ? esc(d.googleMin) : ''}">
            <a class="btn btn-blue" id="fGoogleLink" target="_blank" rel="noopener" href="#">ดูใน Google Maps ↗</a></div>
            <div class="sub">${googleServer ? 'เชื่อม Google Routes API แล้ว: ระบบดึงเวลาที่รวมสภาพจราจร ณ เวลาออกเดินทางให้เอง' : 'กด “ดูใน Google Maps” ตั้งเวลาออกเดินทาง แล้วกรอกจำนวนนาทีที่ Google บอก'}</div></div>
          <div class="field"><label for="fManual">ถ้าไม่มีพิกัด: เวลาเดินทางปกติ (นาที)</label><input type="number" min="1" max="600" class="input" id="fManual" value="${esc(d.manualTravelMin || 20)}"></div>
          <div class="sub" id="routeInfo"></div>
        </div>

        <div class="card stack reveal">
          <div class="row between"><h3>🧩 ขั้นตอนเตรียมตัวก่อนออกจากบ้าน</h3><button type="button" class="btn btn-sm" id="addTask">+ เพิ่มขั้นตอน</button></div>
          <div class="sub">เรียงตามลำดับที่ทำจริง ระบบจะนับย้อนจากเวลาออกจากบ้าน (Backward scheduling)</div>
          <div class="stack" id="tasks"></div>
        </div>

        <div class="card card-light stack reveal" id="preview" aria-live="polite"></div>

        <div class="span-2 row" style="justify-content:flex-end">
          <a class="btn" href="#/activities">ยกเลิก</a>
          <button type="submit" class="btn btn-primary" id="saveBtn">${editing ? 'บันทึกการแก้ไข' : 'บันทึกกิจกรรม'}</button>
        </div>
      </form>
    </section>`;

    // ---------- state binding
    const form = $('#actForm');
    let destMarker = null, line = null;
    const map = makeMap($('#addMap'), d.place ? [d.place.lat, d.place.lng] : S.profile.home ? [S.profile.home.lat, S.profile.home.lng] : undefined, 12);

    function drawMap() {
      if (!map) return;
      if (destMarker) { map.removeLayer(destMarker); destMarker = null; }
      if (line) { map.removeLayer(line); line = null; }
      const origin = d.origin || S.profile.home;
      if (origin) L.marker([origin.lat, origin.lng], { icon: pin('pin-home', '🏠') }).addTo(map);
      if (d.place && d.place.lat != null) {
        destMarker = L.marker([d.place.lat, d.place.lng], { icon: pin('pin-dest', '📍') }).addTo(map);
        if (d.route && d.route.line) line = L.polyline(d.route.line, { color: '#fff', weight: 4, opacity: 0.85 }).addTo(map);
        const b = [[d.place.lat, d.place.lng]]; if (origin) b.push([origin.lat, origin.lng]);
        if (b.length > 1) map.fitBounds(b, { padding: [30, 30], animate: false }); else map.setView(b[0], 14, { animate: false });
      }
      safeInvalidate(map);
    }
    function routeInfo() {
      const el = $('#routeInfo'); if (!el) return;
      const gl = $('#fGoogleLink');
      if (gl) gl.href = d.place ? E.googleMapsLink(d.place.lat != null ? d.place : { label: d.place.label }, d.origin || S.profile.home, d.mode) : 'https://www.google.com/maps';
      if (!d.route) { el.innerHTML = !(d.origin || S.profile.home) ? 'ยังไม่มีจุดเริ่มต้น — ปักหมุดบ้านในหน้าตั้งค่า หรือเลือกตำแหน่งปัจจุบัน' : ''; return; }
      const src = d.route.source === 'Google' ? `Google Maps · รวมจราจร ${fmtDur(d.route.trafficMin)}` : d.route.source === 'OSRM' ? 'ถนนจริงจาก OSRM' : 'ประมาณจากระยะทางตรง';
      el.innerHTML = `เส้นทาง ${d.route.km.toFixed(1)} กม. · ปกติ ${fmtDur(d.route.source === 'Google' ? d.route.baseMin : E.modeBaseMinutes(d.route, d.mode))} (${src})${farWarning(d) ? `<div class="status late" style="margin-top:8px">${farWarning(d)}</div>` : ''}`;
    }
    async function refreshRoute() {
      const origin = d.origin || S.profile.home;
      if (!origin || !d.place || d.place.lat == null) { d.route = null; routeInfo(); preview(); return; }
      $('#routeInfo').textContent = 'กำลังคำนวณเส้นทาง…';
      d.route = await getRoute(origin, d.place, { mode: d.mode, departure: estimatedDeparture(d) });
      routeInfo(); drawMap(); preview();
    }
    setTimeout(routeInfo, 0);
    if (map) {
      map.on('click', async (e) => {
        d.place = { lat: e.latlng.lat, lng: e.latlng.lng, label: 'ตำแหน่งที่ปักหมุด', name: 'ตำแหน่งที่ปักหมุด' };
        $('#placePicked').textContent = '✓ ปักหมุดแล้ว — กำลังหาชื่อสถานที่…';
        const name = await reverseGeocode(d.place);
        d.place.label = name; d.place.name = name.split(',')[0];
        $('#placePicked').textContent = `✓ ${name}`; $('#fPlace').value = d.place.name;
        refreshRoute();
      });
      drawMap();
    }

    function renderTasks() {
      $('#tasks').innerHTML = d.prepTasks.map((t, i) => `
        <div class="task-row" data-i="${i}">
          <label class="switch"><input type="checkbox" data-t-on ${t.on !== false ? 'checked' : ''}><span class="track"></span><span class="sr-only">ใช้ขั้นตอนนี้</span></label>
          <input class="input" data-t-label value="${esc(`${t.emoji || ''} ${t.label}`.trim())}" aria-label="ชื่อขั้นตอน">
          <input class="input" type="number" min="0" max="240" data-t-min value="${esc(t.min)}" aria-label="นาที">
          <button type="button" class="btn btn-icon btn-danger btn-sm" data-t-del aria-label="ลบขั้นตอน">×</button>
        </div>`).join('') || '<p class="muted">ไม่มีขั้นตอนเตรียมตัว</p>';
    }
    renderTasks();
    $('#tasks').addEventListener('input', (e) => {
      const row = e.target.closest('.task-row'); if (!row) return;
      const t = d.prepTasks[+row.dataset.i];
      if (e.target.matches('[data-t-label]')) {
        const v = e.target.value.trim();
        const m = v.match(/^(\p{Extended_Pictographic}\uFE0F?)\s*(.*)$/u);
        t.emoji = m ? m[1] : '•'; t.label = m ? m[2] : v;
      }
      if (e.target.matches('[data-t-min]')) t.min = Math.max(0, +e.target.value || 0);
      if (e.target.matches('[data-t-on]')) t.on = e.target.checked;
      preview();
    });
    $('#tasks').addEventListener('change', (e) => { if (e.target.matches('[data-t-on]')) { d.prepTasks[+e.target.closest('.task-row').dataset.i].on = e.target.checked; preview(); } });
    $('#tasks').addEventListener('click', (e) => {
      if (!e.target.matches('[data-t-del]')) return;
      d.prepTasks.splice(+e.target.closest('.task-row').dataset.i, 1); renderTasks(); preview();
    });
    $('#addTask').onclick = () => { d.prepTasks.push({ id: uid(), label: 'ขั้นตอนใหม่', emoji: '•', min: 5, on: true }); renderTasks(); preview(); };

    // segmented controls
    $('#fKind').onclick = (e) => {
      const b = e.target.closest('[data-kind]'); if (!b) return;
      $$('#fKind .chip').forEach((c) => c.classList.toggle('active', c === b));
      const rep = b.dataset.kind === 'repeat';
      d.repeat = rep ? (d.repeat && d.repeat.length ? d.repeat : [1, 2, 3, 4, 5]) : null;
      $('#fDateWrap').classList.toggle('hidden', rep); $('#fDaysWrap').classList.toggle('hidden', !rep);
      $$('#fDays .chip').forEach((c) => c.classList.toggle('active', (d.repeat || []).includes(+c.dataset.day)));
      preview();
    };
    $('#fDays').onclick = (e) => {
      const b = e.target.closest('[data-day]'); if (!b) return;
      const day = +b.dataset.day; const set = new Set(d.repeat || []);
      set.has(day) ? set.delete(day) : set.add(day);
      d.repeat = [...set].sort(); b.classList.toggle('active', set.has(day)); preview();
    };
    $('#fImp').onclick = (e) => { const b = e.target.closest('[data-imp]'); if (!b) return; d.importance = b.dataset.imp; $$('#fImp .chip').forEach((c) => c.classList.toggle('active', c === b)); preview(); };
    $('#fMode').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (!b) return; d.mode = b.dataset.mode; $$('#fMode .chip').forEach((c) => c.classList.toggle('active', c === b)); if (d.route && d.route.source === 'Google') refreshRoute(); else { routeInfo(); preview(); } };
    $('#fOrigin').onclick = async (e) => {
      const b = e.target.closest('[data-origin]'); if (!b) return;
      if (b.dataset.origin === 'gps') {
        try { const p = await getGPS(); d.origin = { lat: p.lat, lng: p.lng, label: 'ตำแหน่งปัจจุบัน' }; }
        catch (err) { toast(esc(err.message)); return; }
      } else d.origin = null;
      $$('#fOrigin .chip').forEach((c) => c.classList.toggle('active', c === b));
      drawMap(); refreshRoute();
    };
    form.addEventListener('input', (e) => {
      if (e.target.closest('#tasks')) return;
      d.title = $('#fTitle').value; d.date = $('#fDate').value; d.time = $('#fTime').value;
      d.arriveEarly = +$('#fEarly').value || 0; d.durationMin = +$('#fDur').value || 60; d.emoji = $('#fEmoji').value || '📌';
      d.manualTravelMin = +$('#fManual').value || 20;
      d.googleMin = +$('#fGoogle').value > 0 ? +$('#fGoogle').value : null;
      $$('[data-rem]').forEach((c) => (d.reminders[c.dataset.rem] = c.checked));
      d.alarm = $('#fAlarm').checked;
      preview();
    });
    form.addEventListener('change', () => form.dispatchEvent(new Event('input')));

    // place search
    async function searchPlace() {
      const q = N.expandPlace($('#fPlace').value.trim()); if (!q) return;
      $('#placeResults').innerHTML = '<p class="muted">กำลังค้นหา…</p>';
      try {
        const near = d.origin || S.profile.home;
        const res = await geocode(q, near);
        if (near) { res.forEach((r) => { r.dist = E.haversineKm(near, r); }); res.sort((a, b) => a.dist - b.dist); }
        $('#placeResults').innerHTML = res.length ? res.map((r, i) => `<button type="button" data-r="${i}"><b>${esc(r.name)}${r.dist != null ? ` <span class="pill ${r.dist > FAR_KM ? 'pill-warn' : ''}">ห่าง ${r.dist.toFixed(r.dist < 10 ? 1 : 0)} กม.</span>` : ''}</b>${esc(r.label)}</button>`).join('') : `<p class="muted">ไม่พบ “${esc(q)}” — ลองพิมพ์ชื่อเต็ม หรือคลิกบนแผนที่</p>`;
        $$('#placeResults [data-r]').forEach((b) => b.onclick = () => {
          const r = res[+b.dataset.r];
          d.place = { lat: r.lat, lng: r.lng, label: r.label, name: r.name };
          $('#placeResults').innerHTML = ''; $('#placePicked').textContent = `✓ ${r.label}`; $('#fPlace').value = r.name;
          refreshRoute();
        });
      } catch (_) { $('#placeResults').innerHTML = '<p class="muted">ค้นหาไม่สำเร็จ (ออฟไลน์?) — คลิกบนแผนที่หรือกรอกเวลาเดินทางเอง</p>'; }
    }
    $('#fPlaceBtn').onclick = searchPlace;
    $('#fPlace').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); searchPlace(); } });

    // live preview
    function preview() {
      const box = $('#preview');
      const occ = E.nextOccurrence(d, new Date());
      if (!d.time || (!d.repeat && !d.date) || (d.repeat && !d.repeat.length)) { box.innerHTML = '<h3>ตัวอย่างแผน</h3><p class="muted">ใส่วันและเวลาเพื่อดูเวลาตื่น</p>'; return; }
      if (!occ) { box.innerHTML = '<h3>ตัวอย่างแผน</h3><p class="muted">วันเวลานี้ผ่านไปแล้ว</p>'; return; }
      const p = planFor(d, occ);
      box.innerHTML = `<div class="row between"><h3>ตัวอย่างแผน</h3><span class="pill pill-blue">โอกาสทัน ${Math.round(p.onTimeProb * 100)}%</span></div>
        <div class="muted">${esc(fmtDate(occ))} · เริ่ม ${hm(occ)}</div>
        <div class="wake-big" style="margin:4px 0"><span class="t" style="font-size:56px">${hm(p.wake)}</span><span class="lbl">ควรตื่น</span></div>
        <div class="metrics" style="margin-top:4px">
          <div class="metric"><div class="k">ออกจากบ้าน</div><div class="v">${hm(p.departure)}</div></div>
          <div class="metric"><div class="k">เดินทาง</div><div class="v">${p.travelMin}′</div></div>
          <div class="metric accent"><div class="k">เผื่อเวลา</div><div class="v">+${p.bufferMin}′</div></div>
        </div>
        <p class="muted" style="font-size:13px;margin:6px 0 0">${p.travelSource === 'google' ? `เวลาเดินทางจาก Google Maps ${fmtDur(p.travelMin)}` : `${esc(p.traffic.day)} ${hm(p.departure)} · ${esc(p.traffic.period)} (×${p.factor.toFixed(2)})`}</p>`;
    }
    preview();

    // NLP
    async function runNLP() {
      const text = $('#nlpInput').value.trim(); if (!text) return;
      $('#nlpOut').innerHTML = '<p class="muted" style="margin-top:10px">กำลังวิเคราะห์…</p>';
      const r = await analyzeText(text);
      const nouns = new Set((r.pos || []).filter((p) => p.tag === 'NOUN' || p.tag === 'PROPN').map((p) => p.w));
      const posMap = Object.fromEntries((r.pos || []).map((p) => [p.w, p.tag]));
      const rep = r.repeat ? (r.repeat.length === 7 ? 'ทุกวัน' : r.repeat.map((x) => DAY_SHORT[x]).join(' ')) : null;
      $('#nlpOut').innerHTML = `
        <div class="entities">
          <span class="entity ok"><span class="k">TITLE</span>${esc(r.title)}</span>
          <span class="entity ${r.time ? 'ok' : ''}"><span class="k">TIME</span>${esc(r.time || 'ไม่พบ')}</span>
          <span class="entity ${r.date || rep ? 'ok' : ''}"><span class="k">DATE</span>${esc(rep ? `🔁 ${rep}` : r.date ? fmtShortDate(E.parseYMD(r.date)) : 'ไม่พบ')}</span>
          <span class="entity ${r.place ? 'ok' : ''}"><span class="k">PLACE</span>${esc(r.place || 'ไม่พบ')}</span>
          <span class="entity ok"><span class="k">CATEGORY</span>${esc(r.category.emoji)} ${esc(r.category.label)} · ${esc(E.IMPORTANCE[r.category.importance].label)}</span>
        </div>
        <div class="tokens" aria-label="ผลการตัดคำ">${r.tokens.map((t) => `<span class="tok ${nouns.has(t) ? 'noun' : ''}">${esc(t)}${posMap[t] ? `<small>${esc(posMap[t])}</small>` : ''}</span>`).join('')}</div>
        <p class="explain">ตัดคำโดย <b>${esc(r.engine)}</b> · ความครบถ้วน ${Math.round(r.confidence * 100)}% · กรอกฟอร์มให้อัตโนมัติแล้ว ตรวจสอบก่อนบันทึก</p>`;
      // apply to form
      d.title = r.title; $('#fTitle').value = r.title;
      d.emoji = r.category.emoji; $('#fEmoji').value = r.category.emoji;
      d.category = { id: r.category.id, label: r.category.label };
      d.importance = r.category.importance; $$('#fImp .chip').forEach((c) => c.classList.toggle('active', c.dataset.imp === d.importance));
      d.arriveEarly = r.category.arriveEarly; $('#fEarly').value = d.arriveEarly;
      if (r.time) { d.time = r.time; $('#fTime').value = r.time; }
      if (r.repeat) { d.repeat = r.repeat; $('#fKind [data-kind="repeat"]').click(); $$('#fDays .chip').forEach((c) => c.classList.toggle('active', r.repeat.includes(+c.dataset.day))); }
      else if (r.date) { d.repeat = null; d.date = r.date; $('#fDate').value = r.date; $('#fKind [data-kind="once"]').click(); }
      // category-specific prep steps (e.g. exam → check ID card)
      for (const t of r.category.tasks || []) if (!d.prepTasks.some((x) => x.label === t.label)) d.prepTasks.push({ id: uid(), ...t, on: true });
      renderTasks();
      if (r.placeQuery) { $('#fPlace').value = r.placeQuery; searchPlace(); }
      preview();
    }
    $('#nlpBtn').onclick = runNLP;
    $('#nlpInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') runNLP(); });
    $$('[data-example]').forEach((b) => b.onclick = () => { $('#nlpInput').value = b.dataset.example; runNLP(); });
    if (prefill) runNLP();

    form.onsubmit = (e) => {
      e.preventDefault();
      form.dispatchEvent(new Event('input'));
      if (!d.title.trim()) { toast('กรุณาใส่ชื่อกิจกรรม'); $('#fTitle').focus(); return; }
      if (!d.time) { toast('กรุณาใส่เวลา'); return; }
      if (!d.repeat && !d.date) { toast('กรุณาเลือกวันที่'); return; }
      if (d.repeat && !d.repeat.length) { toast('เลือกอย่างน้อย 1 วัน'); return; }
      if (!E.nextOccurrence(d, new Date())) { toast('วันเวลานี้ผ่านไปแล้ว'); return; }
      if (!d.category) d.category = N.classify(d.title, []);
      const idx = S.activities.findIndex((a) => a.id === d.id);
      if (idx >= 0) S.activities[idx] = d; else S.activities.push(d);
      S.focus = d.id;
      save();
      const occ = E.nextOccurrence(d, new Date());
      const p = planFor(d, occ);
      toast(`✓ บันทึกแล้ว — ควรตื่น <b>${hm(p.wake)}</b> ออกจากบ้าน <b>${hm(p.departure)}</b>`, 'blue', 7000);
      location.hash = '#/today';
    };
  }

  // ================================================================ SETTINGS
  function renderSettings() {
    const a = S.profile.answers;
    const learnedRows = Object.entries(S.learned).sort();
    $('#app').innerHTML = `<section>
      <div class="page-head"><div><h1>ตั้งค่า</h1><p>ข้อมูลชีวิตประจำวันที่ใช้คำนวณ เก็บไว้ในเครื่องนี้เท่านั้น</p></div></div>
      <div class="grid grid-2">
        <div class="card stack reveal">
          <h3>🧍 กิจวัตรตอนเช้า</h3>
          ${[['eat', '🍳 กินข้าวก่อนออกจากบ้าน'], ['shower', '🚿 อาบน้ำ'], ['dress', '👕 แต่งตัว + เตรียมของ']].map(([k, l]) => `
            <div class="field"><label for="s_${k}">${l} (พิมพ์ได้ เช่น “ครึ่งชั่วโมง”)</label><input class="input" id="s_${k}" data-ans="${k}" value="${a[k] ?? ''}"><div class="sub" data-ans-out="${k}"></div></div>`).join('')}
          <div class="field"><label for="s_wake">⏰ เวลาลุกจากเตียงหลังนาฬิกาปลุก (นาที)</label><input class="input" type="number" min="0" max="60" id="s_wake" value="${S.profile.wakeBuffer}"></div>
          <div class="row"><button class="btn btn-primary btn-sm" id="saveAns">บันทึก</button><label class="switch"><input type="checkbox" id="applyAll" checked><span class="track"></span>อัปเดตกิจกรรมที่มีอยู่ด้วย</label></div>
        </div>
        <div class="card stack reveal">
          <h3>🏠 จุดเริ่มต้น (บ้าน)</h3>
          <p class="muted" style="margin:0" id="homeLabel">${S.profile.home ? `✓ ${esc(S.profile.home.label)}` : 'ยังไม่ได้ตั้ง'}</p>
          <div class="map" id="homeMap" aria-label="แผนที่ปักหมุดบ้าน"></div>
          <div class="sub">📌 คลิกบนแผนที่เพื่อปักหมุดบ้าน หรือลากหมุด 🏠 ไปตำแหน่งที่ถูกต้อง — ระบบจะคำนวณเส้นทางทุกกิจกรรมใหม่ให้</div>
          <div class="row"><button class="btn btn-sm" id="homeGps">📡 ใช้ตำแหน่งปัจจุบันเป็นบ้าน</button></div>
          <div class="row" style="flex-wrap:nowrap"><input class="input" id="homeQ" placeholder="หรือค้นหาที่อยู่/หอพัก"><button class="btn" id="homeSearch">ค้นหา</button></div>
          <div class="search-results" id="homeResults"></div>
          <div class="field"><span class="label">ยานพาหนะหลัก</span><div class="seg" id="sMode">${Object.entries(E.MODES).map(([k, m]) => `<button class="chip ${S.profile.mode === k ? 'active' : ''}" data-mode="${k}">${m.emoji} ${m.label}</button>`).join('')}</div></div>
        </div>
        <div class="card stack reveal">
          <h3>🔔 แจ้งเตือน & สภาพแวดล้อม</h3>
          <label class="switch"><input type="checkbox" id="sSound" ${S.settings.sound ? 'checked' : ''}><span class="track"></span>เปิดเสียงปลุก/แจ้งเตือน</label>
          <label class="switch"><input type="checkbox" id="sRain" ${S.settings.rain ? 'checked' : ''}><span class="track"></span>🌧 วันนี้ฝนตก (เพิ่มเวลาเดินทาง 20%)</label>
          <div class="row"><button class="btn btn-sm" id="sNotif">อนุญาตการแจ้งเตือนเบราว์เซอร์ (${'Notification' in window ? esc(Notification.permission) : 'ไม่รองรับ'})</button><button class="btn btn-sm" id="sBeep">ทดสอบเสียง</button></div>
          <p class="explain">การแจ้งเตือน/ปลุกในเว็บทำงานเมื่อเปิดแท็บ ArriveWise ไว้ สำหรับปลุกบนมือถือแม้ปิดเว็บ ใช้ปุ่ม Export .ics ในหน้ากิจกรรม</p>
        </div>
        <div class="card stack reveal">
          <h3>🧠 สิ่งที่ระบบเรียนรู้ (EWMA)</h3>
          <p class="explain" style="margin:0">เมื่อคุณเช็ค “ออกเดินทาง” และ “ถึงที่หมาย” ระบบจะเทียบเวลาจริงกับที่คาด แล้วปรับตัวคูณของช่วงเวลานั้นด้วย Exponential smoothing (α = 0.3)</p>
          ${learnedRows.length ? `<dl class="kv">${learnedRows.map(([k, v]) => { const [t, h] = k.split('-'); return `<dt>${t === 'wd' ? 'วันธรรมดา' : 'วันหยุด'} ${h}:00–${h}:59</dt><dd>×${v.toFixed(2)}</dd>`; }).join('')}</dl>` : '<p class="muted" style="margin:0">ยังไม่มีข้อมูล</p>'}
          <div class="row"><button class="btn btn-sm" id="resetLearn" ${learnedRows.length ? '' : 'disabled'}>ล้างข้อมูลที่เรียนรู้</button></div>
          <p class="sub">Thai NLP: <span id="nlpStatus">กำลังตรวจสอบ…</span></p>
        </div>
        <div class="card stack reveal span-2">
          <h3>💾 ข้อมูล</h3>
          <div class="row"><button class="btn btn-sm" id="exportJson">⬇️ Export .json</button><label class="btn btn-sm">⬆️ Import .json<input type="file" accept="application/json" id="importJson" hidden></label>
            <button class="btn btn-sm" id="redoOnb">ทำแบบสอบถามใหม่</button><button class="btn btn-sm btn-danger" id="resetAll">ล้างข้อมูลทั้งหมด</button></div>
        </div>
      </div></section>`;

    const showAns = (k) => { const v = N.parseDuration($(`[data-ans="${k}"]`).value); $(`[data-ans-out="${k}"]`).innerHTML = v == null ? 'ยังอ่านค่าไม่ได้' : `= <b>${v}</b> นาที`; };
    ['eat', 'shower', 'dress'].forEach((k) => { showAns(k); $(`[data-ans="${k}"]`).oninput = () => showAns(k); });
    $('#saveAns').onclick = () => {
      for (const k of ['eat', 'shower', 'dress']) { const v = N.parseDuration($(`[data-ans="${k}"]`).value); if (v != null) a[k] = v; }
      S.profile.wakeBuffer = Math.max(0, +$('#s_wake').value || 0);
      if ($('#applyAll').checked) for (const act of S.activities) for (const t of act.prepTasks) {
        if (t.id === 'eat') { t.min = a.eat; t.on = a.eat > 0; } if (t.id === 'shower') t.min = a.shower; if (t.id === 'dress') t.min = a.dress;
      }
      save(); toast('✓ บันทึกกิจวัตรแล้ว'); render();
    };
    let homeTimer = null;
    const picker = homePicker($('#homeMap'), (home, pending) => {
      $('#homeLabel').textContent = `${pending ? '…' : '✓'} ${home.label}`;
      if (pending) return;
      S.profile.home = home;
      clearTimeout(homeTimer);
      homeTimer = setTimeout(async () => { await refreshAllRoutes(); save(); toast('🏠 ปักหมุดบ้านแล้ว — คำนวณเส้นทางกิจกรรมใหม่เรียบร้อย'); }, 300);
    });
    $('#homeGps').onclick = async () => {
      try { const p = await getGPS(); picker ? (picker.center(p), picker.place(p)) : null; if ((p.acc || 0) > 500) toast(`ตำแหน่งจาก GPS คลาดเคลื่อน ±${Math.round(p.acc)} ม. — ลากหมุดให้ตรงบ้านอีกครั้ง`); }
      catch (e) { toast(esc(e.message)); }
    };
    const homeSearch = async () => {
      const q = N.expandPlace($('#homeQ').value.trim()); if (!q) return;
      try {
        const res = await geocode(q);
        $('#homeResults').innerHTML = res.map((r, i) => `<button data-r="${i}"><b>${esc(r.name)}</b>${esc(r.label)}</button>`).join('') || '<p class="muted">ไม่พบ</p>';
        $$('#homeResults [data-r]').forEach((b) => b.onclick = () => { const r = res[+b.dataset.r]; $('#homeResults').innerHTML = ''; if (picker) { picker.center(r); picker.place(r, r.label); } });
      } catch (_) { $('#homeResults').innerHTML = '<p class="muted">ค้นหาไม่สำเร็จ</p>'; }
    };
    $('#homeSearch').onclick = homeSearch;
    $('#homeQ').onkeydown = (e) => { if (e.key === 'Enter') homeSearch(); };
    $('#sMode').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (!b) return; S.profile.mode = b.dataset.mode; save(); render(); };
    $('#sSound').onchange = (e) => { S.settings.sound = e.target.checked; save(); };
    $('#sRain').onchange = (e) => { S.settings.rain = e.target.checked; save(); toast(e.target.checked ? '🌧 เพิ่มเวลาเดินทางเผื่อฝนแล้ว' : 'ปิดโหมดฝนตก'); };
    $('#sNotif').onclick = async () => { if ('Notification' in window) { await Notification.requestPermission(); render(); } };
    $('#sBeep').onclick = () => beep(3);
    $('#resetLearn').onclick = () => { S.learned = {}; S.trips = []; save(); render(); };
    $('#exportJson').onclick = () => {
      const blob = new Blob([JSON.stringify(S, null, 2)], { type: 'application/json' });
      const el = document.createElement('a'); el.href = URL.createObjectURL(blob); el.download = `arrivewise-backup-${E.ymd(new Date())}.json`; el.click();
    };
    $('#importJson').onchange = async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data || !data.profile || !Array.isArray(data.activities)) throw new Error('bad');
        S = { ...fresh(), ...data }; save(); render(); toast('✓ นำเข้าข้อมูลแล้ว');
      } catch (_) { toast('ไฟล์ไม่ถูกต้อง — ไม่ได้เปลี่ยนข้อมูล'); }
    };
    $('#redoOnb').onclick = () => openOnboarding();
    $('#resetAll').onclick = () => { if (confirm('ล้างข้อมูลทั้งหมด?')) { localStorage.removeItem(KEY); S = fresh(); save(); openOnboarding(); render(); } };
    checkHealth().then((h) => { const el = $('#nlpStatus'); if (el) el.textContent = h && h.nlp && h.nlp.available ? h.nlp.engine : 'ใช้ Intl.Segmenter ในเบราว์เซอร์ (ไม่ได้รันผ่าน server.py)'; });
  }
  async function refreshAllRoutes() {
    for (const act of S.activities) if (!act.origin && act.place && act.place.lat != null && S.profile.home) act.route = await getRoute(S.profile.home, act.place, { mode: act.mode, departure: estimatedDeparture(act) });
  }

  // ================================================================ ONBOARDING (3 questions)
  const QUESTIONS = [
    { key: 'eat', q: 'ปกติกินข้าวเช้าก่อนออกจากบ้านไหม? ใช้เวลากี่นาที', lead: 'ถ้าไม่กิน กด “ไม่กิน” ได้เลย — ระบบจะไม่นับเวลานี้', chips: [['ไม่กิน', 0], ['10 นาที', 10], ['15 นาที', 15], ['20 นาที', 20], ['30 นาที', 30]], ph: 'หรือพิมพ์ เช่น “ครึ่งชั่วโมง”, “สิบห้านาที”' },
    { key: 'shower', q: 'อาบน้ำใช้เวลากี่นาที?', lead: 'นับตั้งแต่เข้าห้องน้ำจนออกมา', chips: [['5 นาที', 5], ['10 นาที', 10], ['15 นาที', 15], ['20 นาที', 20], ['30 นาที', 30]], ph: 'หรือพิมพ์ เช่น “ประมาณ 15-20 นาที”' },
    { key: 'dress', q: 'แต่งตัวและเตรียมของก่อนออกจากบ้านกี่นาที?', lead: 'รวมจัดกระเป๋า หาของ ใส่รองเท้า', chips: [['5 นาที', 5], ['10 นาที', 10], ['15 นาที', 15], ['20 นาที', 20]], ph: 'หรือพิมพ์ เช่น “สิบนาที”' },
  ];
  let onbStep = 0;
  function openOnboarding() { onbStep = 0; $('#onboarding').classList.remove('hidden'); document.body.style.overflow = 'hidden'; renderOnb(); }
  function closeOnboarding() { $('#onboarding').classList.add('hidden'); document.body.style.overflow = ''; }
  function renderOnb() {
    const el = $('#onboarding');
    const total = QUESTIONS.length + 1;
    const bar = `<div class="onb-steps" aria-hidden="true">${Array.from({ length: total }, (_, i) => `<span class="${i < onbStep ? 'on' : i === onbStep ? 'cur' : ''}"></span>`).join('')}</div>`;
    if (onbStep < QUESTIONS.length) {
      const Q = QUESTIONS[onbStep];
      const val = S.profile.answers[Q.key];
      el.innerHTML = `<div class="onb-inner onb-anim">
        <div class="logo-hero"><span class="brand-mark"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#050506" stroke-width="2.4" stroke-linecap="round"><path d="M12 21s-6-5.6-6-11a6 6 0 1 1 12 0c0 5.4-6 11-6 11z"/><path d="M12 7v3.2l2 1.3" stroke="#2f6bff"/></svg></span>Arrive<span class="blue">Wise</span></div>
        ${bar}
        <div class="q-num">คำถามที่ ${onbStep + 1} / ${QUESTIONS.length}</div>
        <h2 id="onbTitle">${esc(Q.q)}</h2>
        <p class="lead">${esc(Q.lead)}</p>
        <div class="chips">${Q.chips.map(([l, v]) => `<button class="chip ${val === v ? 'active' : ''}" data-v="${v}">${esc(l)}</button>`).join('')}</div>
        <input class="input" id="onbInput" placeholder="${esc(Q.ph)}" aria-label="พิมพ์คำตอบ" value="${val != null && !Q.chips.some((c) => c[1] === val) ? esc(val + ' นาที') : ''}">
        <div class="parsed" id="onbParsed">${val != null ? `ใช้: <b>${val === 0 ? 'ไม่นับ' : `${val} นาที`}</b>` : ''}</div>
        <div class="foot">
          <button class="btn" id="onbBack" ${onbStep === 0 ? 'style="visibility:hidden"' : ''}>← ย้อนกลับ</button>
          <button class="btn btn-primary" id="onbNext" ${val == null ? 'disabled' : ''}>ถัดไป →</button>
        </div></div>`;
      const set = (v) => { S.profile.answers[Q.key] = v; $('#onbNext').disabled = v == null; $('#onbParsed').innerHTML = v == null ? 'ยังอ่านค่าไม่ได้ ลองพิมพ์ตัวเลขหรือ “ครึ่งชั่วโมง”' : `NLP อ่านได้: <b>${v === 0 ? 'ไม่นับ (0 นาที)' : `${v} นาที`}</b>`; };
      $$('.chips .chip', el).forEach((c) => c.onclick = () => { $$('.chips .chip', el).forEach((x) => x.classList.toggle('active', x === c)); $('#onbInput').value = ''; set(+c.dataset.v); });
      $('#onbInput').oninput = (e) => { $$('.chips .chip', el).forEach((x) => x.classList.remove('active')); set(e.target.value.trim() ? N.parseDuration(e.target.value) : null); };
      $('#onbInput').onkeydown = (e) => { if (e.key === 'Enter' && S.profile.answers[Q.key] != null) $('#onbNext').click(); };
      $('#onbNext').onclick = () => { onbStep++; renderOnb(); };
      $('#onbBack').onclick = () => { onbStep--; renderOnb(); };
      setTimeout(() => $('.chips .chip', el)?.focus(), 50);
      return;
    }
    // final: summary + home location
    const a = S.profile.answers;
    const prep = (a.eat || 0) + (a.shower || 0) + (a.dress || 0) + (S.profile.wakeBuffer || 5);
    el.innerHTML = `<div class="onb-inner onb-anim">${bar}
      <div class="q-num">สรุป</div>
      <h2 id="onbTitle">ตอนเช้าคุณใช้เวลาเตรียมตัว ${fmtDur(prep)}</h2>
      <p class="lead">ลุกจากเตียง ${S.profile.wakeBuffer} · อาบน้ำ ${a.shower} · แต่งตัว ${a.dress} · กินข้าว ${a.eat ? a.eat : 'ไม่กิน'} (นาที)<br>สุดท้าย ตั้ง “บ้าน” เป็นจุดเริ่มต้น เพื่อคำนวณระยะทางไปยังจุดหมาย</p>
      <div class="row"><button class="btn btn-primary" id="onbGps">📡 ใช้ตำแหน่งปัจจุบัน</button><span class="muted" id="onbHome">${S.profile.home ? `✓ ${esc(S.profile.home.label)}` : 'หรือคลิกบนแผนที่เพื่อปักหมุดบ้าน'}</span></div>
      <div class="map" id="onbMap" style="margin-top:14px;height:260px" aria-label="แผนที่ปักหมุดบ้าน"></div>
      <div class="field" style="margin-top:18px"><span class="label">เดินทางด้วยอะไรเป็นหลัก</span><div class="seg" id="onbMode">${Object.entries(E.MODES).map(([k, m]) => `<button class="chip ${S.profile.mode === k ? 'active' : ''}" data-mode="${k}">${m.emoji} ${m.label}</button>`).join('')}</div></div>
      <div class="foot"><button class="btn" id="onbBack">← ย้อนกลับ</button>
        <div class="row"><button class="btn" id="onbSkip">ข้ามไปก่อน</button><button class="btn btn-blue" id="onbDone">เริ่มใช้งาน →</button></div></div></div>`;
    $('#onbBack').onclick = () => { onbStep--; renderOnb(); };
    if (maps.onbMap) { try { maps.onbMap.remove(); } catch (_) {} delete maps.onbMap; }
    const picker = homePicker($('#onbMap'), (home, pending) => { $('#onbHome').textContent = `${pending ? '…' : '✓'} ${home.label}`; if (!pending) S.profile.home = home; });
    $('#onbGps').onclick = async () => {
      $('#onbHome').textContent = 'กำลังหาตำแหน่ง…';
      try { const p = await getGPS(); if (picker) { picker.center(p); await picker.place(p); } if ((p.acc || 0) > 500) $('#onbHome').textContent += ` (คลาดเคลื่อน ±${Math.round(p.acc)} ม. — ลากหมุดให้ตรง)`; }
      catch (e) { $('#onbHome').textContent = e.message + ' — คลิกบนแผนที่เพื่อปักหมุดแทน'; }
    };
    $('#onbMode').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (!b) return; S.profile.mode = b.dataset.mode; $$('#onbMode .chip').forEach((c) => c.classList.toggle('active', c === b)); };
    const finish = () => {
      S.profile.onboarded = true;
      for (const act of S.activities) for (const t of act.prepTasks) { if (t.id === 'eat') { t.min = a.eat; t.on = a.eat > 0; } if (t.id === 'shower') t.min = a.shower; if (t.id === 'dress') t.min = a.dress; }
      save(); closeOnboarding();
      if (!S.activities.length) location.hash = '#/add'; else render();
    };
    $('#onbDone').onclick = finish; $('#onbSkip').onclick = finish;
  }

  // ================================================================ ticking
  function tickCountdowns() {
    const now = Date.now();
    $$('[data-cd]').forEach((el) => { el.textContent = fmtCountdown(+el.dataset.cd - now); });
  }
  let lastStepSig = '';
  setInterval(() => {
    const now = new Date();
    $('#headerClock').textContent = now.toLocaleString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    tickCountdowns();
    scheduler.tick();
    // re-render today when the active step changes (keeps the map alive otherwise)
    if (route() === 'today' && todayEntry) {
      const done = doneMap(todayEntry.act, todayEntry.occ);
      const cur = currentStep(todayEntry.plan, done, now);
      const sig = `${todayEntry.act.id}|${cur && cur.id}|${now >= todayEntry.plan.wake}|${Math.floor(now / 60000)}`;
      const minuteless = sig.split('|').slice(0, 3).join('|');
      if (lastStepSig && lastStepSig.split('|').slice(0, 3).join('|') !== minuteless) render();
      lastStepSig = sig;
      if (gps.watchId != null && now.getSeconds() % 15 === 0) renderLiveBox(todayEntry);
    }
  }, 1000);
  setInterval(() => scheduler.rebuild(), 60000);

  // ================================================================ boot
  window.ArriveWise = { get state() { return S; }, planFor, upcoming, openAlarm, scheduler };
  checkHealth().then(() => { const el = $('#nlpEngine'); if (el) el.textContent = `ตัดคำด้วย ${nlpServer ? 'PyThaiNLP (newmm) + POS tagging' : 'Intl.Segmenter (ภาษาไทย)'} → ดึงวัน/เวลา/สถานที่/ประเภทกิจกรรม`; });
  scheduler.rebuild();
  render();
  if (!S.profile.onboarded) openOnboarding();
})();
