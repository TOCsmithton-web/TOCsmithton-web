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
function element() {
  return {
    markup: "", textContent: "", style: {}, children: [],
    get innerHTML() { return this.markup + this.children.map(child => child.textContent + child.innerHTML).join(""); },
    set innerHTML(value) { this.markup = value; this.children = []; },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; this.markup = ""; }
  };
}
function forecastData(updated = new Date(now).toISOString()) {
  const hourly = { time: [], precipitation: [] };
  for (let t = Date.parse("2026-10-15T00:00:00Z"); t <= Date.parse("2026-10-25T00:00:00Z"); t += 3600000) { hourly.time.push(t / 1000); hourly.precipitation.push(0); }
  const daily = { time: [], precipitation_sum: [], temperature_2m_max: [], temperature_2m_min: [] };
  for (let t = Date.parse("2026-10-15T00:00:00+11:00"); t <= Date.parse("2026-10-25T00:00:00+11:00"); t += 86400000) {
    daily.time.push(t / 1000); daily.precipitation_sum.push(1.2); daily.temperature_2m_max.push(18); daily.temperature_2m_min.push(9);
  }
  return { hourly, daily, _updated: updated };
}
async function weatherResult(base, observation, fail = false, daily = undefined, options = {}) {
  const forecast = element();
  forecast.innerHTML="<div class='loading'>Loading forecast…</div>";
  const storage = options.storage || new Map();
  let activeBase = base, activeObservation = observation, activeFail = fail;
  const sandbox = {
    Date: Clock, Intl, AbortController, setTimeout, clearTimeout,
    el: () => forecast, document: { createElement: element },
    localStorage: {
      getItem(key) { if (options.blockStorage) throw new Error("Storage disabled"); return storage.get(key) || null; },
      setItem(key, value) { if (options.blockStorage) throw new Error("Storage disabled"); storage.set(key, value); }
    },
    save() {}, render() {}, checkAlerts() {}, bayName: () => "Duck Bay", bayRainLimit: () => 40, DUCK_RAIN3_LIMIT: 25,
    console: { error() {}, warn() {} }, previous7Total: NaN, previous3Total: NaN, previous24Total: NaN,
    fetch: async (url) => {
      if (options.onFetch) options.onFetch(url, forecast);
      if (url.startsWith("./weather.json")) {
        if (options.snapshot) return { ok: true, json: async () => options.snapshot };
        throw new Error("Snapshot unavailable");
      }
      if (url.startsWith("https://api.open-meteo.com/")) {
        if (options.failForecast) throw new Error("Forecast offline");
        return { ok: true, json: async () => forecastData() };
      }
      if (url.startsWith("./smithton-rainfall.json")) {
        if (options.failHistory) throw new Error("History offline");
        return { ok: true, json: async () => activeBase };
      }
      if (activeFail) throw new Error("Network unavailable");
      return { ok: true, json: async () => ({ station: "091292", live: activeObservation, daily }) };
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(browserSource + "\n" + weatherSource, sandbox);
  await sandbox.weather();
  return { sandbox, forecast, storage, async again(nextBase, nextObservation, nextFail = false) {
    activeBase = nextBase; activeObservation = nextObservation; activeFail = nextFail;
    await sandbox.weather();
  } };
}
test("weather rendering uses the fresh post-9am observation with existing measured totals", async () => {
  const { sandbox, forecast } = await weatherResult(baseline(), live());
  assert.equal(sandbox.previous7Total, 21.2);
  assert.equal(sandbox.previous3Total, 0);
  assert.equal(sandbox.previous24Total, 0);
  assert.match(forecast.innerHTML, /Live 7-day rainfall/);
  assert.match(forecast.innerHTML, /21\.2 mm/);
});
test("failed live refresh retains the last complete rainfall display after 9am", async () => {
  const { sandbox, forecast } = await weatherResult(baseline(), null, true);
  assert.ok(Number.isNaN(sandbox.previous7Total));
  assert.match(forecast.innerHTML, /Latest available weather — waiting for update/);
  assert.match(forecast.innerHTML, /Latest available 7-day rainfall/);
  assert.match(forecast.innerHTML, /9:00:00 am/);
  assert.equal((forecast.innerHTML.match(/forecast-day /g) || []).length, 7);
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
  assert.match(forecast.innerHTML, /Current reopening readiness awaits complete readings/);
  assert.match(forecast.innerHTML, /Latest completed BOM rainfall/);
  assert.match(forecast.innerHTML, /Incomplete records/);
  assert.match(forecast.innerHTML, /1.2 mm/);
});
test("the fixed Duck Bay thresholds remain 40mm over 7 days and 25mm over 3 days", () => {
  assert.match(page, /40 mm \/ 7-day and 25 mm \/ 3-day/);
  assert.match(page, /var DUCK_RAIN3_LIMIT=25/);
});


test("a failed update preserves the last successful totals and full seven-day outlook", async () => {
  const result = await weatherResult(baseline(), live());
  const incomplete = baseline(); delete incomplete.daily["2026-10-14"];
  await result.again(incomplete, live("2026-10-16T09:40:00+11:00", "2.0"));
  assert.ok(Number.isNaN(result.sandbox.previous7Total));
  assert.match(result.forecast.innerHTML, /Latest available 7-day rainfall/);
  assert.match(result.forecast.innerHTML, /21\.2 mm/);
  assert.match(result.forecast.innerHTML, /9:30:00 am/);
  assert.equal((result.forecast.innerHTML.match(/forecast-day /g) || []).length, 7);
  assert.doesNotMatch(result.forecast.innerHTML, /Loading Smithton/);
});
test("a page reload paints saved totals and forecast before its first request", async () => {
  const saved = await weatherResult(baseline(), live());
  let firstPaint;
  const result = await weatherResult({ daily: {} }, null, true, undefined, {
    storage: saved.storage, failForecast: true, failHistory: true,
    onFetch(url, box) { if (firstPaint === undefined) firstPaint = box.innerHTML; }
  });
  assert.match(firstPaint, /21\.2 mm/);
  assert.equal((firstPaint.match(/forecast-day /g) || []).length, 7);
  assert.match(result.forecast.innerHTML, /21\.2 mm/);
  assert.ok(Number.isNaN(result.sandbox.previous7Total));
});
test("retained readings are replaced when complete fresh data arrives", async () => {
  const result = await weatherResult(baseline(), live());
  await result.again(baseline(), live("2026-10-16T09:40:00+11:00", "2.0"));
  assert.equal(result.sandbox.previous7Total, 23.2);
  assert.match(result.forecast.innerHTML, /Live 7-day rainfall/);
  assert.doesNotMatch(result.forecast.innerHTML, /waiting for update/);
  assert.match(result.forecast.innerHTML, /23\.2 mm/);
});
test("a repeated refresh leaves existing cards visible while requests are pending", async () => {
  let checkExisting = false;
  const result = await weatherResult(baseline(), live(), false, undefined, {
    onFetch(url, box) { if (checkExisting) { assert.match(box.innerHTML, /21\.2 mm/); assert.doesNotMatch(box.innerHTML, /Loading/); } }
  });
  checkExisting = true;
  await result.again(baseline(), live());
});
test("a forecast older than 24 hours remains visible through an upstream outage", async () => {
  const stale = forecastData("2026-10-14T09:45:00+11:00");
  const result = await weatherResult(baseline(), null, true, undefined, { snapshot: stale, failForecast: true });
  assert.match(result.forecast.innerHTML, /Weather forecast last updated: 14\/10\/2026/);
  assert.equal((result.forecast.innerHTML.match(/forecast-day /g) || []).length, 7);
});
test("an older hosted forecast cannot replace a newer saved forecast", async () => {
  const saved = await weatherResult(baseline(), live());
  const older = forecastData("2026-10-15T09:45:00+11:00");
  const result = await weatherResult(baseline(), live(), false, undefined, { storage: saved.storage, snapshot: older, failForecast: true });
  assert.match(result.forecast.innerHTML, /Weather forecast last updated: 16\/10\/2026/);
});
test("corrupt or unavailable browser storage does not prevent fresh weather", async () => {
  for (const options of [{ storage: new Map([["toc-smithton-weather-v1", "{broken"]]) }, { blockStorage: true }]) {
    const result = await weatherResult(baseline(), live(), false, undefined, options);
    assert.equal(result.sandbox.previous7Total, 21.2);
    assert.match(result.forecast.innerHTML, /Live 7-day rainfall/);
  }
});

test("a delayed file or endpoint cannot roll the displayed rainfall backwards", async () => {
  const result = await weatherResult(baseline(), live("2026-10-16T09:40:00+11:00", "2.0"));
  const older = baseline(); older.live = live();
  await result.again(older, null, true);
  assert.equal(result.sandbox.previous7Total, 23.2);
  assert.match(result.forecast.innerHTML, /9:40:00 am/);
  assert.equal(JSON.parse(result.storage.get("toc-smithton-weather-v1")).rainfall.live.rain_since_9am, 2);
});

test("completed rainfall and forecast survive reloads even before the first complete live update", async () => {
  const incomplete = baseline(); delete incomplete.daily["2026-10-16"]; incomplete.latest_date = "2026-10-15"; incomplete.live = null;
  const first = await weatherResult(incomplete, live());
  let firstPaint;
  const next = await weatherResult(null, null, true, undefined, {
    storage: first.storage, failHistory: true, failForecast: true,
    onFetch(url, box) { if (firstPaint === undefined) firstPaint = box.innerHTML; }
  });
  assert.match(firstPaint, /Latest completed BOM rainfall — to 9am 2026-10-15/);
  assert.match(firstPaint, /Latest 7-day rainfall/);
  assert.match(firstPaint, /1.2 mm/);
  assert.match(next.forecast.innerHTML, /Latest completed BOM rainfall/);
  assert.ok(Number.isNaN(next.sandbox.previous7Total));
});
