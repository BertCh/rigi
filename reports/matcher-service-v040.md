# Matcher service v0.4.0: T6 stage-1 search and frozen rule behind a policy switch

*2026-09-26 · code in `tools/matcher/server/` (`app.py`, `t6.py`, `render_worker.mjs`, `replay_final.py`) · method in `reports/stage1.md` · frozen rule sha1 `292fb74f35f6f402b5e81f1b832bac565edd6807`*

## Summary

- **What changed.** `POST /match` for ad-hoc photos now takes a `policy`:
  - `v034` (the default) is the v0.3.x search and confidence, meant to be unchanged from v0.3.5.
  - `t6` is `tools/matcher/stage1/pipeline.run_photo` ported onto the service's own worker and code path, with selection and confidence from `stage1/rule.py`.
  - You can set it per request (`policy`) or for the whole service (env `MATCHER_POLICY`).
  - At start the service asserts that the frozen rule block hashes to `292fb74f…`. If it doesn't, the service refuses to start.
  - The post-freeze "keep the baseline's fused pose within 2°" refinement (stage1.md §10.5) is **not** applied.
- **Replay proof (12 test-run records per arm, no tuning).**
  - **Confidence level: identical on 24/24** (A 12/12, B 12/12). The selected source also matches on every record.
  - **Pose within 0.01°: A 9/12, B 11/12.** All four misses (0.014 to 0.038°) are photos where stage 1 used the 40° sweep (`sweep40`).
  - These misses are the renderer's pre-existing run-to-run nondeterminism, not a code difference. On the same photos, **the v0.3.5 code itself differs from the records by up to 0.039°** (and v0.3.5 runs differ from one another by up to 0.047°). The recorded arms A and B, made by the same code, differ from each other by up to 0.038°. Details are in [Nondeterminism](#nondeterminism-the-renderer-not-the-port).
- **Deployment: :8765 has run v0.4.0 (default policy v034) since 2026-09-26T17:27:44Z.** The restart was accepted by the orchestrator despite wc_0044 (B) at 0.020°. See [Deployment](#deployment).

## Deployment

**Decision.**
- The written condition asked for every B pose to be within 0.01°. wc_0044 (B) is 0.020° off.
- The orchestrator accepted it as renderer noise. The v0.3.5 code reproduces the same 0.0202° offset against that B record, and levels and selected sources match on 24/24 replays. See [Nondeterminism](#nondeterminism-the-renderer-not-the-port).

**What was running before.**
- The old :8765 process (v0.3.5, pid 21978, up since 2026-09-25 22:34) had been broken since the ~16:02Z macOS access outage. Every `/match` returned `render_failed: browserType.launch: Target page, context or browser has been closed`, while `/health` said `renderer.alive: true`.
- Restarting the worker process from inside the service did not fix the same failure on :8766. Only a full process restart did.

**Restart.**
- `kill 21978` at 17:27:33Z, then `tools/matcher/server/run.sh --port 8765` (the same flags as before).
- Warm and listening at 17:27:44Z: about 11 s of downtime.

**Checks after the restart.**
- `/health`: `version` matcher-service/0.4.0, `policy.default` = `v034`, `renderer.browserOk` = true.
- photoId `IMG_4703`: 200 OK, 19 s.
- Ad-hoc (`photoPath`, v034): 200 OK, 57 s.
- The app's own request (IMG_3304) arrived during the check and returned 200.
- The :8766 dev instance was stopped at 17:29Z.

**New `/health` renderer probe (part of this restart).**
- A background thread sends the worker a `health` command every `MATCHER_RENDER_PROBE_S` (default 30 s) while the renderer is idle. The command launches the browser if needed, opens a throwaway context and page, and evaluates `1+1`. On the M3 this takes about 90 to 170 ms.
- `/health` only reads the cached result, so it never waits on the renderer.
- `renderer` now reports `{alive, process, browserOk, probeError, probeAgeS, probeMs, app}`. `alive` is false when the last probe failed.
- **When a probe fails, the top-level `ok` is false.** The app's `matcherAvailable()` then treats the service as down instead of sending requests into `render_failed`.
- Tested on :8766. With Chromium frozen (SIGSTOP), `ok`/`alive` went false with a timeout `probeError`. They went back to true on the next probe after SIGCONT.

**t6 timeout.** Callers opting into `policy: "t6"` must send `timeoutMs` ≥ 300000. The service default is 120 s, and t6 took 136 to 226 s per photo on the loaded machine.

## Replay equality

`tools/matcher/server/replay_final.py` builds each request from the same inputs `tools/bench/final` used:
- the photo after the harness normalisation;
- `meta {lat, lon, altitudeM, positionSource}`;
- `prior.vfov` when the focal is known, else no prior;
- `yawHint` = the weak heading;
- no yaw and no gravity.

It POSTs each request to the running service (:8766) with `policy` v034 (arm A) or t6 (arm B). It compares `confidenceLevel` and the selected pose with `tools/bench/final/out/<arm>/<id>.json`. It only reads that directory and writes its outputs to the scratch dir. The ids are 12 test ids, the same in both arms: 3 narrow, 3 app-seed and 6 sweep40 baselines in arm A. Test ids are refused unless `REPLAY_ALLOW_TEST=1` is set. Nothing was tuned on them.

| id | A level rec / svc | A source | A max \|Δ\|° | B level rec / svc | B source | B max \|Δ\|° |
|---|---|---|---|---|---|---|
| wc_0003 | LOW / LOW | narrow | 0 | HIGH / HIGH | sky | 0.0071 |
| wc_0007 | HIGH / HIGH | appseeds | 0 | HIGH / HIGH | appseeds | 0 |
| wc_0008 | HIGH / HIGH | narrow | 0 | HIGH / HIGH | narrow | 0 |
| wc_0018 | LOW / LOW | sweep40 | **0.038** | LOW / LOW | appseeds | 0.0018 |
| wc_0022 | LOW / LOW | appseeds | 0 | LOW / LOW | appseeds | 4e-7 |
| wc_0032 | LOW / LOW | appseeds | 0 | HIGH / HIGH | sweepfine | 0 |
| wc_0036 | LOW / LOW | sweep40 | 0.0076 | HIGH / HIGH | sweep40 | 0 |
| wc_0038 | LOW / LOW | sweep40 | 0 | HIGH / HIGH | sky | 0.0003 |
| wc_0044 | HIGH / HIGH | sweep40 | **0.014** | HIGH / HIGH | sweep40 | **0.020** |
| wc_0057 | HIGH / HIGH | sweep40 | 0.0077 | HIGH / HIGH | sweep40 | 0.0094 |
| wc_0080 | HIGH / HIGH | sweep40 | **0.018** | HIGH / HIGH | sky | 3e-7 |
| wc_0097 | LOW / LOW | sweep40 | 0.0084 | LOW / LOW | sky | 0.0046 |
| **total** | **12/12 levels** | 12/12 | **9/12 ≤ 0.01°** | **12/12 levels** | 12/12 | **11/12 ≤ 0.01°** |

- **Max |Δ|** is the largest of |Δyaw|, |Δpitch|, |Δroll| and |Δvfov| between the service's `pose` and the record's pose.
- **Wall time on the shared, loaded machine:** v034 44 to 137 s; t6 136 to 226 s.
- **The first B pass was interrupted.** wc_0038 to wc_0097 were first hit by the ~16:02Z access outage (`PermissionError` reading `stage1/rule.py`, then a dead Chromium).
  - The :8766 instance was restarted at 17:01Z with the same code, and those five were re-run. The table shows the re-run.
  - `tools/bench/final/out` was never written: its files still have their 06:10 mtimes, and `replay_final.py` only reads it.

## Nondeterminism: the renderer, not the port

Every pose miss is on a record whose stage 1 was the 40° sweep. That path makes the most fresh renders, and the difference already appears in the stage-1 sweep solve, before stage 2. For wc_0044 (B), the sweep has 225 inliers in both the record and the replay, but a pose 0.005° apart.

**What is deterministic.**
- ALIKED extraction on MPS: 6 repeated extractions of the same image are bit-identical, interleaved with other images or not.
- The RANSAC samplers are seeded (`default_rng(seed)`).
- The app-seed and narrow paths, which reuse the page's cached renders, replay at exactly 0 (7/7 in A).

**What is not deterministic: the rendered views.**
- These are headless-Chromium WebGL frames of the satellite-draped DEM.
- Keypoint counts on the same view differ between runs of the *same code and request*. On wc_0018, v0.3.5 gives 2514 / 2521 / 2496 ALIKED keypoints on view `y-20`. Since extraction is deterministic, the pixels differ.
- The likely cause is imagery-tile/texture state at render time (warm vs cold page, texture upload timing).
- In the T6 run, stage1.md §10.1 had already seen a cold first render come out untextured, which is why the vendored worker and policy t6 force `initTexture` + `gl.finish` after draping.

**Measured spread of the pre-existing code.**
- The v0.3.5 files were saved before the port. I ran them from a scratch mirror of the repo on :8767, same request as arm A, on the three A misses.
- The table below gives each run's max |Δ|° against record A. "Spread" is the largest pairwise difference among the v0.3.5 runs and both records, v0.4.0 not included.

| id | v0.3.5 run 1 | run 2 | run 3 | spread | v0.4.0 (v034) |
|---|---|---|---|---|---|
| wc_0018 | 0.013 | 0.026 | 0.034 | 0.047 | 0.038 |
| wc_0044 | 0.014 | 0.014 | – | 0.020 | 0.014 |
| wc_0080 | 0.039 | 0.000 | – | 0.039 | 0.018 |

- **Against the B record, the v0.3.5 runs are 0.0202° off on wc_0044.** That is the same offset v0.4.0 t6 shows there (0.0202°). The recorded B run's sweep40 happened to land in a slightly different state from all later runs.
- **In the records themselves** (tools/bench/final, same vendored code in both arms), the baseline sweep40 candidate differs between arm A and arm B by more than 0.01° on 6 of 23 sweep40 photos (max 0.038°, wc_0100).
  - On one photo the a-priori level flips: wc_0081 is `low` in A and `high` in B.
  - The app-seed (15) and narrow (12) baselines stay within 0.0092° and 0.0064°.

So 0.01° is below this renderer's run-to-run noise on sweep-seeded photos, for v0.3.5 as much as for v0.4.0. Levels were stable on all 24 replays, but the wc_0081 record shows they can flip near a threshold.

### Known render difference between v034 and the A records (intentional)

The records were made with the vendored v0.3.4 worker (`stage1/vendor/worker.mjs`). It **always** forces the texture upload after draping.
- v0.3.5's `render_worker.mjs` does not. The requirement is that v034 behaves exactly as v0.3.5, so v034 does not either.
- t6 always sends `texUpload: true`.
- `MATCHER_TEX_UPLOAD=1` turns the upload on for v034 too. It is off by default.

This does not explain the misses: the recorded arms differ from each other with the upload on, and v0.3.5 differs from itself with it off.

## Response schema (additions in v0.4.0)

Unchanged fields the app reads: `pose`, `confidence` (0.9/0.2), `confidenceLevel` ("high"/"low"), `confidenceChecks.{cueAgreeDeg, skylineMedPx, matchSupport, positionTrusted}`, `cues.{skyline, match}`, `method`, `version`.

**Every ad-hoc response adds:**
- `policy`: `"v034"` | `"t6"`.
- `policyNote`: set when t6 was requested but the request had heading, gravity and focal. Such a request has no stage 1, so the single fused stage runs with v034 confidence (as in stage1.md).

**`policy: "t6"` (two-stage) adds:**
- `rule: {id: "t6-rule-v1", sha1: "292fb74f…"}`.
- `selectedSource`: `sky` | `sweep40` | `appseeds` | `narrow` | `sweepfine`.
- `baseline: {source, pose, confidenceLevelApriori}`: the service's own stage-1 choice.
- `stage2Prior`: the selected hypothesis before stage 2.
- `lowReason`: the veto, when an a-priori-HIGH or match-dominant pose was made LOW.
- `confidenceChecks` adds:
  - `apriori`, `matchDominant`, `basinGap`, `gapOK`, `ambiguity` (count), `inliers`, `unmet` (list);
  - `veto` (`null` | `"basinGap"` | `"basinGap unavailable (…)"` | `"ambiguity"`);
  - `ambiguousWith[]`, when ambiguous;
  - `basinGrid`.
- `stage1` has these fields:
  - `baselineSeed`, `nCandidates`, `verified`, `maxVerify`;
  - `sweep40`, `sweepfine`, `sky`, `narrowStage1`, `horizonDirs`, `positionSource`;
  - `ignored`: request seeds are not generators under t6;
  - `attempts[]`: one whole-run retry on an infrastructure error or HMR page reopen;
  - `candidates[]`, one per candidate: `{source, alsoFrom, hypothesis, selected, baseline, pose, level, levelApriori, checks, basinGap, skyScore, ms}`.
- `/health` adds `policy: {default, available, t6Rule: {id, sha1}}`, and `renderer` gains `process, browserOk, probeError, probeAgeS, probeMs`. `ok` is false when the browser probe fails.

Example (wc_0032, t6, trimmed and rounded):

```json
{
 "ok": true, "pose": {"yaw": 164.978, "pitch": -4.201, "roll": -0.144, "vfov": 22.236},
 "method": "fused", "confidence": 0.9, "confidenceLevel": "high",
 "confidenceChecks": {"cueAgreeDeg": 0.133, "skylineMedPx": 0.625, "matchSupport": 0.544,
   "apriori": true, "matchDominant": false, "basinGap": 0.635, "gapOK": true, "ambiguity": 0,
   "inliers": 31, "unmet": ["matchDominant"], "veto": null,
   "basinGrid": {"step": 250.0, "best": {"E": 0, "N": 0, "cost": 315.91}, "second": {"E": 0, "N": -500, "cost": 516.43}},
   "positionTrusted": false},
 "cues": {"skyline": {"pose": {"…": "…"}, "residualPx": 0.674, "appConfidence": 0.913, "accepted": "confident"},
          "match": {"pose": {"…": "…"}, "inliers": 32, "residualPx": 3.344}},
 "selectedSource": "sweepfine",
 "baseline": {"source": "appseeds", "pose": {"yaw": 167.287, "pitch": -6.04, "roll": 0.298, "vfov": 29.569}, "confidenceLevelApriori": "low"},
 "stage1": {"baselineSeed": "appseeds", "nCandidates": 5, "verified": 5, "ignored": [],
   "candidates": [
     {"source": "appseeds", "alsoFrom": [], "selected": false, "baseline": true,
      "pose": {"yaw": 167.287, "pitch": -6.04, "roll": 0.298, "vfov": 29.569}, "level": "low", "levelApriori": "low",
      "checks": {"cueAgreeDeg": 2.98, "skylineMedPx": 2.674, "matchSupport": 0.043, "apriori": false, "matchDominant": false,
                 "basinGap": null, "gapOK": false, "ambiguity": 0, "inliers": 3, "unmet": ["apriori", "matchDominant", "basinGap"]}},
     {"source": "sweepfine", "alsoFrom": ["sky"], "selected": true, "baseline": false,
      "pose": {"yaw": 164.978, "pitch": -4.201, "roll": -0.144, "vfov": 22.236}, "level": "high", "levelApriori": "high",
      "checks": {"cueAgreeDeg": 0.133, "skylineMedPx": 0.625, "matchSupport": 0.544, "apriori": true, "matchDominant": false,
                 "basinGap": 0.635, "gapOK": true, "ambiguity": 0, "inliers": 31, "unmet": ["matchDominant"]}}, "…"]},
 "rule": {"id": "t6-rule-v1", "sha1": "292fb74f35f6f402b5e81f1b832bac565edd6807"},
 "policy": "t6", "version": "matcher-service/0.4.0 (…)"
}
```

v034 (wc_0080): `{"ok": true, "pose": {"yaw": 232.21, "pitch": 4.32, "roll": -2.161, "vfov": 43.965}, "method": "fused", "confidence": 0.9, "confidenceLevel": "high", "confidenceChecks": {"cueAgreeDeg": 0.682, "skylineMedPx": 1.882, "matchSupport": 0.659}, "policy": "v034", …}`. This has the same shape as v0.3.5 plus `policy`.

## How to run

```sh
tools/matcher/server/run.sh --port 8765                        # default policy v034
MATCHER_POLICY=t6 tools/matcher/server/run.sh --port 8766      # t6 by default (a request's "policy" still overrides)
curl -s localhost:8765/health | jq .policy
curl -s -XPOST localhost:8765/match -H 'Content-Type: application/json' -d '{"photoPath": "/abs/photo.jpg",
  "meta": {"lat": 46.5, "lon": 8.0, "positionSource": "manual"}, "policy": "t6", "timeoutMs": 400000}'
# replay proof (test ids: explicit opt-in; compares with tools/bench/final/out, which it only reads)
REPLAY_ALLOW_TEST=1 tools/matcher/.venv/bin/python tools/matcher/server/replay_final.py --port 8766 --arm B --out <dir> wc_0003 …
```

Env knobs:
- `MATCHER_POLICY` (`v034` | `t6`).
- `MATCHER_TEX_UPLOAD=1`: v034 texture upload, off by default.
- Unchanged from v0.3.5: `MATCHER_BASIN_GAP_MIN`, `MATCHER_TIMEOUT_MS` (default 120 s), `MATCHER_QUEUE_WAIT_S`, `APP_URL`.

## Caveats

- **Pose tolerance.** A 0.01° pose tolerance is below the renderer's run-to-run noise on sweep40-seeded photos: up to about 0.05° for v0.3.5 itself. Replays of those photos will not be bit-stable in any version until renders are made deterministic, for example by waiting for all imagery tiles and forcing the texture upload on every render.
- **Timeouts.**
  - t6 needs a larger `timeoutMs` than the 120 s default. It took 136 to 226 s per photo here, on a loaded machine with 5 to 19 GB of swap in use. stage1.md §8 measured a median of 85 s unloaded.
  - A client that keeps the default will get 504s under t6.
- **Queue ETA** for t6 uses the stage1.md §8 typical durations. Under load it underestimates.
- **Rule hash reporting.** `rule.sha1` in responses and `/health` is re-read from `stage1/rule.py` on each call. The start-time assert is what guarantees the loaded rule. If someone edits `rule.py` while the service runs, the reported hash could diverge from the code in memory. The start-time assert catches this on the next restart.
- **Coverage.** Only 12 test ids per arm were replayed, covering all five stage-1 sources (sky, sweep40, appseeds, narrow, sweepfine).
