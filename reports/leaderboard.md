# Summit Lens leaderboard

Generated 2026-09-25T04:40:34.409Z by `node scripts/leaderboard.mjs` in 57 s. App: http://localhost:3100. Machine-readable version: `reports/leaderboard.json` (schema at the top of the script).

## Recommended pipeline

**CPU classic+cascade (recommended default)** as the default: 11/12 correct accepts, 0 false accept(s), 0 error(s) > 2°, median 958 ms; tied on accept counts with CPU classic+cascade2, CPU classic+skyfirst (high-accuracy mode) (their median |yaw| differences are inside GT noise, so the cheapest wins). **No agreement gate beats CPU classic+cascade (recommended default) alone on this set.** Alone it escalates 1/13 photos (8%: IMG_7059), 0 false accept(s) and 0 > 2° on 11 accepted GT photos, members' median ms sum 958; only 1 escalated GT photo(s), too few to pick an escalation tier from data (best on this set: App GPU aligner (final), 1/1 accepted within 1°); until then show the prior flagged "unverified" or ask for manual pins. The best gate (2 of 3 (app, cascade, refine+sky): accept only when any two of app, cascade, refine+sky agree within 1° yaw) escalates 2/13 photos (15%: IMG_7059, IMG_7130), 0 false accept(s) and 0 > 2° on 10 accepted GT photos, members' median ms sum 2160: no fewer false accepts or > 2° errors, 1 more escalation(s) and 2.3× the cost. Treat a gate as defence-in-depth that this 12-photo set does not support.

Derived from accept counts, false accepts, > 2° errors and escalation rates only (never from sub-0.3° median differences, which are inside the ~0.2–0.4° noise of 'approx' GT).

## What's blocking SoTA

- **Ground truth covers 12/13 photos** (12 ground-truth.json poses, 11 control-point solves). Missing: IMG_7108. The SoTA report asks for a 50–100 photo in-house set; every number below rests on 12 photo(s).
- **App GPU aligner (final)**: 10/12 correct accepts, 1 false accept(s) (IMG_7130 (2.98°)), 1 > 2°; within noise of target (median |yaw| 0.33° is within GT noise of the 0.3° target); beats published SoTA (mean 0.466° vs Porzi 1.23°, 92% ≤1° vs LandscapeAR 39%).
- **CPU classic+cascade (recommended default)**: 11/12 correct accepts, 0 false accept(s), 0 > 2°; meets target; beats published SoTA (mean 0.224° vs Porzi 1.23°, 100% ≤1° vs LandscapeAR 39%).
- **CPU classic+skyfirst (high-accuracy mode)**: 11/12 correct accepts, 0 false accept(s), 0 > 2°; meets target; beats published SoTA (mean 0.176° vs Porzi 1.23°, 100% ≤1° vs LandscapeAR 39%).
- **refine**: 9/12 correct accepts, 0 false accept(s), 1 > 2°; meets target; beats published SoTA (mean 0.634° vs Porzi 1.23°, 92% ≤1° vs LandscapeAR 39%).
- **refine+sky**: 8/12 correct accepts, 0 false accept(s), 0 > 2°; meets target; beats published SoTA (mean 0.265° vs Porzi 1.23°, 92% ≤1° vs LandscapeAR 39%).
- **render-match (ALIKED+LightGlue, sat, rot_fixf)**: 10/12 correct accepts, 0 false accept(s), 1 borderline accept(s) inside GT noise (IMG_7059 (1.03°)), 0 > 2°; within noise of target (83% within 1°, 92% counting the borderline IMG_7059 (1.03°)); beats published SoTA (mean 0.405° vs Porzi 1.23°, 83% ≤1° vs LandscapeAR 39%).
- **fusion (skyline + render-match)**: 9/12 correct accepts, 0 false accept(s), 0 > 2°; meets target; beats published SoTA (mean 0.293° vs Porzi 1.23°, 92% ≤1° vs LandscapeAR 39%).
- Other ranked variants: meet the target (or are within noise of it): CPU classic+cascade2, CPU classic+cascade, HORIZON=fast, render-match + 1 refinement render (within noise: 83% within 1°, 92% counting the borderline IMG_7059 (1.03°)); false accepts: render-match + 1 refinement render (IMG_7130 (1.75°)); CPU ONNX sky+solve (IMG_7053 (-5.61°)); borderline accepts inside GT noise: render-match + 1 refinement render (IMG_7059 (1.03°)).
- Worst photos for App GPU aligner (final): IMG_7130 (2.983° yaw, 82.3 px).
- App GPU aligner (final) accepts 1 wrong pose(s): IMG_7130 (conf 0.397, 2.983° off). Simulated fix, accept only confidence > 0.397: the 1 newly rejected photo(s) fall back (IMG_7130 2.983° → prior 4.017°); within 1° 11/12 → 11/12, mean |yaw| 0.466° → 0.552°. No gain: a higher threshold alone does not fix this; the fallback (or an escalation tier) has to.
- Worst photos for refine: IMG_7059 (5.651° yaw, 104.3 px, rejected).
- Worst photos for refine+sky: IMG_7059 (-1.333° yaw, 26.9 px, rejected).
- Worst photos for render-match (ALIKED+LightGlue, sat, rot_fixf): IMG_7130 (1.884° yaw, 47.7 px, rejected), IMG_7059 (1.029° yaw, 20.2 px).
- Worst photos for fusion (skyline + render-match): IMG_7130 (1.918° yaw, 48.9 px, rejected).
- App GPU aligner (final) and CPU classic+cascade (recommended default) disagree by > 1° yaw on 1/13 photos (IMG_7130 3°). Where GT exists the first is closer on 0/1.
- Load (median of n=3, carried over from 2026-09-25T03:31:38.380Z): cold 11.1 s with 59.5 MiB on the wire (all origins, incl. DEM tiles and the segmentation model); warm reload 6.2 s with 8 KiB on the wire (472/512 requests from cache). The warm load barely touches the network yet stays slow, so the time is in-browser compute (horizon renders, segmentation, alignment).
- The two GT sources disagree by > 0.3° yaw on IMG_6958 (0.376°), IMG_7155 (-0.334°). Reconcile them before trusting sub-degree numbers.
- The control-point GT (secondary column) is solved in-page from a subset of the labelled points: engine.controlPins has no level constraint for lake waterlines and no OSM-node-id lookup (region JSON carries no ids), so IMG_6958 drops 2 level, IMG_6971 drops 2 level, IMG_7059 drops 1 node/<id>, IMG_7131 drops 1 node/<id>. The primary GT (ground-truth.json, the app pipeline's solve with all points) is unaffected.
- tsc: 2 errors (matcher/deck 2).
- biome: 94 errors (refine/sky 28, app 17, upload/export 33, matcher/deck 1, unowned 17).
- Cold time-to-ready median 11.1 s (n=3) is over the 10 s target.

Targets: median |yaw| ≤ 0.3°, ≥ 90% of photos within 1°. "Within noise of target" = a median at most 0.1° over the bar, or a ≤ 1° rate that meets the bar once the borderline (GT-band) photos are counted; neither is called a pass or a miss. Published reference points from the SoTA report: Porzi et al. 1.23° mean error; LandscapeAR 39% within 1°.

## Leaderboard (ranked)

Every method is re-scored here against one GT snapshot (`out/lead/leaderboard/gt-snapshot/`, taken 2026-09-25T04:39:37.669Z; ground-truth.json sha1 836c5a146ec6), against the primary GT per photo. Ranked by fewest false accepts, then most correct accepts, fewest > 2° errors, most clearly within 1° (as fractions of each method's n); ties share a rank and are ordered by median time. **GT-uncertainty band:** on photos whose GT is 'approx' (0.3° either side of 1°: 1 ± 0.3°) an error cannot be called right or wrong at the 1° line, so it is counted as *borderline*, not as a correct or false accept (and not in 'clearly ≤ 1°'); 'good' GT has no band. **Median |yaw| is shown but not ranked on:** differences under ~0.3° are inside GT noise.

| rank | method | n | correct accepts (clearly < 1°) | false accepts (clearly ≥ 1°) | borderline accepts | > 2° | clearly ≤ 1° / ≤ 1° | median \|yaw\| | mean \|yaw\| | max \|yaw\| | median px | median ms (all photos) | source age |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | CPU classic+cascade (recommended default) | 12 | 11/12 | 0 | 0 | 0 | 12/12 of 12 | 0.20° | 0.22° | 0.62° | 13.1 | 958 | 72 min |
| 1 | CPU classic+cascade2 | 12 | 11/12 | 0 | 0 | 0 | 12/12 of 12 | 0.20° | 0.21° | 0.62° | 13.1 | 1523 | 65 min |
| 1 | CPU classic+skyfirst (high-accuracy mode) | 12 | 11/12 | 0 | 0 | 0 | 12/12 of 12 | 0.13° | 0.18° | 0.62° | 9.6 | 1785 | 64 min |
| 4 | CPU classic+cascade, HORIZON=fast | 12 | 10/12 | 0 | 0 | 0 | 11/12 of 12 (borderline: IMG_7063 (-0.95°)) | 0.18° | 0.27° | 0.95° | 12.6 | 594 | 63 min |
| 5 | render-match (ALIKED+LightGlue, sat, rot_fixf) | 12 | 10/12 | 0 | 1 (IMG_7059 (1.03°)) | 0 | 10/10 of 12 (borderline: IMG_7059 (1.03°)) | 0.20° | 0.41° | 1.88° | 15 | 18223 | 34 min |
| 6 | fusion (skyline + render-match) | 12 | 9/12 | 0 | 0 | 0 | 11/11 of 12 | 0.07° | 0.29° | 1.92° | 8.6 | 22294 | 34 min |
| 7 | refine | 12 | 9/12 | 0 | 0 | 1 (IMG_7059) | 11/11 of 12 | 0.19° | 0.63° | 5.65° | 11.2 | 209 | 68 min |
| 8 | CPU classic+refine | 12 | 9/12 | 0 | 0 | 2 (IMG_6971, IMG_7130) | 10/10 of 12 | 0.22° | 1.28° | 9.13° | 11.5 | 1000 | 74 min |
| 9 | refine+sky | 12 | 8/12 | 0 | 0 | 0 | 11/11 of 12 | 0.18° | 0.27° | 1.33° | 9.8 | 1046 | 68 min |
| 10 | CPU classic+solve, HORIZON=fast | 12 | 8/12 | 0 | 0 | 1 (IMG_7155) | 9/10 of 12 (borderline: IMG_7063 (-0.95°)) | 0.24° | 1.24° | 10.28° | 15.4 | 290 | 64 min |
| 11 | CPU ONNX sky+refine | 12 | 8/12 | 0 | 0 | 2 (IMG_7053, IMG_7130) | 9/9 of 12 | 0.28° | 1.02° | 4.79° | 11.9 | 2306 | 73 min |
| 12 | render-match + 1 refinement render ¹ | 12 | 10/12 | **1** (IMG_7130 (1.75°)) | 1 (IMG_7059 (1.03°)) | 0 | 10/10 of 12 (borderline: IMG_7059 (1.03°)) | 0.20° | 0.41° | 1.75° | 14.8 | 3191 | 64 min |
| 13 | App GPU aligner (final) | 12 | 10/12 | **1** (IMG_7130 (2.98°)) | 0 | 1 (IMG_7130) | 11/11 of 12 | 0.33° | 0.47° | 2.98° | 12.1 | 156 | this run |
| 14 | CPU ONNX sky+solve | 12 | 8/12 | **1** (IMG_7053 (-5.61°)) | 0 | 1 (IMG_7053) | 9/10 of 12 (borderline: IMG_7063 (-0.95°)) | 0.16° | 0.81° | 5.61° | 11.6 | 1828 | 74 min |
| = | CPU skyline solver (final), out/eval | | | | | | | | | | | | same results as CPU classic+solve, HORIZON=fast |
| ref | Prior (compass + gravity) | 12 | – | – | – | 7 | 3/4 of 12 | 3.31° | 4.46° | 10.28° | 113.5 | 0 | – |

¹ No accept/reject signal in the source, so it counts as always accepting (every error clearly ≥ 1° is a false accept). 'Correct/false accepts' use the method's own accept flag (app: confidence > 0.2; CPU variants: the app pipeline's accept; refine and matcher contract files: their `accepted`; fused from fusion_default.json: confidence level HIGH). '> 2°' and '≤ 1°' score the pose as shown: a rejected CPU photo shows the prior, the app shows its fallback, external methods (refine, matcher) are scored on the pose in their file even when they rejected it. Median ms: CPU = skyline + solve on Node; app = autoAlign in the browser; matcher = match + solve on the MPS GPU, rendering excluded.

## Oracle / ensemble (product decision input)

Members: app = App GPU aligner (final); cascade = CPU classic+cascade (recommended default); refine+sky = refine+sky; matcher = render-match (ALIKED+LightGlue, sat, rot_fixf). 13 photos, 12 with GT.

**(a) Lowest skyline residual among app / cascade / refine+sky:** not computable: residuals are not reported comparably (app's autoAlign score is an edge score, not px; cascade's residualPx is null whenever refinePose produced the pose; refine+sky rows carry none). Residuals available per member: app 0/13, cascade 9/13, refine+sky 0/13. Stand-ins:

- GT oracle (best of the three by true error among the poses each member would show: a member that rejected contributes its fallback / the prior, never its rejected pose; an upper bound for any selector): 12/12 within 1°, median 0.10°, max 0.35°; wins cascade 4, app 5, refine+sky 3.
- Highest raw confidence among accepting members (GT-free, **not evidence for a selector**): 12/12 within 1°, median 0.13°, max 0.40°; 0/13 photos have no accepting member. The members' confidences are on uncalibrated, non-comparable scales, and 7/13 picks are ties (IMG_6958, IMG_6971, IMG_7033, IMG_7063, IMG_7108, IMG_7131, IMG_7155) broken by member order (app → cascade → refine+sky); picks: app 9, cascade 3, refine+sky 1. In effect it is "use app unless it rejects".

**(b) Agreement gate:** accept when two members' accepted poses agree within 1° yaw (output = their mean), else escalate. A rejected pose is not a vote. The first row is the baseline every gate must beat: the recommended default alone (accepted when it accepts, escalated when it rejects).

| gate | accepted | escalated (rate) | false accepts on GT | borderline | > 2° | correct / accepted GT | median \|yaw\| accepted | max | best escalation target (≤ 1° on escalated GT) | overall ≤ 1° | members' median ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **cascade alone (baseline: accept when it accepts)** | 12/13 | 1 (8%): IMG_7059 | 0 | 0 | 0 | 11/11 | 0.16° | 0.46° | App GPU aligner (final): 1/1 | 12/12 | 958 |
| app + cascade | 10/13 | 3 (23%): IMG_7059, IMG_7086, IMG_7130 | 0 | 0 | 0 | 9/9 | 0.11° | 0.39° | CPU classic+solve, HORIZON=fast: 2/3 | 11/12 | 1114 |
| app + refine+sky | 7/13 | 6 (46%): IMG_7053, IMG_7059, IMG_7068, IMG_7086, IMG_7108, IMG_7130 | 0 | 0 | 0 | 7/7 | 0.10° | 0.37° | CPU classic+cascade, HORIZON=fast: 4/5 | 11/12 | 1202 |
| app + matcher | 10/13 | 3 (23%): IMG_7059, IMG_7086, IMG_7130 | 0 | 0 | 0 | 9/9 | 0.18° | 0.43° | CPU classic+solve, HORIZON=fast: 2/3 | 11/12 | 18379 |
| cascade + refine+sky | 8/13 | 5 (39%): IMG_7053, IMG_7059, IMG_7068, IMG_7108, IMG_7130 | 0 | 0 | 0 | 8/8 | 0.14° | 0.35° | CPU classic+cascade, HORIZON=fast: 3/4 | 11/12 | 2004 |
| cascade + matcher | 11/13 | 2 (15%): IMG_7059, IMG_7130 | 0 | 0 | 0 | 10/10 | 0.10° | 0.46° | CPU classic+solve, HORIZON=fast: 1/2 | 11/12 | 19181 |
| refine+sky + matcher | 8/13 | 5 (39%): IMG_7053, IMG_7059, IMG_7068, IMG_7108, IMG_7130 | 0 | 0 | 0 | 8/8 | 0.14° | 0.38° | CPU classic+cascade, HORIZON=fast: 3/4 | 11/12 | 19269 |
| 2 of 3 (app, cascade, refine+sky) | 11/13 | 2 (15%): IMG_7059, IMG_7130 | 0 | 0 | 0 | 10/10 | 0.12° | 0.39° | CPU classic+solve, HORIZON=fast: 1/2 | 11/12 | 2160 |
| 2 of 4 (app, cascade, refine+sky, matcher) | 11/13 | 2 (15%): IMG_7059, IMG_7130 | 0 | 0 | 0 | 10/10 | 0.14° | 0.46° | CPU classic+solve, HORIZON=fast: 1/2 | 11/12 | 20383 |

Escalation rate is over all photos (GT or not); false accepts and 'overall' are over GT photos. An escalation target only counts a photo it accepts (a rejected method showing a lucky prior does not count). 'Overall ≤ 1°' = gate-accepted correct + escalated photos the best target accepts within 1°.

## Accuracy detail

### Against the primary GT per photo (ground-truth.json if quality good/approx, else the control-point solve)

| method | n | median \|yaw\| | mean \|yaw\| | max \|yaw\| | median \|pitch\| | median \|roll\| | median px | max px | ≤0.5° | ≤1° | accepted | median ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Prior (compass + gravity) | 12 | 3.31° | 4.46° | 10.28° | 0.76° | 0.59° | 113.5 | 253.7 | 1/12 (8%) | 4/12 (33%) | n/a (always) | 0 |
| App GPU aligner (final) | 12 | 0.33° | 0.47° | 2.98° | 0.26° | 0.30° | 12.1 | 82.3 | 11/12 (92%) | 11/12 (92%) | 11/12 | 154 |
| App GPU aligner (raw) | 12 | 0.33° | 0.93° | 5.91° | 0.28° | 0.31° | 12.1 | 157.2 | 10/12 (83%) | 10/12 (83%) | 11/12 | 154 |
| CPU classic+cascade (recommended default) | 12 | 0.20° | 0.22° | 0.62° | 0.23° | 0.41° | 13.1 | 28.8 | 11/12 (92%) | 12/12 (100%) | 11/12 | 899 |
| CPU classic+skyfirst (high-accuracy mode) | 12 | 0.13° | 0.18° | 0.62° | 0.21° | 0.28° | 9.6 | 28.8 | 11/12 (92%) | 12/12 (100%) | 11/12 | 1804 |
| CPU skyline solver (final), out/eval | 12 | 0.25° | 1.24° | 10.28° | 0.28° | 0.48° | 15.3 | 253.7 | 8/12 (67%) | 10/12 (83%) | 8/12 | 245 |
| CPU skyline solver (raw), out/eval | 12 | 0.25° | 0.84° | 5.77° | 0.23° | 0.48° | 16.2 | 152.2 | 9/12 (75%) | 9/12 (75%) | 8/12 | 245 |
| CPU classic+cascade, HORIZON=fast | 12 | 0.18° | 0.27° | 0.95° | 0.22° | 0.37° | 12.6 | 28.8 | 10/12 (83%) | 12/12 (100%) | 10/12 | 546 |
| CPU classic+cascade2 | 12 | 0.20° | 0.21° | 0.62° | 0.23° | 0.41° | 13.1 | 28.8 | 11/12 (92%) | 12/12 (100%) | 11/12 | 1580 |
| CPU classic+refine | 12 | 0.22° | 1.28° | 9.13° | 0.21° | 0.31° | 11.5 | 225.3 | 9/12 (75%) | 10/12 (83%) | 9/12 | 998 |
| CPU classic+solve, HORIZON=fast | 12 | 0.24° | 1.24° | 10.28° | 0.27° | 0.48° | 15.4 | 253.7 | 8/12 (67%) | 10/12 (83%) | 8/12 | 274 |
| CPU ONNX sky+refine | 12 | 0.28° | 1.02° | 4.79° | 0.29° | 0.25° | 11.9 | 121.2 | 8/12 (67%) | 9/12 (75%) | 8/12 | 2463 |
| CPU ONNX sky+solve | 12 | 0.16° | 0.81° | 5.61° | 0.18° | 0.25° | 11.6 | 139.6 | 8/12 (67%) | 10/12 (83%) | 9/12 | 1817 |
| refine | 12 | 0.19° | 0.63° | 5.65° | 0.12° | 0.36° | 11.2 | 104.3 | 11/12 (92%) | 11/12 (92%) | 9/12 | 239 |
| refine+sky | 12 | 0.18° | 0.27° | 1.33° | 0.15° | 0.16° | 9.8 | 26.9 | 11/12 (92%) | 11/12 (92%) | 8/12 | 1179 |
| fusion (skyline + render-match) | 12 | 0.07° | 0.29° | 1.92° | 0.19° | 0.21° | 8.6 | 48.9 | 11/12 (92%) | 11/12 (92%) | 9/12 | 22403 |
| render-match (ALIKED+LightGlue, sat, rot_fixf) | 12 | 0.20° | 0.41° | 1.88° | 0.19° | 0.27° | 15 | 47.7 | 10/12 (83%) | 10/12 (83%) | 11/12 | 19347 |
| render-match + 1 refinement render | 12 | 0.20° | 0.41° | 1.75° | 0.18° | 0.35° | 14.8 | 44.9 | 10/12 (83%) | 10/12 (83%) | n/a (always) | 2980 |

### Against data/ground-truth.json poses (px = mean grid reprojection, 1600-px-wide image)

| method | n | median \|yaw\| | mean \|yaw\| | max \|yaw\| | median \|pitch\| | median \|roll\| | median px | max px | ≤0.5° | ≤1° | accepted | median ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Prior (compass + gravity) | 12 | 3.31° | 4.46° | 10.28° | 0.76° | 0.59° | 113.5 | 253.7 | 1/12 (8%) | 4/12 (33%) | n/a (always) | 0 |
| App GPU aligner (final) | 12 | 0.33° | 0.47° | 2.98° | 0.26° | 0.30° | 12.1 | 82.3 | 11/12 (92%) | 11/12 (92%) | 11/12 | 154 |
| App GPU aligner (raw) | 12 | 0.33° | 0.93° | 5.91° | 0.28° | 0.31° | 12.1 | 157.2 | 10/12 (83%) | 10/12 (83%) | 11/12 | 154 |
| CPU classic+cascade (recommended default) | 12 | 0.20° | 0.22° | 0.62° | 0.23° | 0.41° | 13.1 | 28.8 | 11/12 (92%) | 12/12 (100%) | 11/12 | 899 |
| CPU classic+skyfirst (high-accuracy mode) | 12 | 0.13° | 0.18° | 0.62° | 0.21° | 0.28° | 9.6 | 28.8 | 11/12 (92%) | 12/12 (100%) | 11/12 | 1804 |
| CPU skyline solver (final), out/eval | 12 | 0.25° | 1.24° | 10.28° | 0.28° | 0.48° | 15.3 | 253.7 | 8/12 (67%) | 10/12 (83%) | 8/12 | 245 |
| CPU skyline solver (raw), out/eval | 12 | 0.25° | 0.84° | 5.77° | 0.23° | 0.48° | 16.2 | 152.2 | 9/12 (75%) | 9/12 (75%) | 8/12 | 245 |
| CPU classic+cascade, HORIZON=fast | 12 | 0.18° | 0.27° | 0.95° | 0.22° | 0.37° | 12.6 | 28.8 | 10/12 (83%) | 12/12 (100%) | 10/12 | 546 |
| CPU classic+cascade2 | 12 | 0.20° | 0.21° | 0.62° | 0.23° | 0.41° | 13.1 | 28.8 | 11/12 (92%) | 12/12 (100%) | 11/12 | 1580 |
| CPU classic+refine | 12 | 0.22° | 1.28° | 9.13° | 0.21° | 0.31° | 11.5 | 225.3 | 9/12 (75%) | 10/12 (83%) | 9/12 | 998 |
| CPU classic+solve, HORIZON=fast | 12 | 0.24° | 1.24° | 10.28° | 0.27° | 0.48° | 15.4 | 253.7 | 8/12 (67%) | 10/12 (83%) | 8/12 | 274 |
| CPU ONNX sky+refine | 12 | 0.28° | 1.02° | 4.79° | 0.29° | 0.25° | 11.9 | 121.2 | 8/12 (67%) | 9/12 (75%) | 8/12 | 2463 |
| CPU ONNX sky+solve | 12 | 0.16° | 0.81° | 5.61° | 0.18° | 0.25° | 11.6 | 139.6 | 8/12 (67%) | 10/12 (83%) | 9/12 | 1817 |
| refine | 12 | 0.19° | 0.63° | 5.65° | 0.12° | 0.36° | 11.2 | 104.3 | 11/12 (92%) | 11/12 (92%) | 9/12 | 239 |
| refine+sky | 12 | 0.18° | 0.27° | 1.33° | 0.15° | 0.16° | 9.8 | 26.9 | 11/12 (92%) | 11/12 (92%) | 8/12 | 1179 |
| fusion (skyline + render-match) | 12 | 0.07° | 0.29° | 1.92° | 0.19° | 0.21° | 8.6 | 48.9 | 11/12 (92%) | 11/12 (92%) | 9/12 | 22403 |
| render-match (ALIKED+LightGlue, sat, rot_fixf) | 12 | 0.20° | 0.41° | 1.88° | 0.19° | 0.27° | 15 | 47.7 | 10/12 (83%) | 10/12 (83%) | 11/12 | 19347 |
| render-match + 1 refinement render | 12 | 0.20° | 0.41° | 1.75° | 0.18° | 0.35° | 14.8 | 44.9 | 10/12 (83%) | 10/12 (83%) | n/a (always) | 2980 |

### Against the control-point GT solve (px = mean reprojection at the labelled points, 1600-px basis)

| method | n | median \|yaw\| | mean \|yaw\| | max \|yaw\| | median \|pitch\| | median \|roll\| | median px | max px | ≤0.5° | ≤1° | accepted | median ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Prior (compass + gravity) | 11 | 2.97° | 4.54° | 10.61° | 0.61° | 1.10° | 97.4 | 252.4 | 2/11 (18%) | 3/11 (27%) | n/a (always) | 0 |
| App GPU aligner (final) | 11 | 0.30° | 0.28° | 0.62° | 0.26° | 0.34° | 7.9 | 24.4 | 9/11 (82%) | 11/11 (100%) | 10/11 | 151 |
| App GPU aligner (raw) | 11 | 0.30° | 0.79° | 5.90° | 0.26° | 0.34° | 7.9 | 164.1 | 8/11 (73%) | 10/11 (91%) | 10/11 | 151 |
| CPU classic+cascade (recommended default) | 11 | 0.17° | 0.24° | 0.56° | 0.22° | 0.37° | 8.6 | 19.3 | 10/11 (91%) | 11/11 (100%) | 10/11 | 958 |
| CPU classic+skyfirst (high-accuracy mode) | 11 | 0.09° | 0.17° | 0.46° | 0.17° | 0.30° | 6.9 | 20.4 | 11/11 (100%) | 11/11 (100%) | 10/11 | 1822 |
| CPU skyline solver (final), out/eval | 11 | 0.25° | 1.35° | 10.61° | 0.24° | 0.71° | 13.7 | 224.2 | 8/11 (73%) | 8/11 (73%) | 7/11 | 258 |
| CPU skyline solver (raw), out/eval | 11 | 0.25° | 0.90° | 5.44° | 0.24° | 0.62° | 13.7 | 166.8 | 7/11 (64%) | 8/11 (73%) | 7/11 | 258 |
| CPU classic+cascade, HORIZON=fast | 11 | 0.17° | 0.29° | 1.14° | 0.15° | 0.54° | 8.6 | 27.4 | 9/11 (82%) | 10/11 (91%) | 9/11 | 594 |
| CPU classic+cascade2 | 11 | 0.17° | 0.23° | 0.49° | 0.22° | 0.36° | 8.6 | 19.3 | 11/11 (100%) | 11/11 (100%) | 10/11 | 1653 |
| CPU classic+refine | 11 | 0.19° | 1.02° | 9.10° | 0.16° | 0.35° | 7.5 | 252.4 | 9/11 (82%) | 10/11 (91%) | 9/11 | 996 |
| CPU classic+solve, HORIZON=fast | 11 | 0.22° | 1.34° | 10.61° | 0.24° | 0.71° | 13.1 | 224.2 | 7/11 (64%) | 8/11 (73%) | 7/11 | 290 |
| CPU ONNX sky+refine | 11 | 0.23° | 0.73° | 4.75° | 0.15° | 0.26° | 8.6 | 123.6 | 8/11 (73%) | 9/11 (82%) | 8/11 | 2619 |
| CPU ONNX sky+solve | 11 | 0.16° | 0.86° | 5.57° | 0.15° | 0.62° | 9.2 | 137.9 | 8/11 (73%) | 8/11 (73%) | 8/11 | 1805 |
| refine | 11 | 0.19° | 0.67° | 5.39° | 0.22° | 0.35° | 7.5 | 64.3 | 9/11 (82%) | 10/11 (91%) | 9/11 | 268 |
| refine+sky | 11 | 0.14° | 0.31° | 1.59° | 0.22° | 0.26° | 7.5 | 20.5 | 9/11 (82%) | 10/11 (91%) | 8/11 | 1311 |
| fusion (skyline + render-match) | 11 | 0.15° | 0.18° | 0.66° | 0.12° | 0.27° | 7 | 22.7 | 10/11 (91%) | 11/11 (100%) | 9/11 | 22294 |
| render-match (ALIKED+LightGlue, sat, rot_fixf) | 11 | 0.16° | 0.24° | 0.77° | 0.07° | 0.23° | 10.5 | 22.5 | 10/11 (91%) | 11/11 (100%) | 11/11 | 20470 |
| render-match + 1 refinement render | 11 | 0.15° | 0.25° | 0.77° | 0.08° | 0.30° | 10.1 | 21.5 | 10/11 (91%) | 11/11 (100%) | n/a (always) | 3191 |

### Confidence calibration (primary GT, success = |yaw| < 1°)

| method | n | AUROC | Spearman(conf, \|yaw err\|) | conf <0.3 | 0.3–0.7 | ≥0.7 | confident failures | rejected successes |
|---|---|---|---|---|---|---|---|---|
| App GPU aligner (final) | 12 | 0.91 | -0.34 | 1 @ 0.39° | 2 @ 1.67° | 9 @ 0.23° | none | IMG_7086 |
| App GPU aligner (raw) | 12 | 1 | -0.48 | 1 @ 5.91° | 2 @ 1.67° | 9 @ 0.23° | none | none |
| CPU classic+cascade (recommended default) | 12 | – | -0.64 | 1 @ 0.62° | 3 @ 0.37° | 8 @ 0.13° | none | IMG_7059 |
| CPU classic+skyfirst (high-accuracy mode) | 12 | – | -0.27 | 1 @ 0.62° | 1 @ 0.23° | 10 @ 0.11° | none | IMG_7059 |
| CPU skyline solver (final), out/eval | 12 | 0.95 | -0.78 | 1 @ 10.28° | 4 @ 0.79° | 7 @ 0.13° | none | IMG_7059, IMG_7063 |
| CPU skyline solver (raw), out/eval | 12 | 1 | -0.79 | 1 @ 5.77° | 4 @ 0.83° | 7 @ 0.13° | none | IMG_7063 |
| CPU classic+cascade, HORIZON=fast | 12 | – | -0.65 | 2 @ 0.79° | 2 @ 0.34° | 8 @ 0.13° | none | IMG_7059, IMG_7063 |
| CPU classic+cascade2 | 12 | – | -0.38 | 1 @ 0.62° | 2 @ 0.35° | 9 @ 0.13° | none | IMG_7059 |
| CPU classic+refine | 12 | 0.93 | -0.85 | 2 @ 2.32° | 4 @ 0.30° | 6 @ 0.12° | none | IMG_7059 |
| CPU classic+solve, HORIZON=fast | 12 | 0.95 | -0.79 | 1 @ 10.28° | 4 @ 0.79° | 7 @ 0.13° | none | IMG_7059, IMG_7063 |
| CPU ONNX sky+refine | 12 | 0.91 | -0.62 | 2 @ 2.32° | 2 @ 3.23° | 8 @ 0.10° | none | IMG_7059 |
| CPU ONNX sky+solve | 12 | 0.85 | -0.57 | 2 @ 1.15° | 3 @ 0.95° | 7 @ 0.04° | none | IMG_7059, IMG_7063 |
| refine | 12 | 0.95 | -0.61 | 3 @ 0.20° | 3 @ 0.22° | 6 @ 0.12° | none | IMG_6971, IMG_7130 |
| refine+sky | 12 | 0.91 | -0.36 | 2 @ 0.78° | 2 @ 0.19° | 8 @ 0.13° | none | IMG_7053, IMG_7068, IMG_7130 |
| fusion (skyline + render-match) | 12 | 1 | -0.04 | 4 @ 0.04° | 8 @ 0.14° | – | none | IMG_7059, IMG_7086 |
| render-match (ALIKED+LightGlue, sat, rot_fixf) | 12 | 0.85 | -0.49 | – | 3 @ 0.45° | 9 @ 0.17° | none | none |

AUROC is blank until the set has both successes and failures. Spearman should be negative: higher confidence, lower error.

## Per photo (signed yaw error vs primary GT, degrees; confidence in brackets)

| photo | GT | GT agreement (json−cp yaw) | Prior (compass + gravity) | App GPU aligner (final) | CPU classic+cascade (recommended default) | CPU classic+skyfirst (high-accuracy mode) | refine | refine+sky | render-match (ALIKED+LightGlue, sat, rot_fixf) | fusion (skyline + render-match) | app−cascade yaw |
|---|---|---|---|---|---|---|---|---|---|---|---|
| IMG_6958 | json (approx) cp 3/5 pins | 0.38° (10.2 px) | **2.60** | -0.40 (1.00) | -0.27 (1.00) | -0.29 (1.00) | -0.28 (1.00) | -0.30 (1.00) | -0.45 (0.66) | -0.40 (0.42) | -0.13 |
| IMG_6971 | json (good) cp 2/4 pins | 0.03° (2.9 px) | **-9.13** | -0.04 (1.00) | 0.46 (0.51) | -0.03 (1.00) | 0.20 (0.29, rej) | -0.07 (1.00) | 0.46 (0.91) | 0.01 (0.50) | -0.50 |
| IMG_7018 | json (good) cp 7/7 pins | 0.02° (4.2 px) | **8.28** | -0.32 (1.00) | 0.23 (0.77) | -0.22 (0.98) | -0.21 (0.88) | -0.23 (0.95) | -0.35 (0.56) | -0.27 (0.66) | -0.55 |
| IMG_7033 | json (good) cp 5/5 pins | -0.02° (3.9 px) | 0.71 | 0.23 (1.00) | 0.04 (0.98) | 0.06 (1.00) | 0.06 (1.00) | -0.03 (1.00) | 0.01 (0.85) | 0.16 (0.64) | 0.20 |
| IMG_7053 | json (good) cp 3/3 pins | 0.03° (2.9 px) | **-4.79** | 0.34 (0.81) | -0.13 (0.83) | -0.13 (0.83) | 0.15 (0.56) | 0.11 (0.36, rej) | 0.03 (0.83) | -0.03 (0.24) | 0.47 |
| IMG_7059 | json (approx) cp 2/3 pins | -0.26° (9 px) | 0.62 | -0.35 (0.69) | 0.62 (0.00, rej) | 0.62 (0.00, rej) | **5.65** (0.00, rej) | **-1.33** (0.09, rej) | **1.03** (0.78) | -0.03 (0.13, rej) | -0.98 |
| IMG_7063 | json (approx) cp 2/2 pins | -0.18° (8.9 px) | -0.95 | -0.40 (1.00) | -0.37 (0.54) | -0.27 (1.00) | -0.38 (0.54) | -0.33 (1.00) | -0.20 (0.89) | -0.48 (0.49) | -0.03 |
| IMG_7068 | json (approx) cp 2/2 pins | -0.17° (5.1 px) | **1.67** | -0.08 (0.98) | 0.23 (0.55) | 0.23 (0.55) | 0.22 (0.55) | 0.27 (0.36, rej) | 0.02 (0.93) | -0.04 (0.64) | -0.31 |
| IMG_7086 | json (good) cp 4/4 pins | 0.01° (2.3 px) | -0.39 | -0.39 (0.00, rej) | 0.16 (0.98) | 0.09 (1.00) | 0.11 (1.00) | 0.13 (1.00) | 0.06 (0.77) | 0.04 (0.03, rej) | -0.55 |
| IMG_7108 | **missing** | – | yaw 49.1 | yaw 62.7 (1.00) | yaw 62.5 (1.00) | yaw 62.5 (1.00) | yaw 62.4 (0.00, rej) | yaw 62.3 (0.00, rej) | yaw 63.0 (0.70) | yaw 62.8 (0.55) | 0.24 |
| IMG_7130 | json (approx) | – | **-4.02** | **2.98** (0.40) | -0.02 (0.83) | -0.02 (0.83) | 0.17 (0.00, rej) | 0.23 (0.00, rej) | **1.88** (0.41, rej) | **1.92** (0.01, rej) | **3** |
| IMG_7131 | json (good) cp 3/4 pins | 0.03° (4.2 px) | **10.06** | -0.01 (1.00) | 0.02 (1.00) | 0.02 (1.00) | 0.03 (1.00) | 0.02 (1.00) | -0.21 (0.85) | -0.11 (0.70) | -0.03 |
| IMG_7155 | json (good) cp 2/2 pins | -0.33° (6.4 px) | **-10.28** | -0.03 (0.87) | -0.13 (1.00) | -0.13 (1.00) | -0.13 (1.00) | -0.13 (1.00) | 0.17 (0.93) | 0.04 (0.70) | 0.10 |

Headline methods only; every method's per-photo errors are in leaderboard.json. Cells without GT show the method's absolute yaw instead of an error. **Bold** = more than 1° off or more than 1° of disagreement.

### the app pipeline's own matcher summary (from report, not re-scored; tools/matcher/out/report_tables.md)

| method | n | median \|Δyaw\| | median \|Δpitch\| | median \|Δroll\| | median pin px | within 1° |
|---|---|---|---|---|---|---|
| prior | 11 | 2.97° | 0.61° | 1.10° | 97.4 | 3/11 |
| skyline auto | 11 | 0.30° | 0.26° | 0.34° | 7.9 | 11/11 |
| render-match | 11 | 0.16° | 0.07° | 0.23° | 10.5 | 11/11 |

Against the app pipeline's in-page control-point solve (engine.solvePins). Our re-score of render-match against the same kind of GT (the cp column): n=11, median |yaw| 0.16°, 11/11 within 1° (differences come from the GT snapshot and pin set).

### scripts/eval-app.mjs as printed (cross-check)

| photo | pins | gt resid px | prior px | auto px | Δyaw prior | Δyaw auto | Δpitch auto | Δroll auto |
|---|---|---|---|---|---|---|---|---|
| IMG_6958 | 3 | 6 | 97.4 | 24.4 | 2.97 | -0.03 | 0.13 | -3.15 |
| IMG_6971 | 2 | 13.7 | 252.4 | 3.1 | -9.10 | -0.01 | 0.28 | -0.17 |
| IMG_7018 | 7 | 4.2 | 208.5 | 9.1 | 8.30 | -0.30 | 0.30 | 0.08 |
| IMG_7033 | 5 | 3.9 | 57.7 | 5.8 | 0.69 | 0.22 | 0.05 | -0.20 |
| IMG_7053 | 3 | 0.7 | 123.6 | 7.9 | -4.75 | 0.37 | 0.37 | -1 |
| IMG_7059 | 2 | 8.3 | 9.8 | 11.9 | 0.36 | -0.62 | -0.05 | 0.76 |
| IMG_7063 | 2 | 1.8 | 27.4 | 10.1 | -1.14 | -0.59 | 0.26 | -0.54 |
| IMG_7068 | 2 | 2.3 | 77.9 | 4.1 | 1.50 | -0.25 | 0.09 | 0.34 |
| IMG_7086 | 4 | 0.7 | 19.5 | 19.5 | -0.38 | -0.38 | 0.33 | -0.27 |
| IMG_7108 | 0 | 0 | 0 | 0 | 0 | 13.59 | -1.70 | 0.80 |
| IMG_7130 | 1 | 0 | 108 | 66.1 | -4.12 | 2.88 | 1.71 | -1.20 |
| IMG_7131 | 3 | 1.8 | 224.3 | 6.9 | 10.09 | 0.02 | -0.37 | -0.24 |
| IMG_7155 | 2 | 0.3 | 224.2 | 1.7 | -10.61 | -0.36 | 0.09 | 0.40 |

eval-app summary: 11/13 within 1° yaw, median auto px 7.9. Agreement with this run's app step over 11 photos: max |Δpx| 0, max |Δyaw| 0° (separate page loads, so small differences are expected). (stale, from 2026-09-25T03:31:38.380Z)

## Performance

| photo | cold ready | warm ready | cold load event | cold last network response | cold requests / KiB on wire | warm requests / KiB on wire | page errors |
|---|---|---|---|---|---|---|---|
| IMG_6958 | 9.37 s | 5.05 s | 0.15 s | 8.86 s | 422 / 53941 | 422 / 8 | 0 |
| IMG_7063 | 12.19 s | 6.21 s | 0.24 s | 8.38 s | 522 / 60946 | 522 / 8 | 0 |
| IMG_7155 | 11.08 s | 6.53 s | 0.14 s | 6.94 s | 512 / 61816 | 512 / 8 | 0 |

If ready is much later than the last network response, the time goes to in-browser compute (horizon renders, segmentation, alignment), not downloads.

Median cold 11.08 s (n=3), warm 6.21 s (n=3). cold = fresh on-disk browser profile (empty HTTP cache/storage; the Vite dev server's own transform cache may be warm); warm = reload in the same profile. Sequential, one page at a time. Bytes = on-the-wire bytes of every response, cross-origin included (Chrome DevTools protocol). A load with >1 document request was reloaded mid-measurement (e.g. dev-server HMR) and is flagged. (stale, from 2026-09-25T03:31:38.380Z)

Bytes on the wire by origin (requests, of which from cache / KiB):

| photo | load | localhost:3100 | fonts.googleapis.com | fonts.gstatic.com | tiles.mapterhorn.com | cdn.jsdelivr.net | storage.googleapis.com |
|---|---|---|---|---|---|---|---|
| IMG_6958 | cold | 161 (0 cached) / 18876 | 1 (0 cached) / 1 | 1 (0 cached) / 25 | 256 (11 cached) / 15909 | 2 (0 cached) / 3132 | 1 (0 cached) / 15998 |
| IMG_6958 | warm | 161 (121 cached) / 8 | 1 (1 cached) / 0 | 1 (1 cached) / 0 | 256 (256 cached) / 0 | 2 (2 cached) / 0 | 1 (1 cached) / 0 |
| IMG_7063 | cold | 161 (0 cached) / 18690 | 1 (0 cached) / 1 | 1 (0 cached) / 25 | 356 (25 cached) / 23100 | 2 (0 cached) / 3132 | 1 (0 cached) / 15998 |
| IMG_7063 | warm | 161 (121 cached) / 8 | 1 (1 cached) / 0 | 1 (1 cached) / 0 | 356 (356 cached) / 0 | 2 (2 cached) / 0 | 1 (1 cached) / 0 |
| IMG_7155 | cold | 161 (0 cached) / 18693 | 1 (0 cached) / 1 | 1 (0 cached) / 25 | 346 (17 cached) / 23967 | 2 (0 cached) / 3132 | 1 (0 cached) / 15998 |
| IMG_7155 | warm | 161 (121 cached) / 8 | 1 (1 cached) / 0 | 1 (1 cached) / 0 | 346 (346 cached) / 0 | 2 (2 cached) / 0 | 1 (1 cached) / 0 |

Median solve time over all photos: Prior (compass + gravity) 0 ms, App GPU aligner (final) 156 ms, App GPU aligner (raw) 156 ms, CPU classic+cascade (recommended default) 958 ms, CPU classic+skyfirst (high-accuracy mode) 1785 ms, CPU skyline solver (final), out/eval 258 ms, CPU skyline solver (raw), out/eval 258 ms, CPU classic+cascade, HORIZON=fast 594 ms, CPU classic+cascade2 1523 ms, CPU classic+refine 1000 ms, CPU classic+solve, HORIZON=fast 290 ms, CPU ONNX sky+refine 2306 ms, CPU ONNX sky+solve 1828 ms, refine 209 ms, refine+sky 1046 ms, fusion (skyline + render-match) 22294 ms, render-match (ALIKED+LightGlue, sat, rot_fixf) 18223 ms, render-match + 1 refinement render 3191 ms.

### Production bundle (ok, 2.5 s)

Total JS 3171 KiB (944 KiB gzip), CSS 56 KiB.

| chunk | size | gzip |
|---|---|---|
| deck-MJ-hsQqh.js | 724 KiB | 201 KiB |
| sky.worker-Cdf2839A.js | 411 KiB | 111 KiB |
| geodesy-De3XUcTh.js | 371 KiB | 98 KiB |
| terrain-DpwgpDja.js | 363 KiB | 89 KiB |
| index-CrbUL6-h.js | 319 KiB | 101 KiB |
| segment-BWRHWYX1.js | 152 KiB | 45 KiB |
| gpu-data-evaluator-C4c0ona9.js | 94 KiB | 28 KiB |
| full.esm-DQ0x0Eyp.js | 72 KiB | 25 KiB |
| studio._id-pG6-VdOm.js | 70 KiB | 24 KiB |
| pipeline.worker-0m2gkcwZ.js | 68 KiB | 27 KiB |

Build side effects outside out/lead/leaderboard/: node_modules/.nitro/last-build.json: created by nitro, deleted (did not exist before). (Nitro always writes this pointer under the repo root; the step puts back what was there.)

## Health

| step | status | time | result |
|---|---|---|---|
| tsc | fail | 3.4 s | 2 errors: matcher/deck 2 |
| biome | fail | 0.7 s | 94 errors, 2 warnings over 129 files (refine/sky 28, app 17, upload/export 33, matcher/deck 1, unowned 17; lint/style/useImportType 1, lint/suspicious/noApproximativeNumericConstant 1, assist/source/organizeImports 31, format 61, lint/correctness/useExhaustiveDependencies 2) |
| build | ok | 2.5 s | JS 3171 KiB |
| evalcpu | ok | 0.0 s | 9 reports (eval 13, classic-cascade 13, classic-cascade-fasth 13, classic-cascade2 13, classic-refine 13, classic-skyfirst 13, classic-solve-fasth 13, model-refine 13, model-solve 13) (read-only); out/eval = classic-solve-fasth |
| matcher | ok | 0.0 s | tools/matcher/results-fusion.json (matcher:fusion 13), tools/matcher/results.json (matcher:render-match 13), out/refine/results.json (refine 13, refine+sky 13), out/lead/eye/results.json (ignored), tools/matcher/out/results/<id>_initial.json (ignored), tools/matcher/out/results/<id>_refine.json (matcher:render-match-it1 13), tools/matcher/out/results/fusion_default.json (ignored) |
| evalapp | ok (stale 2026-09-25T03:31:38.380Z) | 46.9 s | 13 rows, 11/13 within 1° |
| app | ok | 49.8 s | 13 photos |
| perf | ok (stale 2026-09-25T03:31:38.380Z) | 51.1 s | 3 photos; median cold 11.08 s (n=3), warm 6.21 s (n=3) |

Step notes:

- **biome**: biome.json includes only **/src/** (plus vite.config.ts), so scripts/ is ignored by config
- **evalcpu**: read-only: the app pipeline's out/eval*/report.json as last written (pass --run-evalcpu to regenerate out/eval/)
- **app**: ready times here are under concurrent load; use the perf step for clean timings. app 'accepted' mirrors PhotoWorkspace (confidence > 0.2).
- **perf**: cold = fresh on-disk browser profile (empty HTTP cache/storage; the Vite dev server's own transform cache may be warm); warm = reload in the same profile. Sequential, one page at a time. Bytes = on-the-wire bytes of every response, cross-origin included (Chrome DevTools protocol). A load with >1 document request was reloaded mid-measurement (e.g. dev-server HMR) and is flagged.

## Inputs and their age

Default mode runs no other track's evaluator: it reads their latest outputs (retrying a read while a file looks mid-rewrite).

| file | written | age at run | note |
|---|---|---|---|
| public/photos/photos.json | 2026-09-25T02:37:17.421Z | 2.0 h | snapshot sha1 0810c9fa8f91 → out/lead/leaderboard/gt-snapshot/ |
| data/ground-truth.json | 2026-09-25T04:39:20.416Z | 1 min | snapshot sha1 836c5a146ec6 → out/lead/leaderboard/gt-snapshot/ |
| data/control-points.json | 2026-09-25T03:10:01.349Z | 91 min | snapshot sha1 b7a0d9ef03f2 → out/lead/leaderboard/gt-snapshot/ |
| out/eval/report.json | 2026-09-25T03:53:38.758Z | 46 min | 13 rows |
| out/eval-classic-cascade/report.json | 2026-09-25T03:27:49.828Z | 72 min | 13 rows |
| out/eval-classic-cascade-fasth/report.json | 2026-09-25T03:36:26.827Z | 63 min | 13 rows |
| out/eval-classic-cascade2/report.json | 2026-09-25T03:34:51.569Z | 65 min | 13 rows |
| out/eval-classic-refine/report.json | 2026-09-25T03:26:13.586Z | 74 min | 13 rows |
| out/eval-classic-skyfirst/report.json | 2026-09-25T03:35:20.663Z | 64 min | 13 rows |
| out/eval-classic-solve-fasth/report.json | 2026-09-25T03:36:13.958Z | 64 min | 13 rows |
| out/eval-model-refine/report.json | 2026-09-25T03:26:48.852Z | 73 min | 13 rows |
| out/eval-model-solve/report.json | 2026-09-25T03:25:57.203Z | 74 min | 13 rows |
| tools/matcher/results-fusion.json | 2026-09-25T04:06:33.984Z | 33 min | matcher:fusion 13 |
| tools/matcher/results.json | 2026-09-25T04:06:33.983Z | 33 min | matcher:render-match 13 |
| out/refine/results.json | 2026-09-25T03:32:04.672Z | 68 min | refine 13, refine+sky 13 |
| out/lead/eye/results.json | 2026-09-25T04:31:54.319Z | 8 min | ignored: no rows with id + absolute yaw (not the results contract shape) |
| tools/matcher/out/results/<id>_initial.json | – | – | ignored: superseded by the contract file for matcher:render-match (tools/matcher/results.json) |
| tools/matcher/out/results/<id>_refine.json | 2026-09-25T03:36:26.648Z | 63 min | matcher:render-match-it1 13 |
| tools/matcher/out/results/fusion_default.json | – | – | ignored: superseded by the contract file for matcher:fusion (tools/matcher/results-fusion.json) |
| tools/matcher/out/report_tables.md | 2026-09-25T03:39:37.205Z | 61 min | summary lines, not re-scored (cross-check only) |
| perf step (own Playwright pass) | 2026-09-25T03:31:38.380Z | 69 min | carried over from a previous run |

## Methods

- **Prior (compass + gravity)**: EXIF heading, Apple gravity pitch/roll, f35 focal: the baseline to beat
- **App GPU aligner (final)**: src/lib/align.ts via the app: the pose the UI shows after load (conf > 0.2 → aligned, else near-compass alt or prior)
- **App GPU aligner (raw)**: engine.autoAlign(true) best pose, whatever its confidence
- **CPU classic+cascade (recommended default)**: detectSkyline → solvePose → on reject refinePose; what /baseline Auto-align runs (SOLVER=cascade). the app pipeline's out/eval-classic-cascade/report.json (written 2026-09-25T03:27:49.828Z); final pose = solved if accepted, else prior; re-scored here from prior + delta
- **CPU classic+skyfirst (high-accuracy mode)**: refine with ONNX sky cross-check, else cascade; always loads the 4.5 MB sky model (SOLVER=skyfirst). the app pipeline's out/eval-classic-skyfirst/report.json (written 2026-09-25T03:35:20.663Z); final pose = solved if accepted, else prior; re-scored here from prior + delta
- **CPU skyline solver (final), out/eval**: solved if accepted, else prior (what the baseline pipeline would show). out/eval/report.json = the app pipeline's last default run (written 2026-09-25T03:53:38.758Z); its results match out/eval-classic-solve-fasth
- **CPU skyline solver (raw), out/eval**: scripts/eval.ts: detectSkyline + solvePose, always the solved pose. out/eval/report.json = the app pipeline's last default run (written 2026-09-25T03:53:38.758Z); its results match out/eval-classic-solve-fasth
- **CPU classic+cascade, HORIZON=fast**: the cascade on the app pipeline's horizon-fast horizon (what the browser runs). the app pipeline's out/eval-classic-cascade-fasth/report.json (written 2026-09-25T03:36:26.827Z); final pose = solved if accepted, else prior; re-scored here from prior + delta
- **CPU classic+cascade2**: solve → refine with sky cross-check → refine. the app pipeline's out/eval-classic-cascade2/report.json (written 2026-09-25T03:34:51.569Z); final pose = solved if accepted, else prior; re-scored here from prior + delta
- **CPU classic+refine**: classic skyline, refinePose only. the app pipeline's out/eval-classic-refine/report.json (written 2026-09-25T03:26:13.586Z); final pose = solved if accepted, else prior; re-scored here from prior + delta
- **CPU classic+solve, HORIZON=fast**: simple solvePose core on the horizon-fast horizon. the app pipeline's out/eval-classic-solve-fasth/report.json (written 2026-09-25T03:36:13.958Z); final pose = solved if accepted, else prior; re-scored here from prior + delta
- **CPU ONNX sky+refine**: ONNX sky-model skyline, refinePose. the app pipeline's out/eval-model-refine/report.json (written 2026-09-25T03:26:48.852Z); final pose = solved if accepted, else prior; re-scored here from prior + delta
- **CPU ONNX sky+solve**: ONNX sky-model skyline, solvePose (do not pair these). the app pipeline's out/eval-model-solve/report.json (written 2026-09-25T03:25:57.203Z); final pose = solved if accepted, else prior; re-scored here from prior + delta
- **refine**: src/lib/refine: robust skyline refinement from the prior (out/refine/results.json, method 'refine')
- **refine+sky**: src/lib/refine with the ONNX sky mask (out/refine/results.json, method 'refine+sky')
- **fusion (skyline + render-match)**: tools/matcher/results-fusion.json (contract file): joint skyline + render-match refinement (fusion.py), with the app pipeline's confidence / accepted
- **render-match (ALIKED+LightGlue, sat, rot_fixf)**: tools/matcher: satellite-draped DEM renders at prior yaw ±20°, ALIKED+LightGlue, rotation-only solve at the GPS eye (the app pipeline's headline config). From tools/matcher/results.json (with the app pipeline's confidence / accepted) when present, else re-derived from out/results/<id>_initial.json (then it always 'accepts'); ms = match+solve, rendering excluded
- **render-match + 1 refinement render**: tools/matcher refine stage (it1): one more render at the solved pose, same config. Always 'accepts'

