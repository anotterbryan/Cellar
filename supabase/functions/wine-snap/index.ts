// Cellar · wine-snap  (version 5: label reading, bottle notes, guided dinner pairing, shared household cellar, community bottle facts)
import postgres from "npm:postgres@3.4.5";
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

// ---------------- shared household cellar (stored in this project's own database)
const DB_URL = Deno.env.get("SUPABASE_DB_URL") ?? "";
let sql: ReturnType<typeof postgres> | null = null;
let ready = false;
async function db() {
  if (!DB_URL) throw new Error("Database not available");
  if (!sql) sql = postgres(DB_URL, { max: 2, prepare: false, idle_timeout: 20 });
  if (!ready) {
    await sql`create table if not exists cellar_households (code text primary key, data jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now())`;
    await sql`alter table cellar_households enable row level security`;   // no public access; only this function can read/write
    await sql`create table if not exists cellar_community (key text not null, device text not null, fields jsonb not null, updated_at timestamptz not null default now(), primary key (key, device))`;
    await sql`alter table cellar_community enable row level security`;
    ready = true;
  }
  return sql;
}
const ALPHA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode() { const b = crypto.getRandomValues(new Uint8Array(8)); const c = [...b].map((x) => ALPHA[x % ALPHA.length]).join(""); return `${c.slice(0, 4)}-${c.slice(4)}`; }
type Rec = { id: number | string; mt?: number; [k: string]: unknown };
function mergeData(a: { bottles?: Rec[]; tombs?: Record<string, number> }, b: { bottles?: Rec[]; tombs?: Record<string, number> }) {
  const tombs: Record<string, number> = { ...(a.tombs ?? {}) };
  for (const [k, v] of Object.entries(b.tombs ?? {})) tombs[k] = Math.max(tombs[k] ?? 0, Number(v) || 0);
  const byId = new Map<string, Rec>();
  for (const r of [...(a.bottles ?? []), ...(b.bottles ?? [])]) {
    const k = String(r.id), cur = byId.get(k);
    if (!cur || (Number(r.mt) || 0) >= (Number(cur.mt) || 0)) byId.set(k, r);
  }
  const bottles = [...byId.values()].filter((r) => !(tombs[String(r.id)] && tombs[String(r.id)] >= (Number(r.mt) || 0)))
    .sort((x, y) => String(y.ts ?? "").localeCompare(String(x.ts ?? ""))).slice(0, 600);
  return { bottles, tombs };
}
async function household(task: string, input: { code?: string; bottles?: Rec[]; tombs?: Record<string, number>; name?: string }) {
  const s = await db();
  if (task === "household_create") {
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const r = await s`insert into cellar_households (code, data) values (${code}, ${s.json({ name: String(input.name ?? "").slice(0, 60), bottles: [], tombs: {} })}) on conflict do nothing returning code`;
      if (r.length) return { code };
    }
    throw new Error("Couldn't create a code, try again");
  }
  const code = String(input.code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(.{4})(.{4})$/, "$1-$2");
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) return { error: "That code doesn't look right (it's 8 letters/numbers, like ABCD-2345).", status: 400 };
  return await s.begin(async (t) => {
    const rows = await t`select data from cellar_households where code = ${code} for update`;
    if (!rows.length) return { error: "No shared cellar uses that code. Check it and try again.", status: 404 };
    const cur = rows[0].data as { name?: string; bottles?: Rec[]; tombs?: Record<string, number> };
    if (task === "household_check") return { ok: true, name: cur.name ?? "", count: (cur.bottles ?? []).length };
    const merged = mergeData(cur, { bottles: (input.bottles ?? []).slice(0, 600), tombs: input.tombs ?? {} });
    await t`update cellar_households set data = ${t.json({ ...cur, ...merged } as never)}, updated_at = now() where code = ${code}`;
    return { ok: true, name: cur.name ?? "", ...merged, server_time: Date.now() };
  });
}

// ---------------- community bottle facts (anonymous; only facts about the bottle, never personal data)
const CFIELDS = ["producer", "grape", "place", "color", "sweet", "wine_id"];
const cleanKey = (k: unknown) => String(k ?? "").toLowerCase().replace(/[^a-z0-9:|-]/g, "").slice(0, 120);
function cleanFields(f: Record<string, unknown> = {}) {
  const out: Record<string, string> = {};
  for (const k of CFIELDS) { const v = f[k]; if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 80); }
  return out;
}
async function community(task: string, input: { keys?: unknown[]; device?: unknown; fields?: Record<string, unknown> }) {
  const s = await db();
  const keys = [...new Set((input.keys ?? []).map(cleanKey).filter((k) => /^(bc|nm):.{3,}/.test(k)))].slice(0, 4);
  if (!keys.length) return { error: "No bottle key", status: 400 };
  if (task === "community_add") {
    const device = String(input.device ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
    const fields = cleanFields(input.fields);
    if (device.length < 8 || Object.keys(fields).length < 2) return { error: "Not enough to share", status: 400 };
    for (const k of keys) await s`insert into cellar_community (key, device, fields) values (${k}, ${device}, ${s.json(fields)}) on conflict (key, device) do update set fields = excluded.fields, updated_at = now()`;
    return { ok: true };
  }
  // community_get: majority value per field, with how many different phones agree
  const all = await s`select device, fields from cellar_community where key in ${s(keys)} order by updated_at desc limit 400`;
  const seen = new Set<string>(), rows = all.filter((r) => !seen.has(r.device) && seen.add(r.device));   // one vote per phone
  if (!rows.length) return { found: false };
  const tally: Record<string, Record<string, { v: string; n: number }>> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.fields as Record<string, string>)) {
    const norm = String(v).toLowerCase(); tally[k] ??= {}; tally[k][norm] ??= { v: String(v), n: 0 }; tally[k][norm].n++;
  }
  const fields: Record<string, string> = {}, agree: Record<string, number> = {};
  for (const [k, opts] of Object.entries(tally)) { const best = Object.values(opts).sort((a, b) => b.n - a.n)[0]; fields[k] = best.v; agree[k] = best.n; }
  return { found: true, fields, agree, people: rows.length, trusted: Math.min(agree.producer ?? 0, agree.grape ?? agree.wine_id ?? 0) >= 2 };
}

const NOTES_PROMPT = `You are a warm, precise sommelier writing a short "at a glance" panel about ONE specific wine for a wine-lover's app.
You get the producer, wine name, grape, place and vintage (some may be missing) plus the general style it belongs to.
- If you genuinely know this producer/wine, describe THIS wine (known=true). If not, set known=false and describe what a bottle like this typically offers, saying so plainly.
- Never invent awards, scores, prices, owners or history. If unsure about a fact, leave it out.
- headline: one sentence, like a search snippet. taste: 3-6 short tasting notes. food: 3-5 specific dishes. serve: one short tip (temperature/decanting/glass).
- producer: 1-2 sentences about the producer only if known, else empty.
Return only JSON.`;
const NOTES_SCHEMA = {
  type: "OBJECT",
  properties: {
    known: { type: "BOOLEAN" },
    headline: { type: "STRING" },
    taste: { type: "ARRAY", items: { type: "STRING" } },
    food: { type: "ARRAY", items: { type: "STRING" } },
    serve: { type: "STRING", nullable: true },
    producer: { type: "STRING", nullable: true },
    confidence: { type: "STRING", enum: ["high", "medium", "low"] },
  },
  required: ["known", "headline", "taste", "food", "confidence"],
};
const GUIDED_PROMPT = `You are a friendly expert sommelier. The user described their meal and picked details (sauce, toppings, cheeses...).
You get CANDIDATES: wine styles already vetted by a fact-checked pairing guide for those details, each with the guide's reason.
- Choose the 3 best for this exact meal from the CANDIDATES (use exact ids), best first, and write one or two warm, plain sentences each explaining why it works with THIS meal (acidity, tannin, weight, sweetness vs spice, fat, salt). Stay consistent with the guide's reasons; do not contradict them.
- If the CELLAR list is not empty, pick up to 2 of the user's bottles (exact ids) that suit the meal, with a short why; else return an empty list.
- Add one "avoid" sentence and one practical serving tip. Only use ids from the lists. Return only JSON.`;
const PAIR_PROMPT = `You are a friendly expert sommelier. The user tells you what they're having for dinner.
Pick the 3 best wine STYLES from the numbered CATALOG (use their exact ids), best first, and explain each in one or two plain, warm sentences (why it works with this dish: acidity, tannin, weight, sweetness vs spice, etc.).
If the user's CELLAR list is not empty, also pick up to 2 bottles from it that would work (exact ids), with a short why; if none fit, return an empty list.
Add one "avoid" sentence (what would clash) and one practical tip. Keep it encouraging and simple. Only use ids that appear in the lists. Return only JSON.`;
const PAIR_SCHEMA = {
  type: "OBJECT",
  properties: {
    dish: { type: "STRING" },
    picks: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, why: { type: "STRING" } }, required: ["id", "why"] } },
    cellar_picks: { type: "ARRAY", items: { type: "OBJECT", properties: { id: { type: "STRING" }, why: { type: "STRING" } }, required: ["id", "why"] } },
    avoid: { type: "STRING", nullable: true },
    tip: { type: "STRING", nullable: true },
  },
  required: ["dish", "picks"],
};

async function callGemini(model: string, parts: unknown[], schema: unknown = SCHEMA, search = SEARCH) {
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: search ? { temperature: 0.2 } : { temperature: 0.2, responseMimeType: "application/json", responseSchema: schema },
  };
  if (search) body.tools = [{ google_search: {} }];
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
  const peek = req.headers.get("x-cellar-task") ?? "";
  if (!peek.startsWith("household_") && !peek.startsWith("community_get") && !allowed(ip)) return new Response(JSON.stringify({ error: "Too many scans this hour. Try again later." }), { status: 429, headers: H });

  let input: { candidates?: { id: string; name: string; why?: string }[]; details?: string; task?: string; keys?: unknown[]; device?: string; fields?: Record<string, unknown>; code?: string; name?: string; bottles?: Rec[]; tombs?: Record<string, number>; images?: string[]; text?: string; wine?: Record<string, unknown>; dish?: string; catalog?: { id: string; name: string }[]; cellar?: { id: string; name: string }[] };
  try { input = await req.json(); } catch { return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers: H }); }
  const task = input.task ?? "read";
  if (task.startsWith("community_")) {
    try { const out = await community(task, input as never); const st = (out as { status?: number }).status;
      return new Response(JSON.stringify(out), { status: st ?? 200, headers: H }); }
    catch (e) { return new Response(JSON.stringify({ error: "The community database isn't available right now.", detail: String(e).slice(0, 200) }), { status: 500, headers: H }); }
  }
  if (task.startsWith("household_")) {
    try { const out = await household(task, input as never); const st = (out as { status?: number }).status;
      return new Response(JSON.stringify(out), { status: st ?? 200, headers: H }); }
    catch (e) { return new Response(JSON.stringify({ error: "The shared cellar isn't available right now.", detail: String(e).slice(0, 200) }), { status: 500, headers: H }); }
  }
  if (task === "notes" || task === "pair") {
    let parts: unknown[], schema: unknown;
    if (task === "notes") {
      const w = JSON.stringify(input.wine ?? {}).slice(0, 1500);
      parts = [{ text: NOTES_PROMPT + (SEARCH ? "\nYou may search the web; respond with ONLY the JSON object." : "") }, { text: "Wine: " + w }]; schema = NOTES_SCHEMA;
    } else {
      const dish = String(input.dish ?? "").slice(0, 300);
      if (!dish) return new Response(JSON.stringify({ error: "Tell me what's for dinner" }), { status: 400, headers: H });
      const cands = (input.candidates ?? []).slice(0, 16);
      if (cands.length) {
        const cel = (input.cellar ?? []).slice(0, 80).map((c) => `${c.id}: ${c.name}`).join("\n").slice(0, 6000);
        const cl = cands.map((c) => `${c.id}: ${c.name}${c.why ? " | guide: " + String(c.why).slice(0, 220) : ""}`).join("\n");
        parts = [{ text: GUIDED_PROMPT }, { text: "Meal: " + dish + (input.details ? "\nDetails: " + String(input.details).slice(0, 400) : "") }, { text: "CANDIDATES:\n" + cl }, { text: "CELLAR:\n" + (cel || "(empty)") }];
        schema = PAIR_SCHEMA;
      } else {
      const cat = (input.catalog ?? []).slice(0, 260).map((c) => `${c.id}: ${c.name}`).join("\n").slice(0, 20000);
      const cel = (input.cellar ?? []).slice(0, 80).map((c) => `${c.id}: ${c.name}`).join("\n").slice(0, 6000);
      parts = [{ text: PAIR_PROMPT }, { text: "Dinner: " + dish }, { text: "CATALOG:\n" + cat }, { text: "CELLAR:\n" + (cel || "(empty)") }]; schema = PAIR_SCHEMA;
      }
    }
    const useSearch = SEARCH && task === "notes";
    let r = await callGemini(MODEL, parts, schema, useSearch), used = MODEL;
    if (r.status === 429 || r.status === 503 || r.status === 404) { r = await callGemini(FALLBACK, parts, schema, useSearch); used = FALLBACK; }
    if (!r.ok) return new Response(JSON.stringify({ error: r.status === 429 ? "The free AI quota is used up for now." : "The AI couldn't answer this one.", status: r.status }), { status: 502, headers: H });
    const j = await r.json(); const cand = j.candidates?.[0];
    const out = parseJSON((cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join(""));
    if (!out) return new Response(JSON.stringify({ error: "The AI reply couldn't be understood." }), { status: 502, headers: H });
    const sources = (cand?.groundingMetadata?.groundingChunks ?? []).map((c: { web?: { uri?: string; title?: string } }) => c.web).filter(Boolean).slice(0, 5);
    return new Response(JSON.stringify({ ...out, model: used, web_search: useSearch, sources }), { headers: H });
  }

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
