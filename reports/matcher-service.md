# Render-and-match service (optional escalation tier)

*2026-09-25 · v0.2 (fused) · code in `tools/matcher/server/` and `src/lib/matcher-client.ts` · method in `reports/matcher.md` (render-match) and `reports/fusion.md` (fusion)*

## Summary

- **What it is.** A small local HTTP service on :8765. `POST /match` now returns the **fused** pose: `tools/matcher/fusion.py`'s joint Huber LM over rotation + focal, using both the app's skyline evidence and ALIKED+LightGlue matches against satellite-draped DEM renders.
  - The confidence rule is `fusion.md`'s a-priori one. **HIGH** iff:
    - the skyline-only and match-only solves agree within 1°;
    - the skyline median residual at the fused pose is under 4 px;
    - at least 30 % of matches are within 6 px.
- **The client still sends only `{photoId, prior}`.** The server computes the skyline cue itself. Its long-lived headless renderer drives the app page, runs `engine.autoAlign(true)` from the request prior, and exports `horizonDirs` plus `edge.fine`, `edge.fg` and `edge.sky`, exactly as `export_skyline.mjs` does. It then renders the 5 satellite views as before.
- **It reproduces fusion.py.**
  - Offline: the service's fusion wrapper (`server/fuse.py`, which imports fusion.py's functions) reproduces `out/results/fusion_default.json` **bit-exactly**, Δ = 0.00000° on every angle, for 7155, 7086, 7131 and 7108 at shifts 0 and +15. All HIGH/LOW levels match.
  - Live, end-to-end (fresh renders and a fresh skyline export): within **0.005°** of `results-fusion.json` on yaw, pitch and roll for IMG_7155, 7086 and 7131, against the 0.05° budget.
- **Backward compatible.**
  - `confidence` is still a number: HIGH → 0.9 and LOW → 0.2, so `m.confidence < 0.5` still gates correctly.
  - The new fields are `method`, `confidenceLevel`, `confidenceChecks`, `cues`, `fusionScore`, `matchConfidence` and `fusedFrom`.
  - `{fused:false}` returns the v0.1 behaviour.
  - `version` is `matcher-service/0.2 …`.
- **Latency.** The skyline step adds ~0.2 s of in-page export, but fusion's CPU solve adds **~2.7–3.5 s** (up to 5.4 s cold).
  - Warm: **~6.2 s** fused, against ~3.0 s for `fused:false`.
  - Cold page: ~16–21 s.
  - The very first request after the dev server has been idle can take ~55 s, while Vite compiles the page.

## v0.3 changes (2026-09-25, T5 follow-up; tested on a separate :8767 instance, :8765 untouched)

`version` is now `matcher-service/0.3 …`. photoId requests and ad-hoc requests without the new fields behave as before; the GT-12 parity check is below.

- **LightGlue runs on the CPU** (`MATCHER_LG_DEVICE`, default `cpu`; ALIKED stays on MPS).
  - On MPS the *same* photo/render pair intermittently gave wrong results, in both directions: 0, 2 or 13 matches instead of about 900, or spurious extra matches (236 instead of about 49). It happened under GPU and memory contention; it was reproduced offline, and 5 sequential requests showed it in 11 of 25 views.
  - That was the "cold-page readiness race": the renders were fine (textured, same pixel statistics), the matcher was not. Turning off flash attention did not fix it.
  - The CPU path is deterministic. It costs about 1.6 s per view pair: roughly +3–4 s for a 5-view stage and +7 s for the 9-view 360° sweep.
- **Imagery readiness** (`render_worker.mjs`). After the satellite drape, every tile in range must carry its texture; any that doesn't is re-draped, up to 2 retries. Each render reports `timing.imageryRetries` and `imageryMissing`. Every render in the tests had 0 missing tiles.
- **ENOENT crash fixed** (`render_worker.mjs`).
  - The ad-hoc photo bytes are held in memory for the page's lifetime, so `fulfill({body})` no longer reads a temp file that `app.py` has deleted.
  - Every route handler is wrapped: a failed fulfill aborts that request instead of throwing.
  - There are global `unhandledRejection` and `uncaughtException` loggers, so the worker no longer exits on them.
  - `app.py` sends a new `release` command when an ad-hoc request finishes, which drops that photo's pages.
  - Test (`reload` test hook): render an ad-hoc photo, delete its temp dir, reload the page. The reload succeeded, the worker stayed alive, and `ping` answered afterwards.
- **Memory.**
  - The app process (python) was at 2.9–4.5 GB RSS. The vmmap breakdown was a physical footprint of about 0.47 GB; the rest was `MALLOC_LARGE_REUSABLE` (freed CPU attention and score buffers) plus the MPS allocator cache.
  - After every job it now runs `gc.collect()` and `torch.mps.empty_cache()`, and calls `malloc_zone_pressure_relief` on macOS.
  - The render worker keeps **1** warm page by default (`MATCHER_MAX_PAGES`, was 2), because each draped page holds about 1–1.5 GB in Chromium.
  - Measured on 13 GT photoId requests, then 12 dev ad-hoc requests: **app RSS 650–1,380 MB, flat; physical footprint 400–428 MB, flat**. Worker plus Chromium: 0.35–2.3 GB, depending on the one warm page.
- **Basin-gap LOW trigger** for ad-hoc requests with an untrusted position (`meta.positionSource` given and not `"exif-gps"`, or `positionUncertainM > 50`).
  - It runs only on a HIGH result. `pose6.basin_gap` evaluates a 9×9 position grid (±1 km) from the **service's own stage-2 skyline cue and matches**, with Mapterhorn horizons ray-marched in Python and no new renders.
  - If gap < `MATCHER_BASIN_GAP_MIN` (default **0.20**, tuned on dev; see `reports/position.md`), or the check can't run, the response is set to `confidenceLevel:"low"` with `lowReason`.
  - New fields: `confidenceChecks.basinGap`, `confidenceChecks.positionTrusted`, `confidenceChecks.basinGrid`, and `timingMs.basinGap`.
  - Added latency: **median about 10.6 s, range 9.4–35 s** on dev, plus 10–40 s of one-off tile fetching for an uncached area. The Mapterhorn cache is `tools/matcher/.cache`, capped at 1 GB.
- **`yawSeeds` / `poseSeeds`** (ad-hoc requests; search hints only).
  - Each seed (at most 4) is tried first: a wedge page is opened with heading = seed, and 3 views at the photo's FOV (yaw ±hfov/2) are render-matched.
  - The first seed with ≥ 30 inliers and a solved yaw within one hfov of the seed becomes the stage-2 prior. The 360° sweep and its full-terrain page load are skipped, and stage 2 reuses the wedge page when it can.
  - Otherwise the normal sweep runs. The HIGH/LOW rule is unchanged.
  - For narrow-FOV photos the seeds join the existing `seeds` list.

## v0.3.4 (fair queue tickets, empty-view retry, stage-1 keypoints back to 4096)

This version keeps the lead's `routeAdhoc` fix, which intercepts Vite's `virtual:photos` module.

### Queue tickets (for clients)

- **Every `503 busy` carries a ticket:** the `X-Queue-Ticket` response header and the JSON field `ticket`, together with `Retry-After` (also in the JSON as `retryAfterS`).
- **How to retry:** sleep `Retry-After` seconds, then resend the same request with the request header **`X-Queue-Ticket: <ticket>`**. This works for JSON and for multipart `/match`.
  - A retry that presents a ticket keeps it; if it is still busy, it gets the same ticket back with a fresh `Retry-After`.
  - A ticket that has been presented at least once is **active**.
- **Order:** the job and the single waiter slot go to the **oldest active ticket** first.
  - A request with no ticket, or with a newer one, gets a 503 as long as an older active ticket exists, even if the service happens to be idle for a moment.
  - A ticket that is never presented doesn't block anyone. That way a client that ignores tickets can't clog the queue with abandoned ones.
- **Expiry:** at 2 × `Retry-After` + 15 s after it was last issued. It is consumed when the request is served.
- **`Retry-After`** = the stage-based ETA of the running job (plus a queued waiter) + the typical duration of every older active ticket's job, rounded up and capped at 60 s.
- **CORS:**
  - `Access-Control-Allow-Headers: Content-Type, X-Queue-Ticket`, so the browser preflight for the retry passes (checked with `curl -X OPTIONS … -H 'Access-Control-Request-Headers: content-type,x-queue-ticket'` → 204 with both headers).
  - `Access-Control-Expose-Headers: Retry-After, X-Queue-Ticket`.
- `/health` `queue` gains `tickets`, the number of live tickets.

**Fairness test** (`tools/matcher/fairness_test.py`, :8767).
- Setup: a greedy client re-posts immediately after each 200 and 1 s after each 503, and never sends a ticket. A ticket-honouring client sleeps `Retry-After` and echoes the ticket.
- Result: the honouring client was served after **1, 2 and 1** retry cycles in 3 rounds, and the greedy client still got 5 × 200 (no starvation).
- A first version that counted never-presented tickets starved both clients: the greedy client's abandoned tickets blocked everyone until they expired. That is why only active tickets count.

### Empty views

A `502 "empty render for y+10"` (IMG_7068 in the lead's e2e) has two possible causes:
- the app page's `__engine` was swapped mid-render by a dev-server reload (HMR or full reload, e.g. when `photos.ts` changed at 13:14). The new engine has no drape and no loaded geometry, so its geometry buffer is all zeros;
- or a view with genuinely no terrain.

The worker now tags each engine (`__wid`) when a render starts and diagnoses an empty view:
- **engine swapped:** the page is dropped and the whole render is retried once with a fresh page;
- **same engine:** that view is re-rendered once in place;
- **still empty:** the request fails as before.

Errors such as "Execution context was destroyed" or "Target closed" (a reload hitting the page mid-command) also trigger the one-page retry.

Test: the `MATCHER_DEBUG_HOOKS=1` hook reloads the page before view y+10 of an IMG_7068 photoId render. The render was retried and returned all 5 views in 18.4 s (`timing.renderRetried` records the reason). Responses also carry `timing.emptyViewRetries`.

### Stage-1 keypoints

`MATCHER_SWEEP_KP` is back to a default of **4096**; the environment variable stays. The lead's attribution on dev found the 2048 cap from v0.3.1 harmful:
- On wc_0009, stage-1 inliers fell from 32 to 19, below the 30 threshold. That triggered the app-skyline fallback, which gave a verified-wrong pose; at 4096 the pose is correct.
- The time saved is negligible because page load and rendering dominate: on wc_0006, stage 1 took 16.7 s at 4096 and 17.1 s at 2048.

## v0.3.3 (ETA for overrunning jobs, cancellable basin gap, port-range block)

- **ETA.**
  - A stage that has overrun its typical time is expected to need about as long again as it already has (`OVERRUN_FACTOR = 1.0`); there is no near-zero floor.
  - When the whole job is running slower than typical, the remaining stages are scaled by elapsed ÷ typical-so-far, up to 3×.
  - Trace of a real ad-hoc basin-gap job (wc_0063, 58.6 s, `tools/bench/t5/server_tests/v033.json`): median |etaS − actual remaining| = **5.0 s**, and **no underestimate > 10 s**. The largest underestimate was 5.6 s; an overrunning stage-1 match pushed estimates up by as much as 20 s, erring long.
- **Cancelling during the basin gap.**
  - `pose6.grid_search` polls the job's cancel check every 0.25 s while its thread pool runs. A shared `Event` makes the pending grid nodes return at once, and the check is also polled between the LM nodes.
  - DEM tile loading (`dem.CANCEL`) polls it between tiles.
  - The basin-gap wrapper re-raises cancellation and deadline errors instead of downgrading to LOW.
  - A client that disconnected mid-basinGap freed the job in **0.68 s** (7.4 s before).
  - The gap values are unchanged (wc_0063 0.139, offline fast mode).
- **Escalation block.** Headless app pages opened by any instance abort requests to 127.0.0.1, localhost and [::1] on ports **8765–8769**, as well as the instance's own port. A predicate check allowed :3100, :8770 and tile hosts.

## v0.3.2 (queue policy, cancellation, per-request render budget)

`version` is now `matcher-service/0.3.2 …`, and it is reported by `/health`.

- **Bounded queue.** At most 1 job runs and at most 1 waits.
  - The waiter gets the job lock within 5 s (`MATCHER_QUEUE_WAIT_S`), or a `503 busy`.
  - When the queue is full, the 503 comes at once, before the body is read.
  - `Retry-After` is the stage-based estimate below, rounded up and capped at 60 s.
- **ETA estimate.** Each job type has a typical stage sequence (`STAGE_SEQ`):

  | job | stages (typical seconds) |
  |---|---|
  | photoId | render 10, match 6, solve 0.5, fusion 3 |
  | ad-hoc | render 25, match 7, solve 1, render 12, match 6, solve 0.5, fusion 3, basinGap 8, release 1 |

  - The estimate = the running stage's remaining typical time (at least 20 % of it, and at least 1 s) + the typical time of the stages after it + the full typical time of any queued job. It is capped at the running job's own deadline.
  - `/health` now includes `queue: {waiting, etaS, running: {stage, elapsedS} | null}`, where `etaS` is the seconds until a new job could start (null when idle).
- **CORS.** Responses now send `Access-Control-Expose-Headers: Retry-After`.
- **Disconnected clients.** A job checks at every stage boundary, between the views inside matching, and every second while it waits for a render reply. When its socket shows EOF, or its deadline has passed, the job is cancelled: the reply is abandoned, the job lock is freed, and the log records `job cancelled`.
  - The ad-hoc page `release` is now fire-and-forget. It queues behind whatever the worker is doing, and its reply is discarded by id, so a cancelled job no longer waits for its abandoned render.
  - `_json` now catches `BrokenPipeError`, `ConnectionResetError` and `ConnectionAbortedError`; these used to surface as 500s.
- **Render budget per request, not per renderer.** When a request's deadline expires mid-render, that request alone gets a 504 ("reply abandoned; renderer kept"), and the late reply is discarded by id. The worker and its warm pages survive.
  - The worker is killed and restarted only when it is truly hung: no output at all for `MATCHER_RENDER_HUNG_S` (300 s, about 2× the worst render or page-load step) while a command is outstanding.
- **Test** (`tools/matcher/concurrency_test.py` on :8767, `tools/bench/t5/server_tests/concurrency.json`). The scenario ran these clients against one instance:
  - A: a photoId loop;
  - B: an ad-hoc client with `yawSeeds`;
  - C: a `/health` poller every 2 s;
  - D: a client that disconnects 6 s after sending;
  - E: one request with `timeoutMs` 3000;
  - F: afterwards, an ad-hoc job that is running when its client disconnects.

  Results: **PASS.**
  - No 500s.
  - The only 504 was E's (over budget), with the renderer kept.
  - Every 503 carried a `Retry-After` of 12 / 15 / 22 / 59 s and arrived within 0–5.1 s.
  - A got 4/4 × 200 and B got 200 after retrying.
  - F's job was freed **0.5 s** after its client disconnected, while it sat in the stage-1 render (before the non-blocking release it took 30 s).
  - **One render-worker pid** throughout the run.
  - One earlier run also produced a `502 render_failed "empty render"` for A. That is the worker's dead-engine check after a dev-server HMR reload of the shared app, not a collision; it didn't recur.

## v0.3.1 (concurrency, no-orphan process handling, latency)

- **Concurrency.**
  - `Renderer.call` holds a renderer lock for the whole request/reply. It matches the reply on the call's **own** id, and drops late replies from earlier calls that timed out.
  - The ad-hoc `release` runs **inside** the job lock, via `job_and_release`.
  - A queued request still waits for the job lock until its own deadline. It then gets `503 busy` with a `Retry-After` header (30 s for the job lock, 5 s for the renderer lock).
  - Root cause of what the e2e run saw: with the old code, concurrent requests could replace `Renderer.proc` from another thread, so killed or restarted workers were orphaned, not killed. At 11:45 the live :8765 had **27 orphaned `render_worker.mjs` processes plus their Chromiums**, 5.4 GB RSS, and swap was full at 15.9/16 GB. That swap growth is what filled the shared APFS disk.
- **Latency.** Same confidence rule and same basin-gap threshold (0.20).
  - Basin gap: the 81 grid nodes (horizon ray-march plus coarse rotation search) run in a thread pool (`POSE6_GRID_THREADS`, default 6). The gaps are bit-identical (wc_0063 0.139, wc_0027 0.208, wc_0069 0.171 offline), and the time drops from **9.8–11.7 s to 5.6–6.5 s**.
  - Stage-1 searches (the 360° sweep, narrow seeds and hint seeds) match with the top-**2048** keypoints by score (`MATCHER_SWEEP_KP`). CPU LightGlue then takes **0.72 s per pair instead of 1.9 s** (measured; 6 threads is already the default, and 11 threads gives only 1.86 s). For the 9-view sweep that saves about 10 s. The final stage keeps 4096.
  - `torch.set_num_threads`: no gain beyond the default of 6 performance cores.
- **Before (4096 kp, 1 grid thread), idle except for page loads:**

  | case | total | stage 1 | page load in stage 1 | stage-2 render | match | fusion | basin gap |
  |---|---|---|---|---|---|---|---|
  | IMG_7155 stripped | 29.6 s | 19.7 s | 7.6 s | 9.6 s | 5.4 s | 2.6 s | – |
  | IMG_7068 stripped | 185 s | 175 s | 159 s | 9.9 s | 6.1 s | 2.1 s | – |
  | wc_0063 manual | 180 s | 165 s | 157 s | 14.8 s | 2.4 s | 1.6 s | 9.8 s |

  - Page loads of 25–160 s dominate. They vary run to run with the same code (IMG_7068: 25–159 s) and track the machine's swap state, not the service.
- **After** (`MATCHER_SWEEP_KP=2048`, 6 grid threads; `tools/bench/t5/server_tests/latency.jsonl`). The machine was loaded during this run: load average 10.8, swap 7.1/8.2 GB, and other sessions' python and Chromium using about 4.9 cores.

  | case | total | stage 1 | page load in stage 1 | stage-1 compute* | stage-2 render | match | fusion | basin gap |
  |---|---|---|---|---|---|---|---|---|
  | IMG_7155 stripped | 38.1 s | 21.3 s | 9.2 s | 7.6 s (before 9.2) | 16.4 s | 10.1 s | 4.2 s | – |
  | IMG_7068 stripped | 74.8 s | 57.0 s | 46.6 s | 5.1 s (before 9.7) | 17.2 s | 10.4 s | 4.4 s | – |
  | wc_0063 manual | 181 s | 143 s | 135 s | 4.3 s (before 4.7) | 37.8 s | 4.0 s | 1.9 s | 30.4 s (gap 0.179 → LOW, as before) |

  \*Stage-1 compute is stage 1 minus page load, render and imagery: the matching this change targets.
  - Stage-1 compute went down, as expected; it is least affected by the load.
  - The unchanged final-stage steps (render, 4096-kp match, fusion) took about 2× longer than in the "before" run. The whole machine was slower, so the end-to-end totals don't isolate the change.
  - Basin gap (30 s) was the step most hurt by CPU contention: 6 threads competing with 5 busy cores. The isolated offline measurement stands at 5.6–6.5 s threaded against 9.8–11.7 s unthreaded, with the gap values unchanged. On a busy host, set `POSE6_GRID_THREADS=2`.
  - Page loads (9–135 s) remain the dominant, uncontrolled cost of an escalation.
- **No orphaned render workers** (`tools/matcher/orphan_test.py`, PASS on :8767):
  - The worker starts in its own process group (`start_new_session`). Every restart and every shutdown kills the **whole group**: SIGTERM, up to 3 s grace, then SIGKILL. `_start` also reaps a previous group before launching a new one.
  - The Python server registers `atexit`, `SIGTERM` and `SIGINT` handlers that reap the group.
  - `render_worker.mjs` closes Chromium and exits on SIGTERM/SIGINT and on **stdin EOF**, so if the Python server dies, even by SIGKILL, the worker follows within 3 s.
  - Test: 3 forced restarts (the worker is SIGSTOPped, the render step times out with a 504, and the renderer restarts), then a SIGTERM of the server, then a restart plus a SIGKILL of the server. Processes left in any of the instance's worker groups (node + Chromium) after each step: **0 / 0 / 0 / 0 / 0**.
  - `tools/matcher/server_restart_test.py` also checks a direct `Renderer.kill()` and a node crash followed by `_start`: 0 of 5 processes left each time.

## v0.3 test results (:8767)

**GT-12 photoId parity** (`tools/bench/t5/server_tests/gt12.jsonl`) against `tools/matcher/out/results/fusion_default.json`:
- 13/13 HIGH/LOW levels are identical.
- |Δpose| ≤ 0.04° (largest: roll −0.039°).

**Cold ad-hoc IMG_7155**, stripped (no heading, pitch/roll or focal; every request cold because pages are released): all 5 stage-2 views now match (849 / 1008 / 1148 / 1084 / 731). Before the fix, 1–3 of the 5 views returned 0 matches (`cold7155.jsonl`).

**yawSeeds latency**, stripped ad-hoc requests (`seeds.jsonl`). Each cell is total s / stage-1 s; the final pose is the same in every case (|Δyaw| ≤ 0.02°) and all are HIGH:

| photo | no seed | seed at the solution +4° | wrong seed (+90°) |
|---|---|---|---|
| IMG_7155 | 34.1 / 23.3 | **27.1 / 14.9** | 60.5 / 50.7 (seed fails, then sweep) |
| IMG_7068 | 61.6 / 50.6 | **46.1 / 36.1** | 103.5 / 93.0 |

The machine was swapping during these runs, so page loads (25–90 s) dominate and the absolute times are inflated. A wrong seed costs one extra wedge-page load.

**Basin gap on dev** (hand-placed, fused HIGH; `tools/bench/t5/server_tests/dev.jsonl`): the trigger drops **wc_0063** (the gross error, gap 0.175, stable across two runs) and keeps every verified-correct HIGH:

| photo | gap |
|---|---|
| wc_0069 | 0.213–0.215 |
| wc_0027 | 0.229 (both runs) |
| wc_0017 | 0.48 |
| wc_0047 | 0.74 |
| wc_0076 | 0.84 |
| wc_0020 | 1.25 |

Other issues seen during these tests:
- One 502 `render_failed` (wc_0027, first try; the retry passed).
- wc_0054 (EXIF GPS, so the trigger doesn't apply) came back LOW, with the cues disagreeing by 2.16°. In the wild run it was HIGH. I can't tell whether that comes from the CPU-LightGlue change or from run-to-run variance in the two-stage search.

## Running it

```bash
# dev server must be on :3100 for photoId mode (npm run dev -- --port 3100)
tools/matcher/server/run.sh                 # → http://127.0.0.1:8765
tools/matcher/server/run.sh --port 8765 --host 127.0.0.1 --no-warm-renderer
```

- **Environment variables:**
  - `APP_URL`: default `http://localhost:3100`.
  - `MATCHER_CORS`: comma list of allowed origins. Default `http://localhost:3100,http://127.0.0.1:3100`.
  - `MATCHER_TIMEOUT_MS`: default request timeout, 120000.
  - `MATCHER_MAX_PAGES`: number of warm `/photo` pages, default 2.
  - `MATCHER_PORT`
- **The app side** reads `VITE_MATCHER_URL`. If it's unset, the client uses `http://localhost:8765`.
- **Dependencies:** none beyond the existing `tools/matcher/.venv` (stdlib `http.server`) and the repo's Playwright. Weights come from `tools/matcher/weights`. Nothing is downloaded.
- **Disk:** temporary renders and the skyline export go to `$TMPDIR/matcher-*` and are deleted after each request. That's ~48 MB for 5 views plus ~2.5 MB of skyline maps. Nothing is written to `tools/matcher/out/`.
- **Files (`tools/matcher/server/`):**
  - `app.py`: HTTP server, validation, timeouts, CORS and response assembly.
  - `core.py`: matching and the legacy solve. It imports `extract`, `match`, `lift` and `solve_rotation` from `../match.py`.
  - `fuse.py`: in-memory replay of `fusion.solve_photo()`. It imports `solve`, `selection_cost`, `diagnostics`, `rot_angle`, `match_resid` and the constants from `../fusion.py`. `skyline_from_arrays()` is `fusion.load_skyline()` without the files, and its S map is checked `array_equal`.
  - `render_worker.mjs`: persistent Chromium plus warm `/photo` pages. It exports satellite renders and xyz buffers (from `render.mjs`) and the skyline cue (from `export_skyline.mjs`). The pages are blocked from calling back into the service.
  - `run.sh`: the launcher.
- **Neither `../fusion.py` nor `../match.py` is modified.**
- **Stopping it:** Ctrl-C, or `pkill -f tools/matcher/server/app.py`.

## API

Errors look like `{ok:false, error:{code, message}, version}`, with these HTTP statuses:

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

Jobs are serialised: one GPU and one renderer.

### `GET /health`

Returns `{ok, device:"mps", version, models:{extractor, matcher, fusion, warm, warmupMs}, renderer:{alive, app}, busy, uptimeS, requests}`.

### `POST /match`, mode (a): JSON

```json
{"photoId":"IMG_7155","prior":{"yaw":225.6,"pitch":-7.84,"roll":-1.28,"vfov":53.06},
 "fused":true, "offsets":[-20,-10,0,10,20], "timeoutMs":60000}
```

- The server exports the skyline cue for this prior. It sets `engine.prior` in memory, runs `autoAlign(true)` and applies the acceptance rule that `export_skyline.mjs` applies.
- It renders views at `prior.yaw + offsets`, matches `public/photos/<ID>.jpg`, and fuses.
- **This mode is dev-server only**, because it drives `localhost:3100/photo/<ID>`.

### `POST /match`, mode (b): `multipart/form-data`

| part | content |
|---|---|
| `request` | JSON `{prior, eye:[x,y,z], views:[{tag, pose, W, H}], fused?, photoId?, skyline?: {w, h, pose, confidence?, accepted?}, timeoutMs?}` |
| `photo` | JPEG or PNG |
| `rgb:<tag>` / `xyz:<tag>` | the satellite render, and float32 LE H×W×3 ENU (rows top→bottom, sky = 0) |
| `skyline:horizon` / `skyline:fine` / `skyline:fg` / `skyline:sky` | optional float32: `engine.horizonDirs`, and `edge.fine`, `edge.fg` and `edge.sky` after `autoAlign` (w×h, row 0 = top) |

The skyline cue comes from the first source available:
1. the `skyline:*` parts;
2. otherwise, if `photoId` is given, the worker exports it from the app;
3. otherwise there is none, and the response is `method:"render-match"`, `confidenceLevel:"low"`.

### Response (v0.2, fused)

Real response (IMG_7155, warm):

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

- **`pose`** is the fused pose, with focal refined behind fusion's 5 % EXIF prior.
- **`inliers`, `inlierFrac`, `residualPx` and `coverage`** are match statistics *at the fused pose*: lifted matches within 6 px, and their RMS.
- **`confidenceChecks`** are the three quantities of the a-priori rule:
  - `cueAgreeDeg` is the rotation angle between the skyline-only and match-only solutions;
  - `skylineMedPx` and `matchSupport` are measured at the fused pose.
- **`cues.skyline.pose`** is the app's `autoAlign` answer after the acceptance rule. **`cues.match.pose`** is fusion's match-only LM pose. Its `inliers` and `residualPx` are the RANSAC inliers and their RMSE.
- **`fusionScore`** is `fusion.md`'s continuous summary, the same value as the leaderboard confidence.
- **`matchConfidence`** is the v0.1 heuristic.
- **If the skyline cue is unavailable**, the response has `method:"render-match"`, `confidenceLevel:"low"`, `confidence:0.2`, `cues.skyline:null` and `skylineUnavailable:"<reason>"`, with the render-match pose. The HIGH rule needs both cues, so it can't pass.
- **`{fused:false}`** returns exactly the v0.1 response plus `method:"render-match"`. `confidence` is then the old 0–1 heuristic, and there's no `confidenceLevel`.

## TypeScript client (`src/lib/matcher-client.ts`)

```ts
matcherAvailable(force?: boolean): Promise<boolean>
requestMatch(req: MatchRequest, opts?: { signal?: AbortSignal; timeoutMs?: number /* 60000 */ }): Promise<MatchResult | null>
matchIsConfident(m: MatchResult): boolean   // confidenceLevel === 'high', else (old servers) confidence >= 0.5
shouldEscalate({ skylineConfidence, skylinePose, altSkylinePose?, minConfidence = 0.5, maxSolverDisagreeDeg = 1 }): boolean
type MatchRequest =
  | { photoId: string; prior: Pose; offsets?: number[]; fused?: boolean; freeFocal?: boolean }
  | { photo: Blob; prior: Pose; eye: [number, number, number]; views: MatchView[]; skyline?: SkylineCueInput; photoId?: string; fused?: boolean }
```

- **`MatchResult`** gains optional fields: `method`, `confidenceLevel`, `confidenceChecks`, `cues`, `fusionScore`, `matchConfidence` and `skylineUnavailable`. The v0.1 fields are unchanged.
- **Graceful degradation is unchanged:** the client returns `null` when the service is down, times out, is aborted, returns an HTTP error or finds no pose. It never throws.
- **`shouldEscalate` was changed by another session** since v0.1. It no longer compares against the compass prior, which fired on about half the photos. It now escalates when:
  - there is no skyline result;
  - skyline confidence is below 0.5;
  - an optional second skyline solver disagrees by more than 1° in yaw or pitch.

  I kept that change. The snippet below uses the new signature.
- **Checks:** lint-clean under `biome lint`, and type-checks under the repo's strict flags.

## Test results (M3 Pro, MPS, dev server shared with other sessions)

### Parity with `tools/matcher/results-fusion.json` (true compass, service end to end)

| photo | service fused yaw / pitch / roll / vfov | Δ vs results-fusion.json (yaw / pitch / roll) | level | cueAgree / skyMed / support |
|---|---|---|---|---|
| IMG_7155 (4 runs) | 235.916–235.918 / −8.389…−8.391 / −3.851…−3.854 / 52.51 | −0.003…−0.001 / ≤ 0.002 / ≤ 0.001 | HIGH | 0.16–0.18° / 0.70 px / 0.80–0.91 |
| IMG_7086 (2 runs) | 162.681 / −7.631 / +0.505 / 52.39 | +0.004…+0.005 / +0.004 / +0.004 | LOW | 2.54° / 11.7 px / 0.87 |
| IMG_7131 (2 runs) | 10.676 / −4.522 / +0.063 / 52.44 | +0.002 / +0.001 / −0.001 | HIGH | 0.12° / 0.97 px / 0.96 |
| IMG_7108 (2 runs) | 62.793–62.817 / 1.78–1.81 / 3.15–3.20 / 66.8–67.0 | +0.002…+0.026 / ≤ 0.026 / ≤ 0.059 | **HIGH, yaw ≈ 62.8** | 0.31–0.36° / 0.82–0.85 px / 0.50–0.53 |
| IMG_7086, prior +15° | 162.671 / −7.635 / +0.522 | vs `fusion_default` shift +15: +0.028 / +0.008 / −0.002 | LOW | 14.54° / 4.9 px / 0.86 |

- **The residual differences are all match-side.** Each request renders and matches afresh, so the lifted match sets differ slightly as imagery and DEM tiles stream in. Offline, on the same inputs, the wrapper is bit-exact.
- **The IMG_7086 skyline cue has moved.** The app's `autoAlign` from the unshifted prior now returns 162.08 / −10.11, where the export used for `fusion.md` had 162.25 / −7.26. So cueAgree is 2.5° instead of 0.7°. It is still LOW, and the fused pose is unchanged. That points to an app-side skyline change since the export.
- **IMG_7086 at +15° shows why fusion helps.** Skyline falls back to the shifted prior (yaw 177.2), the match cue recovers 162.67, and fused lands at +0.05° from the pin GT. It is correctly LOW, because the cues disagree by 14.5°.

### Timings (ms)

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

- **What the skyline cue costs:** the in-page export (`autoAlign` + readback) is ~0.2 s. The fusion solve is 2.7–3.5 s warm and up to 5.4 s, on the CPU, dominated by the horizon-polyline crossing test with numeric Jacobians (see `fusion.md`). Together, **fused adds ~3.2 s to a warm request**: 6.2 s against 3.0 s.
- **Multipart mode (IMG_7131, 5 views):**

  | skyline source | total | result |
  |---|---|---|
  | inline `skyline:*` parts | 6.8 s | fused, HIGH, yaw 10.674 |
  | `photoId` exported by the worker | 16.2 s (9.7 s cold-page skyline export) | identical pose |
  | none | 2.9 s | render-match, LOW, confidence 0.2 |
  | `fused:false` | 2.8 s | v0.1 response, confidence 0.83 |

### TS client (`npx tsx`, session scratchpad): 17/17 passed

- **`shouldEscalate`** (new signature):
  - high confidence with no second solver: no escalation;
  - confidence 0.3: escalate;
  - solvers 1.5° apart: escalate;
  - wraparound 359.6° vs 0.2°: no escalation;
  - no skyline result: escalate.
- **`matcherAvailable`:** true in 18 ms, cached in 0 ms.
- **`requestMatch`:**
  - photoId mode on IMG_7155: `method:"fused"`, `confidenceLevel:"high"`, `confidence:0.9`, yaw 235.918.
  - `fused:false`: the legacy render-match result, yaw 236.051.
  - `timeoutMs:300` returned `null` after 303 ms.
  - Aborting the signal returned `null` after 201 ms.
  - A 404 returned `null`.
  - Multipart with inline skyline through the client's `FormData` builder: fused, HIGH, yaw 235.917, 4.3 s for 3 views.
  - Multipart without skyline: render-match, LOW, 0.2, and `matchIsConfident` is false.
- **Service down:**
  - Killing the server while "up" was cached: `requestMatch` returned `null` in 9 ms.
  - A fresh process with the server down: `matcherAvailable` returned false in 14 ms, and `requestMatch` returned `null` in 0 ms.

## Note for the app owner (session mt-image-9e)

**Apply a match only when `confidenceLevel === "high"`.** `matchIsConfident(m)` does this, and falls back to `m.confidence >= 0.5` for a v0.1 server. HIGH maps to `confidence` 0.9 and LOW to 0.2, so an existing `m.confidence < 0.5` gate keeps working.

**Where to add it.** In `src/components/PhotoWorkspace.tsx`, in the init effect, directly after the `autoAlign(true)` acceptance block (the `if (res && res.confidence > 0.2) … else if (near) … else …` block) and before `setStatus(null)`. I did not edit the file.

```tsx
// import { matchIsConfident, requestMatch, shouldEscalate } from '#/lib/matcher-client'

        // --- optional fused skyline + render-match escalation (tools/matcher/server; no-op when not running) ---
        if (
          !navigator.webdriver && // the service's own headless renderer loads this page too
          shouldEscalate({ skylineConfidence: res?.confidence, skylinePose: res?.pose })
        ) {
          const poseBefore = engine.pose
          void requestMatch({ photoId: photo.id, prior: engine.prior }, { signal: escalation.signal, timeoutMs: 45_000 }).then(
            (m) => {
              if (!m || engineRef.current !== engine) return // service down / timed out / superseded engine
              if (engine.pose !== poseBefore) return // user dragged, pinned or re-aligned meanwhile: don't clobber
              if (!matchIsConfident(m)) return // LOW: keep the skyline/compass pose
              setPose(m.pose, false) // fused yaw/pitch/roll + refined vfov
              const c = m.confidenceChecks
              setAlignNote(
                `Skyline + terrain texture agree${c?.cueAgreeDeg != null ? ` (${c.cueAgreeDeg.toFixed(1)}°)` : ''} · fused alignment`,
              )
            },
          )
        }
```

Plus the abort wiring, in the same effect:

```tsx
    const escalation = new AbortController() // next to `const off = engine.onRender(...)`
    // ...and in the effect's cleanup, before engine.dispose():
    escalation.abort()
```

Notes:

- **Dev only as written.** `{photoId, prior}` makes the service drive `localhost:3100/photo/<ID>`.
  - For prod, send the multipart form. `requestMatch({photo, prior, eye, views, skyline})` builds it.
  - `skyline` is `{w: engine.edge.w, h: engine.edge.h, pose: res.pose, confidence: res.confidence, horizon: engine.horizonDirs, fine: engine.edge.fine, fg: engine.edge.fg, sky: Float32Array.from(engine.edge.sky)}`, captured right after `autoAlign(true)`.
- **Timing.** The match takes ~6 s warm and ~16–20 s on a cold page, so show the skyline pose first and upgrade it if the match returns HIGH.
- **When it applies.** On the pin set, 23 of 33 cases were HIGH and all were within 1°. LOW cases (e.g. IMG_7086, IMG_7059, wrong GPS) leave the skyline pose in place, which is the safe default.
- **An optional note for LOW results with only a failed skyline.** If `m.cues?.skyline` shows a failed skyline (`accepted === 'prior'`) and `m.cues.match` has many inliers, you could show "terrain match suggests yaw X" without applying it. IMG_7086 is the example.

## Limitations / next steps

- **Fusion runs on the CPU and costs ~3 s.** It could be vectorised: `sky_curve`'s all-segments × all-columns crossing test with numeric Jacobians.
- **Single job at a time.** A second client waits in the queue, up to its own timeout.
- **Mode (a) is dev-only.** Prod needs the app to produce its own views plus the skyline arrays (mode b).
- **The skyline cue follows the live app.** If `align.ts` changes, the server's skyline cue changes with it (as seen on IMG_7086). The HIGH rule still needs both cues to agree.
- **Imagery licences.** Server-side use of swisstopo or Esri imagery for production needs a terms check (see `reports/matcher.md`).

## v0.1 (render-match only, `fused:false`) results, for reference

- IMG_7155: yaw 236.04–236.07, Δyaw −0.16 vs the pin GT.
- IMG_7086: yaw 162.68–162.77, Δyaw +0.11…+0.13.
- Warm requests take 3.0–4.2 s and cold pages 12–15 s.
- Inlier counts vary between identical requests (859–3075) while the pose stays within 0.03°, because tiles stream in after `[data-ready]`.

## v0.3.5: slow down ticketless busy clients

- **Delay:** a busy `503` for a request *without* an `X-Queue-Ticket` header is held for up to `MATCHER_TARPIT_S` (default 2 s) before it's sent. At most `MATCHER_TARPIT_MAX` (default 16) are held at once; any beyond that are answered immediately.
- **Logging:** these 503s aren't logged one per line. A summary line is written every 30 s instead.
- **Why:** a greedy client re-polling straight after each 503 was running at about 40 req/s and grew the log by 1.2 MB during the v0.3.4 e2e.
- **Clients that honour tickets:** they send the ticket back, so they skip the delay and see no change.
- **Test:** on a throwaway instance, ticketless 503s came back after 2 s, or 7 s when the request first waited for the waiter slot, and no per-request 503 lines were logged.
