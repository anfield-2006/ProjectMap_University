/*
 * ArriveWise — Thai NLP helpers (rule engine).
 * Tokens come from PyThaiNLP (server, newmm word segmentation + POS) when available,
 * otherwise from the browser's Intl.Segmenter('th') — so the app still works offline.
 *
 * NLP tasks used (see nlpforthai.com/tasks):
 *  - Word segmentation      : PyThaiNLP newmm / Intl.Segmenter
 *  - Part-of-speech tagging : PyThaiNLP (orchid_ud) → nouns help find the place name
 *  - Named-entity style extraction (rule based): DATE, TIME, DURATION, PLACE
 *  - Text classification (lexicon scoring)     : activity category + importance
 *  - Text normalisation / spell variants       : Thai digits, number words, abbreviations (ม.อ., รพ., มหาลัย)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AWNLP = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------- normalisation
  const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';
  function normalizeDigits(s) {
    return String(s || '').replace(/[๐-๙]/g, (c) => String(THAI_DIGITS.indexOf(c)));
  }

  const DIGIT_WORDS = { ศูนย์: 0, หนึ่ง: 1, นึง: 1, เอ็ด: 1, สอง: 2, ยี่: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6, เจ็ด: 7, แปด: 8, เก้า: 9 };
  const NUM_RE = /(?:ศูนย์|หนึ่ง|นึง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย)+/g;

  /** 'สิบห้า' → 15, 'ยี่สิบ' → 20, 'สามสิบห้า' → 35, 'ร้อยยี่สิบ' → 120 */
  function thaiWordToNum(word) {
    const re = /ศูนย์|หนึ่ง|นึง|เอ็ด|สอง|ยี่|สาม|สี่|ห้า|หก|เจ็ด|แปด|เก้า|สิบ|ร้อย/g;
    let total = 0, cur = 0, m, any = false;
    while ((m = re.exec(word))) {
      any = true;
      const w = m[0];
      if (w === 'ร้อย') { total += (cur || 1) * 100; cur = 0; }
      else if (w === 'สิบ') { total += (cur || 1) * 10; cur = 0; }
      else cur = DIGIT_WORDS[w];
    }
    return any ? total + cur : null;
  }

  const ALIASES = [
    [/ม\.?\s?อ\.?\s*ภูเก็ต/g, 'มหาวิทยาลัยสงขลานครินทร์ วิทยาเขตภูเก็ต'],
    [/มรภ\.?\s*ภูเก็ต/g, 'มหาวิทยาลัยราชภัฏภูเก็ต'],
    [/ม\.?\s?อ\.?(?=\s|$)/g, 'มหาวิทยาลัยสงขลานครินทร์'],
    [/มหาลัย|มหาลับ|มหาวิทยาลับ|มอ(?=\s|$)/g, 'มหาวิทยาลัย'],
    [/รพ\./g, 'โรงพยาบาล'],
    [/รร\./g, 'โรงเรียน'],
    [/ร\.ร\./g, 'โรงเรียน'],
    [/ม\.ราชภัฏ|ราชภัฎ/g, 'มหาวิทยาลัยราชภัฏ'],
    [/สนามบินภูเก็ต|สนามบิน ภูเก็ต/g, 'ท่าอากาศยานภูเก็ต'],
  ];
  /** Expand common Thai abbreviations / misspellings so geocoding finds the place. */
  function expandPlace(s) {
    let out = String(s || '').trim();
    for (const [re, rep] of ALIASES) out = out.replace(re, rep);
    return out.replace(/\s+/g, ' ').trim();
  }

  /** digits + number words → arabic digits; keeps everything else. */
  function normalize(text) {
    let s = normalizeDigits(text).replace(/\u200b/g, '');
    // Only convert number words in a numeric context so "ห้าง", "สี่แยก", "เก้าอี้" stay intact.
    const UNIT_AFTER = /^\s*(โมง|ทุ่ม|นาที|ชั่วโมง|ชม|วัน|สัปดาห์|อาทิตย์|นาฬิกา|ครึ่ง|ครั้ง|$)/;
    const CTX_BEFORE = /(ตี|บ่าย|ทุ่ม|อีก|ชั่วโมง|ประมาณ|ราว|เวลา|โมง)\s*$/;
    s = s.replace(NUM_RE, (w, offset, full) => {
      const n = thaiWordToNum(w);
      if (n == null) return w;
      const after = full.slice(offset + w.length);
      const before = full.slice(0, offset);
      if (!UNIT_AFTER.test(after) && !CTX_BEFORE.test(before)) return w;
      return ` ${n} `;
    });
    return s.replace(/[ \t]+/g, ' ').trim();
  }

  // ------------------------------------------------------- tokenisation
  function segment(text) {
    const s = String(text || '');
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      const seg = new Intl.Segmenter('th', { granularity: 'word' });
      return Array.from(seg.segment(s)).filter((x) => x.segment.trim()).map((x) => x.segment);
    }
    return s.split(/\s+/).filter(Boolean);
  }

  // ------------------------------------------------------- DURATION
  /**
   * "ครึ่งชั่วโมง" → 30, "ชั่วโมงนึง" → 60, "1 ชม. 20 นาที" → 80, "15-20 นาที" → 20 (upper bound = safer),
   * "ไม่กิน" → 0, "20" → 20
   */
  function parseDuration(text) {
    const raw = normalizeDigits(String(text || '')).trim();
    if (!raw) return null;
    if (/ไม่(ได้)?\s*(กิน|ทาน|อาบ|ต้อง|มี)|^ไม่$|ข้าม|^ไม่ใช้|^-$/.test(raw)) return 0;
    if (/แป๊บ|แปป|นิดเดียว|ไว\s*ๆ|เร็ว\s*ๆ/.test(raw)) return 5;
    let s = normalize(raw).replace(/ชม\.?|hrs?|hours?|h\b/gi, 'ชั่วโมง').replace(/นาที|mins?|minutes?|m\b|น\./gi, 'นาที');
    let total = 0, found = false;
    if (/ครึ่ง\s*ชั่วโมง/.test(s)) { total += 30; found = true; s = s.replace(/ครึ่ง\s*ชั่วโมง/, ' '); }
    const range = s.match(/(\d+(?:\.\d+)?)\s*(?:-|–|ถึง|ถึง|~)\s*(\d+(?:\.\d+)?)\s*(ชั่วโมง|นาที)?/);
    if (range) {
      const v = Math.max(+range[1], +range[2]);
      total += range[3] === 'ชั่วโมง' ? v * 60 : v;
      return Math.round(total);
    }
    let m = s.match(/(\d+(?:\.\d+)?)\s*ชั่วโมง(\s*ครึ่ง)?/);
    if (m) { total += +m[1] * 60 + (m[2] ? 30 : 0); found = true; s = s.replace(m[0], ' '); }
    else if ((m = s.match(/ชั่วโมง\s*(\d+)(?!\s*นาที)/))) { total += +m[1] * 60; found = true; s = s.replace(m[0], ' '); }
    else if (/ชั่วโมงครึ่ง/.test(s)) { total += 90; found = true; s = s.replace('ชั่วโมงครึ่ง', ' '); }
    else if (/ชั่วโมง/.test(s)) { total += 60; found = true; s = s.replace('ชั่วโมง', ' '); }
    m = s.match(/(\d+(?:\.\d+)?)\s*นาที/);
    if (m) { total += +m[1]; found = true; }
    else if (!found && (m = s.match(/(\d+(?:\.\d+)?)/))) { total += +m[1]; found = true; }
    return found ? Math.round(total) : null;
  }

  // ------------------------------------------------------- TIME
  /** Thai clock expressions → {h, m}. */
  function parseTime(text) {
    const s = normalize(text);
    const half = (rest) => (/^\s*ครึ่ง/.test(rest || '') ? 30 : 0);
    const minutesAfter = (rest) => {
      const mm = (rest || '').match(/^\s*(\d{1,2})\s*นาที/);
      return mm ? +mm[1] : half(rest);
    };
    let m;
    if ((m = s.match(/(\d{1,2})\s*[:.]\s*(\d{2})(?!\s*\/)/))) {
      let h = +m[1];
      const after = s.slice(m.index + m[0].length);
      if (/^\s*(pm|p\.m\.)/i.test(after) && h < 12) h += 12;
      if (h < 24 && +m[2] < 60) return { h, m: +m[2] };
    }
    if (/เที่ยงคืน/.test(s)) return { h: 0, m: 0 };
    if ((m = s.match(/เที่ยง(?!คืน)(\s*ครึ่ง)?/))) {
      const rest = s.slice(m.index + 6);
      const mm = rest.match(/^\s*(\d{1,2})\s*นาที/);
      return { h: 12, m: m[1] ? 30 : mm ? +mm[1] : 0 };
    }
    if ((m = s.match(/ตี\s*(\d{1,2})/))) {
      const h = +m[1];
      if (h >= 1 && h <= 5) return { h, m: minutesAfter(s.slice(m.index + m[0].length)) };
    }
    if ((m = s.match(/บ่าย\s*(\d{1,2})?\s*(?:โมง)?/))) {
      const n = m[1] ? +m[1] : 1;
      if (n >= 1 && n <= 5) return { h: 12 + n, m: minutesAfter(s.slice(m.index + m[0].length)) };
    }
    if ((m = s.match(/(\d{1,2})\s*ทุ่ม/)) || (m = s.match(/ทุ่ม\s*(\d)(?!\d)/))) {
      const n = +m[1];
      if (n >= 1 && n <= 5) return { h: 18 + n, m: minutesAfter(s.slice(m.index + m[0].length)) };
    }
    if ((m = s.match(/(\d{1,2})\s*โมง\s*(เช้า|เย็น|ค่ำ|ตรง)?/))) {
      let h = +m[1];
      const part = m[2];
      if (part === 'เย็น' || part === 'ค่ำ') { if (h < 12) h += 12; }
      else if (part !== 'เช้า') { if (h >= 1 && h <= 5) h += 12; }
      if (h <= 23) return { h, m: minutesAfter(s.slice(m.index + m[0].length)) };
    }
    if ((m = s.match(/(\d{1,2})\s*นาฬิกา/))) {
      const h = +m[1];
      if (h <= 23) return { h, m: minutesAfter(s.slice(m.index + m[0].length)) };
    }
    if ((m = s.match(/(\d{1,2})\s*(am|pm)/i))) {
      let h = +m[1] % 12;
      if (/pm/i.test(m[2])) h += 12;
      return { h, m: 0 };
    }
    return null;
  }

  // ------------------------------------------------------- DATE
  const DAYS = [
    ['อาทิตย์', 0], ['จันทร์', 1], ['อังคาร', 2], ['พุธ', 3], ['พฤหัสบดี', 4], ['พฤหัส', 4], ['ศุกร์', 5], ['เสาร์', 6],
  ];
  const MONTHS = [
    ['มกราคม', 0], ['ม.ค.', 0], ['กุมภาพันธ์', 1], ['ก.พ.', 1], ['มีนาคม', 2], ['มี.ค.', 2], ['เมษายน', 3], ['เม.ย.', 3],
    ['พฤษภาคม', 4], ['พ.ค.', 4], ['มิถุนายน', 5], ['มิ.ย.', 5], ['กรกฎาคม', 6], ['ก.ค.', 6], ['สิงหาคม', 7], ['ส.ค.', 7],
    ['กันยายน', 8], ['ก.ย.', 8], ['ตุลาคม', 9], ['ต.ค.', 9], ['พฤศจิกายน', 10], ['พ.ย.', 10], ['ธันวาคม', 11], ['ธ.ค.', 11],
  ];

  function fixYear(y) {
    if (y == null) return null;
    y = +y;
    if (y > 2400) return y - 543; // Buddhist era
    if (y < 100) return y >= 50 ? 2500 + y - 543 : 2000 + y;
    return y;
  }

  /** → { date: Date|null, repeat: number[]|null } */
  function parseDate(text, now = new Date()) {
    const s = normalize(text);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const plus = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);

    // repeat rules
    if (/ทุกวัน\s*(ธรรมดา|ทำงาน)|วันธรรมดา|จันทร์\s*(-|ถึง|–)\s*ศุกร์|จ\.\s*-\s*ศ\./.test(s)) return { date: null, repeat: [1, 2, 3, 4, 5] };
    if (/ทุก\s*(เสาร์\s*-?\s*อาทิตย์|วันหยุด|สุดสัปดาห์)/.test(s)) return { date: null, repeat: [0, 6] };
    const every = s.match(/ทุก\s*(?:วัน)?\s*((?:(?:จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์)[\s,และ]*)+)/);
    if (every) {
      const set = new Set();
      for (const [name, d] of DAYS) if (every[1].includes(name)) set.add(d);
      if (set.size) return { date: null, repeat: [...set].sort() };
    }
    if (/ทุกวัน(?!\s*(จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์))/.test(s)) return { date: null, repeat: [0, 1, 2, 3, 4, 5, 6] };

    // relative words
    if (/มะรืน/.test(s)) return { date: plus(2), repeat: null };
    if (/พรุ่งนี้|พรุ่งนี/.test(s)) return { date: plus(1), repeat: null };
    let m = s.match(/อีก\s*(\d+)\s*วัน/) || s.match(/(\d+)\s*วัน\s*ข้างหน้า/);
    if (m) return { date: plus(+m[1]), repeat: null };
    if ((m = s.match(/อีก\s*(\d+)\s*(สัปดาห์|อาทิตย์)/))) return { date: plus(7 * +m[1]), repeat: null };

    // explicit dates: 25/11, 25/11/69, 25-11-2026
    if ((m = s.match(/(\d{1,2})\s*[/-]\s*(\d{1,2})(?:\s*[/-]\s*(\d{2,4}))?/))) {
      const d = +m[1], mo = +m[2] - 1;
      if (d >= 1 && d <= 31 && mo >= 0 && mo <= 11) {
        let y = fixYear(m[3]) ?? today.getFullYear();
        let date = new Date(y, mo, d);
        if (!m[3] && date < today) date = new Date(y + 1, mo, d);
        return { date, repeat: null };
      }
    }
    // 25 พ.ย. 69 / 3 ธันวาคม
    for (const [name, mo] of MONTHS) {
      const idx = s.indexOf(name);
      if (idx < 0) continue;
      const before = s.slice(0, idx).match(/(\d{1,2})\s*$/);
      if (!before) continue;
      const after = s.slice(idx + name.length).match(/^\s*(\d{2,4})/);
      const y = fixYear(after && after[1]) ?? today.getFullYear();
      let date = new Date(y, mo, +before[1]);
      if (!after && date < today) date = new Date(y + 1, mo, +before[1]);
      return { date, repeat: null };
    }
    // weekday names: "วันจันทร์", "จันทร์หน้า", "วันอาทิตย์หน้า" ('อาทิตย์หน้า' alone = next week)
    for (const [name, dow] of DAYS) {
      const re = name === 'อาทิตย์' ? /วัน\s*อาทิตย์(\s*หน้า)?/ : new RegExp(`(?:วัน\\s*)?${name}(\\s*หน้า)?`);
      const mm = s.match(re);
      if (!mm) continue;
      let diff = (dow - today.getDay() + 7) % 7;
      if (mm[1] && diff === 0) diff = 7;
      return { date: plus(diff), repeat: null };
    }
    if (/(สัปดาห์|อาทิตย์)\s*หน้า/.test(s)) return { date: plus(7), repeat: null };
    if (/วันนี้|คืนนี้|เช้านี้|เย็นนี้|บ่ายนี้/.test(s)) return { date: today, repeat: null };
    return { date: null, repeat: null };
  }

  // ------------------------------------------------------- CLASSIFY
  const CATEGORIES = [
    { id: 'exam', label: 'สอบ', emoji: '📝', importance: 'critical', arriveEarly: 30, words: ['สอบ', 'ควิซ', 'quiz', 'midterm', 'final', 'ไฟนอล', 'มิดเทอม', 'สอบปลายภาค', 'สอบกลางภาค'],
      tasks: [{ label: 'เช็คบัตรนักศึกษา/บัตรประชาชน + ปากกา', min: 5, emoji: '🪪' }] },
    { id: 'flight', label: 'เดินทางไกล', emoji: '✈️', importance: 'critical', arriveEarly: 120, words: ['สนามบิน', 'ท่าอากาศยาน', 'เที่ยวบิน', 'ขึ้นเครื่อง', 'บิน', 'flight', 'รถทัวร์', 'รถไฟ', 'บขส'],
      tasks: [{ label: 'เช็คพาสปอร์ต/บัตร/ตั๋ว', min: 10, emoji: '🎫' }] },
    { id: 'interview', label: 'สัมภาษณ์', emoji: '🤝', importance: 'critical', arriveEarly: 20, words: ['สัมภาษณ์', 'interview'],
      tasks: [{ label: 'เตรียมเอกสาร/Resume', min: 10, emoji: '📄' }] },
    { id: 'class', label: 'เรียน', emoji: '🎓', importance: 'important', arriveEarly: 10, words: ['เรียน', 'คาบ', 'เลคเชอร์', 'lecture', 'มหาวิทยาลัย', 'มหาลัย', 'โรงเรียน', 'วิชา', 'แล็บ', 'lab', 'เซค', 'section', 'ติว'],
      tasks: [{ label: 'จัดกระเป๋า/เช็คตารางเรียน', min: 5, emoji: '🎒' }] },
    { id: 'work', label: 'ทำงาน', emoji: '💼', importance: 'important', arriveEarly: 10, words: ['งาน', 'ทำงาน', 'ออฟฟิศ', 'office', 'ประชุม', 'meeting', 'กะ', 'เข้างาน', 'ลูกค้า'], tasks: [] },
    { id: 'health', label: 'สุขภาพ', emoji: '🏥', importance: 'important', arriveEarly: 20, words: ['หมอ', 'โรงพยาบาล', 'คลินิก', 'ทำฟัน', 'ทันตกรรม', 'ฉีดวัคซีน', 'ตรวจสุขภาพ', 'นัดหมอ'],
      tasks: [{ label: 'เตรียมบัตรนัด/บัตรประชาชน', min: 5, emoji: '🪪' }] },
    { id: 'sport', label: 'ออกกำลังกาย', emoji: '🏃', importance: 'normal', arriveEarly: 5, words: ['ฟิตเนส', 'ยิม', 'gym', 'วิ่ง', 'ฟุตบอล', 'บอล', 'แบด', 'ว่ายน้ำ', 'ออกกำลัง', 'โยคะ'], tasks: [] },
    { id: 'social', label: 'นัดเพื่อน', emoji: '☕', importance: 'normal', arriveEarly: 5, words: ['เพื่อน', 'นัด', 'ปาร์ตี้', 'เดท', 'กินข้าวกับ', 'คาเฟ่', 'ดูหนัง', 'เที่ยว'], tasks: [] },
  ];
  const DEFAULT_CAT = { id: 'other', label: 'ทั่วไป', emoji: '📌', importance: 'normal', arriveEarly: 10, tasks: [] };

  /** Lexicon scoring classifier. Longer keyword matches score higher; tokens are matched exactly. */
  function classify(text, tokens) {
    const s = String(text || '').toLowerCase();
    const toks = new Set((tokens || []).map((t) => t.toLowerCase()));
    let best = null, bestScore = 0;
    for (const cat of CATEGORIES) {
      let score = 0;
      for (const w of cat.words) {
        if (toks.has(w)) score += 2 + w.length / 10;
        else if (s.includes(w)) score += 1 + w.length / 10;
      }
      if (score > bestScore) { best = cat; bestScore = score; }
    }
    const cat = best || DEFAULT_CAT;
    return { id: cat.id, label: cat.label, emoji: cat.emoji, importance: cat.importance, arriveEarly: cat.arriveEarly, tasks: cat.tasks, score: +bestScore.toFixed(2) };
  }

  // ------------------------------------------------------- PLACE + TITLE
  const STOP = /^(พรุ่งนี้|วันนี้|มะรืน|มะรืนนี้|วัน|ตอน|เวลา|ช่วง|ประมาณ|ราว|ก่อน|หลัง|ทุก|อีก|ตี|บ่าย|เที่ยง|เที่ยงคืน|ทุ่ม|โมง|เช้า|เย็น|ค่ำ|คืน|นี้|หน้า|น\.|นาฬิกา|จันทร์|อังคาร|พุธ|พฤหัส|พฤหัสบดี|ศุกร์|เสาร์|อาทิตย์|ครับ|ค่ะ|คะ|นะ|จ้า|\d.*)$/;
  const PLACE_HINT = /มหาวิทยาลัย|มหาลัย|โรงเรียน|โรงพยาบาล|คลินิก|สนามบิน|ท่าอากาศยาน|เซ็นทรัล|ห้าง|บริษัท|ออฟฟิศ|ตลาด|สถานี|ยิม|ฟิตเนส|คาเฟ่|ร้าน|ม\.|รพ\.|รร\.|บ้าน|หอ|ตึก|อาคาร|สนาม|ภูเก็ต|กรุงเทพ/;
  const TRIGGERS = ['ที่', 'ไป', 'ณ', 'แถว', 'ถึง'];

  function extractPlace(text, tokens) {
    const toks = tokens && tokens.length ? tokens : segment(text);
    let start = -1;
    // prefer explicit locative markers ("ที่", "ณ") over the verb "ไป" ("ไปเรียนที่ ม.อ." → ม.อ.)
    for (const trig of ['ที่', 'ณ', 'แถว']) {
      start = toks.indexOf(trig);
      if (start >= 0) break;
    }
    for (let i = 0; start < 0 && i < toks.length; i++) {
      if (toks[i] === 'ไป' || toks[i] === 'ถึง' || (/^ไป/.test(toks[i]) && toks[i].length > 2 && PLACE_HINT.test(toks[i]))) start = i;
    }
    let picked = [];
    if (start >= 0) {
      let first = toks[start];
      // tokens like "ไปมหาลัย" glued together
      if (first !== 'ไป' && first.startsWith('ไป')) picked.push(first.slice(2));
      for (let i = start + 1; i < toks.length; i++) {
        const t = toks[i].trim();
        if (!t) continue;
        if (STOP.test(t)) break;
        if (TRIGGERS.includes(t) && picked.length) break;
        picked.push(t);
      }
    }
    if (!picked.length) {
      const hint = toks.findIndex((t) => PLACE_HINT.test(t));
      if (hint >= 0) {
        for (let i = hint; i < toks.length && !STOP.test(toks[i].trim()); i++) picked.push(toks[i].trim());
      }
    }
    const place = picked.join('').replace(/\s+/g, ' ').trim();
    return place.length >= 2 ? place : '';
  }

  function stripDateTime(text) {
    return normalize(text)
      .replace(/ทุกวัน\S*|ทุก\s*\S+|วันธรรมดา/g, ' ')
      .replace(/พรุ่งนี้|มะรืน(นี้)?|วันนี้|คืนนี้|เช้านี้|เย็นนี้|อีก\s*\d+\s*(วัน|สัปดาห์)/g, ' ')
      .replace(/(วัน)?(จันทร์|อังคาร|พุธ|พฤหัสบดี|พฤหัส|ศุกร์|เสาร์|อาทิตย์)(หน้า)?/g, ' ')
      .replace(/\d{1,2}\s*[/-]\s*\d{1,2}(\s*[/-]\s*\d{2,4})?/g, ' ')
      .replace(/\d{1,2}\s*[:.]\s*\d{2}\s*(น\.|นาฬิกา)?/g, ' ')
      .replace(/(ตอน|เวลา|ช่วง)?\s*(ตี|บ่าย)\s*\d*\s*(โมง)?(\s*ครึ่ง)?/g, ' ')
      .replace(/\d+\s*(โมง|ทุ่ม|นาฬิกา)\s*(เช้า|เย็น|ค่ำ|ตรง)?(\s*ครึ่ง)?/g, ' ')
      .replace(/เที่ยง(คืน)?(ครึ่ง)?/g, ' ')
      .replace(/\b(ตอน|เวลา)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Full quick-add parser.
   * @param text  e.g. "พรุ่งนี้ไปเรียนที่ ม.อ.ภูเก็ต 8 โมงเช้า"
   * @param opts  { tokens?, pos?, engine?, now? }
   */
  function parseActivity(text, opts = {}) {
    const now = opts.now || new Date();
    const tokens = opts.tokens && opts.tokens.length ? opts.tokens : segment(text);
    const time = parseTime(text);
    const { date, repeat } = parseDate(text, now);
    const cat = classify(text, tokens);
    let place = extractPlace(text, tokens);
    // drop time/date leftovers that slipped into the place
    place = stripDateTime(place).replace(/(ตอน|เวลา)$/, '').trim();

    let title = stripDateTime(text).replace(/^(ฉัน|ผม|เรา|หนู|อยาก|ต้อง|จะ)+/, '').trim();
    if (place) {
      const idx = title.indexOf(place);
      if (idx > 0) title = title.slice(0, idx).replace(/(ที่|ณ|แถว)\s*$/, '').trim() || title;
    }
    title = title.replace(/\s*(ตอน|เวลา|ที่)$/, '').trim();
    if (!title || title.length < 2) title = place ? `ไป${place}` : cat.label;
    if (title.length > 60) title = title.slice(0, 60);

    // default date when only a time is given: today if still ahead, else tomorrow
    let finalDate = date;
    if (!finalDate && !repeat && time) {
      const t = new Date(now); t.setHours(time.h, time.m, 0, 0);
      finalDate = t > now ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    }

    const fields = [time, finalDate || repeat, place].filter(Boolean).length;
    const pad = (n) => String(n).padStart(2, '0');
    return {
      title,
      time: time ? `${pad(time.h)}:${pad(time.m)}` : null,
      date: finalDate ? `${finalDate.getFullYear()}-${pad(finalDate.getMonth() + 1)}-${pad(finalDate.getDate())}` : null,
      repeat,
      place,
      placeQuery: expandPlace(place),
      category: cat,
      tokens,
      pos: opts.pos || null,
      engine: opts.engine || (typeof Intl !== 'undefined' && Intl.Segmenter ? 'Intl.Segmenter (th)' : 'whitespace'),
      confidence: +(fields / 3).toFixed(2),
    };
  }

  return {
    normalizeDigits, thaiWordToNum, normalize, expandPlace, segment,
    parseDuration, parseTime, parseDate, classify, extractPlace, parseActivity,
    CATEGORIES, DEFAULT_CAT,
  };
});
