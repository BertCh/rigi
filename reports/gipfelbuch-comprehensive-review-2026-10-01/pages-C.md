# Gipfelbuch review C: viewport-inference, pose-estimate, eye-rule, accept-rule, baseline-pipeline, step-inside

Read-only review, 2026-10-01. Nothing rendered. Every number below was checked against `public/demo/gipfelbuch/*.json` (index.json, demo-NN.json, eye-rule.json, step-inside/split.json) or the cited report or code. Paths are relative to the repo root. Line numbers are for the tree at review time.

Severity: **bug** (wrong on screen, or broken), **accuracy** (a claim that does not match code, data or reports), **design** (legibility or encoding), **cleanup** (code health or size).

## Kit state that affects all six pages (re-checked)

- R1 is fixed in the kit. `Figure` now spans the wide track (`viz/Figure.tsx:84-87`, `lg:mr-[calc(-66.667%-16px)]`, and `bleed` also takes cols 1-2).
- R3 is fixed for `Numbers` (`explain.tsx:525-528`: auto-fit 150 px, nowrap, `clamp(26px,14cqi,40px)`). `Stat` is only half fixed (`Section.tsx:104-113`): its values are nowrap now, so they no longer wrap mid-number, but in a 4-up grid inside the 518 px prose column (for example in `Details`) a long value overflows sideways into its neighbour instead. See the per-page items.
- R6 (imprint) is fixed: it is off by default (`real.tsx:426`).
- R8 `Flow` is fixed: below 560 px of container width it becomes a vertical list (`Steps.tsx:31-32`).
- R1 trade-off. Several pages now tune their SVG label constants to the wide track: eye-rule `SIDE_LABEL = 8`, `OFFSETS_LABEL = 9.5` (`eye-rule.tsx:206-210`) and accept-rule `LABEL = 10` (`accept-rule.tsx:976-978`). At the 390 px width that README:233 requires, these render at 5-6 px. Fix: a kit floor, for example a `useRenderedScale()` hook or a CSS `font-size: max(11px, …)` on `HandLabel`, or a stacked narrow layout. The constants alone cannot serve both widths.

---

## 1. viewport-inference.tsx (2399 lines)

### Regression status
- Fixed: Fig. D4 heat map. It is now a 12-step graded contour-brown tint by cost rank, with a legend (`:705-760`, `:795-813`). This settles "hatch encodes": fill encodes here.
  - cleanup: the comment at `:795` says "three steps of the cost scale", but 12 are drawn.
- Fixed: the RealGrid badge is small and in the corner (`:1585-1592`). The stage tabs are filled ink chips (`:1517-1527`). The Trio imprint is off.
- Open (design, R2): the Fig. D6 confidence bars (`:1660-1690`) are an 8-layer wash at 12 % plus a hatch. The accept/reject state is still texture rather than fill.
  - The caption calls demo-12's bar "cross-hatched" (`:1650`), but it is a single-angle paper-coloured hatch over the wash (`:1679-1686`).
  - Fix: a solid `color-mix` tint per verdict, a different tint for refine, and correct the caption.
- Open (design, R2): the Fig. D7 factor bars (`GateBar`, `:1310-1328`) are a 10 % wash with a gap-9 hatch, so a factor of 1.0 still reads as faint texture. Fix: a solid brown tint at about 45 %.
- Open (design, R3): the "What it buys" Stat row (`:1777-1786`) and `MeasuredStats` (`:1730-1752`) are 4-up inside `Details` (the prose column). "4.0° → 0.22°" and "12.5 → 2.4 px" are about 170 px wide at the 26 px clamp floor, in cells of about 110 px, so they overflow into the next cell. Fix: use `Numbers`, or `grid-cols-2`.

### Accuracy
1. **bug/accuracy: three different "median compass error" values for the same 12 photos.**
   - The front `Numbers` and `medYaw` (`:2207-2213`) use accepted photos only: **9.6°**, and skyline gap **12.5 → 2.0 px**.
   - `MeasuredStats` in Details (`:1736-1741`) and the RealGrid footer (`:1631-1635`) use all 12, including the rejected 07 and 11: **7.9°** and **12.5 → 2.4 px**.
   - pose-estimate's Numbers also says 7.9° (`pose-estimate.tsx:1881`, labelled "12 demo photos").
   - Fix: one helper in the kit (accepted only, as the review decided) used by both pages, with the label saying "accepted".
2. **accuracy: the IMG_7053 story is misattributed.**
   - `FullCircle` says "The wild benchmark found this for real: a 360° first pass at the local 0.5 bar accepted IMG_7053 at −123.7°" (`:1153-1156`).
   - IMG_7053 is one of the Niederhorn hand-registered photos. The −123.7° accept comes from the GT-12 **heading-removed ablation** (`reports/bench-ablation.md:332,383-384,435`), not from the 100-photo wild set.
   - The same wrong attribution is in `src/lib/geo/solve.ts:266-268` and `src/lib/geo/README.md` (No compass heading).
   - The figure also writes "IMG_7053: this alias won at the 0.5 bar" on the **synthetic** polar plot (`:1121-1123`), as if the schematic alias were that photo.
   - Fix: "a heading-removed run on the hand-registered set", and move the IMG_7053 note out of the synthetic SVG into the side text.
3. **accuracy: the hero caption states a correction as fact for rejected photos.** `HeroCompare` (`:2083-2085`) says "The phone's compass was X° off here … the map's skyline snaps onto the ridge" for whichever photo is picked. For demo-07 and demo-11 the solve was **rejected**: demo-11's "0.2° off" is the rejected pose. Fix: branch on `d.solved.accepted` ("solver's best guess, rejected").
4. **accuracy:** "0 false accepts on 12 hand-registered photos" (MarginNote `:2292-2295`, Numbers source `:2341`, Legacy `:1789-1795`) holds on Terrarium only.
   - On Mapterhorn, the DEM the app solves on, there is one accept over 1° (IMG_7130, 1.05°; `geo/README.md` DEM table).
   - baseline-pipeline already qualifies this (`baseline-pipeline.tsx:1782,1785`). Make the two pages agree.
5. Verified correct:
   - `solve.ts` defaults: yawRange 25, pitchRange 3, trunc 12 px, sigma 15/1.5/1.5/0.06, ≤3 seeds > 1.5°, Cauchy 4 px, tilt 3°, 0.5 and 0.75.
   - The confidence product (`solve.ts:530-535`).
   - The skyline mechanism (`geo/skyline.ts` header), the horizon (0.05° step, curvature and refraction) and the 2¹³ FFT ring (`refine/init.ts:72`).
   - The five `SCENES` verdicts recompute correctly.
   - The RealGate caption's 0.46, 0.44 and 0.56 match index.json.
   - All CodeRef paths exist.

### Bugs and design
- design: `CameraTable` heads "phone" in `--gb-red` and "solved" in `--gb-water` (`:2131-2136`). The figure directly above keys the phone as magenta `#e0207f` and solved as cyan `#0aa5bd` (`LAYER_STYLE`, `real.tsx:247-248`). Use `PRIOR_C` and `SOLVED_C`. The table also uses `border-t` and font-mono where `.gb-table` exists (README:129).
- design: two 12-tile galleries of the same verdicts: front Fig. 2 `Verdicts` (`:2253`) and Details Fig. D2 `RealGrid` (`:1544`).
- cleanup: the header comments still say "Fig. 3", "Fig. 4" and so on (`:345`, `:600`, `:984`, `:1170`), while the labels are D3-D7.

### Prose
- Good. Beats follow the explainer recipe, and the one equation (`:2153-2174`) is honest: the Details note says ρ is truncated L1 on the grid and Cauchy in the polish.

---

## 2. pose-estimate.tsx (2023 lines)

### Regression status
- Fixed: the Fig. D2 chart (red prior, navy solved, hollow for rejected, in-chart legend; `:1087-1120`, `:1158-1186`). The Details Fig. D1 photo now sits above the table at full width (`:970`). DofLadder rows have a forest tint when solved (`:741-747`). The ProvenanceCard selected state is an ink fill (`:874-886`). The Stat row is now inside the wide Figure.
- Open (design): the PoseExplorer buttons are 11 px font-mono on paper-deep (`:557-570`), which reads as a caption, not a button.

### Accuracy
1. **bug: the hero prose is hard-coded for demo-01 but follows the picker.**
   - `HeroPose` takes the page photo (`:1472-1473`), but the caption says "a slight look down, a small tilt" (`:1504`). The in-photo notes say "pitch X°: the cross sits below the dashes" (`:1612`) and "roll X°: tiny, but the dashes lean" (`:1630`).
   - These are wrong for demo-02, 05 and 08 (pitch +3.7, +2.1, +2.2: the cross is *above*), for demo-09, 06 and 10 (pitch about −12°, not "slight"), and for demo-07 and 08 (roll −6.7 and −5.8, not "tiny").
   - The comment at `:1470` still says "demo-01".
   - Fix: derive the words from the signs and sizes, or label the figure "Fixed: demo-01".
2. **accuracy: "Where it fails" (`:1950-1952`) and Fig. 4 (`:1964-1966`) say a rejected photo keeps "the phone's own" pose.**
   - In the app, a full-metadata photo shows the autoAlign pose whenever its confidence is > 0.2 (`second-opinion.ts:83-91`, `choosePreview`). A cascade reject ends as "kept: app pose, no badge" or "unverified", not the phone prior.
   - The baked data agrees: `d.app` for demo-07 and demo-11 is `source: "solved"`, conf 0.67 and 0.84.
   - accept-rule even says so: "Rejected is not the same as wrong" (`accept-rule.tsx:401-405`).
   - Fix: "the pose is shown unverified (not as certain)".
3. **accuracy:** ProvenanceCard says "Only 'auto' counts as accepted" (`:889-891`).
   - The ontology says autoAlign's > 0.2 is "never HIGH alone" (`ontology/core/confidence.ts:41-42`).
   - `isAutoHigh` and `poseAccepted` make "auto" accepted only with a verified, refined or matched second opinion (`picker/candidates.ts:216-225`, `nearfield/controller.ts:74-85`).
   - Fix: "auto is shown; it counts as accepted only once the second opinion verifies it."
4. **accuracy:** the median compass error of 7.9° in Numbers (`:1881`, `:1992-1994`) includes the two rejected solves. viewport-inference says 9.6° (accepted only). See VI-1.
5. design: HeroPose draws the solved camera's level horizon in `LAYER_STYLE.prior.color` (magenta, `:1550`). On the same page magenta means "phone" (Fig. 2 and 3 keys). MarkList item 2 says "the dashed line is a level horizon", but there are two dashed lines (light `:1528-1535` and magenta `:1546-1553`). Fix: one neutral colour for the horizon, and name each line.
6. Verified correct:
   - `poseBasis` matches `camera/index.ts:22-40`.
   - The DOF ladder rules match `pose6dof/README.md:44-62`.
   - The priors (2°, 10°, 3 %, `max(hAcc, 5)`) and the synthetic numbers (99.3 %, 0.008°, 1.1 m vs 17 m, 7e-15, 1e-12) match README:127-140, labelled synthetic.
   - `choosePreview` 0.2 and 4°/1.5° match `second-opinion.ts:77,87`.
   - The saved-vs-fresh yaw agreement (≤ 0.4° on 11, 1.2° on demo-11) matches the data.
   - `pose.ts` (three adapter) still exists and is imported, so the CodeRef is valid.
   - Fig. 2 and Fig. 4 are labelled "Fixed: demo-09/07/11" (R9 done).

### Cleanup
- `skyBand` (`:906-916`) is a byte-for-byte copy of viewport-inference `:1446-1456`. Use the kit `skylineBand`.
- `PoseExplorer`'s header comment says "Fig. 1 — hero" (`:203`), but its label is D3.
- `LINE_LIGHT = "#f4efe4"` (`:1462`) is a literal colour on a photo. That is allowed, but `CrispLine` in the kit (`real.tsx`) is the shared photo-overlay stroke.

---

## 3. eye-rule.tsx (1513 lines)

### Regression status
- **Fixed: the old Fig. 4 overprint** (now Details "D1", `Hero`).
  - The two eye labels sit on opposite sides of the fix: "max rule" is anchored at its end, left of the fix (`:364-372`). "contour MAP" goes right and above when `mapX ≥ 0`, or left and 19 units below otherwise (`:431-440`).
  - I checked the geometry: the ground rises to the right, so a contour eye above the floor eye always has `mapX > 0` and goes right. The left case is always below. The labels cannot meet.
- Fixed: the Fig. 1 side view and photo are stacked (`:1184-1190`, `SideView` then `RealPhoto bleed`).
- Fixed: the Fig. 3 sign colours (navy left / red right, `:856`, with header keys at `:815-826`).
- Fixed: the Fig. 2 colours are sign-yellow for Terrarium and forest for Mapterhorn (`:553-554`).
- Fixed: the "Fixed: demo-09" caveat for R9 (`:1199`).
- Open (design): the Fig. 2 and Fig. 1 label constants are sized for a track of about 960 px (`:206-210`). They come out at about 5 px on a phone. See the kit note.

### Bugs
1. **bug: a stale figure reference.** The Details prose says "0.2 m is about 6 px … (Fig. 5)" (`:1475`), but the drift plot is labelled **D2** (`:963`).
2. **accuracy: `engine.ts` no longer exists.** The header comment (`:55`) and the Known-drift callout ("`engine.ts` (`eyeAltitude`)", `:1480`) name it. `eyeAltitude` lives in `src/lib/deck/scene.ts:59`, and the CodeRef below already points there (`:1505`). Fix the prose.
3. bug (minor): the Readout sub-line builds "max rule is -3.2 m too low" when `err < 0` (`:504-506`), a double negative. Fix: `max rule is ${abs} m too low`.
4. bug (fragile): `HeroStages` reads Mapterhorn demo-09 as `eyeData.mapterhorn[8]` (`:1181-1183`), by array index. Use `.find((r) => r.id === "demo-09")`, as `EyeEquation` does (`:1235`).
5. cleanup/perf: `useEyeData` has no cache and runs in 5 components (`HeroStages`, `EyeEquation`, `RealOffsets`, `RealContour`, `Page`), so `eye-rule.json` is fetched 5 times. baseline-pipeline's `usePoseSolve` (`baseline-pipeline.tsx:1819-1838`) has the module-cache pattern.
6. cleanup: the local `median` returns the upper middle for even lengths (`:548-551`). It is only used on odd sets today, but it differs from the other pages' helper.

### Accuracy (verified)
- From eye-rule.json:
  - drop counts: 11/12 on Mapterhorn, 1/12 on Terrarium;
  - demo-09: 1183 m, 730 m under Terrarium and 750 m under Mapterhorn;
  - photo 09 is the only contour fallback.
- `EYE_PRIOR_DEFAULTS` (σA 3, altBias −7, "9 of the 10 DEV photos Swiss, 4 days") matches `concord/priors/altitude.ts:66-88`.
- The 1.6 vs 1.8 drift matches `geo/pipeline.ts:23,49`, `deck/scene.ts:59` and `roll/mosaic/ridgelines.worker.ts:112-113`.

### Prose
- `:1443-1446`: "…would look like a 50 m altitude error. On the twelve Niederhorn fixes it does against Mapterhorn but not Terrarium (Fig. 2), so the photographer most likely stood where …". "It does" has no clear subject. Rewrite as, for example: "On the twelve Niederhorn fixes the altitude sits within a few metres of Mapterhorn ground (median −10 m) but 30-70 m above Terrarium's (Fig. 2)."

---

## 4. accept-rule.tsx (2012 lines)

### Regression status
- Fixed: the gates table now stacks below 640 px with a `break-all` chip (`:1424-1445`).
- Fixed: the ScoreFit 27 px / 2 px callouts are back (`spots`, `Mark`, `MarkList`; `:1645-1681`, `:1747-1775`).
- Fixed: the Trio uses `sm:grid-cols-2` (`:1915`). Figure numbers run 1-5 in order, and the "(Fig. 5)" reference in Details is right (`:1408`).
- Fixed on desktop: the VerdictTree labels are larger (`LABEL = 10`, `:978`). Open on phone (design): about 6 px at 390 px, and no stacked layout.
- **Open (design, R2): the Fig. 2 bars and the factor bars are still texture.**
  - `Bar` is a 10 % wash with a 0.14 ink hatch (`:223-238`). `HandBar` is a wash at about 9 % with a hatch (`:172-187`).
  - The comments claim "Solid ink fills" and "A solid bar" (`:120`, `:128`), but `INK_FILL` is only used for the selection `boxShadow` (`:249`).
  - Fix: `fill` = `INK_FILL[...]` at 70-85 %, with the hatch on top.
- Open (design, low): under reduced motion `useTime(0)` freezes PrecisionLadder on rule 1 (the app aligner, the worst rule; `:722-724`) and the VerdictTree on scenario 1. The final state (the product rule) would carry the point.

### Accuracy
1. **accuracy: "only these two ever show as certain" (verified, matched) is wrong.** It appears in the VerdictTree note (`:1305-1307`) and the caption (`:1111`, "Only matched and verified poses are shown as certain").
   - "refined" is HIGH too:
     - `isAutoHigh` accepts `verify === "refined"` (`picker/candidates.ts:223`);
     - `poseAccepted` admits it (`nearfield/controller.ts:83`);
     - the pose crosswalk promotes refined to accepted (`ontology/crosswalk/pose.ts:254-266`).
   - Fix: three outcomes, and circle `refined` in forest.
2. **accuracy: wrong file paths in the gates table.**
   - `YAW_UNKNOWN / FOCAL_UNKNOWN 0.75` is cited to `unknown-pose.worker.ts` (`:1329-1333`, and the header `:64`). The constants are in `src/lib/integration/unknown-pose-core.ts:40,47`.
   - `MATCH_AGREE_DEG 0.5°` is cited to `second-opinion.ts` (`:1344-1348`). It is in `src/lib/matcher-client.ts:137`.
3. **accuracy: the current-rule status is incomplete.**
   - The page quotes only the 100-photo dev numbers: 20/20 product rule, 30 vs 20. These match `bench-wild.md:69,165`.
   - It omits the pre-registered **held-out test** (`reports/test-results.md`): product rule 11/11 on the current service (arm A) and 15/17 with 2 unsure (arm B), 0 gross. `matcher-client.ts:139-145` cites this.
   - It also omits that the looser rule `HIGH ∧ (EXIF ∨ basinGap ≥ 0.20)` met its bar on test but is **not** what `matchAccepted` implements.
   - Fix: add one Numbers item or a sentence, for example "held-out test: 11/11, 0 gross", and one sentence on the looser rule's status.
4. **bug: stale colour words.**
   - Fig. 2 caption (`:280-282`): "amber: rejected by solvePose, rescued by refinePose". The rescued bar is drawn with `Wash color="brown"` (`:204`, `:225`), which is `--nb-brown`, contour brown. The legend's "amber" is `--gb-sign`, used only in the unused `INK_FILL.brown`. The accepted colour (water blue) is never named.
   - Fig. 5 caption (`:731`): "Accent dots are correct accepts". They are forest `HandDot`s (`:707-713`).
5. **accuracy:** the ladder labels "Cascade ≥ 0.75" (`:641-647`) read as a global bar. In `bench-wild.md:74` the 0.75 is "the app's yaw-unknown gate", applied to yaw-unknown photos; heading-known photos keep 0.5. Rename to "Cascade, 0.75 when yaw unknown".
6. **prose/accuracy:** "Each dot below is one of 100 photos with a known right answer" (`:1956-1958`).
   - The dots are **accepted poses** under each rule (60, 27, 22, 31 and 20 dots), not 100 photos.
   - Correctness is blind-verified, not "known".
   - The first thing "below" is Fig. 4 (the 12 demo photos), not the ladder.
7. accuracy (minor): the Beat title "Four checks multiply into one score" and MarginNote b (`:1880-1890`) disagree with the equation directly below (`:1777-1808`), which has the tilt gate plus four factors. viewport-inference says "five clamped factors" (`viewport-inference.tsx:1358`). Say "four checks and a tilt gate".
8. accuracy (minor): the Fig. 2 caption says the solve is "at the app's local bar of 0.5" (`:278-279`). demo-12's stored solve record is the **full** search (`search: "full"`, bar 0.75). The 0.29 product is that search's.
9. Verified correct:
   - `solveFactors` (`:76-103`) matches `solve.ts:530-535`.
   - 39/19/2 and 0.64, 25/2, 22/0, 30/1 and 20/0 match `bench-wild.md`.
   - Fig. 3: 14 registered rows; worst accepted 0.47°; rejected 6.78° and 19.76°; IMG_7063 at 0.48 (index.json).
   - `MIN_CONFIDENCE`, `DEDUPE_DEG`, `TAP_MAX_PX`, `minRmsSlope 0.015`, `AGREE_DEG 1` and `CASCADE_TIMEOUT_MS` match the code.

### R9 and hard-wired photos
- `ScoreFit` and `RealDecisions` default to local state `"demo-11"` (`:1634`, `:268`) and ignore the page photo (`useNotebookPhoto`). The other five pages follow it.
- `TwoSolvers` is hard-wired to demo-01 (`:1597`) and prints "within 1°: keep it" whatever the values are. Label it "demo-01", or compute the verdict.

---

## 5. baseline-pipeline.tsx (2323 lines)

### Regression status
- **Fixed: the Conveyor `min-w-[620px]` clipping.** There is no min-width now. Below 560 px of container width a vertical `<ol>` replaces the SVG (`:255-307`). The legend overlap ("wi●sreject") is gone: keys at x 6 and 290 (`:430-438`).
- **New bug: the escalation-lane label runs off the right edge.** "FFT yaw ring · robust IRLS · 0.4–1.3 s measured" starts at x ≈ 443 (`translate(px(3))` + 2, `:388`, `:402-404`), at size 13. That is about 46 characters, ending near x ≈ 770 in a 720-wide viewBox, so it is clipped. Fix: two lines, or start the lane at `px(2)`.
- Fixed: the AllTwelve bars are solid 4 px PenLines in red and navy (`:1312-1339`), and rows have a hover background.
- Partly fixed (R2):
  - `TimeBar` (`:1061-1079`) has distinct stage colours and an in-bar "horizon 93 %" label, but is still drawn as a gap-1.8 hatch with paper-coloured text on the hatch. Use a solid fill under the label.
  - Variants (`:932-939`) and GroundTruthEval cells (`:1420-1439`) use dense hatch as a fill. That is acceptable, but a solid tint would be simpler.
- Open (design): YawSearch's "typical yaw X px" label (`:1918-1926`) can sit on the curve near the right end. The wording is also wrong: it is the **median cost**, not a yaw. Rename it to "typical cost".

### Accuracy
1. **accuracy: stale stage timings that contradict the page's own data.** The medians from index.json (12 demo photos) are horizon **4.30 s**, skyline **161 ms** and solve **97 ms**.
   - The Conveyor STAGES say "4.7 s classic", "150 ms" and "95 ms" (`:116`, `:122`, `:128`), and its caption claims they are "median over the 12 demo photos" (`:253`).
   - Deep step 3 says "the classic ray-march took 3.9 to 8.1 s per photo … (Fig. D3)" (`:1513-1514`). The measured range is 3.87-5.53 s, so 8.1 is wrong, and Fig. D3 shows totals ≤ 5.7 s.
   - Deep step 4 says "116 to 464 ms … (median 150 ms)" (`:1524-1525`). The measured range is 111-255 ms and the median is 161 ms.
   - `PipelineNumbers` (`:1777-1778`) computes 4.3 s, so the page contradicts itself.
   - Fix: compute all of these from `idx` (as `PipelineNumbers` does), or drop "median over the 12 demo photos" from the Conveyor caption.
2. accuracy (minor): the CascadeFlow caption mixes sources. It routes the **README's 12 GT photos** but quotes the **demo photos'** solve times ("0.02 to 0.15 s", `:735`). It also states "Zero false accepts" without the Mapterhorn caveat that `PipelineNumbers` (`:1785`) gives. The Deep Stat "0 false accepts" (`:1583`) has the same gap.
3. accuracy (minor): the YawSearch `Eq` (`:2161-2198`) omits the prior term `0.02·τ·((Δψ/σψ)²+(Δφ/σφ)²)`. The plotted curve comes from `coarseCost` (via `data-pose-solve.ts`), which includes it. Add "+ a weak pull toward the compass" to the legend.
4. design: the YawSearch colour keys disagree with the photo overlay.
   - "compass guess" is `SWISS.red` on the button and in the plot (`:1881`, `:2122`), but the photo draws `prior` in magenta `#e0207f`.
   - "best fit" is `--gb-water` (`#30626b`), but the photo draws `solved` in cyan `#0aa5bd`.
   - Use `LAYER_STYLE` colours for both.
5. GroundTruthEval caption (`:1380-1388`): "The hand-registered benchmark … 19 photos". 5 of the 19 have `gtQuality: "none"`. "that is in the table below" points at Fig. D6, which is a bar figure, not a table.
6. Verified correct:
   - the Trio claims (demo-03 at 0.87, demo-12 rescued, demo-07 rejected);
   - Fig. 3 is labelled "Fixed: demo-11 and demo-12";
   - `cascade` and `pickFull` match `solve.ts:240-271`;
   - `geo/README.md` variant numbers (8/12, 9/12, 11/12, 0.27°/6.7 px, …);
   - the wild cascade "22 accepts, all correct" (`geo/README.md`, `bench-wild.md:74`).

### Cleanup
- The constant names lie:
  - `YELLOW = "var(--gb-contour)"` and `CYAN = "var(--gb-water)"` (`:975-976`): after the reskin YELLOW is brown and CYAN is teal.
  - `PAPER = SWISS.ink` (`:77`) is ink.
- `PipelineNumbers.med` hard-codes `(s[5]+s[6])/2` (`:1762-1765`), which assumes exactly 12 photos.
- Three crop helpers (`band` `:980`, `ridgeCrop` `:1721`, `OutcomeMini`'s inline transform `:1744-1752`) duplicate the kit's `skylineBand`.
- `CASCADE_LABEL` and `YAW_LABEL` comments (`:725`, `:1842`) still say "rendered at the text column (~720 px)". The figure track is now wider.

---

## 6. step-inside.tsx (2010 lines)

### Regression status
- **Fixed (R5):** `RealRange` is back in the body as Fig. 3, right after `RealSplit` (`:1683`, `:1701`).
- Fixed: both two-column grids now break at `lg:` (`:822`, `:1557`).
- Fixed: the Truth legend uses the real `PROVENANCE_COLORS` (`:695-737`).
- Fixed: `MiniSplit` follows the page photo (`:1628-1636`), and the imprint is off.

### Bugs
1. **bug: stale figure references in Details.** The Details figures were renamed D1-D3, but the prose still says:
   - "Compare anchored range with DEM range (Fig. 1)" (`:1853`): the ruler is **D1**, and Fig. 1 is the hero;
   - "a confidence radius … (Fig. 2)" (`:1880`): it is **D2**;
   - "The Truth toggle … (Fig. 3)" (`:1894`): it is **D3**, and Fig. 3 is RealRange;
   - "the rule of Fig. 1" (`:1970`) and "the disc of Fig. 2" (`:1979`).
2. **bug: stale colour words and keys.**
   - Fig. 4 caption: "White tick: the eye height we use" (`:1001-1002`). The tick is drawn `color="ink"` (`:1074-1080`).
   - The hero stage-3 key "near things become 3D" uses `var(--accent)` (`:1309`), but the bar draws near rows in `--nb-forest` (`:1243-1245`).
   - The RealSplit key "Left to the terrain" uses `DEM_C` (`--nb-brown`, `:1549`), but `split.png` paints Far in provenance orange `[230,159,0]` (`scripts/gipfelbuch/data-step-inside.ts:72`).
   - The D1 caption calls the model dot "the accent dot" (`:173`). It is coloured by class (`CLS_COLOR`, `:97-102`).
3. accuracy (minor): the D-section Stat says "1M runs at about 35-45 fps" (`:1923`). In `step-inside-results.md:28` that is three.js's figure (deck is about 38 fps), and three has been removed. The "2 renderers … three.js has since been removed" Stat (`:1924-1928`) is an odd headline now. Say "WebGPU and WebGL2 deck share one near DEM", or drop it.
4. cleanup: `RealSplit` reads the curve point by index, `d.anchor.curve.x[3]` (`:1569-1570`), for "133 m vs 1338 m". Name the point in `split.json`.
5. cleanup: `RealEye` (`:970-980`) and `useSplitData` (`:1346-1359`) each hand-roll a fetch hook. Use a shared `useGipfelbuchJson`.
6. R9: `RealRange` silently falls back to demo-03 when the picked photo is not one of its four (`:770-773`). Say "baked for 01/02/03/06; showing 03".

### Accuracy (verified)
- These match the code:
  - `classify` = `classifyRange` order;
  - `STEP_SPLIT` 0.5 / 150 m / 3 m (`controller.ts:55-58`);
  - `confidenceRadiusFrom` (`scene.ts:100-103`);
  - the 0.15 and 0.35 gates (`controller.ts:48`);
  - `poseAccepted` (`controller.ts:74-85`);
  - tint mix 0.65.
- 15 % vs 80 % and 200k at 60 fps match `step-inside-results.md:11,28`. "GPS eye errors 7–37 m" is finding 7 (`:44`).
- `split.json`: object 15.5 % and far 51.8 % of non-sky pixels; quality 0.347; n 3139.

---

## Size and duplication: what the kit could absorb

Each file is 1500-2400 lines because the old full page sits behind `<Details>` (`Legacy` / `Deep`). That old page repeats the front's real-data figures in an older form.

| page | front (explainer) | Details-only code |
|---|---|---|
| viewport-inference | about 430 lines (`:1966-2399`) | about 1960 lines |
| pose-estimate | about 565 lines (`:1457-2023`) | about 1450 lines |
| accept-rule | about 480 lines (`:1534-2012`) | about 1530 lines |
| baseline-pipeline | about 700 lines (`:1630-2323`) | about 1630 lines |
| step-inside | about 1270 lines | about 740 lines (SplitRuler, ConfidenceDisc, Provenance, RealCompression) |
| eye-rule | about 1100 lines | about 400 lines (Hero, DriftPlot) |

Candidates to share:

1. **Crop helpers:** `skyBand` (VI `:1446`, PE `:906`, identical), `band` (BP `:980`), `ridgeCrop` (BP `:1721`) and `bandCrop` (AR `:108`). Use kit `skylineBand(d, minH)`, with a `maxRatio` option if one is needed.
2. **Format and maths helpers:**
   - `median` / `medianOf` is in 6 files, with two semantics;
   - `sgn` / `fmt` (VI, PE, BP), `clamp01` (VI, AR, BP), `rectPath` / `rectD`;
   - add a kit `viz/format.ts`, plus an `acceptedPhotos(idx)` helper so the "median compass error" rule is defined once (see VI-1).
3. **`Slider`** (a label plus value over `HandRange`) is re-implemented 4 times (VI `:550`, PE `:170`, ER `:129`, SI `:399`). Add a `LabeledRange` to `viz/labels.tsx`.
4. **Value bars:** `GateBar` (VI `:1280`) and `HandBar` / `Bar` (AR `:129`, `:194`) are both clip-path hand bars with wash plus hatch. Use one kit `ValueBar` with a solid tint and optional hatch, which fixes R2 in one place.
5. **Verdict gallery:** viewport-inference `Verdicts` (`:2253`) and accept-rule `Verdicts` (`:1550`) are the same 12-tile `Gallery` with skyline plus solved and a result/failure tone, and VI's Details adds a third (`RealGrid`). Use a kit `VerdictGallery({label})`.
6. **JSON hooks:** `useEyeData` (ER), `useSplitData` and the RealEye inline fetch (SI), and `usePoseSolve` (BP, the only one with a cache). Use a kit `useGipfelbuchJson<T>(path)` with a module cache. This also removes eye-rule's 5 duplicate fetches.
7. **Concept links:** `A` / `link` (VI, BP, SI, PE) and the accept-rule inline `Link`s. Use a kit `ConceptLink`.
8. **Split Details out:** move `Legacy` / `Deep` into `pages/<id>.details.tsx` and lazy-load them on `<details>` open. Delete the Details figures that now duplicate a front figure on the same photo:
   - VI `RealStory` ≈ `HeroCompare` plus Trio;
   - VI `RealGrid` ≈ `Verdicts`;
   - PE `RealPose` ≈ `HeroPose` plus `Tag`;
   - BP `MeasuredOnePhoto` ≈ `HeroStages`.
9. **Hand-pass rule drift:** the pages use `font-mono` for readouts 9-17 times each (VI 17, BP 17, PE 15, AR 11, SI 9, ER 4). README:10-17 and 161 say print is only for code and equations. Numbers should use `gb-num` / `nb-num`. A lint rule in `gipfelbuch.check.ts` would catch it.
