# VSWEEP: a peak-based vertical pass after the horizontal sweep

2026-10-01. Protocol: [PROTOCOL.txt](PROTOCOL.txt) (written before any number). Code: `scripts/vsweep/` (`lib.ts`, `eval.ts`, `summarize.ts`, `synthetic.ts`). Raw output: `out/vsweep/` (gitignored).

## Verdict

**The registered peak arm (VP) is KILLED.** It fails rule 1 (a median gain of at least 0.05°) on both horizontal stages and both DEMs, and rule 3 (it must beat the dense vertical sweep) on 3 of 4. This holds both in the frozen run and after the post-hoc fixes. The dense vertical sweep (VD) does not pass cleanly either: on Terrarium it makes one or two photos worse by more than 0.15°. So the result is negative and nothing is wired into the app.

Why it fails:

1. **Too few peaks.** A typical frame (about 60° wide) holds 1 to 8 prominent skyline peaks. At the registered 6 px prominence, only 2 to 5 of the 14 photos reach the 3 matched peaks the arm needs, so it falls back to the horizontal result on the rest.
2. **Pitch is already at the floor.** Both horizontal stages already fit pitch jointly with yaw. When yaw is right (|yaw err| ≤ 1°), the median pitch error is 0.13 to 0.21°, which is 3 to 4 px at 1600 px. That matches the ground-truth noise (0.2 to 0.4° on "approx" entries) and the DEM-vs-GT disagreement. When the vertical arms do fire on those photos, they mostly move pitch by 0.08° or less. The one large move is IMG_7068 (`H_app`, Terrarium), and it went the wrong way. Neither arm can show a gain at that level on this GT.

## Setup

- 14 GT photos (good or approx), with the eye from `scripts/lib/pipeline-node.ts` (EYE=max). DEMs: Terrarium (registered) and Mapterhorn (the app's DEM, descriptive).
- Horizontal stages, code unchanged:
  - `H_geo`: `solvePose`.
  - `H_app`: `autoAlign` on the 512 px edge map, the CPU reference of the live path.
- Vertical arms hold yaw, roll and focal fixed and sweep pitch ±1.5° in 0.01° steps. The cost is truncated L1 at 6 px on a 1600 px basis.
  - `VD`: dense, every confident skyline column.
  - `VP`: peaks, apex to apex, matched by mutual nearest neighbour within 25 px.
  - `VS`: saddles.
  - `VPS`: peaks and saddles pooled.

## Results (median |pitch error|, degrees; "calls" = photos where the arm had at least 3 matches)

Frozen run, Terrarium, all 14 photos:

| stage | V0 (none) | VD dense | VP peaks (calls) | VPS (calls) |
|---|---|---|---|---|
| H_geo | 0.26 | 0.22 (1 photo worse >0.15) | 0.26 (2/14) | 0.26 (5/14) |
| H_app | 0.31 | 0.23 (2 photos worse >0.15) | 0.29 (4/14) | 0.32 (6/14) |

Mapterhorn, all 14 photos (descriptive, A2 apex):

| stage | V0 | VD | VP (calls) | VPS (calls) |
|---|---|---|---|---|
| H_geo | 0.21 | 0.25 | 0.20 (5/14) | 0.22 (9/14) |
| H_app | 0.27 | 0.21 | 0.23 (5/14) | 0.24 (7/14) |

Photos where yaw is right (|yaw err| ≤ 1°), Mapterhorn, A2:

| stage | n | V0 | VD | VP | VPS |
|---|---|---|---|---|---|
| H_geo | 10 | 0.13 | 0.15 | 0.13 | 0.14 |
| H_app | 9 | 0.21 | 0.14 | 0.16 | 0.14 |

**Capture range (where a vertical pass does help).** When the starting pitch is pushed ±0.5° or ±1° off, V0 obviously stays off (0.45 to 1.06°). VD comes back to the unperturbed level from every start (0.14 to 0.30°). VPS mostly does (0.20 to 0.73°). VP alone comes back only part way (0.23 to 0.94°) because it has no matches on most photos. In the real runs this mattered once: `H_app` on IMG_7086 left pitch 1.58° off, and both VD and VP pulled it to 0.08°. The opposite also happened once: on IMG_7068 (`H_app`, pitch error only −0.12°), VD and frozen VP dragged pitch to −0.84° and −1.04°. Without a gate, the vertical pass is a coin flip on exactly the cases it would exist for.

## Synthetic check (tests the solver, not the world)

The "photo" is the DEM horizon at the GT pose plus σ = 1 px noise, and each arm starts at a pitch error of ±0.25, ±0.5 or ±1°.

- VD recovers within 0.00° every time.
- Frozen VP was biased by −0.06° (about −1.3 px) on most photos: 82 of 210 calls were more than 0.03° off. The extreme of a noisy profile is biased by the noise itself. Peaks pick up the most negative noise sample, and saddles get the mirror bias.
- Amendment A2 (post hoc) takes the apex from a least-squares quadratic over ±6 px on both sides, which brings it to 15 of 210. The ultra-wide IMG_7059 is still −0.06°.
- A2 changed the real-photo medians by at most 0.01 to 0.04°. The bias was real but not what limits the arm.

## Diagnostics

- **DEM tip blunting is not a clear signal here.** At the GT pose, peak and saddle residuals on the same photo mostly share their sign and size: Terrarium IMG_7068 is −15 vs −22 px, and IMG_7131 −9 vs −11 px. On Mapterhorn, IMG_7155 peaks and saddles are both +1 to +5 px. The per-photo offset is a pitch or eye disagreement between GT and DEM, not something tip-specific.
- Mapterhorn shrinks the peak residuals at GT on IMG_7131, for example from −2.7, −5.0, −19.5, −9.6 to −2.5, −3.5, −4.6, −7.4 px, and raises matched peaks (VPS calls 5 → 9).
- Peak prominence 3 px (amendment A1, post hoc, Terrarium) gives more calls (VP 8/14) but no better medians: `H_geo` VP 0.33 vs V0 0.26. On IMG_7155, where yaw is 5.7° off, VPS matched the wrong peaks and moved pitch by +0.70°.

## What would be worth doing instead (not done)

- **A pitch-consistency flag rather than a pass.** If a dense vertical sweep wants to move the horizontal stage's pitch a lot, the solve may be suspect. On Terrarium, the VD shifts of 0.45° or more were IMG_7086 `H_app` (−1.50°, a real pitch failure), IMG_7068 `H_app` (−0.72°, a false flag) and IMG_6019 `H_geo` (−0.49°, yaw 20° off). That is 2 of 3 right with n = 3, so it would need the wild dev set and its own protocol.
- **A better GT for pitch.** Telling apart improvements below 0.1° needs pins with independent elevations (OSM `ele`) at sub-pixel accuracy, not the current 0.2 to 0.4° entries.

## Amendments (post hoc, labelled)

- **A1:** prominence 3 px (`VS_PROM=3 VS_TAG=a1-prom3`).
- **A2:** least-squares apex ±6 px (`VS_APEX_R=6 VS_TAG=a2`), added after the synthetic check found the bias.
- Mapterhorn runs are descriptive; the protocol registered Terrarium. None of these rescues the registered verdict.

## Reproduce

```bash
npx tsx scripts/vsweep/eval.ts                                  # frozen (Terrarium)
DEM=mapterhorn VS_APEX_R=6 VS_TAG=a2 npx tsx scripts/vsweep/eval.ts
npx tsx scripts/vsweep/summarize.ts out/vsweep/results-terrarium.json [--yaw-ok 1]
VS_APEX_R=6 npx tsx scripts/vsweep/synthetic.ts
```

Needs `img/*.HEIC`, `data/ground-truth.json` and macOS `sips`. The first Mapterhorn run fetches tiles and traces horizons (about 2 min per photo), and later runs are cached (about 5 s per photo).
