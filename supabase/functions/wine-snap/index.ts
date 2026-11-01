// Cellar · wine-snap
// A tiny, private middleman between the Cellar website and Google's Gemini API.
// It keeps the Gemini key secret (stored as a Supabase secret, never in the website),
// sends Gemini the label photo(s), and returns the details as tidy JSON.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   GEMINI_API_KEY   required. Free key from https://aistudio.google.com/apikey
//   GEMINI_MODEL     optional. Default "gemini-3.8-flash"; falls back to FALLBACK_MODEL when busy.
//   FALLBACK_MODEL   optional. Default "gemini-3.5-flash-lite".
//   ALLOWED_ORIGINS  optional. Comma list. Default "https://anotterbryan.github.io".
//   WEB_SEARCH       optional. "on" turns on Google Search grounding (requires billing on the Google account).

const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
const FALLBACK = Deno.env.get("FALLBACK_MODEL") ?? "gemini-3.5-flash-lite";
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://anotterbryan.github.io").split(",").map((s) => s.trim()).filter(Boolean);
const BASE = Deno.env.get("GEMINI_BASE") ?? "https://generativelanguage.googleapis.com";
const SEARCH = (Deno.env.get("WEB_SEARCH") ?? "off").toLowerCase() === "on";

// gentle per-visitor limit so a stranger can't burn the free quota
const hits = new Map<string, number[]>();
function allowed(ip: string): boolean {
  const now = Date.now(), win = 60 * 60 * 1000, max = 40;
  const list = (hits.get(ip) ?? []).filter((t) => now - t < win);
  if (list.length >= max) return false;
  list.push(now); hits.set(ip, list); return true;
}

function cors(origin: string | null): Record<string, string> {
  const ok = origin && (ORIGINS.includes("*") || ORIGINS.includes(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const PROMPT = `You are a careful sommelier's assistant reading a wine bottle label.
Look at the photo(s) (front label, and back label if given) plus any text the user typed.

Rules:
- "label" fields: ONLY what is actually printed on the bottle. If you cannot read it clearly, use null. Never guess a vintage year.
- grape: the grape variety or wine type as printed (e.g. "Viognier", "Muscadine", "Red Blend"). If several are listed, give the main one in grape and all in grapes.
- region: the most specific place printed (e.g. "Napa Valley", "Paso Robles"); state: US state if printed or clearly implied by the region; country if printed or clearly implied.
- color: one of "Red","White","Rosé","Sparkling","Fortified", or null. sweetness: one of "Dry","Off-dry / semi-sweet","Sweet", or null — only if printed or unmistakable from the wine type.
- abv: number from the label (e.g. 13.5) or null.
- winery_info: what you KNOW about this producer from general knowledge (2-3 plain sentences, location, notable facts). If you don't know this producer, set known=false and leave summary empty. Do not invent facts.
- is_wine: false if the photo is not a wine bottle/label.
Return only JSON matching the schema.`;

const SCHEMA = {
  type: "OBJECT",
  properties: {
    is_wine: { type: "BOOLEAN" },
    label: {
      type: "OBJECT",
      properties: {
        producer: { type: "STRING", nullable: true },
        wine_name: { type: "STRING", nullable: true },
        grape: { type: "STRING", nullable: true },
        grapes: { type: "ARRAY", items: { type: "STRING" } },
        region: { type: "STRING", nullable: true },
        state: { type: "STRING", nullable: true },
        country: { type: "STRING", nullable: true },
        vintage: { type: "INTEGER", nullable: true },
        color: { type: "STRING", nullable: true },
        sweetness: { type: "STRING", nullable: true },
        abv: { type: "NUMBER", nullable: true },
        text: { type: "STRING", nullable: true },
      },
    },
    winery_info: {
      type: "OBJECT",
      properties: {
        known: { type: "BOOLEAN" },
        summary: { type: "STRING", nullable: true },
        location: { type: "STRING", nullable: true },
      },
    },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
  },
  required: ["is_wine", "label", "confidence"],
};

async function callGemini(model: string, parts: unknown[]) {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: SEARCH ? { temperature: 0.1 } : { temperature: 0.1, responseMimeType: "application/json", responseSchema: SCHEMA },
  };
  if (SEARCH) body.tools = [{ google_search: {} }];
  const r = await fetch(`${BASE}/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": KEY },
    body: JSON.stringify(body),
  });
  return r;
}

function parseJSON(t: string) {
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch { /* ignore */ } }
  return null;
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  const H = { ...cors(origin), "content-type": "application/json" };
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "POST only" }), { status: 405, headers: H });
  if (!KEY) return new Response(JSON.stringify({ error: "Server is missing GEMINI_API_KEY" }), { status: 500, headers: H });
  if (origin && !ORIGINS.includes("*") && !ORIGINS.includes(origin)) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers: H });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "anon";
  if (!allowed(ip)) return new Response(JSON.stringify({ error: "Too many scans this hour. Try again later." }), { status: 429, headers: H });

  let input: { images?: string[]; text?: string };
  try { input = await req.json(); } catch { return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers: H }); }
  const images = (input.images ?? []).slice(0, 2).filter((s) => typeof s === "string" && s.length < 2_500_000);
  const text = (input.text ?? "").slice(0, 2000);
  if (!images.length && !text) return new Response(JSON.stringify({ error: "Send a photo or text" }), { status: 400, headers: H });

  const parts: unknown[] = [{ text: PROMPT + (SEARCH ? "\nYou may search the web to identify the producer and fill winery_info; respond with ONLY the JSON object (no prose)." : "") }];
  images.forEach((d, i) => {
    const m = d.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (m) parts.push({ text: i === 0 ? "Front label:" : "Back label:" }, { inline_data: { mime_type: m[1], data: m[2] } });
  });
  if (text) parts.push({ text: "Text the user typed or scanned from the label:\n" + text });

  let r = await callGemini(MODEL, parts), used = MODEL;
  if (r.status === 429 || r.status === 503 || r.status === 404) { r = await callGemini(FALLBACK, parts); used = FALLBACK; }
  if (!r.ok) {
    const detail = (await r.text()).slice(0, 300);
    const msg = r.status === 429 ? "The free AI quota is used up for now. The on-device reader will be used instead." : "The AI couldn't read this one.";
    return new Response(JSON.stringify({ error: msg, status: r.status, detail }), { status: 502, headers: H });
  }
  const j = await r.json();
  const cand = j.candidates?.[0];
  const out = parseJSON((cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join(""));
  if (!out) return new Response(JSON.stringify({ error: "The AI reply couldn't be understood." }), { status: 502, headers: H });
  const sources = (cand?.groundingMetadata?.groundingChunks ?? []).map((c: { web?: { uri?: string; title?: string } }) => c.web).filter(Boolean).slice(0, 5);
  return new Response(JSON.stringify({ ...out, model: used, web_search: SEARCH, sources }), { headers: H });
});
