"""POST HOC (see PROTOCOL.txt AMENDMENTS): G50h = 50 m horizontal displacement, height kept (z = max(T.z, DTM+1.6)).
Writes out_posthoc/<pid>.json."""
from __future__ import annotations
import json, sys
from e3_run import *  # noqa: F401,F403

OUTP = HERE / "out_posthoc"


def run_ph(pid):
    m = C.load_meta(pid)
    v = C.load_view(pid, "refs", m["perturbBase"])
    K, W, H, pose = v["intrinsics"], v["W"], v["H"], v["pose"]
    T = np.array(v["eye"], float)
    R0 = NR.pose_to_R(pose)
    frame = G.EnuFrame(m["lat"], m["lon"], 0)
    wedge = (pose["yaw"], K["hfov"] / 2 + 25)
    grids = D.build_grids(frame, 0, 0, T[2], wedge, cache=D.DATA / pid / "grid.npz")
    ortho = D.Ortho(frame, 0, 0, T[2], wedge, D.DATA / pid / "tiles")
    Gd, az = disp_eye(pid, 50, T, grids)
    Gd[2] = max(T[2], NR.dtm_height(grids, Gd[0], Gd[1]) + 1.6)
    photo = np.array(Image.open(C.CACHE / pid / "photo.jpg").convert("RGB").resize((W, H), Image.LANCZOS))
    fp = feats(photo)
    far_full = NR.upsample_xyz(v["xyz"], 2, W, H)
    far = NR.warp_view(v["rgb"], far_full, Gd, pose, K, W, H, min_depth_new=1500.0)
    zfun = lambda x, y: NR.dtm_height(grids, x, y) + 1.7  # noqa: E731
    out = {"pid": pid, "T": T.tolist()}
    for var, kw in (("V1", dict(surface="dtm")), ("V2", dict(surface="dsm"))):
        r = NR.render_near(grids, ortho, Gd, pose, K, W, H, **kw)
        cp = NR.composite(r, far["rgb"], far["xyz"])
        eyeR = r["eye"]
        k0, k1 = match(fp, feats(cp["rgb"]))
        X, ok = lift(k1, cp["xyz"], eyeR)
        x2d, X = k0[ok] + 0.5, X[ok]
        dep = np.linalg.norm(X - eyeR, axis=1)
        bb = bands(dep)
        rec = {"G": eyeR.tolist(), "azDeg": az, "eGps3d": float(np.linalg.norm(eyeR - T)), "lifted": int(len(X)),
               **{f"lift_{k}": int(s.sum()) for k, s in bb.items()}}
        for dof, zf in (("3dof", None), ("2dof", zfun)):
            E, info = eye_solve(x2d, X, dep, eyeR, R0, K, zf)
            rec[dof] = {"E": E.tolist(), "err3d": float(np.linalg.norm(E - T)), "errH": float(np.hypot(*(E - T)[:2])),
                        "info": info, "better": bool(np.linalg.norm(E - T) < np.linalg.norm(eyeR - T))}
        out[f"G50h_{var}"] = rec
    OUTP.mkdir(exist_ok=True)
    (OUTP / f"{pid}.json").write_text(json.dumps(out, indent=1, default=float))
    return out


if __name__ == "__main__":
    torch.set_num_threads(4)
    for pid in sys.argv[1:]:
        if (OUTP / f"{pid}.json").exists() or not (OUT / f"{pid}.json").exists():
            continue
        try:
            o = run_ph(pid)
            b = o["G50h_V2"]
            print(pid, "G50h V2", round(b["eGps3d"], 1), "->", round(b["3dof"]["err3d"], 1), b["3dof"]["info"].get("fail", ""), flush=True)
        except Exception:
            print(pid, "FAILED", flush=True)
            traceback.print_exc()
