"""POST HOC variant (designed after seeing flags.json): viewpoint resolution ignores place=* features (villages, hamlets,
localities) and picks the nearest among exact + prefix matches; F-vis dropped. Writes flags_posthoc.json."""
import json, sys
import p1
from fetch_gaz import dev_rows

orig_resolve = p1.resolve_vp


class GazNoPlace(p1.Gaz):
    def __init__(self, elements):
        super().__init__([el for el in elements if "place" not in el.get("tags", {})])


def resolve_vp(g, cap, lat, lon):
    tk = cap.split()
    hits = []
    for n in range(min(5, len(tk)), 0, -1):
        q = " ".join(tk[:n])
        if len(q.replace(" ", "")) >= 3:
            hits += g.exact(q)
            if hits:
                break
    if tk and tk[-1] in p1.TAIL_GENERIC and len(tk) > 1:
        hits += g.exact(" ".join(tk[:-1]))
    hits += g.prefix(cap)
    return p1.pick_nearest(hits, lat, lon, "posthoc") if hits else None  # no Nominatim in the variant


p1.Gaz = GazNoPlace
p1.resolve_vp = resolve_vp
out = []
for e in dev_rows():
    r = p1.run_photo(e)
    r["flags"] = [f for f in r["flags"] if f != "F-vis"]
    r["suspect"] = bool(r["flags"])
    out.append(r)
    print(r["pid"], r["flags"], [(v["text"], v["feature"] and v["feature"]["name"], v["feature"] and v["feature"]["type"], v["feature"] and v["feature"]["distM"]) for v in r["viewpoints"] if v["feature"]])
json.dump(out, open("flags_posthoc.json", "w"), indent=1, ensure_ascii=False)
