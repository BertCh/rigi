# Gipfelbuch: design and state

The Gipfelbuch is the explainer at `/gipfelbuch` (index) and `/gipfelbuch/<id>` (one sheet per pipeline step), drawn as a Swiss topographer's field book on map paper. This is the one current doc: the rules that apply to the shipped code, the sheet list, the open fixes and the decisions still waiting. How to write a page and the kit API: `src/components/gipfelbuch/README.md` (plus `tafel/README.md` and `viz/LIVE.md`).

State on 2026-10-02: 16 sheets (5f15c550), hand pass and explainer grammar landed, all of it **browser-unverified** (rows in `reports/batch-ledger.md`).

## Code map

| Where | What |
|---|---|
| `src/lib/gipfelbuch/graph.ts` | `GIPFELBUCH_NODES`, in data-flow order (Blatt n = n-th node); `claim`, `summary`, `modules`, `reports` |
| `src/lib/gipfelbuch/graph-utils.ts` | helpers, `MERGED_SHEETS` redirects, `closestSheetIds` |
| `src/lib/gipfelbuch/pages/<id>.tsx` | one bespoke page per sheet (found by `import.meta.glob`) |
| `src/components/gipfelbuch/` | `ConceptPage` shell; `swiss/` sheet theme and furniture; `notebook/` pen kit, Kroki marks, Feldbuch; `viz/` figure kit; `tafel/` hero, ledger, Blattübersicht, Wegnetz |
| `src/routes/gipfelbuch.{index,$concept,print}.tsx` | index, sheet, printed edition; dev previews `/dev/gipfelbuch-sheet`, `/dev/gipfelbuch-live`, `/dev/tafel` |
| `scripts/gipfelbuch/` | bakes into `public/demo/gipfelbuch/`: `build-data.ts` (per-photo JSON), `data-tafel.ts`, `data-sheet.ts`, `bake-diagram-scene.ts`, `bake-ground.ts` (macOS only), `data-*.ts` per page |
| CI rows | `gipfelbuch` (`gipfelbuch.check.ts`), `gipfelbuch-contrast`, `gipfelbuch-notebook`, `tafel`, `tafel-sheets`; specs in `src/components/gipfelbuch/__tests__/` |

## Sheets

Order and chapters from `graph.ts` and `tafel/chapters.ts`.

| Blatt | id | Chapter |
|---|---|---|
| 1–7 | photo, skyline, dem-horizon, viewport-inference, pose-estimate, accept-rule, tap-a-peak | I. Which way was it pointing? |
| 8–12 | dem-source, eye-rule, peak, terrain-snapping, dem-anchoring | II. Where does the camera sit on the terrain? |
| 13–16 | rigi, photo-workspace, camera-roll, step-inside | III. What a known camera is used for |

Merged ids redirect (`MERGED_SHEETS`, `beforeLoad` in `gipfelbuch.$concept.tsx`): baseline-pipeline → viewport-inference, camera-prior → photo, terrain-sampler → dem-source. Unknown ids get an in-page "did you mean" (`closestSheetIds`), not a 404.

The index is: hand contents, the **Wegnetz** (the concept graph drawn as a trail map, `tafel/Wegnetz.tsx`), the Niederhorn `SheetMap`, the picker-driven **Blattübersicht**, then the **Feldbuch** (`NotebookMap`).

## User rulings (these override every older design doc)

- One look everywhere: a Swiss-map field notebook, written by hand and sketched. Hand is the form; print is only code, equations and opt-in `.gb-print` (hand pass, 2026-10-01).
- Hand lettering face is Architects Daughter (Caveat was too hard to read, 2026-10-02).
- No paper grain or texture, tape, tilted photos, red margin rule or sheet-edge ticks; the soft grid stays.
- No outlines around sections or cards, strokes only for state, no decorative or coloured shadows.
- No node-link graphs, except the concept graph as the hand-drawn Wegnetz trail map.
- Every single-photo figure and animated sequence gets a side spill that maps to what it shows (supersedes "one spilled photo per sheet").
- Peak notebook (D-PN1–4): paper in both themes with the Tafel on a `--gb-paper-deep` plate; H1 = name, claim = dek; picker-driven Blattübersicht as the index.
- 19 → 16 sheets, merged ids redirect (5f15c550).

## Canon

Checked against the code on 2026-10-02. File names are under `src/components/gipfelbuch/` unless given in full.

**Type**
- Only the `--gb-font-*` role tokens (`swiss/fonts.css`, on `.gb-swiss, .nb-book`); never name a face inline (lint).
  - body `--gb-font-body` = Playpen Sans (GB Hand Body);
  - titles, h2/h3, `.display-title`, `HandText`, `MarginNote`: `--gb-font-letter` = Architects Daughter (GB Hand, `size-adjust: 92%`, `font-size-adjust: ex-height 0.5`);
  - caps (kickers, table heads, peak and place names): `--gb-font-caps` = Patrick Hand SC, `.gb-caps`;
  - numbers: `--gb-font-figure` = Shantell Sans, tabular (`.gb-num`, `.gb-coord`, `HandLabel`);
  - print: Fira Mono for code, Source Serif 4 for `--gb-font-math`, Fira Sans for `.gb-print`.
- Sizes only from `TYPE` in `swiss/type.ts` (scale 11/13/16/20/24/40/56; roles micro, kicker, caption, body, lead, h3, h2, claim, h1, display, hand, handLabel, stat). Unit 6 px, line 24 px (`GB_UNIT`, `GB_LINE`).
- Body measure at most 66ch; headings balanced, prose `text-wrap: pretty`.
- Italic is a category: `.gb-water` (water names), `.gb-derived` (estimated values). Tables use `.gb-table` (hand caps head, pen rule, right-aligned tabular numbers, no cell borders).
- Fonts are self-hosted OFL subsets in `public/fonts/gipfelbuch/` (`LICENSES.md`; also in `NOTICE.md`).

**Ink**
- Brezine swatches as `--gb-*` (`swiss/theme.css`, `swiss/palette.ts`, `SWISS` in `swiss/inks.ts` for canvas and node code): ink LK, contour NB, water GL, forest GG, red SR, navy PB, sign SY/YY, pencil GR, secondary BG, relief BL (hairlines only, 2.8:1, never text).
- Roles: ink = axes, series, text; pencil = prior or uncertainty; brown = DEM and terrain; water = image-measured; forest = result; navy = peaks; red = route and "the answer", at most one red emphasis per figure.
- Paper `--gb-paper` (W 96% + YY 4%), `--gb-paper-deep` (+ LG 9%); `--gb-grain: none`. Soft grid `--nb-grid` 6%, index ruling 8%, cell 24 px.
- Text is ink, `gb-secondary` or a semantic ink, never an alpha ladder. Every text ink is ≥ 4.5:1 on paper and paper-deep (`swiss/contrast.check.ts`).
- Inside `.gb-swiss` `--color-white` is ink and `--rigi-paper`/`--rigi-ink` are swapped; pages must not use `var(--rigi-paper)`. Never put a resolved `color-mix()` in an SVG attribute. Role aliases must be declared on `.gb-swiss` and on `[data-theme="dark"]` scopes.
- Photo-layer colours come from `viz/inks.ts` (`LAYER_INKS`, `inkFor(layer, "photo"|"paper")`); a key swatch is drawn exactly like the stroke it names.

**Layout**
- `ConceptPage` grid with named lines (Standortfeld, text, margin and rail); figures use the wide track, never widen the prose column (`viz/Figure.tsx`).
- Space separates; no `border`/`ring`/`outline` boxes and no rounded cards; wells use paper-deep fill.
- Sheet order: register entry, lettered H1 with marker underline, claim as hand note, Tafel hero (or the page's own hero, `PAGE_HERO` in `tafel/sheets.tsx`), ledger (exactly 3 measured items, `sheets.check.ts`), field notes, one `HandRule`, body, closed Glossar (`OntologyPanel`), `SheetColophon`, closed "Für Entwickler" `DevFold`, Signposts, `NotebookTrail`.
- Pages work at 390 px: `viewBox` SVGs, `w-full h-auto`, no fixed widths.

**Hand and sketch**
- Measured marks (`data` on `SketchPath`, `SketchPolyline`, `PenLine`, `PenCircle`, `HandDot`) are one constant-width pen pass within `DATA_TOLERANCE` = 0.5 px (`notebook/Ink.tsx`); furniture gets two passes. `PlotSeries` is exact.
- Certainty is line style (solid measured, dashed 4/2 modelled, dotted open), never wobble.
- Photos and DEM rasters are never filtered, tinted or hatched; overlays on photos use `CrispLine` (`viz/real.tsx`).
- Seeds are stable strings, never array indices. Areas use `Hachure` (one angle per figure) or `Stipple`.
- No raw SVG `<text>` in pages: `HandLabel`, `HandNote`, `HandText` (`viz/labels.tsx`). Hand notes tilt at most 4° (`MAX_HAND_TILT`); labels and photos stay upright.
- At least 6 hand notes per page (`MIN_HAND_NOTES`): leaders, struck guesses with red corrections, circled numbers keyed to figures.
- Kroki and LK vocabulary in `notebook/carto.tsx` and `swiss/Marks.tsx`; prose marks in `notebook/marks.tsx`. `#nb-wobble`/`#nb-grain` only on dense legacy art, never on text, photos, rasters or animated groups.
- Kitsch test: every material element carries a fact.

**Figures**
- A caption is one claim sentence with one measured number; caveats go to a margin note, hand note or Details. Synthetic figures carry `source="Skizze"`; a figure fixed to one photo uses `pinned="demo-NN"`.
- Numbers come only from `public/demo/gipfelbuch/*.json`, the bakes or `reports/`.
- Single-photo figures spill (`RealPhoto bleed`, `viz/GeoSpill.tsx`); Trio, Gallery and thumbnails never spill. The spill's solved horizon meets `solvedRows` at the frame edge within 0.5 px (`__tests__/geo-spill.spec.ts`).
- Overlay stack (`viz/overlay.tsx`): ground, raster, derived, measured, furniture, notes, interaction; derived sits under measured; at most 8 labels per layer.
- Ground: photos are never altered, only the surrounding ground (`--fig-*` vars, `viz/ground.ts`, `ground-palette.json`); read them with fallbacks.
- Photo story (`viz/storyFilm.ts`): guess = setup, measure = evidence, correct = change, snap = result; a refused solve ends on "keep". Every number is read from the photo JSON; no faked search sweep.
- Synthetic diagrams sit on the demo-09 real ground (`viz/diagram-scene.json`) and show only what a photo cannot.
- At most one live plate (GPU engine) per sheet (`viz/LIVE.md`).

**Motion**
- Tokens in `viz/motion.ts` (`MOTION`, `EASE`), mirrored as `--gb-dur-*`/`--gb-ease-*` in `swiss/theme.css` (pinned by `motion-css.spec.ts`). No springs or overshoot.
- Arming: single bloom at 0.75 in view, sequences at 0.45, reset below 0.2. Playback is once, replaying on return, pointer rest or tap; `loop` is opt-in.
- Static is the design: under reduced motion, webdriver, print or no IntersectionObserver every figure shows its settled last frame with all notes. Drags write the DOM, not React state. No wheel or scroll hijacking.
- Sheet links use `sheetTransition()` (`view-transition-name: gb-sheet`), only under `prefers-reduced-motion: no-preference`.

**Copy**
- Claim (dek): one sentence, at most 60 characters, no digit. Tagline 1–90 characters. Never "Next:"; never call it "atlas".
- Sentences of 15 words or fewer, plain words, active voice; explain a term once; code identifiers only in Details. Reader text carries no paths, script names or dates (`Measured` puts provenance in `title`).
- Killed ideas are told with what was measured, in a `negative` callout.

**Accessibility**
- Focus ring 2 px `--gb-red`; `forced-colors` and `prefers-contrast: more` blocks in `swiss/theme.css`; the Stages caption is `aria-live`; interactive figures keep keyboard handling.

**Lint (`gipfelbuch.check.ts`).** Node fields, claim and tagline rules, existing `modules`/`reports` paths, a connected graph with ≥ 2 edges per node, ontology links. Page rules (skip a line with `// gb-lint-allow`): half-pixel sizes, `text-white/<65`, `rounded`, inline font names, `display-title` outside the shell, dark-theme layer hexes, `decoration-white`, `var(--rigi-paper)`, `rotate-N`, raw `<text>`, `ring-1`, `Next:`, `color-mix` in SVG attributes, duplicate `Fig.` labels, fewer than 6 hand notes.

## Decisions waiting for the user

From the explainer pass (2026-10-02); none answered in code yet.

1. **Playback.** Should Stages loop, and should the rigi hero loop like the landing? (Now: once, replay on return.)
2. **Compare intro.** Keep the one-time wipe from guess to split (`compareIntroX`)? The landing has none.
3. **Hero bloom** on by default for spilled heroes: it may flash one frame on load (one-line switch-off).
4. **Photo story.** Keep the guessed numbers ghosted in the last frame? Is 12.9 s the right length (landing scene: 28 s)?
5. **Gallery.** Verdict circle on or under the photo? "2nd solver": caution or result? A wide-track option for galleries without a spill?
6. **Diagrams.** demo-09 as the one real ground, or follow the picker? Stated vertical exaggeration acceptable? Is "no evidence after a change" too strict (PinLock works around it)?
7. **Maps.** Keep the Imhof SVG ramp filter on DEM rasters (`swiss/imhof.tsx`), or bake the ramp ("never filter DEM rasters")? Make the correction arc navy so it does not read as a second red?
8. **Rock and glacier mask** for `RockHachure` from swissTLM3D land cover (design book D5): not built, not decided.

## Open fixes

Verified against the tree on 2026-10-02. Priorities from the 2026-10-01 comprehensive review.

**Data**
- P0: `public/demo/gipfelbuch/demo-02..12.json` have `ms.terrain = 0` (only demo-01 has 120). `build-data.ts` is fixed; rebake. The viewport-inference terrain-time ledger reads it.
- P0: the shell copy in `ConceptPage.tsx` promises every number follows the picker, but many figures are fixed to one photo: mark them `pinned` or make them follow; `photo.tsx` Fig. 2 (YawBars) ignores the picker.
- P0: no check compares the bakes with each other.

**Accuracy (page text)**
- `photo.tsx` ~1787, 1843: "magnetic heading is first corrected to true north" holds only in `mapPriorsFromPhoto`; `geoDecl` defaults off.
- `peak.tsx` ~1849: "every label moves by the same px per degree" (measured 32–47 px at 3°, it varies by peak).
- `viewport-inference.tsx` ~1940: credits the wild benchmark with the IMG_7053 −123.7° false accept; it came from the heading-removed ablation (`reports/bench-ablation.md`). Same in `src/lib/geo/solve.ts:268` and `src/lib/geo/README.md`.
- `viewport-inference.tsx` ~1892, `dem-horizon.tsx` ~1897: "fast method ~0.3 s"; the measured demo run is 3.5–5.3 s.
- `terrain-snapping.tsx` :46, :792: cites `engine.ts buildPeaks`, which does not exist.
- `dem-horizon.tsx` :830, :1989: "Invented terrain" / "the invented ray" over the real demo-09 ground; also "out to 150 km" (:830, :1825) while the app caps at 120 km.
- `skyline.tsx` ~1345 and dem-horizon equation colour words: stale layer colours after the ink change (also check accept-rule, step-inside, dem-source, terrain-snapping maps).
- Step-review corrections not applied (text for each in `reports/archive/steps-2026-10-02/<step>.md`, "Gipfelbuch corrections"): `graph.ts` summaries still say "About a dozen hand-set thresholds", "second source, kept secondary", "On the test photos"; `eye-rule.tsx` ~1370 "optional check"; `dem-source.tsx` ~1827 "100 test photos"; `photo.tsx` ~699 "Tags are read as written"; summaries and `modules` of camera-prior (now photo), skyline, dem-horizon, peak, eye-rule, tap-a-peak ("pinned is endorsed"), dem-anchoring ("faded" → "labelled low trust"), camera-roll ("slowly varying" → "correlated over about a minute"), pose-estimate, photo-workspace and step-inside describe research paths rather than the live app.
- Unsure, re-check: step-inside figure labels (Fig. 1/5/3 vs D1–D3), the tap-a-peak "taller C ranks first" caption, the accept-rule gates table, the rigi "17/17 HIGH" tile attribution, the Mapterhorn zoom table's missing 6–15 km band in dem-source.

**Explainer follow-ups**
- Held hunks: `frame: "photo"` on the dem-anchoring, step-inside and tap-a-peak Stages; `kind: "change"` on eye-rule's "The rule" stage; drop `bleed` on the rigi Gallery (`rigi.tsx:240`); SheetMap `follow` on the index (`gipfelbuch.index.tsx:232`, follow code dormant until then).
- `--fig-*` ground is set only on photo-workspace, viewport-inference and the live plates; RealPhoto bleed and StoryMap do not set it.
- Perf: `PhotoStory.tsx:1175` private rAF clock → `useBeatClock`; make story `t` subscribable so RealPhoto and GeoSpill skip re-renders during the turn; move the 23 settled `useTime` figures to the shared clock; Trio arms on `useInView` instead of the 0.45 sequence arming.
- Unused kit: `PeakLeader`, `StationRays`, `ContourScribble`, `SpotX`, `TrigTriangle`, `ProfileSketch` (`notebook/carto.tsx`), `LiveTopoBoard`; `AutoVisual`, `NoImprint` still live.

**A11y, theme, print**
- No `color-scheme: light` in the Gipfelbuch, so native controls render dark.
- `role="button"` groups inside `role="img"` SVGs (photo-workspace ~892–953, camera-roll ~1527/1696, accept-rule ~319) are hidden from screen readers.
- `GB Sans Condensed` is declared but unused (101 KB); 640–800-unit viewBoxes put labels at 5–7 px on phones.

**Architecture**
- Stale "Caveat" in code comments (the face is Architects Daughter): `notebook/Ink.tsx` ~54, ~318; `viz/MarginNote.tsx` ~16, ~28; `viz/Figure.tsx` ~25; `viz/Section.tsx` ~10. `MarginNote.tsx` still cites "design book H6" (archived).
- `useWidth` duplicated (StoryMap, Tafel, three `site/meta` files). Pages are 800–2,500 lines with Details inline.
- `peak.tsx` ~897, `tap-a-peak.tsx` ~959: `fetch().then(r => r.json())` without `r.ok`, promise cached.
- Check gaps: `sheets.check.ts` accepts scaled or raw values; `tafel.check` passes with no bakes.

## Numbers pages must respect

- App test set: 12/14 within 1°, 0 false accepts (`reports/status.md`). Wild set (100 photos): 60 accepted, 39 correct, 19 wrong, 2 unsure (precision 0.64, `reports/bench-wild.md`); keep the 2 unsure.
- Accept bar 0.5 rests on 14 photos and sits between 0.48 (correct, rejected) and 0.51 (accepted); it was tuned on that set.
- Skyline "0.30°, 11 of 11 within 1°" is the curated GT set, not held out.
- demo-10 peaks: 1181 in frame, 924 hidden by terrain, 257 visible, 20 labelled.
- demo-09 GPS altitude 1183 m vs ground 1913 m; eye = `max(alt, ground + 1.6 m)`; display uses 1.8 m without altitude (open, see roadmap).
- Horizon: k = 0.13, about 1,275 samples per azimuth, 7,200 azimuths; app cap 120 km.
- Measured 2026-10-01 demo run: 10/12 accepted (demo-07, demo-11 rejected: a person occludes the skyline); compass errors −19° to +11.5°; median skyline residual 5–43 px prior → 0.9–7.7 px solved.

## Browser batch (one pass, under the render lock)

`/gipfelbuch`, every `/gipfelbuch/<id>`, `/gipfelbuch/print`, `/dev/gipfelbuch-sheet`, `/dev/gipfelbuch-live`; light and dark, 375 px and 1440 px. Look at: font loading (Playpen, Patrick Hand SC, Architects Daughter) and title sizing under `font-size-adjust`; label overlap with the wider hand faces; the hero bloom's first frame; the story film's horizon meeting the spill at the frame edge; Stages crossfades; the Trio grid; wash and pencil filter cost; `fill="var(--gb-paper)"` SVG attributes in Safari and Firefox.

## Research kept

- `reports/archive/gipfelbuch-design-book.md`: the research behind the sheet (Swiss cartography and typography, field books, NPR) and the rule ids (T, I, G, L, F, H, A) that code comments cite.
- `reports/archive/gipfelbuch-swiss-cartography.md`: LK symbology, swisstopo web colours, Kroki conventions, the S1–S32 primitives cited by `notebook/carto.tsx`.
- Key facts: Jenny et al. 2014 rock drawing (about 7 strokes per 2 mm, mean width 0.12 mm); Jenny, Hutzler and Hurni 2010 scree (4–8-corner polygons, boulders about 1.5 mm); LK contours take the surface colour (earth brown, rock black, glacier and lake blue), index every 100 m at 1:25k. swisstopo is Swiss OGD, credit "© swisstopo".
- Earlier design docs (swiss aesthetic, notebook research, sketch rendering and inventory, field-notebook design, regression, restore, best-of-both, hand-sketch spec, explainer specs, peak-notebook plan and prototype, comprehensive review) were deleted on 2026-10-02; their surviving rules are above and they are in git history.
