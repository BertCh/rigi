> **Archived 2026-10-02:** the Python service this describes was removed. Render-and-match now runs in the browser (`src/lib/matcher`, behind `src/lib/matcher-client.ts`); the Python modules it was ported from are offline reference code in `tools/matcher/reference/`. Paths under `tools/matcher/server/` below no longer exist.

# Render-and-match service (optional escalation tier)

A small local HTTP service (default :8765, `tools/matcher/server/`, client `src/lib/matcher-client.ts`) that renders satellite-draped DEM views with a headless Chromium, matches them to the photo (ALIKED + LightGlue) and fuses that with the app's skyline cue (`tools/matcher/fusion.py`, method in [fusion.md](../fusion.md)). Current version **v0.4.0**. Since v0.4 an ad-hoc `POST /match` takes a `policy`: `v034` (default, the v0.3.x search and confidence) or `t6` (the T6 stage-1 search and frozen rule, method in [stage1.md](../stage1.md)). This file merges the former v0.4.0 note and the v0.2 to v0.3.5 document.

> **Update (2026-10-01):** the render worker no longer drives the three.js PhotoEngine (removed 583e2b7). Its pages open on `?renderer=deck` by default (`MATCHER_RENDERER=deck|webgpu|auto`) and the views come from the engine's offscreen hooks (`loadSatellite` / `renderPoseView` / `loadFullTerrain`, 5dbdfc5); see the header of `tools/matcher/server/render_worker.mjs`. Escalation in the app lives in `src/lib/integration/second-opinion.ts` (cascade first, then `matchAccepted`), not in `PhotoWorkspace.tsx` as the old "Note for the app owner" proposed. The latency, nondeterminism and replay numbers below were measured on the three.js renderer and have not been repeated on the deck renderer.

## Running it

```sh
# dev server must be on :3100 for photoId mode (npm run dev -- --port 3100)
tools/matcher/server/run.sh                                      # http://127.0.0.1:8765, default policy v034
tools/matcher/server/run.sh --port 8765 --host 127.0.0.1 --no-warm-renderer
MATCHER_POLICY=t6 tools/matcher/server/run.sh --port 8766        # t6 by default (a request's "policy" still overrides)
curl -s localhost:8765/health | jq .policy
curl -s -XPOST localhost:8765/match -H 'Content-Type: application/json' -d '{"photoPath": "/abs/photo.jpg",
  "meta": {"lat": 46.5, "lon": 8.0, "positionSource": "manual"}, "policy": "t6", "timeoutMs": 400000}'
# replay proof (test ids need explicit opt-in; compares with tools/bench/final/out, which it only reads)
REPLAY_ALLOW_TEST=1 tools/matcher/.venv/bin/python tools/matcher/server/replay_final.py --port 8766 --arm B --out <dir> wc_0003 …
```

Stop with Ctrl-C or `pkill -f tools/matcher/server/app.py`. The app side reads `VITE_MATCHER_URL` (default `http://localhost:8765`). No dependencies beyond `tools/matcher/.venv` (stdlib `http.server`) and the repo's Playwright; weights come from `tools/matcher/weights`, nothing is downloaded. Temporary renders and the skyline export go to `$TMPDIR/matcher-*` (about 48 MB for 5 views plus 2.5 MB of skyline maps) and are deleted after each request; nothing is written to `tools/matcher/out/`.

**Environment variables** (checked against `app.py`, `core.py`, `render_worker.mjs`, `t6.py`, `pose6.py` on 2026-10-01):

| variable | default | effect |
|---|---|---|
| `MATCHER_HOST` / `MATCHER_PORT` | `127.0.0.1` / `8765` | bind address; `--host`/`--port` override, and the port is passed to the worker, which blocks its pages from calling back into it |
| `APP_URL` | `http://localhost:3100` | the app the render pages load |
| `MATCHER_CORS` | `http://localhost:3100,http://127.0.0.1:3100` | comma list of allowed origins |
| `MATCHER_POLICY` | `v034` | service-wide default policy (`v034` or `t6`); anything else refuses to start |
| `MATCHER_TIMEOUT_MS` | `120000` | default request timeout |
| `MATCHER_QUEUE_WAIT_S` | `5` | how long the single waiter waits for the job lock before `503 busy` |
| `MATCHER_TARPIT_S` / `MATCHER_TARPIT_MAX` | `2` / `16` | hold for a ticketless busy 503, and the cap on held ones |
| `MATCHER_RENDER_PROBE_S` | `30` | idle-renderer health probe period |
| `MATCHER_RENDER_HUNG_S` | `300` | no worker output for this long with a command outstanding: kill and restart the worker |
| `MATCHER_BASIN_GAP_MIN` | `0.20` | basin-gap LOW threshold (v034, untrusted position); roadmap N4 flags it for re-derivation |
| `MATCHER_SWEEP_KP` | `4096` | keypoint cap for stage-1 searches |
| `MATCHER_LG_DEVICE` | `cpu` | LightGlue device (ALIKED stays on MPS) |
| `MATCHER_TEX_UPLOAD` | off (`1` = on) | force the texture upload plus `gl.finish` after draping for v034; t6 always does |
| `MATCHER_MAX_PAGES` | `1` | warm `/photo` pages in the render worker (each draped page holds about 1 to 1.5 GB in Chromium) |
| `MATCHER_DRAPE_FULL_M` | `40000` | full-terrain (360°) pages drape only tiles within this range (override per request with `drapeMaxM`) |
| `MATCHER_RENDERER` | `deck` | the `?renderer=` the worker's pages open on: `deck`, `webgpu` or `auto`; any other value throws |
| `MATCHER_HORIZON_PRECISION` / `MATCHER_ALIGN_PRECISION` | unset | `f64` or `certified-f32`, passed as `?horizonPrecision=` / `?alignPrecision=` (for `scripts/gpu/precision-gate.mjs`); replies carry `meta.pageFlags` and, when set, the `precision` path each stage took |
| `T6_GPU_GRID` | off (`1` = on) | t6 only: the worker's `edges` command also returns the WebGPU skyline-grid candidate cells, re-scored exactly in numpy (`sky_gpu.py`) |
| `T6_GPU_IDLE_MS` | `120000` | worker, with `T6_GPU_GRID=1`: idle time before the grid's GPU resources are released |
| `POSE6_GRID_THREADS` | `6` | basin-gap grid thread pool; on a busy host set 2 |
| `MATCHER_DEBUG_HOOKS` | off (`1` = on) | test hook that reloads the page before view N |
| `REPLAY_ALLOW_TEST` | off | `replay_final.py` only: allow test ids |

Files in `tools/matcher/server/`: `app.py` (HTTP server, validation, timeouts, CORS, response assembly), `core.py` (matching and legacy solve, imports from `../match.py`), `fuse.py` (in-memory replay of `fusion.solve_photo()`; `../fusion.py` and `../match.py` are not modified), `t6.py` (policy t6), `sky_gpu.py` (opt-in GPU grid), `render_worker.mjs` (persistent Chromium plus warm `/photo` pages; exports satellite renders, xyz buffers and the skyline cue), `replay_final.py`, `run.sh`.

## API

Errors look like `{ok:false, error:{code, message}, version}`:

| status | code | meaning |
|---|---|---|
| 400 | `bad_request` / `bad_image` / `bad_render` | invalid input; `bad_render` means an xyz buffer doesn't reproject under its own pose |
| 404 | `unknown_photo` / `not_found` | photo or route not found |
| 413 | `too_large` | body over 200 MB |
| 502 | `render_failed` | the render step failed |
| 503 | `busy` | still queued when the timeout ran out |
| 503 | `renderer_died` | the render worker exited |
| 504 | `timeout` | the request timed out |
| 500 | `internal` | unexpected server error |

Jobs are serialised (one GPU, one renderer): at most 1 job runs and 1 waits.

### `GET /health`

Returns `{ok, device:"mps", version, models:{extractor, matcher, fusion, warm, warmupMs}, renderer:{alive, process, browserOk, probeError, probeAgeS, probeMs, app}, policy:{default, available, t6Rule:{id, sha1}}, queue:{waiting, etaS, tickets, running:{stage, elapsedS}|null}, busy, uptimeS, requests}`.
- A background thread sends the worker a `health` command every `MATCHER_RENDER_PROBE_S` while the renderer is idle. It launches the browser if needed, opens a throwaway context and page and evaluates `1+1` (about 90 to 170 ms on the M3). `/health` only reads the cached result.
- **When a probe fails the top-level `ok` is false** and `renderer.alive` is false, so the app's `matcherAvailable()` treats the service as down. Tested with Chromium frozen (SIGSTOP): false with a timeout `probeError`, true again on the next probe after SIGCONT.
- `queue.etaS` is the seconds until a new job could start (null when idle).

### `POST /match`, mode (a): JSON (dev server only)

```json
{"photoId":"IMG_7155","prior":{"yaw":225.6,"pitch":-7.84,"roll":-1.28,"vfov":53.06},
 "fused":true, "offsets":[-20,-10,0,10,20], "timeoutMs":60000}
```

The server sets `engine.prior`, runs `autoAlign(true)` and applies the acceptance rule of `export_skyline.mjs`, renders views at `prior.yaw + offsets`, matches `public/photos/<ID>.jpg` and fuses. It drives `localhost:3100/photo/<ID>`, hence dev only. Ad-hoc requests send `photoPath` plus `meta {lat, lon, altitudeM, positionSource}` and optional `prior`, `yawHint`, `yawSeeds` / `poseSeeds` (at most 4; search hints), `policy`, `timeoutMs`.

### `POST /match`, mode (b): `multipart/form-data`

| part | content |
|---|---|
| `request` | JSON `{prior, eye:[x,y,z], views:[{tag, pose, W, H}], fused?, photoId?, skyline?: {w, h, pose, confidence?, accepted?}, timeoutMs?}` |
| `photo` | JPEG or PNG |
| `rgb:<tag>` / `xyz:<tag>` | the satellite render, and float32 LE H×W×3 ENU (rows top to bottom, sky = 0) |
| `skyline:horizon` / `skyline:fine` / `skyline:fg` / `skyline:sky` | optional float32: `engine.horizonDirs`, and `edge.fine`, `edge.fg`, `edge.sky` after `autoAlign` (w×h, row 0 = top) |

The skyline cue comes from the first source available: the `skyline:*` parts; else, if `photoId` is given, the worker exports it from the app; else none, and the response is `method:"render-match"`, `confidenceLevel:"low"`.

### Response (fused)

`confidence` stays a number (HIGH 0.9, LOW 0.2, so `m.confidence < 0.5` still gates); `{fused:false}` returns the v0.1 response plus `method:"render-match"` (confidence then the old 0 to 1 heuristic, no `confidenceLevel`). Real response (IMG_7155, warm, v0.2):

```json
{"ok":true,"method":"fused",
 "pose":{"yaw":235.918,"pitch":-8.391,"roll":-3.851,"vfov":52.513},
 "confidence":0.9,"confidenceLevel":"high",
 "confidenceChecks":{"cueAgreeDeg":0.175,"skylineMedPx":0.704,"matchSupport":0.909},
 "cues":{"skyline":{"pose":{"yaw":235.849,"pitch":-8.356,"roll":-3.756,"vfov":52.33},"residualPx":0.761,"appConfidence":0.874,"accepted":"confident"},
         "match":{"pose":{"yaw":235.944,"pitch":-8.504,"roll":-3.772,"vfov":52.629},"inliers":2893,"residualPx":3.159}},
 "fusionScore":0.704,"fusedFrom":"match","matchConfidence":1.0,
 "inliers":2810,"inlierFrac":0.908,"nLifted":3093,"residualPx":2.917,"coverage":0.5,
 "deltaYawFromPrior":10.32,"focalPx":778.45,"size":{"W":1024,"H":768},"perView":["..."],
 "vsGroundTruth":{"dYaw":-0.292,"dPitch":0.05,"dRoll":0.303,"pinPx":1.682},"eye":[0,0,1936.051],
 "timingMs":{"render":1014,"loadMs":0,"imageryMs":1,"skylineMs":214,"renderMs":797,"warmPage":true,"draped":false,
             "match":2308,"solve":418,"fusion":3400,"total":7175},
 "version":"matcher-service/0.2 (fused skyline+render-match via fusion.py, λ=1; aliked-n16+lightglue on sat renders)"}
```

- **`pose`** is the fused pose, focal refined behind fusion's 5 % EXIF prior. **`inliers`, `inlierFrac`, `residualPx`, `coverage`** are match statistics at the fused pose (lifted matches within 6 px, and their RMS).
- **`confidenceChecks`** are the three quantities of the a-priori rule (`fusion.md`): `cueAgreeDeg` (rotation angle between the skyline-only and match-only solutions), `skylineMedPx` and `matchSupport` (at the fused pose). **HIGH** iff the cues agree within 1°, the skyline median residual is under 4 px and at least 30 % of matches are within 6 px.
- **`cues.skyline.pose`** is the app's `autoAlign` answer after the acceptance rule; **`cues.match.pose`** is fusion's match-only LM pose (its `inliers` and `residualPx` are the RANSAC inliers and RMSE). `fusionScore` is `fusion.md`'s continuous summary (the leaderboard confidence); `matchConfidence` is the v0.1 heuristic.
- **No skyline cue:** `method:"render-match"`, `confidenceLevel:"low"`, `confidence:0.2`, `cues.skyline:null`, `skylineUnavailable:"<reason>"`.
- **Basin-gap fields** (ad-hoc, v0.3+): `confidenceChecks.basinGap`, `.positionTrusted`, `.basinGrid`, `timingMs.basinGap`, and `lowReason` when the gap forced LOW. Responses also carry `timing.imageryRetries`, `imageryMissing`, `emptyViewRetries`, `renderRetried`.

### Policy (v0.4)

`policy` is per request or service-wide (`MATCHER_POLICY`).
- **`v034`** (default): the v0.3.x search and confidence, meant to be unchanged from v0.3.5. Responses have the same shape plus `policy`. Example (wc_0080): `{"ok": true, "pose": {"yaw": 232.21, "pitch": 4.32, "roll": -2.161, "vfov": 43.965}, "method": "fused", "confidence": 0.9, "confidenceLevel": "high", "confidenceChecks": {"cueAgreeDeg": 0.682, "skylineMedPx": 1.882, "matchSupport": 0.659}, "policy": "v034", …}`.
- **`t6`**: `tools/matcher/stage1/pipeline.run_photo` ported onto the service's own worker and code path, with selection and confidence from `stage1/rule.py`. At start the service asserts that the frozen rule block hashes to `292fb74f35f6f402b5e81f1b832bac565edd6807` (and matches `tools/bench/t6/RULE_FROZEN.sha1`); otherwise it refuses to start. The post-freeze "keep the baseline's fused pose within 2°" refinement (stage1.md §10.5) is **not** applied. A request with heading, gravity and focal has no stage 1: the single fused stage runs with v034 confidence and `policyNote` says so. **Callers opting into t6 must send `timeoutMs` >= 300000** (the default is 120 s; t6 took 136 to 226 s per photo on a loaded machine, median 85 s unloaded per stage1.md §8; a client that keeps the default gets 504s).

Fields added in v0.4.0. Every ad-hoc response: `policy`, `policyNote`. `policy:"t6"` adds:
- `rule: {id: "t6-rule-v1", sha1: "292fb74f…"}`; `selectedSource` (`sky` | `sweep40` | `appseeds` | `narrow` | `sweepfine`); `baseline: {source, pose, confidenceLevelApriori}` (the service's own stage-1 choice); `stage2Prior` (the selected hypothesis before stage 2); `lowReason` (the veto, when an a-priori-HIGH or match-dominant pose was made LOW).
- `confidenceChecks` adds `apriori`, `matchDominant`, `basinGap`, `gapOK`, `ambiguity` (count), `inliers`, `unmet` (list), `veto` (`null` | `"basinGap"` | `"basinGap unavailable (…)"` | `"ambiguity"`), `ambiguousWith[]`, `basinGrid`.
- `stage1`: `baselineSeed`, `nCandidates`, `verified`, `maxVerify`, `sweep40`, `sweepfine`, `sky`, `narrowStage1`, `horizonDirs`, `positionSource`, `ignored` (request seeds are not generators under t6), `attempts[]` (one whole-run retry on an infrastructure error or HMR page reopen), `candidates[]` with `{source, alsoFrom, hypothesis, selected, baseline, pose, level, levelApriori, checks, basinGap, skyScore, ms}`.

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

### Queue tickets (v0.3.4)

- Every `503 busy` carries a ticket (`X-Queue-Ticket` header and JSON `ticket`) with `Retry-After` (also `retryAfterS`). Retry: sleep `Retry-After` seconds, resend the same request (JSON or multipart) with `X-Queue-Ticket: <ticket>`. A presented ticket is **active**; a retry that presents one keeps it (same ticket and a fresh `Retry-After` if still busy).
- Order: the job and the single waiter slot go to the **oldest active ticket**. A request with no ticket or a newer one gets a 503 while an older active ticket exists, even if the service is idle for a moment. A ticket never presented blocks nobody, so a client that ignores tickets cannot clog the queue.
- Expiry: 2 × `Retry-After` + 15 s after it was last issued; consumed when served. `Retry-After` = the stage-based ETA of the running job (plus a queued waiter) plus the typical duration of every older active ticket's job, rounded up, capped at 60 s.
- CORS: `Access-Control-Allow-Headers: Content-Type, X-Queue-Ticket`; `Access-Control-Expose-Headers: Retry-After, X-Queue-Ticket` (preflight checked: 204 with both).
- A busy 503 for a request without a ticket is held up to `MATCHER_TARPIT_S` (v0.3.5; max `MATCHER_TARPIT_MAX` at once, the rest answered at once), and those 503s are summarised in the log every 30 s instead of one line each.
- ETA table (`STAGE_SEQ`, typical seconds): photoId = render 10, match 6, solve 0.5, fusion 3; ad-hoc = render 25, match 7, solve 1, render 12, match 6, solve 0.5, fusion 3, basinGap 8, release 1. The estimate = the running stage's remaining typical time (at least 20 % of it and 1 s) + typical time of the later stages + the full typical time of any queued job, capped at the running job's deadline. A stage that overran is expected to need about as long again (`OVERRUN_FACTOR = 1.0`); a slow job scales the remaining stages by elapsed ÷ typical-so-far, up to 3×. The t6 ETA uses the stage1.md §8 durations and underestimates under load.

### TypeScript client (`src/lib/matcher-client.ts`)

```ts
matcherAvailable(force?: boolean): Promise<boolean>
requestMatch(req: MatchRequest, opts?: { signal?: AbortSignal; timeoutMs?: number /* 60000 */ }): Promise<MatchResult | null>
matchIsConfident(m: MatchResult): boolean   // confidenceLevel === 'high', else (old servers) confidence >= 0.5
shouldEscalate({ skylineConfidence, skylinePose, altSkylinePose?, minConfidence = 0.5, maxSolverDisagreeDeg = 1 }): boolean
type MatchRequest =
  | { photoId: string; prior: Pose; offsets?: number[]; fused?: boolean; freeFocal?: boolean }
  | { photo: Blob; prior: Pose; eye: [number, number, number]; views: MatchView[]; skyline?: SkylineCueInput; photoId?: string; fused?: boolean }
```

- `MatchResult` has the optional fields `method`, `confidenceLevel`, `confidenceChecks`, `cues`, `fusionScore`, `matchConfidence`, `skylineUnavailable`. The client returns `null` (never throws) when the service is down, times out, is aborted, returns an HTTP error or finds no pose.
- `shouldEscalate` no longer compares against the compass prior (that fired on about half the photos). It escalates when there is no skyline result, skyline confidence is below 0.5, or an optional second skyline solver disagrees by more than 1° in yaw or pitch.
- **Apply a match only when `confidenceLevel === "high"`** (`matchIsConfident`). On the pin set, 23 of 33 cases were HIGH and all within 1°; LOW cases (e.g. IMG_7086, IMG_7059, wrong GPS) keep the skyline pose. The match takes about 6 s warm and 16 to 20 s on a cold page, so show the skyline pose first and upgrade it. For a LOW result with a failed skyline (`cues.skyline.accepted === 'prior'`) and many match inliers, "terrain match suggests yaw X" can be shown without applying it (IMG_7086 is the example). Prod needs the multipart form (`requestMatch({photo, prior, eye, views, skyline})`, with `skyline = {w, h, pose, confidence, horizon, fine, fg, sky}` captured right after `autoAlign(true)`).

## Changelog

**v0.1** (render-match only, `fused:false`): IMG_7155 yaw 236.04 to 236.07 (Δyaw −0.16 vs the pin GT), IMG_7086 162.68 to 162.77 (Δ +0.11 to +0.13). Warm 3.0 to 4.2 s, cold page 12 to 15 s. Inlier counts vary between identical requests (859 to 3075) while the pose stays within 0.03°, because tiles stream in after `[data-ready]`.

**v0.2** (2026-09-25, fused): `POST /match` returns the fused pose of `fusion.py`'s joint Huber LM over rotation + focal, using the app's skyline cue and the ALIKED + LightGlue matches against satellite-draped DEM renders. The client still sends only `{photoId, prior}`; the server computes the skyline cue itself (headless page, `autoAlign(true)` from the prior, exports `horizonDirs`, `edge.fine/fg/sky`) and renders the 5 views. Reproduces fusion.py: offline bit-exactly (Δ = 0.00000° on every angle, 7155, 7086, 7131, 7108 at shifts 0 and +15, all levels match); live end to end within 0.005° of `results-fusion.json` on yaw/pitch/roll for 7155, 7086, 7131 (budget 0.05°). Latency: the in-page skyline export adds about 0.2 s and fusion's CPU solve 2.7 to 3.5 s (up to 5.4 s cold), so warm about 6.2 s fused against about 3.0 s for `fused:false`; cold page 16 to 21 s; the first request after the dev server idles can take about 55 s (Vite compiling).

**v0.3** (2026-09-25, T5 follow-up):
- **LightGlue on the CPU** (`MATCHER_LG_DEVICE=cpu`; ALIKED stays on MPS). On MPS the same photo/render pair intermittently gave wrong results under GPU/memory contention (0, 2 or 13 matches instead of about 900, or spurious extras, 236 instead of about 49; 11 of 25 views in 5 sequential requests). The renders were fine (the "cold-page readiness race" was the matcher); turning off flash attention did not fix it. The CPU path is deterministic and costs about 1.6 s per view pair (+3 to 4 s for 5 views, +7 s for the 9-view sweep).
- **Imagery readiness**: after the drape every tile in range must carry its texture, else it is re-draped (up to 2 retries); 0 missing tiles in all tests.
- **ENOENT crash fixed**: ad-hoc photo bytes are held in memory for the page's lifetime, every route handler is wrapped, global `unhandledRejection`/`uncaughtException` loggers keep the worker alive, and `app.py` sends a `release` command when an ad-hoc request finishes. Test: render, delete the temp dir, reload the page; the reload succeeded and `ping` answered.
- **Memory**: after every job `gc.collect()`, `torch.mps.empty_cache()` and `malloc_zone_pressure_relief` (macOS); the python process had been at 2.9 to 4.5 GB RSS (physical footprint about 0.47 GB, the rest freed CPU attention buffers and the MPS cache). `MATCHER_MAX_PAGES` default 2 -> 1. Measured on 13 GT photoId plus 12 dev ad-hoc requests: app RSS 650 to 1,380 MB flat, physical footprint 400 to 428 MB flat, worker plus Chromium 0.35 to 2.3 GB.
- **Basin-gap LOW trigger** for ad-hoc requests with an untrusted position (`meta.positionSource` given and not `"exif-gps"`, or `positionUncertainM > 50`), HIGH results only. `pose6.basin_gap` evaluates a 9×9 position grid (±1 km) from the service's own stage-2 skyline cue and matches (Mapterhorn horizons ray-marched in Python, no new renders). Gap < `MATCHER_BASIN_GAP_MIN` (0.20, tuned on dev; `reports/position.md`, removed, `git show 384df44:reports/position.md`) or an unrunnable check sets `confidenceLevel:"low"` with `lowReason`. Cost: median about 10.6 s (9.4 to 35 s) on dev plus 10 to 40 s of one-off tile fetching for an uncached area (cache `tools/matcher/.cache`, capped at 1 GB).
- **`yawSeeds` / `poseSeeds`** (search hints, at most 4): each seed is tried first (wedge page with heading = seed, 3 views at the photo's FOV, yaw ±hfov/2). The first seed with >= 30 inliers and a solved yaw within one hfov of the seed becomes the stage-2 prior; the 360° sweep and its full-terrain page load are skipped. Otherwise the normal sweep runs; the HIGH/LOW rule is unchanged. For narrow-FOV photos the seeds join the existing `seeds` list.

**v0.3.1** (concurrency, no orphans, latency):
- `Renderer.call` holds a renderer lock for the whole request/reply, matches the reply on the call's own id and drops late replies; the ad-hoc `release` runs inside the job lock (`job_and_release`); a queued request waits for the job lock until its own deadline, then `503 busy` with `Retry-After` (30 s job lock, 5 s renderer lock). Root cause of what the e2e run saw: concurrent requests could replace `Renderer.proc` from another thread, orphaning workers. At 11:45 the live :8765 had **27 orphaned `render_worker.mjs` processes plus Chromiums**, 5.4 GB RSS, swap full at 15.9/16 GB, which filled the shared APFS disk.
- Basin-gap grid in a thread pool (`POSE6_GRID_THREADS`, 6): gaps bit-identical (wc_0063 0.139, wc_0027 0.208, wc_0069 0.171 offline), 9.8 to 11.7 s -> 5.6 to 6.5 s. Stage-1 searches matched with the top-2048 keypoints (`MATCHER_SWEEP_KP`): CPU LightGlue 0.72 s per pair instead of 1.9 s (11 threads gives only 1.86 s), about 10 s saved on the 9-view sweep; the final stage keeps 4096. `torch.set_num_threads`: no gain beyond the default 6 performance cores. **The 2048 cap was reverted in v0.3.4** (below).
- **No orphans**: the worker starts in its own process group (`start_new_session`); every restart and shutdown kills the whole group (SIGTERM, 3 s grace, SIGKILL), `_start` reaps a previous group first, and the Python server registers `atexit`/`SIGTERM`/`SIGINT` handlers. `render_worker.mjs` closes Chromium and exits on SIGTERM/SIGINT and on stdin EOF, so the worker follows a SIGKILLed server within 3 s.

**v0.3.2** (queue policy, cancellation, render budget): bounded queue (1 running, 1 waiting; the waiter gets the job lock within `MATCHER_QUEUE_WAIT_S` or a 503; a full queue answers 503 at once, before the body is read); the stage-based ETA and `/health` `queue`; `Access-Control-Expose-Headers: Retry-After`. A job checks for a disconnected client or an expired deadline at every stage boundary, between views inside matching and every second while waiting for a render reply, then cancels (reply abandoned, lock freed, `job cancelled` logged). The ad-hoc `release` is fire-and-forget; `_json` catches `BrokenPipeError`, `ConnectionResetError`, `ConnectionAbortedError` (they used to surface as 500s). The render budget is per request: an expired deadline mid-render gives that request alone a 504 ("reply abandoned; renderer kept") and the late reply is discarded by id; the worker is killed only when truly hung (`MATCHER_RENDER_HUNG_S`, 300 s, about 2× the worst render or page-load step).

**v0.3.3**: ETA for overrunning jobs (above). Cancelling during the basin gap: `pose6.grid_search` polls the cancel check every 0.25 s while its pool runs (a shared `Event` makes pending grid nodes return at once), DEM tile loading polls it between tiles (`dem.CANCEL`), and the wrapper re-raises cancellation and deadline errors instead of downgrading to LOW. A client that disconnected mid-basinGap freed the job in **0.68 s** (7.4 s before); gap values unchanged (wc_0063 0.139). Escalation block: headless pages opened by any instance abort requests to 127.0.0.1, localhost and [::1] on ports **8765 to 8769** and the instance's own port (predicate check allowed :3100, :8770 and tile hosts).

**v0.3.4** (fair queue tickets, empty-view retry, stage-1 keypoints back to 4096): queue tickets (above); keeps the app pipeline's `routeAdhoc` fix that intercepts Vite's `virtual:photos` module. A `502 "empty render for y+10"` (IMG_7068 in the e2e run) had two possible causes: the page's `__engine` swapped mid-render by a dev-server reload (the new engine has no drape and an all-zero geometry buffer), or a genuinely empty view. The worker tags each engine (`__wid`): engine swapped -> drop the page and retry the whole render once; same engine -> re-render that view once; still empty -> fail as before. "Execution context was destroyed" / "Target closed" also trigger the one-page retry. `MATCHER_SWEEP_KP` is back to **4096**: on wc_0009 the 2048 cap dropped stage-1 inliers from 32 to 19, below the 30 threshold, which triggered the app-skyline fallback and a verified-wrong pose; the time saved is negligible (wc_0006 stage 1: 16.7 s at 4096, 17.1 s at 2048).

**v0.3.5**: slow down ticketless busy clients (tarpit above). Why: a greedy client re-polling right after each 503 ran at about 40 req/s and grew the log by 1.2 MB during the v0.3.4 e2e. Ticket-honouring clients see no change.

**v0.4.0** (2026-09-26): the `policy` switch (above); the renderer health probe and `ok:false` on a failed probe; `MATCHER_TEX_UPLOAD`. `:8765` has run v0.4.0 (default policy v034) since 2026-09-26T17:27:44Z. Replay proof against the recorded tools/bench/final arms (below): confidence level identical on 24/24, selected source on every record, pose within 0.01° on 9/12 (A) and 11/12 (B), with all misses attributed to renderer nondeterminism.

## Test and verification records

*Update (2026-10-01): the test scripts named in the v0.3.x records (`tools/matcher/{fairness,concurrency,orphan,server_restart}_test.py`) are not in the repository; their outputs under `tools/bench/t5/server_tests/` are the record.*

### v0.2 parity with `tools/matcher/results-fusion.json` (true compass, service end to end; M3 Pro, MPS, shared dev server)

| photo | service fused yaw / pitch / roll / vfov | Δ vs results-fusion.json (yaw / pitch / roll) | level | cueAgree / skyMed / support |
|---|---|---|---|---|
| IMG_7155 (4 runs) | 235.916–235.918 / −8.389…−8.391 / −3.851…−3.854 / 52.51 | −0.003…−0.001 / ≤ 0.002 / ≤ 0.001 | HIGH | 0.16–0.18° / 0.70 px / 0.80–0.91 |
| IMG_7086 (2 runs) | 162.681 / −7.631 / +0.505 / 52.39 | +0.004…+0.005 / +0.004 / +0.004 | LOW | 2.54° / 11.7 px / 0.87 |
| IMG_7131 (2 runs) | 10.676 / −4.522 / +0.063 / 52.44 | +0.002 / +0.001 / −0.001 | HIGH | 0.12° / 0.97 px / 0.96 |
| IMG_7108 (2 runs) | 62.793–62.817 / 1.78–1.81 / 3.15–3.20 / 66.8–67.0 | +0.002…+0.026 / ≤ 0.026 / ≤ 0.059 | **HIGH, yaw ≈ 62.8** | 0.31–0.36° / 0.82–0.85 px / 0.50–0.53 |
| IMG_7086, prior +15° | 162.671 / −7.635 / +0.522 | vs `fusion_default` shift +15: +0.028 / +0.008 / −0.002 | LOW | 14.54° / 4.9 px / 0.86 |

- The residual differences are all match-side: each request renders and matches afresh, so the lifted match sets differ as imagery and DEM tiles stream in. Offline, on the same inputs, the wrapper is bit-exact.
- The IMG_7086 skyline cue has moved: the app's `autoAlign` from the unshifted prior now returns 162.08 / −10.11 (the export used for `fusion.md` had 162.25 / −7.26), so cueAgree is 2.5° instead of 0.7°. Still LOW, fused pose unchanged; an app-side skyline change since the export.
- IMG_7086 at +15° shows why fusion helps: skyline falls back to the shifted prior (yaw 177.2), the match cue recovers 162.67, fused lands +0.05° from the pin GT, and is correctly LOW (cues disagree by 14.5°).

### v0.2 timings (ms)

| request | total | page load + drape | skyline export | 5-view render | match | legacy solve | fusion |
|---|---|---|---|---|---|---|---|
| IMG_7155, first request after server start | 57 960 | 42 396 + 9 123 (Vite compiling) | 217 | 741 | 2 146 | 395 | 2 792 |
| IMG_7086 cold page | 18 765 | 8 386 + 2 494 | 223 | 828 | 2 654 | 339 | 3 794 |
| IMG_7131 cold page | 20 653 | 9 130 + 2 295 | 237 | 804 | 2 453 | 269 | 5 427 |
| IMG_7108 cold page | 18 949 | 10 154 + 1 926 | 240 | 792 | 2 341 | 253 | 3 207 |
| IMG_7155 cold page (2nd) | 16 256 | 8 960 + 1 119 | 218 | 755 | 2 077 | 389 | 2 698 |
| IMG_7086 +15° cold page | 16 570 | 9 017 + 1 227 | 204 | 752 | 2 175 | 152 | 3 004 |
| **IMG_7108 warm** | **6 224** | 0 | 230 | 739 | 1 943 | 339 | 2 932 |
| **IMG_7131 warm** | **6 724** | 0 | 206 | 764 | 1 923 | 268 | 3 526 |
| **IMG_7086 warm** | **6 160** | 0 | 204 | 775 | 2 090 | 251 | 2 803 |
| **IMG_7155 warm** | **6 196** | 0 | 212 | 853 | 1 880 | 346 | 2 864 |
| IMG_7155 warm, `fused:false` | 2 969 / 2 985 | 0 | – | 801 | 1 797 | 335 | – |

Fused adds about 3.2 s to a warm request (the fusion solve is on the CPU, dominated by the horizon-polyline crossing test with numeric Jacobians; see `fusion.md`). Multipart (IMG_7131, 5 views): inline `skyline:*` parts 6.8 s (fused, HIGH, yaw 10.674); `photoId` exported by the worker 16.2 s (9.7 s cold-page skyline export), identical pose; no skyline 2.9 s (render-match, LOW, 0.2); `fused:false` 2.8 s (v0.1 response, confidence 0.83).

### TS client (`npx tsx`): 17/17 passed

`shouldEscalate`: high confidence with no second solver no escalation; confidence 0.3 escalate; solvers 1.5° apart escalate; wraparound 359.6° vs 0.2° no escalation; no skyline result escalate. `matcherAvailable`: true in 18 ms, cached 0 ms. `requestMatch`: photoId mode on IMG_7155 `method:"fused"`, HIGH, 0.9, yaw 235.918; `fused:false` the legacy result, yaw 236.051; `timeoutMs:300` returned `null` after 303 ms; abort returned `null` after 201 ms; a 404 returned `null`; multipart with inline skyline through the client's `FormData` builder fused, HIGH, yaw 235.917, 4.3 s for 3 views; multipart without skyline render-match, LOW, 0.2, `matchIsConfident` false. Service down: with "up" cached `requestMatch` returned `null` in 9 ms; a fresh process with the server down: `matcherAvailable` false in 14 ms, `requestMatch` `null` in 0 ms. Lint-clean under `biome lint` and strict type-check.

### v0.3 tests (separate :8767 instance, :8765 untouched)

- **GT-12 photoId parity** (`tools/bench/t5/server_tests/gt12.jsonl`) against `tools/matcher/out/results/fusion_default.json`: 13/13 levels identical, |Δpose| <= 0.04° (largest roll −0.039°).
- **Cold ad-hoc IMG_7155**, stripped (no heading, pitch/roll or focal; pages released so every request is cold): all 5 stage-2 views match (849 / 1008 / 1148 / 1084 / 731); before the fix 1 to 3 of 5 returned 0 matches (`cold7155.jsonl`).
- **yawSeeds latency** (`seeds.jsonl`; total s / stage-1 s; final pose the same in every case, |Δyaw| <= 0.02°, all HIGH):

  | photo | no seed | seed at the solution +4° | wrong seed (+90°) |
  |---|---|---|---|
  | IMG_7155 | 34.1 / 23.3 | **27.1 / 14.9** | 60.5 / 50.7 (seed fails, then sweep) |
  | IMG_7068 | 61.6 / 50.6 | **46.1 / 36.1** | 103.5 / 93.0 |

  The machine was swapping, so page loads (25 to 90 s) dominate; a wrong seed costs one extra wedge-page load.
- **Basin gap on dev** (hand-placed, fused HIGH; `dev.jsonl`): the trigger drops **wc_0063** (the gross error, gap 0.175, stable across two runs) and keeps every verified-correct HIGH: wc_0069 0.213 to 0.215, wc_0027 0.229, wc_0017 0.48, wc_0047 0.74, wc_0076 0.84, wc_0020 1.25. Other issues seen: one 502 `render_failed` (wc_0027, first try; the retry passed); wc_0054 (EXIF GPS, trigger not applicable) came back LOW with cues 2.16° apart, while HIGH in the wild run (CPU-LightGlue change or run-to-run variance of the two-stage search, undetermined).

### v0.3.1 latency (`tools/bench/t5/server_tests/latency.jsonl`)

Before (4096 kp, 1 grid thread), idle except for page loads:

| case | total | stage 1 | page load in stage 1 | stage-2 render | match | fusion | basin gap |
|---|---|---|---|---|---|---|---|
| IMG_7155 stripped | 29.6 s | 19.7 s | 7.6 s | 9.6 s | 5.4 s | 2.6 s | – |
| IMG_7068 stripped | 185 s | 175 s | 159 s | 9.9 s | 6.1 s | 2.1 s | – |
| wc_0063 manual | 180 s | 165 s | 157 s | 14.8 s | 2.4 s | 1.6 s | 9.8 s |

Page loads of 25 to 160 s dominate and vary run to run with the same code (IMG_7068: 25 to 159 s), tracking the machine's swap state. After (`MATCHER_SWEEP_KP=2048`, 6 grid threads), under load (load average 10.8, swap 7.1/8.2 GB, other sessions using about 4.9 cores):

| case | total | stage 1 | page load in stage 1 | stage-1 compute* | stage-2 render | match | fusion | basin gap |
|---|---|---|---|---|---|---|---|---|
| IMG_7155 stripped | 38.1 s | 21.3 s | 9.2 s | 7.6 s (before 9.2) | 16.4 s | 10.1 s | 4.2 s | – |
| IMG_7068 stripped | 74.8 s | 57.0 s | 46.6 s | 5.1 s (before 9.7) | 17.2 s | 10.4 s | 4.4 s | – |
| wc_0063 manual | 181 s | 143 s | 135 s | 4.3 s (before 4.7) | 37.8 s | 4.0 s | 1.9 s | 30.4 s (gap 0.179 -> LOW, as before) |

\*Stage 1 minus page load, render and imagery. The unchanged final-stage steps took about 2× longer than in the "before" run (whole machine slower), so end-to-end totals do not isolate the change. Basin gap (30 s) was hurt most by CPU contention (6 threads against 5 busy cores); the isolated offline figure stands at 5.6 to 6.5 s threaded against 9.8 to 11.7 s unthreaded.

### Queue, cancellation, ETA, no-orphan tests (:8767)

- **Fairness** (v0.3.4): a greedy client re-posts immediately after each 200 and 1 s after each 503 without a ticket; a ticket-honouring client sleeps `Retry-After` and echoes the ticket. The honouring client was served after **1, 2 and 1** retry cycles in 3 rounds, and the greedy client still got 5 × 200. A first version that counted never-presented tickets starved both clients (abandoned tickets blocked everyone until expiry), which is why only active tickets count.
- **Empty-view retry**: `MATCHER_DEBUG_HOOKS=1` reloads the page before view y+10 of an IMG_7068 photoId render; the render was retried and returned all 5 views in 18.4 s (`timing.renderRetried`).
- **ETA trace** (wc_0063 ad-hoc basin-gap job, 58.6 s, `v033.json`): median |etaS − actual remaining| **5.0 s**, no underestimate > 10 s (largest 5.6 s; an overrunning stage-1 match pushed estimates up to 20 s too long).
- **Concurrency** (`concurrency.json`): clients A photoId loop, B ad-hoc with `yawSeeds`, C `/health` poller every 2 s, D disconnects after 6 s, E `timeoutMs` 3000, F an ad-hoc job whose client disconnects mid-run. **PASS**: no 500s; the only 504 was E's (renderer kept); every 503 carried a `Retry-After` of 12 / 15 / 22 / 59 s and arrived within 0 to 5.1 s; A got 4/4 × 200 and B 200 after retrying; F's job was freed **0.5 s** after disconnect in the stage-1 render (30 s before the non-blocking release); one render-worker pid throughout. One earlier run produced a `502 render_failed "empty render"` for A (dead-engine check after a dev-server HMR reload of the shared app); it did not recur.
- **No orphans** (`orphan_test.py`, PASS): 3 forced restarts (worker SIGSTOPped, render step 504, renderer restarts), then SIGTERM of the server, then a restart plus SIGKILL of the server; processes left (node + Chromium) after each step **0 / 0 / 0 / 0 / 0**. `server_restart_test.py` also checks a direct `Renderer.kill()` and a node crash followed by `_start`: 0 of 5 left each time.
- **Tarpit** (v0.3.5): on a throwaway instance ticketless 503s came back after 2 s, or 7 s when the request first waited for the waiter slot, and no per-request 503 lines were logged.

### v0.4 deployment (2026-09-26)

- **Decision.** The written condition asked for every B pose within 0.01°; wc_0044 (B) is 0.020° off. The orchestrator accepted it as renderer noise: the v0.3.5 code reproduces the same 0.0202° offset against that B record, and levels and selected sources match on 24/24 replays.
- **Before.** The old :8765 process (v0.3.5, pid 21978, up since 2026-09-25 22:34) had been broken since the about 16:02Z macOS access outage: every `/match` returned `render_failed: browserType.launch: Target page, context or browser has been closed`, while `/health` said `renderer.alive: true` (the reason for the new probe). Restarting the worker from inside the service did not fix the same failure on :8766; only a full process restart did.
- **Restart.** `kill 21978` at 17:27:33Z, then `tools/matcher/server/run.sh --port 8765`; warm and listening at 17:27:44Z (about 11 s of downtime). After: `/health` version matcher-service/0.4.0, `policy.default` = `v034`, `renderer.browserOk` true; photoId `IMG_4703` 200 OK in 19 s; ad-hoc (`photoPath`, v034) 200 OK in 57 s; the app's own request (IMG_3304) returned 200. The :8766 dev instance was stopped at 17:29Z.

### v0.4 replay equality

`tools/matcher/server/replay_final.py` builds each request from the inputs `tools/bench/final` used (the photo after harness normalisation; `meta {lat, lon, altitudeM, positionSource}`; `prior.vfov` when the focal is known, else no prior; `yawHint` = the weak heading; no yaw, no gravity), POSTs it to the running service (:8766) with `policy` v034 (arm A) or t6 (arm B), and compares `confidenceLevel` and the selected pose with `tools/bench/final/out/<arm>/<id>.json` (read only; outputs go to the scratch dir). The 12 test ids are the same in both arms (3 narrow, 3 app-seed and 6 sweep40 baselines in arm A). Test ids are refused unless `REPLAY_ALLOW_TEST=1`. Nothing was tuned on them.

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
| **total** | **12/12 levels** | 12/12 | **9/12 <= 0.01°** | **12/12 levels** | 12/12 | **11/12 <= 0.01°** |

- **Max |Δ|** is the largest of |Δyaw|, |Δpitch|, |Δroll|, |Δvfov| between the service's `pose` and the record's. Wall time on the shared, loaded machine: v034 44 to 137 s; t6 136 to 226 s (5 to 19 GB of swap in use).
- The first B pass was interrupted: wc_0038 to wc_0097 were hit by the about 16:02Z access outage (`PermissionError` reading `stage1/rule.py`, then a dead Chromium). The :8766 instance was restarted at 17:01Z with the same code and those five re-run; the table shows the re-run. `tools/bench/final/out` was never written.

### Nondeterminism: the renderer, not the port

Every pose miss is on a record whose stage 1 was the 40° sweep, which makes the most fresh renders; the difference already appears in the stage-1 sweep solve (wc_0044 B: 225 inliers in both record and replay, but a pose 0.005° apart).
- **Deterministic:** ALIKED extraction on MPS (6 repeated extractions bit-identical, interleaved or not); the RANSAC samplers (seeded `default_rng(seed)`); the app-seed and narrow paths, which reuse the page's cached renders (exactly 0, 7/7 in A).
- **Not deterministic: the rendered views** (headless-Chromium WebGL frames of the satellite-draped DEM). Keypoint counts on the same view differ between runs of the same code and request (wc_0018, v0.3.5: 2514 / 2521 / 2496 ALIKED keypoints on view `y-20`). The likely cause is imagery-tile/texture state at render time (warm vs cold page, upload timing). stage1.md §10.1 had seen a cold first render come out untextured, which is why the vendored worker and policy t6 force `initTexture` + `gl.finish` after draping.
- **Measured spread of v0.3.5** (run from a scratch mirror on :8767, same request as arm A, on the three A misses; max |Δ|° against record A; "spread" is the largest pairwise difference among v0.3.5 runs and both records, v0.4.0 excluded):

  | id | v0.3.5 run 1 | run 2 | run 3 | spread | v0.4.0 (v034) |
  |---|---|---|---|---|---|
  | wc_0018 | 0.013 | 0.026 | 0.034 | 0.047 | 0.038 |
  | wc_0044 | 0.014 | 0.014 | – | 0.020 | 0.014 |
  | wc_0080 | 0.039 | 0.000 | – | 0.039 | 0.018 |

- Against the B record, the v0.3.5 runs are 0.0202° off on wc_0044, the same as v0.4.0 t6 (the recorded B run's sweep40 landed in a slightly different state from all later runs).
- In the records themselves (same vendored code in both arms), the baseline sweep40 candidate differs between arm A and arm B by more than 0.01° on 6 of 23 sweep40 photos (max 0.038°, wc_0100); on wc_0081 the a-priori level flips (`low` in A, `high` in B). App-seed (15) and narrow (12) baselines stay within 0.0092° and 0.0064°.
- So 0.01° is below this renderer's run-to-run noise on sweep-seeded photos (up to about 0.05° for v0.3.5 itself). Levels were stable on all 24 replays, but wc_0081 shows they can flip near a threshold.
- **Known intentional render difference (v034 vs the A records):** the records used the vendored v0.3.4 worker (`stage1/vendor/worker.mjs`), which always forces the texture upload after draping. v0.3.5's `render_worker.mjs` does not, and v034 must behave exactly as v0.3.5, so it does not either (`MATCHER_TEX_UPLOAD=1` turns it on). This does not explain the misses: the recorded arms differ from each other with the upload on, and v0.3.5 differs from itself with it off.

## Caveats and next steps

- **Pose tolerance.** 0.01° is below the renderer's run-to-run noise on sweep40-seeded photos; replays of those photos will not be bit-stable in any version until renders are made deterministic (e.g. wait for all imagery tiles, force the texture upload on every render).
- **Rule hash reporting.** `rule.sha1` in responses and `/health` is re-read from `stage1/rule.py` on each call; the start-time assert guarantees the loaded rule, and catches an edit made while running on the next restart.
- **Coverage.** Only 12 test ids per arm were replayed (all five stage-1 sources).
- **Fusion runs on the CPU and costs about 3 s**; it could be vectorised (`sky_curve`'s all-segments × all-columns crossing test with numeric Jacobians).
- **Single job at a time**; a second client waits up to its own timeout. Mode (a) is dev-only; prod needs mode (b).
- **The skyline cue follows the live app**: if `align.ts` changes, the cue changes with it (as seen on IMG_7086); the HIGH rule still needs both cues to agree.
- **Imagery licences.** Server-side use of swisstopo or Esri imagery in production needs a terms check (`reports/matcher.md`, removed; `git show 384df44:reports/matcher.md`).
