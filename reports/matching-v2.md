# Matching v2: eye-position fallback, calibration priors, LoMa (dev only)

*2026-09-26 · (resumed after the ~16:02 UTC outage) · code in `tools/matcher/v2/` · research in `research_notes/matching_v2_research.md` (removed 2026-09-29; `git show 384df44:research_notes/matching_v2_research.md`)*

**Scope.** Only the 50 DEV ids of `tools/bench/split.json` were used. The spent test half was never opened, and no `data_v3` photo was opened, rendered or run. Verdicts come from the existing verified dev refs (`tools/bench/gt/t6`, through `stage1/evaluate.py`) plus the new blind pack in `tools/matcher/v2/verify/`. The frozen T6 rule was used unchanged (`292fb74f…`), and the pipeline code stamp was `c2d406ea3c557e6e`.

> **Status (2026-10-02):** a frozen dev study record. The LoMa-specific rule (recommendation 4) is roadmap R3 and waits on the H2 veto (R2), which waits on H1 blind verification (R1); see [terrain-matching-research.md](terrain-matching-research.md). In the app, the suggestion-only eye policy is followed by the "Check camera position" aid behind `?eyesearch=on|auto` (default off; `src/lib/gpu/eye/suggest.ts`), a skyline eye refinement, not this render-match fallback. The v2 code (`tools/matcher/v2/`) is offline Python; the browser matcher (`src/lib/matcher`) implements only `v034` and `t6`.

## Verdict

1. **The eye-position fallback does not earn auto-accept status.**
   - On dev, v2 adds **0 correct HIGH** and **1 gross HIGH**: wc_0086, a blind-verified near-miss at the moved eye.
   - Correct poses stay at 26/50. Product-rule accepts are unchanged at 12/12 correct.
   - Recommendation: the fallback should ship, if at all, as a LOW "try this viewpoint" **suggestion** and never as an accept.
2. **The suggestion path shows real signal.**
   - On wc_0074 the fallback moved the eye 225 m, and both blind verifiers judged the moved-eye pose **correct**.
   - The *same rotation* at the stated eye is a known-wrong ref (both verifiers again said wrong).
   - So this photo was an eye-position failure, and it is the first verified-correct pose for wc_0074 from any method.
3. **Most failures are not about the eye.**
   - 15 of the 30 non-HIGH dev photos have **zero** render-match support at the stated eye and at all 4–6 viewpoint candidates within 400 m.
   - A local eye search cannot fix those photos.
4. **Calibration priors (GeoCalib pitch, AnyCalib focal) are speed-only and near-neutral at best, so they stay OFF.**
   - The flags exist (`V2_PRIORS=pitch,focal`).
   - A GeoCalib pitch fan snapped to T6's own pitch grid keeps sky-search recall (24/30 vs 23/30 ref hits within 3°) and cuts the sky-stage time by about 40%. That stage is only about 10% of T6's time.
   - GeoCalib itself costs about 4.7 s per photo on CPU, which cancels the saving.
   - The free-phase fan (the first version) and the AnyCalib focal set both **lose** hits.
5. **LoMa in T6 under the frozen rule is not safe.**
   - On dev it makes **1 gross HIGH**: the known trap wc_0069 becomes HIGH-wrong.
   - HIGH goes from 19 correct / 0 wrong to 18 correct / 1 wrong.
   - It is also about 1.6× slower (median 134 s).
   - LoMa needs its own dev-calibrated rule before it can be an arm.

## 1. Method

### v2 = T6 at the stated eye, plus an eye-position fallback (`run_v2.py`)

1. **T6 at the stated eye.** Run T6 exactly as in `stage1/pipeline.run_photo` with the frozen rule. On dev the stamped T6 record is reused when its code stamp, lat/lon, matcher and priors all match (`V2_STATED_DIR`), so the v2 and T6 arms are identical at the stated eye by construction.
2. **Stop if HIGH.** If the stated-eye result is HIGH, it is final. The fallback never touches a HIGH.
3. **Otherwise, generate viewpoint candidates** with `viewpoints.candidates`. This is a photo-independent prior over where a photographer stands: open spots (the share of azimuths with a horizon beyond 1 km), plus the local high points within 100 m, 250 m and 400 m.
4. **Probe each candidate.** Run the T6 FOV-aware fine sweep (`pipeline.fine_sweep`) at each candidate and record its best window inlier count.
5. **Run full T6 at up to 2 eyes** (`EYE_TOP`), taking only eyes whose best inlier count is at least max(100, 3× the stated eye's best stage-1 inliers).
6. **Accept a moved-eye result only if:**
   - it is HIGH under the frozen rule *at that eye*;
   - its sweep support beats every other eye by 1.5×;
   - no strong candidate at any other eye (including the stated eye) lies more than 2° away.
7. **Safety fix.** A moved eye gets `positionSource: "moved"`, so it never inherits the EXIF exemption from the basin-gap check, the exemption through which T6's wc_0038 slipped. `positionTrusted` is always false for a moved eye.
8. **No HIGH anywhere.** The stated result is returned, and the best moved-eye result is exposed as `final.suggestion`.

**Negative result from before the outage (`_calib_eyes.py`).** Skyline scoring cannot locate the eye. On the 30 dev photos whose stated eye is known correct, the stated eye ranked at a median of 43rd of 113 grid eyes. That is why the candidates come from a viewpoint prior and render matching acts as the judge.

### Scoring (`score_v2.py`)

- **Stated-eye poses** inherit dev verdicts: within 0.5° of yaw and pitch, with the eye within 2 m.
- **Moved-eye poses** take the new blind verdicts, matched with the same tolerance and a 3-D eye within 2 m.
- **Product rule:** HIGH ∧ (EXIF ∧ eye not moved ∨ Mapterhorn cascade acc75 agrees at the same eye).
- **Looser rule:** HIGH ∧ (EXIF ∧ eye not moved ∨ basinGap ≥ 0.20).
- **Recall** is out of the 30 dev photos with any verified-correct pose. wc_0074's new correct suggestion is not an accept and does not change the denominator.

## 2. Dev results (50 photos)

| arm | correct | HIGH: correct / wrong / unsure | EXIF HIGH | product rule: correct/accepted, recall | looser rule: correct/accepted (wrong), recall | time per photo, median / p90 |
|---|---|---|---|---|---|---|
| T6 at the stated eye | 26 | 19 / 0 / 1 | 9/9 | 12/12, 12/30 | 19/20 (0), 19/30 | 85 s / 110 s |
| **v2** (T6 + eye fallback) | 26 | 19 / **1** / 1 | 9/9 | 12/12, 12/30 | 19/21 (**1**), 19/30 | **196 s / 432 s** |

- **Fallback activity:** on the 30 non-HIGH photos it ran a median of 214 s (p90 427 s, max 472 s).
- **Machine load:** the timings were taken while another v2 shard, the LoMa arm and other services were running (load average 10–17), so treat them as upper bounds.
- **Moved-eye runs:** full T6 was run at a moved eye on only 2 of the 30 photos (wc_0074, wc_0086). All the others were stopped by the 3× / 100-inlier gate.

**What the fallback saw (30 non-HIGH photos):**

| outcome | photos |
|---|---|
| 0 support at the stated eye and at every candidate eye | 15: wc_0005, 0010, 0013, 0015, 0034, 0035, 0037, 0040, 0052, 0053, 0055, 0073, 0087, 0095, 0098. Two of these (wc_0034, wc_0055) have a verified-correct pose at the stated eye, so for them this is a matching failure, not an eye failure. The LoMa oracle rescues wc_0034 (`loma/REPORT.md`) |
| some candidate eye beats the stated eye, but below the 3× gate | 8, including the known gross-error photos wc_0069 (629 vs 304, 2.1×) and wc_0001 (563 vs 207, **2.7×**, close to the gate) |
| gate passed, full T6 at the moved eye | wc_0086 (1611 vs 0, HIGH), wc_0074 (1689 vs 356, LOW, suggestion) |

- **The gate held for the gross-error photos:** it kept wc_0069 and wc_0001 out.
- **But its margin is thin:** wc_0001 would pass at a 2.5× gate. The gate is a safety device, not a detector.

**Eye probe (task 1, `eyeprobe.py`, resumed after the outage; `.cache/eyeprobe/`).** It covers 9 photos, 3 of them controls.

- **wc_0086:** 0 inliers at the stated eye → 1611 at the high point 25 m east.
- **wc_0095, 0023, 0040, 0098, 0053:** 0 at every eye, out to 400 m.
- **Controls:** on wc_0004 (3076 at the stated eye vs 2468 at the best alternative) and wc_0088 (1667 vs 637), the stated eye wins. On wc_0054, however, an eye 127 m away beats the stated eye (1066 vs 645) even though the stated-eye T6 pose is verified correct.
- **Conclusion:** sweep support is not a reliable eye locator, because distant scenery matches from many nearby eyes. This is why the fallback never runs on HIGH photos.

## 3. Blind verification of the moved-eye results (`tools/matcher/v2/verify/`)

**Protocol** (`PROTOCOL.md`, written before any verdict):
- Overlays from `build_pack.ts`, drawn on the Mapterhorn DEM at the exact eye used.
- A neutral "candidate XX" header (no pose numbers, eye, id or method), random labels and widths, and a hidden `key.json`.
- Fresh verifier agents, each with its own scratch dir holding only hashed photo folders, and the C1–C4 checklist.
- Controls: decoys at ±4–5° of yaw, duplicates, a verified-correct positive control (wc_0004 ref A), and a known-wrong ref.
- Raw verdicts are in `verify/raw/`, keyed in `verify/verdicts_keyed.json`.

**Round 1 (va, vb):**
- **wc_0074 (suggestion):** both correct. Its known-wrong stated-eye twin was called wrong by both, and the decoy was called wrong by both.
- **wc_0086:** va unsure, vb correct at moderate confidence. Both reported that the overlay's title bar **hid wc_0086's skyline**, which sits in the top 7% of the frame.
- That is a pack defect: the harness overlay draws its title bar over the photo, and the neutral header covers it.

**Round 2 (vc, vd, fresh):**
- **Pack fix:** the photo is padded with equal black bands top and bottom, and the vfov widened to match. This is exact for a centred pinhole: the line on the control photo reproduces to within 0.05% of height.
- **Result:** vc said correct (borderline on C2, 1–1.3% high on the right ridge). vd said **wrong, near-miss**: centre and left within 1%, but the right wooded ridge rises to 1.75% too high over the rightmost 12%.
- **Rule outcome:** "either wrong → wrong" makes the wc_0086 moved-eye HIGH **wrong**, a gross HIGH under the protocol. The rotation is right. A near-field ridge that is off by a little over the tolerance is what a slightly wrong eye position produces.
- **Stated eye:** the same pose drawn at the stated eye is wrong for all 4 verifiers, because the skyline lies entirely out of frame.

**Controls:**
- Positive control: judged correct 4/4.
- Yaw decoys: rejected 7/8. The eighth was va's round-1 decoy, marked unsure because of the occlusion.
- Duplicates: consistent 4/4 verifiers.

**Post-hoc observation (not applied, n = 1).** wc_0086's moved-eye HIGH was match-dominant only: the skyline cue disagreed by 14° (`cueAgreeDeg`), and `apriori` failed. Requiring `apriori` (both cues agree) for any moved-eye HIGH would have vetoed it. It would also leave v2 with no moved-eye HIGH at all on dev, so there is no dev evidence that a moved-eye accept rule can be both safe and useful.

## 4. Calibration priors (task 3; `priors.py`, `_prior_ab.py`, offline on cached edge maps)

**Set-up.** The T6 skyline global search (`skyglobal.search`) was run on all 50 dev photos from the cached pose-free edge maps. A "hit" means one of the top-4 hypotheses lies within 3° (|Δyaw| + |Δpitch|) of a verified-correct ref (30 photos). `priors.search` on the default grid reproduces `SkyGlobal.search` exactly on 50/50 photos.

| arm | hits of 30 (any of top-4 / top-1) | sky-stage time vs base (sum) | net |
|---|---|---|---|
| base (T6) | 23 / 19 | 1.00 (median 8.3 s) | — |
| GeoCalib pitch fan, free phase (the first version) | 19 / 19 | 0.81 | **loses** wc_0019, 0028, 0034, 0085. The truth lies inside the fan every time, but the shifted pitch sampling changes which yaw peaks survive |
| **GeoCalib pitch fan snapped to T6's pitch grid** | **24 / 19** | **0.59** | +wc_0071, no losses |
| AnyCalib focal set, focal-unknown photos only (7 with refs) | 3/7 vs base 4/7 | 0.57 | loses wc_0028 and wc_0067, gains wc_0046 |
| both | 3/7 | 0.43 | — |

- **Recommendation: keep both priors off** (`V2_PRIORS` unset).
  - The snapped pitch fan is neutral-or-better on this stage.
  - But the sky stage is 10–16 s of an 85–240 s run, and GeoCalib itself takes about 4.7 s on CPU (MPS differs from CPU on 9/63 photos, per `calib/REPORT.md`). So the net saving is about 0.
  - The priors are wired into `run_v2.py` as opt-in flags: they patch `SkyGlobal.search`, and `focal` also sets a single AnyCalib FOV in the eye-probe fine sweep.
  - No end-to-end dev run was made with them on, so enabling them needs one.
- **The brittleness is itself a finding.** The skyline search's top-k is sensitive to the pitch-grid phase: 4 of 23 hits flip.

## 5. LoMa inside T6 (orchestrator request; `V2_MATCHER=loma`, stated eye only)

`s1.correspond` is routed through `loma/matcher.correspond_loma` (LoMa-B, 4096 kp, MPS fp32). That covers the sweep40, fine-sweep, narrow and stage-2 verification matching. Everything else is T6 as frozen: generators, fusion, and the rule sha1 `292fb74f…`. The run covered all 50 dev photos, one process, with no errors.

| arm (stated eye, frozen rule) | HIGH: correct / wrong / unsure | gross HIGH | EXIF HIGH | product rule | looser rule | correct (inherited) | time, median / p90 |
|---|---|---|---|---|---|---|---|
| T6, ALIKED+LightGlue | 19 / 0 / 1 | 0 | 9/9 | 12/12, 12/30 | 19/20, 19/30 | 26 | 85 s / 110 s |
| **T6, LoMa** | 18 / **1** / 0 | **1 (wc_0069)** | 8/8 | 11/11, 11/30 | 18/19, 18/30 | 26 (+8 LOW poses pending) | 134 s / 203 s |

**HIGH changes, LoMa vs ALIKED:**
- **Lost** (the pose is still correct but now LOW), 3 photos:
  - wc_0004: basin gap 0.18 vs 0.21.
  - wc_0009 and wc_0027: matchSupport 0.64 and 0.67, below the match-dominant 0.70.
  - wc_0076 (unsure) also drops to LOW.
- **Gained**, 2 photos:
  - wc_0052: a new correct HIGH on a haze photo where ALIKED got nothing.
  - wc_0063: now HIGH, correct.
- **Gross error:** wc_0069 becomes HIGH. That is the known gross error that T6's ambiguity veto demotes under ALIKED. With LoMa, the pose (280.96, −8.59) sits on the known-wrong ref A. The cues agree (0.59°, 3.2 px, support 0.93, gap 0.25), and the competing strong candidate that triggered the veto no longer exists. This matches the caveat in `loma/REPORT.md`: stronger matching also strengthens wrong basins.

**Why:** the frozen thresholds were calibrated on ALIKED statistics. LoMa lifts more matches per view, including more off-pose ones, which lowers `matchSupport` on correct poses. It also changes which competing basins look "strong".

**Pending poses:** the 8 LOW LoMa poses that fall outside every verified cluster were not blind-verified. They are not accepts, so none of the HIGH or accept metrics depend on them.

**Conclusion:** LoMa is a better matcher (`loma/REPORT.md`), but **not a drop-in under the frozen rule**. On dev it makes one gross HIGH that ALIKED avoids, and it loses one net HIGH. Before it can be an arm it needs its own rule, calibrated on dev: match-dominant and strong thresholds on LoMa's support distribution, plus a re-check of the ambiguity veto. After that, a fresh blind pack. The v2 fallback was not run with LoMa: the stated-eye result already rules it out as a candidate default, and the orchestrator limited this session to one render worker.

## 6. Time cost

- **T6:** median 85 s, p90 110 s (stamped dev records).
- **v2:** HIGH photos cost the same as T6. For the 30 non-HIGH photos add a median 214 s (p90 427 s). Most of that is 4–6 fine sweeps at 25–35 s each, plus up to 2 full T6 runs at about 90–120 s each.
- **Overall v2:** median 196 s, p90 432 s per photo on this loaded M3 Pro.
- **LoMa T6:** median 134 s, p90 203 s. It needs about 10 GB of MPS memory, so it must run as one long-lived process.

## 7. Recommendation

1. **Keep the frozen T6 rule and the v034 policy default as they are.** Nothing in v2 is ready to become a default.
2. **Eye fallback:** ship it (if at all) only as a **suggestion** (`final.suggestion`: a LOW pose plus the moved eye, rendered at the moved eye), never as an accept. It must be opt-in because it costs about 3.5 min more per failed photo. On dev it gave 1 verified-correct suggestion (wc_0074) and 1 near-miss (wc_0086) out of 2.
3. **Priors:** leave them off.
4. **LoMa:** do not switch the matcher under the frozen rule, because of wc_0069. Next step: calibrate a LoMa rule on dev (support and strong thresholds, and the ambiguity veto), then run a fresh blind pack. Only then can it enter v3 as arm D.
5. **v3:** `reports/v3-prereg.md` is a draft for the user's decision. It pre-registers A = v034, B = t6, and C = v2 with moved-eye results **reported as suggestions only**, plus LoMa as a conditional arm.

## Files

- **Code:**
  - `tools/matcher/v2/run_v2.py`, with flags `V2_STATED_DIR`, `V2_MATCHER`, `V2_NO_FALLBACK`, `V2_PRIORS`, `V2_PORT`.
  - `viewpoints.py`, `eyeprobe.py`, `priors.py`, `_prior_ab.py`, `score_v2.py`.
  - `verify/build_pack.ts`, with `PACK_PAD=1`.
- **Results:**
  - `tools/matcher/v2/out/dev/` (per photo, `raw/`, `score.json`).
  - `out/dev_loma/`.
  - `.cache/eyeprobe/`.
  - `verify/{PROTOCOL.md, cands*.json, key.json, round2/key.json, raw/, verdicts_keyed.json, verdicts.json}`.
- **Scratch:** logs and `prior_ab.json` are in a local scratch directory.
