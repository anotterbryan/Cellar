// Cellar · swift-action  (version 10: remembered answers for settings-file tasks, e.g. quors spirit notes)
// Label reading, bottle notes, guided dinner pairing, shared household cellar, community bottle facts,
// plus (new in 6) a settings file on the Cellar website, general-purpose storage, and a status check,
// so most future features need no server change. Deployed automatically from GitHub.
const SERVER_VERSION = 10;
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
//   GROQ_API_KEY     optional. Free key from https://console.groq.com/keys. Used only when both Gemini models fail.
//   CONFIG_URL       optional. Settings file. Default https://anotterbryan.github.io/Cellar/server/config.json
//                    (prompts, extra AI tasks, storage areas, limits). Only read from this address, so
//                    nobody can send the server their own instructions.

const KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash";
const FALLBACK = Deno.env.get("FALLBACK_MODEL") ?? "gemini-3.5-flash-lite";
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "https://anotterbryan.github.io").split(",").map((s) => s.trim()).filter(Boolean);
const BASE = Deno.env.get("GEMINI_BASE") ?? "https://generativelanguage.googleapis.com";
const SEARCH = (Deno.env.get("WEB_SEARCH") ?? "off").toLowerCase() === "on";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";
const GROQ_BASE = Deno.env.get("GROQ_BASE") ?? "https://api.groq.com";
const CONFIG_URL = Deno.env.get("CONFIG_URL") ?? "https://anotterbryan.github.io/Cellar/server/config.json";

// ---------------- settings file (cached 5 minutes; built-in defaults if it can't be reached)
type TaskDef = { prompt: string; schema?: unknown; inputs?: Record<string, number>; images?: number; search?: boolean; cache_days?: number };
type StoreDef = { max_bytes?: number; per_key?: number; listable?: boolean };
type Config = { version?: number | string; groq?: { model?: string; vision_model?: string; enabled?: boolean }; cache?: { notes_days?: number; pair_days?: number }; models?: { primary?: string | null; fallback?: string | null }; limits?: { ai_per_hour?: number; store_puts_per_hour?: number };
  prompts?: Record<string, string>; schemas?: Record<string, unknown>; tasks?: Record<string, TaskDef>; stores?: Record<string, StoreDef> };
let CFG: Config = {}, cfgAt = 0, cfgErr = "";
async function config(): Promise<Config> {
  if (Date.now() - cfgAt < 5 * 60 * 1000) return CFG;
  cfgAt = Date.now();
  try {
    const r = await fetch(CONFIG_URL + "?t=" + Math.floor(Date.now() / 300000), { signal: AbortSignal.timeout(4000) });
    if (r.ok) { const j = await r.json(); if (j && typeof j === "object") { CFG = j; cfgErr = ""; } }
    else cfgErr = "settings file returned " + r.status;
  } catch (e) { cfgErr = "settings file unreachable: " + String(e).slice(0, 80); }
  return CFG;
}
const prompt = (name: string, dflt: string) => (typeof CFG.prompts?.[name] === "string" && CFG.prompts[name].length > 20) ? CFG.prompts[name] : dflt;
const schemaOf = (name: string, dflt: unknown) => (CFG.schemas?.[name] && typeof CFG.schemas[name] === "object") ? CFG.schemas[name] : dflt;
const modelPrimary = () => CFG.models?.primary || MODEL;
const modelFallback = () => CFG.models?.fallback || FALLBACK;

// gentle per-visitor limit so a stranger can't burn the free quota
const hits = new Map<string, number[]>();
function allowed(ip: string, bucket = "ai", max = CFG.limits?.ai_per_hour ?? 40): boolean {
  const now = Date.now(), win = 60 * 60 * 1000, k = bucket + "|" + ip;
  const list = (hits.get(k) ?? []).filter((t) => now - t < win);
  if (list.length >= max) return false;
  list.push(now); hits.set(k, list); return true;
}

function cors(origin: string | null): Record<string, string> {
  const ok = origin && (ORIGINS.includes("*") || ORIGINS.includes(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cellar-task",
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
    await sql`create table if not exists cellar_store (ns text not null, key text not null, device text not null, data jsonb not null, updated_at timestamptz not null default now(), primary key (ns, key, device))`;
    await sql`alter table cellar_store enable row level security`;
    await sql`create table if not exists cellar_ai_cache (key text primary key, task text not null, data jsonb not null, hits integer not null default 0, created_at timestamptz not null default now())`;
    await sql`alter table cellar_ai_cache enable row level security`;
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

// ---------------- general-purpose storage: areas are switched on in the settings file ("stores")
// Each phone keeps its own entry per key (e.g. one rating per phone per wine); everyone can read all entries.
const cleanNs = (n: unknown) => String(n ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
const cleanDevice = (d: unknown) => String(d ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
async function store(task: string, input: { ns?: unknown; key?: unknown; keys?: unknown[]; device?: unknown; data?: unknown }, ip: string) {
  const ns = cleanNs(input.ns), def = CFG.stores?.[ns];
  if (!def) return { error: "That storage area isn't switched on.", status: 404 };
  const s = await db();
  if (task === "store_put" || task === "store_delete") {
    const key = cleanKey(input.key), device = cleanDevice(input.device);
    if (key.length < 2 || device.length < 8) return { error: "Missing key or device", status: 400 };
    if (task === "store_delete") { await s`delete from cellar_store where ns = ${ns} and key = ${key} and device = ${device}`; return { ok: true }; }
    if (!allowed(ip, "store", CFG.limits?.store_puts_per_hour ?? 300)) return { error: "Too many saves this hour.", status: 429 };
    const body = JSON.stringify(input.data ?? null);
    if (input.data == null || body.length > (def.max_bytes ?? 4000)) return { error: "Too much to save", status: 413 };
    await s`insert into cellar_store (ns, key, device, data) values (${ns}, ${key}, ${device}, ${s.json(input.data as never)}) on conflict (ns, key, device) do update set data = excluded.data, updated_at = now()`;
    return { ok: true };
  }
  if (task === "store_recent") {   // newest entries across all keys, only for areas marked "listable" (e.g. suggestions to review)
    if (!def.listable) return { error: "That storage area can't be listed.", status: 403 };
    const lim = Math.min(Number((input as { limit?: unknown }).limit) || 100, 300);
    const rows = await s`select key, data, updated_at from cellar_store where ns = ${ns} order by updated_at desc limit ${lim}`;
    return { ok: true, entries: rows.map((r) => ({ key: r.key, data: r.data, updated: new Date(r.updated_at).toISOString() })) };
  }
  // store_get: up to per_key newest entries for each key (device ids are never returned)
  const keys = [...new Set((input.keys ?? [input.key]).map(cleanKey).filter((k) => k.length >= 2))].slice(0, 20);
  if (!keys.length) return { error: "Missing key", status: 400 };
  const me = cleanDevice(input.device), lim = Math.min(def.per_key ?? 100, 500);
  const rows = await s`select key, device, data, updated_at from (select *, row_number() over (partition by key order by updated_at desc) as rn from cellar_store where ns = ${ns} and key in ${s(keys)}) x where rn <= ${lim}`;
  const out: Record<string, { data: unknown; mine: boolean; updated: string }[]> = {};
  for (const r of rows) (out[r.key] ??= []).push({ data: r.data, mine: !!me && r.device === me, updated: new Date(r.updated_at).toISOString() });
  return { ok: true, entries: out };
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

// ---------------- remembered AI answers: the same bottle (or the same dinner) never costs quota twice.
// Only this server writes the cache, from Gemini's own replies, so nobody can plant answers.
async function cacheKey(task: string, parts: unknown[]) {
  const norm = JSON.stringify(parts).toLowerCase().replace(/\s+/g, " ");
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(task + "|" + norm));
  return task + ":" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 40);
}
async function cacheGet(key: string, days: number) {
  if (!DB_URL || days <= 0) return null;
  try {
    const s = await db();
    const rows = await s`update cellar_ai_cache set hits = hits + 1 where key = ${key} and created_at > now() - make_interval(days => ${days}) returning data`;
    return rows.length ? rows[0].data : null;
  } catch { return null; }
}
async function cachePut(key: string, task: string, data: unknown) {
  if (!DB_URL) return;
  try { const s = await db(); await s`insert into cellar_ai_cache (key, task, data) values (${key}, ${task}, ${s.json(data as never)}) on conflict (key) do update set data = excluded.data, created_at = now(), hits = 0`; } catch { /* cache is optional */ }
}

// Groq (OpenAI-style API). Same prompt; the schema is described in words because Groq's JSON mode doesn't take one.
async function callGroq(parts: unknown[], schema: unknown) {
  const hasImage = parts.some((p) => (p as { inline_data?: unknown }).inline_data);
  const model = hasImage ? (CFG.groq?.vision_model || "qwen/qwen3.8-27b") : (CFG.groq?.model || "qwen/qwen3.8-27b");
  const content: unknown[] = [];
  for (const p of parts as { text?: string; inline_data?: { mime_type: string; data: string } }[]) {
    if (p.text) content.push({ type: "text", text: p.text });
    else if (p.inline_data) content.push({ type: "image_url", image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } });
  }
  content.push({ type: "text", text: "Respond with ONLY one JSON object (no other text) that follows this JSON schema:\n" + JSON.stringify(schema) });
  const r = await fetch(`${GROQ_BASE}/openai/v1/chat/completions`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${GROQ_KEY}` },
    body: JSON.stringify({ model, temperature: 0.2, response_format: { type: "json_object" }, messages: [{ role: "user", content: hasImage ? content : content.map((c) => (c as { text: string }).text).join("\n\n") }] }),
  }).catch(() => null);
  if (!r) return { r: new Response("{}", { status: 503 }), model };
  if (!r.ok) return { r: new Response(await r.text(), { status: r.status }), model };
  const j = await r.json();
  const text = String(j.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "");
  return { r: new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 }), model };
}

async function runGemini(parts: unknown[], schema: unknown, search: boolean) {
  const res = await runGeminiOnly(parts, schema, search);
  if (res.r.ok || !GROQ_KEY || CFG.groq?.enabled === false || !(res.r.status === 429 || res.r.status >= 500 || res.r.status === 404)) return res;
  const g = await callGroq(parts, schema);   // both Gemini models busy or out of free quota → Groq
  return g.r.ok ? { r: g.r, used: "groq:" + g.model } : res;
}
async function runGeminiOnly(parts: unknown[], schema: unknown, search: boolean) {
  const primary = modelPrimary(), fallback = modelFallback();
  const call = (m: string) => callGemini(m, parts, schema, search).catch(() => new Response("{}", { status: 503 }));   // network hiccup → try the backup model
  let r = await call(primary), used = primary;
  if (r.status === 429 || r.status === 503 || r.status === 404) { r = await call(fallback); used = fallback; }
  return { r, used };
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
  if (origin && !ORIGINS.includes("*") && !ORIGINS.includes(origin)) return new Response(JSON.stringify({ error: "Origin not allowed" }), { status: 403, headers: H });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? "anon";
  await config();
  const peek = req.headers.get("x-cellar-task") ?? "";
  const free = peek.startsWith("household_") || peek.startsWith("community_get") || peek.startsWith("store_") || peek === "info";
  if (!free && !allowed(ip)) return new Response(JSON.stringify({ error: "Too many scans this hour. Try again later." }), { status: 429, headers: H });

  let input: { ns?: unknown; key?: unknown; data?: unknown; inputs?: Record<string, unknown>; candidates?: { id: string; name: string; why?: string }[]; details?: string; task?: string; keys?: unknown[]; device?: string; fields?: Record<string, unknown>; code?: string; name?: string; bottles?: Rec[]; tombs?: Record<string, number>; images?: string[]; text?: string; wine?: Record<string, unknown>; dish?: string; catalog?: { id: string; name: string }[]; cellar?: { id: string; name: string }[] };
  try { input = await req.json(); } catch { return new Response(JSON.stringify({ error: "Bad JSON" }), { status: 400, headers: H }); }
  const task = input.task ?? "read";
  if (task === "info") {
    let dbOk = false, cached = 0, saved = 0;
    try { if (DB_URL) { const s = await db(); dbOk = true; const c = await s`select count(*)::int as n, coalesce(sum(hits),0)::int as h from cellar_ai_cache`; cached = c[0].n; saved = c[0].h; } } catch { /* reported as false */ }
    return new Response(JSON.stringify({ ok: true, server_version: SERVER_VERSION, config_version: CFG.version ?? null, config_error: cfgErr || null,
      remembered_answers: cached, quota_saved: saved, model: modelPrimary(), fallback: modelFallback(), groq: GROQ_KEY ? (CFG.groq?.enabled === false ? "off in settings" : (CFG.groq?.model || "qwen/qwen3.8-27b")) : null, web_search: SEARCH, database: dbOk, key_set: !!KEY,
      tasks: ["read", "notes", "pair", ...Object.keys(CFG.tasks ?? {})], stores: Object.keys(CFG.stores ?? {}) }), { headers: H });
  }
  if (task.startsWith("store_")) {
    try { const out = await store(task, input as never, ip); const st = (out as { status?: number }).status;
      return new Response(JSON.stringify(out), { status: st ?? 200, headers: H }); }
    catch (e) { return new Response(JSON.stringify({ error: "Storage isn't available right now.", detail: String(e).slice(0, 200) }), { status: 500, headers: H }); }
  }
  const aiTask = !!CFG.tasks?.[task] || ["read", "notes", "pair"].includes(task);
  if (aiTask && !KEY) return new Response(JSON.stringify({ error: "Server is missing GEMINI_API_KEY" }), { status: 500, headers: H });
  // extra AI tasks defined in the settings file: the prompt and schema come from the file, the app only sends data
  const def = CFG.tasks?.[task];
  if (def && typeof def.prompt === "string") {
    const parts: unknown[] = [{ text: def.prompt }];
    for (const [name, max] of Object.entries(def.inputs ?? {})) {
      const v = input.inputs?.[name]; if (v == null || v === "") continue;
      parts.push({ text: `${name.toUpperCase()}:\n` + (typeof v === "string" ? v : JSON.stringify(v)).slice(0, Math.min(Number(max) || 1000, 20000)) });
    }
    for (const d of (input.images ?? []).slice(0, Math.min(def.images ?? 0, 3))) {
      const m = typeof d === "string" && d.length < 2_500_000 && d.match(/^data:(image\/[a-z]+);base64,(.+)$/);
      if (m) parts.push({ inline_data: { mime_type: m[1], data: m[2] } });
    }
    if (parts.length < 2) return new Response(JSON.stringify({ error: "Nothing to work with" }), { status: 400, headers: H });
    const search = SEARCH && !!def.search;
    const hasImg = parts.some((p) => (p as { inline_data?: unknown }).inline_data);
    const ck = def.cache_days && !hasImg ? await cacheKey(task, parts) : "";
    if (ck) { const hit = await cacheGet(ck, def.cache_days!); if (hit) return new Response(JSON.stringify({ ...(hit as object), cached: true }), { headers: H }); }
    const { r, used } = await runGemini(parts, def.schema ?? { type: "OBJECT", properties: { text: { type: "STRING" } } }, search);
    if (!r.ok) return new Response(JSON.stringify({ error: r.status === 429 ? "The free AI quota is used up for now." : "The AI couldn't answer this one.", status: r.status }), { status: 502, headers: H });
    const j = await r.json(); const out = parseJSON((j.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join(""));
    if (!out) return new Response(JSON.stringify({ error: "The AI reply couldn't be understood." }), { status: 502, headers: H });
    if (ck) await cachePut(ck, task, { ...out, model: used });
    return new Response(JSON.stringify({ ...out, model: used }), { headers: H });
  }
  if (!["read", "notes", "pair"].includes(task) && !task.startsWith("community_") && !task.startsWith("household_"))
    return new Response(JSON.stringify({ error: "This server doesn't know that request yet.", unknown_task: task, server_version: SERVER_VERSION }), { status: 404, headers: H });
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
      parts = [{ text: prompt("notes", NOTES_PROMPT) + (SEARCH ? "\nYou may search the web; respond with ONLY the JSON object." : "") }, { text: "Wine: " + w }]; schema = schemaOf("notes", NOTES_SCHEMA);
    } else {
      const dish = String(input.dish ?? "").slice(0, 300);
      if (!dish) return new Response(JSON.stringify({ error: "Tell me what's for dinner" }), { status: 400, headers: H });
      const cands = (input.candidates ?? []).slice(0, 16);
      if (cands.length) {
        const cel = (input.cellar ?? []).slice(0, 80).map((c) => `${c.id}: ${c.name}`).join("\n").slice(0, 6000);
        const cl = cands.map((c) => `${c.id}: ${c.name}${c.why ? " | guide: " + String(c.why).slice(0, 220) : ""}`).join("\n");
        parts = [{ text: prompt("guided", GUIDED_PROMPT) }, { text: "Meal: " + dish + (input.details ? "\nDetails: " + String(input.details).slice(0, 400) : "") }, { text: "CANDIDATES:\n" + cl }, { text: "CELLAR:\n" + (cel || "(empty)") }];
        schema = schemaOf("pair", PAIR_SCHEMA);
      } else {
      const cat = (input.catalog ?? []).slice(0, 260).map((c) => `${c.id}: ${c.name}`).join("\n").slice(0, 20000);
      const cel = (input.cellar ?? []).slice(0, 80).map((c) => `${c.id}: ${c.name}`).join("\n").slice(0, 6000);
      parts = [{ text: prompt("pair", PAIR_PROMPT) }, { text: "Dinner: " + dish }, { text: "CATALOG:\n" + cat }, { text: "CELLAR:\n" + (cel || "(empty)") }]; schema = schemaOf("pair", PAIR_SCHEMA);
      }
    }
    const useSearch = SEARCH && task === "notes";
    // cache notes always; cache pairings only when no personal cellar list is included
    const days = task === "notes" ? (CFG.cache?.notes_days ?? 180) : ((input.cellar ?? []).length ? 0 : (CFG.cache?.pair_days ?? 60));
    const ck = days > 0 ? await cacheKey(task, parts) : "";
    if (ck) { const hit = await cacheGet(ck, days); if (hit) return new Response(JSON.stringify({ ...(hit as object), cached: true }), { headers: H }); }
    const { r, used } = await runGemini(parts, schema, useSearch);
    if (!r.ok) return new Response(JSON.stringify({ error: r.status === 429 ? "The free AI quota is used up for now." : "The AI couldn't answer this one.", status: r.status }), { status: 502, headers: H });
    const j = await r.json(); const cand = j.candidates?.[0];
    const out = parseJSON((cand?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? "").join(""));
    if (!out) return new Response(JSON.stringify({ error: "The AI reply couldn't be understood." }), { status: 502, headers: H });
    const sources = (cand?.groundingMetadata?.groundingChunks ?? []).map((c: { web?: { uri?: string; title?: string } }) => c.web).filter(Boolean).slice(0, 5);
    const result = { ...out, model: used, web_search: useSearch, sources };
    const looksGood = task === "notes" ? !!(out.headline && Array.isArray(out.taste)) : Array.isArray(out.picks) && out.picks.length > 0;
    if (ck && looksGood) await cachePut(ck, task, result);
    return new Response(JSON.stringify(result), { headers: H });
  }

  const images = (input.images ?? []).slice(0, 2).filter((s) => typeof s === "string" && s.length < 2_500_000);
  const text = (input.text ?? "").slice(0, 2000);
  if (!images.length && !text) return new Response(JSON.stringify({ error: "Send a photo or text" }), { status: 400, headers: H });

  const parts: unknown[] = [{ text: prompt("read", PROMPT) + (SEARCH ? "\nYou may search the web to identify the producer and fill winery_info; respond with ONLY the JSON object (no prose)." : "") }];
  images.forEach((d, i) => {
    const m = d.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (m) parts.push({ text: i === 0 ? "Front label:" : "Back label:" }, { inline_data: { mime_type: m[1], data: m[2] } });
  });
  if (text) parts.push({ text: "Text the user typed or scanned from the label:\n" + text });

  const { r, used } = await runGemini(parts, schemaOf("read", SCHEMA), SEARCH);
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
