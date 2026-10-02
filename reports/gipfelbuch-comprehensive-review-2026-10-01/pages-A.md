# Gipfelbuch concept-page review A (2026-10-01)

Pages: rigi, photo, photo-workspace, tap-a-peak, peak, camera-prior, camera-roll (`src/lib/gipfelbuch/pages/`).
Read-only review, without rendering. Claims were checked against `src/`, `public/demo/gipfelbuch/*.json` and `reports/`. Label-size and clipping items are geometry estimates.

Severity tags: **bug** / **accuracy** / **design** / **cleanup**.

## Kit-level status of the regression root causes (R1–R9)
- **R3 (Stat / Numbers wrap): fixed.** `viz/Section.tsx:105-112` (nowrap, `clamp(26px,14cqi,40px)`) and `viz/explain.tsx:528`.
- **R6 (imprint on thumbnails): fixed.** It is off by default (`viz/real.tsx:426`).
- **R1 (figure width): mitigated.** `Figure bleed` now spans `lg:ml-[calc(-33.333%-8px)]` (`viz/Figure.tsx:87`). The body column is still `content-start/margin-start` (`ConceptPage.tsx:297`).
- **R8 (shared layouts): partly fixed.** `Flow` now stacks in narrow containers. `HowItWorksScene` still uses viewport breakpoints (`HowItWorksScene.tsx:747`), and `RollCompasses` still clips.
- **R9 (page picker vs fixed figures): open on every page in this set.** The shell's text says "every number on this sheet is re-read from its measured run" (`ConceptPage.tsx:285-293`). rigi and peak never read the picked photo, and the other pages follow it in only some figures.

## Cross-page cleanup (size and duplication)
- **Repeated helpers.** These page-local copies should move to `viz/`:
  - `CHIP_ON`/`CHIP_OFF`, `Chip`, `Slider` rows;
  - `median`, `angDiff`, `cone`, `sgn`/`signed` (the kit has `signedDegrees`);
  - `skyBand`/`ridgeCrop` (the kit has `skylineBand`);
  - `ROLL_IDS` (the kit has `GIPFELBUCH_PHOTO_IDS`);
  - per-page `FIG_LABEL`/`LABEL` constants that scale SVG text for a 720 px column.
- **Repeated fetches.**
  - `/demo/manifest.json` is fetched 5 times across photo and camera-prior.
  - `roll.json` is fetched by 5 components in camera-roll.
  - Each needs one cached kit hook, like `useGipfelbuchPhoto`.
- **Projection maths is copied in 3 files** (tap-a-peak, photo-workspace, peak). tap-a-peak also re-implements a small solver (about 100 lines) where it could call `geo/camera` and `solveFromControlPoints`.
- **SVG labels need a minimum size.** Use a kit `useFigureScale()` or a `minPx` on `HandLabel`, so text never drops below about 10 px at the real figure width. This replaces the per-page constants.
- **Fixed figures need a label.** Figures that stay on one photo should say "fixed: demo-NN". A kit `FixedPhotoNote` would make this uniform.


## rigi.tsx (780 lines)

Checked against: `public/demo/gipfelbuch/demo-NN.json` (all 12), `reports/status.md:9`, `reports/test-results.md:55-63`, `src/lib/gipfelbuch/graph.ts` (all 18 STAGES ids exist), `tafel/sheets.tsx:42,1791`, `ConceptPage.tsx:281-293`, `swiss/theme.css` + `src/styles.css:65` (dark island resets the swapped tokens correctly). `gipfelbuch.check.ts` passes.

### Earlier findings: status
| Finding | Status |
|---|---|
| R5 GuessVsSolved demoted into Details (cluster-A HIGH) | **Fixed**: back in body at `rigi.tsx:665`, Fig. 2 |
| R6 imprint on Trio/Gallery tiles | **Fixed** kit-wide (`viz/real.tsx:426`, imprint off by default) |
| R3 Stat/Numbers wrap | **Fixed** kit-wide (`viz/Section.tsx:105-112`, nowrap + `clamp(26px,14cqi,40px)`) |
| R1 narrow figure column | **Mitigated**: `Figure bleed` now `lg:ml-[calc(-33.333%-8px)]` (`viz/Figure.tsx:87`); body column still `content-start/margin-start` (`ConceptPage.tsx:297`) |
| Step-inside Trio tile (cluster-A MED) | **Fixed**: real split over photo, caption "near ground lifted to 3D" (`rigi.tsx:582-598`) |
| R8 HowItWorksScene cramped (cluster-A HIGH) | **Open**: the scene still lays out on viewport breakpoints (`HowItWorksScene.tsx:747` `lg:grid-cols-[7fr_5fr]`, `:686,705` `sm:flex`), not container width, so inside a figure it still assumes a page-wide box. Shared component (uncommitted edits by another session); fix belongs there (container queries) |
| Fig D1 synthetic registration contrast (cluster-A MED) | **Partly fixed**: photo line ink 2.2, DEM line solved-colour 2.8, residual now a `Wash` (`rigi.tsx:169-184`). Overprint at the bottom remains (see bugs) |
| Stages tab bar wrap in Details | Not re-checkable without a browser; Stages is kit |

### Bugs
1. **bug — page picker contradicts every figure (R9).** `rigi.tsx:401,499,559` hard-code demo-01 / demo-03; the page never calls `useNotebookPhoto`. Yet the shell renders a `PhotoPicker` with "every number on this sheet is re-read from its measured run" (`ConceptPage.tsx:285-293`) and a Ledger from the picked photo (`sheets.tsx:1794-1797`). Picking demo-11 shows a ledger for a rejected photo above a Fig. 1 that says demo-01's numbers. Fix: drive `HeroStages` (and the caption) from `useNotebookPhoto()`; keep GuessVsSolved/Outcomes on demo-03 but caption them "fixed: demo-03".
2. **bug — two residual metrics on one sheet, even for demo-01.** Ledger "aligned to 2.0 px" = `solved.residualPx` (1.98) while Fig. 1 caption says the gap falls "from 5 to 3 px" = `residual.solved.median` (2.71) rounded with `toFixed(0)` (`rigi.tsx:411`). Fix: use one metric on the sheet (or name both: "solver residual 2.0 px, median column gap 2.7 px") and print one decimal.
3. **bug — note and circled key point to a hidden figure.** "Drag the terrain line afterwards to feel the match ①" + margin note "Slide it off by 3° and see how big the error looks" (`rigi.tsx:669-673`) sit above Fig. 3 (HowItWorksScene, a drag that springs back, no 3° slider, no ①). The ① (`CircledKey`, `:268`) and the ±4° slider (`:274-281`) are in Fig. D1 inside the collapsed Details. Fix: drop the ① and rewrite the note for Fig. 3 ("drag the terrain line off; it springs back"), or move the reference into Details.
4. **bug — overprinting labels in Fig. D1.** HandText at `(300, 292)` size 19 (`rigi.tsx:265`) spans about x 300–510, y 278–296; the degree-ruler labels sit at y = BASE+22 = 284 at x 400 ("0°") and x 520 ("9°") (`:205-214`). They collide on every frame. Fix: move the note to y ≈ 236 (above BASE, in the rock hatch) or drop the even-tick labels under it.
5. **bug (minor) — ruler labels truncated.** Ticks every 60 px at `PX_PER_DEG = 13` are 4.6° apart; even labels print `((i-6)*4.6)|0` → −27, −18, −9, 0, 9, 18, 27 (true 9.2°, 18.4°, 27.6°) (`rigi.tsx:213`). Fix: label every tick on a whole-degree grid (`PX_PER_DEG*5 = 65 px`), or `toFixed(1)`.

### Accuracy
6. **accuracy — "all on the CPU in the browser"** (`rigi.tsx:748-749`). Stale since the GPU-default waves: horizon march, solve grid, sky refine and certified-f32 horizon/align run on the luma graph by default (`reports/status.md` GPU compute row). The baked gipfelbuch data was measured on the CPU path (README §Real data), which is a different statement. Fix: "in the browser, on the GPU where available (the demo numbers here were baked on the CPU path)".
7. **accuracy — "17 / 17 HIGH-confidence wild test photos correct"** (`rigi.tsx:729-731`) is the matcher *service* (arm A, `test-results.md:63`, `status.md:9`), not the in-browser pipeline the rest of the page describes. Fix: label "matcher service, held-out wild test: HIGH 17/17" and say it is a separate service.
8. **accuracy (minor) — Fig. 1 caption uses `Math.abs(delta.yaw)`** (`rigi.tsx:403`), dropping the direction; fine for demo-01 (+9.3°) but hides that demo-09/10 are −19°. Low.
9. Verified correct: 12/14 within 1°, 0 false accepts, ~a fifth of wild photos auto-accept (`status.md:9`); "Two photos here were rejected as low confidence" (demo-07 0.457, demo-11 0.443); demo-12 "refined" (stage `refine`); demo-03 GuessVsSolved 13→2 px (13.1→1.8); demo-01 compass 9.3° off (251.41 → 260.7).

### React / code
10. **cleanup — `ROLL_IDS` duplicates `GIPFELBUCH_PHOTO_IDS`** (`rigi.tsx:543-556`); `Gallery` already defaults to it (`viz/explain.tsx:542`). Delete the constant and the `ids` prop.
11. **cleanup — per-frame rebuilds in the rAF figure.** `Registration` rebuilds `candidatePath`, the 400-point `residual` string and its `Wash` every frame (`rigi.tsx:114-121`). README: "inside rAF loops reuse precomputed paths". Fine at this size, but quantise `px` (e.g. 0.5 px) and memoise on it.
12. **design — `Constellation` tabs** (`rigi.tsx:341-365`): `role="tab"` without `role="tabpanel"`/`aria-controls`/arrow keys; `${accent}26` assumes a 6-digit hex (`groupColor` falls back to `"#999"` → invalid `#99926`). Use plain buttons with `aria-pressed`, or full tab semantics; use `color-mix()` for the tint.
13. **cleanup — `tightBand` hard-codes demo-07/11/12** (`rigi.tsx:530`) as "head on the skyline" ids; that fact belongs in the data (a `personOnSkyline` flag) or a shared kit helper, since other pages crop the same photos.

### Prose
14. **prose — Margin note b repeats its sentence** ("Yaw ... is the part the phone gets wrong" / "Yaw is what the compass gets wrong; the rest of the pose holds", `rigi.tsx:658-661`). Replace with a fact: "pitch and lens land within 3° / 5 % on the demo set".
15. **prose — Margin note a** "I notice the skyline is the only line both sides can draw" (`:651`) reads oddly ("I notice"). Suggest "The skyline is the one line both photo and terrain can draw."
16. **prose — four MarginNotes** (a–d) against the MarginNote rule "at most 3 per entry" (README §Margin notes; the hand-pass section says notes are not capped, so the README contradicts itself). Resolve the README, then trim.
17. **prose — Outcomes step 3 body repeats its title** ("Step inside" / "Step inside: near ground lifted to 3D…", `rigi.tsx:583-584`). Body: "Near ground lifted to 3D, seen from the camera's own eye."
18. **prose — Fig. 3 caption** "the six beats of one real solve, on the dark plate" (`:680`): "dark plate" is jargon; say "The landing page's demo scene, one real solve in six beats."

### Size / duplication
19. **cleanup — `Constellation` (60 lines)** duplicates the index (Blattübersicht/NotebookMap) and the shell's "Where it sits" route device. Replace it with a link to `/gipfelbuch` or a shared `ChapterList` component from the index.
20. Page is the shortest of the seven (780 lines) and close to the explainer recipe; the synthetic `Registration` (~200 lines) is the only bespoke figure. Keep.

## Review: camera-prior.tsx and photo.tsx (2026-10-01)

Read-only. Numbers recomputed with node over `public/demo/manifest.json` and `public/demo/gipfelbuch/demo-*.json`. Code claims checked in `src/lib/upload/exif.ts`, `camera/focal.ts`, `geo/solve.ts`, `geo/pipeline.ts`, `integration/unknown-pose*.ts`, `geocam/priors/{photo-priors,heading}.ts`, `geocam/map/factors.ts`, `concord/priors/altitude.ts`, `pose6dof/types.ts`, `flags/index.ts`, `reports/negative-results.md`, `reports/geometry-first-pose.md`. Kit state: `Stat`/`Numbers` now use clamp + nowrap (`viz/Section.tsx:105-112`, `viz/explain.tsx:525-528`), so R3 is fixed. RealPhoto imprint defaults off (`viz/real.tsx:426`), so R6 is fixed. `Flow` stacks below 560 px of container width (`viz/Steps.tsx:32`), so R8 is fixed. Figures now span past the prose into the margin columns (`viz/Figure.tsx:86-87`), so R1 is fixed.

## camera-prior.tsx

### Verified correct
- `DEFAULT_SIGMA.yaw` 15, `yawRange` 25 and `pitchRange` 3 are at `geo/solve.ts:273,354-355`. `COMPASS_DEFAULTS` 5/5/nu 3 is at `geocam/map/factors.ts:179`. `sigmaHFromHAcc` clamps to 5–100 m with a default of 20 (`photo-priors.ts:69`). `sigmaA` 3 is at `concord/priors/altitude.ts:71`. sigmaH/sigmaV 15/20 is at `pose6dof/types.ts:55`. The focal prior is on the 1600 basis (`photo-priors.ts:60`).
- Deep prose (l.1081-1089): the median |Δyaw| over 12 photos is 7.89°, 6 exceed 7.1°, the worst is demo-10 at −18.98° (2.68σ), the pitch and roll medians are 0.765/0.675, and the outliers are demo-11 −2.66, demo-02 +2.56 and demo-12 −2.23. All of these match the data.
- Callout (l.1719-1728): 6 of the 10 accepted photos are beyond 7.1° (01, 02, 03, 05, 09, 10). This matches.
- "Within 3° / within 5 %" (l.1546) holds: accepted |Δpitch| is at most 2.56, and the hfov ratio is at most 1.04.
- Fig. 3 "up to 18.6°" is correct (demo-09 −18.55). The negative result 12.0→13.4 px is the altitude-contour eye rule (`negative-results.md:85`). The "6.0 vs 0.5–2" figure appears at `negative-results.md:100`.

### Earlier findings: status
- FIXED: the misattributed negative result. The beat now names altitude (l.1676-1687).
- FIXED: the ±7.1° band. Fig. 2 shades ±15 and names ±25 (l.1329-1331, 1343). D2 keeps 7.1 for MAP and is explained in the Callout (l.1719).
- FIXED: declination is now in the Fig. 2 caption (l.1331), and lens distortion is noted (l.1727).
- FIXED: the Stat/Numbers overprint (kit), Flow D4 (kit), the Fig. 3 overlay contrast (CrispLine halo in `real.tsx:585-588`) and the loud Trio numbers.
- FIXED: stipple in the Fig. 2 band and in the D2 sigma bands. Both are now a flat `Wash` (l.1343, 273-284, 297).
- PARTLY OPEN (R2): Fig. 2 bars are still hatch-filled with an outline (l.1377-1393), so the value-carrying bars have no solid or graded fill. **design**. Fix: a solid tint for accepted bars (for example ink at 70 %), red outline only for rejected bars, and hatch on top if the texture is wanted.
- PARTLY OPEN: the D1 photo-plus-map grid switches on the viewport `lg:` breakpoint (l.174), not on a container query. Inside Details the photo and map still sit side by side at about 860 px, so the map is about 330 px. **design**. Fix: `@container` with stacking below about 720 px.
- OPEN: the D3 tab chips are text with an underline border only (l.652-656). The cluster-A note "no chip, no dot-state" is partly addressed, because a HandDot state was added. Low priority.

### Bugs
1. **bug**, l.485-491: the GPS hAccuracy strip passes `fmt={(v) => \`${v}\`}` with raw manifest floats. The selected-dot label (l.393) then reads, for example, "01 · 29.397090027280996". Fix: `fmt={(v) => v.toFixed(0)}`. The tick labels are unaffected.
2. **bug (inconsistent number)**: the median compass error is **9.6°** in the main-flow Numbers (l.1601-1615, 10 accepted photos) but **7.9°** in the Details prose (l.1083) and the D2 Stat (l.499), which use all 12 photos including the two rejected solves. The page states both without reconciling them. Fix: use accepted-only in D2 and the prose too (the viewport-inference review made the same change there), or label D2 "all 12, including 2 rejected".
3. **bug (stale figure refs)**: l.1073 says "with the numbers shown in Fig. 3", but those numbers are in the PriorLab, Fig. **D3**, and main-flow Fig. 3 is the gallery. l.1081 says "Against the real photos (Fig. 2)", but the strips it quotes (7.1° 1σ, the 7.9° median) are Fig. **D2**, while Fig. 2 shades ±15°. Fix: refer to D3 and D2.
4. **bug (stale colour word)**: the PriorTrio body (l.1497) says "Cyan is where the camera really faced", but the line is drawn in `color="blue"` (l.1511), which is `--nb-blue` = `--gb-water` #30626b, a dark teal. The page's real cyan is `LAYER_STYLE.solved` #0aa5bd (Fig. 1, D1). The same mismatch appears in the third Trio tile (l.1559). Fix: draw with `SOLVED_C`/`PRIOR_C` (as Fig. 1 does), or say "blue".
5. **bug (wrong claim for some picker photos)**: the YawShift worked line (l.1294-1297) always says "the ridge's slope turns that slide into the N px vertical gap". For demo-11 (Δψ −0.22°, so Δx ≈ 3 px, yet the gap is 43 px) and demo-12 (Δx 21 px, gap 41 px), the gap comes from a person occluding the skyline, not from yaw. demo-07 and demo-11 are also rejected solves, so "solved" is untrusted there. Fix: when `!d.solved.accepted` or `|Δx|` is much smaller than the gap, swap the sentence ("here the gap is mostly occlusion, not compass"), or pin the worked example to an accepted photo.
6. **design (overprint, by geometry)**: the Fig. 2 "worst" arrow (l.1419-1428) runs from (590, 66) to (558, 237). It crosses the demo-10 bar (x 539–577, y 120–215) and ends between that bar's value label (baseline 229) and its id label "10" (baseline 244). The arrow also assumes the worst error is negative: for a positive worst it would point below the axis at nothing. Fix: end the arrow at the bar's far end + 6 on the side given by `sign(v)`, and start it left of the bar.
7. **design**: the Fig. 3 gallery hard-codes `["demo-09","demo-03","demo-06","demo-02"]` (l.1698) under the caption "four **more** photos". When the page picker is set to one of these, the photo repeats. Fix: filter out `photoId` and take the next accepted photo, or drop "more".

### Accuracy / prose
- **accuracy**, l.1076-1078 and 1176-1178: the prose says a magnetic heading "is first made true with the WMM2025 declination". That holds only in `mapPriorsFromPhoto`, which passes `declination ?? true` (`photo-priors.ts:105`). Everywhere else `priorHeading` defaults to the `geoDecl` flag, which is **off** (`flags/index.ts:187`, `heading.ts:31-34`), so the production skyline solve does not correct magnetic headings. Fix: add "(geocam MAP path; app-wide behind geoDecl, default off)".
- **accuracy/prose**, l.1677-1680: "We tried trusting the phone's altitude more" loosely describes the altitude-contour eye rule (a prior on the eye from altitude contours), not trust in GPS altitude. Fix: "We tried pulling the eye toward the phone's altitude contour".
- **prose**: the YawShift equation (l.1641) comes before "The idea" beat (l.1643), so the reader meets Δx ≈ f·tan(Δψ) before yaw is defined ("Yaw, the way the camera points" appears at l.1654). README §Math kit says the equation sits in a Beat after the figure it explains. Fix: move `<YawShift/>` after the idea beat, or into it.
- **prose**: "19°" appears five times (margin note a, Fig. 2 caption, the Fig. 2 annotation, Numbers, and 18.6 in the Fig. 3 caption). Two would do.
- **prose**: the PriorNumbers label "median tilt error from gravity" (l.1623) uses pitch only. Say "pitch".
- **design**: Fig. 2 YawBars ignores the page picker. Ringing the picked photo's bar would tie it to Fig. 1 and YawShift, in the spirit of R9.

### Label sizes
- The Strip constants (l.215-218) are commented as tuned for 720 px but are 9/10.5 units in a 520 viewBox. At the now-wide track (about 860 px) they render at about 15/17 px, which is fine. The comment is stale.
- The PriorTrio SVGs (viewBox 100) use HandLabel 4.2 and HandText 5/5.5 (l.1479-1539), about 9–13 px at about 250 px tiles. That is below the README's 18 px floor for Caveat notes. Fix: 6 / 7 units, or move the numbers into the HTML body.
- The PriorLab HandLabels at 11 (l.699, 864) in a 540 viewBox in the 1.7fr column render at about 9–10 px.

### React / code
- **cleanup**: `PriorLab(_props: { accent })` takes an unused prop (l.590, 1060).
- **cleanup**: `useHAcc` (l.103) fetches `/demo/manifest.json`. It is called twice on this page (PriorErrors, PriorTrio), and photo.tsx and pose-estimate.tsx have their own copies. Fix: one cached `useDemoManifest()` in `viz/real.tsx`.
- **cleanup**: `med` in PriorErrors (l.430) hard-codes indices 5/6, assuming exactly 12 photos. Use the generic median in PriorNumbers (l.1602).
- **cleanup**: `key={id}` sits on both AlignmentStoryProvider and the inner RealPhoto (l.173, 176). One is enough.
- **cleanup**: the Strip dot `role="button"` handles Enter only (l.364). Add Space.
- **cleanup**: PriorLab re-renders every frame while visible (useTime) even when nothing animates (compass, gravity and focal all on: only the pivot pulse moves). Acceptable; could gate `useTime` on `!on.compass || !on.gravity`.

### Size / duplication (1733 lines)
- `skyBand` (l.122) duplicates the kit's `skylineBand` (`viz/explain.tsx:764`), and photo.tsx has a third variant, `ridgeCrop`. Use the kit's.
- `sgn` duplicates photo's `signed` and `notebook/notes.tsx:58 signedDegrees`. Move one formatter into the kit.
- `rectD`/`circleD`/`wedge` path helpers also appear in other pages and belong in `notebook/sketch.ts`.
- `Strip` (about 190 lines) is a generic "dot strip with σ bands, click to pick" and could be a kit `DotStrip`.
- The page has about 650 lines of Details: Deep prose, PriorLab (430 lines), the D4 Flow plus Steps (which say the same thing twice), Gotchas and CodeRefs. The Flow (l.1097) and the Steps (l.1118) cover the same pipeline. Keep one.

## photo.tsx

### Verified correct
- `MAX_PX` 2048 (`exif.ts:16`), MakerNote 0x0008 gravity (`exif.ts:145-150`), `DEFAULT_F35` 26 (`exif.ts:18`), round(lon/15) plus `tzEstimated` (`exif.ts:266-268, 334-345`), pinned → alt/hAccuracy null (`exif.ts:355-360`). The flag names `yawUnknown`, `pitchRollUnknown`, `focalUnknown` and `positionSource` are at `exif.ts:373-378`. A missing heading gives `yawRange = 180`, a 360° search (`unknown-pose-core.ts:70`). Missing gravity gives `pitchRange = 15`, a "wide pitch search" (`:58`). The `PhotoMeta` fields at l.699-701 match `lib/photos.ts:11-34`. `geo/photo-meta.ts` has `focal35`. Eye = max(alt, ground + 1.6) (`geo/pipeline.ts:23,49`).
- f = f35·√(W²+H²)/43.27 (`FF35_DIAGONAL_MM = 43.2666`, `camera/focal.ts:11`). Recomputed: 26 mm gives 601 px and 67.3° (landscape) or 802 px and 53.0° (portrait); 13 mm gives 106.2°.
- Fig. 3 caption "28 to 69 m above the DEM in eleven photos … 730 m below in demo-09" matches the recomputed values (28…69, −730). hAccuracy spans 5.8–121.6, which shows as "6–122 m". All 12 photos carry GPS, heading, gravity and f35, so "12 / 12" and "none raises an unknown flag" (l.683) are correct.
- The tilt wording (l.889-892) follows the sign in `exif.ts:190`.

### Earlier findings: status
- FIXED: the Fig. 2 (now Fig. 3) table `min-w-[640px]` is gone. It is now a container-query grid (l.525-526, 556), with labelled 3×3 cells when narrow.
- FIXED: the Anatomy layout. The EXIF tags are HandLabel size 10 in a 400 viewBox (l.262), about 12 px at the wide track. The pane is in a viewport `lg` grid.
- FIXED: the selected gallery tile. It is now `tone="failure"` with a red value label (l.1045, 1061), and imprint is off.
- FIXED: hero pins inset to 10 %/90 % (l.847-852). FIXED: "tens of degrees" is now "up to 19°" (l.781). FIXED: the focal equation was added (l.1088-1112).
- OPEN (kit): the Steps rail styling (cluster-A MED) belongs to the kit and was not checked here.

### Bugs
1. **bug (arrow to the wrong mark)**, l.853-869: the red note "up to 19° off on the demo set" is about the compass (Mark 3 at (W/2, 60), MarkList item 3). Its arrow ends at (W/2+18, H/2−24), right next to **Mark 4 (Tilt)** at (W/2, H/2). So the hero tells the reader that the tilt is 19° off. Fix: aim the arrow at (W/2+14, 60+14), or place Mark 3 where the arrow lands.
2. **bug (overflow band)**, l.525-526: the wide grid is 2+5.5+8+5+4.5+3.5+4.5+4 rem plus 1fr plus 8 × 12 px of gaps, which needs at least about 690 px. It switches on at `@[640px]`, so containers from 640 to about 690 px overflow or squeeze the last (pitch/roll) column. Fix: `@[720px]`, or shrink the `8rem` f35 column.
3. **bug (out-of-order margin marks)**: the marks read a (l.1182), **d** (l.1219), b (l.1233), c (l.1240), so d comes before b and c. There are also 4 notes, while the README §Margin notes caps them at 3. Fix: re-letter them a, b, c, d in DOM order and drop one (c and b say nearly the same).
4. **accuracy**, margin note d, l.1219-1221 ("So only yaw and position are left to find."), and l.752-754 ("only yaw and position remain uncertain"): the pipeline does not solve position. GPS fixes it, and the eye is max(alt, DEM + 1.6). The solve frees yaw, plus pitch, roll and focal within tight windows (`geo/solve.ts:273,354-355`). The viewport-inference page says exactly this. Fix: "So yaw is what's left to find; GPS gives the place."
5. **design (picker collision)**: LensEquation (l.1081-1121) compares the picked photo against a "Fixed example, demo-02 (the ultra-wide)". With demo-02, 07, 08 or 10 picked (all 13 mm), the sentence compares 13 mm with 13 mm. Fix: choose `b = a.sensor.f35 === 13 ? "demo-01" : "demo-02"` and adapt the wording.
6. **cleanup (stale comment)**: l.912 says "drawn from the real values of demo-01", but TagsMini, TiltMini and LensMini take the picked photo (l.1167-1168). l.909's assumption of "about 230 px wide" no longer holds at the wide track (about 280 px), which is harmless.

### Accuracy / prose
- **prose (repetition)**: "730 m" appears four times in the main flow: the beat (l.1231), the Fig. 2 caption (l.1039), the Fig. 3 caption (l.550) and Numbers (l.1152). Fig. 2 (seven tiles) and Fig. 3 (the 12-row table) show the same altitude check twice. Fix: keep Fig. 2 as the visual and move the full table to Details, or drop the altitude columns from Fig. 3 and keep it as the heading and tilt record that cluster-A said was "the whole point".
- **prose**: Fig. 2 picks seven tiles from `ALT_IDS` (l.1020) without saying why 05, 07, 08, 11 and 12 are left out (people in frame). Add "(people-free crops)" or show all 12 with `cols={6}`.
- **accuracy (minor)**: the Anatomy "region" row hard-codes `"demo-region"` and "~20 km" (l.174-179). It matches the manifest, but the size is not checked here.
- **prose**: the Survival entry "Apple gravity" says "wide pitch search", and the code uses ±15° (`unknown-pose-core.ts:58`). Give the number.

### React / code
- **cleanup**: `useManifest` (l.107) is called three times on this page (RealRecord, FieldsTable, PhotoNumbers), which means three fetches of the same JSON. It duplicates `useHAcc` in camera-prior. Use one shared cached hook.
- **cleanup**: `signed` (l.823), `ridgeCrop` (l.1009) and `compassName` (l.803-822) are local copies. Use the kit's `skylineBand`. `compassName` is probably useful in the kit.
- **cleanup**: `Survival` updates `have` from a closure, `setHave({ ...have, … })` (l.624). Use a functional update. The same applies to PriorLab in camera-prior (l.651).
- **design**: the Anatomy and RealRecord tab buttons (l.402-418) and the Survival toggles (l.620-633) are bespoke chip styles. Three pages restyle chips by hand, and a kit `ChipToggle` would settle the active/inactive contrast once.

### Size (1255 lines)
- The Details section (`Deep`, about 350 lines) repeats the main flow: the Steps "Focal to field of view" duplicates LensEquation, "Gravity to pitch and roll" duplicates the Trio, and the Hazards callout repeats the 19° compass claim. It could be cut to the Anatomy figure, the Survival figure, the Definition and the CodeRefs.

## Review: photo-workspace.tsx and camera-roll.tsx (2026-10-01)

Read-only review. Checked against `src/lib/integration/second-opinion.ts`, `src/lib/ontology/core/confidence.ts`, `src/components/PhotoWorkspace.tsx`, `src/routes/photo.$id.tsx`, `src/lib/roll/{roll.ts,align/viewpoint.ts,align/align.ts,import/interpolate.ts,mosaic/panorama.ts,mosaic/ridgelines.ts,map/multi-drape-layer.ts,map/drape-atlas.ts}`, `src/components/site/meta/RollCompasses.tsx`, kit (`viz/Figure.tsx`, `viz/explain.tsx`, `viz/Section.tsx`, `viz/real.tsx`, `viz/hooks.ts`, `notebook/Ink.tsx`), `public/demo/gipfelbuch/demo-*.json`, `public/demo/gipfelbuch/camera-roll/roll.json`, `public/demo/shots/{demo-01-overlay,drape}.jpg`, `reports/leaderboard.md`. Nothing rendered; label-size and clipping items are geometry estimates.

Verified correct (no action): choosePreview bar `> 0.2` (medium exclusive, `high: null`), NEAR_WINDOW 4°/1.5°, AGREE_DEG 1, CASCADE_TIMEOUT_MS 20 000, matcher 150 s and "45–77 s idle", busy matcher unlocks at once (second-opinion.ts:5-22,77-115); drag/shift-roll/wheel formulas (PhotoWorkspace.tsx:964-1030, wheel clamp 5..100); solvePins 1/2/≥3 rule (align.ts:945-951); source order saved → unknown cascade → autoAlign (PhotoWorkspace.tsx:555-640); exportLocked gates concord and EyeSuggestion; leaderboard 11/12, 0 false accepts, IMG_7130 +2.98° at 0.397, −0.02° (leaderboard.md:14-15,23). Roll: ROLL_LINK_M 15 km single-linkage, VIEWPOINT 250 m first match then re-centre, resolvePose order saved > GT (quality ≠ none, all four angles) > solved > prior (roll.ts:19-21,90-180,208); BIAS_WINDOW 45 min, MIN 1°, MAX 90°, OUTLIER 8°, median (viewpoint.ts:17-28,85); retry 2° (align.ts:105); interpolate 20 min (interpolate.ts:11); ridgeline slabs 40 m–120 km default (ridgelines.ts:92-93); TOP_K 4, 4 mip-mapped atlases, first 16 at 1024 px (multi-drape-layer.ts:80, drape-atlas.ts:21-23,79); 360° mesh repeat (panorama.ts:9); `local-roll-<hash>` (roll.ts:261-264). Roll data: 12 photos, 1 roll, 1 viewpoint, max 112 m from first, span 20:05, 10/12 accepted. RealBias prose numbers recompute to 9 used / 3 better / 5 worse / 8 of 10 outliers, matching the code.

---

## photo-workspace.tsx

### Bugs

1. **bug** `photo-workspace.tsx:1221-1228` — MeasuredWorkspace states "the two solvers agree to X°, well inside the 1° AGREE_DEG" for whatever photo the picker selects. For demo-11 `|app.yaw − solved.yaw| = 1.23°` (demo-11.json), so the sheet prints "agree to 1.23°, well inside the 1°". Fix: branch on `≤ 1` ("inside" / "outside, so this would be Refined"), or compute the verdict word.
2. **bug** `photo-workspace.tsx:1517-1520` — "In the timeline of ①, the lock row is the only thing that waits." `CircledNumber 1` points at Fig. 1 (HeroJourney Stages), which has no lock row; the timeline with a lock row is D2 PoseJourney, inside the collapsed Details. Fix: refer to the "Export unlocked" stage of Fig. 1, or point to D2 explicitly.
3. **bug** `photo-workspace.tsx:1105-1151` (Fig. 3 AnnotatedWorkspace) — regression item "Stockhorn label hidden under pins" still open. Mark 1 at (1126, 548) with `k=3.2` (r = 10.5·k ≈ 34 units) sits on the baked "Stockhorn 2,190 m · 18.2 km" label (≈ 1126, 560–595 in the 2048 frame). The two added hand notes are `color="#fff"` with HandText's default paper halo (Ink.tsx:351-352) and are placed over the bright cumulus (x 426–1000, y 430–478) and pale sky (x 980+, y 445): white on white. viewBox still the full 2048×1536 (no crop; only `k` went 2.56 → 3.2). Fix: crop `viewBox="0 380 2048 900"`, move Mark 1 above/left of the label (e.g. 1010, 520), give the notes `color="var(--gb-ink)"` with paper halo or `#fff` with a dark halo (`halo={false}` plus a dark stroke), and drop the "Stockhorn: 2,190 m, 18.2 km" note: it repeats the baked label and MarkList item 1 (three copies).

### Accuracy

4. **accuracy** `photo-workspace.tsx:1442-1444, 1221-1225` — "Second opinion: a separate solve runs after first paint. The two yaws agree to X°." compares `d.app` (source `"solved"` for all 12 demos: the bundled roll-aligner pose) with build-data's solvePose. Bundled demo photos open on `bundledPose` (photo.$id.tsx:25; PhotoWorkspace.tsx:490-497, 575-578), so the real second opinion (GPU autoAlign vs cascade) never runs on them. Fix: caption as "Two CPU solves of this photo (the app's saved roll pose and this script's) agree to X°", or show IMG_7130's real numbers here.
5. **accuracy** `photo-workspace.tsx:1608` (Trio "Unlock … or after 20 s") and `:1756-1759` (Stat "20 s cascade deadline bounding the export lock") — the 20 s bounds the cascade only. When the cascade rejects and `shouldEscalate()` is true and the matcher is free, the lock holds until the match returns (up to 150 s; PhotoWorkspace.tsx:1132 + second-opinion.ts:15-22). D2's "Weak skyline" scenario already shows this (lockEnd 8, "not to scale"), so the page contradicts itself. Fix: "or after 20 s if the second solver stalls; a render-and-match escalation can hold it longer".
6. **accuracy (prose)** `photo-workspace.tsx:1382-1390` — "Turning the camera 9.3° moves the label 122 px … one degree of yaw is about 10.7 px near the centre." The reader computes 9.3 × 10.7 = 100 px ≠ 122. Verified on demo-01: Niesen sits 28° off-axis, where x = c_x + f·tan(Δ) grows faster than linear (612·tan 28.3° − 600.9·tan 19.0° ≈ 123 px). Fix: add "and more toward the edge, because the lens spreads angles there".
7. **accuracy (minor)** `photo-workspace.tsx:575` — the lock label reads `!!status || verify === "pending"`; code is `!!status || !!error || verify === "pending"` (PhotoWorkspace.tsx:1132).

### Design

8. **design** `photo-workspace.tsx:1357-1366` — the "N px apart" note is `#fff` with the default paper halo on a photo, so it is low contrast on sky (the HandLabel next to it uses a dark halo correctly, 1367-1377). Fix: same dark halo as the label.
9. **design** `photo-workspace.tsx:251-254` — FIG_LABEL 11.5 / FIG_NAME 13.5 are fine on the desktop wide track (the R1 kit fix in Figure.tsx:83-87 now gives ~860–1100 px). At 390 px the 640-unit schematics render at ~0.55×, so labels are ~6 px. The comment's "540 to 800 px" is stale. Fix: scale with a container query, or hide the row-label HandNotes below 480 px.
10. **design** `photo-workspace.tsx:1097-1102` — Fig. 3 is fixed to demo-01 between two picker-driven figures (R9). The caption says demo-01, which is acceptable; prefix "Fixed: demo-01" so it does not read as following the picker.
11. **design** `photo-workspace.tsx:1238, 1253` — PeakProjection's default pick "Niesen" and the `known` list are demo-01 names. On other photos it silently falls back to the first four by x. Fine functionally; reset `pick` when `photo` changes so the pressed chip and the drawn peak cannot diverge.

### React / code

12. **cleanup** `photo-workspace.tsx:837` — `solvePinsDemo(pinned)` (12 LM iterations) runs on every rAF frame of the tween. Use `useMemo(() => solvePinsDemo(pinned), [pinned.join()])`.
13. **cleanup** `photo-workspace.tsx:1019` — `const unit = k === "vfov" ? "°" : "°"` is a no-op ternary.
14. **cleanup** `photo-workspace.tsx:608, 632` — every worker bar uses the same Wash seeds `"pw-wash-7"` / `"pw-wash-8"` (identical texture). Seed with `w.a`. Seed prefixes mix `pw-` and `pj-`.
15. **cleanup** `photo-workspace.tsx:1521, 1535, 1629` — MarginNote marks run a, c, b in reading order. Renumber a, b, c.

### Regression findings (cluster-E §1, app.md)

| Finding | Status |
|---|---|
| Fig. 2 (now Fig. 3) overlay labels illegible, Stockhorn under pins | **Open**: no crop, `k` 2.56→3.2 only (`:1105,1116`); now also white-on-cloud notes (item 3) |
| Numbers wrap mid-value | **Fixed** in kit (`explain.tsx:525-528` nowrap + clamp + auto-fit) |
| PoseJourney/PinSolve lost ground, FIG_LABEL ~7 px | **Fixed** on desktop: Wash+Hachure ground (`:322-335, 900-913`), FIG_LABEL 11.5 (`:253`), wide track. Open on phones (item 9) |
| Stage-1 "Opens on the phone's guess" renamed | **Kept on purpose** (`:1416-1418`), and accurate per choosePreview |
| Engineers' Toggle dl wrap; inactive chip contrast | **Fixed** (wide track; `CHIP_OFF` ink 80 %, `:88-89`) |
| Imprint under MiniLayers | **Fixed** via kit default off (`real.tsx:426`) |
| "Fallback" relabel, PeakProjection, Eq (app.md) | Present (`:1416, 1235-1393, 1543-1591`) |

### Size and duplication

- 1 807 lines, ~800 of them two synthetic Details schematics (PoseJourney 256-720, PinSolve 725-1047). `CHIP_ON`/`CHIP_OFF`/`INKVAR` (76-89) are duplicated verbatim in camera-roll (117-119). Move a `ChipButton` and the ink-var map into the kit.
- PoseJourney repeats `Wash` + `Hachure` on the same `d` eight times (496-641). A kit `HatchedBox({d, ink, opacity})` would cut ~100 lines here and on other pages.
- `solveLin`/LM in PinSolve (753-810) is a page-local Gauss-Newton solver. Acceptable as a schematic, but it could live in a small `viz/schematic-math.ts` shared with any other pin demo (tap-a-peak has a PinLock stage).

---

## camera-roll.tsx

### Bugs

1. **bug** `camera-roll.tsx:494-498` — `useTime(99)`: under reduced motion and webdriver `t` is frozen at 99 (hooks.ts:106-117), so `auto = floor(99·1.1 % 12) + 1 = 1`. The static figure shows 1 of 8 photos, one viewpoint, and none of the "f joined viewpoint 1" story. The initial render before scrolling into view is the same. Fix: `useTime(8.5)` (gives 10 > N, so the `done` end state with centroids).
2. **bug** `camera-roll.tsx:2023` — `<RollCompasses sketch />` is a raw `<figure>` (RollCompasses.tsx:328), not the kit `Figure`, so it gets neither the R1 wide track nor a figure number. It stays in the ~520 px prose column, which is why the cluster-E HIGH item is still open: right-edge labels are not clamped (`RollCompasses.tsx:899-907`, anchor "start" past the edge), and the slider is `w-32 sm:w-44` (`:516`). Fix: wrap it in `<Figure label="Fig. 2" bleed>` (renumber RealRoll/RealBias to 3/4), clamp label x to `[8, W-8]` with an anchor flip, and make the slider full width.
3. **bug (geometry estimate)** `camera-roll.tsx:586-588` — the ViewpointWalk top note starts at x=330 with size 14, about 62 characters (≈ 390 units), so it runs to ≈ 720 in a 640-wide viewBox and is clipped. The wording is also garbled ("the first photo within 250 m opens a viewpoint, not the nearest"). Fix: `x={320} anchor="middle"` and "a photo joins the first viewpoint within 250 m, not the nearest".
4. **bug (minor)** `camera-roll.tsx:324-331` — at link distance 30 km the label sits at x = 628 + text, past the 640 edge. Fix: `anchor="end"` when `linkKm > 24`.

### Accuracy

5. **accuracy** `camera-roll.tsx:1597-1599` — "Captured over 20:05 min, in four bursts." The roll.json timestamps give six bursts at a > 60 s gap (0–5 s; 2:01; 4:45–5:58; 8:30–8:40; 11:13–11:22; 20:03–20:05). Fix: compute bursts from `rows[].t` or drop "in four bursts".
6. **accuracy (framing)** `camera-roll.tsx:2155-2163` (Details: "every anchored photo gives its neighbours a better starting prior") and D4 caption `:796` — on the real roll the sequential bias lowers the error for 3 of 9 photos and raises it for 5, and OUTLIER_DEG flags 8 of 10 (RealBias, recomputed). The Details text hedges, but the main-flow beat (`:2090-2101`) never says the bias made most photos worse. Fix: one sentence in the beat with the 3-better / 5-worse count, or a Numbers item.

### Design / colour words

7. **design** `camera-roll.tsx:1510-1529` — the selected station's ray labels use `color="pencil"` (compass) and `"blue"` (solved), but the rays are LAYER_STYLE magenta `#e0207f` and teal `#0aa5bd` (`:1284-1285`), and the caption says "Dashed magenta … teal". Fix: colour the labels `PRIOR_C` / `SOLVED_C` (darkened for text).
8. **design** `camera-roll.tsx:2071` — the Trio calls the compass "Red" (StoryMap `PRIOR_INK #ab343a`) and RealRoll calls it "magenta" two figures earlier: two names and two inks for the same quantity on one page. Fix: one prior ink across both (StoryMap or LAYER_STYLE), then one word.
9. **design** `camera-roll.tsx:252-255` — the comment says the figures render "at the text column (~720 px)". FIG_LABEL_SMALL = 10 renders at ≈ 5.5 px on a 390 px phone, which hits the D5 azimuth ticks (`:1187`). Fix: as photo-workspace item 9.
10. **design** `camera-roll.tsx:1297` — RealRoll's selection starts at demo-03 regardless of the page photo picker (R9). Seed it from `useNotebookPhoto()`.
11. **design** `camera-roll.tsx:1900, 2079, 2220` — `drape.jpg` appears three times (hero stage 3, Trio step 3, D6), and it carries baked dark app chrome ("Live on your GPU · drag to orbit", "Open the full roll →") on the paper sheet. Fix: keep the hero use and D6, give the Trio step a crop or the MiniPlan, and crop the chrome out (`object-position`/inset).
12. **design (R2, low)** `camera-roll.tsx:823-830` — the D4 search window, a value-carrying wedge, is hatch only, with in/out encoded by hatch colour. Add a light Wash under it as PoseJourney does.
13. **prose** `camera-roll.tsx:1121` — "The DEM ridgelines traced from the viewpoint eye (red) sit behind here" is unclear. Use "The red line is the DEM ridgeline seen from the viewpoint; the app draws it over each photo as the match cue."
14. **prose** `camera-roll.tsx:2029-2031` — the margin note says "so the pins pile up", but the figure it annotates (RealRoll) draws station triangles; the pins only appear in D6. Use "so the stations pile up".
15. **cleanup** `camera-roll.tsx:284` — the comment says "in pencil", but the contours are `color="brown"`.

### React / code

16. **cleanup/perf** `camera-roll.tsx:1269-1282` — `useRollData()` fetches `roll.json` separately in five components (HeroStages, RealRoll, RealBias, MiniPlan, RollNumbers). Hoist it to a module-level promise cache or a context (as `useGipfelbuchPhoto` does).
17. **cleanup** `camera-roll.tsx:1762-1775` — the hard-coded `ROLL_IDS` duplicates `roll.rows[].id`. Derive it.
18. **cleanup** — `median` is defined twice (`:727-730` inline, `:1286-1290`); `angDiff` (`:121`) duplicates `wrap180` in `#/lib/geodesy`; `cone()` (`:1778-1789`) duplicates StoryMap's `wedge`; `Slider`/`Chip`/`CHIP_*` (`:117-188`) duplicate the photo-workspace chips. Kit candidates: `ChipButton`, `LabeledRange` (HandRange + value readout), `wedgePath`.
19. **cleanup** `camera-roll.tsx:76-116` — RayLabel takes `size` but maps it to 11/13 regardless. Pass it through or drop the prop.

### Regression findings (cluster-E §2, app.md)

| Finding | Status |
|---|---|
| RealRoll demoted into Details | **Fixed**: back in body after RollCompasses (`:2025-2035`) |
| RealRoll text column one word per line | **Fixed** on desktop (wide track + `lg:grid-cols-[minmax(0,380px)_1fr]`, `:1437`); stacks below lg |
| RollCompasses sketch clips/collides, tiny slider | **Open** (item 2; RollCompasses.tsx:516, 899-907) |
| Numbers wrap | **Fixed** in kit |
| CompassBias readout grid | **Fixed** (`:893-911` grid-cols-1, nowrap, tabular-nums) |
| ViewpointWalk lost disc fills, top label cut | **Fixed** (Wash `:530-534`, viewBox `0 -24`, `:512`); new top-note clip (item 3) |
| PoseLadder lost pills | **Fixed** (Chip `:681`, description 75 % ink `:700`) |
| PanoramaStrip sliders half width | **Fixed** (`grid-cols-1`, `:1211`) |
| Imprint on MiniAim/MiniPlan | **Fixed** (MiniAim is now StoryMap `:1955-1958`; kit default off) |
| "mip-mapped GIPFELBUCHES", "within a hundred metres" (app.md) | **Fixed** (`:2208` "atlases"; `:2217` "about 110 m") |
| Dark tiles `bg-[#11161a]` (app.md kit request) | **Gone** from this page (no matches) |

### Size and duplication

- 2 296 lines. Six Details schematics (RollLinker, ViewpointWalk, PoseLadder, CompassBias, PanoramaStrip, D6), about 1 050 lines, sit behind the fold. PanoramaStrip carries its own camera basis/projection (`:951-1018`), which duplicates the projection helpers in photo-workspace (`proj`) and in RollCompasses. A shared `viz/camera-math.ts` (basis, projectUV, unprojectAzEl) would serve three files and could be tested against `panorama.ts`.

## Review: peak.tsx and tap-a-peak.tsx (2026-10-01)

This was a read-only review. Nothing was rendered. Numbers were recomputed with node/tsx from `public/demo/gipfelbuch/**`. Code was checked against `src/lib/geo/peaks.ts`, `geodesy.ts`, `geo/control-points.ts`, `align.ts`, `picker/candidates.ts`, `picker/PickerPanel.tsx` and `terrain.ts`. A "likely" tag on a text-clipping item means the clip is estimated from Caveat at about 0.4 em per character and has not been seen in a render.

## Kit-level status for these pages

- R3 (`Numbers` wrap) is fixed in the kit. The value cell uses `whitespace-nowrap` with `clamp(26px,14cqi,40px)` (`viz/explain.tsx:528`).
- R6 (imprint) is fixed in the kit. `ImprintContext` defaults to false (`viz/real.tsx:427`).
- R1 is half fixed. A `Figure bleed` now spans 8 of the 12 columns (`viz/Figure.tsx:87`), but non-bleed figures still sit in about 520 px. On peak that covers Fig. 4 and Fig. 6. On tap-a-peak it covers Fig. 4 and Fig. 5.

---

## peak.tsx

### Regression findings (cluster-C, peaks.md)

| Finding | Status |
|---|---|
| LabelLayout `truncate` cut the reason column | **Fixed.** `whitespace-normal` and a 4-column grid (`peak.tsx:799,806`). Cap and spacing rows are both red; the suggested "muted for cap" was not done (`:809`). |
| HiddenRings population chart demoted to Details | **Fixed.** It is now `RealOcclusion`, main-flow Fig. 4 (`:1499`), with a 300-unit-tall viewBox. |
| Labelled vs visible dots are the same colour | **Still open.** Dots are `forest` vs `pencil` (`:1610`), which are `#575e4e` vs `#49423d` (`swiss/theme.css:24`, `notebook.css:20`): two near-identical dark greys. The legend draws "visible, not labelled" as 40 % ink, a light grey (`:1655-1660`), so the legend does not match the dots. |
| Visible count 260 vs 257 | **Fixed in the body.** Every count comes from `peak.json` `counts` (`:1342,1709`). **Still open in the shell:** the sheet value is `` `${d.peaks.filter(p => p.visible).length} visible summits` `` (`tafel/sheets.tsx:1759`), which reads 260 from the demo-10 bake while the body says 257. The bake also stores only the 40 tallest hidden peaks, so its counts are not catalogue counts. |
| Hidden 924 vs the 40 ringed | **Fixed.** The label reads "hidden (tallest 6 ringed)" (`:1456`). |
| RayMarch readout overflow, pills, "HIDDEN" overprint | **Fixed.** The verdict label moved to the bottom-left (`:355-363`). Pills are filled ink when active (`:405-409`). |
| Fig. 1 compare: pink prior labels on pale clouds | Not re-checked visually. Same `RealPhoto priorPeaks` path, unchanged. |

### Bugs

1. **bug: R9, two pickers and the page ignores the notebook photo.** `peak.tsx` never calls `useNotebookPhoto`.
   - Fig. 1 `RealSummits` has its own local 3-photo picker (`:1335,1364`).
   - Fig. 2 and Fig. 5 are fixed to demo-01; Fig. 3 and Fig. 4 to demo-10.
   - Meanwhile the shell shows a 12-photo picker and a ledger for the picked photo, with the promise "every number on this sheet is re-read from its measured run" (`ConceptPage.tsx:286-292`).
   - Fix: drive `RealSummits` from `useNotebookPhoto()`, falling back to demo-10 when `peak.json` has no counts for the photo (the pattern in `tap-a-peak.tsx:967-973`). Label the fixed figures "fixed: demo-NN" in their captions.
2. **bug: hidden rings overprint (demo-10, the default photo).** Three of the six rings sit within 8 working px: Gross Grünhorn (452,214), Hinter Fiescherhorn (444,213) and P3981 (446,214), each with r = 7k ≈ 3.9 working px (`:1346,1482-1490`).
   - Fix: deduplicate rings closer than 2r, or ring the top 6 *after* x-spacing, as `layoutPeakLabels` does.
3. **bug: Fig. 1 caption overcounts rings.** "red rings mark the N tallest hidden ones" uses `min(6, hid.length)` (`:1359`). On demo-09, Aletschhorn sits at x = 803, outside the 800-px frame and the crop, so only 5 rings show. `HiddenRings` filters on y only (`:1482`).
   - Fix: filter on x and y first, then count.
4. **bug (likely): text clipped at the viewBox edges.**
   - RayMarch note: `x = fx(s.km) - 64`, `anchor="end"`, size 17 (`:371-383`). For summit A, fx(11) - 64 = 140 units, while "Rotstock: needs an eye ≥ … m" is about 200 units wide, so it clips at the left.
   - RealOcclusion note: `x = x(worst.az) + 74 = 464` (`:1635-1643`). "Kleines Wannenhorn: 2.17° under the skyline" is about 290 units wide, so it runs past W = 640 and clips at the right.
   - Fix: flip the anchor near the edges, or clamp x to [8, W-8] with the anchor chosen by side.
5. **bug: wrong figure reference.** Details Steps "Project, rank, space out" says "Fig. 2" (`:2016`). The label-layout schematic is Fig. D2; Fig. 2 is the compare wipe.
6. **bug: loading skeleton uses a stale layout class.** `lg:mr-[calc(-66.667%-16px)]` (`:1503`) belongs to the old grid. The skeleton extends right into the margin and the rail, so the page jumps when the data arrives.
   - Fix: use the same box as the Figure, or no skeleton.

### Accuracy

1. **"whatever the peak" is false.** The Fig. 5 caption says "Each degree of compass error slides every label sideways by {f·tan 1°} px, whatever the peak" (`:1219-1221`). The beat says "Every label moves by the same N px per degree" (`:1845-1849`).
   - The figure itself projects through the real camera, so it contradicts its own caption. At Δψ = 3° on demo-01 the six picked labels move 32, 33, 33, 36, 40 and 47 px. A yaw change moves a point at angle α off-axis by f·[tan(α+Δ) − tan α] ≈ f·Δ·sec²α.
   - Fix: "about N px per degree at the centre, more towards the edges". Keep Δx ≈ f·tan Δψ as the on-axis form.
2. **YawSlide picks only the left half.** `filter((_, i) => i % 3 === 0).slice(0, 6)` on the labelled peaks with y ≥ 150 gives x = 2…517 (`:1198-1204`). The first pick sits at x = 2 on the frame edge.
   - Fix: pick evenly across x, excluding 20 px margins.
3. **Fig. 3 caption geometry.** "would sit 1.5° below the ridge ② 24 km in front of it" (`:950-954`). The ridge is 24 km from the *eye*; the summit is 35 km away, so the ridge is about 10 km in front of the summit.
   - Fix: "below a ridge 24 km out".
4. **Fig. 4 "40 tall summits" is the bake cap.** `build-data.ts` keeps only the 40 tallest hidden peaks (peaks.md, `build-data.ts:246`), so `hid.length` is always 40 and the full count is 924 (`:1529-1532`).
   - Fix: "The 40 tallest hidden summits sit 0.1–2.2° below…".
   - The variable called `worst` is really the summit deepest below the skyline (`:1522`); rename it.
5. **"snapped onto the real ridge" overstates.**
   - The beat says "Each summit is first snapped onto the real ridge" (`:1743`). Details says "The local-max search is the one described on the snapping page" (`:1976`).
   - `viewPeaks` uses its own `localMax`: 60 m, 17 samples, and height only (`peaks.ts:102-119,141`). The direction still comes from the OSM node.
   - The snapping page's search is `terrain.ts:273` `localMax` (150 m), a different function.
   - Fix: "its height is taken from the highest DEM point within 60 m of the node".
6. **150 km vs 120 km.** Numbers says "150 km, farthest summit considered", which matches the code (`:1909`, `peaks.ts:135`). But the same block's counts come from `data-peak.ts` at 120 km (`:1914`). The 1181 / 924 / 257 counts therefore exclude the 120–150 km band.
   - Fix: state both, or rebake at 150 km.
7. **Magenta for the occluding-ridge gap.** Fig. 3 draws the summit-to-skyline gap in `LAYER_STYLE.prior.color` (magenta, which means "phone's guess" everywhere else) (`:971-974`). The note beside it is red.
   - Fix: use `--gb-red` to match the ridge sight line.
8. **Ink for "labelled" is inconsistent.** It is forest in the Fig. 1 readout (`:1450`), `--accent` in the Fig. 6 gallery (`:1885`), and forest dots in Fig. 4. Pick one.
9. **Stale header comment.** "The terrain and the candidate summits are synthetic" (`:71`) now only applies to D1 and D2.

Verified correct (no change needed):
- `apparentElevation` with R_eff = R/(1−0.13).
- 50 m … 150 km range.
- March from 20 m with step max(10, 0.4 % d), stop max(150, 2 % d), tolerance 0.05°.
- `score` weights, verbatim (`peaks.ts:173-183`).
- maxLabels 20, spacing 3 % of width.
- Overpass `natural=peak|volcano`, `name:de` / `name:en` fallback, "1,234.5" and "4000 ft" parsing (`peaks.ts:40-79`).
- demo-01: f 612.1 → 10.7 px/°; median label shift 106 px over 19 labelled peaks; Δyaw 9.29°.
- Grosses Wannenhorn: 3906 m, 34.6 km, θ 3.13° vs ridge 4.63° at 24.1 km; ridge 10 px above it in the photo (218.2 vs 208.4).

### Sizes, design and React

- **design:** `FIG_LABEL` / `FIG_NAME` are tuned for a 720-px column (comment at `:171-175`). The non-bleed RealOcclusion (Fig. 4) renders at about 520 px, giving labels of 8 px and 9.4 px. Either `bleed` Fig. 4 or raise the constants about 1.35×. Phones at 390 px give 6 px.
- **design:** `HiddenSummit` uses crop `[320,120,760,250]` (`:916`) while `REAL_CROP["demo-10"]` is `[320,110,760,250]` (`:1324`). Unify them.
- **design:** RayMarch draws "visible" in `--nb-forest` (`#575e4e`), which reads as ink. The visible/hidden distinction rests on red alone.
- **cleanup:** the comment at `:1340` says "the usePeakData memo", but it is a fetch hook, not a memo.
- **cleanup:** `usePeakData` caches the promise module-wide and swallows errors (`:892-905`). A failed fetch is cached for the session.
- **cleanup:** `RayMarch` and `LabelLayout` re-render every frame through `useTime`. They recompute `scan()` twice and `layout()` per frame and rebuild every `Hachure` band. Memoise `full` on `[eye, sel]`.
- **cleanup:** internal links use `Link` with no `viewTransition={sheetTransition()}` (`:79-89`), against the README A1 rule.

### Prose

- The main path is concise and claim-first.
- The Details "four questions" section (`:1920-1939`) and "What the score rewards" (`:2028-2049`) are fine.
- The "Where it fits" paragraph repeats the related-links rail; it could be cut.

### Size and duplication (2119 lines)

- The synthetic D1/D2 schematics are about 700 lines (`:95-865`). Both live in Details. Consider moving them to `pages/peak/schematics.tsx`.
- Patterns shared with tap-a-peak that belong in the kit:
  - a fetch-and-cache hook (`usePeakData` / `useTapData`), as a generic `useBakedJson<T>(path)`;
  - a labelled slider row (`flex justify-between font-mono text-[11px]` plus `HandRange`, 4 times here);
  - chip buttons;
  - `dl` readout cells (`Cell` in tap-a-peak);
  - the `link()` helper (tap-a-peak has `A()`).

---

## tap-a-peak.tsx

### Regression findings (cluster-C, peaks.md)

| Finding | Status |
|---|---|
| MissBars demoted to Details | **Fixed.** Main-flow Fig. 4 (`:1446`), 5 columns per photo, values in `TYPE.micro`. |
| HeroTaps lines thin, tap rings 6 px | **Fixed.** `CrispLine` 2.4k, rings 10k with a 5k dark under-stroke, and a geo bleed (`:879,924-946,1095`). |
| PinLock caption colour words stale | **Fixed.** The plate is dark again; the caption says "solid cyan… dashed pale line" (`:305`), which matches `LAYER_STYLE.solved` and `PLATE_TEXT` (`:331,342`). |
| PinLock readout "YAWSOLVED" collision | **Fixed.** `flex flex-wrap justify-between gap-x-2` (`:508`). |
| PeakChooser 6-px labels and row wrapping | **Partly fixed.** Labels are now 11.5 units (12.6 px at the bleed width, about 7 px on phones), numbers are `whitespace-nowrap`, and windows use Wash plus hatch (`:609-624,768`). |
| Gallery tiles: 8-px captions, imprint | Imprint fixed (kit). Tiles are still about 160 px in a non-bleed 3-column figure (`:1473-1478`), so labels inside are 3–5 px. |
| Four-step Flow arrows pointing at nothing | Depends on the kit `Flow` (R8); not re-checked here (`:1580`). |

### Bugs

1. **bug (high): label leaders pair the wrong peaks on demo-10, the default photo.**
   - `TapFrame` pairs `step.peaks[i]` with the i-th labelled peak of the *current* bake: `photo?.peaks.filter(p => p.labelled && p.solved)[i]` (`:880-882`).
   - `tap/demo-10.json` was baked against an older `demo-10.json`. It has 22 `labelledNames`, with Breithorn and Ankenbälli each listed twice, while the bake now has 20.
   - From index 8 on, every pair is shifted. At 3 taps (median miss 0.1 px), 12 of 22 leaders run 13–556 working px between unrelated peaks. Only those whose ends sit in the crop are drawn.
   - Affected: Fig. 1 hero (all 4 stages), Fig. 3 on demo-10, and the Trio. demo-01 and demo-09 match.
   - Fix: rebake `scripts/gipfelbuch/data-tap.ts`, and pair by name (or store the solved px in the tap JSON) instead of by index. Also hoist the `filter` out of the map; it is O(n²) per render.
2. **bug (likely): PeakChooser note clipped at the left.** The `HandText` at `x = X(197) - 6 ≈ 162`, `anchor="end"`, size 16 (`:727-729`), reads "B and C are 0.6° apart: the taller one wins". At about 6.4 units per character it is about 270 units wide, so it starts near x = -110. It also overprints the hatched windows.
   - Fix: anchor start at the right of the B/C pair, or put the note under the axis.
3. **bug: PeakChooser claim is false at the default slider position.**
   - The caption says "B and C sit 0.6° apart, so the taller C is offered first" (`:594`).
   - At u = 0.58 the ranking is E (key −0.22), A, F, D, C (4.67), B (4.77). The list shows only the top 4 (`:760`), so neither B nor C is listed.
   - The bonus is on prominence, not height ("taller" is wrong).
   - Fix: "so the more prominent C ranks ahead of B", and either start u where B/C are near a ray or show 6 rows.
4. **bug: MissBar docstring says solid, the drawing is not.** "One solid bar…" (`:1277`), but the bar is a 6-layer Wash at 0.07 plus a hatch at 0.75 (`:1297-1312`), so the value area is still hatch-dominated (R2).
   - Fix: a flat tint (for example `--gb-water` at about 35 %) with an optional hatch on top, or correct the comment.
5. **bug: shell ledger mislabels the catalogue.** "summits in the catalogue" is `peaks.length` (`tafel/sheets.tsx:1675`). That is the bake's stored list: visible plus the 40 tallest hidden, giving 300 / 118 / 218. It is not the catalogue: demo-10 has 1181 named peaks in frame (`peak.json`).
   - Fix: "summits in the bake", or read `peak.json` counts.

### Accuracy

1. **The MissBars caption repeats the overclaim.** "After three taps the median label miss is 0.1 px or less on all three photos" (`:1352-1354`). This holds by construction: the taps sit at the pipeline's solved pixels, and the reference is that same solution. Only the Numbers source line says so (`:1501-1503`).
   - Fix: add "(by construction: exact taps, reference = pipeline pose)" to the caption.
2. **R9 is partly fixed.** `RealTaps` follows `useNotebookPhoto` with a demo-10 fallback (`:967-973`). But Fig. 1, Fig. 2, the Trio, the "Where it fails" beat and Numbers are fixed to demo-10 without saying so on the figure, while the shell ledger follows the picked photo.
   - Fix: add "fixed: demo-10" to the Fig. 1 and Fig. 2 captions. Ideally drive the hero from the followed photo when it is in `TAP_IDS`.
3. **Fig. 3 caption omits a layer.** It does not mention the yellow detected skyline (`layers={["skyline"]}`, `:871`). Readers see an unexplained third line.
4. **MarginNote uses the synthetic field of view.** "12 px of 1000 is about 0.7° of a 57.6° view" (`:1652`) uses the schematic's HFOV. On demo-10 (f ≈ 316 px on an 800-px frame, about 103° wide) the same gate is about 1.2°. Say "on a 58° view" or quote a real one.
5. **Stale header comment.** "The scene below is synthetic and deterministic" (`:68`) now applies only to D1 and D2.

Verified correct (no change needed):
- `nearbyPeaks` window 15°, max 8, bonus min(1, prom/1000·0.5) (`candidates.ts:106-127`).
- `TAP_MAX_PX` 12 (`:167`).
- `solveFromControlPoints`: focal σ 10 %, 100 iterations, level point = half (`control-points.ts:58-127`).
- `solvePins` 50 iterations (`align.ts:967`).
- "Use this" gives a user-confirmed note plus the correction log (`PickerPanel.tsx:16-17,384-411,750`).
- OneTap hand formula, yaw / pitch (hand vs solver):

  | Photo | Yaw | Pitch | dx, dy |
  |---|---|---|---|
  | demo-10 | 121.00 vs 121.11 | −11.99 vs −11.96 | 24 px, 86 px |
  | demo-09 | 116.25 vs 116.33 | — | — |
  | demo-01 | 260.56 vs 260.69 | — | — |

- PinLock prior: 6.5° yaw, 1.4° pitch, lens 558/600 = 7 % short.
- Step-1 focal equals the sensor focal (301 px), as Fig. 2's legend claims.

### Design and React

- **design:** the PinLock dark plate uses fixed hex literals and a raw `<rect>`/`<path>` fill (`:72-78,315-335`). This goes against the README "Literals" and "no closed rect" rules for an off-photo drawing. It is defensible as a photo stand-in, but say so in the README exceptions, or move it to paper with ink and red.
- **design:** PeakChooser uses a raw `<input type="range">` (`:742-752`); every other slider uses `HandRange`.
- **design:** the Fig. 5 gallery (`:1473`) is non-bleed with 3 columns. With 700-unit crops at about 160 px, tap names and rings are 3 px.
  - Fix: `cols={1}` with a tighter skyline-band crop, or bleed.
- **design:** the RealTaps `dl` puts 8 cells in `sm:grid-cols-5` (`:1014`), which leaves a ragged 5 + 3. Use 4 columns.
- **cleanup:** PinLock re-implements projection and a small LM (`:108-208`, about 100 lines). `#/lib/geo/camera` (`cameraFromAngles`, `project`, `directionENU`; peak.tsx already uses it) and `solveFromControlPoints` are pure, so the schematic could call the real solver. "Same unlock ladder" would then hold by construction.
- **cleanup:** the chip class string is duplicated verbatim (`:477-481` and `:1002`). Extract a kit `Chip`.
- **cleanup:** the OneTap label size `(13 * (ONE_CROP[2] - ONE_CROP[0])) / 720` is repeated 4 times (`:1173,1216,1224,1233`). Hoist it to a constant.
- **cleanup:** `useTapData` is called for demo-10 by `Page`, `HeroTaps`, `OneTap`, `TrioFrame` ×3 and `MissBars`. The cache dedupes the fetches, but each instance flashes `null` (`setD(null)` at `:816`) on mount.
- **cleanup:** `A()` links have no `viewTransition` (`:1392-1400`).

### Prose

- The main path is tight. The "Where it fails" beat is good, and its first-guess margin note works.
- Details: the "Which summit did you mean?" paragraph (`:1552-1563`) and the re-ranking paragraph (`:1573-1578`) are dense, about 70 words each. Each could lose a sentence.
- The MarginNote "I notice the hard part is the name, not the maths" (`:1561`) repeats the sentence right before it. Cut it, or make it a doubt.

### Size and duplication (1677 lines)

- The synthetic D1 (PinLock, about 300 lines) and D2 (PeakChooser, about 230 lines) live only in Details.
- Calling the real solver (above) and kit `Chip` / `LabelledRange` / `Readout` would cut roughly 250 lines.
- `TapFrame` is a good reusable piece: a real photo with prior→solved leaders. Apart from the pairing bug, it overlaps peak.tsx's YawSlide leader drawing and could become a kit `LabelShift` overlay.
