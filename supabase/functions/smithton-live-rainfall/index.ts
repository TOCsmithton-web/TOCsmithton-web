import { BOM_URL, liveObservation, completedDaily } from "./observations.mjs";

const headers = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "https://tocsmithton-web.github.io",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "no-store",
  "Vary": "Origin"
};
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "GET") return new Response(JSON.stringify({ error: "Use GET" }), { status: 405, headers: { ...headers, Allow: "GET, OPTIONS" } });
  try {
    const response = await fetch(BOM_URL, {
      headers: { "User-Agent": "TOC-Smithton-Rainfall/1.0", Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12000)
    });
    if (!response.ok) throw new Error("BOM observation service returned " + response.status);
    const live = liveObservation(await response.json());
    const completed = await completedDaily(live.period_start.slice(0, 10), new URL(req.url).searchParams.get("completed_through"));
    return new Response(JSON.stringify({
      station: "091292", source: "BOM Smithton Aerodrome",
      updated: new Date().toISOString(), live, ...completed
    }), { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "BOM observations unavailable";
    console.error("Smithton live rainfall:", message);
    return new Response(JSON.stringify({ error: message }), { status: 503, headers });
  }
});
