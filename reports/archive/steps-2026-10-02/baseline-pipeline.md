# Step ④ baseline-pipeline (+ viewport-inference hub): review, research, plan

*2026-10-02, step lead mt-image-17 pod "baseline-pipeline". Gipfelbuch nodes `baseline-pipeline` ("Predict the skyline, find it, slide one onto the other") and `viewport-inference` ("The compass guesses. The ridge does not.") in `src/lib/gipfelbuch/graph.ts`. Dev evidence only; no sealed data opened, no numbers here are results.*

## 1. Scope and ownership

| Owned here (graph order: viewport-inference lists them first) | Read, proposals only |
|---|---|
| `src/lib/geo/{pipeline,solve,photo-meta}.ts`, `src/lib/geo/README.md`, `src/lib/refine/**` except `confidence.ts`, `src/baseline-ui/**` (the `/baseline` page and worker) | `src/lib/geo/{horizon,terrain}.ts` (dem-horizon / terrain-sampler), `src/lib/geo/skyline.ts` (skyline), `src/lib/refine/confidence.ts` and `src/lib/integration/second-opinion.ts` (accept-rule), `src/lib/align.ts` (tap-a-peak; U7 only added specs and an `export`), `src/lib/integration/unknown-pose*.ts` and `src/lib/picker/**` (pod B, G2/R4), `src/lib/gpu/**` (pod D), `src/components/PhotoWorkspace.tsx` (photo-workspace) |

## 2. Current state (as the code runs)

**Three entry points share one cascade** (`src/lib/geo/pipeline.ts:86-146`: `solvePose`, on reject `refinePose` from the prior; the first accepting stage answers, else the solve's pose; every stage listed as `candidates`):

1. **`/baseline`** (`src/baseline-ui/pipeline.worker.ts:206-240`): Terrarium tiles, horizon-fast horizon, `detectSkyline`, then the cascade. Since 9052a1e a prior with a missing compass / gravity / focal gets the unknown-pose options and the 0.75 bar (`src/baseline-ui/align-options.ts`).
2. **Unknown-pose** (uploads without full EXIF; `src/lib/integration/unknown-pose-core.ts:141-251`, worker): Mapterhorn 360° scene (GPU march by default), `detectSkylineAsync`, the cascade per focal seed (40/50/65° hfov when focal unknown), accept = `accepted && !ambiguous && !weak360` (0.75 bars, `:40`, `:47`, `:208-215`). Reject → match service (`matchAccepted`, `src/lib/matcher-client.ts:146`), else "unverified".
3. **App second opinion** (full EXIF, `src/lib/integration/second-opinion.ts`): the page first runs `autoAlign` (`src/lib/align.ts:748`, a different scorer: edge + sky/terrain contrast along the projected DEM skyline, ±25° grid + coordinate descent, `alignResult` confidence = margin·4 × score·2.5, `align.ts:728-746`), shows it at confidence > 0.2 (`choosePreview`, `second-opinion.ts:83`), then the cascade in a worker within 20 s decides verified / refined / kept / unverified / matched. GPU: `autoAlignAsync` (`src/lib/gpu/align/index.ts:402`) with `alignPrecision` = `certified-f32` by default (`src/lib/flags/index.ts:150`), falling back to the f64 GPU-bound refine, then plain CPU.

**solvePose** (`src/lib/geo/solve.ts:193-561`): coarse yaw × pitch grid (step max(0.1°, 1.5 px), truncated L1 at 12 px on the small-angle shift, Gaussian priors, `coarseCost` `:387`); local yaw minima → ≤ 3 seeds > 1.5° apart; ambiguity = 1 − (runner-up − best)/(median − best) with the runner-up > 2° away (`:420-448`); Cauchy LM (4 px) over yaw/pitch/roll/log f from each seed (`:489-506`); confidence = tilt gate (3°) × ramps on inliers, coverage, (1 − ambiguity), horizon relief (`:530-535`); bar 0.5 local (±25°), 0.75 full 360° (`FULL_SEARCH_CONFIDENCE`, `:274`). Its coarse grid has a GPU twin (`src/lib/gpu/solve/{index,cpu}.ts`) whose selection repeats the minima / seed / runner-up logic.

**refinePose** (`src/lib/refine/index.ts:125-302`): FFT circular correlation of elevation profiles (8192-bin grid, ±30° default, free pitch/roll nuisance, `init.ts:198-367`), top-5 modes + the prior → robust IRLS per mode (`robust.ts`) → pick by robust cost at a common scale → confidence = product of smoothstep ramps on PSR, mode ratio, σ (correlation-inflated covariance), inlier fraction, RMS slope, RMS px, accept at ≥ 0.5 with hard gates (`confidence.ts:70-79`, `:126-236`).

**Tests:** `src/lib/geo` 93.6% lines, `src/lib/refine` 98%; `pipeline.ts` was at 5% (no spec) before this pass. `src/lib/integration/unknown-pose-core.ts` 37% (pod B area).

## 3. Findings (ranked)

| # | Sev | Where | Finding | State |
|---|---|---|---|---|
| F1 | **P1** precision | `src/baseline-ui/pipeline.worker.ts:221-223`, `BaselinePage.tsx:74-98` | `/baseline` Auto-align on a photo without a compass ran the default cascade around a made-up north heading: a ±25° solve and a ±30° refine at the 0.5 bar. That is the recorded "app auto-align with no heading: 3/11 correct, 7 false accepts" regime (`reports/bench-ablation.md`). On a synthetic panorama it accepted two poses 140° off (truth 100°, 250°; confidence 0.68 / 0.67, both from refine). The README already told callers to pass `headingKnown: false`; the worker did not. | **Fixed 9052a1e** |
| F2 | P1 recall | `src/lib/geo/solve.ts:420-443` (and the twins `src/lib/gpu/solve/cpu.ts:71-99`, `index.ts:301-363`) | 360° search seam: the grid runs −180…+180, local minima are found without wrap and the runner-up test (`|dy − best| > 2`) is not circular. A true yaw within ~3° of prior + 180° shows up as a minimum at both ends, the "runner-up" is the same basin and ambiguity → ~0.9, so a confidence-1.0 match drops to 0.41 and is rejected (probe: prior 0°, truth 160°: accepted 1.00; prior −19.7° (truth 179.7° away): 0.41, rejected). Precision-safe, costs ~1.5% of no-heading photos (those facing near south when the placeholder prior is north). Fix: circular minima + wrap-aware distances when the grid spans 360°, identical in all three selections; behaviour change → opt-in flag, then the dev cascade harness. | Planned (U5) |
| F3 | P1 UX/precision | `src/components/PhotoWorkspace.tsx:1088-1099` (`runAlign` direct path) | The Auto-align button on a full-EXIF photo persists `autoAlign`'s pose at any confidence and marks it "auto"; on reload it is "Restored your saved alignment" and skips the second opinion. The load path shows it only above 0.2 and verifies it. Fix: run the re-run result through `choosePreview` and persist only state "auto" (or re-run the second opinion). | Proposed (needs the PhotoWorkspace owner; §6) |
| F4 | P1 precision | `src/lib/integration/second-opinion.ts:141-152` | When the cascade times out or fails ("timeout"/"kept"), a 0.2–0.5 autoAlign pose stays "auto" and exports unlock, although `shouldEscalate` would want 0.5. Fix: below 0.5 (or not "auto") the fail branch returns "unverified" (state only, never the pose). | Proposed to the accept-rule pod (U6, needs a product nod: changes what the user sees on slow networks) |
| F5 | P2 | `src/lib/integration/unknown-pose.worker.ts:83-92` | Any non-timeout tile failure becomes a hole (by design for 404/ocean), so a transient 5xx gives a holed 360° horizon cached for the worker's life. Fix: holes only for 404/204, otherwise retry / fail the scene. | Proposed to pod B |
| F6 | P2 | `src/lib/geo/pipeline.ts` | No spec for the cascade's escalation, the eye rule or the horizon-fast fallback (5% coverage). | **Fixed (U2, this pass)** |
| F7 | P3 robustness | `src/lib/geo/pipeline.ts:60-66` | `sceneHorizon` returned the march's value without `await` inside `try`: harmless while the march is synchronous, but an async march's rejection would bypass the classic fallback. | **Fixed (U2)** |
| F8 | P2 doc drift | `src/lib/gpu/align/index.ts:20-31`, `CertTiming` / `AlignGpuTiming` docs | Header says certified-f32 is "OPT-IN … the default stays f64"; the flag default is `certified-f32` since the WAG precision gate. | Proposed to pod D |
| F9 | P2 drift risk | `scripts/eval.ts:153-161`, `tools/bench/harness/cascade.ts:136-195`, `src/lib/geo/pipeline.ts:113-146` | Three copies of the escalation rule. Same semantics today (first accepting stage, else solve). The harness copy is the frozen-rule one; do not refactor it, pin the app copy instead. | Documented + pinned (U2) |
| F10 | P2 tests | `src/lib/align.ts:728-746` | `alignResult`'s margin/confidence arithmetic has no spec beyond a [0,1] range check; nothing covers `autoAlignAsync`'s fallback branches (grid failure, certified fallback, violation disable). | **Specs landed 84f825b** (alignResult arithmetic; no-device and grid-failure fallbacks equal CPU autoAlign). Not covered: certified-f32 fallback and the `violation` disable branch (need a fake pose-bound session) |
| F11 | P3 | `src/lib/refine/init.ts:218-345` | Same seam with `init.yawRange: 180` (unknown-pose, /baseline no-heading): shifts ±4096 are the same bin, modes' 1° separation and the PSR exclusion are not circular. Effect: a duplicate seed (refine dedups with `wrap180`) and a slightly deflated PSR at the seam. | Planned with U5 |
| F12 | P3 | `src/baseline-ui/BaselinePage.tsx:74-98` | The prior's fallback branch drops gravity (and focal) whenever any one sensor is missing, so a photo with gravity but no heading is solved from a level prior. Fix: build the prior from whatever is present (`cameraFromGravity` with heading 0). | Later (small) |
| F13 | P3 | `src/lib/deck/engine.ts:2373`, `src/lib/deck-webgpu/engine.ts:3396` | Both engines re-implement `alignResult` after the silhouette re-rank (margin on `total`). | Proposed (engine owners) |
| F14 | P3 | `src/lib/integration/unknown-pose.ts` (`solve` abort) | Abort rejects the promise but the worker keeps solving; a re-run queues behind it. | Proposed to pod B |

Checked and clean: photo-change races on the load path (`engineRef.current !== engine` after every await), yaw wrap in `unknown-pose-core.ts:208-227`, NaN confidence → level "unknown", certified-f32 fallbacks are logged, worker teardown in `finally`.

## 4. Research summary

**Our record** (do not redo): killed or not adopted for this step: `?pipeline=` cascade/skyfirst/wide variants and agreement gates (`reports/pipeline-ab.md`, `reports/leaderboard.md`); raising the app bar; ONNX sky + solve (false accept IMG_7053); Terrarium for the cascade (14 vs 25 wild correct); the 360° margin rule (the wrong accept had the highest margin, `reports/bench-ablation.md`); VSWEEP vertical pass; X4 branch-and-bound (`tools/research/tm/x4_bnb/REPORT.md`); X1 learned yaw features; FUND E0–E3; GPU FFT for the refine correlation. Numbers to quote with their set: cascade on the 100-photo wild set (dev + spent test, Mapterhorn) 25 correct, at the 0.75 yaw-unknown gate 22/22; dev half alone 10/10 (`reports/bench-wild.md`); 12-photo GT 11/12, 0 false (`src/lib/geo/README.md`). Missing heading is the largest loss on the wild set (42 photos, ~38% solvable).

**External** (sources in `reports/Mountain photo georeferencing SoTA.md`, `research_notes/tm_literature_2026-09.md`, and):
- Baboud et al., CVPR 2011, direction-aware edge score over rotations (2.75% → 9.75% registered with learned silhouettes): our `align.ts` edge term is this family. <https://publications.graphics.tudelft.nl/papers/484>
- Baatz et al., ECCV 2012, contour words + verification; 49% of queries needed manual sky masks, the same dependency as our sky model. <https://people.inf.ethz.ch/pomarc/pubs/BaatzECCV12.pdf>
- Brejcha & Čadík, 3DV 2018, spherical FFT cross-correlation of semantic regions + edges; AUC 0.84 → 0.40 with automatic masks. A region (land-cover) cue beside the skyline is the one untried family. <https://cphoto.fit.vutbr.cz/semantic-orientation/>
- PeakLens (Fedorov et al., arXiv 1508.02959): edge-map heading estimation, same family as `align.ts`.
- CrossLocate (WACV 2022): depth renders best for retrieval (position, not orientation); our depth paths are killed (X2/X3). <https://cphoto.fit.vutbr.cz/crosslocate/>
- Fourier correlation filters with a peak-to-energy ratio (e.g. HorizonNet, arXiv 2608.30471): what refine's FFT + PSR already does.
- Slice / strip agreement (X4 here): 3 independent strips agreeing on yaw, AUROC 0.947–0.988 on 30 dev photos as an abstain signal; recommended, **not wired anywhere in `src/`**.

**Ideas, ranked by value / cost** (none changes the accept path without a flag and a dev gate):
1. 3-strip yaw agreement as a **diagnostic** on `SkylineSolveResult` (dev tooling first; a veto only through R2's prereg and the displaced-eye decoys). Cheap, no new data.
2. Fix the 360° seam (F2): pure bug, recall only.
3. Distance-transform (chamfer) coarse cost instead of truncated L1, judged on X4's half-step-shift flip count (dev, offline cache).
4. Region / land-cover cue (Brejcha) as dev research with a fixed kill bar on wrong-basin and displaced-eye decoys.
5. A circular-shift null z-score for solvePose's yaw peak, as input to the N4 basin-gap recalibration.

## 5. Plan

| Unit | What | Size / risk | Gate | When |
|---|---|---|---|---|
| U1 | `/baseline` no-sensor options + 0.75 bar (F1) | S / low (bit-identical with full EXIF) | spec with the two synthetic 140° false accepts; fast tier | **landed 9052a1e** |
| U2 | `pipeline.ts` specs (escalation with stubbed stages, eye rule, tile cache, horizon-fast fallback) + `return await` (F6, F7, F9 docs) | S / none | specs | this pass |
| U3 | This plan doc | – | – | this pass |
| U4 | `stripAgreement` diagnostic in `solve.ts` (idea 1): exported pure function, no change to accept/confidence, specs; printed by `scripts/baseline-solve-synth.ts` | M / none on behaviour | specs + `solvePose` result unchanged | **landed (this commit)**; next: record it in the dev cascade harness and measure AUROC on the wild dev half in the next batch pass |
| U5 | 360° seam fix (F2, F11) behind `SolveOptions.circularYaw` + a flag, in `solve.ts` and the two `gpu/solve` selections | M / medium (touches pod D's GPU twin) | bit-identical off; dev cascade harness on the wild dev half (`tools/bench/harness/cascade.ts`, Mapterhorn) and the synthetic `BIG_YAW=1 NO_HEADING=1 npm run baseline:synth` | next, coordinate with pod D |
| U6 | second-opinion fail branch → "unverified" below 0.5 (F4) | S / low | spec | needs a product nod |
| U7 | `alignResult` + `autoAlignAsync` fallback-branch specs (F10) | S / none | specs | **landed 84f825b** |
| U8 | Peer proposals: `parseAppleGravity` via `upload/exif.ts` `appleGravity` (photo pod F10); `loadScene` via `eye-rule.ts` `eyeAltitude` (eye-rule pod U3) | S / none on valid inputs | specs | **landed 3c8428a** |
| U8 | Chamfer coarse cost (idea 3), region cue (idea 4), z-score (idea 5) | research | dev only, prereg kill bars | later |

## 6. Proposals to other owners

- **PhotoWorkspace (F3):** in `runAlign`'s direct path use `choosePreview(res, eng.prior)`; `setPose(app.pose, app.state === "auto" && !eng.unknowns.any)`; state from `app.state`. Better: start the second opinion again, as on load.
- **Pod B (F5, F14):** tile holes only for 404/204; cancel message for an aborted solve. Once G2 lands, `options()` in `unknown-pose-core.ts` is now also used by `src/baseline-ui/align-options.ts`, so keep its signature.
- **Pod D (F8, and U5):** refresh the `gpu/align/index.ts` header ("default certified-f32 since …"); U5 needs the same circular selection in `gpu/solve/{cpu,index}.ts`.
- **Engine owners (F13):** reuse `align.ts` `alignResult` after the silhouette re-rank.

## 7. Gipfelbuch corrections (do not edit graph.ts; for the Gipfelbuch owner)

- `viewport-inference` summary: "…a confidence score gates the result, with a full-circle retry under a stricter bar. A rejected solve falls back to the sensors and to tapping peaks." The code escalates a rejected solve to refinePose first (`pipeline.ts` cascade) on `/baseline` and in unknown-pose, and the app page's first answer comes from a different scorer (`align.ts` autoAlign) with the cascade as its second opinion. Suggested: "A coarse grid from the sensor guess finds candidates, a robust fit refines them, and a confidence score gates the result, with a full-circle search under a stricter bar when the compass is missing or wrong. A rejected solve escalates to a second, correlation-based refinement, then to the match service or to tapping peaks."
- `viewport-inference` modules list `geo/skyline.ts` and `geo/horizon.ts` (owned by the skyline and dem-horizon nodes) but not `src/lib/align.ts` or `src/lib/integration/second-opinion.ts`, which carry the app's actual viewport solve. Suggested modules: `geo/solve.ts`, `refine/index.ts`, `align.ts`, `integration/second-opinion.ts`.
- `baseline-pipeline` summary is right for `/baseline`; add "On a photo without a compass, gravity or focal length the same cascade runs with the unknown-pose options and a 0.75 bar."

## 8. Log

| Date | Unit | Commit | Note |
|---|---|---|---|
| 2026-10-02 | U1 | 9052a1e | `/baseline` unknown-sensor options + 0.75 bar; adversarial review: LAND (nits fixed before landing) |
| 2026-10-02 | U2 + U3 | 5e43b99 | pipeline specs (13 tests), `return await`, cascade-copies doc; this plan |
| 2026-10-02 | U8 | 3c8428a | parseAppleGravity hardened through the upload parser (type-5 rationals are now read like the upload path does; implausible vectors → undefined); eye through `eyeAltitude`, 1.6 m kept (D1 is the user's) |
| 2026-10-02 | U7 | 84f825b | align specs (Sonnet), reviewed |
| 2026-10-02 | U4 | this commit | stripAgreement diagnostic (Sonnet), reviewed: solvePose untouched |

Negative / not done: U5 (seam) deferred, it needs the same change in pod D's GPU selection and a flag through pod B's worker; no batch-ledger rows (nothing landed changes rendering or GPU code).

## 9. Decisions for the user

1. F3/F4: should an explicit Auto-align re-run, or a second opinion that timed out, leave a 0.2–0.5 pose saved as "auto"? Recommended: no (show it, keep it unsaved and "unverified").
2. D1 (eye-rule pod): 1.6 m vs 1.8 m eye height without a GPS altitude.

## 10. Next (top 3)

1. U5: circular 360° selection behind a flag, with pod D, then the dev cascade harness.
2. Measure `stripAgreement` on the wild dev half (next batch pass) as an R2 veto candidate, against the displaced-eye decoys.
3. F3/F4 once decided; F12 (use gravity in `/baseline`'s prior when only the heading is missing).
