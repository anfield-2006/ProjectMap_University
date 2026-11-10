// End-to-end smoke test: node tests/e2e.mjs  (server must be running on :5500)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.AW_URL || 'http://127.0.0.1:5500';
const OUT = new URL('./screenshots/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(OUT, { recursive: true });
const errors = [];
const ok = (cond, msg) => { if (!cond) throw new Error('FAIL: ' + msg); console.log('✓', msg); };

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1360, height: 900 }, locale: 'th-TH', timezoneId: 'Asia/Bangkok',
  geolocation: { latitude: 7.8804, longitude: 98.3923 }, permissions: ['geolocation'],
});
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/tile|openstreetmap|favicon/i.test(m.text()) && !(m.location().url || '').includes('api/health')) errors.push(m.text()); });

await page.goto(BASE);
// ---- onboarding: 3 questions
await page.waitForSelector('#onboarding:not(.hidden)');
ok(await page.locator('.q-num').innerText() === 'คำถามที่ 1 / 3', 'onboarding starts at question 1/3');
await page.fill('#onbInput', 'ครึ่งชั่วโมง');
ok((await page.locator('#onbParsed').innerText()).includes('30'), 'NLP duration: "ครึ่งชั่วโมง" → 30');
await page.screenshot({ path: OUT + '01-onboarding.png' });
await page.click('#onbNext');
await page.click('.chips .chip[data-v="15"]');
await page.click('#onbNext');
await page.fill('#onbInput', 'สิบนาที');
ok((await page.locator('#onbParsed').innerText()).includes('10'), 'NLP duration: "สิบนาที" → 10');
await page.click('#onbNext');
await page.click('#onbGps');
await page.waitForFunction(() => document.querySelector('#onbHome').textContent.startsWith('✓'), null, { timeout: 15000 });
ok(true, 'home set from GPS');
await page.click('#onbDone');
await page.waitForURL(/#\/add/);

// ---- NLP quick add
await page.fill('#nlpInput', 'พรุ่งนี้ไปเรียนที่ ม.อ.ภูเก็ต 8 โมงเช้า');
await page.click('#nlpBtn');
await page.waitForSelector('.entities');
const ents = await page.locator('.entities').innerText();
ok(ents.includes('08:00'), 'NLP TIME = 08:00');
ok(/ม\.อ\.ภูเก็ต|ม\.อ\./.test(ents), 'NLP PLACE contains ม.อ.ภูเก็ต');
ok(ents.includes('เรียน'), 'NLP CATEGORY = เรียน');
const engine = await page.locator('#nlpOut .explain').innerText();
console.log('  engine:', engine.split('·')[0]);
await page.waitForSelector('#placeResults button', { timeout: 20000 });
await page.click('#placeResults button >> nth=0');
await page.waitForFunction(() => /กม\./.test(document.querySelector('#routeInfo').textContent), null, { timeout: 20000 });
ok(true, 'route computed: ' + (await page.locator('#routeInfo').innerText()));
await page.screenshot({ path: OUT + '02-add.png', fullPage: true });
await page.click('#saveBtn');
await page.waitForURL(/#\/today/);

// ---- today plan
await page.waitForSelector('.wake-big .t');
const wake = await page.locator('.wake-big .t').innerText();
ok(/^\d{2}:\d{2}$/.test(wake), 'wake time shown: ' + wake);
ok(await page.locator('.step').count() >= 5, 'checklist has wake/prep/depart/arrive steps');
ok(await page.locator('#todayMap .leaflet-tile, #todayMap .leaflet-marker-icon').count() > 0, 'map rendered');
const gm = await page.getAttribute('#gmapsBtn', 'href');
ok(gm.startsWith('https://www.google.com/maps/dir/?api=1'), 'Google Maps deep link');
await page.click('.step .dot >> nth=0');
await page.waitForSelector('.step.done');
ok(true, 'checklist step can be ticked');
await page.click('#gpsBtn');
await page.waitForFunction(() => /กม\./.test(document.querySelector('#liveBox')?.textContent || ''), null, { timeout: 20000 });
ok(true, 'live GPS box: ' + (await page.locator('#liveBox .gps-live').innerText()).replace(/\s+/g, ' '));
// scroll for reveal animations, then screenshot
for (let y = 0; y < 4000; y += 500) { await page.mouse.wheel(0, 500); await page.waitForTimeout(80); }
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(400);
await page.screenshot({ path: OUT + '03-today.png', fullPage: true });

// ---- alarm modal
await page.click('#testAlarm');
await page.waitForSelector('#alarmDialog[open]');
await page.screenshot({ path: OUT + '04-alarm.png' });
await page.click('#alarmStop');
ok(!(await page.locator('#alarmDialog[open]').count()), 'alarm opens and closes');

// ---- second activity with conflict → activities page
await page.goto(BASE + '/#/add');
await page.fill('#nlpInput', 'สอบไฟนอลพรุ่งนี้ 8 โมงครึ่ง');
await page.click('#nlpBtn');
await page.waitForSelector('.entities');
await page.waitForTimeout(1500);
await page.click('#saveBtn');
await page.waitForURL(/#\/today/);
await page.goto(BASE + '/#/activities');
await page.waitForSelector('.act');
ok(await page.locator('.act').count() === 2, 'two activities listed');
ok(await page.locator('.pill-danger').count() >= 1, 'sweep-line conflict detected');
await page.screenshot({ path: OUT + '05-activities.png', fullPage: true });

// ---- buffer is sane for a short city trip
await page.goto(BASE + '/#/today');
await page.waitForSelector('.wake-big .t');
const bufTxt = await page.locator('.budget-legend').innerText();
const bufMin = +(bufTxt.match(/อุบัติเหตุ (\d+) นาที/) || [])[1];
ok(bufMin > 0 && bufMin <= 15, `buffer for a ~7 km trip is ${bufMin} min`);

// ---- home pin: click on the settings map
await page.goto(BASE + '/#/settings');
await page.waitForSelector('#homeMap .leaflet-marker-icon');
const before = await page.evaluate(() => JSON.parse(localStorage.getItem('arrivewise.v1')).profile.home);
const box = await page.locator('#homeMap').boundingBox();
await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.3);
await page.waitForFunction(() => document.querySelector('#homeLabel').textContent.startsWith('✓'), null, { timeout: 15000 });
await page.waitForTimeout(1500);
const after = await page.evaluate(() => JSON.parse(localStorage.getItem('arrivewise.v1')).profile.home);
ok(after.lat !== before.lat || after.lng !== before.lng, `home re-pinned: ${after.label.slice(0, 40)}`);
await page.screenshot({ path: OUT + '07-settings-homepin.png' });

// ---- mobile
const m = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, locale: 'th-TH', timezoneId: 'Asia/Bangkok' });
const mp = await m.newPage();
mp.on('pageerror', (e) => errors.push('mobile: ' + e.message));
await mp.goto(BASE);
await mp.evaluate((s) => localStorage.setItem('arrivewise.v1', s), await page.evaluate(() => localStorage.getItem('arrivewise.v1')));
await mp.reload();
await mp.waitForSelector('.wake-big .t');
await mp.waitForTimeout(900);
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
ok(!overflow, 'no horizontal overflow on 390px');
await mp.screenshot({ path: OUT + '06-mobile.png' });

ok(errors.length === 0, 'no JS errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close();
console.log('\nALL E2E CHECKS PASSED · screenshots in tests/screenshots/');
