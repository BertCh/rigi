Archived 2026-10-01: folded into [../terrain-matching-research.md](../terrain-matching-research.md) ("Strategy carried forward").

# Terrain matching: execution plan for the five next steps, and a broader view of the problem

*2026-09-28 · follows `reports/terrain-matching-research.md` (§7). Dev only; data_v3 untouched.*

## Part A — what is running now

> **Update (2026-10-01):** the statuses below are as of 2026-09-28. Since then: H1 is done (`tools/research/tm/h1_mine/REPORT.txt`; the blind pack holds 120 overlays across 27 photos), P1 is done (Part C, negative), step 1b blind verification is ready but not started (roadmap R1), and steps 2, 3 and 5 still wait on it (R2, R3, R6). From Part B, §1's top-3 picker / tap-a-peak is built behind `?picker=on` (R4, `src/lib/picker/README.md`), and §4's near-field render option was tested as FUND E3 and killed ([negative-results.md](../negative-results.md)). Current state: [status.md](../status.md), [roadmap.md](../roadmap.md).

| step | study | dir | status |
|---|---|---|---|
| 1 hard negatives | **H1 mining**: T6+LoMa candidates at the stated eye (S1), X1 feature seeds (S2), a masked-basin rerun (S5), v2 eye-search eyes (S3), and a displaced-eye pilot (S4). Common support = single-view LoMa inliers at the candidate's own render; the pool is ≥ 100; the pool rule was fixed in `PROTOCOL.txt` before any verdicts | `tools/research/tm/h1_mine/` | running |
| 4 position | **P1 triage** (DONE, see Part C): title → OSM geocode (from-X / vom-X / depuis-X …), eye-height check, line-of-sight to the named target summits, flag rule fixed before scoring, candidate eyes emitted as proposals | `tools/research/tm/p1_position/` | running |
| 1b verify | Blind verifiers on the H1 pack (fresh agents, neutral headers, padded overlays, duplicates, decoys, positive controls) | main session | after H1 |
| 2 veto prereg | Panel (MoGe-2 `combo_int.z`, fused-correspondence `pnp_rel`, 3-strip agreement, XoFTR-depth support) computed on the labelled pool; thresholds frozen by a rule written before scoring | `h2_panel/` | after 1b |
| 3 recall levers | LoMa, X1 seeds, ALIKED+dehaze, and a LoMa-specific rule, run under the frozen veto | — | after 2 |
| 5 data_v3 | Fold into `reports/v3-prereg.md` | — | **needs the user's sign-off** |

### A change to step 1: most hard negatives don't need blind verification

A photo has exactly one orientation. So a candidate at the **same eye** (within 2 m) as a verified-correct pose, and more than 3° away from it, is wrong **by construction**. That makes two cheap sources of labelled hard negatives from the production distribution:

- **Masked-basin rerun (S5):** suppress the correct basin (±10° yaw) in stage 1 and let T6+LoMa find its best alternative. That alternative is exactly the pose the veto must reject whenever the pipeline misses the true basin.
- **Every other stated-eye candidate** more than 3° from a correct ref.

Blind verification is then only needed for **moved-eye poses** (S3/S4) and for photos without a correct ref. That is also where the dangerous near-misses live (wc_0086, wc_0074).

A random 20% of the construction-labelled poses still go through the pack, to measure label noise.

**Caveat:** the two kinds of negative differ. Construction negatives are wrong-*basin* errors. The eye-error traps (wc_0001, 0070, 0086) are only in the verified moved-eye set. The veto must be reported separately on each kind; a single pooled AUROC would hide the dangerous kind.

### What step 2 can and cannot claim

With *n* hard negatives and 0 accepted, the 95% upper bound on the veto's miss rate is about 3/*n*:

| hard negatives | miss rate at most |
|---|---|
| 7 (today) | ~43% |
| 30 | ~10% |
| 60 | ~5% |

- Freeze the thresholds by a written rule, not by eye. For example, "the minimum over leave-one-photo-out folds of the correct-ref score, minus a margin".
- Report the result per negative kind.
- A "0 wrong accepted on dev" result is a necessary condition, not evidence of safety. data_v3 is what supplies the evidence.

## Part B — stepping back: how else to approach the problem

The current framing is: *single photo in, one pose out, automatically accepted only if a rule is certain*. Nearly all of the remaining work fights the last clause. Seven observations follow.

### 1. Turn verification into ranking by using the user (largest product lever)

- **Numbers:**
  - Top-4 hit rate is **27/30**, but safe HIGH is ~19–27/50.
  - The product rule already asks the user to confirm anything that isn't HIGH.
- **Proposal:** instead of a yes/no on one pose, show the **top 3 distinct basins** as overlay thumbnails and ask "which one fits?".
  - A ranking problem is one we already solve well.
  - A wrong pick is also much rarer than a wrong accept, because a person easily rejects a wrong skyline once they can compare.
- **Cheaper still:** "tap a peak you know". The app already has labels; tapping a named summit gives yaw and pitch directly. Two taps give the full rotation. An eye error then shows up as an inconsistency between the two taps.
- **Suggested metric:**
  - auto-accept precision at 1.0, *plus* recall@3 with one tap;
  - `unknown-pose.worker` and `/roll` are the natural places for it.
- **Owner:** this is an app-pipeline decision, not a research result. Proposed, not built.

### 2. Make eye position a model-selection question, not a search

- **The problem:** the traps are wrong *eyes* that still collect 300–1800 inliers. Today the basin gap compares orientations at one eye only.
- **Global basin gap:** accept a pose only if it beats the best explanation found anywhere in the plausible eye region by a margin:
  - stated eye;
  - v2 eyes within 400 m;
  - P1's title-geocoded eyes;
  - OSM viewpoints within 1–3 km.
- **What it changes:** eye search stops being a recall lever that creates gross HIGHs (wc_0086) and becomes a **verifier**: if another eye explains the photo about as well, abstain.
- **Status:** v2's `AMBIG_DEG` is a narrow version of this. H1's S3 records supply the data to test it at no extra cost.

### 3. Get more field of view before trying to be cleverer

- **Why:** the basin ambiguity is worst on narrow, tele, near-field frames. A three-photo panorama triples the skyline, and ambiguity falls roughly exponentially with skyline length.
- **What exists:** `tools/matcher/v2/pano.py` and the `/roll` import already give us burst and trip groups. Photos taken within minutes and ~250 m share an eye, which gives a joint solve with one eye and N rotations.
- **Status:** not tested on the benchmark, which is single-photo by design. It is worth a dev-roll study on the user's own GT-12 sequences.

### 4. Attack the largest failure bucket, which isn't verification

F1's largest bucket is **matching (12 of 31)**, and near-field content is the common factor: failing photos have a median 44% of the frame within 300 m, against 16% for successes.

- **The cause:** the renders use swissALTI3D (bare earth) and SWISSIMAGE, with the matcher capped at maxZoom 14.
- **Options:**
  - **Render the near field properly:** higher zoom within ~500 m, and swissSURFACE3D, the DSM with trees and buildings. It is swisstopo open data, but it is not a tile service, so it needs local tiling.
  - **Or mask the near field** out of matching and the decision where the DEM can't explain it (LSGS-style reliability mask, R1 E-S2).
- **Status:** steps 1–3 don't touch this bucket. It should be a parallel study (proposed as N1).

### 5. Title geocoding is a benchmark lever more than a product lever

- **Why:** Commons titles ("from Pilatus") are rich; app uploads mostly have EXIF GPS and no title.
- **The product analogue:**
  - "where were you standing?" as a map tap when the position is flagged suspect;
  - the P1 checks that need no title: eye height against the DEM, and visibility of what the heading points at.
- **How to report P1:** give the title and no-title flags separately, so a benchmark gain isn't mistaken for a product gain.

### 6. Labels are the scarce resource, so build a flywheel

- **The current method:** every verdict costs a blind-verifier round.
- **The flywheel:**
  1. Use agreement between independent pipelines as a silver label: cascade, fused/T6, LoMa, and different eyes.
  2. Send only the disagreements to blind verification.
  3. Add construction labels (Part A).
  4. Add, with consent, the choices users make in the top-3 picker from §1.
- **The payoff:** that turns a 100-photo benchmark into thousands of training pairs. That is enough to retrain a Doppelgangers-style pair classifier (MIT licence) on photo↔render pairs, which R1 ranked highly but which is starved of negatives today.

### 7. Protect the ability to evaluate

- **Why:** data_v3 is the last held-out set, and each pre-registration spends one. When the recall levers land, the next change will have nothing to test on.
- **Recommendation:**
  - Assemble **data_v4** now: ~100 photos, sealed, with the same stratum mix. Collection is cheap compared to everything else.
  - Optionally, reserve a sealed slice of v3 for a second look. That is only possible if it is decided **before** v3 is opened.

## Proposed order after the current runs

1. H1 → blind verification → H2 veto pre-registration (steps 1–2 as planned, with the construction-label change).
2. In parallel, with no dependency on the veto: **N1 near-field** (render zoom/DSM vs masking, dev matching stage) and **global basin gap** computed from the H1 records.
3. Step 3 recall levers under the frozen veto, with the P1 flags as a "position suspect → don't auto-accept" input.
4. Decisions for the user:
   - whether to build the top-3 picker / tap-a-peak UX (§1);
   - whether to assemble data_v4 (§7);
   - the data_v3 spend (step 5).

## Part C — results

### P1 position triage (done; `tools/research/tm/p1_position/REPORT.txt`)

**Coverage:** 29 of the 50 dev titles are usable:
- 19 contain a "from X"-style viewpoint phrase, and 16 of those match an OSM feature;
- 21 name a peak within 40 km.

**Pre-registered flag (far ∨ low ∨ not-visible):** 12 photos flagged.

| judged against | flagged correctly | flagged wrongly | missed | precision | recall |
|---|---|---|---|---|---|
| F1's 9 position failures | 3 | 9 | 6 | 0.25 | 0.33 |
| F1's 5 errors over 400 m | 3 | – | 2 | – | 3/5 |

It flags **6 of the 30 photos that are already solved correctly** (about 20%). The full rule is **not shippable**.

**The individual checks:**
- **Far** (the named viewpoint is more than 400 m away): 6 flags, only 1 on a solved photo. It catches both headline cases:
  - wc_0069: Fronalpstock is 1.08 km away and the eye sits 575 m too low;
  - wc_0073: Pilatus Kulm is 17.5 km away and the eye sits 1621 m too low.
- **Not-visible:** 5 of its 6 flags are on solved photos. The misfires come from pass and railway names, "Viewpoint Target" titles, and headings that disagree with the named peak.
- **Low:** never fired.

**Post-hoc variant (n = 2):** add "the viewpoint is at least 150 m above the eye" to the far check. It flags 3 photos, catching 2 real failures with 0 flags on solved photos. It needs confirmation on a split we haven't looked at.

**Proposals:** only the wc_0069 and wc_0073 candidate eyes are credible. The wc_0017 proposal would be harmful: it sits 2.2 km away and 811 m below a verified-correct eye.

**Deviation:** Overpass was slow, so place areas were dropped for all 50 photos. This was decided before any results.

**Implications:**
1. Use the far check as a **"don't auto-accept, suggest the eye"** signal, never as an automatic eye move.
2. Run T6 at the two credible proposals, as a suggestion.
3. Title-based triage covers about half of Commons photos and ~0 app uploads (GT-12 has no titles), which supports B§5. The product analogue is a map-tap "where were you standing?" prompt.

### Enabler for B§2 (global basin gap), 2026-09-28

**API:** a batched-eye GPU horizon, `computeHorizonsAuto(mosaics, eyes, opts)` in `src/lib/gpu/horizon/index.ts`.
- **Where it runs:** browser or worker only, using WebGPU. It falls back to CPU automatically.
- **Output:** elevation and distance per azimuth.
- **Speed:** 343 eyes in 0.5–1.1 s, against 25–39 s on CPU.
- **Parity with CPU:** p99 ≤ 2e-4°.

**What this makes affordable:** a skyline-level cross-eye ambiguity check over hundreds of plausible eyes per photo. That covers eyes within 400 m, OSM viewpoints within 1–3 km, and P1 proposals. Use it as a cheap pre-filter that decides where T6 runs, not as a pose accept.

**Still to come:** a batched eye-search provider (`src/lib/gpu/eye`) is in progress.

**Update:** the batched eye-search provider is done.

- **API:** `src/lib/gpu/eye`, with `createEyeHorizonProvider`, `loadEyeMosaics` and `sectorForPose`.
- **Where it runs:** browser only. It falls back to CPU automatically.
- **Speed:** about 0.4 s for 343 eyes.
- **Eye refinement:** `refineEyeFromSkyline(..., { horizonsAtEyes, ground })` is 6.7× faster than the per-eye CPU version.
- **Caveat:** GPU and CPU horizons differ by up to ~1e-2° at a few azimuths. On IMG_7063 the eye moved 0.86 m (inside the LM 1σ). So any basin-gap margin must be much wider than that, or the gap must be computed on one backend only.
- **Bench:** `out/gpu/w6/eye-bench.json`.
