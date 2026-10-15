/* Refresh live observations independently of GitHub Pages builds. No daily totals are created here. */
(function (root) {
  "use strict";
  var endpoint = "https://gyzxsugnlobxlvqjevhh.supabase.co/functions/v1/smithton-live-rainfall";
  // Public legacy anon JWT: compatibility with the Edge gateway's JWT verification.
  // This is a browser-safe public key, never a service-role or secret key.
  var publicObservationToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd5enhzdWdubG9ieGx2cWpldmhoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4NDk3MzksImV4cCI6MjEwNjQyNTczOX0.2wOxRlxuPBuIFmP3E6CXnlsJkKQd33l0w-4xh91LNSQ";
  function validLive(live, now) {
    if (!live || typeof live.rain_since_9am !== "number" || !Number.isFinite(live.rain_since_9am) || live.rain_since_9am < 0) return false;
    var at = Date.parse(live.observed_at), start = Date.parse(live.period_start), end = Date.parse(live.period_end);
    if (!Number.isFinite(at) || !Number.isFinite(start) || !Number.isFinite(end) || at > now || now - at > 90 * 60000 || now > end || at <= start || at > end) return false;
    if (!/^\d{4}-\d{2}-\d{2}T09:00:00[+-]\d{2}:\d{2}$/.test(live.period_start) || !/^\d{4}-\d{2}-\d{2}T09:00:00[+-]\d{2}:\d{2}$/.test(live.period_end)) return false;
    if (end - start < 23 * 3600000 || end - start > 25 * 3600000) return false;
    if (!Array.isArray(live.forecast_period_ends) || live.forecast_period_ends.length !== 7 || live.forecast_period_ends[0] !== live.period_end) return false;
    return live.forecast_period_ends.every(function (value, i, all) {
      var stamp = Date.parse(value);
      return Number.isFinite(stamp) && (i === 0 || (stamp - Date.parse(all[i - 1]) >= 23 * 3600000 && stamp - Date.parse(all[i - 1]) <= 25 * 3600000));
    });
  }
  async function refreshLive(baseline) {
    var known = baseline.latest_date;
    var complete = /^\d{4}-\d{2}-\d{2}$/.test(known || "") && Array.from({ length: 6 }, function (_, i) {
      var day = new Date(known + "T12:00:00Z"); day.setUTCDate(day.getUTCDate() - i);
      var value = baseline.daily && baseline.daily[day.toISOString().slice(0, 10)];
      return typeof value === "number" && Number.isFinite(value) && value >= 0;
    }).every(Boolean);
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, 23000);
    try {
      var response = await fetch(endpoint + (complete ? "?completed_through=" + known : ""), {
        cache: "no-store", signal: controller.signal,
        headers: { Authorization: "Bearer " + publicObservationToken, apikey: publicObservationToken }
      });
      if (!response.ok) throw new Error("BOM live refresh unavailable (" + response.status + ")");
      var payload = await response.json();
      var now = Date.now();
      if (payload.station !== "091292" || !validLive(payload.live, now)) throw new Error("Waiting for a current post-9am BOM observation");
      var previousAt = baseline.live && Date.parse(baseline.live.observed_at);
      if (Number.isFinite(previousAt) && previousAt > Date.parse(payload.live.observed_at)) return baseline;
      // Merge only explicitly measured BOM daily records. Missing fields stay missing.
      var daily = baseline.daily, latest = baseline.latest_date;
      Object.keys(payload.daily || {}).forEach(function (day) {
        var value = payload.daily[day];
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > payload.live.period_start.slice(0, 10) || typeof value !== "number" || !Number.isFinite(value) || value < 0) return;
        if (daily === baseline.daily) daily = Object.assign({}, baseline.daily || {});
        daily[day] = value;
        if (!latest || day > latest) latest = day;
      });
      return Object.assign({}, baseline, { daily: daily, latest_date: latest, live: payload.live, live_error: null, live_refresh_error: null });
    } catch (error) {
      return Object.assign({}, baseline, { live_refresh_error: error.message || "BOM live refresh unavailable" });
    } finally {
      clearTimeout(timer);
    }
  }
  root.TOCSmithtonRainfall = { refreshLive: refreshLive };
})(typeof window === "undefined" ? globalThis : window);
