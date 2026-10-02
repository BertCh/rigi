# Audit C: accept-rule, terrain-snapping, tap-a-peak, peak

Paths: new = src/lib/gipfelbuch/pages/<id>.tsx; old = HEAD:src/lib/atlas/pages/<id>.tsx. Shots in scratchpad/shots/.
Overall: on these four pages almost no figure was deleted. Most fidelity loss comes from (a) the 518 px column squeezing figures that were designed for ~712-800 px, (b) the hatch/hand-drawn re-skin lowering contrast, (c) tables/columns clipping, (d) three figures moved into Details, (e) the RealPhoto imprint on tiny thumbs. Several figures were improved or added.

## Cross-cutting items that hit these pages hardest
- Numbers row wraps big numerals mid-value on every page: "19 / 60", "10 / 12" (accept-rule-new-03), "221 m", "21 to 87 m" (terrain-snapping-new-02), "131.8 px" (tap-a-peak-new-02), "924 of 1181", "20 of 257" (peak-new-04: 3-line numeral). Fix: Numbers value font-size clamp to column (container query / text-[clamp]), `white-space:nowrap` + smaller size at <=4 columns, or 2x2 grid in the narrow column.
- RealPhoto imprint under Trio/Gallery thumbs: accept-rule-new-00/01 (12 tiles x 3-line "Aufnahme demo-01, 2026-09-07 Revision solve Stich SVG" before the real caption), peak-new-01 (Trio steps 2 and 3 push titles down so "Aim/Look/Choose" no longer align), peak-new-04 (Fig 5 gallery). Fix: `imprint={false}` default for Gallery/Trio/TrioFrame/TapTile tiles and the Verdicts tiles; keep it only on the single large hero photo.

---
## accept-rule

### Regressions
- HIGH (legibility) VerdictTree (Fig. 4 in Details, accept-rule-new-04, y~90-450; new accept-rule.tsx:1001 VerdictTree, old 850). The 760 px SVG is now scaled to ~500 px with hand-drawn underline boxes; node text is ~7 px, "yes/no" edge labels ~6 px, and the active-path highlight (red ellipse around "refined: cascade pose" + thick black path) is the only thing that reads. Old (accept-rule-old-04) was 13 px with filled nodes and a lit path. Fix: for narrow containers re-layout the tree vertically (it is a decision list; stack 2 columns of nodes instead of 3) or give the SVG a min-width with horizontal pan; at minimum bump NH/LABEL constants (lines 822-884) by ~1.4x for the small viewBox and keep node boxes as paper-deep fills with 1 px ink strokes so the active path is distinguishable by fill, not just a red wobble.
- HIGH (clipped data) "In the code" gates table (accept-rule-new-05/06, Legacy section line ~1340-1372). The middle/description column collapsed to ~60 px so text wraps one word per line ("local / ±yaw / search", "user / picks / and / pins / are / never / HIGH"), and the file chips overflow the Details panel's right edge (src/lib/integration/unknown-pose.worker.ts at x~1088, outside the 869 px panel). Old table (accept-rule-old-04/05) had a 3-col layout with a 300 px description column. Fix: stack each row (mono threshold on one line, description below, chip below) under ~560 px; allow chip `max-w-full truncate`/`break-all`.
- MED RealDecisions bars (Details Fig. 1, accept-rule-new-03 y~900-1080; new :241 RealDecisions/:167 Bar, old :144/:92). Accepted bars are now grey hatch, rejected red hatch, rescued amber hatch at ~25% opacity. In old the accepted bars were solid periwinkle and rejected/rescued solid red/amber; the 0.5 line now strikes through the bars and its "0.5" label collides with the y axis. The decision (accepted vs rejected) is no longer readable at a glance, and the rejected photo (demo-11) is cropped narrower than before (portrait image 290 px, still OK). Fix: solid fills (ink-green or dark ink for accepted, --gb-red solid for rejected, amber for rescued) with the hatch only as texture on top; draw the bar threshold line above the bars with the label in the gutter.
- MED Hero compare (old HeroReject, :1290-1372): large demo-11 band with numbered callouts (1) "Photo's skyline and map's skyline drift up to 27 px apart here" and (2) "Here they agree within 2 px, even though hair reaches the ridge" is gone from the main flow. The new ScoreFit (:1527) shows the same photo band with orange tick marks, which tells the f story, but the two concrete measured callouts (27 px vs 2 px) are lost. Fix: add two Mark/MarkList callouts to ScoreFit's photo (the old `spots` useMemo is reusable); this uses data already there.
- MED "Score the fit" trio step (old FactorBars) was replaced by the interactive ScoreFit (improvement, see below), but the remaining Trio is now 2 mini-panels (BarScale, TwoSolvers) at only 160 px wide inside a 518 px column, leaving ~190 px of empty paper on the right (accept-rule-new-02 y~230-490). BarScale dots are 4 px and the "0.75/0.50" labels ~7 px. Fix: render the two as a stacked 1-col figure at full column width (or `Trio` with 2 columns of 1fr instead of fixed 160 px), scaling the SVG viewBox up.
- LOW Fig. 1 verdict tiles (accept-rule-new-00/01): 117 px tiles vs ~170 px before, "01 · accepted" chip in cyan on photo now uses ink text (OK) but the mono captions are now 4 lines because of the imprint. Fix: imprint off + 4 tiles per row retained but cols=3 on narrow, or tiles 2 rows x 6.
- LOW Fig numbering repeated: "FIG. 1" appears for the verdict gallery and again in Details (RealDecisions), "FIG. 2" twice (ScoreFit and ConfidenceVsError both labelled Fig. 2 in new; accept-rule-new-01/02), "FIG. 4" for ladder and tree. Old had the same duplicates (Details restarted), but the new page text says "(Fig. 3)" in step 2 of Details which now refers to the ladder labelled Fig. 4. Fix: give Details figures `D1..D3` labels or continue numbering; fix the "(Fig. 3)" reference (accept-rule.tsx step 2 text).
- LOW PrecisionLadder dots (accept-rule-new-02/03 y~1240-1400): dots are hand-drawn blobs; "wrong accepts" are drawn as red pen crosses, but at the sampled frame the red crosses are not visible (animation mid-run), and unsure dots are faint hollow circles. After the animation finishes, check the contrast of faint circles on paper-deep (colour "faint", width 1.4). Fix: set `prefers-reduced-motion`/webdriver to render final state (old did the same under webdriver?), raise faint stroke to 1.8.
- LOW Connections graph and Previous/Next cards (old accept-rule-old-06) replaced by "On this route" text links: intended, but the "Leads to / Referenced by" descriptions (e.g. "Georeference a mountain photo...") are lost; links only. Acceptable.

### Improvements to keep
- ScoreFit (new :1527): interactive photo picker + formula c = tilt·<(f-0.3)/0.5>·... with live numbers per photo (accept-rule-new-01). Better than the old static 4-bar mini panel.
- ConfidenceVsError promoted out of Details into the main flow (new Fig. 2 scatter, accept-rule-new-02): old had it only in Details. Hatch-zone for accepted region and hollow-red rejects read well.
- Hero strip: 3 measured stats (0.79 confidence, 70 % inlier fraction, 0.33 rival dip) plus photo picker "re-read from this photo's run".
- Scenario tabs with hand-written italic labels and the "hover a point" readout still work.

### Fix list (priority)
1. Gates table + VerdictTree responsive layouts (high).
2. Numbers wrap + imprint off on thumbs (global).
3. Solid bar fills in RealDecisions; line over bars.
4. Reinstate the 27 px / 2 px callouts on ScoreFit's photo.
5. BarScale/TwoSolvers full-width at 1 col.

---
## terrain-snapping

### Regressions
- HIGH (broken/placeholder data, hero) Hero stats strip reads "66° view cone / 260.7° pointing / 0 km patch half-width" (terrain-snapping-new-00, top right). "0 km patch half-width" is a wrong/empty value for this page (the hero data is for demo-01, which has no DEM patch metadata on this page), and the hero picker + "Follow another photo... every number re-read" implies the page follows the picked photo, but Fig. 1 (Hero, new :639-698) is hard-wired to demo-03 (`useGipfelbuchPhoto("demo-03")`, crop [0,300,800,900]) so picking other photos changes nothing in the body. Old page had no picker and a single demo-03 hero, so nothing was promised. Fix: either feed `useGipfelbuchPhoto(pickedId)` and recompute marks (peak of that photo; marks for eye/depth at fixed relative positions), or hide the picker/"Follow another photo" strip on this page; compute "patch half-width" from the DemPatch radius or drop that stat.
- HIGH (legibility) Fig. 3 eye-lift bar chart (RealEye, new :145-322; old :123-296; terrain-snapping-new-02 y~140-560). Old: 850 px wide, solid green (Mapterhorn) and salmon (Terrarium) bars with 11 px numerals. New: ~520 px, hatch fills in orange vs grey: at demo-09 the two bars (731 m outlier) are indistinguishable stripes, tick labels (0 m/10 m) ~7 px, and the mono "Bar = metres..." paragraph below is wider than the column and wraps ragged (x=327 vs body x=351). Fix: solid fills (--gb-green/forest for Mapterhorn, --gb-red-tint or ink for Terrarium) with hatch only as an overlay at low alpha; min font 10 px by using viewBox width = column width; wrap the explanatory paragraph in the caption style, not raw mono.
- HIGH (clipped data) Ledger table "Every place a coordinate meets the map" (Details, terrain-snapping-new-02/03; new :585-637, `min-w-[560px]` inside `overflow-x-auto`). The 4th column "WHEN" ("always", "?geoLakeFloor", "Step Inside") is cut off at the panel edge (shows "alwa", "?geo", "Step") and the Rule column is squeezed to ~90 px (5-6 line wraps). Old (terrain-snapping-old-02) showed all four columns. Fix: below 640 px collapse to cards: What + chip on the first line, Role pill + When on the second, Rule below.
- MED Fig. 2 snap map (PeakReal, new :366-583, old :310-516; terrain-snapping-new-01 y~930-1230 vs old-01). Map shrank from 392 px to 270 px; the 9x9 sample grid, which is the whole point ("highest of 9x9 grid"), is now tiny white/black dots almost invisible on the grey hillshade, and the snap line and node markers are 6 px. The readout table (Ramsgrind / DEM at OSM node / snapped point / ...) is 11 px mono with tight leading and the "Does the snap agree..." paragraph is in mono at 9-10 px. Old had green dots at 40 % opacity over a darker hillshade and legible values. Fix: stack map above the readout at full column width (518 px square), draw grid dots with a paper halo (r=3, fill ink, stroke paper) and highlight the highest sample in red; set the paragraph in the body font.
- MED Fig. 1 labels: "Blüemlisalphorn" now handwritten script, 30 px in 800-px photo space with paper halo; readable here on bright sky, but the three marker circles are red outlined rings with dark digits at 18 px (terrain-snapping-new-00 y~680-1000) and the lower markers 1/3 over yellow grass lose contrast vs the old filled dark green discs. Fix: filled paper discs with red ring + ink digit (or filled red with paper digit).
- LOW Photo shrunk: 712 px → 518 px (cross-cutting).
- LOW The Snap/Bound/Hint MiniSvg trio (new :698-837): hatch drawings read fine but the lake hatch teal and the red marker are small (terrain-snapping-new-01 y~190-300); the old dark panels with green point + pink ring were more obvious. Add a 1.4x stroke width.
- LOW Connections graph (old 04) → "On this route" text: acceptable.

### Improvements to keep
- New "How far we search" formula card (r = min(250, 60 + 0.004 d) = 92 m) tied to the live Ramsgrind numbers (new-01 y~650-890); also the numerals are live.
- Details narrative paragraph now has real inline code styling (kept) and the card keeps the engineer-only content collapsed.
- Hero picker (once it drives the page) and the measured stat strip are a good pattern.

### Fix list
1. Wire picker to hero or remove it; fix "0 km".
2. Ledger responsive cards.
3. RealEye solid fills + larger text.
4. PeakReal: full-width map, visible grid.
5. Numbers nowrap.

---
## tap-a-peak

### Regressions
- HIGH (moved out of main flow) MissBars (log-scale bars of median label miss per photo, 3 photos x 5 stages): in old it was main-flow Fig. 4 right after the interactive tap figure (old :1095, tap-a-peak-old-01 y~700-1110); in new it is the second child of `<Details>` (new :1450, labelled "Fig. 6", tap-a-peak-new-03 y~590-1010) and was shrunk to 45 px-wide hatch columns with 8 px labels. This is the page's headline evidence ("after three taps the miss is 0.1 px on all three photos"). Fix: move `<MissBars />` back above "Where it fails" (before the Fig. 4 gallery), 1 column per photo row at full width, solid bars (sensors = ink-grey, taps = --gb-red), values at 10 px.
- HIGH (legibility) Fig. 1 (HeroTaps stage, new :1005-1065; tap-a-peak-new-00 y~1170-1400 + new-01 top). Old stage was 808 px wide and 242 px tall with the yellow detected skyline and cyan DEM skyline clearly separate (tap-a-peak-old-00). New is 534 px x ~160 px; the two lines are now thin wobbly sketch strokes (cyan SketchPath + yellow) overlapping each other and the cloud edges; the tap rings are 6 px open circles. At that scale the viewer cannot see the 19° offset that the stage animates. Fix: crop to the skyline band at 2x height (crop in RealPhoto, aspect 3:1 rather than 5:1), thicken lines to 2.2 px with a 4 px ink halo (or white halo) and make tap rings 10 px with filled ink dot; the stepper chips "BL.01 PHONE SENSORS..." are fine.
- MED Fig. 5 / new Fig. 4 gallery of 3 photos (TapTile new :982-997, tap-a-peak-new-02 y~770-870): thumbs 162 px (was 230 px) with 8 px mono captions overlapping the next row ("-0.75° off" line touches the figure caption) and uneven heights. Fix: tile = thumb + 2-line caption in 10 px, fixed aspect crop, imprint off.
- MED PinLock synthetic stage (Details, new :262-525; tap-a-peak-new-03 y~0-560 vs old-02 y~640-1180): the stage lost its dark sky/panorama gradient (now hatch on paper), the predicted skyline is a black solid and the "real" one a black dashed, but the caption still says "The accent line is the predicted skyline; the dashed cream line is where the real one is" (colours no longer exist). The four readout cards (YAW SOLVED / PITCH SOLVED / ROLL KEPT / FOCAL KEPT) lost their boxes and the label/status pair collide: "YAWSOLVED", "PITCHSOLVED", "ROLLKEPT" (new-03 y~335-390). Fix: accent line in --gb-red, real line dashed ink, caption wording; put label and status on separate lines (flex-wrap/justify-between with gap) and keep the card border only for the "solved" state.
- MED Disambiguation figure (PeakChooser new :549-751; new-04 y~500-760): chart is scaled to ~460 px with 6 px labels ("alt 3", "alt 2", "shown", azimuth ticks), candidate rows wrap onto two lines ("1 Summit / E  0.3° - 0.55° · / 11.7 km"). The coloured +-15° windows became faint hatch. Old (old-03 y~585-940) was legible. Fix: bump the SVG viewBox text sizes by 1.5x, make candidate rows a 2 column grid with `whitespace-nowrap` for numbers, raise window fill alpha.
- LOW Trio step visuals (TrioFrame) are 162 x 50 px strips (new-01 y~1200-1250); the tap markers inside them are unreadable. Old: 190 x 57, equally small, so not a regression; consider showing a single large frame with stage chips instead.
- LOW Four-step flow (Re-solve -> Tap-consistent -> Skyline score -> Preview) wraps to 2 rows with arrows pointing off to nothing (new-04 bottom); old was one row of pills. Fix: vertical list with down arrows.

### Improvements to keep
- New OneTap figure (Fig. 2, new :1067-1235; tap-a-peak-new-01 y~380-1090): the real photo with the measured 24 px right / 86 px up offsets from the image centre, then the formula yaw ~ az - atan((x-cx)/f) = 121.0 deg with live numbers; clearer than the old text-only idea beat.
- Hero photo-with-numbered-tap-rings plus 3 live stats (218 summits in catalogue, 11.7 km nearest, 67.2 km farthest).
- Fig. 3 per-photo picker + readout table retained with all values (yaw/pitch/roll error, focal, labels off, rms, skyline miss).
- The "Pin" ontology card (Words/Is a/Shapes/Method/Known issues) is a richer closing than old.

### Fix list
1. Move MissBars back to the main flow, solid bars.
2. Bigger/thicker sky strip in Fig. 1 with halo lines.
3. PinLock caption colours + readout card collision.
4. Gallery tile sizing, imprint off.
5. PeakChooser text sizes.

---
## peak

### Regressions
- HIGH (clipped/ellipsised data) LabelLayout (Schematic 2, Details; new :689-957, ranking rows near :868 `className="truncate"`; peak-new-06 y~0-130 vs old-04 y~660-790). Rows now read "3 Stockspitz 3699 16 px from G...", "8 Alpligrat 1288 cap reache...", "9 Nollen 699 cap reache...": the reason string, which is the point of the table ("16 px from Grauhorn (< 19)", "cap reached (6)"), is cut off. The minSpacing label wraps ("3.0 / %"). Fix: remove `truncate`, make the row a grid `[1.5rem_1fr_3.5rem_auto]` with `whitespace-normal` for the reason (or put the reason on a second line in 10 px), and keep the colour (red for crowded, muted for cap).
- HIGH (moved/shrunk) Old Fig. 3 "HiddenRings" elevation-vs-azimuth chart (40 tall summits sit 0.1-2.2 deg below the skyline; Aletschhorn 0.2 deg under it) was main-flow in old (old :953-1130, peak-old-01 y~1230-1400 + old-02 y~0-220) with green (labelled), grey (visible) and red (hidden) dots on a dark sky. In new it is in Details as "Fig. 6" (peak-new-05 y~1060-1330) with dark navy/black dots on paper: labelled vs visible dots are the same colour so the legend "labelled / visible, not labelled" cannot be told apart, and the chart is only ~90 px tall. Main-flow replacement is HiddenSummit (new Fig. 3, improvement), which tells the same hiding story for one summit, so only the population view is lost. Fix: keep it in Details if desired but encode with colour (labelled = --gb-green solid, visible = ink 40 % grey, hidden = red hollow) and double the height (180 px); optionally surface it as a small multiple under the Fig. 3 formula.
- MED Fig. 2 numbers inconsistent with the story: stat strip says "in frame, visible 260 / labelled 20 / hidden by terrain 924" (peak-new-01 y~790-850) while the old strip said hidden 40 (tallest 40 kept as rings); the rings drawn are still the tallest ~40, and the text two beats later says "257 visible" and "924 of 1181" (peak-new-02/04). Visible count 260 vs 257 disagree. Fix: label the stat "hidden by terrain (tallest 40 ringed)" or show 40 with the rings, and take 'visible' from one source (`pc` in RealSummits :1388 vs `usePeakData` in HiddenSummit).
- MED Fig. 2 photo labels (peak-new-01 y~430-620; new :1388-1512, old :843-950). In 566 px the summit labels are ~7 px with two-line height+distance stubs ("4274 m · 33 km" above "Finsteraarhorn") and they collide ("Finsteraarhorn" overprinting "Eiger", "Ebenefluh/Abeni Flue" overprinting "Jungfrau"). Old (peak-old-01 y~0-130) used 12 px white halo labels at 808 px width with the same collision on the left but legible. The hidden rings are 5 px crimson circles and hard to find. Fix: crop to the 40-60 deg window with the highest density (REAL_CROP), render labels at 10 px with a paper halo, hide the elevation/distance stub line under 700 px; ring radius 7 and red 2 px.
- MED Fig. 1 compare (peak-new-00 bottom / new-01 top; new :1734-1790 vs old :1179-1230). Phone's guess labels are now pink text with a white halo on pale clouds (low contrast: "Niesen", "Triesthorn", "Seehorn"), and the 566 px frame is ~35 % smaller. The red divider handle with white ring is a good replacement for the old dark handle. Fix: pink to a darker magenta (#c2185b) or draw label chips (paper fill 85 %, magenta text) for the "phone's guess" half only.
- MED RayMarch schematic (Schematic 1, new :252-627; peak-new-05 y~480-880 vs old-03 y~280-790). The dark sky/terrain panel became hatch on paper (fine), but the "HIDDEN · 456 samples" label still overprints the "C · Grauhorn" peak label at top right (existed in old), the verdict/readout grid overflows the right edge ("curve + refr. drop" at x~873 vs panel edge 869), summit-picker chips lost their pill borders so the active one is just a yellow underline ("B · Hohbalm · 24 km") and misaligned with the other two (new-05 y~745-815), and the eye-height slider is a thin wobbly line. Fix: pill buttons with 1 px ink border and filled active; readout grid `grid-cols-2` inside the panel padding; move "HIDDEN · n samples" to the stage's bottom-left.
- LOW Trio step titles misalign (peak-new-01 y~1290 vs 1380) because step 2/3 images carry the imprint (cross-cutting) and step 1's DEM carries a different imprint ("Aufnahme terrarium DEM, 40 km patch").
- LOW Numbers wraps "924 of 1181", "20 of 257" onto 3 lines (cross-cutting).
- LOW Fig. 5 gallery (peak-new-04 y~520-830): labels in the 4 photos are 4-6 px; "20 labelled" is the same for all, so the numbers add little; counts in new are "in frame / hidden / labelled" instead of old "visible / labelled" (178, 265, 88, 177 vs 446, 725, 480, 558): different quantity, so old and new numbers cannot be compared; fine if intended, but mention "in frame" in caption.

### Improvements to keep
- HiddenSummit (new Fig. 3: photo with a "10 px of ridge / Grosses Wannenhorn, hidden" callout, ray diagram eye 1934 m, theta formula with live values, peak-new-02 y~320-1000). Strong and measured.
- YawSlide (new Fig. 4: compass-error slider with ringed true positions and delta-x = f tan(delta-psi) = 32 px, peak-new-03 bottom). New interactive; ties directly to the accept-rule page.
- Fig. 1 phone's-guess/solved-pose compare slider retained; Fig. 2 photo picker (3 photos) and DEM ray map retained.
- Details "Seven shapes" table (mono column with wrapped descriptions) and the Peak ontology card render cleanly.

### Fix list
1. LabelLayout: remove truncate, readable reason column.
2. Restore HiddenRings population chart with colour encoding (main flow as a small figure, or Details with 2x height).
3. Fig. 2 label legibility and consistent counts.
4. RayMarch readout/pill fixes.
5. Fig. 1 label contrast.
