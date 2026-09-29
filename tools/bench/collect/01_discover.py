"""Step 1: discover candidate File: titles on Commons via geosearch + category walks.

Output: work/titles.json  {title: {"src": [...], "region": str}}
"""
from common import api, save, load

# (region, name, lat, lon) -- viewpoints / valleys across Swiss mountain areas
POINTS = [
    # Bernese Oberland
    ("bernese", "Grindelwald", 46.624, 8.041), ("bernese", "Kleine Scheidegg", 46.585, 7.961),
    ("bernese", "Muerren", 46.559, 7.892), ("bernese", "Wengen", 46.605, 7.922),
    ("bernese", "Schilthorn", 46.558, 7.835), ("bernese", "First", 46.659, 8.054),
    ("bernese", "Schynige Platte", 46.652, 7.911), ("bernese", "Niederhorn", 46.710, 7.770),
    ("bernese", "Maennlichen", 46.612, 7.941), ("bernese", "Oeschinensee", 46.498, 7.727),
    ("bernese", "Adelboden", 46.490, 7.560), ("bernese", "Gstaad", 46.475, 7.286),
    ("bernese", "Lenk", 46.450, 7.440), ("bernese", "Grimsel", 46.560, 8.330),
    ("bernese", "Hasliberg", 46.745, 8.200), ("bernese", "Brienzer Rothorn", 46.787, 8.047),
    ("bernese", "Jungfraujoch", 46.547, 7.985), ("bernese", "Niesen", 46.645, 7.651),
    ("bernese", "Stockhorn", 46.694, 7.539), ("bernese", "Gasterntal", 46.430, 7.700),
    # Valais
    ("valais", "Zermatt", 46.020, 7.750), ("valais", "Gornergrat", 45.983, 7.785),
    ("valais", "Riffelsee", 45.990, 7.760), ("valais", "Saas Fee", 46.108, 7.928),
    ("valais", "Bettmerhorn", 46.400, 8.060), ("valais", "Eggishorn", 46.427, 8.093),
    ("valais", "Riederalp", 46.380, 8.020), ("valais", "Graechen", 46.195, 7.838),
    ("valais", "Verbier", 46.096, 7.228), ("valais", "Arolla", 46.020, 7.480),
    ("valais", "Zinal", 46.130, 7.630), ("valais", "Crans-Montana", 46.310, 7.480),
    ("valais", "Leukerbad", 46.380, 7.630), ("valais", "Loetschental", 46.420, 7.800),
    ("valais", "Simplon", 46.250, 8.030), ("valais", "Grand St Bernard", 45.900, 7.170),
    ("valais", "Champery", 46.180, 6.870), ("valais", "Sion", 46.230, 7.360),
    ("valais", "Moiry", 46.140, 7.580), ("valais", "Findeln", 46.010, 7.790),
    # Engadin / Graubuenden
    ("graubuenden", "St Moritz", 46.490, 9.840), ("graubuenden", "Muottas Muragl", 46.520, 9.900),
    ("graubuenden", "Diavolezza", 46.410, 9.970), ("graubuenden", "Bernina", 46.430, 10.020),
    ("graubuenden", "Corvatsch", 46.420, 9.820), ("graubuenden", "Maloja", 46.400, 9.690),
    ("graubuenden", "Pontresina", 46.490, 9.900), ("graubuenden", "Scuol", 46.800, 10.300),
    ("graubuenden", "Davos", 46.800, 9.830), ("graubuenden", "Arosa", 46.780, 9.680),
    ("graubuenden", "Flims", 46.830, 9.280), ("graubuenden", "Lenzerheide", 46.730, 9.560),
    ("graubuenden", "Albula", 46.580, 9.840), ("graubuenden", "Flueela", 46.750, 9.950),
    ("graubuenden", "Zernez NP", 46.660, 10.100), ("graubuenden", "Splugen", 46.550, 9.320),
    ("graubuenden", "Oberalp", 46.660, 8.750), ("graubuenden", "Soglio", 46.340, 9.540),
    ("graubuenden", "Val Muestair", 46.620, 10.380), ("graubuenden", "Vals", 46.620, 9.180),
    # Central Switzerland
    ("central", "Pilatus", 46.979, 8.255), ("central", "Rigi", 47.057, 8.485),
    ("central", "Stanserhorn", 46.930, 8.340), ("central", "Engelberg Titlis", 46.800, 8.430),
    ("central", "Brunnen", 46.990, 8.610), ("central", "Stoos", 46.980, 8.660),
    ("central", "Andermatt", 46.630, 8.590), ("central", "Furka", 46.570, 8.410),
    ("central", "Susten", 46.730, 8.450), ("central", "Klausenpass", 46.870, 8.850),
    ("central", "Mythen", 47.030, 8.690), ("central", "Melchsee-Frutt", 46.770, 8.270),
    ("central", "Buergenstock", 46.995, 8.380), ("central", "Uetliberg", 47.350, 8.490),
    # Glarus
    ("glarus", "Braunwald", 46.940, 8.990), ("glarus", "Kloental", 47.030, 8.980),
    ("glarus", "Elm", 46.920, 9.170), ("glarus", "Amden", 47.150, 9.140),
    ("glarus", "Flumserberg", 47.090, 9.280), ("glarus", "Muttsee", 46.860, 8.990),
    # Saentis / Appenzell
    ("appenzell", "Saentis", 47.250, 9.340), ("appenzell", "Ebenalp", 47.285, 9.410),
    ("appenzell", "Seealpsee", 47.270, 9.400), ("appenzell", "Hoher Kasten", 47.280, 9.490),
    ("appenzell", "Churfirsten", 47.180, 9.280), ("appenzell", "Faelensee", 47.250, 9.430),
    # Ticino
    ("ticino", "Monte Generoso", 45.930, 9.020), ("ticino", "San Salvatore", 45.980, 8.950),
    ("ticino", "Monte Bre", 46.010, 8.990), ("ticino", "Monte Tamaro", 46.100, 8.870),
    ("ticino", "Cardada", 46.200, 8.780), ("ticino", "Verzasca", 46.300, 8.840),
    ("ticino", "Val Bavona", 46.400, 8.530), ("ticino", "Airolo", 46.530, 8.610),
    ("ticino", "Gotthard", 46.560, 8.570), ("ticino", "Nufenen", 46.480, 8.390),
    ("ticino", "Lucomagno", 46.560, 8.800), ("ticino", "Monte Lema", 46.040, 8.830),
    ("ticino", "Val Maggia", 46.300, 8.650),
    # Jura
    ("jura", "Chasseral", 47.130, 7.060), ("jura", "Creux du Van", 46.930, 6.720),
    ("jura", "Weissenstein", 47.250, 7.510), ("jura", "Dent de Vaulion", 46.680, 6.350),
    ("jura", "La Dole", 46.420, 6.100), ("jura", "Chasseron", 46.850, 6.540),
    ("jura", "Mont Tendre", 46.590, 6.310),
    # Vaud / Fribourg Alps
    ("vaud", "Rochers de Naye", 46.430, 6.980), ("vaud", "Leysin", 46.340, 7.010),
    ("vaud", "Les Diablerets", 46.350, 7.160), ("vaud", "Moleson", 46.550, 7.020),
    ("vaud", "Lavaux", 46.490, 6.740),
]

CATEGORIES = [
    "Category:Views from Pilatus", "Category:Views from Rigi", "Category:Views from Säntis",
    "Category:Views from Gornergrat", "Category:Views from Niesen", "Category:Views from Schilthorn",
    "Category:Views from Männlichen", "Category:Views from Muottas Muragl", "Category:Views from Uetliberg",
    "Category:Views from Chasseral", "Category:Views from Monte Generoso", "Category:Views from Stanserhorn",
    "Category:Views from Titlis", "Category:Views from Brienzer Rothorn", "Category:Views from Diavolezza",
    "Category:Views from Eggishorn", "Category:Views from Hoher Kasten", "Category:Views from the Jungfraujoch",
    "Category:Views from Kleine Scheidegg", "Category:Views from Schynige Platte", "Category:Views from Niederhorn",
    "Category:Views from Weissenstein", "Category:Views from Monte Tamaro", "Category:Views from Moléson",
    "Category:Views from Rochers de Naye", "Category:Views from Stockhorn", "Category:Views from Piz Nair",
    "Category:Views from Corvatsch", "Category:Views from Fronalpstock", "Category:Views from Ebenalp",
    "Category:Mountains of Switzerland",
]


def geosearch(lat, lon, radius=10000):
    r = api({"action": "query", "list": "geosearch", "gscoord": f"{lat}|{lon}", "gsradius": radius,
             "gslimit": 500, "gsnamespace": 6, "gsprimary": "all"})
    return [g["title"] for g in r.get("query", {}).get("geosearch", [])]


def catmembers(cat, cmtype="file", limit_pages=4):
    out, cont = [], {}
    for _ in range(limit_pages):
        r = api({"action": "query", "list": "categorymembers", "cmtitle": cat, "cmtype": cmtype,
                 "cmlimit": 500, **cont})
        out += [m["title"] for m in r.get("query", {}).get("categorymembers", [])]
        if "continue" not in r:
            break
        cont = r["continue"]
    return out


def main():
    titles = load("titles.json", {})
    done = set(load("discover_done.json", []))

    def add(t, src, region):
        if not t.lower().endswith((".jpg", ".jpeg")):
            return
        e = titles.setdefault(t, {"src": [], "region": region})
        if src not in e["src"]:
            e["src"].append(src)

    for region, name, lat, lon in POINTS:
        key = "geo:" + name
        if key in done:
            continue
        ts = geosearch(lat, lon)
        for t in ts:
            add(t, key, region)
        done.add(key)
        print(f"{name}: {len(ts)} (total {len(titles)})")
        save("titles.json", titles); save("discover_done.json", sorted(done))

    for cat in CATEGORIES:
        key = "cat:" + cat
        if key in done:
            continue
        files = catmembers(cat)
        # one level of subcategories (e.g. per-peak categories under Mountains of Switzerland)
        if cat == "Category:Mountains of Switzerland":
            subs = catmembers(cat, cmtype="subcat", limit_pages=2)
            for s in subs[:150]:
                files += catmembers(s, limit_pages=1)
        for t in files:
            add(t, key, "cat")
        done.add(key)
        print(f"{cat}: {len(files)} (total {len(titles)})")
        save("titles.json", titles); save("discover_done.json", sorted(done))


if __name__ == "__main__":
    main()
