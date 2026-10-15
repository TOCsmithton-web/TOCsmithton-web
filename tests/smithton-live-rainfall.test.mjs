import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { liveObservation, parseDailyCsv, completedDaily } from "../supabase/functions/smithton-live-rainfall/observations.mjs";

const now = Date.parse("2026-10-16T09:45:00+11:00");
function row(iso, rain = "0.0", wmo = 94953) {
  return { wmo, aifstime_utc: new Date(iso).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14), rain_trace: rain };
}
function payload(...rows) { return { observations: { data: rows } }; }
function live(iso = "2026-10-16T09:30:00+11:00", rain = "0.0", clock = now) {
  return liveObservation(payload(row(iso, rain)), clock);
}
function baseline() {
  return {
    station: "091292", latest_date: "2026-10-16",
    daily: { "2026-10-16": 0, "2026-10-15": 0, "2026-10-14": 0, "2026-10-13": 7.1, "2026-10-12": 8.1, "2026-10-11": 6, "2026-10-10": 0 },
    live: live("2026-10-16T09:00:00+11:00")
  };
}
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const browserSource = fs.readFileSync(new URL("../smithton-rainfall-live.js", import.meta.url), "utf8");
async function refresh(base, fetcher) {
  const sandbox = { Date: Clock, fetch: fetcher, AbortController, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  vm.runInNewContext(browserSource, sandbox);
  return sandbox.TOCSmithtonRainfall.refreshLive(base);
}
const response = (observation, station = "091292") => async () => ({ ok: true, json: async () => ({ station, live: observation }) });

test("post-9am measured zero starts the new Hobart rainfall period", () => {
  const result = live();
  assert.equal(result.rain_since_9am, 0);
  assert.equal(result.period_start, "2026-10-16T09:00:00+11:00");
  assert.equal(result.period_end, "2026-10-17T09:00:00+11:00");
  assert.equal(result.forecast_period_ends.length, 7);
});
test("exactly 9am is not promoted into the next period", () => {
  const result = live("2026-10-16T09:00:00+11:00");
  assert.equal(result.period_end, "2026-10-16T09:00:00+11:00");
  assert.ok(Date.parse(result.period_end) < now);
});
test("missing, null and nonnumeric rainfall never become zero", () => {
  for (const value of [null, undefined, "", " ", "N/A", "-", -1, Infinity]) {
    assert.throws(() => liveObservation(payload({ ...row("2026-10-16T09:30:00+11:00"), rain_trace: value }), now), /no numeric/);
  }
});
test("stale, future, invalid-date and other-station observations are rejected", () => {
  assert.throws(() => live("2026-10-16T08:00:00+11:00"), /stale/);
  assert.throws(() => live("2026-10-16T10:00:00+11:00"), /future/);
  assert.throws(() => liveObservation(payload({ wmo: 94953, aifstime_utc: "20261301223000", rain_trace: "0.0" }), now), /numeric/);
  assert.throws(() => liveObservation(payload(row("2026-10-16T09:30:00+11:00", "0.0", 94970)), now), /numeric/);
});
test("latest numeric Smithton reading wins regardless of row order", () => {
  const result = liveObservation(payload(row("2026-10-16T09:00:00+11:00"), row("2026-10-16T09:30:00+11:00", "1.2")), now);
  assert.equal(result.rain_since_9am, 1.2);
});
test("Hobart 9am periods preserve daylight-saving offsets", () => {
  const spring = live("2026-10-03T09:30:00+10:00", "0.0", Date.parse("2026-10-03T10:00:00+10:00"));
  assert.equal(spring.period_start, "2026-10-03T09:00:00+10:00");
  assert.equal(spring.period_end, "2026-10-04T09:00:00+11:00");
  assert.equal(Date.parse(spring.period_end) - Date.parse(spring.period_start), 23 * 3600000);
  const autumn = live("2026-04-04T09:30:00+11:00", "0.0", Date.parse("2026-04-04T10:00:00+11:00"));
  assert.equal(autumn.period_end, "2026-04-05T09:00:00+10:00");
  assert.equal(Date.parse(autumn.period_end) - Date.parse(autumn.period_start), 25 * 3600000);
});
test("daily CSV preserves measured zero while excluding blank, unknown and future records", () => {
  const csv = '"Station, Smithton"\r\nProduct,Date,Rainfall (mm),Notes\r\nID,2026-10-14,,missing\r\nID,2026-10-15,N/A,unknown\r\nID,2026-10-16,0.0,observed\r\nID,2026-10-17,3.2,future\r\n';
  assert.deepEqual(parseDailyCsv(csv, "2026-10-16"), { "2026-10-16": 0 });
});
test("completed daily retrieval handles a month boundary without inventing failed records", async () => {
  const urls = [];
  const result = await completedDaily("2026-11-02", "2026-11-01", async url => {
    urls.push(url);
    if (url.includes("202610")) throw new Error("BOM daily unavailable");
    return { ok: true, text: async () => "Date,Rainfall (mm)\n2026-11-01,2.1\n2026-11-02,0.0\n2026-11-03,\n" };
  });
  assert.equal(urls.length, 2);
  assert.deepEqual(result.daily, { "2026-11-01": 2.1, "2026-11-02": 0 });
  assert.equal(result.daily_errors.length, 1);
  assert.deepEqual(await completedDaily("2026-11-02", "2026-11-02", () => { throw new Error("should not fetch"); }), { daily: {}, daily_errors: [] });
});
test("Refresh replaces the expired 9am reading with measured 9:30am zero, preserving daily history", async () => {
  const base = baseline();
  const result = await refresh(base, response(live()));
  assert.equal(result.live.observed_at, "2026-10-15T22:30:00.000Z");
  assert.equal(result.live.rain_since_9am, 0);
  assert.equal(result.daily, base.daily);
  assert.equal(result.latest_date, base.latest_date);
  assert.equal(base.live.period_end, "2026-10-16T09:00:00+11:00");
});
test("Refresh failure keeps the old expired reading and missing days intact", async () => {
  const base = baseline();
  delete base.daily["2026-10-14"];
  const result = await refresh(base, async () => { throw new Error("Network unavailable"); });
  assert.equal(result.live, base.live);
  assert.equal(result.daily, base.daily);
  assert.equal(result.daily["2026-10-14"], undefined);
  assert.match(result.live_refresh_error, /Network/);
});
test("an authoritative daily record fills a rollover gap without treating unknown fields as zero", async () => {
  const base = baseline();
  base.latest_date = "2026-10-15";
  delete base.daily["2026-10-16"];
  delete base.daily["2026-10-14"];
  const result = await refresh(base, async () => ({ ok: true, json: async () => ({ station: "091292", live: live(), daily: { "2026-10-16": 0, "2026-10-14": null, "2026-10-17": 8 } }) }));
  assert.equal(result.daily["2026-10-16"], 0);
  assert.equal(result.latest_date, "2026-10-16");
  assert.equal(result.daily["2026-10-14"], undefined);
  assert.equal(result.daily["2026-10-17"], undefined);
  assert.equal(base.daily["2026-10-16"], undefined);
});
test("invalid live data, wrong station and old period cannot replace confirmed history", async () => {
  for (const observation of [live("2026-10-16T09:00:00+11:00"), { ...live(), rain_since_9am: null }, { ...live(), forecast_period_ends: [] }]) {
    const base = baseline();
    const result = await refresh(base, response(observation));
    assert.equal(result.live, base.live);
    assert.ok(result.live_refresh_error);
  }
  const base = baseline();
  assert.equal((await refresh(base, response(live(), "094250"))).live, base.live);
});
test("an older endpoint reading cannot overwrite a newer static reading", async () => {
  const base = baseline();
  base.live = live("2026-10-16T09:40:00+11:00", "0.2");
  assert.equal(await refresh(base, response(live())), base);
});

const page = fs.readFileSync(new URL("../control-new.html", import.meta.url), "utf8");
const weatherSource = page.slice(page.indexOf("async function weather(){"), page.indexOf("function renderRiverHistory("));
function element() { return { innerHTML: "", textContent: "", style: {}, children: [], appendChild(child) { this.children.push(child); }, replaceChildren() { this.children = []; } }; }
async function weatherResult(base, observation, fail = false, daily = undefined) {
  const forecast = element();
  const hourly = { time: [], precipitation: [] };
  for (let t = Date.parse("2026-10-15T00:00:00Z"); t <= Date.parse("2026-10-25T00:00:00Z"); t += 3600000) { hourly.time.push(t / 1000); hourly.precipitation.push(0); }
  const data = { hourly, daily: { time: [], precipitation_sum: [], temperature_2m_max: [], temperature_2m_min: [] } };
  const sandbox = {
    Date: Clock, Intl, AbortController, setTimeout, clearTimeout,
    el: () => forecast, document: { createElement: element },
    save() {}, render() {}, checkAlerts() {}, bayName: () => "Duck Bay", bayRainLimit: () => 40, DUCK_RAIN3_LIMIT: 25,
    console: { error() {} }, previous7Total: NaN, previous3Total: NaN, previous24Total: NaN,
    fetch: async (url) => {
      if (url.startsWith("https://api.open-meteo.com/")) return { ok: true, json: async () => data };
      if (url.startsWith("./smithton-rainfall.json")) return { ok: true, json: async () => base };
      if (fail) throw new Error("Network unavailable");
      return { ok: true, json: async () => ({ station: "091292", live: observation, daily }) };
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(browserSource + "\n" + weatherSource, sandbox);
  await sandbox.weather();
  return { sandbox, forecast };
}
test("weather rendering uses the fresh post-9am observation with existing measured totals", async () => {
  const { sandbox, forecast } = await weatherResult(baseline(), live());
  assert.equal(sandbox.previous7Total, 21.2);
  assert.equal(sandbox.previous3Total, 0);
  assert.equal(sandbox.previous24Total, 0);
  assert.match(forecast.innerHTML, /Live 7-day rainfall/);
  assert.match(forecast.innerHTML, /21\.2 mm/);
});
test("failed live refresh after the 9am cutoff remains pending", async () => {
  const { sandbox, forecast } = await weatherResult(baseline(), null, true);
  assert.ok(Number.isNaN(sandbox.previous7Total));
  assert.match(forecast.children[0].children[0].textContent, /LIVE RAINFALL PENDING/);
  assert.match(forecast.children[0].children[1].textContent, /post-9am/);
});
test("weather can cross 9am even when the Pages file has not recorded today's completed day", async () => {
  const base = baseline();
  base.latest_date = "2026-10-15";
  delete base.daily["2026-10-16"];
  const { sandbox, forecast } = await weatherResult(base, live(), false, { "2026-10-16": 0 });
  assert.equal(sandbox.previous7Total, 21.2);
  assert.match(forecast.innerHTML, /Live 7-day rainfall/);
});
test("a fresh live observation cannot fill a missing completed day", async () => {
  const base = baseline();
  delete base.daily["2026-10-14"];
  const { sandbox, forecast } = await weatherResult(base, live());
  assert.ok(Number.isNaN(sandbox.previous7Total));
  assert.match(forecast.children[0].children[1].textContent, /Missing completed BOM rainfall day/);
});
test("the fixed Duck Bay thresholds remain 40mm over 7 days and 25mm over 3 days", () => {
  assert.match(page, /40 mm \/ 7-day and 25 mm \/ 3-day/);
  assert.match(page, /var DUCK_RAIN3_LIMIT=25/);
});
