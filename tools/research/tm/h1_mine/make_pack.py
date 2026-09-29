"""H1 blind pack inputs (PROTOCOL.txt BLIND PACK): blind candidates + S4 pilot picks + controls (duplicates, yaw decoys,
positive controls, wrong-by-construction noise checks). Seeded (20260928). Writes key/key.json, key/pack_cands.json,
pack_index.json; then run build_pack.ts (see REPORT.txt)."""
from __future__ import annotations

import collections
import hashlib
import json
import random
import sys
from pathlib import Path

from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import tm_common  # noqa: E402
import refs  # noqa: E402

ROOT = tm_common.ROOT
SEED = 20260928
MAN = {e["id"]: e for e in json.load(open(ROOT / "tools/bench/data/manifest.json"))}
KEY = HERE / "key"
WIDTHS = [1240, 1320, 1400, 1480]


def main():
    rng = random.Random(SEED)
    pool = json.load(open(HERE / "pool.json"))
    items = []  # {pid, kind, pose, eye, cid?, ...}
    blind = [r for r in pool if r["status"] == "blind"]
    for r in blind:
        items.append({"pid": r["pid"], "kind": "pilot" if r["label"] == "pilot" else "candidate", "cid": r["cid"],
                      "pose": r["pose"], "eye": r["eye"]})
    # wrong-by-construction label-noise checks: 20 % (>= 5)
    wc = sorted([r for r in pool if r["status"] == "wrong-construct"], key=lambda r: r["cid"])
    nwc = min(len(wc), max(5, round(0.2 * len(wc))))
    for r in rng.sample(wc, nwc):
        items.append({"pid": r["pid"], "kind": "construct-check", "cid": r["cid"], "pose": r["pose"], "eye": r["eye"]})
    pack_pids = sorted({it["pid"] for it in items})
    # duplicates: ~10 % of blind candidates (>= 5)
    nd = min(len(blind), max(5, round(0.1 * len(blind))))
    dups = rng.sample(sorted(blind, key=lambda r: r["cid"]), nd)
    for r in dups:
        items.append({"pid": r["pid"], "kind": "duplicate", "cid": r["cid"], "pose": r["pose"], "eye": r["eye"]})
    # correct refs of pack photos (fallback: any dev photo) for decoys / positive controls
    def correct_of(pids):
        out = []
        for p in pids:
            for c in refs.correct_refs(p):
                out.append({"pid": p, "ref": c["label"], "pose": {k: float(c["pose"][k]) for k in ("yaw", "pitch", "roll", "vfov")},
                            "eye": {"lat": MAN[p]["lat"], "lon": MAN[p]["lon"], "h": float(c["eyeH"])}})
        return out
    cref = correct_of(pack_pids)
    others = correct_of([p for p in sorted(tm_common.dev_ids()) if p not in pack_pids])
    rng.shuffle(cref)
    rng.shuffle(others)
    pool_refs = cref + others
    # one ref per photo first
    seen, uniq = set(), []
    for c in pool_refs:
        if c["pid"] not in seen:
            seen.add(c["pid"])
            uniq.append(c)
    n_dec, n_pos = max(6, round(0.05 * len(blind))), max(4, round(0.04 * len(blind)))
    decoy_src, pos_src = uniq[:n_dec], uniq[n_dec:n_dec + n_pos]
    if len(pos_src) < n_pos:
        pos_src += [c for c in pool_refs if c not in decoy_src and c not in pos_src][: n_pos - len(pos_src)]
    for c in decoy_src:
        m = MAN[c["pid"]]
        # narrow = hfov < 25 deg: use the cache meta
        hf = json.load(open(tm_common.CACHE / c["pid"] / "meta.json"))["hfov0"]
        d = (3.0 if hf < 25 else 5.0) * rng.choice((-1, 1))
        items.append({"pid": c["pid"], "kind": f"decoy-yaw{d:+.0f}", "ref": c["ref"], "pose": {**c["pose"], "yaw": (c["pose"]["yaw"] + d) % 360},
                      "eye": c["eye"]})
    for c in pos_src:
        items.append({"pid": c["pid"], "kind": "positive-control", "ref": c["ref"], "pose": c["pose"], "eye": c["eye"]})
    # labels, folders, widths
    salt = hashlib.sha256(f"h1-{SEED}".encode()).hexdigest()[:12]
    used = set()

    def label():
        while True:
            L = rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") + rng.choice("ABCDEFGHJKLMNPQRSTUVWXYZ") + str(rng.randint(2, 9))
            if L not in used:
                used.add(L)
                return L
    imgw = {}
    width_of = {}
    for it in items:
        p = it["pid"]
        if p not in imgw:
            imgw[p] = Image.open(ROOT / "tools/bench/data" / MAN[p]["file"]).width
        ws = sorted({min(w, imgw[p]) for w in WIDTHS} | ({imgw[p] - 80} if imgw[p] <= WIDTHS[0] else set()))
        if it["kind"] == "duplicate":
            ws = [w for w in ws if w != width_of.get(it["cid"])] or ws
            it["width"] = rng.choice(ws)
        else:
            it["width"] = rng.choice(ws)
            if it.get("cid") and it["kind"] in ("candidate", "pilot"):
                width_of[it["cid"]] = it["width"]
    rng.shuffle(items)
    for it in items:
        it["label"] = label()
        it["folder"] = "p" + hashlib.sha256(f"{salt}:{it['pid']}".encode()).hexdigest()[:10]
    KEY.mkdir(exist_ok=True)
    folders = sorted({it["folder"] for it in items})
    # batching: ~12-15 folders per batch, shuffled
    fl = folders[:]
    rng.shuffle(fl)
    nb = max(1, round(len(fl) / 13.5))
    batches = [sorted(fl[i::nb]) for i in range(nb)]
    key = {"seed": SEED, "salt": salt, "folders": {it["folder"]: it["pid"] for it in items},
           "candidates": {it["label"]: it for it in items},
           "counts": dict(collections.Counter(it["kind"] if not it["kind"].startswith("decoy") else "decoy" for it in items)),
           "batches": batches}
    json.dump(key, open(KEY / "key.json", "w"), indent=1)
    json.dump([{k: it[k] for k in ("pid", "folder", "label", "width", "pose", "eye")} for it in items],
              open(KEY / "pack_cands.json", "w"), indent=0)
    idx = {"folders": folders, "nFolders": len(folders), "nImages": len(items),
           "suggestedBatches": batches,
           "note": "Each folder = one photo (photo.jpg) + its candidate_XX.jpg overlays. Verify every candidate in a folder "
                   "in the same batch. No key information here."}
    json.dump(idx, open(HERE / "pack_index.json", "w"), indent=1)
    print(len(items), "images in", len(folders), "folders;", key["counts"], "batches", [len(b) for b in batches])


if __name__ == "__main__":
    main()
