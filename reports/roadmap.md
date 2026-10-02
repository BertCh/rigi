# Rigi roadmap

*2026-10-02. Open work only. State is in [status.md](status.md), dead ends in [negative-results.md](negative-results.md), what landed in `CHANGELOG.md`. Topic plans own their detail: GPU/renderer [gpu-renderer.md](gpu-renderer.md), Gipfelbuch [gipfelbuch.md](gipfelbuch.md), cartography [swiss-cartography-review.md](swiss-cartography-review.md), concordance [concordance-research.md](concordance-research.md). Code comments citing retired row ids (WAG-*, LF1–LF8, U1–U4, FUND/GEO tables) refer to `git show bab0f28:reports/roadmap.md`.*

## Position

- **The wedge.** Nobody ships automatic registration of existing photos against terrain (PeakVisor still aligns by hand). The lead is timing, not a moat.
- **The asset is geometric truth:** a verified camera pose plus the real DEM. Learned and generative models sit on top of it and never replace it.
- **Sales order:** B2B (railways, tourism boards, newsrooms, science), then a share-link web beta, then a pose API.

## Rules for every item

1. Accuracy claims are pre-registered and measured on sealed data; dev numbers are never quoted as results.
2. Precision beats recall: a HIGH must be right; everything uncertain is a suggestion the user confirms.
3. Generated or warped pixels are display-only: never in the pose, confidence, benchmarks, measurements or exports.
4. WebGPU is primary; WebGL2 deck is the fallback and test path (no perf work on it). Opt-in looks are off by default and ship as GLSL + WGSL twins.
5. Commercial-licence models only in the product path; research licences stay behind dev flags.
6. GPU first: prefer the luma graph path and make working GPU paths the default unless quality or performance regress. CPU twins stay the reference.
7. Upstream-facing work stays local: no visgl PRs or issues unless the user says so; changes live here and in the vendored rigi builds.
8. Browser/GPU checks run in batched passes; per change only the fast tier (AGENTS.md "Testing policy").

## Now: unblock launch

| # | Item | Done when | State |
|---|---|---|---|
| N1 | **Regression gate** `scripts/ci/run.mjs` + GitHub CI | Every commit | Built. Open: deck style-baseline capture (the check SKIPs since the Landeskarte default) |
| N2 | **Licences** ([licences.md](licences.md)): Esri imagery outside CH, Overpass self-hosting, Mapterhorn PMTiles attribution and production traffic, model licences | No public URL before this | Register done; owner decisions open |
| N3 | **Evaluation data**: one ~100-photo set with trip sequences, sealed by sha1 before `data_v3` is opened (~300 photos for a ≥ 0.95 accept bound) | Sealed | Not started |
| N4 | **Basin-gap calibration**: v034's 0.20 gap was tuned on verdicts that later flipped and sits inside run-to-run noise | Re-derived in the R2 prereg | Open |
| N5 | **Re-annotate GT on Mapterhorn** (fitted on Terrarium, up to 81 m low at Niederhorn), then switch eval defaults | GT refit | Not started |
| N7 | **Code-review backlog** ([code-review-2026-09-30.md](code-review-2026-09-30.md)): CR-13, 41, 46, 67, W2 | Each fix moves its row to Closed with the commit | 5 open |
| N8 | **Batch browser pass** over every [batch-ledger.md](batch-ledger.md) row: renderer and GPU waves (rigi.5/6, gpgpu, nn runtime), in-browser matcher / Step Inside / propagation, roll map WebGPU, Landeskarte default (keep or revert 9b2a6e8), Gipfelbuch | Each row marked keep / revert / doc-only | Unowned |

## Next: registration trust and recall (0–3 months)

About 20% of wild photos auto-accept with held-out HIGH precision 1.00; recall is the bottleneck.

| # | Item | Gate | State |
|---|---|---|---|
| R1 | **H1 blind verification** of the hard-negative pack (120 overlays, 27 photos) | Protocol in `tools/research/tm/h1_mine/` | Ready |
| R2 | **H2 veto prereg**: MoGe-2 depth, PnP shift, 3-strip agreement, XoFTR-depth; GA5 integrity as a candidate. Needs ≥ 30 hard negatives and must pass E1's displaced-eye decoys | Written threshold rule | Waits on R1 |
| R3 | **Recall levers under the frozen veto**: LoMa-sat with its own rule, ALIKED+dehaze, X1 top-2 generator | Dev, then v3 prereg | Waits on R2 |
| R4 | **Top-3 picker / tap-a-peak** (top-4 hit 27/30 vs ~20/50 safe HIGH); corrections logged; solution-separation alert as a suggestion | Default-on after the owner tries it | Built behind `?picker=on` |
| R5 | **Pose propagation**: accepted photos anchor overlapping neighbours as suggestions (0/83 wrong pairs pass); runs in the browser | Sign-off on `tools/nearfield/propagate/PREREG_DRAFT.txt`; held-out roll set from N3 | Wired into `/roll` |
| R6 | **v3 prereg** ([v3-prereg.md](v3-prereg.md)): fold in R2/R3, `STAGE1_MANIFEST` and code stamps, decide whether arms run the browser matcher port, `V2_SUGGEST_ONLY` dry run of the arms | Owner sign-off | Draft |
| R7 | Measure the target input (iPhone with GPS, heading, gravity) at scale, incl. the 14 non-Swiss `data_v3` photos | Part of N3 | Not started |
| R8 | **E5 ray-cast oracle adoption** (passed on dev: horizon parity p95 0.19 px, 18.7 ms per 1024×768 frame; `src/lib/raycast`, not wired): matcher geometry without a render, ortho colour output, quiet-machine timing. GEO GB/GC stay gated on phase A ([geometry-first-pose.md](geometry-first-pose.md)) | Owner decision | Built, not wired |

## Next: product follow-ups (from the 10-02 step reviews, checked open in code)

Evidence: [archive/steps-2026-10-02/](archive/steps-2026-10-02/README.md).

| # | Item | State |
|---|---|---|
| P1 | **Decisions:** `geoDecl` default (off); eye height without GPS altitude 1.6 vs 1.8 m (`geo/eye-rule.ts`); roll compass bias window 45 min → ~60 s; `?firstOverlay=prior`; `?horizonRange=auto`; peak-name locale and catalogue radius; whether "verified" includes pitch | Owner |
| P2 | **Honest outputs:** visible mark on unverified exports; a pin solve that fails the name check is still saved as "pinned" (`PhotoWorkspace.tsx`); one "accepted" predicate (`workspaceIsTrustedAuto` unused); `positionSource` fails open | Open |
| P3 | **Robustness:** 360° seam in solve confidence (no `circularYaw`); `dem/load.ts` lacks `Retry-After` backoff and never clears its missing-tile set; `loadScene` ground throws outside Mapterhorn z13–17 | Open |
| P4 | **Features:** workspace pin tool; open-pose-file import and GeoPose export; roll map "draping N of M"; compass-less roll photos not drawn facing north; peak ranking without the prominence tag | Open |
| P5 | **Defaults waiting on the batch pass:** `pinSolve=seeded`, `peakSnapInterior` | Browser batch |
| P6 | **Python-service leftovers** (dropped, not ported, 8bb109d0): DA3 multiview and MoGe ViT-L/B (`model` option ignored); propagation `ess` / `da3` options; on-disk depth cache (now in-memory only); nearfield client `timeoutMs` unread, `signal` unchecked during inference, errors collapse to `null` | Open |
| P7 | `PhotoWorkspace.tsx` split (2,334 lines) | Open |

## Next: whole-image concordance and the near field (0–4 months, parallel)

The skyline can't see eye-position error; interior error grows as 1/distance.

| # | Item | State |
|---|---|---|
| C1 | **Interior pins** (`scripts/concord/eval.ts`, split 10 dev / 4 holdout) | Built; waits on the owner clicking pins (`tools/concord/pins/PROTOCOL.txt`) |
| C2 | Focal table under `?concord=eye` (holdout 1.99% → 0.32%, n = 2) | Applied in `getPhoto` and `cameraFromMeta`; bundled photos need a re-ingest to carry `model`/`lensModel`. Claims wait on C1 |
| C3 | Interior cues + a joint solve gated on **held-out pins** (old code in `a1845f5`) | Waits on C1 |
| C4 | **Near-field signal** (swissSURFACE3D − swissALTI3D) for occluders, matcher failures and the Step Inside split | `?concord=occl`; label/drape hooks landed, unconsumed; consumer wiring next |
| S1 | **Step Inside v1.1**: semantic + depth split (target ≥ 80% smear removal, now 15%), cliff-lip anchoring, anchor parity | Blocked on a permissive segmenter ([shortlist](../research_notes/segmenter-shortlist-2026-10-02/NOTE.md)); `?anchorCliff=on` built, browser-unverified |
| S2 | **Completion P0** (`?nearfield=complete`): slab diagnosis, edge snap, people volumes, behind-layer inpainting | Built except inpainting (no LaMa in the browser yet; `rfft2` on `GPUFFT2D` is groundwork); waits on the provenance decision |
| S3 | **3D Tiles** T2: tiles + nDSM into S1's object class; Google logo before any public URL | T0/T1 built; T2 behind `?tiles3dObjects=on` (thresholds uncalibrated); Google off in non-dev builds |
| S4 | Step Inside end to end on WebGPU in a browser (luma splat stack, photo sky, 3D tiles) | Browser batch |

## Next: live camera

| # | Item | State |
|---|---|---|
| RT1 | `/live` with the skyline pose tracker (`src/lib/track`); output is a suggestion until a gate passes | Built, browser-unverified. Plan RT-0..3: [realtime-investigation-2026-10-02.md](realtime-investigation-2026-10-02.md) |
| RT2 | Tracker gate: metrics, thresholds, clip set | Draft [tracker-gate-draft.md](tracker-gate-draft.md); owner sign-off |
| RT3 | Step Inside depth ~2 → ~10 fps (nn persistent forwards landed f7823db8) | Open |

## Next: GPU and rendering

All open items, decisions P1–P4 and evidence: [gpu-renderer.md](gpu-renderer.md). Headlines:

| # | Item | State |
|---|---|---|
| G1 | Roll map WebGPU parity check (`roll-map-parity`, none exists) | Open |
| G2 | `skylineGpu` on since f720c646; `?focalSeedGate` A/B on the wild dev split | Browser batch, then A/B |
| G3 | `renderBundles` default only if the batch measures a CPU gain | Opt-in |
| G4 | Imagery atlas overflow eviction; blank first silhouette (confirm workaround) | Open |
| G5 | Re-run the deck #10753 / #10776 audit now that stock deck layers draw on WebGPU (roll extras) | Open |
| G6 | Animated looks (water, wind) watched live and tuned beyond one photo | Batch item |
| G7 | Upstream watch before any vendor bump (`node scripts/upstream/luma-watch.mjs`) | Tooling built; no trigger fired 10-02 |

## Later: beta, pilots, service (3–18 months)

| # | Item | Depends on |
|---|---|---|
| L1 | Share-link web beta (watermark + link, iOS location coaching; Step Inside opt-in). Spec: [share-beta-design-2026-10-02.md](share-beta-design-2026-10-02.md) | N1, N2, R4; S1 |
| L2 | Pilots: railway/tourism board, newsroom/OSINT, science pose-initialiser | L1 |
| L3 | iOS rendering path | Before L1 reaches iOS |
| L4 | Batch registration service (the browser matcher run headless, queued) for API and archive customers | N2 imagery licence |
| L5 | Pose API + embeddable viewer; GCP / no-GPS mode | L2 demand |
| L6 | Webcam/archive registration; global coverage with per-region accuracy | L4 |
| L7 | Completion P1 (SAM 3D Objects, TripoSplat; people beyond volumes) | S2; gated downloads |
| L8 | GEN3C geometry-fidelity test (one rented-GPU run; the old adapter was removed in dd05828f) | Funding decision |
| L9 | Native/AR app | Pilot demand |

## Parked

- Multi-photo fusion as a product goal; hosting any world model (LingBot-World v2 is non-commercial).
- VGGT beyond filing for the commercial checkpoint; DEM-prompted depth until its range instability is solved.
- The display warp field unless interior pins show a gain.
- T6 as the default policy; T5 position refinement (opt-in only).
- A world model as a synthetic-negative engine (one bounded study at most).
- Retiring the WebGL deck layers, until Safari/Firefox ship WebGPU with `float32-filterable`.
