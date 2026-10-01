# In-the-wild benchmark: 100 Swiss Commons photos

**Question:** our accuracy numbers so far come from 12 photos taken by one person with one phone in two regions. How do the aligners do on other people's photos, which have no gravity and often no heading?

**Answer (v2 verification, 2026-09-25):**

| | result |
|---|---|
| Photos solvable by at least one method | 53 / 100 |
| Correct poses: fused `/match` | **50** |
| Correct poses: app aligner | 39 |
| Correct poses: cascade | 14 |
| Fused HIGH precision | **0.97**: 30 correct out of 31 HIGH, 1 gross error |
| Fused HIGH precision on EXIF-GPS photos | **12 / 12** |
| Product accept rule (fused HIGH and (EXIF GPS or agreement with the cascade)) | **16 / 16 correct** |
| App aligner, accepted poses | 0.64 precision, 19 gross errors (don't auto-accept it) |

The main remaining losses are photos with no heading (16 of 42 solvable), low light, haze and near-field terrain. Fused is also over-cautious: 20 of its LOW poses are correct.

> **Why v2.** The first verification pass (v1) drew overlays from the Terrarium DEM using the app pipeline's eye-height rule. The methods solve on Mapterhorn at their own eye, which is up to about 40 m higher on this set, and Terrarium ground differs from Mapterhorn by up to 114 m. On near-field skylines the drawn line moved by 1–27% of image height (median about 1.3% on the spot-checked photos), which made many correct poses look like "near-misses" or "wrong". v2 draws every candidate on Mapterhorn at the eye its method actually used, and all 100 photos were re-verified blind. v1 is kept for comparison below. The v1 numbers (fused 33 correct, HIGH precision 0.72) were **wrong**, and so was their story that parallax from bad GPS explains the near-misses. That explanation came mostly from the overlays.

## Set and protocol

- **Photos:** 100 photos from Wikimedia Commons, all taken in Switzerland, with camera-type coordinates and at most 3 per author.
  - Licences: CC BY / CC BY-SA 94, CC0 4, PD 1. See `tools/bench/data/ATTRIBUTION.md`.
  - Resized to 2048 px (54 MB total). Rebuild with `tools/bench/collect/run.sh`.
- **Strata:** position source is EXIF GPS for 43 and hand-placed for 57. The skyline is near for 57 and far for 43 (a visual estimate). A heading is known for 58, mostly coarse compass letters, and unknown for 42. No photo has gravity. 44 are tagged hard.
- **Methods** (run with `tools/bench/harness/run.sh … --weak-heading`):
  - `app`: the app's `autoAlign`, plus a harness 360° seed wrapper.
  - `cascade`: the app pipeline's `solvePose` → `refinePose`, with the unknowns declared. In this run it solved on the **Terrarium** DEM (Mapterhorn has since been added), and it's drawn at its eye rule re-applied on Mapterhorn. That mismatch may understate the cascade a little.
  - `fused`: the matcher service's two-stage mode (a 360° match sweep, or app-skyline seeds when the sweep finds under 30 matches), then the skyline+match joint LM, using the confidence rule fixed in advance in `reports/fusion.md`.
- **Ground truth: blind visual verification.**
  - Poses within 0.5° of each other form one cluster, and each cluster becomes one overlay (DEM skyline plus OSM peaks) with a random A/B/C label.
  - Verifier agents judge each overlay against a fixed checklist: C1 coverage of at least 70%, C2 vertical fit within 1.5% of height, C3 feature alignment, C4 tilt. The verdict is correct, wrong or unsure, with an explicit near-miss tag. Verifiers never see the method or the confidence.
  - 30 photos are judged twice. The candidate verdicts agree 67 of 71 times in both v1 and v2; they're different pairs that happen to give the same count. Disagreements count as unsure.
  - Photos whose images hit a rate limit were re-judged from scratch, and no verdict rests on an unseen image.
- **Files:** the v2 pack is `tools/bench/harness/out/runs/wild/verify_v2/` and its verdicts are in `verdicts_v2/`. The scorer is `VERIFY_VERSION=v2 python3 tools/bench/score/score_wild.py`, which writes `tools/bench/score/wild_scores_v2.json`.

## Headline results (v2)

How to read the cells:
- **correct (+≈):** poses verified correct, with near-misses in brackets.
- **accepted:** app or cascade accepts, or fused HIGH.
- **precision:** correct ÷ (correct + wrong) among accepted poses.
- **gross:** accepted poses judged wrong.

| stratum | n | any correct | app: correct / accepted / precision / gross | cascade | fused |
|---|---|---|---|---|---|
| **all** | 100 | 53 | 39 (+9≈) / 60 / 0.64 / 19 | 14 (+4≈) / 17 / 0.75 / 3 | **50** (+7≈) / 31 / **0.97 / 1** |
| **EXIF GPS** | 43 | 24 | 17 / 24 / 0.70 / 7 | 8 / 8 / 0.88 / 0 | **23** / 12 / **1.00 / 0** |
| hand-placed | 57 | 29 | 22 / 36 / 0.60 / 12 | 6 / 9 / 0.62 / 3 | **27** / 19 / **0.95 / 1** |
| far skyline | 43 | 22 | 14 / 20 / 0.65 / 7 | 7 / 7 / 0.86 / 1 | 20 / 13 / 0.92 / 1 |
| near skyline | 57 | 31 | 25 / 40 / 0.63 / 12 | 7 / 10 / 0.67 / 2 | **30** / 18 / **1.00 / 0** |
| heading known | 58 | 37 | 27 / 34 / 0.73 / 8 | 11 / 11 / 0.82 / 2 | **35** / 22 / 0.95 / 1 |
| heading unknown | 42 | 16 | 12 / 26 / 0.50 / 11 | 3 / 6 / 0.60 / 1 | **15** / 9 / **1.00 / 0** |
| fused seeded by match sweep | 38 | 33 | 21 / 27 / 0.77 / 5 | 9 / 9 / 0.88 / 1 | 32 / 21 / 0.95 / 1 |
| fused seeded by app skyline | 61 | 20 | 18 / 32 / 0.55 / 13 | 5 / 8 / 0.62 / 2 | 18 / 10 / **1.00 / 0** |

**Closest to the product, EXIF GPS plus a heading (30 photos):** a correct pose exists for 20 of them. Fused is correct on 19, and fused HIGH is **10 / 10 correct**.

## Confidence calibration

- **Fused HIGH:** 30 of 31 are correct. The single gross error is wc_0069: hand-placed position, far skyline, tagged near-field terrain and parallax-mismatch. It's the kind of case the basin-gap LOW trigger from T5 targets; that trigger is being added to the service now. On EXIF-GPS photos, on near skylines, with no heading, and when seeded from the app skyline, fused HIGH has **no errors**.
- **Fused LOW is conservative:** 20 LOW poses are correct. HIGH covers 30 of fused's 50 correct poses, so there's recall to gain.
- **Independence from the app seed:** in the 61 runs seeded by the app skyline, fused HIGH is 10 / 10 correct, while the app's own accepts on the same photos are 0.55 precise with 13 gross errors. The fused rule re-checks the seed and doesn't inherit the app's verdict.
- **Cross-method agreement:** fused and the cascade share a pose cluster on 13 photos, and all **13 / 13 are correct**.
- **Product rule (adopted):** fused HIGH and (EXIF GPS or agreement with the cascade within 0.5°). That's **16 accepts, 16 correct**, and everything else goes to "please confirm".
  - The cost is recall. Fused HIGH alone is 30 correct with 1 wrong, so the rule gives up 14 correct accepts to avoid that single error.
  - Once the basin-gap trigger has been validated on dev, a looser rule becomes reasonable: fused HIGH plus basin-gap, when there's no EXIF GPS.
- **App accept** (`autoAlign` plus the 360° wrapper): 0.64 precision with 19 gross errors. Never auto-accept it on uploads.
- **Cascade accept:** 0.75 precision with 3 gross errors (wc_0004, wc_0037, wc_0061). All three were solved on Terrarium. It should be re-run on Mapterhorn before drawing conclusions.

## Failure taxonomy (v2)

Share of photos where at least one method is correct, by photo tag (the tags are the verifiers' union):

| photo condition | photos | any correct |
|---|---|---|
| low light / dusk | 10 | **2** |
| heading unknown | 42 | **16 (38%)** |
| near-field terrain forms the skyline | 24 | 8 (33%) |
| fog / haze | 36 | 15 (42%) |
| cloud on the skyline | 38 | 20 (53%) |
| foreground occlusion | 40 | 20 (50%) |
| hand-placed position | 57 | 29 (51%) |
| EXIF GPS | 43 | 24 (56%) |
| heading known | 58 | 37 (64%) |
| water reflection | 16 | 11 |

47 photos are unsolved. Their most common candidate tags are wrong-direction (40), roll (33) and pitch-offset (29). These are search failures, not small misfits.

1. **No heading, and search.** The fused 360° match sweep found fewer than 30 matches on 61 of 99 photos. Seeded by the sweep, fused is correct on 32 of 38 photos; seeded by the app skyline, on 18 of 61. The largest lever is **a better stage-1 search**: a finer yaw/FOV sweep, and features that are more robust to season and lighting (winter, dusk and haze against summer orthophotos).
2. **Low light and haze** leave weak skyline and texture evidence.
3. **Position error and near-field terrain:** much smaller than v1 suggested. T5's position refinement (`reports/position.md`, removed; `git show 384df44:reports/position.md`) turns 2 more dev photos correct and breaks none (blind, v2 overlays), but it isn't the main lever.
4. **Narrow FOV** (hfov below about 10°): fused falls back to the skyline and returns LOW. This is a documented limit (`reports/bench-ablation.md`).

## v1 → v2: what changed

Verdict transitions per method (v1 → v2):

| method | wrong → correct | correct → wrong | unsure → correct | wrong → unsure / correct → unsure |
|---|---|---|---|---|
| app | 10 | 0 | 2 | 2 / 0 |
| cascade | 0 | 1 | 0 | 0 / 2 |
| fused | **15** | 2 | 4 | 2 / 0 |

| headline | v1 (Terrarium overlays) | v2 (Mapterhorn, method eye) |
|---|---|---|
| any method correct | 38 | 53 |
| fused correct / HIGH precision / gross | 33 / 0.72 / 3 | 50 / 0.97 / 1 |
| app correct / precision / gross | 27 / 0.43 / 26 | 39 / 0.64 / 19 |
| cascade correct / precision | 17 / 0.77 | 14 / 0.75 |
| "the near-misses are parallax from bad GPS" | the leading story | mostly an overlay artefact |

The cascade gets slightly worse in v2, probably because it solved on Terrarium and is now drawn on Mapterhorn.

**Lesson:** a verification renderer has to use exactly the terrain model and eye the method uses. That's now enforced in `tools/bench/harness/lib/geo.ts` (Mapterhorn only), and each cluster's eye is recorded in `key_v2.json`.

## Runtime per photo

| method | median | p90 |
|---|---|---|
| app, alignment compute (360° seeds) | 3.1 s | 9.3 s |
| app, wall time including page load and full terrain | 12.4 s | — |
| cascade | 3.0 s | 8.0 s |
| fused, cold page, two-stage | 28.4 s | 53.9 s |

The fused cold time is mostly imagery drape, which is now limited to 40 km on 360° pages.

## Known limits

- **No metric ground truth:** the verdicts are visual. C2's 1.5% of height works out to about 0.3° at a 20° vfov and 1° at a 67° vfov.
- **Near-misses count as wrong.** Adding the ≈ columns gives the lenient reading.
- **Coarse strata:** hand-placed coordinates and compass-letter headings are coarse, and the skyline-distance tags are visual estimates.
- **Cascade on Terrarium:** the cascade row reflects Terrarium solving. It should be re-run on the Mapterhorn loader.
- **Terrarium ground truth:** the 12-photo ground truth used elsewhere was fitted against Terrarium DEM notches (app pipeline), so the GT-12 leaderboard numbers carry a small Terrarium bias.

## Files

- **Data:** `tools/bench/data/{manifest.json, ATTRIBUTION.md, photos/}`
- **Frozen split:** `tools/bench/split.json` (50 dev and 50 test, read-only). T5 was developed on dev only, and test hasn't been touched yet.
- **Harness:** `tools/bench/harness/run.sh`, with outputs in `tools/bench/harness/out/runs/wild/`:
  - `results/`
  - `verify/` + `verdicts/` (v1)
  - `verify_v2/` + `verdicts_v2/` (v2)
- **Scoring:** `tools/bench/score/score_wild.py`, which writes `wild_scores_v1.json` and `wild_scores_v2.json`.
- **Leaderboard rows:** `tools/bench/results.json` (`wild:app`, `wild:cascade`, `wild:fused`).
- **Related reports:** `reports/bench-ablation.md` (the 12-photo metadata ablation) and `reports/position.md` (T5; removed, `git show 384df44:reports/position.md`).

## Update: cascade re-run on Mapterhorn (2026-09-25)

The cascade was re-run on the Mapterhorn loader (`demTileLoaderNode(MAPTERHORN)`, eye from `terrain.ground()` on the same DEM) for all 100 photos (`tools/bench/harness/out/runs/wild-cascade-mt/`).
- **Verdicts:** 34 poses inherit a v2 verdict (within 0.5° in yaw and pitch, eye within 2 m of the verdicted cluster). The other 66 were blind-verified on Mapterhorn overlays at the cascade's own eye.
- **Rule-deviation override:** one verifier passed wc_0055 despite a 2–3% offset (citing tree height). The checklist treats that offset as a near-miss, so it is scored **unsure**.
- **Scores:** `tools/bench/score/cascade_mt_scores.json`

| | all 100 | dev 50 |
|---|---|---|
| cascade correct (Terrarium run → Mapterhorn) | 14 → **25** | 6 → 10 |
| accepts at the 0.5 rule: correct / wrong | 27: 25 / 2 (precision 0.93) | 10: 10 / 0 |
| accepts at the app's 0.75 yaw-unknown gate: correct / wrong | 22: **22 / 0 (precision 1.00)** | 10: 10 / 0 |
| fused and cascade in the same cluster | **19 / 19 correct** | |
| product rule (fused HIGH and (EXIF or agreement with the cascade)) | **20 / 20 correct** (was 16 / 16) | |

**Yaw-unknown accepts in the 0.5–0.75 confidence band** (5 photos, which the 0.75 gate now rejects and the app escalates to fused):
- **wc_0007, wc_0080** (cascade correct): fused is HIGH and correct, so escalation recovers them.
- **wc_0068** (cascade correct): fused is LOW and wrong, so the photo becomes "please confirm".
- **wc_0043, wc_0097** (cascade wrong): fused is LOW, so they are correctly not accepted.

The net result of gate plus escalation is 2 of 3 correct recovered and 0 of 2 wrong accepted.
