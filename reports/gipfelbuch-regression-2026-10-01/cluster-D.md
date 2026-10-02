# Findings D: dem-source, terrain-sampler, eye-rule, dem-anchoring

Shots in `.../scratchpad/shots/` (abbrev `<p>-old/new-NN`). New code in `src/lib/gipfelbuch/pages/<id>.tsx`, old in `git show HEAD:src/lib/atlas/pages/<id>.tsx` (copies in `scratchpad/d/<id>.old.tsx`).

## Cross-page root causes found on these four pages (beyond the known list)

C1. **Label sizes were tuned for a text column that no longer exists.** The new pages carry comments such as eye-rule.tsx:286-289 ("Fig. 2 ... bleeds to the ~720 px text column: 11 px rendered", "Fig. 1 side view ... 1.7fr column, about 450 px"), dem-source.tsx:139-143 ("360-wide figures render at their 560 px max-width; the 600-wide ladder renders at ~720 px"). `PAGE_GRID` (ConceptPage.tsx:59) gives the bespoke body 6 of 12 tracks = ~518 px, and `Figure bleed` is only `lg:-mx-6` (Figure.tsx:73). Every SVG label therefore renders at ~0.7 x the intended size, i.e. 6-8 px: eye-rule Fig 2 axis/photo ids, dem-source zoom ladder ("13.1 m", "z12", "104.6 m"), dem-anchoring Fig 2 and Fig 3 axes, terrain-sampler Fig 2 ring labels. The old charts also bled wide: old terrain-sampler Fig 2/3 and eye-rule Fig 2 were ~860 px wide cards (terrain-sampler-old-01/02, eye-rule-old-01). The right 4 grid tracks (~330 px) are blank beside every figure on all four pages.
   Fix: wrap the Bespoke in `lg:col-[content-start/full-end]`, give prose blocks `max-w-[34rem]` and make `Figure bleed` fill the wide track (~780 px). Then the existing label constants are right again. If that is rejected, recompute the *_LABEL constants against 518 px and floor all SVG text at 9.5 px rendered.

C2. **Hero ledger and photo picker are new, but the bespoke figures do not follow them.** `Ledger` + `PhotoPicker` (ConceptPage.tsx:160-195) re-read numbers per photo, but every figure on these pages is baked from Niederhorn/demo-01 (or demo-09 for eye-rule). Result: terrain-sampler hero says "1886.1 m under the camera" (demo-01 JSON, `gps.ground`) while Fig 1 right below says "Under the camera: 1,934 m" (Mapterhorn tile). Clicking another thumbnail changes only the 3 ledger numbers. Either say so ("figures below are from Niederhorn / demo-09") or wire the figures to `photoId`. Keep the picker (improvement, see below) but add that caveat line under the strip.

C3. **Ledger unit collision.** Large ledger values ("1886.1" "1918.9") run into the unit and the label: unit "m" is drawn on top of the first letter of the label ("mDEM ground", "mGPS altitude", "mheightAt() under the camera"). See terrain-sampler-new-00 (y~165) and eye-rule-new-00 (y~165-295). Fix in Ledger: give the unit its own fixed-width grid column or `whitespace-nowrap` + `pr-1`, and widen the label column.

C4. **Pipeline `Flow` wraps with dangling arrows.** dem-source-new-03 (y~270), eye-rule-new-04 (y~1160-1240), terrain-sampler-new-04 (y~680-760): a 4-5 node flow wraps to two rows, leaving a trailing arrow pointing at nothing (red arrow after node 3 / 4). Fix: flex-wrap with the arrow attached to the preceding node and omitted on a row end; or render the Flow vertically below ~600 px.

C5. **Stat rows wrap badly at 518 px.** `Numbers` uses 4 columns of ~120 px with 40 px numerals: "25 vs / 14", "21-87 / m", "730 / m", "11 / / 12", "20 / / 27", "1.6 -> / 105 / m" (dem-source-new-02 y~900; terrain-sampler-new-05 y~350; eye-rule-new-03 y~590; dem-anchoring-new-03 y~1030). Fix: numeral size `clamp(26px,4.6vw,34px)`, `white-space:nowrap` on value+unit, 2x2 grid below 640 px (or let it use the wide track from C1).

C6. **Tiny Trio schematics.** Trio previews (dem-source, terrain-sampler, eye-rule 3-card rows) were 190 px dark cards with legible mini-figures; now ~160 px borderless hatch drawings whose in-figure text is 4-5 px ("near/far", "fine tile missing", "coarser tile", "z13 1.3 m"). dem-anchoring-new-02 step 1 also shows the imprint line "Aufnahme demo-01, 2026-09-07 · Revision solve · Stich SVG" under a 160 px thumb (known issue 2, hits hard here: it wraps to 3 lines and is wider than the picture).

---

## dem-source

### Regressions
- **HIGH: hero ledger shows "0 km half-width of the patch".** dem-source-new-00 top right. `tafel/sheets.tsx:1515` `stat(d, "demPatch.halfKm", ..., { unit: "km" })`, but `UNIT_SCALE.km = 0.001` (sheets.tsx:69) divides a value that is already km (demo-01.json `halfKm: 20` -> 0.02 -> "0"). Fix: drop the `unit:"km"` scaling for this stat (pass `dec:0` and render unit via label) or store metres.
- **MED: Fig 1 peak annotations lost their numbers.** Old SVG text "Mapterhorn peaks at 1,964 m / Terrarium peaks at 1,930 m" in the plot (dem-source-old-00 y~1107-1125, HEAD dem-source.tsx ~215-225). New `HandText` says "Mapterhorn peaks here / Terrarium peaks here" (dem-source.tsx:~214-219, dem-source-new-00 y~1190-1207) and the numbers were moved to the caption. The two labels also overlap the Terrarium/Mapterhorn lines. Fix: restore "peaks at 1,964 m" in the hand text (it is data), anchor each label next to its own summit on the profile, and keep the caption for the 34 m summary.
- **MED: zoom-ladder (Fig 3) lit band no longer reads.** Old: lit band solid green with the other bands dark (dem-source-old-01 y~1230-1330). New: all bands outline boxes, active band = cross-hatch; Terrarium bands are red hatch vs empty boxes; band labels ~7 px (C1). Fix: active band filled with solid `--gb-forest`/`--gb-red` at 0.85 and paper-coloured label; inactive bands light wash (0.12), not outline-only; labels >= 10 px.
- **MED: relationship cards removed.** Old "Connections" graph + "Leads to / Referenced by" cards with one-line summaries (dem-source-old-04/05). New: a 4-column footer of bare links (dem-source-new-05 bottom). The network graph is intentionally gone (matches the "no network graphs" decision), but the *explanations* ("this feeds: One function, heightAt(lat, lon)...") are lost. Fix: add a plain 2-column "Leads to / Used by" list in the footer with the node `tagline` under each link, in the new type scale. No graph.
- **LOW: Fig 2 elevation hatch.** Old filled area was a quiet green wash with 2 crisp lines (dem-source-old-01 y~255-460). New hatch + wobbly dashed Terrarium line; the Terrarium/Mapterhorn lines coincide over 10 km so the dash reads as noise. Fix: draw the Terrarium dash on top with width 1.2 in `--gb-red`, Mapterhorn 1.8 in forest; reduce hatch opacity to 0.25.
- **LOW: pixel-decode card text wraps** ("135x256 + 90 + 130/256 - / 32768", dem-source-new-03 y~950-990). Fix: `white-space:nowrap; font-size:11px` or stack the two cards.
- **LOW: coverage chips lost chip borders** (dem-source-new-03 y~1250-1285) so "Niederhorn (CH) z17" etc. read as loose text; acceptable but add a hairline underline or dotted leader.

### Improvements to keep
- Photo picker strip with per-photo check/cross marks (dem-source-new-00).
- Fig 1 slider handle in red with a red divider: much clearer than the old white-on-white handle.
- Colour-to-metres `Eq` block (h = 256R + G + B/256 - 32768 with the pixel's numbers, dem-source-new-03) replaces a plain text decode and is a real addition.
- "Fig. 4" bars: hatch + edge is readable and the value labels are crisp.
- Copy fix: explains Terrarium grid is finer than its detail.
- All of Fig 1/2/3/4 data is intact (same JSON, same values).

### Fix list
1. sheets.tsx:1515 halfKm unit bug (HIGH).
2. C1 wide track so Fig 3 labels return to 11 px.
3. Put numbers back into Fig 1 labels.
4. Solid active band in Fig 3.
5. Footer "Leads to / Used by" with taglines.
6. C4, C5.

---

## terrain-sampler

### Regressions
- **HIGH: Fig 2 (radar + level table) lost its dark-card compositional fidelity and side-by-side layout.** Old: radar left, live readout card ("distance 14 km / band picks z11 / answered by z11 . 26 m/px") and level table right, active row highlighted (terrain-sampler-old-01 y~275-665). New: radar on top, readout and table stacked, default distance 49 km so the interesting z11 case is not shown, ring fills are all the same pale hatch so the "band" is only an orange-hatched outer ring (terrain-sampler-new-02 y~360-970). Rings' z-labels ~7 px; "Click a row to remove a level" is plain mono text with no affordance. Fix: with C1 wide track, restore a 2-column grid (radar 300 px | table); default the probe to 14 km; fill ring k with `--gb-forest` at 0.1 x k (graded) and give the active ring a solid 2 px forest outline; row hover/active = paper-deep fill with a red left tick.
- **HIGH: Fig 3 blend illustration (BlendMini and weights bar) degraded.** terrain-sampler-new-03 y~180-720. (a) The 6x5 height grid labels collide across the seam ("1891.31|1891.13", "1889.94" overprinted by the stipple sample marker and the 4 corner dots) because cell width is now ~55 px for 7-char labels at 11 px; (b) the four-weight bar (terrain-sampler.tsx:753-779) is four 9 px high hatch smears with width = weight, opacity 0.45-1, so neither the weights nor their match to the corners can be read (old: four solid green bars, terrain-sampler-old-03 y~170). (c) the "stipple" blob for the four-corner footprint hides the numbers it is explaining. Fix: shrink grid labels to 9.5 px and drop decimals to 1 inside cells (full precision in the readout); draw weights as solid forest bars at 12 px high with the numeric weight printed inside (0.12 / 0.24 ...), and colour-link each bar to its corner dot via a numbered circle; replace the stipple blob with a thin dashed square.
- **MED: Fig 4 caption contradicts the chart.** terrain-sampler.tsx:849-850 still says "White: what we answer ... Violet: the coarsest map" but the chart now draws black (answer) and orange (coarsest) (terrain-sampler-new-05 y~175-260). Fix: reword to "Black ... Orange ...", or use `<Key color=...>` chips instead of colour words.
- **MED: Fig 4 band-edge worst-case row.** Old coloured per-level "z9 worst 44 m, z10 worst 24 m ..." chips (each a different colour, terrain-sampler-old-02 y~382) are now grey/orange text (terrain-sampler-new-05 y~175); the colour per level meant something. Fix: restore a per-level ink (forest -> brown -> red) on those chips or add a tiny swatch.
- **MED: hero hillshade (Fig 1) is fine but marker 1 overlaps the shading and the dashed line is heavy black.** The new red numbered circles are more legible than the old green (improvement), but the 3 pt black dashed transect competes with the dark terrain on the left (terrain-sampler-new-01 y~800). Fix: make the transect white with a 1 px dark under-stroke, or switch to paper halo only on the dark half.
- **MED: hero ledger collisions** (C3) and hero number disagrees with Fig 1 (C2).
- **LOW: profile area under Fig 1 is hatched orange** with the readout list wrapped awkwardly ("170 / m away.") (terrain-sampler-new-01 y~1335-1390). Fix: widen via C1, or put the four readouts in a 2x2 grid with nowrap.
- **LOW: relationship cards removed** (same as dem-source). Terrain Sampler had the richest set (Leads to 3 / Referenced by 4 + "feeds this" DEM Source).
- **LOW: step-2 "Blend four pixels" Trio mini shows only a hatched square** (terrain-sampler-new-02 y~1180-1260), numbers 3 px.

### Improvements to keep
- Red numbered markers on the hillshade (stronger contrast than the old pale green rings).
- Blend `Eq` block (h = (1 - fy) top + fy bottom with live numbers) and the symbol legend (terrain-sampler-new-03 y~740-980) is a real addition.
- Sheet "Zeichenerklärung" legend (contour / viewpoint) at the foot.
- Fig 4 chart lines are crisp enough and answer line is bold.

### Fix list
1. Fig 2: 2-col layout, default 14 km, graded ring fills, active ring outline.
2. BlendMini label size + solid weight bars.
3. Fix "White/Violet" caption (terrain-sampler.tsx:849).
4. C3 ledger unit, C2 caveat line, C5 stats.
5. Per-level colour on worst-case chips.
6. Related-links taglines in footer.

---

## eye-rule

### Regressions
- **HIGH: hero Fig 1 side view and photo are squeezed side-by-side and unreadable.** eye-rule.tsx:1005-1030 `grid md:grid-cols-[1.7fr_1fr]` inside the 518 px column makes the side view ~290 px and the photo a 176 px thumb (eye-rule-new-00 y~650-870); labels (`SIDE_LABEL`, HandText 15-19) land at ~7 px ("ground 1913 m", "phone says 1183 m", "inside the mountain"). The skyline overlay on the photo (layers ["skyline"], crop band) is invisible at that size; old had the 260 px photo with a visible yellow/green skyline (eye-rule-old-00 y~555-655) and a 440 px side view. Stage tabs also lost their active pill: new is underline-only and low contrast (fine aesthetically), but the pause button is a tiny 10 px icon. Fix: stack (side view full width, photo as a 100% wide, 140 px tall strip below) at < 760 px container width; photo uses `skylineBand(d)` crop at full column width; hand text >= 11 px rendered.
- **HIGH: Fig 4 (alt-contour schematic) labels overprint.** "max rule 1001.6 m" and "contour MAP 995.5 m" are drawn on top of each other (eye-rule-new-04 y~485-495; old had them separated, eye-rule-old-03 y~145-157). eye-rule.tsx:420 and :441-448 place both labels near px(mapX)/py(...)-4/-11 with only an `anchor` flip. Also text on the (now blank-paper) terrain hatch is 6 px. Fix: put the "max rule" label right of the vertical, the "contour MAP" label on the opposite side with a leader line; stagger y by max(0, 14 - |py(floorEye)-py(mapEye)|).
- **HIGH: Fig 2 dumbbell chart (12 photos) shrunk and labels sized wrong.** Old: 860 px wide, 15 px labels, crisp blue/yellow dots, "alt 1183 m: -730 m (off scale)" in red (eye-rule-old-01 y~255-880). New: ~480 px, 8 px photo ids and axis, blob dots (hand-drawn pentagon blobs, eye-rule-new-02 y~590-980), one amber vs near-black dot pair that reads as two nearly identical dots at this size, legend at 6 px, "off scale" note 6 px red on hatch. Fix: C1 wide track; replace blob dots with crisp 5 px circles (sketch style only on the grid), Terrarium amber vs Mapterhorn forest (not near-black), label size 11 px, "off scale" note on a paper chip.
- **MED: Fig 3 bar chart lost sign colour.** Old used amber for positive and blue for negative (eye-rule-old-02 y~30-130). New: identical black hatch for both signs; direction only readable from the number (eye-rule-new-03 y~85-340). Fix: negative bars hatched in navy / positive in red-brown; add centre label "contour lower | contour higher".
- **MED: hero ledger collisions** (C3) and per-photo ledger vs demo-09-only figures (C2): eye-rule ledger shows demo-01's 1886.1/1918.9/1918.9 (the eye equals the GPS altitude there) while Fig 1 and the three cards say 1183 / 1915 / 1914.7 (demo-09). Add the "figures below: demo-09" note.
- **MED: sliders in Fig 4 are 2 px wobbly lines** with black round knobs (eye-rule-new-04 y~640-650); old had chunky blue tracks with clear fill (eye-rule-old-03 y~340). Active value readouts (-12 m, +30 m) remain but are tiny. Fix: use a straight 3 px track, fill left of the knob in red, 18 px knob with a paper ring; keep the sketch look for tick marks only.
- **LOW: Fig 5 (shift vs distance)** loses the blue curve's weight (black 2 px) and the grid is almost invisible; axis labels 7 px (eye-rule-new-04 y~1150-1385). Mark the 3 labelled points with 4 px red dots and 10 px text.
- **LOW: "Where it fails" amber/ blue / red callouts** keep their left rule but lost the tinted background that distinguished them (eye-rule-new-05 y~100-630); three callouts now read as the same grey card. Tint each at 6% of its rule colour.
- **LOW: ontology card + connections** same as dem-source (graph intentionally gone; add taglines).
- **LOW: `Flow` wrap** (C4): EXIF -> DEM at fix -> max(...) -> iso-band scan -> Gaussian prior wraps to 3 rows with two dangling arrows (eye-rule-new-04).

### Improvements to keep
- Photo picker with check/cross marks.
- New Eq block "eye = max(alt, g + 1.6) = max(1183, 1913 + 1.6) = 1914.7" with R/G/B-style coloured symbols (eye-rule-new-00 bottom) makes the rule explicit, which the old page only said in prose.
- Fig 3 and Fig 2 axes now have quiet pencil gridlines and the amber "altitude used" line is thicker and clearer.
- Cards 1-3 big numerals (1183 m / 1915 m / 1914.7 m) kept and legible.

### Fix list
1. Stack Fig 1 (side view full width, photo strip below) and raise label sizes.
2. De-overlap Fig 4 labels.
3. Wide track + crisp dots for Fig 2.
4. Sign colours in Fig 3.
5. Chunky sliders.
6. C2/C3/C4/C5.

---

## dem-anchoring

### Regressions
- **HIGH: Fig 5 (pixel classes) is unreadable.** Old: a 24x? grid of coloured cells, five classes in five fills (blue sky, brown people, rose near, violet far, yellow kept) with a legend of 5 colour swatches (dem-anchoring-old-03 y~1240-1400 / old-04 y~0-80). New: five hatch families at the same -45 degree angle and differing only by gap (dem-anchoring.tsx:703-709 `CELL_INK`), rendered grey on a pale hatch rectangle, legend swatches 10 px hatch (dem-anchoring-new-05 y~0-140 area). Sky vs far vs near are indistinguishable. Fix: restore cell fills (class tint at 0.55 opacity) and overlay the single hatch only on the "kept" class; legend swatches filled squares.
- **HIGH: hero stages 2 and 3 (RangeCells overlay) now draw only thin hatch lines over the photo.** dem-anchoring.tsx:1237-1310: per-class hachure, width 1.3 at 0.9 opacity (gap 8, dimmed 11). Old drew 50% opaque coloured cell fills (HEAD ~1085-1117), which is what made the five distance bands readable on the photo. I could only screenshot stage 1 (dem-anchoring-new-00/old-00), so stage 2/3 is unverified visually, but a gap-8 hatch over a busy photo of forest and cloud will lose the band colours (legend shows hatch swatches only, dem-anchoring-new-00 y~1117-1133). Fix: fill cells at 0.4 opacity with the band ink, then the hatch on top at 0.7; the legend gets filled swatches. Also keep the paper halo (exists) but widen it to 4.
- **HIGH: Fig 2 spaghetti (27 real range curves) shrunk to a 290 px thumbnail with grey lines.** Old: 420 px wide, olive-yellow semi-opaque lines with a legible stat triple beside it (dem-anchoring-old-01 y~185-530). New: all-grey curves, 7 px axis labels, stat boxes stacked right at 9 px (dem-anchoring-new-01 y~130-340). The point of the figure (the curves fan out) still works but is faint. Fix: C1 wide track, curves in forest at 0.5 opacity with the median curve in red, axes 10 px, and the "1.5 / 5.8 / 6.1" stat triple as large numerals.
- **MED: Fig 3 (fit demo) loses the filled trusted-band and colour contrast.** Old yellow dots, white curve with white knots on dark band (dem-anchoring-old-02 y~0-420) vs new teal dots + red curve + dotted band outline (dem-anchoring-new-02 y~0-320): dots, band and gridlines are equally thin so the +-25 % band is hard to see; "depth taken at face value" label is a rotated hand label that crosses the dots; axes at 7 px; the three stat numerals (50% / 0.25 / 6) kept. Fix: tint the band at 0.12 forest; dots r=2.4; rotate the label to follow the diagonal and place it below it.
- **MED: Fig 4 / Fig 6 zone colours are weak.** shown/low-trust/hidden are red and amber hatch plus grey "shown" dots (dem-anchoring-new-03 y~740-850, new-05 y~520-710): the grey dots for the 16 "shown" photos read as dead data. Fix: shown = forest dots; zone tint wash behind hatch.
- **MED: Trio step 1 thumbnail with 3-line imprint** (C6/known).
- **LOW: engineer-detail code cards truncate paths** ("src/lib/nearfield/anchor...", dem-anchoring-new-05 y~950-1220) and drop their card borders so 6 entries float; use full path on a second line with `break-all`.
- **LOW: closing sentence breaks around two inline chips** ("Its DEM side is the terrain sampler. Background: [chip] and [chip] .", dem-anchoring-new-05 y~660-715). Fix: `inline-flex` chips with nowrap, or move the two reports to a CodeRef row.
- **LOW: stat row wraps** ("20 / 27") and a long 5-line caption under "0.13" (C5).
- **LOW: relationship cards** (same note as above).

### Improvements to keep
- Per-photo ledger stats ("34 km depth along the view / 362 ground samples / 260.7 deg azimuth") and the picker.
- New cost-function `Eq` block "L = sum w_i min(|ln D_i - ln f(m_i)|, ln 1.25)" with a symbol legend (dem-anchoring-new-01 y~460-710): a real addition that pairs with Fig 2.
- Fig 1 photo (486 px) is unchanged in fidelity (no overlay on stage 1); the stage tab strip and prev/next arrows work; legend swatches are now class-keyed.
- Red fitted curve with ringed knots in Fig 3 and the red residual dot in Fig 6 read better than the old white/yellow on a light-tinted paper.
- Engineers' step list uses a vertical pen rule with numbered nodes; it reads cleanly.

### Fix list
1. Restore filled cell classes for RangeCells and Fig 5 (HIGH).
2. Widen Fig 2/3 via C1, colour curves, 10 px axes.
3. Forest dots for "shown" in Fig 4/6.
4. C5 stats, C6 Trio imprint (`imprint={false}` in Trio thumbs), code-card truncation, closing sentence chips.

---

## Priority across my pages
1. C1 (wide figure track + recomputed label sizes): unblocks about 12 of the above items.
2. dem-source hero ledger "0 km" bug (sheets.tsx:1515).
3. eye-rule Fig 1 stacking and Fig 4 label overprint.
4. dem-anchoring Fig 5 + RangeCells fills.
5. terrain-sampler Fig 2 layout/default and Fig 3 weight bars; fix the "White/Violet" caption (terrain-sampler.tsx:849).
6. C2 caveat line for baked figures vs per-photo ledger; C3 unit overlap.
