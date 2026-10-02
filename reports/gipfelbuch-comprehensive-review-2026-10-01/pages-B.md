# Gipfelbuch page review B: skyline, dem-horizon, dem-source, dem-anchoring, terrain-sampler, terrain-snapping

Read-only review, 2026-10-01. No browser was used; every finding below comes from reading the source and the baked JSON (`public/demo/gipfelbuch/*.json`, `terrain/terrain.json`), which I recomputed in Python where noted. Rendered pixel sizes are estimates from viewBox width ÷ figure width, assuming the R1 wide track is about 860 px.

Severity: **bug** (wrong output or broken behaviour), **accuracy** (a claim that does not match the code or data), **design** (legibility or encoding), **cleanup** (code health or duplication).

## Shell and kit status (regression R1–R9 and the outright bugs)

| Item | Status | Evidence |
|---|---|---|
| R1 wide figure track | FIXED | `viz/Figure.tsx:83-87` (`lg:mr-[calc(-66.667%-16px)]`, bleed adds the left 2 columns) |
| R3 `Stat`/`Numbers` overflow | FIXED | `viz/explain.tsx:527-528`, `viz/Section.tsx:105-112` (clamp + nowrap + container query) |
| R4 red-on-red chips | FIXED | `swiss/theme.css:109-117` (`.gb-coord` moved into `@layer components`); skyline also carries `!text-…` at `skyline.tsx:646,843` (now redundant) |
| R6 imprint on thumbs | FIXED | `viz/real.tsx:426` (off by default) |
| R8 `Flow` | FIXED | `viz/Steps.tsx:31-40` (vertical below 560 px container) |
| `halfKm` "0 km" ledger | FIXED | `tafel/sheets.tsx:1708-1711` and `:1770` now pass `scale: 1` |
| R9 picker vs fixed figures | PARTLY OPEN | The shell still promises "every number on this sheet is re-read from its measured run" (`ConceptPage.tsx:~290`), but dem-source, dem-anchoring Fig 1, terrain-sampler Figs 2–4 and terrain-snapping are all fixed to demo-01, demo-03 or Niederhorn. Some captions say so (dem-anchoring:1433, terrain-snapping:740, terrain-sampler:1041-1044, skyline:1224, dem-horizon:1731); dem-source has no such caption at all. |

New shell bugs that affect my pages:
- **bug** `tafel/sheets.tsx:1727`: the terrain-sampler ledger "to sample the tile" reads `ms.terrain`, which is 120 ms for demo-01 and **0 ms for the other 11 photos** (a tile-cache artefact in build-data). Drop the stat or bake a real per-photo timing.
- **accuracy** `tafel/sheets.tsx:1722` (and `:1161` in the band): the label is "heightAt() under the camera", but `gps.ground` is the **Terrarium** ground (every demo JSON has `dem: "terrarium"`), and `heightAt` is a method of the 3D mesh `Terrain` (`src/lib/terrain.ts:258`), not of `TerrainSampler` (which has `sample`/`sampleAt(lon, lat, d)`/`ground(lon, lat)`). The page itself says the sampler reads Mapterhorn. Fix: show `terrain.json eyes[].groundMapterhorn` for the picked photo, or label the stat "Terrarium ground (build-data run)".
- **design** `tafel/sheets.tsx:1762-1770`: the terrain-snapping ledger shows view cone, pointing and DEM-patch half-width, none of which the page discusses. Better: the eye lift on Mapterhorn and on Terrarium for the picked photo (from `terrain.json eyes`), and the median peak move.

---

## skyline.tsx (1,507 lines)

Verified correct: the 8-term sky basis, the 4 IRLS Cauchy passes, the seed weight `(1 − y/h)⁶` (`geo/skyline.ts:498`), FAR_ABOVE 0.2, edge cap 0.35, edgeWeight 60, jumpCost 2, jumpCap 80, refinePasses 1, minWeight 0.1 → NaN (`:483-490, :672`), and `skylineFromSky`'s 1.5 % occluder and ×0.7 (`sky/skyline.ts:39,108`). The ports of `rejectSpikes`/`fuseSkylines` match `refine/skyline-clean.ts:55-130` at their defaults. Numbers check out: 0.30° vs 2.97° (leaderboard.md:206-207), 39/60 and precision 0.64 with 19 gross errors (bench-wild.md:11,16), dusk 2/10 and haze 15/36 (bench-wild.md:81-84), and a median time of 161 ms over the 12 photos.

Regression items: the X1 chips are fixed (kit plus `!text`); the WeightStrip fill is back as a solid water bar (`:1036-1057`); HardCases no longer shows the imprint (kit). Still open: Fig 3 is `bleed` (`:487`), but with R1 that is now fine. The picker inside Fig 2 duplicates the shell picker (see below).

- **accuracy** `:1341`: the Eq legend says *y* is "the yellow line", but Fig 3 draws the Viterbi path in `SWISS.forest` (`:559`), and `Sym c="skyline"` renders in contour brown on paper (`viz/math.tsx:19`). The earlier review fixed this by drawing the path yellow; that fix has regressed. Fix: say "the green line" and give `Sym` `c={SWISS.forest}`, or draw the path in the skyline ink.
- **accuracy** `:658-660`: the slider label "(the path barely moves: sky evidence dominates)" is back. The 2026-10-01 review removed it as never measured (`reports/gipfelbuch-review-2026-10-01/skyline-horizon.md`). Remove it again.
- **accuracy** `:994-995, :1211`: demo-02 "glare at **both** ends". Measured: 80 of the left 80 columns are silent but only 8 of the right 80; the larger gap is 171 silent columns mid-frame. Say "the left end and a mid stretch".
- **accuracy** `:1327, :1353`: "2 px a row … 80 px" gives the jump cost a pixel unit. It is a cost per row of jump (unary units), capped at 80. Say "2 per row, capped at 80".
- **cleanup** `:54-66, :365, :698, :977`: the header and section comments are stale. They describe Fig. 1 as the Viterbi scan, Fig. 2 as clean-up and Fig. 5 as the ports; the code labels are Fig 3, D1 and Fig 2. Rewrite them.
- **cleanup** `:980-991` `bandCrop` is byte-identical to the kit's `skylineBand(d)` (`viz/explain.tsx:771`). Delete it and use the kit.
- **cleanup** `:700-754`: import `rejectSpikes`/`fuseSkylines` from `src/lib/refine/skyline-clean.ts`. They are pure and import-safe, and a copy can drift.
- **design** `:1099-1112`: Fig 2 has its own `PhotoPicker` bound to the same `useNotebookPhoto` state as the shell picker 1 screen above, so the page shows two pickers for one state. Keep one (the shell's), or make the in-figure strip a compact "now showing demo-NN" line.
- **design** `:1132`: the code identifier "detectSkyline" appears in the body figure readout. The copy rule allows identifiers only in Details; say "detector".
- **cleanup** `:644-648, :841-845`: the duplicated chip classes still carry `!text-[var(--gb-paper)]`, which is no longer needed after the R4 kit fix. Factor out a `ChipTabs` kit component (the same pattern appears in dem-horizon:537 and dem-anchoring:441).

## dem-horizon.tsx (2,036 lines)

Verified against `geo/horizon.ts:47-95`: step 0.05, 150 km, minDistance 20, step factor 0.004, minOcclusion 0.08, `R' = R/(1−k)` with k = 0.13 (`geodesy.ts:20`), "ties keep the nearer point" (strict `>`), and NaN samples skipped. The fast marcher's 0.3 s figure is from `geo/README.md:70`. Recomputed per photo (`terrainProfile`, `solved.f`): the curvature shift is 1.2 px on demo-01, 1.5 px on demo-03 and 0.1–2.6 px across the 12 photos.

Regression items fixed: the toggle pill (kit R4), the dark under-stroke on photo lines (`PHOTO_DARK`, `:71, :1124`), the straight gradient legend (`:987-1015`), the "in the photo" band as a blue wash (`:1177`), and the worst-tenth stems in Fig 4 (`:1699-1725`). Still open: Synthetic 2 sits side by side (`:841`), which is acceptable on the wide track.

- **accuracy (picker-dependent)** `:1843-1845`: "A 25 m GPS error shifts a ridge 2 km away by up to 0.7°, about 10 px **at this photo's focal length**." 10 px is f = 830 (demo-03). On the default demo-01 (f = 612) it is 7.7 px; on the wide photos (02, 07, 08, 10; f ≈ 311) it is 3.9 px. Compute it from `d.solved.f`, or drop "this photo's".
- **accuracy (picker-dependent)** `:1997-1998`: "On the real photo in Fig. 2 the curve moves the skyline by about 1.5 px." Fig 2 follows the picker, and 1.5 px is demo-03 only (demo-01 is 1.2 px). Use `shiftPx` from `Ladder`, or say "1 to 3 px across the 12 photos". The same problem affects `:2004-2005` ("0.1 px at this photo's focal length").
- **accuracy** `:1731`: the caption "a head on the ridge puts the worst tenth of columns 100 px or more off" is true for demo-08 (p90 145) and demo-07 (103) but **false for demo-12 (p90 18 px)**. Say "up to 145 px".
- **accuracy** `:1568-1621`: the Eq colour keys do not match the figure. *a* is keyed `solved` (water), but the live sight line is `SWISS.ink` (`:1497`). *h* is keyed `var(--accent)`, but the ground is drawn in contour brown (`:1488`). *d²/2R′* is keyed `--rigi-lesson` (contour brown on paper, `swiss/theme.css:49`), the same colour as the ground line, while the drop bar is **red** (`:1509`). Fix: key *a* to ink, *h* to `SWISS.contour` and the drop term to `SWISS.red`.
- **accuracy** `:838`: the Sweep caption says "brighter means nearer". On paper the segments are red with higher opacity when nearer (`:920`), so nearer is darker and stronger. This is a stale dark-ground colour word.
- **bug** `:480-488`: the "best so far: X° at Y km" note is anchored at `xD(S.bestD)+50`. With curvature off, the skyline is the 50 km summit (x ≈ 531), and the roughly 220-unit string runs past the 640 viewBox and is clipped. Flip the anchor to `end` when `xD(S.bestD) > PX1 - 240`.
- **prose** `:1830-1833`: the Trio step "Keep the steepest" has the body "Past 50 km the ground sags 171 m, so we lower it", which is about curvature, not the running maximum. Fix: "Each sample that beats the steepest angle so far becomes the skyline."
- **prose** `:1851-1853`: "In Fig. 3 the cool, far parts of the line stay put when the position is off." Fig 3 never varies the position, so the claim is not shown. Reword it as an inference, or add a ±25 m toggle.
- **cleanup** `:1240, :1251`: `dists` is computed and then `void`ed (dead code).
- **cleanup** `:1017-1028` `viewBand` duplicates `skylineBand` with different margins. Add `skylineBand(d, minH, {above, extra})` options to the kit.
- **react/perf** `:914-922`: Sweep re-renders up to 359 `DataLine` (SketchPath) segments on every animation frame, each with a per-frame opacity. Memoise the segment list by `k` buckets, or draw one path per distance bucket.
- **design** `:980-983`: `distColor` uses lightness 64–68 %, so yellow and near-yellow dots and lines on the paper ProfilePlot (`:1197-1219`) have low contrast because they have no under-stroke there. Add the `PHOTO_DARK`/ink casing, or darken the ramp for paper.

## dem-source.tsx (1,242 lines)

Verified against `terrain.json`: summit 1963.8 vs 1929.8 (34 m), OSM tag 1963, a 1.2 km box (halfM 600), transect worst 69 m, a camera ground gap of 20.7–86.6 m with all 12 positive, and Mapterhorn 0.41 m / Terrarium 3.28 m native pixels. The decode values are 1934.13 and 1882.51. `MAPTERHORN.levels`/`TERRAIN_LEVELS` are from `dem/sources.ts:16-18, 81-87`. Benchmark: 14 → 25 (bench-wild.md:161), 1–27 %, 114 m and 0.72 (bench-wild.md:22).

Regression items fixed: the halfKm ledger; numbers back in the Fig 1 hand labels (`:283-300`); the lit ladder band is now denser hatch plus an edge (only partly "solid"); the C1 labels are back to about 11 px on the wide track (`HERO_LABEL` 6.5 at 640 px max-width gives 11.6 px). Still open: the Fig 4 bars are hatch plus outline (`:514-528`), against the R2 rule that fill encodes.

- **bug** `:866-871`: the ladder slider has `min={2}`, but the value is `log10(d)*100`, so the minimum should be **200** (100 m). As written, the left 38 % of the track (1–100 m) is dead: `lx` clamps at 100 m and the band never changes.
- **accuracy** `:1127-1129` (and terrain-sampler `:1484-1489`): "Mapterhorn's ladder is one zoom coarser per band than Terrarium's … plus two finer near-field levels." The code has different breakpoints: Terrarium z13 ≤ 4 km, z11 ≤ 40, z10 ≤ 150; Mapterhorn z15 ≤ 1, z14 ≤ 2.5, z12 ≤ 6, **z11 ≤ 15 (26 m/px, no Terrarium equivalent)**, z10 ≤ 40, z9 ≤ 150. Mapterhorn is therefore finer than Terrarium from 4 to 15 km, not just one zoom offset. Say so.
- **accuracy** `:1114-1116`: "the user-approved default that **every** DEM consumer uses". The gipfelbuch's own measured data (all 12 demo JSONs: `dem: "terrarium"`) and `/baseline` use Terrarium, as the page admits at `:1219-1220`. Say "every product path".
- **accuracy** `:1055-1057, :1196-1198`: "drawing on the wrong map moved the skyline by **1 to 27 %**" is emphasised with a double underline, but the report gives a median of about 1.3 % on near-field skylines (bench-wild.md:22). And "Swapping Terrarium for Mapterhorn took the cascade from 14 to 25 … with no algorithm change" leaves out that the 14 was solved on Terrarium but verified on Mapterhorn overlays at a re-applied eye (bench-wild.md:32,117). Add "median about 1.3 %" and "part of the 14 → 25 is the verification mismatch".
- **prose** `:277`: "a 34 m **pit** where the summit should be" describes a rounded-off, lower summit, not a pit. And `:280` "same box, same pixel" is wrong: the two summits are about 220 m apart (Mapterhorn index 215 vs Terrarium 261 at 4 m cells). Say "a summit 34 m too low".
- **design** `:257-275`: the PenDimension for the 34 m gap is only 3 viewBox units tall (about 5 px), so the key fact is invisible. Enlarge the profile's y scale near the top, or add an inset.
- **bug (minor)** `:245, :253`: `var(--gb-faint)` is not defined anywhere (only `--nb-faint` exists), so "west"/"east" fall back to inherited ink. Use `var(--nb-faint)`.
- **design** `:1164-1173`: the coverage chips use `border-b border-dotted`. The README rule is "no border on HTML containers; strokes only for state". Acceptable as a leader, but note it.
- **cleanup** `:302, :457, :572, :863, :882, :949, :954, :1164` use raw `text-[11px]`/`text-[13px]` instead of `TYPE.*` (lint rule T1).
- **cleanup** `:131-138`: `A` uses a plain `<a href>` (a full page load). The other pages use the router `Link`.
- **cleanup** `:723, :895`: stale comments ("Fig 2: the distance ladder" is Fig 3; "Fig 4: the encoding" is D1).
- **duplication** `PixelCard` (Trio), `DecodeEquation` and `Encoding` (D1) show the same Mapterhorn pixel three times; D1 could keep only the Terrarium card. `BandsMini` and `FallbackMini` are near-copies of terrain-sampler's `LevelsMini` and `HoleMini`.
- **R9** No figure follows the picker, and nothing says so. The hero ledger changes per photo (patch min/max), but the page body is all Niederhorn/demo-01. Add "Fixed: the Niederhorn (demo-01) camera" to the Fig 1 caption.

## dem-anchoring.tsx (2,176 lines)

Verified against `nearfield/anchor.ts`: range 15–3000 m (`:176-177`), band ln 1.25, knots at 2–98 % with min spacing 0.2 and slopes 0.75–6, step 0.02 (`:81-90, :346`), nMin 200 (`:106`), stride `sqrt(W·H/40 000)` (`:183`), the quality formula (`:111-119`), `ANCHOR_LOW_TRUST` 0.35 (`:109`), `ANCHOR_MIN_QUALITY` 0.15 (`types.ts:94`), `CURVE_METRIC_NEAR` 15 (`:134`), and `rayFactor`/`modelDepth`/`sampleDemGrid` (`geom.ts:27,64,73`). AUC 0.73 and the ratios 1/2.9/6.6 are from step-inside-results.md:34-36.

Regression items fixed: RangeCells now uses a solid 28 % class tint (`:1400-1407`) with filled legend swatches (`:1474-1485`); the Fig 2 fan is forest with a red median and 24 px stat numerals (`:1714-1769`); "shown" dots are forest in Fig 4 and the minis. Still open: D1 pixel classes are still hatch at a single −45° angle, separated only by gap, over a 0.08 wash (`:754-761, :867-889`), so sky, far and near remain hard to tell apart (R2).

- **accuracy** `:1446`: the hero stage 1 caption says "A depth model can guess its shape, **but not its metres**." The earlier review corrected this (MoGe-2 is metric; the measured problem is range compression), and the fix has regressed. `:1945-1946` says "gets shape right and metres wrong. Near the camera it is roughly right", which also contradicts itself. Say "metric, but it squeezes far distances".
- **accuracy** `:1956-1957` (MarginNote next to Fig 2): "the DEM/model ratio is about 1 at 15 to 30 m and about 2.9 at 100 to 300 m". Fig 2, directly above, prints the median of the 27 curves (about 1.5 / 5.8 / 6.1 at 20/100/300 m, `:1671`). Two different aggregations sit side by side without reconciliation. State "report: per-pixel ratio; figure: median of per-photo curves".
- **react bug** `:441-454`: `Chip` is a component **defined inside** `CurveFigure`'s render, and `useTime` re-renders that render on every animation frame. React therefore sees a new component type each frame and remounts the three buttons, which drops keyboard focus and hover while the figure plays. Hoist `Chip` to module scope and pass `mode`/`setMode` as props.
- **react/perf** `:601-617, :568-600`: every frame re-renders 300 `HandDot`s and re-sketches the band `Wash` (5 layers) from new path strings. Precompute the curve-lerp endpoints and draw the dots in two static groups (inlier and outlier per `p` bucket).
- **design** `:1266-1292`: the raw `<input type="range">` (×2) breaks the kit's `HandRange` pattern used on the other pages.
- **accuracy (minor)** `:1644` and `:1652`: *f* is keyed `var(--accent)`, but Fig 2's curves are forest and the median is red. Key it to `SWISS.red` ("the red line").
- **cleanup** `:380, :732, :1069`: stale comments ("Fig. 1: scatter" is Fig 3; "Fig. 2: candidate" is D1; "Fig. 3: trust gauge" is D2).
- **R9** Fig 1 (`:1424`) and MiniWindow (`:1622`) are hard-wired to demo-01, which the caption says ("On demo-01"); acceptable. The ledger above, however, follows the picked photo (depth along the view, ground samples), so the hero numbers and Fig 1 disagree whenever another photo is picked.

## terrain-sampler.tsx (1,598 lines)

Verified against `geo/terrain.ts`: the `-0.5` pixel-centre offset (`:35-36`), concurrency 16 (`:94`), the size check throws (`:106-107`), and sea clamped to 0 in `dem/decode.ts:22`. 404/204 is remembered and `ancestorCrop` is used (`dem/load.ts:71-83,154`). The 3D mesh uses `fetchDemBytes` (`src/lib/terrain.ts:357`). The default probe is now about 13.9 km (the z11 case) for the still frame, as fixed. Transect within 12 km: z9 is worst at 43.8 m, the band rule at 15.5 m.

Regression items fixed:
- "White/Violet" is gone. The caption now reads "Black line … Orange line" (`:880-881`), with Keys at `:973-974`.
- The weight bars are solid forest with numbers (`:792-813`), and the grid labels use one decimal (`:590-592`).
- The stipple blob is replaced by a dashed rect.
- The rings are graded and the answering ring is outlined (`:262-276`).
- The 2-column layout is back (`:240`), and the row selected state has a red tick (`:426-427`).

**1886.1 m vs 1,934 m: explained, not fixed.** The mismatch is not a photo-picker problem: even on demo-01 the ledger (`gps.ground`) is the **Terrarium** ground (1886.1) and Fig 1's point 1 is the **Mapterhorn** ground (1934.3). The Fig 1 caption now says so (`:1041-1043`), but the ledger label still claims to be `heightAt()` (see the shell section).

- **bug** `:1016-1029, :1040`: point 1 now follows the picked photo, but it is still drawn at demo-01's camera pixel (150,150), and the caption's "The ground falls X m within Y m north of the camera" subtracts **demo-01's** patch height (`row[midX]`) from the **picked photo's** Mapterhorn ground. For any photo other than demo-01 this is a mixed-site number (for example demo-07: 1932.7 + 81 − …). Either keep point 1 and the "falls" text on demo-01 (and say "fixed: demo-01"), or compute the drop only when `photoId === "demo-01"`.
- **accuracy** `:1106`: "170 m north of the camera" is hard-coded; use `box.profile.northM`.
- **accuracy** `:57` (header) and `graph.ts:339` tagline "One function, heightAt(lat, lon)": the sampler's API is `sampleAt(lon, lat, distance)` and `ground(lon, lat)` (note the lon, lat order). `heightAt` belongs to the mesh `Terrain`.
- **accuracy** `:1484-1489`: the same "one zoom below the Terrarium default … with two finer near-field levels on top" oversimplification as dem-source (the extra z11 band runs 6–15 km).
- **design** `:862-869, :957-970`: the legend lists "worst" for z14, z12, z11, z10 and z9 with graded contour swatches, but only z9 and the answer are plotted, so the swatch colours key nothing. The `colors` map is mostly dead (only `colors[9]` is used). Either plot all levels in those graded inks, or show the worst values as a plain list without swatches.
- **design** `:880, :974`: "Orange" for `--gb-contour` (#95500c, NB brown) is a stretch on paper. Use "brown", or let `Key` speak and drop the colour word.
- **prose** `:826-831`: the Eq legend says *h* is "the four pixel heights are the numbered dots", but *h* is the blended answer (water ink). Split it: "h: the answer; the four pixel heights are the numbered dots …".
- **prose** `:1401-1432`: the same two numbers (44 m and 16 m) appear three times in a row: the Beat title (a two-sentence title), the margin note and the strike line. Keep the title as a claim ("A band rule keeps far ground within 16 m") and one struck guess.
- **cleanup** `:130-137`: `LEVELS` is a hand copy of `MAPTERHORN.levels`. Import it, as dem-source does, so they cannot drift. `mpp` uses lat 46.71 here and dem-source's `mPerPx` uses 46.8; share one helper.
- **cleanup** `:182, :453, :847`: stale comments ("Fig. 1 — which tile level" is Fig 2, and so on).
- **design** `:218-224, :522-530`: the ring and grid probes are pointer-only. There is no keyboard path to move the probe (the Fig 3 "measured point" button helps). Add arrow-key handling, or a range input mirroring the distance.

## terrain-snapping.tsx (1,171 lines)

Verified: the snap radius `min(250, 60 + 0.004 d)` is in `deck/engine.ts:2530`, the 150 m–110 km gate at `:2529`, and the 9 × 9 grid with strict-greater at `src/lib/terrain.ts:273-285`. The eye rule is the one in deck/scene.ts. Ramsgrind is 7927 m → 92 m. Mapterhorn lifts 11 of 12 photos, Terrarium 1 of 12; the lift is 6–21 m excluding demo-09, the median 13.5 m. Curvature is 0.61 m at 3 km and 683 m at 100 km.

Regression items fixed: the hero now says "Fixed: demo-03, with hand-placed marks" (`:740`); the Ledger is a responsive `@container` list (`:691-723`); the PeakReal grid is ink dots graded by height with the highest in red (`:465-476`); the readout paragraph is set in the body font (`:616`); the "0 km" ledger is fixed (kit). Still open: the RealEye bars are hatch-only (R2), see below.

- **accuracy/design** `:113` vs `:243-279`: the comment says "solid fills encode the two ground models (Mapterhorn brown, Terrarium pencil grey)", but the code draws **hatch only**, brown versus **forest**. R2 is still open, and the comment is stale. Also, **the colour meaning is inverted across sibling pages**: dem-source uses forest = Mapterhorn and red = Terrarium (`dem-source.tsx:50-51`), while this page uses brown = Mapterhorn and forest = Terrarium. Pick one map-ink pair for the whole DEM cluster (put it in the kit, for example `DEM_INK.mapterhorn`).
- **bug (likely clip)** `:350-352`: the HandText "finer map, higher crest: Mapterhorn lifts 11 of 12" starts at x = 344 in a 560-wide viewBox at size 14. About 50 characters is roughly 280 units, so it ends near x ≈ 620 and is cut at the right edge (estimate; not rendered). Wrap it onto two lines, or anchor it at `end` at x = 556.
- **accuracy** `:1127`: `buildPeaks` no longer exists in `deck/engine.ts`; the snap is `snapOne`/`snapPeaksNear` (`:2523-2530`). The comment at `:54` and `deck/scene.ts:107` are also stale.
- **accuracy (minor)** `:525, :586` vs data: the red "highest grid sample" is labelled 1661.8 m (`snapH`), but the highest of the 81 baked grid samples is 1664.3 m (at (64,156)). The grid and the snap were sampled differently (by about 2.5 m), so the figure contradicts its own "highest of the 9 by 9" claim. Re-bake from one sampler, or label the dot with the grid value.
- **prose** `:549`: "OSM node here, summit 9 by 9 samples away" is garbled. Say "the summit: highest of 9 × 9 samples".
- **bug (minor)** `:591`: `{ex.ele ?? "none"} m` renders "none m" when the tag is missing.
- **bug (minor)** `:920`: `var(--gb-blue)` is undefined, so the "lake" label is not blue. Use `var(--gb-water)`.
- **design** `:750-777`: the "typical peak climbs 46 m" note sits at (300, 760) with `anchor="end"`, right above mark 3 (the *depth*, at 300, 790), not next to mark 2 (the peak). The note reads as belonging to the wrong mark. Put it beside mark 2 with a leader.
- **design** `:112`: `EYE_LABEL = 11·560/800` assumes an 800 px render. On the wide track it is about 12 px, but at 390 px it is about 5 px, which fails the README's 390 px rule. This is the same for every viewBox-scaled label in all six pages. A kit helper that floors SVG text at about 10 px rendered (via a `ResizeObserver` scale, or `vector-effect`-like text scaling) would fix them all.
- **cleanup** `:138-146`: a local `Measured` shadows the kit's (imported as `PhotoMeasured`); rename it to `TerrainMeasured`, or extend the kit's `Measured` to take a `what` line.

---

## Cross-page size and duplication (what to move into the kit)

The six pages total 9,730 lines. Candidates to share:
1. **`useTerrainData` + `TerrainData` types + module cache**, copied 4× (dem-source:107, dem-anchoring:96, terrain-sampler:105, terrain-snapping:109), each page with its own type subset and its own fetch cache. Move them into `viz/real.tsx` beside `useGipfelbuchPhoto` as `useTerrainJson()` with the full type. That saves about 120 lines and gives one cache.
2. **`rectPath`/`rectD`, `median`, `clamp`, `lerp`, `fmt`/`fmtN`**: repeated in 4–6 pages. Move them to a `viz/math-utils.ts`.
3. **Concept links**: 5 variants (`A` with `<a href>` in dem-source; `A` with `Link` in dem-horizon and terrain-sampler; `link()` with a `byId` guard in dem-anchoring and terrain-snapping). Use one kit `ConceptLink`.
4. **Skyline crops**: skyline `bandCrop` is identical to the kit `skylineBand`; dem-horizon `viewBand` is a variant.
5. **DEM ladder minis**: dem-source `BandsMini`/`FallbackMini` vs terrain-sampler `LevelsMini`/`HoleMini` are near-identical. Move them to a shared `DemLadderMini`/`FallbackMini`.
6. **Level tables and m/px**: terrain-sampler `LEVELS` copy, two `mPerPx` formulas with different latitudes. Import `MAPTERHORN.levels` and add a `metresPerPixel(z, tileSize, lat)` in `dem/tiles.ts`.
7. **Chip tab groups** (skyline ×2, dem-horizon, dem-anchoring) and raw range inputs (dem-source, dem-anchoring ×2): use a kit `ChipTabs` and `HandRange` everywhere.
8. **Algorithm ports**: skyline re-implements `rejectSpikes`/`fuseSkylines` (import them); dem-anchoring ports `fitCurve` (it could call the real `fitCurve(mr, dr)` on the synthetic points, removing about 100 lines and drift risk).
9. **Picker duplication**: skyline Fig 2 and dem-horizon Fig 3 each embed a second `PhotoPicker` for the same shared state.
10. **Stale "Fig. N" section comments** in five of the six files. Drop the numbers from comments altogether; the labels live in JSX.
