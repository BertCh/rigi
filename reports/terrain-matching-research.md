# Terrain-matching deep research: what limits photo↔terrain matching, and what to try next

*2026-09-28 · the TM program in `tools/research/tm/` (rules in its README). There is one report per study; this document combines them.*

**Scope.**
- Only the 50 DEV ids were used. The spent test half and `data_v3` were not touched, the live services were not called, and no shared code was edited.
- Every study ran offline on one shared render cache (C0, 2.6 GB, verified bit-stable).

**Honesty caveats.**
- The sample is small: 30 photos with a verified-correct ref, but only **4–7 genuinely hard wrong poses** (wc_0001, 0069, 0070, 0074, 0086, plus a few near-misses).
- Several of the most interesting results were found **post hoc**, and they are labelled as such.
- Nothing here changes the frozen T6 rule or the v034 service default.

## 1. Where the failures are (F1 autopsy, 31 non-correct-HIGH dev photos)

| failing stage | photos | typical cause |
|---|---|---|
| matching | 12 | appearance gap (snow vs summer drape, haze, backlight); near-field content the DEM lacks |
| position | 9 | 5 are more than 400 m off: wc_0073's EXIF GPS is ~16 km off, and wc_0069's eye is ~600 m too low. 4 are small eye errors |
| decision | 5 | correct pose, rejected by a fragile rule clause: wc_0063 (basin gap 0.182 vs 0.20) and wc_0006 (the 0.3° clause, 1935 inliers) |
| search | 3 | wc_0040: the Moléson is visible, but no candidate lands within 90° of it |
| refine / GT | 2 | wc_0028, wc_0076 |

- **Ceiling:** about 19–20 of the 31 look recoverable as *poses*. As *safe HIGH accepts*, the realistic gain is **only +4 to +8** (19 → ~23–27 of 50).
- **Why the ceiling is low:** the eye-error photos are exactly where wrong poses also get 330–1800 inliers.
- **Near-field terrain:** the renders draw terrain within ~300 m as smooth blur. Failing photos have a median 44% of the frame within 300 m, against 16% for successes.

## 2. Search (stage 1)

| finding | study | numbers (30 photos with a ref) |
|---|---|---|
| **Dense-feature yaw correlation** (DINOv2 over a 24-view ring) is complementary to the skyline | X1 | top-4 hit @3°: 23 → **27** with skyline top-2 + feature top-2 at the same budget. Held-out even ids: 11 → 14 of 16. Post hoc arm, but it held on the held-out half |
| The two cues fail on *different* photos | X1 | features alone find wc_0009, 0048, 0052, 0094; skyline alone finds 6 others. Feature top-1 has median 0.66° but a short tail (p90 18° vs the skyline's 57°) |
| The skyline baseline's 23/30 is a **lucky grid phase** | X4 | half-step grid shifts give 18–21 |
| Exact search (branch-and-bound) doesn't help | X4 | it removes phase brittleness but reaches only the phase-averaged 20. The near-ties are in the score function itself |
| Closed-form pitch/roll per yaw | X4 | 17× faster skyline search (1.2 s) for −2 top-4 hits |
| Depth-edge yaw scan from mono-depth | X2 | 28/30 within 2° on a 360° scan, but **pitch, roll and focal were given**, so this is not yet a real search |

## 3. Matching (stage 2) — X3, plus the earlier LoMa report

- **Best combination:** **LoMa-B on the sat render** (27/30 successes at the true pose, 25/30 correct top view in the ring sweep, AUC 0.94). MINIMA-RoMa on hillshade ties it but is 2.5× slower.
- **Cheap win for ALIKED:** dehaze the photo before matching (24 → 26/30; haze subset 7 → 9/10).
- **Renders that don't help:** snow, haze-styled, normals and edge renders gave no gain. Edges failed with every matcher.
- **Geometry-only renders separate but lose recall.** XoFTR on a depth-coded render gives the traps almost no support (wc_0074 A: 13, wc_0001 B: 22, wc_0069 A: 7, against 300–740 for LoMa-sat), but it loses 5 true-pose successes.
- **Not usable (licences):** MatchAnything (registration licence), MASt3R (NC) and RoMa v2 (gated weights, Linux kernel) were ruled out.

## 4. Verification: the real bottleneck

T6 already has 0 wrong HIGHs at the stated eye. The payoff from verification is that it would let us turn on the recall levers (LoMa, feature hypotheses, eye search, a looser basin-gap clause) without letting gross errors through. Each cue below catches a different kind of trap:

| cue (study) | wc_0001 B | wc_0069 A | wc_0070 A | wc_0074 A | wc_0086 N7 | cost on correct |
|---|---|---|---|---|---|---|
| 3-strip skyline yaw agreement (X4) | abstains | abstains | **passes** | abstains | – | the baseline abstains on 2 of its 19 correct top-1s; B&B top-1s 18/18 kept |
| MoGe-2 terrain-depth score `combo_int.z` < 0.37 (X2) | passes | **veto** | passes | **veto** | not scored | 0/19 T6 and 0/18 LoMa correct HIGHs vetoed; 1/78 strong correct poses |
| PnP free-centre shift `pnp_rel` > ~0.035 (X5, post hoc) | **veto** | passes | **veto** | passes | passes (only `pnp_up_abs` catches it) | loses wc_0047 (correct HIGH) |
| XoFTR on a depth render, ≥ 30 inliers (X3, post hoc) | **veto** (22) | **veto** (7) | ? | **veto** (13) | – | accepted correct refs 29 → 24 |
| DINOv2 photo↔render similarity (X1) | prefers the correct ref in 48/49 ref pairs | | | | | untested as a stage-2 check |

- **What the table shows:**
  - Mono-depth catches wrong *basins* seen from a wrong eye that puts an obstacle in the render (0069, 0074).
  - The PnP centre shift catches near-miss *eyes* whose far layers still match (0001, 0070).
  - The two are complementary: an OR-veto catches 6 of 7 hard wrongs, at a cost of 2 of 22 strong correct refs (wc_0047, wc_0085). That operating point is fragile.
- **The negative-evidence features alone failed.** Unmatched rendered contours, depth-band residuals and ring spread did not separate correct from wrong (X5). A learned ≤ 4-feature model could not reach zero wrong accepts without vetoing correct HIGHs.
- **What limits verification is negatives, not ideas.** Every veto was calibrated on ≤ 7 hard wrong poses from ≤ 7 photos.

## 5. Position

- **Distance of the position errors:** the five > 400 m errors are 1–16 km off, so the 400 m eye search can't fix them.
- **Ideas from F1 and the literature study (R1):**
  - title geocoding ("from Pilatus", "from Fronalpstock", "von der Belchenflue");
  - visibility sanity checks before matching;
  - OSM viewpoints, huts and paths within 1–3 km as candidate eyes.
- **Eye proposals from the PnP shift:** the free-centre PnP in X5 proposes plausible eye corrections: +83 m up for wc_0074 (verified correct 225 m away) and +79 m up for wc_0086.

## 6. What did not work (don't repeat)

- Branch-and-bound skyline search, and column-pooled (1-D) feature correlation.
- DINOv3 over DINOv2.
- Edge-map, snow-styled and haze-styled renders.
- Mono-depth FOV as a focal prior: MoGe is +20° too wide, DA3 7° off, while EXIF is 0.55°.
- A learned negative-evidence verifier on this data.
- Grounded in the literature (R1) rather than tested here: VGGT/MASt3R-style feed-forward pose, ground↔aerial yaw nets, image translation, NeRF/3DGS.

## 7. Recommended next steps (ranked)

> **Update (2026-10-01):** step 1's mining ran as H1 (`tools/research/tm/h1_mine/REPORT.txt`: 166 kept candidates, a 120-overlay blind pack across 27 photos); the blind verification is ready but not started (roadmap R1), so steps 2–3 still wait (R2, R3) and step 5 is roadmap R6. Step 4's title triage ran as P1 and was not shippable (precision 0.25; [terrain-matching-research.md](terrain-matching-research.md), final section). Execution plan (folded into the final section below) and the top-3 picker (built behind `?picker=on`): [roadmap.md](roadmap.md).

1. **Mine a hard-negative set on dev** before any verifier work.
   - Run LoMa-sat plus the X1 feature hypotheses plus the v2 eye-search finals on all 50 dev photos, and keep every ≥ 100-inlier pose.
   - Blind-verify the new ones with the existing protocol (padded packs, neutral headers).
   - Target 30+ hard wrongs. This is what every veto decision here is bottlenecked on.
2. **Pre-register a verifier panel on that set.**
   - The panel: MoGe-2 ViT-B `combo_int.z`, `pnp_rel` computed on the *fused multi-view* correspondences, 3-strip agreement, and XoFTR-depth support.
   - Freeze the thresholds on the mined set, then judge the panel as a veto on T6 + LoMa.
3. **Pre-register the recall levers, gated on step 2:**
   - LoMa-sat as the matcher;
   - ALIKED + photo dehaze as the cheap alternative;
   - X1 feature top-2 as an extra stage-1 generator (+4 top-4 hits);
   - a LoMa-specific rule that also fixes the fragile basin-gap and 0.3° clauses (wc_0063, wc_0006).
4. **Position triage:** title geocoding and a visibility sanity check that output "position suspect". Also try OSM candidate eyes within 1–3 km and the PnP eye proposals as *suggestions*.
5. **Only after 1–3 are frozen on dev:** fold the winners into the `reports/v3-prereg.md` draft and spend `data_v3`. **That needs the user's sign-off.**

Quick, cheap items that can be done independently:
- **wc_0033:** blind-verify LoMa's unverified pose (yaw 61°, 1219 inliers). X2's depth score puts it above the correct-ref median.
- **Camera model:** the live matcher assumes fx = fy, which costs up to 0.4 px (found by C0). It's harmless for matching but matters for sub-pixel refinement, so tell f0.

## Files

| study | report | key data |
|---|---|---|
| C0 cache | `tools/research/tm/c0_cache/REPORT.md` | `cache/FORMAT.md` |
| R1 literature | `research_notes/tm_literature_2026-09.md` | — |
| F1 autopsy | `tools/research/tm/f1_autopsy/REPORT.md` | `taxonomy.json`, `sheets/` |
| X1 feature yaw | `tools/research/tm/x1_yawcorr/REPORT.md` | `results/x1_results.json` |
| X2 mono-geometry | `tools/research/tm/x2_geom/REPORT.md` | `veto.json`, `results_all.json` |
| X3 modality × matcher | `tools/research/tm/x3_modality/REPORT.md` | `tables_final.md`, `summary_final.json` |
| X4 skyline search | `tools/research/tm/x4_bnb/REPORT.md` | `results/x4_results.json` |
| X5 verifier | `tools/research/tm/x5_verifier/REPORT.txt` | `features*.json`, `combo_veto.json` |

Disk: 7.4 GB under `tools/research/tm/`. Of that, the cache is 2.6 GB and the weights and packages about 3.5 GB, which can be pruned. *(Update 2026-10-01: after the 2026-09-30 prune, 5.2 GB remain: cache 2.4 GB, `weights/x2` 2.1 GB plus `.pylib_x2`, which the near-field service loads, so keep them. `c0_cache/` and `cache/` are gitignored, so their REPORT/FORMAT files exist only locally.)*

## Strategy carried forward (from tm-strategy, 2026-10-01)

The 2026-09-28 execution plan (`tm-strategy.md`, now `archive/tm-strategy.md`) is folded in here; the live plan is [roadmap.md](roadmap.md).

**Construction negatives.** A photo has one orientation, so a candidate at the same eye (within 2 m) as a verified-correct pose and more than 3° away is wrong by construction. Two cheap labelled sources: the masked-basin rerun (suppress the correct basin, ±10° yaw, in stage 1 and keep T6+LoMa's best alternative; S5) and every other stated-eye candidate more than 3° from a correct ref. Blind verification is then needed only for moved-eye poses (S3/S4) and photos without a correct ref, which is also where the dangerous near-misses live (wc_0086, wc_0074); a random 20% of construction labels still goes through the pack to measure label noise. Caveat: construction negatives are wrong-basin errors, while the eye-error traps (wc_0001, 0070, 0086) exist only in the verified moved-eye set, so a veto must be reported per negative kind, never as one pooled AUROC.

**Miss-rate bound.** With *n* hard negatives and 0 accepted, the 95% upper bound on the veto's miss rate is about 3/*n*:

| hard negatives | miss rate at most |
|---|---|
| 7 (at the time) | ~43% |
| 30 | ~10% |
| 60 | ~5% |

Freeze thresholds by a written rule (e.g. the minimum over leave-one-photo-out folds of the correct-ref score, minus a margin), report per negative kind, and treat "0 wrong accepted on dev" as necessary, not sufficient; data_v3 supplies the evidence.

**B§2, the global basin gap (open).** The traps are wrong eyes that still collect 300 to 1800 inliers, and today's basin gap compares orientations at one eye only. Proposal: accept a pose only if it beats the best explanation found anywhere in the plausible eye region by a margin (stated eye; v2 eyes within 400 m; P1's title-geocoded eyes; OSM viewpoints within 1 to 3 km). Eye search then stops being a recall lever that creates gross HIGHs (wc_0086) and becomes a verifier: if another eye explains the photo about as well, abstain. v2's `AMBIG_DEG` is a narrow version; H1's S3 records supply the test data. The batched-eye GPU horizon and eye provider (above) make hundreds of eyes affordable as a pre-filter that decides where T6 runs, not as a pose accept; any margin must be much wider than the GPU-vs-CPU horizon difference (up to about 1e-2°).

**P1 results (position triage, done, negative; `tools/research/tm/p1_position/REPORT.txt`).** 29 of the 50 dev titles are usable (19 have a "from X" phrase, 16 of those match an OSM feature; 21 name a peak within 40 km). The pre-registered flag (far or low or not-visible) flags 12 photos: against F1's 9 position failures 3 correct, 9 wrong, 6 missed (precision 0.25, recall 0.33); against the 5 errors over 400 m, 3 of 5. It also flags 6 of the 30 already-solved photos (about 20%), so the full rule is not shippable.
- Far (named viewpoint more than 400 m away): 6 flags, 1 on a solved photo; catches both headline cases (wc_0069: Fronalpstock 1.08 km away, eye 575 m too low; wc_0073: Pilatus Kulm 17.5 km away, eye 1621 m too low). Not-visible: 5 of 6 flags on solved photos (pass and railway names, "Viewpoint Target" titles, headings that disagree with the named peak). Low: never fired.
- Post-hoc (n = 2, needs a fresh split): far plus "viewpoint at least 150 m above the eye" flags 3 photos, 2 real failures, 0 on solved photos.
- Proposals: only the wc_0069 and wc_0073 candidate eyes are credible; the wc_0017 proposal would be harmful (2.2 km away, 811 m below a verified-correct eye). Overpass was slow, so place areas were dropped for all 50 photos (decided before results).
- Use: a "don't auto-accept, suggest the eye" signal, never an automatic eye move. Title triage covers about half of Commons photos and about 0 app uploads (GT-12 has no titles); the product analogue is a map-tap "where were you standing?" prompt.

**Part A statuses (as of 2026-10-01).**

| step | study | status |
|---|---|---|
| 1 hard negatives | H1 mining (`h1_mine/`: stated-eye T6+LoMa, X1 seeds, masked-basin rerun, v2 eyes, displaced-eye pilot; pool >= 100 fixed in `PROTOCOL.txt`) | done: 166 kept candidates, 120-overlay blind pack across 27 photos |
| 4 position | P1 triage (`p1_position/`) | done, negative (above) |
| 1b verify | blind verifiers on the H1 pack (neutral headers, padded overlays, duplicates, decoys, positive controls) | ready, not started (roadmap R1) |
| 2 veto prereg | panel (MoGe-2 `combo_int.z`, fused `pnp_rel`, 3-strip agreement, XoFTR-depth support), thresholds frozen by a prior rule | waits on 1b (R2) |
| 3 recall levers | LoMa, X1 seeds, ALIKED+dehaze, a LoMa-specific rule, under the frozen veto | waits on 2 (R3) |
| 5 data_v3 | fold into [v3-prereg.md](v3-prereg.md) | needs the user's sign-off (R6) |

Part B's other items: the top-3 picker / tap-a-peak is built behind `?picker=on` (R4, `src/lib/picker/README.md`); the near-field render option was tested as FUND E3 and killed ([negative-results.md](negative-results.md)); more field of view (panorama/burst joint solve, `tools/matcher/v2/pano.py`) is untested on the single-photo benchmark; the label flywheel (silver labels from pipeline agreement, only disagreements blind-verified) and a sealed data_v4 remain proposals.
