# Rigi roadmap

*2026-10-02. Open work only; current state is in [status.md](status.md), dead ends are in [negative-results.md](negative-results.md), and what landed is in `CHANGELOG.md`. Code comments citing retired row ids (WAG-*, LF1–LF8, U1–U4, FUND/GEO tables) refer to the 2026-10-01 version: `git show bab0f28:reports/roadmap.md`.*

## Position

- **The wedge.** Nobody ships automatic registration of existing photos against terrain (PeakVisor still aligns by hand). The lead is timing, not a moat.
- **The asset is geometric truth:** a verified camera pose plus the real DEM. Learned and generative models sit on top of it and never replace it.
- **Sales order:** B2B (railways, tourism boards, newsrooms, science), then a share-link web beta, then a pose API.

## Rules for every item

1. Accuracy claims are pre-registered and measured on sealed data; dev numbers are never quoted as results.
2. Precision beats recall: a HIGH must be right, everything uncertain is a suggestion the user confirms.
3. Generated or warped pixels are display-only: never in the pose, confidence, benchmarks, measurements or exports.
4. Both engines (WebGPU deck default, WebGL2 deck fallback) stay at parity; opt-in looks are off by default and ship as GLSL + WGSL twins.
5. Commercial-licence models only in the product path; research licences stay behind dev flags.
6. GPU first: prefer the luma graph path and make working GPU paths the default unless quality or performance regress (user, 2026-10-01). WebGPU only for the graph; CPU twins stay the reference.
7. Everything upstream-facing stays local: no visgl PRs or issues; changes live here and in the vendored rigi builds (user, 2026-10-01).
8. Browser/GPU checks run in batched passes; per change only the fast tier (AGENTS.md "Testing policy"; cook mode in [batch-ledger.md](batch-ledger.md)).

## Now: unblock launch

| # | Item | Done when | State |
|---|---|---|---|
| N1 | **Regression gate** `scripts/ci/run.mjs` + GitHub CI | Every commit | Built; fast tier includes Vitest. Open: deck style-baseline capture (the check SKIPs; the default look changed with Landeskarte) |
| N2 | **Licences** ([licences.md](licences.md)): Esri imagery outside CH, Overpass self-hosting, Mapterhorn PMTiles attribution, model licences | No public URL before this | Register and opt-in swaps done; owner decisions open |
| N3 | **Evaluation data**: one ~100-photo set with trip sequences, sealed by sha1 before `data_v3` is opened | Sealed | Not started |
| N4 | **Basin-gap calibration**: v034's 0.20 gap was tuned on verdicts that later flipped and sits inside run-to-run noise | Re-derived in the R2 prereg | Open |
| N5 | **Re-annotate GT on Mapterhorn** (fitted on Terrarium, up to 81 m low at Niederhorn), then switch eval and `/baseline` defaults | GT refit | Not started |
| N7 | **Code-review backlog** ([code-review-2026-09-30.md](code-review-2026-09-30.md)) | Each fix sets its row to `fixed <commit>` | See the backlog's summary line; remaining rows mostly need a browser/GPU or a user decision |
| N8 | **Batch browser pass** over wave 5 and later ledger rows: Landeskarte default (keep or revert 9b2a6e8), WebGL2 Imhof/hatch twins compiled, `mosaicGpu`, chrome/fonts, Gipfelbuch | Each [batch-ledger.md](batch-ledger.md) row marked keep / revert / doc-only | Unowned |

## Next: registration trust and recall (0–3 months)

About 20% of wild photos auto-accept with held-out HIGH precision 1.00; recall is the bottleneck.

| # | Item | Gate | State |
|---|---|---|---|
| R1 | **H1 blind verification** of the hard-negative pack (120 overlays, 27 photos) | Protocol in `tools/research/tm/h1_mine/` | Ready |
| R2 | **H2 veto prereg**: MoGe-2 depth, PnP shift, 3-strip agreement, XoFTR-depth; GA5 integrity as a candidate. Needs ≥ 30 hard negatives and must pass E1's displaced-eye decoys | Written threshold rule | Waits on R1 |
| R3 | **Recall levers under the frozen veto**: LoMa-sat with its own rule, ALIKED+dehaze, X1 top-2 generator | Dev, then v3 prereg | Waits on R2 |
| R4 | **Top-3 picker / tap-a-peak** (top-4 hit 27/30 vs ~20/50 safe HIGH); corrections logged | Default-on after the owner tries it | Built behind `?picker=on` |
| R5 | **Pose propagation**: accepted photos anchor overlapping neighbours as suggestions (0/83 wrong pairs pass). DEM render check inconclusive | Sign-off on `tools/nearfield/propagate/PREREG_DRAFT.txt`; held-out roll set from N3 | Library built and wired into `/roll` |
| R6 | **v3 prereg** ([v3-prereg.md](v3-prereg.md)): fold in R2/R3, add `STAGE1_MANIFEST` and code stamps, smoke the re-based stage-1 workers, `V2_SUGGEST_ONLY` dry run | Owner sign-off | Draft |
| R7 | Measure the target input (iPhone with GPS, heading, gravity) at scale, incl. the 14 non-Swiss `data_v3` photos | Part of N3 | Not started |
| R8 | **Research phase 1** (dev only), ran 2026-10-02: **E5 ray-cast oracle PASS** on dev (`src/lib/raycast`, not wired; horizon parity p95 0.19 px, 18.7 ms per 1024×768 frame); **E4 step 1 KILLED** (flat DINOv2 token cost); E0r and the skyline-parallax eye test KILLED ([negative-results.md](negative-results.md)). GEO GB/GC gated on phase A ([geometry-first-pose.md](geometry-first-pose.md)) | E5 adoption (matcher geometry off headless Chromium, ortho colour output, quiet-machine timing batch) | Owner decision |

## Next: whole-image concordance and the near field (0–4 months, parallel)

The skyline can't see eye-position error; interior error grows as 1/distance. Plan: [concordance-research.md](concordance-research.md).

| # | Item | State |
|---|---|---|
| C1 | **Interior pins** (`scripts/concord/eval.ts`, split 10 dev / 4 holdout) | Built; waits on the owner clicking pins (`tools/concord/pins/PROTOCOL.txt`) |
| C2 | Focal table behind `?concord=eye` (holdout 1.99% → 0.32%, n = 2) | Wired into the app prior (`getPhoto` vfov) and `cameraFromMeta` (011decd); bundled photos need a re-ingest to carry `model`/`lensModel`. Accuracy claims wait on C1 |
| C3 | Interior cues + a joint solve gated on **held-out pins** (the old gate scored on its own cues and made holdout worse; code in `a1845f5`) | Waits on C1 |
| C4 | **Near-field signal** (swissSURFACE3D − swissALTI3D) for occluders, matcher failures and the Step Inside split | Behind `?concord=occl`; label/drape hooks landed (unconsumed, `?concord=occl,labels,drape`); consumer wiring next |
| S1 | **Step Inside v1.1**: semantic + depth split (target ≥ 80% smear removal, now 15%), cliff-lip anchoring, WebGL2/WebGPU anchor parity | Blocked on a permissive segmenter (shortlist: `research_notes/segmenter-shortlist-2026-10-02/`). Cliff-lip anchoring behind `?anchorCliff=on` and anchor-parity helpers built 10-02, browser-unverified |
| S2 | **Completion P0** (`?nearfield=complete`): slab diagnosis, edge snap, behind-layer LaMa (`research_notes/completion_integration_2026-09.md`) | Slab diagnosis, edge snap, display-only guard built behind `?nearfield=complete` (10-02, browser-unverified); behind-layer LaMa waits on the provenance decision |
| S3 | **3D Tiles** T2: tiles + nDSM into S1's object class; Google logo before any public URL | T0/T1 built (`src/lib/tiles3d`); T2 nDSM object prior behind `?tiles3dObjects=on` (10-02, browser-unverified, thresholds uncalibrated); Google dropped from non-dev builds until the logo ships |

Follow-ups from removing the Python services (behaviour dropped, not ported):
- **LaMa inpaint** for the behind-layer completion: `nearfield/complete/index.ts` marks it NOT IMPLEMENTED (S2).
- **DA3 multiview** depth and the **MoGe ViT-L/B** sizes: the `model` option is accepted and ignored (only MoGe-2 ViT-S runs in the browser).
- **Propagate `ess` / `da3`** options of the propagation service: no browser port.
- **Depth cache**: the service kept a 1 GB on-disk cache; the browser keeps an in-memory `WeakMap<Blob>`, so nothing survives a reload.
- **Matcher busy handling**: the service's ETA / `Retry-After` answer is gone (busy now means another job on this page). The "timeout cut 120 s to 60 s" claim is unverified: the last HTTP client's default was already 60 s and no 120 s appears in its history.
- **Nearfield client hygiene** (P1.7): `timeoutMs` is declared but never read, `signal` is not checked during inference, and errors collapse to `console.warn` plus `null`.

## Next: GPU and rendering

| # | Item | State |
|---|---|---|
| G1 | **WAG-next** (was the WAG-next row). Landed 10-02 (session cd, browser-unverified): sky-worker graph release, no imagery re-upload between matcher views (a15eeca), near-first terrain on 256-layer devices + idle atlas compaction (e499995), lake floor on the GPU height gather, `GPUProgram` lowerings verified on Dawn (a921f82; no further stages qualify), page flags forwarded to workers (5bb8d0a). Open: precision gate on the dev split (both engines), P3 (`/roll` to WebGPU if WebGL becomes fallback-only), imagery overflow eviction, blank first silhouette draw (browser). Plan: [whole-app-graph-plan.md](whole-app-graph-plan.md) | Batch browser pass, then the open items |
| G2 | **skylineGpu** default: root cause of the IMG_6958 flip is `refinePose` on a wrong-focal seed, not the GPU maths | Off; fix the seed path, then re-run the unknown-pose A/B |
| G3 | **renderBundles**, **rg11b10** colour target | Wired, opt-in; judge in a batch pass |
| G4 | luma watch (was LF8) (`node scripts/upstream/luma-watch.mjs`): re-sweep on alpha.3, a moved vendored PR head or deck #10752 activity | Tooling built; 10-02 run: no trigger fired, no re-sweep ([note](../research_notes/gpu-pod-d-2026-10-02/luma-watch-2026-10-02.md)) |
| G5 | Animated looks (water, wind) watched live; waves fade by ~10 km | Still-frame only; 10-02 fade pinned in node (`look/__tests__/water-waves-fade.spec.ts`: full strength to ~1 km, under half by 10 km, flat past 29.8 km); live watch is a batch item |

## Later: beta, pilots, service (3–18 months)

| # | Item | Depends on |
|---|---|---|
| L1 | Share-link web beta (watermark + link, iOS location coaching; Step Inside opt-in) | N1, N2, R4; S1 |
| L2 | Pilots: railway/tourism board, newsroom/OSINT, science pose-initialiser | L1 |
| L3 | iOS rendering path | Before L1 reaches iOS |
| L4 | Hosted matcher as a queued service | N2 imagery licence |
| L5 | Pose API + embeddable viewer; GCP / no-GPS mode | L2 demand |
| L6 | Webcam/archive registration; global coverage with per-region accuracy | L4 |
| L7 | Completion P1 (people, SAM 3D Objects, TripoSplat) | S2; gated downloads |
| L8 | GEN3C geometry-fidelity test (one rented-GPU run; adapter in `src/lib/nearfield/generate/`) | Funding decision |
| L9 | Native/AR app | Pilot demand |

## Landed recently (details in `CHANGELOG.md`)

- **2026-10-01/02:** WebGPU deck default and three.js removed; vendored luma rigi.3 / deck rigi.1; whole-app graph waves 0–4 (graph is the only GPU path; nine GPU defaults kept after the waves 3–4 browser pass); upstream ports U1–U4 and luma frontier LF1–LF8 (Nebelmeer, trails, weather, water, wind, NPR kit, `GPUSort` splats); wave 5 Swiss signature (Imhof relief, Landeskarte hatch, swisstopo labels, self-hosted fonts, WGSL compile gate, CR-02/04/06); Gipfelbuch hand-drawn explainer; Landeskarte example; Vitest unit tests in the fast tier.
- **Killed or not applicable** (see negative results): FUND E0–E3, GEO GA2–GA5, concordance joint solve/warp/re-match, `GPUFFT1D` refine, virtual geometry LOD, paged splats (LF6).

## Parked

- Multi-photo fusion as a product goal; hosting any world model (LingBot-World v2 is non-commercial).
- VGGT beyond filing for the commercial checkpoint; DEM-prompted depth until its range instability is solved.
- The display warp field unless interior pins show a gain.
- T6 as the default policy; T5 position refinement (opt-in only).
- A world model as a synthetic-negative engine (one bounded study at most).
