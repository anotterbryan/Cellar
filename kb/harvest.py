"""Cellar knowledge base: download Wikipedia (+ Wikidata) pages for every wine style, grape, wine country and core topic.
Runs on GitHub Actions (see .github/workflows/harvest-wikipedia.yml). Output: kb/wiki/<kind>/<slug>.json and kb/wiki/index.json.
Wikipedia text is CC BY-SA 4.0: each file keeps the page URL and revision so it can be credited."""
import json, os, re, sys, time, urllib.parse, urllib.request

API = "https://en.wikipedia.org/w/api.php"
WD = "https://www.wikidata.org/w/api.php"
UA = "CellarLyceumKB/1.0 (https://anotterbryan.github.io/Cellar/; github.com/anotterbryan/Cellar) python-urllib"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wiki")
WINEY = re.compile(r"\b(wine|wines|grape|grapes|vineyard|vineyards|viticulture|appellation|winemaking|vintner|winery|DOC|AOC|AVA)\b", re.I)

def get(url, params):
    params = {**params, "format": "json", "formatversion": "2", "maxlag": "5"}
    q = url + "?" + urllib.parse.urlencode(params)
    for attempt in range(5):
        try:
            with urllib.request.urlopen(urllib.request.Request(q, headers={"User-Agent": UA}), timeout=30) as r:
                j = json.load(r)
            if "error" in j and j["error"].get("code") == "maxlag": time.sleep(5); continue
            time.sleep(0.15)
            return j
        except Exception as e:
            time.sleep(2 + attempt * 3)
    raise RuntimeError("request failed: " + q[:200])

def page(title):
    j = get(API, {"action": "query", "titles": title, "redirects": "1", "prop": "extracts|info|pageprops|pageimages|categories|revisions",
                  "explaintext": "1", "exsectionformat": "wiki", "inprop": "url", "ppprop": "wikibase_item|disambiguation",
                  "piprop": "original", "cllimit": "max", "clshow": "!hidden", "rvprop": "ids|timestamp"})
    p = (j.get("query", {}).get("pages") or [{}])[0]
    if p.get("missing") or "pageprops" in p and "disambiguation" in p["pageprops"]: return None
    return p

def search(q, n=4):
    j = get(API, {"action": "query", "list": "search", "srsearch": q, "srlimit": str(n)})
    return [s["title"] for s in j.get("query", {}).get("search", [])]

def winey(p):
    lead = (p.get("extract") or "")[:2500]
    cats = " ".join(c["title"] for c in p.get("categories", []))
    return bool(WINEY.search(lead)) or "wine" in cats.lower() or "grape" in cats.lower()

def resolve(cands, extra_search):
    tried = []
    for t in cands:
        p = page(t); tried.append(t)
        if p and winey(p): return p, "direct", tried
    for q in extra_search:
        for t in search(q):
            if t in tried: continue
            p = page(t); tried.append(t)
            if p and winey(p): return p, "search", tried
    return None, "not found", tried

def wikidata(qid):
    if not qid: return {}
    j = get(WD, {"action": "wbgetentities", "ids": qid, "props": "claims|descriptions", "languages": "en"})
    ent = j.get("entities", {}).get(qid, {})
    keep = {}
    for prop, name in [("P17", "country"), ("P625", "coordinates"), ("P18", "image"), ("P31", "instance_of"), ("P279", "subclass_of"), ("P495", "country_of_origin"), ("P131", "located_in")]:
        vals = []
        for c in ent.get("claims", {}).get(prop, []):
            v = c.get("mainsnak", {}).get("datavalue", {}).get("value")
            if isinstance(v, dict) and "id" in v: v = v["id"]
            if isinstance(v, dict) and "latitude" in v: v = {"lat": v["latitude"], "lon": v["longitude"]}
            if v is not None: vals.append(v)
        if vals: keep[name] = vals
    keep["description"] = ent.get("descriptions", {}).get("en", {}).get("value")
    return keep

def slug(s): return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:80]

def save(kind, key, label, p, how, tried):
    os.makedirs(os.path.join(OUT, kind), exist_ok=True)
    rec = {"kind": kind, "key": key, "label": label, "match": how, "tried": tried}
    if p:
        qid = p.get("pageprops", {}).get("wikibase_item")
        text = p.get("extract") or ""
        rec.update({"title": p["title"], "url": p.get("fullurl"), "revision": (p.get("revisions") or [{}])[0].get("revid"),
                    "fetched": time.strftime("%Y-%m-%d"), "license": "CC BY-SA 4.0 (Wikipedia contributors)",
                    "wikidata": qid, "image": (p.get("original") or {}).get("source"),
                    "categories": [c["title"].replace("Category:", "") for c in p.get("categories", [])],
                    "lead": text.split("\n==")[0].strip(),
                    "sections": [s.strip() for s in re.findall(r"^==+\s*(.*?)\s*==+\s*$", text, re.M)],
                    "text": text, "facts": wikidata(qid)})
    with open(os.path.join(OUT, kind, slug(key) + ".json"), "w", encoding="utf-8") as f: json.dump(rec, f, ensure_ascii=False, indent=1)
    return {"kind": kind, "key": key, "label": label, "title": rec.get("title"), "url": rec.get("url"), "match": how, "chars": len(rec.get("text", ""))}

def main():
    T = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "targets.json"), encoding="utf-8"))
    only = sys.argv[1] if len(sys.argv) > 1 else "all"
    idx = []
    def run(kind, key, label, cands, extra):
        try:
            p, how, tried = resolve(cands, extra); idx.append(save(kind, key, label, p, how, tried))
        except Exception as e:
            idx.append({"kind": kind, "key": key, "label": label, "match": "error: " + str(e)[:120]})
        print(kind, key, "→", idx[-1].get("title"), "(" + idx[-1]["match"] + ")", flush=True)
    if only in ("all", "topic"):
        for t in T["topics"]: run("topic", t, t, [t], [t])
    if only in ("all", "grape"):
        for g in T["grapes"]: run("grape", g, g, [f"{g} (grape)", g], [f"{g} grape variety"])
    if only in ("all", "country"):
        for c in T["countries"]: run("country", c, c, [f"{c} wine", f"Wine in {c}", f"Wine in the {c}", f"Winemaking in {c}"], [f"{c} wine industry"])
    if only in ("all", "wine"):
        for w in T["wines"]:
            run("wine", w["id"], w["name"], w["candidates"], [w["candidates"][0] + " wine", " ".join(w["grapes"][:1] + [w["region"]]) + " wine"])
    os.makedirs(OUT, exist_ok=True)
    old = []
    ip = os.path.join(OUT, "index.json")
    if only != "all" and os.path.exists(ip): old = [r for r in json.load(open(ip)) if r["kind"] != only]
    json.dump(old + idx, open(ip, "w"), ensure_ascii=False, indent=1)
    found = sum(1 for r in idx if r.get("title"))
    print(f"done: {found}/{len(idx)} matched")

if __name__ == "__main__": main()
