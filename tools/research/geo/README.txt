GEO: geometry-first camera pose (plan: reports/geometry-first-pose.md; phase A = GA0-GA5). Started 2026-09-30.
Python reference + research tooling for the TS package src/lib/geocam/**.

HARD RULES (every agent) - inherits tools/research/fund/README.txt and tools/research/tm/README.md:
- DEV ONLY. Wild set: the 50 dev ids (tools/matcher/v2/refs.py dev_ids / correct_refs; tm_common.assert_dev).
  GT set: dev = IMG_5495 6971 7018 7033 7053 7059 7063 7068 7131 7155; HOLDOUT 6019 6958 7086 7130 are REFUSED
  (tools/concord/pins/PROTOCOL.txt). geo_common.assert_dev() enforces both. Never open test ids, tools/bench/data_v3,
  or the H1 blind-pack overlays (tools/research/tm/h1_mine/pack/**).
- Write only in the files you own. Agent C owns everything here except other agents' REPORT_GA*.txt and their
  appended sections of PROTOCOL.txt, plus out/geocam/python/** and out/geocam/decoys/**.
- Never call live services (:8765 :8766 :8767 :8768 :3000 :3100). No renders unless unavoidable; then a private
  port 8790-8799 while holding geo_common.render_lock() (= tm_common.render_lock()).
- Python: tools/matcher/.venv/bin/python (3.12) with PYTHONPATH=tools/research/geo/.pylib (pycolmap 4.2.1,
  gtsam 4.3.0, pygeomag 1.1.0; installed with pip --target, --no-deps; numpy/scipy/poselib come from the venv).
  Never pip install into tools/matcher/.venv. Keep this dir < 2 GB (df -h first).
- Kill criteria in reports/geometry-first-pose.md s5 are FIXED (copied into PROTOCOL.txt). Before scoring any real-data
  eval, append your exact rule to PROTOCOL.txt (timestamped, UTC). Label post-hoc findings.
- Output: REPORT_<name>.txt (plain text, honest) + machine-readable json under out/geocam/.

LAYOUT
  geo_common.py        dev-id guards, locks, paths, E1 hypothesis loader, pose/ENU helpers
  pnp_prior.py         "afternoon test": PnP variants + covariance on E1/H1/E3 correspondences -> REPORT_PNP.txt,
                       out/geocam/python/pnp_prior.json
  gtsam_ref.py         GTSAM reference MAP solver (mirrors src/lib/geocam/map factors) + parity. `make` writes
                       fixtures (format "geocam-map-fixture/1", documented in its header) to
                       out/geocam/python/fixtures/; `parity` compares with the TS results -> REPORT_GTSAM.txt,
                       out/geocam/python/gtsam_parity.json (also reads out/geocam/fixtures/*.json in that format)
  ts_fixture_solve.ts  runs src/lib/geocam/map solveMap on fixtures -> <name>.ts.json (npx tsx ...)
  decl_ref.py          WMM2025 declination reference table -> out/geocam/python/decl_ref.json
  export_decoys.py     E1 hypotheses -> out/geocam/decoys/<pid>.json (format below)

DECOY EXPORT FORMAT (out/geocam/decoys/<pid>.json; written by export_decoys.py; read by GA2/GA5 TS evals)
  {
    "format": "geocam-decoys/1", "pid": "wc_0002", "source": "tools/research/fund/e1_acontrario",
    "stated": {"lat", "lon", "h"},                 // stated (GPS/manual) eye; ENU frame origin = (lat, lon, 0)
    "W": 1024, "H": 769,                           // pixel frame of every uv below (render size, photo aspect)
    "vfov0": deg, "focalKnown": bool, "f0Px": px,  // EXIF/table prior focal at this W x H
    "refs": [{"pose": {yaw,pitch,roll,vfov}, "eyeEnu": [e,n,u], "from"}],   // verified-correct poses (truth)
    "hyps": [{
      "id": "wc_0002_dispd150b153", "kind": "POOL|REF|RING|YAW|DISP",
      "label": "POS|NB-inh|NB-con|NB-dec|NE-inh|NE-dec|AMB|UNL",
      "eye": {"lat","lon","h"}, "eyeEnu": [e,n,u],   // hypothesis eye in the STATED-eye ENU frame (m)
      "eyeOffsetM": [de,dn,du],                      // eyeEnu - stated eye (== eyeEnu - [0,0,stated.h])
      "dispDistM": 150|400|50|null, "pose": {"yaw","pitch","roll","vfov"},
      "nCorr": int, "nKept": int,                    // all lifted matches / exported after thinning
      "uv": [[u,v],...],                             // photo px at W x H, 0 = image edge (pixel centre = i+0.5)
      "xyz": [[e,n,u],...],                          // world points in the STATED-eye ENU frame (m)
      "dist": [m,...],                               // |xyz - eyeEnu|
      "e1": {"log10NFA", "T", "Tfit", "accept": {...}, "misfitMedPx"}   // E1 scores (diagnostic)
    }]
  }
  ENU: x east, y north, z up (m); heights = the renderer's DEM heights (as eye.h). Frames of the E1 npz files are
  centred on each hypothesis eye's lat/lon; the export shifts them into the stated-eye frame by the local
  equirectangular offset (same formula as e1lib.enu_offset; error << 1 m at <= 400 m).
  Pose convention: yaw deg clockwise from north, pitch deg up, roll deg; OpenCV camera R = common.pose_to_R(pose);
  f(px) = (H/2)/tan(vfov/2); principal point (W/2, H/2).
  Thinning: 16 x 12 image grid, <= 400 points, round-robin over cells in original order (deterministic).
