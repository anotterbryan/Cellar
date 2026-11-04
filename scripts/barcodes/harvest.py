"""Barcode harvest for cellar (wine) and quors (spirits) — the production version of Bryan's three handoff scripts.

Runs on GitHub Actions (the build workspace can't reach these sites). Steps:
  off     Open Food Facts bulk export, streamed straight from the download (no 10 GB temp file), codes read as TEXT
          so leading zeros survive, wine/spirit chosen from Open Food Facts' own category tags (not a loose "vin"
          match, which also catches vinegar), every code checked with the GTIN check digit, vintage pulled from names.
  brazos  Brazos Wine's public importer UPC table (Grower, Wine, Vintage, UPC).
  gov     Socrata open-data catalog search: a list of public government alcohol datasets (leads, not barcodes).
  build   Merge into small "shard" files the apps load on demand: barcodes/wine/<first 3 digits>.json and
          barcodes/spirits/<first 3 digits>.json, plus a spreadsheet for Bryan. The hand-curated upc.json lists always win.
Open Food Facts data is © Open Food Facts contributors, Open Database License (ODbL); attribution is kept in the output.
usage: python scripts/barcodes/harvest.py [off] [brazos] [gov] [build]   (no args = all)
"""
import csv, gzip, io, json, os, re, sys, time, urllib.request
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RAW = os.path.join(ROOT, "barcodes", "raw"); os.makedirs(RAW, exist_ok=True)
UA = "CellarLyceumBarcodeHarvest/1.0 (free hobby wine app; github.com/anotterbryan/Cellar)"
OFF_URL = "https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz"
BRAZOS_URL = "https://www.brazoswine.com/resources/upc-codes"

# --- Open Food Facts category tags (their own taxonomy) ---
WINE_TAGS = {"en:wines", "en:red-wines", "en:white-wines", "en:rose-wines", "en:sparkling-wines", "en:champagnes", "en:fortified-wines",
             "en:sweet-wines", "en:dessert-wines", "en:wines-from-france", "en:wines-from-italy", "en:wines-from-spain", "en:proseccos", "en:cavas", "en:ports", "en:sherries"}
SPIRIT_TAGS = {"en:spirits", "en:distilled-spirits", "en:whiskies", "en:whiskeys", "en:bourbons", "en:scotch-whiskies", "en:rums", "en:vodkas", "en:gins",
               "en:tequilas", "en:mezcals", "en:brandies", "en:cognacs", "en:armagnacs", "en:calvados", "en:liqueurs", "en:aperitifs", "en:vermouths",
               "en:anise-flavored-spirits", "en:pastis", "en:ouzos", "en:grappas", "en:piscos", "en:cachacas", "en:absinthes", "en:bitters", "en:amari"}
NOT_DRINK = re.compile(r"vinegar|vinaigre|essig|aceto|vinagre|cooking-wine|wine-sauce|sauce|dressing|marinade|cheese|chocolate|candy|confectioner|"
                       r"jelly|jam|mustard|salt|cake|biscuit|cookie|ice-cream|non-alcoholic|alcohol-free|dealcoholi|grape-juice|syrup", re.I)

def gtin_ok(code):
    """Valid GTIN-8/12/13/14 check digit."""
    if not code.isdigit() or len(code) not in (8, 12, 13, 14): return False
    d = [int(c) for c in code]; body, chk = d[:-1], d[-1]
    s = sum(x * (3 if i % 2 == 0 else 1) for i, x in enumerate(reversed(body)))
    return (10 - s % 10) % 10 == chk

def norm_code(raw):
    c = re.sub(r"\D", "", str(raw or ""))
    if len(c) == 14 and c[0] == "0": c = c[1:]
    if len(c) == 13 and c[0] == "0" and gtin_ok(c[1:]): c = c[1:]   # EAN-13 with leading 0 = the UPC-A on US bottles
    return c if gtin_ok(c) else None

VINT = re.compile(r"\b(19[5-9]\d|20[0-3]\d)\b")
def vintage_of(s):
    m = VINT.search(s or ""); return m.group(1) if m else ""

def fetch(url, timeout=60):
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout)

def step_off():
    print("Open Food Facts: streaming", OFF_URL, flush=True)
    csv.field_size_limit(1 << 30)
    keep = {"wine": {}, "spirits": {}}; n = 0; t0 = time.time()
    with fetch(OFF_URL, timeout=300) as resp:
        text = io.TextIOWrapper(gzip.GzipFile(fileobj=resp), encoding="utf-8", errors="replace", newline="")
        rd = csv.reader(text, delimiter="\t"); head = next(rd); ix = {h: i for i, h in enumerate(head)}
        want = ["code", "product_name", "brands", "categories_tags", "quantity", "countries_tags", "last_modified_t"]
        missing = [w for w in want if w not in ix]
        if missing: print("  columns missing:", missing)
        g = lambda row, k: row[ix[k]] if k in ix and ix[k] < len(row) else ""
        for row in rd:
            n += 1
            if n % 500000 == 0: print(f"  {n:,} products read, {len(keep['wine']):,} wines, {len(keep['spirits']):,} spirits, {time.time() - t0:.0f}s", flush=True)
            tags = set(g(row, "categories_tags").split(","))
            kind = "wine" if tags & WINE_TAGS else "spirits" if tags & SPIRIT_TAGS else None
            if not kind or NOT_DRINK.search(g(row, "categories_tags")): continue
            code = norm_code(g(row, "code"))
            name, brand = g(row, "product_name").strip(), g(row, "brands").split(",")[0].strip()
            if not code or not (name or brand): continue
            keep[kind][code] = {"brand": brand, "name": name, "size": g(row, "quantity").strip()[:20], "vintage": vintage_of(name),
                                "countries": g(row, "countries_tags").replace("en:", "")[:80], "src": "off"}
    print(f"  done: {n:,} products read; kept {len(keep['wine']):,} wines and {len(keep['spirits']):,} spirits")
    for k, v in keep.items(): json.dump(v, open(os.path.join(RAW, f"off_{k}.json"), "w"), ensure_ascii=False)

def step_brazos():
    from bs4 import BeautifulSoup
    print("Brazos Wine:", BRAZOS_URL)
    html = fetch(BRAZOS_URL).read().decode("utf-8", "replace"); soup = BeautifulSoup(html, "html.parser"); out = {}
    for table in soup.find_all("table"):
        heads = [th.get_text(" ", strip=True).lower() for th in table.find_all("th")]
        for tr in table.find_all("tr"):
            cells = [td.get_text(" ", strip=True) for td in tr.find_all("td")]
            if not cells: continue
            row = dict(zip(heads, cells)) if heads and len(heads) == len(cells) else {}
            grower = row.get("grower", cells[0] if len(cells) > 0 else ""); wine = row.get("wine", cells[1] if len(cells) > 1 else "")
            vint = row.get("vintage", cells[2] if len(cells) > 2 else ""); upc = row.get("upc code", row.get("upc", cells[-1]))
            code = norm_code(upc)
            if code: out[code] = {"brand": grower, "name": wine, "size": "", "vintage": vint if re.fullmatch(r"\d{4}", vint or "") else vintage_of(wine), "src": "brazos"}
    print(f"  {len(out)} valid UPCs (codes failing the check digit are skipped: they're typos on the source)")
    p = os.path.join(RAW, "brazos_wine.json"); old = json.load(open(p)) if os.path.exists(p) else {}   # keep Bryan's saved copy as a fallback
    json.dump({**old, **out}, open(p, "w"), ensure_ascii=False)

def step_gov():
    print("Socrata open-data catalog search")
    res = []
    for q in ["Iowa liquor products", "liquor products", "liquor product list", "wine", "spirits price list", "alcoholic beverage", "liquor brands"]:
        try:
            j = json.load(fetch("https://api.us.socrata.com/api/catalog/v1?only=datasets&limit=50&q=" + urllib.parse.quote(q)))
            for it in j.get("results", []):
                r, m = it.get("resource", {}), it.get("metadata", {})
                res.append({"query": q, "id": r.get("id"), "title": r.get("name"), "agency": m.get("domain"), "link": it.get("permalink") or r.get("permalink", ""),
                            "updated": r.get("updatedAt"), "columns": r.get("columns_name", [])[:40], "description": (r.get("description") or "")[:400]})
        except Exception as e: print("  query failed:", q, e)
    seen, uniq = set(), []
    for r in res:
        if r["id"] not in seen: seen.add(r["id"]); uniq.append(r)
    for r in uniq: r["has_barcode_column"] = any(re.search(r"(^|[_ ])(upc|ean|gtin|barcode|upc_code)([_ ]|$)", (c or "").lower()) for c in r["columns"])
    print(f"  {len(uniq)} datasets, {sum(r['has_barcode_column'] for r in uniq)} with a barcode-like column")
    json.dump(uniq, open(os.path.join(RAW, "gov_datasets.json"), "w"), ensure_ascii=False, indent=1)

GOVKEEP = re.compile(r"liquor|spirit|wine|alcohol", re.I)
def _pick(cols, *pats):
    for p in pats:
        for c in cols:
            if re.search(p, c, re.I): return c
    return None
def step_govdata():
    """Pull the public government datasets that actually carry barcodes (e.g. a state liquor product list) via the SODA API."""
    leads = json.load(open(os.path.join(RAW, "gov_datasets.json"))) if os.path.exists(os.path.join(RAW, "gov_datasets.json")) else []
    out = {"wine": {}, "spirits": {}}
    for d in [r for r in leads if r["has_barcode_column"] and GOVKEEP.search(r["title"] or "") and not re.search(r"vending|energy|sales by|tax", r["title"] or "", re.I)][:8]:
        dom, rid = d["agency"], d["id"]; rows = []; off = 0
        print("  dataset:", dom, rid, d["title"])
        try:
            while off < 400000:
                page = json.load(fetch(f"https://{dom}/resource/{rid}.json?$limit=50000&$offset={off}", timeout=120))
                if not page: break
                rows += page; off += len(page)
                if len(page) < 50000: break
        except Exception as e: print("   failed:", e); continue
        if not rows: continue
        cols = list({k for r in rows[:200] for k in r})
        cu = _pick(cols, r"^upc$", r"upc", r"gtin", r"ean", r"barcode"); cn = _pick(cols, r"item_desc", r"description", r"product_name", r"^name$", r"brand")
        cv = _pick(cols, r"vendor_name", r"vendor", r"supplier", r"manufacturer", r"brand"); cs = _pick(cols, r"bottle_volume", r"size", r"volume")
        cc = _pick(cols, r"category_name", r"category", r"class", r"type")
        if not (cu and cn): print("   no usable columns", cols[:20]); continue
        n = 0
        for r in rows:
            code = norm_code(r.get(cu)); name = (r.get(cn) or "").strip()
            if not code or not name: continue
            cat = (r.get(cc) or "") + " " + name; kind = "wine" if re.search(r"\bwine|vino|champagne|prosecco|port\b|sherry", cat, re.I) and not re.search(r"liqueur|brandy|schnapps", cat, re.I) else "spirits"
            size = r.get(cs) or ""; size = f"{size} ml" if str(size).isdigit() else str(size)
            out[kind][code] = {"brand": (r.get(cv) or "").strip().title(), "name": name.title() if name.isupper() else name, "size": size[:20], "vintage": vintage_of(name), "src": "gov:" + dom}; n += 1
        print(f"   {n:,} barcodes")
    for k, v in out.items(): json.dump(v, open(os.path.join(RAW, f"gov_{k}.json"), "w"), ensure_ascii=False)

WIKIDATA_Q = """SELECT ?item ?itemLabel ?gtin ?brandLabel ?kind WHERE {
  ?item wdt:P3962 ?gtin .
  { ?item wdt:P31/wdt:P279* wd:Q282 . BIND("wine" AS ?kind) } UNION { ?item wdt:P31/wdt:P279* wd:Q56139 . BIND("spirits" AS ?kind) }
  UNION { ?item wdt:P31/wdt:P279* wd:Q154 . BIND("spirits" AS ?kind) }
  OPTIONAL { ?item wdt:P1716 ?brand . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,fr,es,it,de". }
}"""
def step_wikidata():
    """Wikidata (Wikipedia's structured-data sister, CC0): drinks that carry a GTIN barcode (property P3962)."""
    import urllib.parse
    out = {"wine": {}, "spirits": {}}
    try:
        req = urllib.request.Request("https://query.wikidata.org/sparql?format=json&query=" + urllib.parse.quote(WIKIDATA_Q), headers={"User-Agent": UA, "Accept": "application/sparql-results+json"})
        rows = json.load(urllib.request.urlopen(req, timeout=180))["results"]["bindings"]
    except Exception as e: print("  Wikidata query failed:", e); rows = []
    for r in rows:
        code = norm_code(r["gtin"]["value"]); name = r.get("itemLabel", {}).get("value", "")
        if not code or re.fullmatch(r"Q\d+", name): continue
        out[r["kind"]["value"]][code] = {"brand": r.get("brandLabel", {}).get("value", ""), "name": name, "size": "", "vintage": vintage_of(name), "src": "wikidata"}
    print(f"Wikidata: {len(out['wine'])} wines, {len(out['spirits'])} spirits with a valid barcode")
    for k, v in out.items(): json.dump(v, open(os.path.join(RAW, f"wikidata_{k}.json"), "w"), ensure_ascii=False)

TRADE_SHEETS = ["https://www.jfwthekey.com/asset/distributor-standard-wine-list-excel-july-2018", "https://www.finewinepa.com/fine-wines/wine-list-excel/"]
def step_sheets():
    """Producers' and retailers' public trade spreadsheets: keep any rows that carry a valid UPC/EAN."""
    import openpyxl; out = {}
    for url in TRADE_SHEETS:
        try:
            data = fetch(url, timeout=120).read()
            if not data[:2] == b"PK": print("  not an Excel file:", url); continue
            wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True); n = 0
            for ws in wb:
                head, hi = None, {}
                for row in ws.iter_rows(values_only=True):
                    cells = ["" if c is None else str(c).strip() for c in row]
                    if head is None:
                        if any(re.search(r"upc|ean|gtin|barcode", c, re.I) for c in cells): head = cells; hi = {c.lower(): i for i, c in enumerate(cells)}
                        continue
                    pick = lambda *ps: next((cells[i] for k, i in hi.items() for p in ps if re.search(p, k) and i < len(cells) and cells[i]), "")
                    code = norm_code(pick(r"upc", r"ean", r"gtin", r"barcode"))
                    if not code: continue
                    name = pick(r"wine", r"description", r"product", r"name", r"item"); brand = pick(r"brand", r"producer", r"winery", r"grower")
                    out[code] = {"brand": brand, "name": name, "size": pick(r"size", r"volume", r"format")[:20], "vintage": pick(r"vintage") or vintage_of(name), "src": "sheet:" + url.split("/")[2]}; n += 1
            print(f"  {url}: {n} barcodes")
        except Exception as e: print("  failed:", url, e)
    json.dump(out, open(os.path.join(RAW, "sheets_wine.json"), "w"), ensure_ascii=False)

def step_build():
    load = lambda f: json.load(open(os.path.join(RAW, f))) if os.path.exists(os.path.join(RAW, f)) else {}
    seed_w = json.load(open(os.path.join(ROOT, "upc.json")))["codes"]; seed_s = json.load(open(os.path.join(ROOT, "quors", "upc.json")))["codes"]
    sets = {"wine": ({**load("off_wine.json"), **load("wikidata_wine.json"), **load("gov_wine.json"), **load("sheets_wine.json"), **load("brazos_wine.json")}, seed_w),
            "spirits": ({**load("off_spirits.json"), **load("wikidata_spirits.json"), **load("gov_spirits.json")}, seed_s)}
    import openpyxl; wb = openpyxl.Workbook(); wb.remove(wb.active)
    for kind, (found, seed) in sets.items():
        shards = defaultdict(dict); added = 0
        for code, r in sorted(found.items()):
            if code in seed or ("0" + code) in seed or (code[1:] if len(code) == 13 and code[0] == "0" else None) in seed: continue
            shards[code[:3]][code] = [r["brand"], r["name"] + (f" {r['vintage']}" if r.get("vintage") and r["vintage"] not in r["name"] else ""), r["size"], r["src"]]; added += 1
        d = os.path.join(ROOT, "barcodes", kind); os.makedirs(d, exist_ok=True)
        for f in os.listdir(d):
            if f.endswith(".json"): os.remove(os.path.join(d, f))
        for p, codes in shards.items(): json.dump(codes, open(os.path.join(d, f"{p}.json"), "w"), ensure_ascii=False, separators=(",", ":"))
        srcs = sorted({r["src"] for r in found.values()})
        json.dump({"about": f"{kind} barcodes beyond the curated list. Sources: Open Food Facts (© Open Food Facts contributors, ODbL), Wikidata (CC0), Brazos Wine's public importer UPC table, "
                   "public government open-data product lists and producers' public trade spreadsheets. Row: [brand, name, size, source].", "sources": srcs,
                   "count": added, "shards": sorted(shards), "built": time.strftime("%Y-%m-%d")}, open(os.path.join(d, "index.json"), "w"), indent=1)
        ws = wb.create_sheet(f"{kind.title()} barcodes"); ws.append(["Barcode (UPC/EAN)", "Brand / grower", "Name", "Vintage", "Size", "Countries", "Source"])
        for code, r in sorted(found.items()): ws.append([code, r["brand"], r["name"], r.get("vintage", ""), r["size"], r.get("countries", ""), {"off": "Open Food Facts", "brazos": "Brazos Wine", "wikidata": "Wikidata (CC0)"}.get(r["src"], r["src"])])
        print(f"{kind}: {len(found):,} found, {added:,} new beyond the curated list, {len(shards)} shard files")
    gov = load("gov_datasets.json")
    if gov:
        ws = wb.create_sheet("Gov dataset leads"); ws.append(["Title", "Agency", "Has barcode column", "Link", "Updated", "Description"])
        for r in sorted(gov, key=lambda r: not r["has_barcode_column"]): ws.append([r["title"], r["agency"], "yes" if r["has_barcode_column"] else "", r["link"], r["updated"], r["description"]])
    wb.save(os.path.join(ROOT, "barcodes", "Cellar_Barcode_Harvest.xlsx"))

if __name__ == "__main__":
    steps = sys.argv[1:] or ["off", "brazos", "wikidata", "gov", "govdata", "sheets", "build"]
    import urllib.parse  # noqa
    for s in steps:
        try: globals()["step_" + s]()
        except Exception as e: print(f"step {s} failed: {e!r}"); (s == "build") and sys.exit(1)
