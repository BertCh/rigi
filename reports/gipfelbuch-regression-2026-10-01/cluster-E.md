# Findings E: photo-workspace, camera-roll, step-inside

Shots: `.../scratchpad/shots/<page>-{old,new}-NN.png`. New code: `src/lib/gipfelbuch/pages/<id>.tsx`; old: `git show HEAD:src/lib/atlas/pages/<id>.tsx`.

Overall verdict: these three pages kept almost all functionality. Every picker, stepper, slider, scrubber and toggle still exists in the new code, and the same real photos and measured data are used. The losses are (a) one real-data figure per page demoted into the collapsed "Details for engineers", (b) schematic figures that lost their filled grounds and now render at about 520 px so their 10-11 px viewBox labels shrink to 6-8 px, (c) the Numbers/Stat row breaking badly at the narrow column, and (d) the new top-of-page hero strip colliding with its own labels. There is little to restore functionally; most of the work is scale and legibility.

Site embeds: `RollCompasses.tsx` gained a `sketch` prop (additive, `git diff HEAD`). `Compare.tsx`, `LiveRollMap.tsx` and `src/lib/roll/**` are modified in the tree, but none of these pages mounts `LiveRollMap`; the drape is still the static `/demo/shots/drape.jpg` in both versions. No embed regressed.

---

## 1. photo-workspace

### Regressions

**HIGH: Fig. 2 annotated overlay is no longer readable** (new-02, y 440-870; old-01, y 185-790)
- Same baked `/demo/shots/demo-01-overlay.jpg` and 2048-wide `Mark` viewBox (new `photo-workspace.tsx:991-1020`, `k={2.56}`). It now renders at 566 px instead of 808 px, so the peak labels baked into the JPEG (Drunegalm, Chumigalm, Stockhorn, ...) drop from about 9 px to about 5 px and are illegible. The numbered pins are small circles and the stem and label for "Stockhorn" are hidden under the pin 1/2 markers.
- The explanatory legend under it (five numbered MarkList items) is intact.
- Fix: crop the viewBox to the useful band, for example `viewBox="0 300 2048 1100"`, which drops the empty sky and the foreground rock. That gives roughly 1.4x more pixels per label. Raise `k` to about 3.4 so the Mark discs stay about 20 px. Optionally make the figure click-to-enlarge. Longer term, replace the JPEG with the live `RealPhoto layers={["peaks","solved","skyline"]}` (it already has real peak labels with halos, as the hero photo band shows) so labels are re-typeset at the correct size.

**HIGH: Numbers row breaks mid-value** (new-02 bottom / new-03 top, "11 /" over "12"; new-05, "> / 0.2", "≤ / 1°", "20 / s")
- `Numbers` and `Stat` (kit, `viz/explain.tsx`) use a big light numeral that does not shrink. At 518 px, four columns wrap "11 / 12", "> 0.2", "≤ 1°", "20 s" onto two lines. The first three columns are about 125 px wide.
- The new warning-triangle glyph in front of each stat sits at the wrong baseline on a two-line value.
- Fix (kit-level, benefits all pages): `font-variant-numeric: tabular-nums`, `white-space: nowrap` on the value, and clamp the size to `clamp(28px, 6.5cqi, 44px)` against a container query. Or go 2x2 below about 600 px. Old size was about 36 px serif in 4 columns at 760 px.

**MED: Skyline/pin schematics lost their filled terrain and sky** (new-04, PoseJourney y 1160-1400 and pin figure new-05 y 170-420; old-02 y 965-1200 and old-03 y 1210-1400)
- The old figures used a sky gradient plus a dark ground fill, with a light crest and a bright accent overlay. The new ones use a hachure fill and thin pencil lines (`photo-workspace.tsx` around 267-640, `Hachure`/`SketchPolyline`). The hatch fill is faint (opacity 0.45) and the crest versus overlay (black vs red) is close to unreadable at 640-wide scaled to 540. Pin A/B/C/D rings are thin black circles and the labels A, B, C, D are 7 px.
- In the pose timeline (new-04 bottom), the row labels "pose state / exports / solvers" and the segment text ("loading", "auto", "locked: !!status || verify === 'pending'") are about 6-7 px.
- Cause: `FIG_LABEL = round(11*640/720*2)/2` (about 10 vbox units), designed for a 720 px column. The new column is about 540 px, so this renders at about 7.5 px.
- Fix: bump `FIG_LABEL` to about 13 and `FIG_NAME` to about 15 (the constants are centralized at the `PrintNote` block, lines 229-265). Give the ground a light-brown wash (`var(--nb-paper-deep)` plus the hachure) so the crest reads as a boundary. Draw the pin rings at stroke 2.2 and radius 11 in the red ink. Keep red for the solved or overlay line and navy for the photo skyline so the two are distinguishable (currently black vs red).

**MED: Hero Fig. 1 stage 1 re-labelled and re-captioned** (new-00 y 1170-1400, new-01 y 0-120; old-00 y 465-860)
- "1 Opens on the phone's guess" became "BL.01 Fallback: phone's guess", and the caption became "If the first solve is weak, the cockpit opens here. The map skyline misses by 5.17 px." That is semantically different (the old text said the app always opens on the phone's pose). If this was intentional for accuracy, keep it; otherwise restore the old label.
- The Stages pill row wraps to two lines at 518 px (BL.01 / BL.02 on one row, BL.03 / BL.04 on the next) and the pause button floats mid-row.
- The Fig. 1 photo is 534 x 200 px vs 808 x 303 px (old). The overlay lines are readable, but the stage-4 peak labels are tiny.
- Fix: let the Fig. 1 `Figure` use `bleed`, and give `Stages` a `grid-template-columns: repeat(4, auto)` tab row. It currently has `bleed` but the sheet column still clamps it. Use a larger crop (for example `[0,100,800,330]`) so the labels get more pixels.

**MED: "Details for engineers" figures squeezed** (new-04, y 390-1400)
- The Toggle figure (yellow / magenta / cyan skylines) is intact and the legend chips are kept, but at 526 px the three overlays overlap into one thick line and the stat cells wrap ("skyline miss, median 5.17 -> 2.71 px" over three lines, "5.3 s / 111 ms" wrapped). Old (old-02) had a 4-column row on one line.
- The scenario chips (Saved alignment / Full metadata, agreed / Cascade overrules / Weak skyline, escalated) lost their outlines. The active chip is a yellow highlight with underline, but the inactive ones are very low contrast (grey on cream, new-04 y 1040-1125).
- Fix: use `grid-cols-2` for the `dl` below about 640 px; raise inactive chip contrast (`color-mix(... 78%)`).

**LOW: "mean skyline error 24.7 px" and "overlay yaw error +0.30 deg" readouts** are about 6 px and right-aligned at the figure edge (new-04 y 1250, new-05 y 180). Increase them to FIG_NAME.

**LOW: Imprint line under Trio thumbs** ("Aufnahme demo-01, 2026-09-07 · Revision solve · Stich SVG", new-03 y 210-240). This is the known cross-cutting issue (2); `MiniLayers` in this file does not pass `imprint={false}`. Fix at `photo-workspace.tsx:1297-1310` by adding `imprint={false}`.

**LOW: Steps / "How it works" lost its numbered-badge stack** (new-05 vs old-03): replaced by a hand-drawn red line connecting small dots. Fine aesthetically, but the dot is 7 px and the number is 9 px; make the numerals 12 px.

### Improvements to keep
- Hero photo band with the real measured skyline, label stems, and the 12-photo picker (new-00). It is a genuine upgrade: the peak names are legible, and "every number on this sheet is re-read from its measured run" shows the same data model.
- New Fig. 2 `PeakProjection` (new-01 y 620-1130): a peak picker (Niesen/Seehorn/Niderhorn/Stockhorn), a prior-vs-solved link with a dashed pen line, and a live-computed caption ("moves the label 122 px, one degree of yaw is about 10.7 px"). This is new real-data content, and it is legible (the dark handwritten label reads on the sky). Keep it.
- The `Eq` block for x = c_x + f d.r/d.f with a legend (new-01 y 1170-1400) is a good addition.
- The `Details` content (PoseJourney, PinSolve, Steps) keeps full functionality: scenario chips, scrubber with "playing" toggle, the 0-4 pins toggle, and click-the-rings.

### Fix list (priority order)
1. Crop and enlarge Fig. 2 annotated overlay (`photo-workspace.tsx:991`), or use the live RealPhoto peaks layer.
2. Fix `Numbers`/`Stat` wrapping in `viz/explain.tsx` (nowrap and a container-query size).
3. Raise `FIG_LABEL`/`FIG_NAME` and restore a ground wash in PoseJourney and PinSolve; colour-separate the photo and overlay strokes.
4. `imprint={false}` on `MiniLayers`.
5. Restore the stage-1 label "Opens on the phone's guess" (or confirm the rename is intended). Wrap the pill row in a 2-column grid.
6. Engineers' Toggle figure: 2-column stat grid, higher inactive-chip contrast.

---

## 2. camera-roll

### Regressions

**HIGH: the interactive roll overview (RealRoll) was demoted into the collapsed Details** (old-00 y 1100-1400 and old-01 y 0-370 vs new-04/new-05)
- Old main body: "The idea" then `<RealRoll />`. That figure holds a 12-photo thumbnail strip on a timeline (with leader lines to GPS time ticks), a plan map with a dashed 250 m viewpoint ring, GPS accuracy discs, cyan solved vs magenta compass rays, a click-a-photo-or-dot readout, and the "1 roll, 1 viewpoint, 112 m..." text block.
- New main body: `<RollCompasses sketch />` instead (`camera-roll.tsx:2013-2030`). RealRoll was moved into `<Details>` (new-04 y 1000-1400, new-05).
- The visitor who never opens the details sees no timeline-to-plan figure, no GPS circles, and no real photos on a map, which was the page's best explainer of "pile becomes place".
- Fix: keep `RollCompasses` as the hero after "The idea", and put `RealRoll` back directly after it (before the Eq) under a short beat ("Where they stood"). The Details collapse can keep RollLinker/ViewpointWalk/PoseLadder/CompassBias/PanoramaStrip only.

**HIGH: RealRoll's right-hand readout column is crushed to one word per line** (new-04 y 1130-1400, new-05 y 0-160)
- The old layout was a 2-column grid (plan 380 px | text 410 px) in an 808 px figure. At 526 px the text column is about 120 px, so "demo-03 · +2:01 · accepted / GPS ±24 m / compass 155.8° → solved 167.3° (+11.5°)" and the three descriptive paragraphs wrap into a very narrow sliver of 3-5 words per line, 20+ lines tall. The plan map itself is okay but its rotated ray labels ("compass 156°", "solved 167°") collide with the ring.
- Fix: stack the two columns (plan above, text below) under 700 px (`flex-col md:flex-row` in `RealRoll`, `camera-roll.tsx:1295+`). Give the text column `font-size: 12px; line-height: 1.5`. Move the ray labels outside the ring.

**HIGH: RollCompasses sketch clips and collides** (new-01 y 340-1190)
- The right-edge arrows "15:30 +11.4" are clipped at the figure edge in the "Facing southeast" panel (y 397). In "Facing north", the "rejected: low confidence" labels (y 820-855) overlap the "15:36 -3.7°" labels. The photo strips are about 20-45 px tall with photo content not recognisable (small pink/blue wash), so "watch every photo settle onto the skyline" cannot be seen; at the slider's resting position (skyline) the photos are tiny parallelograms.
- Compare the old page, which showed the same idea via thumbnails of real photos in a 12-up strip, which was legible.
- The slider track itself is only about 170 px wide, and the label "compass" / "skyline" are 8 px handwriting.
- Fix (in `src/components/site/meta/RollCompasses.tsx`, `sketch` branch): clamp annotation x to `[8, W-8]` with `textAnchor` flipping to "end" past 85 % of the width; stack rejected-photo labels with a 12 px vertical offset; double the panel row height in `sketch` mode (at 540 px, about 90 px per strip) so photo content is recognisable; widen the slider to 100 % of the figure.

**MED: Numbers row wrap** (new-02 y 1300-1400, new-03 y 0-120): "10 / 12", "-19° to +12°" break across lines and misalign (same cause as photo-workspace item 2).

**MED: CompassBias (Fig. 4) readout grid broken** (new-06 y 500-820)
- "photo a · -9 min +36.6°" and "photo b · -4 min +39.1°" run into each other as 2 columns each about 90 px wide, so the name column wraps to 3-4 lines and the next column's value butts into it ("photo +36.6°photo +39.1°"). The old figure had a clean 2x2 with the numbers right-aligned.
- Fix: single column of rows (`grid-cols-1`) below about 640 px, `tabular-nums`, and `white-space:nowrap` on the value.

**MED: Fig. 2 ViewpointWalk drops its circle backgrounds** (new-05 y 570-840): the shaded overlap lens between viewpoint 1 and 2 (the point of the "f joined viewpoint 1, not 2" lesson) is now only two dashed outlines. The overlap lens (old-03 y 60-390, pink lens) has no fill, so the first-match-not-nearest message is harder to see, and viewpoint 2's top label "viewpoint 2 · 2" is cut off at the top (y 573).
- Fix: fill each viewpoint disc with a 10 % wash of its ink (the `PAL` colour) and the intersection with a hachure; pad the viewBox top by about 20.

**MED: PoseLadder lost its pills** (new-05 y 1230-1400, new-06 y 0-60): the "missing / has it / always" status pills are now plain mono text with a yellow highlight only on the active rung, and the description lines are 9-10 px grey. Fix: restore a bordered or filled pill for the status text and raise the description colour to about 70 % ink.

**LOW: PanoramaStrip (Fig. 5)** (new-06 y 1240-1400, new-07 y 0-130): works, and the match-cue ridgeline is clear (red on a dark skyline), but the photo frames are empty outlines in both versions; keep as is. The two slider labels wrap ("middle photo: compass / error") because the sliders are half width; put one slider per row.

**LOW: imprint line** on the MiniAim thumb ("Aufnahme terrarium DEM, 40 km patch · Revision hillshade · Stich SVG", new-02 y 515-550): `camera-roll.tsx:1962` MiniAim needs `imprint={false}`. (Known issue 2.)

**LOW: copy change**: "The idea" no longer carries "Nothing is stored. The roll is worked out again each time." (it is still in the "Derived, never stored" callout, so no information is lost).

### Improvements to keep
- The compass slider + three-panel strip sketch (`RollCompasses sketch`) is a real-data interaction that did not exist on the old page ("slide it and watch every photo settle onto the terrain's skyline"). Keep it, but fix the clipping.
- The "Where a photo lands on the panorama" `Eq` block (az(u) = psi + atan(...)) with the legend.
- Hero 3-stage figure: "A pile" thumbs (new-00 y 1220-1340) and "A place" cones (a sketch cone instead of a dark map) are legible. The `A drape` stage still uses the real drape shot.
- Compass error per photo (RealBias, new-03 y 900-1090): all 12 dots, cyan predicted ticks, hollow rejected dots, and the replay caption are preserved and legible (dots black instead of pink, which is fine).

### Fix list
1. Put `RealRoll` back in the main body (after `RollCompasses`); stack its columns at narrow width.
2. Fix `RollCompasses` sketch clipping and overlaps and make strips taller.
3. `Numbers` nowrap (shared with photo-workspace).
4. CompassBias readout grid to a single column.
5. ViewpointWalk disc fills; PoseLadder pills.
6. `imprint={false}` on MiniAim and MiniPlan.

---

## 3. step-inside

### Regressions

**HIGH: the real ray-range figure (RealRange) was demoted into the collapsed Details** (old-01 y 60-870 vs new-03 y 900-1400 and new-04 y 0-200)
- Old main body: "The idea" then `<RealRange />`. A 4-photo picker, the full photo with a centre-column stripe (yellow = inside 150 m, orange = far, blue = sky) beside a log-axis range curve with the "150 m" marker, and a sentence like "50 % of the 699 image rows ... nearest hit 37 m". It is the page's central evidence for the near/far split.
- New: `<RealSplit />` replaces it in the main body (`step-inside.tsx:1490`), and RealRange sits under "Details for engineers" (new `step-inside.tsx:1741-1745`).
- RealSplit is a good figure (see Improvements), but it shows one photo, has no picker, and no per-row range measure. A visitor loses the four-photo comparison and the numbers.
- Fix: keep RealSplit in the main body and move RealRange back out of Details to directly follow it, under the heading "Ranges down the centre line". (Or place the 4-photo picker inside RealSplit: its data is `split.json` for one photo only, so this needs the baked split for demo-01/02/04.)

**MED: RealSplit and RealRange are squeezed** (new-01 y 200-530; new-03 y 970-1400)
- RealSplit: the 2-column grid (`md:grid-cols-[1.5fr_1fr]`) keeps two columns at 566 px, so the photo compare is only 326 px wide and the anchor curve is 220 px, with axis labels about 5 px ("range after anchoring to the terrain", "10 m 30 m 100 m", "model as is") and its caption in 9 px mono.
- RealRange: the photo is 277 px and the plot 235 px, so the axis labels ("10 m 100 m 1 km 10 km") are clipped at the right edge of the plot (new-03 y 1050).
- Fix: change the breakpoint from `md:` to `lg:` (or a container query at about 700 px) so they stack under about 700 px. The Compare then spans the full width and the curve sits under it at 360 px wide.

**MED: hero header labels collide** (new-00 y 150-180): "1918.9 m" overlaps "eye height above sea level" (the unit "m" prints over "eye"). Fix in the kit's header value/label grid (reserve the unit width, or put the label on its own line). Hits this page hardest because it has the longest number.

**MED: Fig. 2 (confidence disc) and Truth legend lost colour** (new-05 y 0-480, new-06; old-04 y 190-1160)
- Old Truth legend: four tiles with distinct saturated bars (observed green, reconstructed blue, dem amber, generated pink) that the page text refers to ("The Truth toggle recolours everything by provenance"). New: four thin pencil strokes in desaturated colours (grey-green, teal, brown, and a noisy dotted grey for "generated"), 85 px wide, which barely differ. That undermines the purpose of the legend (match the colours to the app).
- Fix: use the real app palette (`src/lib/nearfield/provenance.ts`) for the swatches and make them 8-10 px thick fills with a pencil edge.
- Confidence disc: labels "median object range 40 m" and "r = 30 m" overlap the arc and cone lines, and the slider label row is 7 px (new-05 y 1090-1340). Keep the sketch but offset the labels onto paper halos (PrintLabel already exists at `step-inside.tsx:136`).

**MED: Numbers row** (new-05 / new-06 y 590-760): "150 m" is on two lines relative to the other items (the value baseline is misaligned because the label is uppercase 9 px and wraps to different counts), and the warning triangle glyph floats left. Same kit fix as the other pages.

**LOW: "Facts changed"**: The stat "4 % / 15 %" became "15 %" ("on deck.gl (WebGL2)") and the callout text now says "deck.gl (4 % with the since-removed three.js engine)", and the Fig. 3 / stat now say "2 renderers ... (three.js has since been removed)". That is a factual update (three PhotoEngine removed 2026-10-01), consistent with `AGENTS.md`, so it is correct; keep it. The "2 renderers" stat is now slightly odd as a headline given one has been removed. Consider "2 backends (WebGPU, WebGL2)".

**LOW: imprint on Trio thumbs** (new-01 y 1085-1170: "Aufnahme demo-01, 2026-09-07 · Revision solve · Stich SVG" and "Aufnahme terrarium DEM ..."): `MiniSplit` (`step-inside.tsx:1597-1605`) and `MiniEye` (1606+) need `imprint={false}`. Also the MiniSplit thumbnail uses demo-01, not the hero's demo-03, which breaks continuity (same in old).

**LOW: Fig. 1 SplitRuler** (new-04 y 300-720): the row labels (climber, hut roof, ...) wrap to two lines and are 9 px; the outcome pills ("Object · splat") are now plain text (the old pills were clipped on the right, so the new text is actually an improvement). Keep, but raise the row label to 11 px.

**LOW: Fig. 3 pipeline diagram** (new-06 y 100-320): the chip outlines were removed; the six steps are loose text with squiggle arrows, and the wrapping after "depth + splats" and "split" is arbitrary (a 3-row zig-zag). Acceptable; if tightening, put it on one row with a horizontal scroll or a 2x3 grid.

### Improvements to keep
- RealSplit: a baked real result with a before/after slider (the split decided on one photo: hiker lifted, lift cabin, terrain left), the fitted anchor curve with "model says 133 m where the terrain says 1338 m, fit quality 0.35, from 3,139 terrain pixels", and percentages computed from `split.json`. This is new, real-photo-based content and a stronger hero than the old chart.
- The `Eq` block for the split rule with coloured rho and rho_DEM symbols.
- SplitRuler outcome labels are no longer clipped (old-03 showed "Object · spla" cut off at the right edge).
- Hero Stages (Photo / How far? / Near or far?) and the photo picker strip at the top of the page are intact and legible (new-00).
- Photo picker on RealRange and the GPS-altitude bar chart (RealEye) keep all 12 photos with clear tick marks and the demo-09 clamp annotation (new-03 y 110-340).

### Fix list
1. Put RealRange back in the main body after RealSplit (keep both).
2. Stack RealSplit and RealRange columns below about 700 px, and increase the SVG axis font sizes.
3. Fix the header number/label collision (kit).
4. Truth legend: real provenance palette, thicker swatches.
5. `Numbers` nowrap/tabular (shared).
6. `imprint={false}` on MiniSplit and MiniEye; consider using demo-03 for MiniSplit.

---

## Cross-page kit fixes that would resolve most items above
- `Numbers` and `Stat` in `src/components/gipfelbuch/viz/explain.tsx`: nowrap tabular value, container-query size, 2x2 below about 600 px.
- A `minLabel` floor for schematics: the page-level figures define `FIG_LABEL` for a 720 px column, but the new sheet column is about 540 px. Either widen the figure column (figures can bleed to about 720 px as before) or scale the constants by `720/540` (about 1.33). Widening the figure column is the single highest-leverage fix and would resolve most "tiny label" items above.
- `RealPhoto` `imprint` default: make it off when `crop` is set and width is below about 300 px, or default to off in `Trio`/`Gallery` thumbs.
- Header meta value/label grid: reserve unit width (the "1918.9 m / eye height" collision).
