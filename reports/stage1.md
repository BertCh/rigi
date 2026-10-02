# T6: stage-1 search for ad-hoc photos (dev only)

*2026-09-26 · code in `tools/matcher/stage1/` · outputs in `tools/bench/t6/` · frozen rule sha1 `292fb74f35f6f402b5e81f1b832bac565edd6807` (`tools/bench/t6/RULE_FROZEN.sha1`)*

> **Status (2026-10-02).** T6 was scored once on the test half as arm B (30/50, HIGH 22/24; [test-addendum.md](test-addendum.md)) and shipped only as the opt-in policy `t6`; `v034` stays the default. The policy now runs in the browser (`src/lib/matcher/t6.ts`, `rule.ts`; `?matcherPolicy=t6`), ported from `tools/matcher/reference/t6.py`; the Python service of §10 was removed 2026-10-02 (8bb109d0). The §5 "known issue" selection refinement was not applied. This pipeline's own runner (`pipeline.py`, `s1.py`, the frozen worker snapshots in `stage1/vendor*`) is kept for study reruns; the snapshots were re-based on the deck engines (wave5/S1), so numbers are not expected to be bit-identical to the three.js-era runs, and a rerun is browser-unverified.

Scope: everything here uses only the 50 dev ids of `tools/bench/split.json`, plus the 12 app GT photos. Verdicts come only from `tools/bench/t6/dev_verdicts.json` (clusters plus `cascadeMapterhorn`) and from blind verdicts given later on dev poses (`tools/bench/t6/baseline_cpu_partial.json`, `verify_cpu_partial/`). No test photo was run, opened or scored. `pipeline.py` refuses test ids unless `--allow-test` is passed (`STAGE1_ALLOW_TEST=1` for `run.sh`).

## Verdict

| dev, 50 photos (final; all verdicts in, 0 pending) | GPU-era service (wild run, v2 verdicts) | CPU replay of the v0.3.4 service logic | **T6 (frozen rule)** |
|---|---|---|---|
| correct | 23 | 25 | **26** (+2 unsure) |
| HIGH: correct / wrong / unsure | 15 / **1** (wc_0069) / 0 | 16 / **1** (wc_0069) / 0 | **19 / 0 / 1** (wc_0076 unsure) |
| product rule, HIGH ∧ (EXIF ∨ Mapterhorn cascade@0.75 agrees) | 9 / 9 | 9 / 9 | **12 / 12** |
| fused/cascade agreement | 7 / 7 correct | 6 / 6 | 7 / 7 |
| median time per photo | 17–28 s (GPU LightGlue) | ≈ 35 s (arm A dry run 53–65 s) | **85 s** (p90 110 s), CPU LightGlue |

The blind pack (`tools/bench/t6/verify/verdicts.json`) came back: wc_0046, wc_0072 and wc_0094 correct (wc_0094 is a T6 HIGH), wc_0028 wrong (near-miss, roll), wc_0087 wrong. These 5 poses are shared by the replay and T6.

- **The a-priori HIGH set grows from 16 to 20 with no wrong HIGH among inherited verdicts.** Two of the 20 (wc_0094, wc_0076) have no clean verdict yet. The only gross error, wc_0069, goes LOW.
- **Correct poses: 23 (GPU-era) → 25 (CPU replay) → 26 (T6).** The replay gains come from deterministic CPU matching (+ wc_0046, 0072, 0094; − wc_0076, which moves to a pose verified unsure). T6 adds wc_0011, a new correct HIGH found by the fine sweep and the skyline search, which agrees with the blind-verified Mapterhorn cascade.
- **Stage-1 search is not the main blocker I expected (goal 1a).** At the verified-correct pose, ALIKED+LightGlue on the satellite render gets ≥ 30 inliers on **23 of 24** dev photos. Appearance (season, haze, lighting) is not what makes the sweep fail. The failures that are real search failures remain unsolved by every generator I tried, and the verified dev set can't tell whether they're solvable at all (25 dev photos have no correct pose from any method).
- **Two infrastructure bugs explain part of the "< 30 inliers" story.** Fixes are in the vendored copies, and they have been ported to the service:
  1. **LightGlue on MPS is non-deterministic.** Its point pruning (`width_confidence`) intermittently returns 0–17 matches instead of about 1000 on an identical pair after a pair of a different size. This is reproduced in isolation: 3/12 and 9/20 failures, against 0/20 on CPU or with pruning off. **6 of the 30 dev photos whose wild sweep had < 30 inliers reach ≥ 30 with deterministic matching.** Four of them (wc_0028, 0047, 0088, 0099) are photos where the sweep then finds the verified pose. The service now runs LightGlue on CPU (v0.3.x), and so does T6.
  2. **The ad-hoc route broke at 13:14 on 09-25.** The app switched to the `virtual:photos` module, so injected photos 404'd. The failure showed up as a 240 s page timeout. Fixed, with a 90 s fail-fast that captures the page console.
- **GT-12 (heading and gravity removed, pin GT): no false HIGH, 11/11 within 1° of yaw (ablation: 10/11), HIGH 9 (ablation: 7).** IMG_7018 is fixed: 105° → 0.20°, HIGH. But median |Δyaw| goes from 0.146° (replay) / 0.162° (ablation) to **0.196°**, because the frozen selection sometimes returns a different stage-2 solve in the same basin (IMG_6971 0.06 → 0.26°, IMG_7059 0.21 → 0.61°, LOW). See "Known issue" below.

## 1. Diagnosis (goal 1a): why does the 360° sweep find < 30 inliers?

`tools/matcher/stage1/diag.py` → `out/diag/*.json`, and `diag_report.py` → `out/diag_report.md`. There are 49 dev photos; wc_0055's page crashed on a dev-server reload.

**What the service sweep does.** It renders 9 views every 40° at pitch 0 and roll 0, at the request vfov (EXIF focal, else a 50° hfov). It solves one 2-point rotation RANSAC over the pooled matches, needs ≥ 30 inliers, and otherwise falls back to the app skyline seeds. For hfov < 25° it runs a separate narrow path.

Per dev photo with a verified-correct pose (24 of 49), I rendered views that remove one geometric error at a time, then matched with ALIKED+LightGlue (the service's matcher):

| test view | what it isolates | photos ≥ 30 inliers (of 24) |
|---|---|---|
| the sweep view nearest the true yaw (request vfov, level) | what the sweep saw | 17 |
| true yaw, level, request vfov | yaw coverage (40° step) | 20 |
| true yaw, level, true vfov | FOV mismatch | 20 |
| **true pose ("oracle")** | tilt (pitch/roll) | **23** |

Appearance at the oracle pose, by render style and matcher (photos ≥ 30 inliers, median inliers):

| style / matcher | ≥ 30 | median |
|---|---|---|
| aliked : satellite (service) | 23 / 24 | 585 |
| aliked : 50/50 satellite + hillshade blend | 23 / 24 | 632 |
| aliked : satellite @ 640 px / @ 1600 px | 23 / 24 | 488 / 587 |
| DISK : satellite | 19 / 24 | 600 |
| aliked : hillshade | 9 / 24 | 0 |
| DISK : hillshade | 5 / 24 | 0 |

**Categories for the 24 photos with a reference pose:**
- 17: the sweep is fine (under deterministic matching).
- 2: yaw coverage. wc_0014 and wc_0017 are narrow, 12–18° hfov.
- 2: tilt. wc_0019 and wc_0048 are narrow, with pitch or roll beyond the fan.
- 2: the pooled RANSAC picks a neighbouring view. On wc_0002 and wc_0006 the correct view has fewer inliers than a wrong one.
- 1: appearance. wc_0034 gets 0 inliers in every style.

**Of the 30 photos whose wild sweep had < 30 inliers,** 6 reach ≥ 30 with deterministic matching. The rest split into 8 narrow (hfov < 25°, served by the narrow path), 7 with unknown focal, and the unsolved photos. The unsolved ones are dominated by fog/haze, near-field terrain and winter.

**Season, haze and lighting do NOT prevent satellite matching at the right pose** on this set: 23/24 at the oracle, including winter photos (wc_0020, 0048, 0059, 0067, 0071, 0085, 0099). Hillshade renders are far worse, as `reports/matcher.md` found, and blending adds little (median +8 %).

**Licences** (nothing new downloaded):
- ALIKED: BSD-3-Clause.
- LightGlue and its weights: Apache-2.0.
- DISK: Apache-2.0.
- SuperPoint: not used.

## 2. Method (goals 1b–1e)

`tools/matcher/stage1/pipeline.py`. Per photo, on one warm page of a vendored snapshot of the v0.3.4 service (render worker + `core`/`fuse`/`assemble`, CPU LightGlue, SWEEP_KP 4096), there are four hypothesis generators:

| generator | what |
|---|---|
| `sweep40` | replay of the service sweep (baseline) |
| `appseeds` | replay of the service fallback: app `autoAlign` from 9 yaw × 3 pitch seeds, best score (baseline) |
| `narrow` | replay of the service `narrow_stage1` for hfov < 25° (baseline), other seeds with ≥ 30 inliers as extra hypotheses |
| **`sweepfine`** (1b) | FOV-aware sweep: views every max(8°, 0.5·hfov) at the photo's vfov (unknown focal: hfov 40° and 62°), and one rotation per window of 3 adjacent views, so a strong wrong view can't swallow the right one. Top 4 windows with ≥ 15 inliers. |
| **`sky`** (1d) | skyline-only global search. The app's own `scorePose` integrand (edge + P(sky) contrast; P(sky) from the pose-free colour model) is scored against the 360° DEM horizon over yaw (0.5°) × pitch ±15° × roll ±9° × FOV (EXIF ×{0.94, 1, 1.06}, else hfov 35–75°), all yaws at once via circular shifts. Top 4 NMS peaks, each polished by the app's coordinate descent. About 12 s, no renders. |

**Verification (1e).** Distinct hypotheses (2° dedupe), up to 6 per photo, each go through the service's own stage 2: a 5-view fan at the hypothesis, the skyline export, `correspond`, `assemble`, and the a-priori fusion checks. Hypotheses are ordered baseline first, then fine sweep and sky interleaved. For hand-placed positions, candidates that could become HIGH (a-priori HIGH, or support ≥ 0.5) also get the v0.3.4 basin gap (pose6 fast grid on the stage-2 cue and matches).

**What each generator contributed.** Selected sources on dev:

| source | picked | correct |
|---|---|---|
| sweep40 | 21 | 13 |
| appseeds | 16 | 1 |
| narrow | 10 | 7 |
| sky | 2 | 1 |
| sweepfine | 1 | 1 |

- The fine sweep and the skyline search each found wc_0011 (hfov 27°, pitch +15°), which no baseline generator reached.
- The skyline-only search is weak as a generator. Its top peaks on photos without a solution almost never get stage-2 match support, and on wc_0009 the true pose scores negatively under the pose-free sky model.
- Its value is as a cheap independent vote: one of its top 4 hypotheses lands within 3° of yaw of the verified-correct pose on 20 of the 23 dev photos where some candidate is correct (often duplicating a baseline hypothesis).

**Robustness.**
- A 900 s wall cap per photo, with the stage recorded (SIGALRM).
- 1 retry on dev-server reload (HMR reopen counter).
- An empty-horizon guard.
- A disk guard (≥ 3.5 GB).
- Every record is stamped with a content hash of the stage-1 code, the vendored snapshot and the knobs. All 50 dev records carry the stamp **`c2d406ea3c557e6e`** (LightGlue cpu, SWEEP_KP 4096, service snapshot `bef98c970614` = v0.3.4 `app.py`).

## 3. Frozen rule (goal 2), fixed before the final dev evaluation

sha1 of the block below: `292fb74f35f6f402b5e81f1b832bac565edd6807`, frozen 2026-09-26T07:20:31Z (`tools/bench/t6/RULE_FROZEN.sha1`, text in `RULE_FROZEN.txt`). `finalize.py` refuses to run if `rule.py`'s block hashes differently.

```
# Definitions, per verified candidate c (its stage-2 fused result, the service's own code path):
#   apriori(c)   = fusion.md a-priori HIGH: cueAgreeDeg < 1 ∧ skylineMedPx < 4 ∧ matchSupport ≥ 0.3
#   matchdom(c)  = "match-dominant": matchSupport ≥ 0.70 ∧ inliers ≥ 1000 (lifted matches within 6 px of the
#                  fused pose, 1024-px grid) ∧ fused pose within 0.3° (|Δyaw| + |Δpitch|) of the match-only pose
#   strong(c)    = matchSupport ≥ 0.5 ∧ inliers ≥ 300   (a competing basin with real match evidence)
#   gapOK(c)     = EXIF-GPS position, or basin gap ≥ 0.20 (pose6 grid on the stage-2 cue + matches; the v0.3.4
#                  service trigger, MATCHER_BASIN_GAP_MIN)
#   high(c)      = (apriori(c) ∨ matchdom(c)) ∧ gapOK(c)
# Selection:
#   1. if some candidate is high: among the high ones take the largest matchSupport·inliers;
#   2. else: the candidate with the largest matchSupport·inliers among strong ones;
#   3. else: the service's own stage-1 choice (the baseline candidate: sweep40 if ≥ 30 inliers, else the
#      app-skyline seed; narrow_stage1 for hfov < 25°).
# Confidence of the selected candidate s:
#   HIGH iff high(s) ∧ no ambiguity, where ambiguity = another verified candidate q with strong(q) whose fused
#   pose is > 2° (|Δyaw| + |Δpitch|) from s's fused pose.  Otherwise LOW.
AGREE_DEG, SKY_PX, SUPPORT = 1.0, 4.0, 0.3
MD_SUPPORT, MD_INLIERS, MD_MATCH_DEG = 0.70, 1000, 0.3
STRONG_SUPPORT, STRONG_INLIERS = 0.5, 300
GAP_MIN = 0.20
AMBIG_DEG = 2.0
```

**Honesty note.** The match-dominant thresholds and the ambiguity check were chosen by looking at dev candidates with inherited verdicts, from a run that preceded the stamped one (`out/runs/dev_pre_stamp`). They were frozen before the stamped dev run was evaluated and before any blind verification of new poses. Evidence against false HIGHs is thin:
- The only dev poses with support ≥ 0.5 and a wrong verdict are wc_0069 (0.93, but only 483 inliers), wc_0001 (0.60), wc_0070 (0.57) and wc_0074 (0.54).
- On the GT-12 synthetic wrong-GPS set, no variant qualifies. The best is IMG_7131@1 km at support 0.24.

**Why 8 correct dev poses were LOW (GPU-era wild rows) and what the rule does with them:**

| id | position | cueAgree° | skyMed px | support | match inl | failed checks | T6 |
|---|---|---|---|---|---|---|---|
| wc_0004 | hand | 1.77 | 6.37 | 0.93 | 7296 | agree, skyMed | **correct HIGH** (match-dominant, gap 0.21) |
| wc_0009 | EXIF | 3.13 | 11.6 | 0.75 | 2105 | agree, skyMed | **correct HIGH** (match-dominant) |
| wc_0085 | EXIF | 1.12 | 6.36 | 0.71 | 788 | agree, skyMed | **correct HIGH** (match-dominant, 1255 inl on CPU) |
| wc_0019 | hand | – | 2.10 | 0.13 | – | agree, support | **correct HIGH** (narrow replay: a-priori HIGH) |
| wc_0006 | hand | 6.96 | 2.92 | 0.12 | 302 | agree, support | correct LOW (support 0.71 but 0.3° off the match-only pose) |
| wc_0071 | EXIF | 2.20 | 7.05 | 0.32 | 12 | agree, skyMed | correct LOW |
| wc_0034 | hand | – | 4.02 | 0 | – | all three | correct LOW (0 matches in any style) |
| wc_0055 | EXIF | 16.8 | 4.55 | 0.01 | 9 | all three | correct LOW |

- **The skyline check is the blocker on 6/8 and cue agreement fails on all 8.** On these photos the app skyline cue (±25° autoAlign from the stage-2 prior) latches onto another ridge, while the match cue is strong and correct.
- **The new criterion accepts the match cue alone** when it is overwhelming (≥ 70 % support, ≥ 1000 inliers, fused pose = match-only pose). That recovers 3 of the 8. A fourth (wc_0019) is recovered by the narrow replay.
- **The ambiguity check is what demotes the gross error wc_0069.** Its basin gap on the CPU replay is 0.222, which passes the service's 0.20 trigger, and the v0.3.4 replay still makes it HIGH-wrong. But a second candidate with 0.65 support and 340 inliers sits > 2° away.

## 4. Accept rules (goal 3), dev

Precision = correct ÷ (correct + wrong) among accepts. Recall = correct accepts ÷ 30 dev photos with a verified-correct pose from any method. "Pend" means pending or unsure.

| pose set | product: HIGH ∧ (EXIF ∨ cascade@0.75 agrees) | HIGH ∧ (EXIF ∨ gap ≥ 0.15) | HIGH ∧ (EXIF ∨ gap ≥ 0.20) | HIGH alone |
|---|---|---|---|---|
| GPU-era wild (gap from T5 pose6 inputs) | 9 acc · **1.00** · 9/30 | 15 · 0.93 (wc_0069) · 14/30 | 14 · **1.00** · 14/30 | 16 · 0.94 · 15/30 |
| CPU v0.3.4 replay (gap from stage-2 inputs) | 9 · **1.00** · 9/30 | 17 · 0.94 (wc_0069) · 16/30 | 16 · 0.94 (wc_0069) · 15/30 | 17 · 0.94 · 16/30 |
| **T6 frozen rule** | 12 · **1.00** · 12/30 | 21 · **1.00** · 20/30 (+1 unsure) | 20 · **1.00** · 19/30 (+1 unsure) | 21 · **1.00** · 20/30 (+1 unsure) |

Recall denominator: 30 dev photos with any verified-correct pose (v2 clusters, Mapterhorn cascade, later blind verdicts).

- **The looser rule "HIGH + basin gap" is safe on dev only if the gap computation reproduces.** On T5's inputs, a 0.20 gap excludes wc_0069 (0.172). On the service's own stage-2 inputs, a CPU re-run gave 0.222, and it would be accepted. A threshold sitting at the noise level of its own statistic isn't a safety margin.
- **With T6's HIGH (which includes the ambiguity check), all gap variants are 1.00 on inherited verdicts,** and recall is 19–20 of 30 against 12 of 30 for the product rule.
- **Recommendation:** keep the product rule as the auto-accept. Evaluate "T6 HIGH ∧ (EXIF ∨ gap ≥ 0.20)" as the looser rule on test; it is the one this report pre-registers. Cascade agreement stays 7/7 correct on dev.

## 5. GT-12 (heading and gravity removed; pin GT, 11 photos; `gt12_eval.py`)

| | median \|Δyaw\| | \|Δpitch\| | \|Δroll\| | within 1° yaw | HIGH (false) |
|---|---|---|---|---|---|
| ablation fused, `both removed` (bench-ablation.md) | 0.162 | 0.121 | 0.303 | 10/11 | 7 (0) |
| CPU v0.3.4 replay (baseline candidate) | 0.146 | 0.124 | 0.308 | 10/11 | 8 (0) |
| **T6** | 0.196 | 0.124 | 0.274 | **11/11** | **9 (0)** |
| fusion.md, full metadata (reference) | 0.15 | 0.12 | 0.27 | 11/11 | 9 (0) |

Against `data/ground-truth.json` (12 photos):

| | median \|Δyaw\| | within 1° | HIGH (false) |
|---|---|---|---|
| ablation | 0.088° | 10/12 | 7 (0) |
| replay | 0.074° | 10/12 | 8 (0) |
| T6 | 0.191° | 11/12 | 9 (0) |

- IMG_7130 stays 1.95° off and LOW.
- With full metadata (heading and gravity known), T6 changes nothing: there is no stage 1, so it is the single fused stage of `fusion.md`.

**Known issue (for the service integration, not applied to the frozen rule).** The selection takes the candidate with the largest support × inliers even when it is the *same basin* as the baseline candidate. That swaps in a slightly different stage-2 solve: IMG_6971 +0.2°, IMG_7059 +0.4°, and the median yaw rises 0.05° on GT-12. A post-hoc fix would keep the baseline candidate's fused pose whenever the selected one lies within 2° of it. I have NOT applied it, because the rule is frozen for the test run.

## 6. Blind verification of new poses (done)

`tools/bench/t6/verify/` (index.json, key.json, verdicts.json): the 5 dev poses outside every verified cluster, shared by the CPU replay and T6. Verdicts: wc_0046, wc_0072, wc_0094 correct; wc_0028 wrong (near-miss, roll); wc_0087 wrong. No dev pose is pending.

**Inheritance rule.** A pose inherits a verdict only if it is within 0.5° of yaw and pitch **and** its eye is within 2 m of the verified pose's eye. The verified poses are:
- the dev v2 clusters;
- the blind-verified Mapterhorn cascade poses (`cascadeMapterhorn` src = blind);
- the partial CPU baseline's blind verdicts;
- the wc_0006 SWEEP_KP = 4096 verdict.

## 7. CPU vs GPU baseline (partial, as decided by the user)

**This baseline is partial: 12 of the 50 dev photos** (wc_0001 … 0017). The other 38 have no CPU baseline of the service and are compared only to GPU-era rows, labelled as such above. The "CPU replay" column in §3–4 is T6's own baseline candidate, the same v0.3.4 logic re-executed inside T6. It is not a run of the service.

| 12 photos | correct | HIGH (correct) |
|---|---|---|
| GPU-era | 5 | 2 (2) |
| CPU v0.3.4, SWEEP_KP 4096 | 5 | 2 (2) |
| T6 | **6** | **5 (5)** |

The SWEEP_KP attribution:
- **wc_0009:** 2048 keypoints drop the sweep to 19 inliers and give a wrong pose. At 4096 it keeps 32 inliers and the pose is correct.
- **wc_0006:** at 4096 the pose was blind-verified correct. At 2048 it was wrong.
- The default was reverted to 4096 in v0.3.4. Timings are in `tools/bench/t6/attr_kp/summary.json`.

## 8. Runtime (M3 Pro under heavy swap, shared dev server, CPU LightGlue)

| stage | median | p90 |
|---|---|---|
| edges + skyline global search | 12 s | 14 s |
| sweep40 replay | 10 s | 12 s |
| app seeds | 3 s | 31 s |
| fine sweep | 14 s | 34 s |
| verification (≤ 6 stage-2 solves + basin gaps) | 41 s | 63 s |
| **total per photo** | **85 s** | **110 s** |

The v0.3.4 service alone takes about 20–40 s per photo on this machine.

## 9. For the test run (lead)

```bash
STAGE1_ALLOW_TEST=1 tools/matcher/stage1/run.sh wc_XXXX wc_YYYY ...
#  → tools/bench/t6/out/<id>.json (final: pose, eye{lat,lon,h}, confidenceLevel HIGH|LOW, checks, source, baseline,
#    codeStamp, rule{id, sha1}) and tools/bench/t6/out/raw/<id>.json (all hypotheses + stage-2 results)
```

- **Needs:**
  - the dev server on :3100;
  - `tools/matcher/.venv` and the weights;
  - ≥ 3 GB free;
  - no other stage-1 or baseline batch running.
- **It starts one private headless worker** and closes it at the end (it never used the former matcher service).
- **Check `codeStamp.sha1 == c2d406ea3c557e6e`** on every output. Refresh the vendored snapshot only by re-running `make_vendor.py`, and only before the test run, since that changes the stamp.

## 10. Integration (done)

Ported into the service as policy `t6` in v0.4.0 (2026-09-26; [archive/matcher-service.md](archive/matcher-service.md)) and from there into the browser matcher (`src/lib/matcher`, 2026-10-02): fine sweep, multi-hypothesis stage 2 with the skyline global search, the §3 confidence (basin gap for every candidate that could become HIGH). Not applied: the post-freeze selection refinement (prefer the baseline candidate's fused pose within 2°). Latency was about +50 s per ad-hoc request in the Python version; the browser cost is not measured.

## Files

*In the repository: `pipeline.py`, `s1.py`, `skyglobal.py`, `rule.py`, `policy.py`, `evaluate.py`, `finalize.py`, `manifest_guard.py`, `run.sh`, `vendor/`, `vendor_v03/`. The other scripts listed below were never committed.*

- `tools/matcher/stage1/`:
  - `pipeline.py`: generators, verification, cap, stamp.
  - `s1.py`: worker client, photo handling, matching helpers, code stamp.
  - `skyglobal.py`
  - `rule.py`: frozen block.
  - `policy.py`, `evaluate.py`: inheritance incl. the eye rule.
  - `eval_rule.py`, `goal3.py`, `rules_compare.py`
  - `baseline_cpu.py`, `baseline_eval.py`: v0.3.x service copy on :8768.
  - `diag.py`, `diag_report.py`
  - `gt12_eval.py`, `finalize.py`, `analyze_dev.py`
  - `make_vendor.py`, with `vendor/` (patched snapshot) and `vendor_v03/` (pristine snapshot + fixes)
  - `probe_adhoc.mjs`
  - `run.sh`
  - `out/`: diag, runs/dev (stamped), runs/dev_pre_stamp, runs/gt12_none. 1.1 MB, renders deleted.
- `tools/bench/t6/`:
  - `out/` (final dev poses + raw)
  - `verify/` (pending pack), `verify_pack.ts`, `pending.json`
  - `RULE_FROZEN.sha1` / `.txt`
  - `baseline_cpu/` (12 partial CPU rows)
  - `attr_kp/`
  - `dev_verdicts.json` (read-only)

## 11. Test-run runner (`tools/bench/final/`)

`tools/bench/final/run_arm.sh <A|B|C> <ids...>` → `tools/bench/final/out/<arm>/<id>.json` + `run.log`:
- A = CPU replay of the v0.3.4 service logic (pipeline.run_photo with the T6-only generators off, baseline hypothesis only; HIGH = a-priori ∧ (EXIF ∨ gap ≥ 0.20)).
- B = T6 frozen (rule sha1 checked).
- C = T5 pose6 (rule text checked against `tools/bench/t5/RULE_FROZEN.sha1`) started from B's pose; pose6's re-matching runs on CPU LightGlue and the render worker is pinned to `stage1/vendor_v03`.
- One child process per photo in its own session, 600 s wall cap (timeout = no pose, not re-run), infra failures (crash, OOM, worker died, page not ready, disk) re-run at most twice with the same stamp, test ids only with `FINAL_ALLOW_TEST=1`.
- Dev dry run (wc_0014, wc_0019), in `tools/bench/final/dryrun_dev/`: all six records ok and HIGH; wall A 65/53 s, B 93/90 s, C 144/156 s. Code stamps: A `a63228f452fdbb75`, B `a5d380c36fcb0497`, C `fb97fbed958a7173` (A and B also carry the T6 pipeline stamp `c2d406ea3c557e6e`).
- Note: `tools/matcher/pose6.py` changed after the T5 freeze (file sha1 `f31f601f…` vs frozen `1ad03962…`: the service's fast basin-gap mode and a thread pool); the CONFIDENCE RULE text and its constants are identical, and arm C uses the default (non-fast) path.
