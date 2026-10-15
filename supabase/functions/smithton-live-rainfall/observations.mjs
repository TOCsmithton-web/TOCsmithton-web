// Use measured BOM observations and explicit daily CSV records; never infer a full day from a partial reading.
export const BOM_URL = "https://www.bom.gov.au/fwo/IDT60801/IDT60801.94953.json";
const zone = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Australia/Hobart", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
});
function parts(ms) {
  return Object.fromEntries(zone.formatToParts(new Date(ms)).filter(p => p.type !== "literal").map(p => [p.type, p.value]));
}
function shiftDay(key, days) {
  const d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function nineAm(key) {
  // At local 9am the day's daylight-saving transition is already complete.
  const probe = Date.parse(key + "T01:00:00Z");
  const p = parts(probe);
  const minutes = (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - probe) / 60000;
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return key + "T09:00:00" + sign + String(Math.floor(absolute / 60)).padStart(2, "0") + ":" + String(absolute % 60).padStart(2, "0");
}
function observationTime(value) {
  const s = String(value ?? "");
  if (!/^\d{14}$/.test(s)) return NaN;
  const ms = Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
  return new Date(ms).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14) === s ? ms : NaN;
}
function rainfall(value) {
  if (typeof value === "string") {
    if (!/^\d+(?:\.\d+)?$/.test(value.trim())) return NaN;
    value = Number(value);
  }
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : NaN;
}
export function parseDailyCsv(text, through) {
  // BOM CSV can contain quoted station names and commas before the data header.
  const rows = []; let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { row.push(field); field = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const header = rows.findIndex(values => values.includes("Date") && values.includes("Rainfall (mm)"));
  if (header < 0) throw new Error("BOM daily rainfall header unavailable");
  const dateCol = rows[header].indexOf("Date"), rainCol = rows[header].indexOf("Rainfall (mm)");
  const daily = {};
  for (const values of rows.slice(header + 1)) {
    const date = values[dateCol], rain = rainfall(values[rainCol]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date || "") && date <= through && Number.isFinite(rain)) daily[date] = rain;
  }
  return daily;
}
export async function completedDaily(anchor, knownThrough, fetcher = fetch) {
  if (knownThrough === anchor) return { daily: {}, daily_errors: [] };
  const months = [...new Set([anchor.slice(0, 7), shiftDay(anchor, -5).slice(0, 7)])];
  const results = await Promise.allSettled(months.map(async month => {
    const compact = month.replace("-", "");
    const url = "https://www.bom.gov.au/climate/dwo/" + compact + "/text/IDCJDW7047." + compact + ".csv";
    const response = await fetcher(url, { headers: { "User-Agent": "TOC-Smithton-Rainfall/1.0" }, cache: "no-store", signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("BOM daily rainfall returned " + response.status);
    const daily = parseDailyCsv(await response.text(), anchor);
    if (!Object.keys(daily).length) throw new Error("BOM daily rainfall has no numeric records");
    return daily;
  }));
  const daily = {}, daily_errors = [];
  for (const result of results) {
    if (result.status === "fulfilled") Object.assign(daily, result.value);
    else daily_errors.push(result.reason?.message || "BOM daily rainfall unavailable");
  }
  return { daily, daily_errors };
}
export function liveObservation(payload, now = Date.now()) {
  const raw = payload?.observations?.data;
  if (!Array.isArray(raw)) throw new Error("BOM observations are unavailable");
  const rows = raw.map(row => ({
    station: Number(row.wmo), at: observationTime(row.aifstime_utc), rain: rainfall(row.rain_trace)
  })).filter(row => row.station === 94953 && Number.isFinite(row.at) && Number.isFinite(row.rain)).sort((a, b) => b.at - a.at);
  if (!rows.length) throw new Error("BOM has no numeric Smithton rain observations");
  const latest = rows[0];
  const age = now - latest.at;
  if (age < 0 || age > 90 * 60000) throw new Error("Latest BOM Smithton rain observation is stale or future dated");
  const p = parts(latest.at);
  const date = p.year + "-" + p.month + "-" + p.day;
  // Exactly 9am remains the old period until a strictly post-9am reading arrives.
  const endDay = latest.at > Date.parse(nineAm(date)) ? shiftDay(date, 1) : date;
  return {
    rain_since_9am: latest.rain,
    observed_at: new Date(latest.at).toISOString(),
    period_start: nineAm(shiftDay(endDay, -1)),
    period_end: nineAm(endDay),
    forecast_period_ends: Array.from({ length: 7 }, (_, i) => nineAm(shiftDay(endDay, i))),
    source_url: BOM_URL
  };
}
