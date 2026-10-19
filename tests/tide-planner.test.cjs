const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { forecast, windKmh } = require('../boomer-planner.js');
const SmithtonTides = require('../smithton-tide-model.js');
const H = 3600, start = Date.parse('2026-10-24T00:00:00+11:00') / 1000;

function fixture(unit = 'km/h') {
  const time = Array.from({ length: 73 }, (_, i) => start - 24 * H + i * H);
  const values = v => time.map(() => v);
  return {
    updated_at: new Date(start * 1000).toISOString(), location: { id: 'smithton' }, tide_mode: 'bom',
    weather: {
      hourly_units: { wind_speed_10m: unit, wind_gusts_10m: unit },
      hourly: { time, wind_speed_10m: values(0), wind_gusts_10m: values(0), wind_direction_10m: values(0), pressure_msl: values(1013.25) },
      daily: { time: [start], sunrise: [start + 6 * H], sunset: [start + 19 * H] }
    },
    tides: { station: { name: 'Burnie', reference_only: true }, datum: 'BOM prediction datum',
      extremes: [-4, 2, 8, 14, 20, 26, 32].map((h, i) => ({ dt: start + h * H, type: i % 2 ? 'Low' : 'High', height: i % 2 ? 1 : 3 })) }
  };
}

async function render(data) {
  const elements = new Map();
  const doc = { title: '', getElementById(id) { if (!elements.has(id)) elements.set(id, { textContent: '', innerHTML: '', value: '' }); return elements.get(id); } };
  class FixedDate extends Date { static now() { return start * 1000; } }
  const context = { document: doc, SmithtonTides, Date: FixedDate, Intl, URL, URLSearchParams, location: { search: '?location=smithton' },
    setInterval() {}, fetch: async () => ({ ok: true, json: async () => data }) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'boomer-planner.js'), 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  return Object.fromEntries(elements);
}

test('wind conversions change values and preserve the original physical screening limits', () => {
  assert.equal(windKmh(fixture('kn'), 10), 18.52);
  assert.equal(windKmh(fixture('km/h'), 10), 10);
  assert.equal(windKmh(fixture('m/s'), 10), 36);
  for (const speed of [14, 16]) {
    const kn = fixture('kn'), kmh = fixture('km/h');
    kn.weather.hourly.wind_speed_10m.fill(speed); kn.weather.hourly.wind_gusts_10m.fill(speed + 2);
    kmh.weather.hourly.wind_speed_10m.fill(speed * 1.852); kmh.weather.hourly.wind_gusts_10m.fill((speed + 2) * 1.852);
    const a = forecast(kn, start)[0].best, b = forecast(kmh, start)[0].best;
    assert.equal(a.wind, b.wind); assert.equal(a.gust, b.gust); assert.equal(a.poor, b.poor); assert.equal(a.score, b.score);
    assert.equal(a.poor, speed > 15);
  }
});

test('Smithton retains a 2 am low and its previous-day 10 pm window without clamping to 4 am', async () => {
  const data = fixture(), model = SmithtonTides.model(data), low = data.tides.extremes[1];
  const p = model.plan(low);
  assert.ok(p); assert.equal(p.start, low.dt - 4 * H); assert.equal(p.end - p.start, 4 * H);
  const ui = await render(data), html = ui.days.innerHTML;
  assert.match(html, /Low tide 1 · 2:00 am/);
  assert.match(html, /10:00 pm \(23 Oct\)/);
  assert.doesNotMatch(html, /between 4 am|Start moved to 4 am/);
  assert.match(ui.assessment.textContent, /no earliest start or evening cutoff/);
});

test('Smithton includes a low after 7 pm and renders table wind values in km/h', async () => {
  const data = fixture('kn');
  data.tides.extremes.forEach(e => { e.dt += 7 * H; });
  data.weather.hourly.wind_speed_10m.fill(10); data.weather.hourly.wind_gusts_10m.fill(12);
  const ui = await render(data);
  assert.match(ui.days.innerHTML, /Low tide 2 · 9:00 pm/);
  assert.match(ui.days.innerHTML, />19 km\/h<\/td>/);
  assert.doesNotMatch(ui.days.innerHTML, /\bkn\b/);
});

test('missing tide coverage is labelled unavailable and is never reported as zero low tides', async () => {
  const data = fixture(); data.tides.extremes = [];
  const ui = await render(data);
  assert.match(ui.days.innerHTML, /Tide data unavailable/);
  assert.doesNotMatch(ui.days.innerHTML, /0 low tides/);
});
