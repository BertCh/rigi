"""X2 diagnostic figures (small PNGs in figs/)."""
from __future__ import annotations
import _env  # noqa: F401
import glob, json
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import geomscore as GS
from geomscore import C
from analyze import get

BLUE, ORANGE, GRAY, INK = "#2a78d6", "#eb6834", "#8a8984", "#52514e"
OUT = _env.HERE / "figs"
OUT.mkdir(exist_ok=True)
plt.rcParams.update({"font.size": 8, "axes.edgecolor": GRAY, "axes.labelcolor": INK, "xtick.color": INK, "ytick.color": INK,
                     "axes.spines.top": False, "axes.spines.right": False})
R = {f.split("/")[-1][:-5]: json.load(open(f)) for f in sorted(glob.glob(str(_env.HERE / "results/*.json")))}


def fig_example(pids):
    fig, ax = plt.subplots(len(pids), 4, figsize=(11, 2.2 * len(pids)))
    for i, pid in enumerate(pids):
        m = C.load_meta(pid)
        g = dict(np.load(_env.HERE / "geom" / f"{pid}.moge_l.npz"))
        refs = (m["correct_refs"][:1] + m["wrong_refs"])[:2]
        ax[i, 0].imshow(C.load_photo(pid)); ax[i, 0].set_title(pid, loc="left")
        for j, x in enumerate(refs):
            rec = C.load_view(pid, "refs", x["label"])
            Rm = GS.render_maps_from_xyz(GS.view_xyz_grid(rec), rec["eye"], rec["pose"])
            P = GS.photo_maps(g, rec["W"], rec["H"])
            if j == 0:
                ax[i, 1].imshow(P["logd"], cmap="viridis"); ax[i, 1].set_title("MoGe-2 L log-depth", loc="left")
            PL = np.where(P["sky"], GS.SKY_LOG, P["logd"]); RL = np.where(Rm["sky"], GS.SKY_LOG, Rm["logd"])
            Ep, _ = GS._edges(PL, GS.CFG["edge_tau_p"], False, P["sky"]); Er, _ = GS._edges(RL, GS.CFG["edge_tau_r"], False, Rm["sky"])
            ov = np.ones(Ep.shape + (3,))
            ov[Ep] = (0.55, 0.55, 0.55)
            ov[Er] = matplotlib.colors.to_rgb(BLUE if x["verdict"] == "correct" else ORANGE)
            ax[i, 2 + j].imshow(ov)
            row = next(r for r in R[pid]["refs"] if r["label"] == x["label"]) if pid in R else None
            z = get(row, "moge_l", "combo", True) if row else None
            ax[i, 2 + j].set_title(f"{x['verdict']} ref {x['label']} (colour=render, grey=photo edges)"
                                   + (f"\ncombo z={z:.1f}" if z is not None else ""), loc="left", fontsize=7)
        for a in ax[i]:
            a.set_xticks([]); a.set_yticks([])
    plt.tight_layout(); plt.savefig(OUT / "example.png", dpi=70); plt.close()


def fig_perturb(model="moge_l", keys=("rank_all", "ord_local", "edge_all", "edge_int", "normal_cos")):
    fig, ax = plt.subplots(1, 2, figsize=(9, 3), sharey=True)
    for ai, (axis, offs) in enumerate((("yaw", [-8, -4, -2, -1, 0, 1, 2, 4, 8]), ("pitch", [-2, -1, 0, 1, 2]))):
        for ki, k in enumerate(keys):
            curves = []
            for r in R.values():
                base = next((x for x in r["refs"] if x["verdict"] == "correct"), None)
                if not r["perturb"] or base is None or not base.get("null"):
                    continue
                from analyze import nullstats
                ns = nullstats(base["null"], model, k)
                s0 = get(base, model, k)
                if ns is None or s0 is None:
                    continue
                d = {p["offset"]: get(p, model, k) for p in r["perturb"] if p["axis"] == axis}
                d[0] = s0
                if all(d.get(o) is not None for o in offs):
                    curves.append([(d[o] - s0) / ns[1] for o in offs])
            if curves:
                c = np.median(np.array(curves), 0)
                ax[ai].plot(offs, c, marker="o", ms=3, lw=1.5, label=f"{k} (n={len(curves)})",
                            color=["#2a78d6", "#eb6834", "#1baf7a", "#4a3aa7", "#e87ba4"][ki])
        ax[ai].axvline(0, color=GRAY, lw=0.5); ax[ai].set_xlabel(f"{axis} offset from verified pose (deg)")
    ax[0].set_ylabel("median score change, in null-σ units")
    ax[1].legend(frameon=False, fontsize=7)
    fig.suptitle(f"{model}: score vs perturbation (0 = verified-correct ref)", x=0.01, ha="left")
    plt.tight_layout(); plt.savefig(OUT / "perturb.png", dpi=80); plt.close()


def fig_scans(pids, keys=("edge_all", "rank_all", "edge_int"), model="moge_l"):
    pids = [p for p in pids if p in R and R[p]["scans"]]
    fig, ax = plt.subplots(len(pids), 1, figsize=(8, 1.4 * len(pids)), sharex=True)
    ax = np.atleast_1d(ax)
    for i, pid in enumerate(pids):
        sc = R[pid]["scans"][0]
        ys = np.array(sc["yaws"])
        for ki, k in enumerate(keys):
            v = np.array([row[model].get(k, np.nan) if row[model].get(k) is not None else np.nan for row in sc["scores"]], float)
            v = (v - np.nanmedian(v)) / (np.nanstd(v) + 1e-9)
            ax[i].plot(ys, v, lw=1, color=[BLUE, "#1baf7a", "#4a3aa7"][ki], label=k)
        for x in R[pid]["refs"]:
            ax[i].axvline(x["pose"]["yaw"] % 360, color=BLUE if x["verdict"] == "correct" else ORANGE, lw=1, ls="--")
        ax[i].set_title(f"{pid}  scan at {sc['verdict']} ref {sc['label']} pitch/roll/vfov (dashed: blue correct, orange wrong refs)",
                        loc="left", fontsize=7)
    ax[0].legend(frameon=False, fontsize=7, ncol=3)
    ax[-1].set_xlabel("yaw (deg)")
    plt.tight_layout(); plt.savefig(OUT / "scans.png", dpi=75); plt.close()


def fig_refs(model="moge_l", key="combo"):
    fig, ax = plt.subplots(figsize=(7, 2.6))
    cs, ws, lab = [], [], []
    for pid, r in R.items():
        for x in r["refs"]:
            z = get(x, model, key, True)
            if z is None:
                continue
            (cs if x["verdict"] == "correct" else ws).append(z)
            if x["verdict"] == "wrong" and pid in ("wc_0001", "wc_0069", "wc_0070", "wc_0074"):
                lab.append((z, f"{pid[3:]}{x['label']}"))
    ax.scatter(cs, np.full(len(cs), 1) + np.random.default_rng(0).uniform(-0.15, 0.15, len(cs)), s=12, color=BLUE, label="correct refs")
    ax.scatter(ws, np.full(len(ws), 0) + np.random.default_rng(1).uniform(-0.15, 0.15, len(ws)), s=12, color=ORANGE, label="wrong refs")
    for z, t in lab:
        ax.annotate(t, (z, 0), xytext=(0, -14), textcoords="offset points", fontsize=6, color=INK, ha="center")
    ax.set_yticks([0, 1]); ax.set_yticklabels(["wrong", "correct"]); ax.set_xlabel(f"{model} {key} (null-z)")
    ax.legend(frameon=False, fontsize=7, loc="upper left")
    plt.tight_layout(); plt.savefig(OUT / f"refs_{key}.png", dpi=80); plt.close()


if __name__ == "__main__":
    fig_refs(key="combo"); fig_refs(key="combo_int")
    fig_perturb()
    fig_scans(["wc_0004", "wc_0009", "wc_0020", "wc_0047", "wc_0063", "wc_0088"])
    fig_example(["wc_0004", "wc_0069", "wc_0074"])
