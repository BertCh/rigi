# Audit B: skyline, dem-horizon, pose-estimate, baseline-pipeline

Shots are in `.../scratchpad/shots/` (`<page>-old-NN.png` / `<page>-new-NN.png`). New files are `src/lib/gipfelbuch/pages/<id>.tsx`; old files are `HEAD:src/lib/atlas/pages/<id>.tsx`.

Overall verdict: on all four pages nothing was removed outright. Every figure, picker, stepper, slider and Details block from HEAD is still present and still works. The new Gipfelbuch hero band (real photo, terrain ridges either side, labelled peaks, a 12-photo picker, three big numbers) is a clear gain.

The losses are almost all fidelity, and they come from four shared causes:
1. A kit CSS specificity bug that makes selected chips unreadable.
2. `Stat` numerals that are far too big for the narrow column.
3. The hatch/Hachure fill replacing solid fills for every bar and area, so quantities no longer read.
4. Fixed-width SVGs (`min-w-[620px]`, bleed figures) now wider than the 518 px column.

## Cross-cutting root causes (they drive findings on all four pages)

**X1. Selected tab/chip text is unreadable (HIGH).**
- This is the cause of the skyline Fig 3 "red on red" chip, and it hits every pill group in these pages.
- The pages style the selected tab as `bg-[var(--accent)] text-[var(--rigi-ink)]`, plus `${TYPE.micro}`.
- `TYPE.micro` is `"text-[11px] leading-[12px] gb-coord"` (`src/components/gipfelbuch/swiss/type.ts:15`).
- `.gb-swiss .gb-coord { color: var(--gb-secondary) }` (`swiss/theme.css:100-107`) is unlayered, so it beats the Tailwind utility `text-[var(--rigi-ink)]`.
- The selected label therefore renders slate `#4a545c` on `--accent` (domain red `#bf2233` on Evidence pages; ConceptPage.tsx:116 sets `--accent` to the domain colour). Contrast is about 1.5:1.
- Seen at skyline-new-02 (Fig 3 "Cost volume" chip, ~y 565), skyline-new-04 (Fig 5 "raw primary", ~y 126), and the same pattern in the dem-horizon "curvature + refraction on" toggle.
- Sites: skyline.tsx:648 and 878; the equivalent selected-chip classes in dem-horizon.tsx and baseline-pipeline.tsx (YawSearch tabs).
- Fix, one place for all pages: add to theme.css
  `.gb-swiss [role="tab"][aria-selected="true"], .gb-swiss .gb-chip-on { color: var(--gb-paper); background: var(--gb-ink); }`
  (or `var(--accent)` with `--gb-paper` text), or drop `gb-coord` from `TYPE.micro` on buttons.
- Better aesthetic fix: no filled red chip at all. Use the existing PhotoPicker/tab style (ink text, red hand-drawn underline), which is already used for "BL.01 PHOTO".

**X2. `Stat` is too large for the narrow column (HIGH on pose-estimate, MED on others).**
- `TYPE.stat` is `text-[40px] sm:text-[56px]` light weight (type.ts:26). It is used in `grid-cols-2 sm:grid-cols-4` groups inside a 518 px column.
- Ranges and units break mid-value or overflow:
  - pose-estimate-new-04 (Fig 2 tiles): "10 / 12" breaks over three lines, "0.9–7.7 px" and "5–43 px" overflow into each other, and "0.44–1.00" runs off the right edge (x≈870).
  - pose-estimate-new-06: "99.3 %" and "0.008° / 1.1 m" are stacked and jostle.
  - skyline-new-03: "161 ms" and "39 / 60" are broken.
  - baseline-pipeline-new-02 ("10 / 12") and new-06 (11 / 12).
  - dem-horizon-new-03 survives only because its values are short.
- The old tile was `text-[2.2rem]` bold, accent coloured, in a 712 px column.
- Fix in `viz/Section.tsx:41`:
  - Use a container-query size: `text-[clamp(26px,5.2cqw,40px)] leading-none whitespace-nowrap`, with `[container-type:inline-size]` on the grid cell.
  - Wrap the unit in a smaller span (`<span class="text-[0.55em]">px</span>`).
  - Use `grid-cols-2` below the 4-up threshold.
  - Drop the little triangle glyph, or place it in the label line, because it eats about 16 px of the numeral line.
- Keep the new light weight and ink colour.

**X3. Hatched fills replace solid fills (MED, systematic).**
- Every bar and area that used to be a solid colour is now a one-stroke `Hachure` with gap 3.5-5. At figure widths of 500 px the bars read as thin diagonal scribble.
- Quantities (width of a bar, which colour is which) become hard to compare.
- Where it hurts:
  - baseline timing bar (`TimeBar` and hero strip, baseline-pipeline-new-01 at y≈178 and new-03 at y≈903). The old four-colour segmented bar (blue 4.4 s, yellow 255 ms, cyan 117 ms) is now a uniform navy-hatched strip. You cannot see that horizon is 93 % of the time, which was the figure's whole point ("The map step is most of it").
  - baseline Fig 3 variants (new-06 y≈460-630) and Fig B before/after bars (new-05 y≈285-690). The magenta/cyan bar pairs are now tiny hatch marks.
  - baseline Fig C photo pills (new-05 y≈1200-1350). The old half-filled capsule (left half = solve, right half = cascade, filled if accepted) is a hatched square. Accepted vs rejected is no longer distinguishable.
  - dem-horizon Fig 3 "in the photo" band and the profile fill; skyline Fig 2 weight strip (old: filled olive area plus `weight 1.0` line; new: thin teal line over a light hatch, skyline-new-01 y≈800-825).
- Fix, in the `Hachure` kit or a new `HatchFill` (`swiss/paint.ts`):
  - Draw a flat 35-45 % tint of the ink under the hatch, then the hatch on top.
  - Use dense hatch (gap 2) at small sizes and a 1.5 px solid outline.
  - Bars should be solid ink tints (navy for the solved/after bar, red for the prior/before bar) with hatch only as texture on the large filled areas such as terrain profiles.

**X4. Wide fixed-width SVGs are clipped or scroll inside the narrow column (MED-HIGH).**
- baseline-pipeline.tsx:244: `className="... min-w-[620px]"` inside `overflow-x-auto` (new-03/04). The five-stage Conveyor is 620 px wide in a roughly 540 px figure, so the fifth stage "confidence gate / accept or escalate" and the `refinePose` fork are cut off at the right (shown only as "con", "0.5 loc"). Its legend text also collides with the dots ("first accepting stage wi●sreject").
- dem-horizon Synthetic 1: the "curvature + refraction on" toggle and the right-hand axis `km` label run past the column (dem-horizon-new-04 y≈1345, x≈871).
- Fix:
  - Make the viewBox responsive (re-lay stage positions for a narrow width, or rotate the five stages to a vertical rail below ~620 px).
  - Where a figure really needs the width, wrap the figure in a wider bleed container (`lg:-mx-16`).
  - Add a visible edge fade or scroll hint if horizontal scroll stays.

**X5. Slider tracks (MED/LOW).**
- All `<input type=range>` (skyline.tsx:666, dem-horizon.tsx:561 `HandRange`, pose-estimate.tsx:207 and 833) now render as a 1 px hairline with a small black dot.
- Compare old: thick accent-coloured track with a larger handle. Targets are hard to see and hit, especially on touch.
- Fix: give the track a 3-4 px height in `--gb-line`, fill the elapsed part in `--accent`, and use a 14 px knob with a paper ring.

## skyline

### Regressions
- **HIGH: Fig 3 (Viterbi cost volume) toggle chip is red-on-red unreadable.**
  - See X1 (skyline-new-02 y≈565; code skyline.tsx:640-655, class at :648).
  - Cause confirmed: `gb-coord` colour wins over `text-[var(--rigi-ink)]`.
  - The same bug hits Fig 5's selected chip "raw primary" (skyline-new-04 y≈126; skyline.tsx:870-880).
  - The unselected chips lose their pill shape and read as plain grey text, so the control group looks like loose labels (old: outlined pills).
- **MED: Fig 3 figure bleeds past the column and the right edge reads cut off.**
  - The figure spans x 319-901 in the 518 px column, and the backtrack path starts mid-plot at the right edge (skyline-new-02 y≈270-285).
  - The `weight` bars below are now black hairline ticks (old: solid salmon bars), so "columns kept 107/120" is harder to correlate with the plot.
  - Fix: restore filled bars (X3), and narrow the figure to the column (drop `bleed`, skyline.tsx:486).
- **MED: Fig 2 (real skyline picker) weight strip lost its fill (skyline-new-01 y≈800).**
  - Old had an olive filled area chart with a `weight 1.0` reference line, which made vote gaps obvious (the dropouts at the cloud and the head).
  - New is a 1 px line over a pale hatch with 6 px text.
  - The picker thumbnail row is also cut mid-thumb at the right (8th thumbnail clipped), whereas the hero strip shows all 12 (skyline-new-01 y≈485-535). The 12 photos are the point of "pick any of the 12 photos".
  - Fix: horizontal scroll with fade, or two rows of 6, or reuse the hero's 12-up strip (`PhotoPicker` size small).
- **MED: Fig 4 hard cases are four 250 px thumbs with the imprint line under each (skyline-new-02 y≈1240 and new-03).**
  - Overlay (yellow ticks) is readable, but the ticks and the crop (head on the ridge) are less legible than old, which had 350 px tiles and a clean two-line caption.
  - The imprint adds a third monospaced line per tile (known issue 2), so each tile reads as three stacked captions.
  - Fix: set `imprint={false}` in `HardCases` and keep the measured caption; or move the imprint into the Figure footer once.
- **LOW: hero steppers in the page header (Fig 1, "BL.01..04") wrap to two rows and the pause control sits alone (skyline-new-00 y≈1224-1262).** Use a single row with an overflow menu, or shorten the labels ("Photo / Sky / Line / Trust").
- **LOW: stat row (skyline-new-03 y≈270-440): "161 ms" and "39 / 60" wrap.** See X2.

### Improvements to keep
- Header band (skyline-new-00): real panorama with measured yellow column ticks, labelled peaks, three "re-read from this photo's run" numbers, and a 12-photo picker with accept/reject tick marks. Much better than the old title-plus-quote header.
- Third stat is now honest wild-set numbers (39/60 plus the "reports/bench-wild.md" caveat) instead of "11/11". Keep, once the tile layout is fixed.
- "THE LINE WE TRACE" formula panel (skyline-new-02 y≈745) with colour-keyed symbols is new and good.
- The Connections network graph was replaced by "On this route" links (skyline-new-05). This follows the no-network-graphs rule. The old "Leads to / Referenced by" cards had the one-line descriptions; the new link row loses those. Consider keeping a two-line text description next to each link.
- Fig 5 code and ontology panels survive intact, and the Details block is open in both versions.

### Fix list
1. X1 selected-chip rule in `swiss/theme.css` (fixes Fig 3 and Fig 5).
2. X2 `Stat` container-query sizing in `viz/Section.tsx`.
3. Restore filled `WeightStrip` area (skyline.tsx:1027+) with a 35 % olive/ink tint plus a 1.5 px outline.
4. Remove `bleed` on Fig 3, or give the scan viewBox a 518 px layout.
5. `imprint={false}` on the `HardCases` gallery and the three-step `Trio` thumbs (skyline.tsx:1244, :1318).
6. Keep picker thumbs fully visible (two rows).

## dem-horizon

### Regressions
- **HIGH: selected toggle (Synthetic 1 "curvature + refraction on") loses legibility and sticks out of the column.**
  - See X1/X4 (dem-horizon-new-04 y≈1345 versus old-04 y≈167, a clear pill).
  - The toggle is now yellow highlighter text with no pill shape and is clipped at the right edge.
- **MED: Fig 3 (real horizon, "Try any of the 12 photos") photo/plot (dem-horizon-new-02 y≈700-1220).**
  - The photo panel is fully reproduced, but in a 566 px column the dotted ridge rows (green) and the cyan skyline are thinner and less saturated than old (old had a dark halo and a thick cyan line; new has a paper-white halo that makes the lighter green dots wash out against hazy blue terrain).
  - The distance colour legend ("near ... far (0.3 to 150 km)") is a hand-drawn rainbow squiggle (new-02 y≈944) that is hard to read as a colour scale.
  - The "in the photo" band on the azimuth plot is a grey hatch, so the dots in the window no longer stand out from those outside (old: tinted teal band).
  - Fix: use a flat 12 % water-blue tint plus an outline for the band; draw the legend as a straight 8 px gradient bar with tick labels.
  - Halo should be dark ink (`rgba(10,14,20,.55)`) for lines over photos, not paper. This is the shared "SketchPath on photo" issue; the dem-horizon ridge dots are the worst example.
- **MED: Fig 4 "Where it fails" gallery (dem-horizon-new-03 y≈405-600).**
  - Photos changed from 2.2 px-median cases (old) to the three head-on-ridge frames, which is a better story (median 3.0/4.1/7.7 px but worst tenth 145/103/18 px).
  - The cyan/yellow lines on 160 px thumbs are barely visible, and each thumb carries a 3-line Aufnahme/Revision/Stich imprint plus a 2-4 line caption.
  - The key claim "median stays small but worst tenth huge" is carried by text only.
  - Fix: show these three at 2-col or full width with a small worst-tenth marker drawn on the photo (red ticks where the gap exceeds 20 px); `imprint={false}`.
- **MED: Synthetic 2 (sweep: map plus unrolled 360 deg profile), dem-horizon-new-05 y≈200-430.**
  - The polar map shrinks to a 180 px wobbly circle (old 255 px) with orange ringed hills.
  - The unrolled-profile panel (old: bright near/dim far lobes with a dark field and rings) is now a 6 px-tall thin black scribble on paper with 20°/10°/0° labels at about 5 px. The "brighter means nearer" encoding is gone from the picture.
  - The scrubber track is a hairline.
  - Fix: render the profile at the full column width (stack map above profile instead of side by side) with a distance-coloured fill (use the same `distColor`).
- **LOW: Synthetic 1 caption sits as a very long left-hanging block to the right of a narrow "SYNTHETIC 1" tag (new-05 y≈25-145).** Wrap the caption full width under the tag.
- **LOW: Fig 2's slider (flat to real Earth) is a hairline (new-01 y≈1005).** See X5.

### Improvements to keep
- Header hero (dem-horizon-new-00): real photo with the cyan horizon plus the terrain either side; stats "194 azimuths, 74 % within 5 px, 5328 ms".
- Fig 1 caption now carries the number that matters ("lands within 1.8 px; at the compass guess it was 13 px off").
- Fig 2 adds a "curve -48 m" annotation on the crest and a red bar for how far it sinks, and the legend (1)(2) text is clearer.
- The formula panel "THE ANGLE EACH GROUND POINT IS SEEN AT" is new and colour-keyed.
- Fig 3 caption adds the 12-photo hint. The three-step "One ray, three jobs" strip is intact.

### Fix list
1. X1 and the toggle pill (dem-horizon.tsx, `HandRange`/toggle near :560).
2. Real-photo overlay halos dark, not paper (RealPhoto/SketchPath-on-photo, `viz/real.tsx:243-280`, dem-horizon `HorizonOverlay` :1083).
3. Replace the squiggle colour legend with a straight gradient bar (`DistLegend` :988).
4. Sweep: stack the map and the profile, fill the profile with `distColor` (:789-980).
5. Fig 4: `imprint={false}`, larger thumbs, a worst-tenth tick on the photo.

## pose-estimate

### Regressions
- **HIGH: Fig 2 stat tiles overlap and overflow (pose-estimate-new-04, y≈585-810; code pose-estimate.tsx:1137-1152).**
  - Four large numerals ("10 / 12", "0.9–7.7 px", "5–43 px", "0.44–1.00") wrap to three lines and collide.
  - The last tile runs off the right edge (to x≈872).
  - Worse in the Details section (new-06 y≈650-830).
  - See X2; also here the strings are ranges, so use `whitespace-nowrap` and a smaller tier.
- **MED: Fig 2 chart (median error px, per demo photo) lost its legend and crisp markers (new-04 y≈340-540).**
  - Old: pink prior dots versus cyan solved dots, a purple selected-column highlight, an x-axis title and a "click a point to load it in Fig. 1" affordance with hover.
  - New: both marker sets are similar dark grey/teal, the solved dots are tiny, the hollow "rejected" circles are hard to see, and there is no legend (the info is only in the caption, which says "magenta/cyan" while the chart is now grey/teal).
  - Fix: colour the prior markers red (`--gb-red`) and the solved markers navy, add an in-chart two-item legend, and bump the markers to 5 px.
- **MED: Fig 1 inside Details: the overlay photo is 250 px (pose-estimate-new-03 y≈950-1040).** The labelled peak names are about 4 px and illegible (old: 385 px, small but readable), and the three legend chips ("detected skyline / DEM at solved pose / peaks (solved)") are stacked vertically and leave a long blank column under the photo next to the 20-row table. Fix: put the photo above the table at full column width.
- **MED: Fig 3 (PoseExplorer) is clipped and its sliders are hairlines (new-04 y≈960-1400, new-05 top).**
  - The plan/image pair is 190 px each.
  - The yaw/pitch/roll/vfov controls are bare hairlines with tiny knobs; the two action links are italic hand-script that looks like captions rather than buttons ("Take control", "Reset to a phone prior").
  - Fix: restore pill buttons (ink outline), thick tracks, and stack plan above image if the column is narrow.
- **LOW-MED: DofLadder (Fig 4) row indicators and the "ChoosePreview" panel (Fig 5) lost their frames.**
  - The ladder rows have thin grey dots versus the old coloured ring dot, so "solved / held" no longer shows at a glance (new-05/06).
  - In Fig 5 the "auto / near-compass / prior" three-way selector shows no selected state other than a red wavy underline on "auto" (new-06 y≈1090).
  - The code block text and the right panel run together without a divider.
- **LOW: "Phone compasses are wrong by degrees" lead figure was replaced by a peak-label comparison (CompassShift).** It is better, and the old dial grid is retained as Gallery (new-02 y≈340-830). But the Dial thumbs at 90 px are fine; the "rejected" labels at 11 and 7 are red text that crowd the angle caption. Minor.

### Improvements to keep
- Hero (pose-estimate-new-00): panorama plus measured skyline plus verification ticks plus "2.0 px residual, 70 % columns agree, 111 ms".
- The four-numbers hero figure (Yaw/Pitch/Roll/View angle) is kept almost 1:1, with crisper numbered callouts (new-01).
- CompassShift (new-01/02): the new figure shows the phone labels (pink) versus the solved labels (black) with the 195 px / 239 px shift, and a formula panel (`Δx ≈ f · Δψ · π / 180`). It is a stronger explanation than the old dial grid alone.
- The "Where it fails" pair (demo-07/11) now carries explicit confidence captions, kept.
- Compass dial grid: the new dials are cleaner (hand-drawn circle, solid solved vs dashed phone).

### Fix list
1. X2 `Stat` (pose-estimate.tsx:1137-1152 and :1280-1292).
2. Fig 2 chart marker colours and an in-chart legend (`PoseResiduals` :1029).
3. Details Fig 1: stack photo above the table, full width (`RealPose` :918).
4. `PoseExplorer`: thick slider tracks; ink-outlined buttons (:192-230, :296+).
5. `DofLadder` and `ProvenanceCard`: selected-state fills (X1-style rule).

## baseline-pipeline

### Regressions
- **HIGH: Conveyor (Fig 1 in Details, baseline-pipeline-new-03 y≈1130 to new-04 y≈90) is cut off at the right.**
  - See X4. `viewBox` plus `min-w-[620px]` in `overflow-x-auto` (baseline-pipeline.tsx:241-244).
  - Stage 5 ("confidence gate"), the tail of the track and the `refinePose` fork are clipped, and no scrollbar or hint shows.
  - The panels lost their box outlines and fills (old: rounded dark cards with the active one lit), so the stage the token is currently on is not highlighted.
  - The legend text overlaps the dots ("wi●sreject").
  - This is the page's core figure, and it is a regression from "works" to "cut off".
- **HIGH: the timing bar (hero Fig 1, baseline-pipeline-new-01 y≈170-215; Fig A new-03 y≈900) is an unreadable hatched strip.**
  - See X3. Segment proportions (4.4 s / 255 ms / 111 ms) are lost, and so is the colour key matching the dots in the legend.
  - Code: `TimeBar` :1036, and the same strip in the hero stages (`HeroStages` :1650).
  - Fix: solid segments in navy/amber/teal with a 1 px ink outline, and a label on the big segment ("horizon 93 %").
- **MED: Fig A (MeasuredOnePhoto, new-03 y≈480-1080) panels are 250 px thumbs.**
  - Four sub-panels (Sensors→prior, Skyline in pixels, Slide one onto the other, Label what is there) are 2×2 at 250 px with 9 px captions.
  - Line separation between the pink/yellow/cyan lines is lost at this size. The labels in panel 4 are about 4 px, unreadable (old: 374 px).
  - The picker strip clips its last thumb.
  - Fix: single column at full figure width, each panel 518×~170, with the imprint off.
- **MED: Fig B (all-12 table, new-05 y≈250-710) lost the coloured bar pairs (X3), the verdict colours and the selected-row feedback.**
  - "solve / rejected / refine" are red/teal text only.
  - The photo thumbs are 36 px (fine). The "Click a row to load it in Fig. A" affordance has no hover/cursor cue.
  - Fix: solid pink/cyan 6 px bars; row hover background; a "▶" glyph on the selected row.
- **MED: Fig C benchmark pills (new-05 y≈1190-1370).** The old two-half capsule is now a hatched swatch with no visible empty/filled difference. Fix: outlined capsule, left half fill = solve, right half = cascade, in solid ink tint.
- **MED: Fig 3 (variants, new-06 y≈430-650) bars are hatch-only.** The hot (cascade) row is red hatch, the rest are grey hatch. The tick at ≤10 px is thin. Old: filled grey bars with a magenta/purple highlight. See X3.
- **MED: stat tiles (new-02 y≈1140-1300, new-06 y≈780-930).** "10 / 12" wraps, "0.22° / 5.0 px" collide. See X2.
- **LOW: YawSearch (hero-like Fig 2, "Sliding is a search for the deepest dip", new-01 y≈1000-1360).** This is a *new* section with real-photo cost curve, and it works. The tabs (compass guess / runner-up / best fit) have the selected one only underlined, which is fine. The "typical yaw 7.0 px" label overlaps the curve at the right (y≈1108).
- **LOW: Trio "Every photo ends in one of three outcomes" (new-02 y≈485-680).** Thumbs are 160 px wide and the imprint line takes three lines each; the overlay is barely visible. Old: 190 px with a colour overlay. Use `imprint={false}`.
- **LOW: cascade flow Fig 2 (new-05 y≈840-1000):** boxes lost outlines, the label text is 5 px, and the bottom caption overlaps the dots.

### Improvements to keep
- Hero (baseline-pipeline-new-00): real photo with the measured skyline, the 12-photo picker with accept/reject marks, and stats "5328 / 180 / 111 ms".
- New "THE SOLVE" section (new-01 y≈520-700 and new-02 y≈1-360): the yaw-search cost curve on a real photo with the compass guess / runner-up / best-fit markers, and a formula panel ("What the dip measures", colour-keyed ε, h, w, τ). This is a good addition.
- Step list ("Stage by stage") uses a hand-drawn red rail: clear and consistent.
- The outcomes caption now says "Demo-03 reaches 0.87 confidence" etc., kept.
- The long "Details" content is intact and readable.

### Fix list
1. Conveyor responsive layout or vertical rail (baseline-pipeline.tsx:214-390), with filled stage cards.
2. `TimeBar` and the hero strip: solid segmented fills (:1036 and :1650).
3. Fig A: one column, large panels (:1101-1240).
4. Fig B/C/3 bars: solid tint plus optional hatch (:1245-1470, :909-980).
5. X1/X2 shared kit fixes.
6. Pass `imprint={false}` to every `RealPhoto` inside `Trio`/`Gallery`/`OutcomeMini` (:1746, :2250, :2291).

## Priority across the four pages
1. X1 selected-chip contrast (one CSS rule, fixes the red-on-red chip everywhere).
2. X2 `Stat` sizing (pose-estimate Fig 2, baseline and skyline stat rows).
3. X3 solid-tint plus hatch for bars and areas (baseline time bar, Fig B/C/3, skyline weight strip).
4. X4 baseline Conveyor clipping, and the dem-horizon toggle clipping.
5. Dark-ink halo (not paper) for measured lines over photos (dem-horizon dotted ridges, skyline ticks).
6. Panels shrunk to thumbs (baseline Fig A 250 px, pose-estimate Details Fig 1 250 px, dem-horizon Fig 4 160 px): switch to a single column at full width, and drop the imprint.
