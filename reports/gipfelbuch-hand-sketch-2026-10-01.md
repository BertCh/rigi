# Gipfelbuch hand pass (2026-10-01, night)

User goal (session mt-image-16): "we lost our nice notebook style gipfelbuch is an informal type thing that is hand written and all visuals are sketches. do a comprehensive research on sketch style, swiss cartography, swiss mapping including swiss topo stuff, and style our gipfelbuch pages more agressively."

Research (in `reports/gipfelbuch-hand-sketch-research/`):
- `sketch-style.md`: real notebooks (summit registers, Feldbuch, Darwin, Laws, Heim, Imfeld, Imhof), page grammar, rough.js / perfect-freehand presets, pencil and wash filters, hand marks on HTML, a font system, prop verdicts, 27 ranked moves.
- `swiss-cartography.md`: LK symbology checked against swisstopo's 2008 legend, live swisstopo web-map colours, heritage (Siegfried, Imhof, Imfeld, glass scribing), the Kroki field sketch, SAC and hiking conventions, LV95 formats, 32 sketch primitives (S1–S32), 20 ranked moves.
- `audit.md`: a forensic diff of the five archived snapshots against the current tree. The notebook look was not lost in the shell; it was lost in the figure kit. From peak to now, hand notes fell from 224 to 41, printed labels rose from 0 to 132, exact data marks from 12 to 124, and the lint capped hand notes at 3 per page.

## 1. Direction: hand is the form, print is the exception

This pass reverses the "print is the form, the hand is the observer" rule (design book 11 and 52–54, best-of-both KR1/KR6/KR11). The Gipfelbuch is now a page of handwritten field notes:

| Role | Face (token) | Where |
| --- | --- | --- |
| Body | Playpen Sans, `--gb-font-body` (GB Hand Body; 7 alternates per glyph, so letters don't repeat) | the whole `.gb-swiss` / `.nb-book` ground |
| Lettering | Caveat 700, `--gb-font-letter`, `font-size-adjust: ex-height 0.5` | `.display-title`, every `h2`/`h3` |
| Block capitals | Patrick Hand SC, `--gb-font-caps` | `.gb-caps`, `.nb-label`, table headers, peak and place names (`HandLabel caps`) |
| Hand figures | Shantell Sans, `--gb-font-figure`, tabular | `.gb-num`, `.nb-num`, `.gb-coord`, `HandLabel` |
| Notes | Caveat, `--gb-font-hand` | `HandText`, `MarginNote`, captions |
| Print | Fira (`--gb-font-print` via `.gb-print`), Fira Mono, Source Serif (`--gb-font-math`) | code, equations, and the opt-in `.gb-print` |

Numbers are written by hand too: a surveyor's field book is all hand figures. Columns stay aligned with tabular figures. This departs from the cartography report's "digits stay print" (from Song et al.); the user asked for a hand-written book.

## 2. What stays (earlier user rulings)

- No paper grain, tape, tilted photos, red margin rule or sheet-edge ticks. Keep the soft grid. (feedback-gipfelbuch-softer)
- Photos and DEM rasters are never filtered, tinted or hatched.
- Data stays on its pixels. A `data` mark is now **one hand pen pass within `DATA_TOLERANCE` = 0.5 px**, at constant width, instead of plain geometry (`notebook/Ink.tsx`). Furniture gets two passes and more roughness.
- One spilled photo per sheet (`RealPhoto bleed`, `PAGE_HERO`), with d5's alignment story intact.
- No node-link graphs, no decorative shadows, no doodles without a fact.
- Hand-note tilt is at most 4° (was 2°). Labels on drawings stay upright.

## 3. Kit changes (done in the core pass)

- `swiss/fonts.css`: GB Hand Body (Playpen Sans) and GB Hand Caps (Patrick Hand SC), self-hosted and OFL (`public/fonts/gipfelbuch/LICENSES.md`), plus the role tokens above.
- `swiss/theme.css` and `notebook/notebook.css` repoint the shared classes to the hand roles.
- `viz/labels.tsx`: `PrintLabel`/`PrintNote` became `HandLabel`/`HandNote` (same props, renamed across all 288 uses, plus `caps` and `italic`).
- `notebook/Ink.tsx`: data mode becomes a bounded pen pass; `HandDot data` wavers below 6 %; `MAX_HAND_TILT` = 4.
- `gipfelbuch.check.ts`: the cap of 3 hand notes per page is replaced by a minimum.

## 4. Work packages

Kit (parallel, disjoint files):
- **K-A, cartographic sketch kit**: `notebook/carto.tsx`, `notebook/marks.tsx`, `SketchDefs` filters.
  - New primitives: `TrigTriangle`, `SpotX`, `SummitCross`, `RockHachure`, `ScreeStipple`, `KrokiHatch`, `HandScaleBar`, `NorthArrow` (declination fan), `KrokiTitle`, `TrailLine`, `Blaze`, `GradeBox`, `HandName` (LK class lettering), `PeakLeader`, `StationRays`, `ContourScribble` and `ProfileSketch`.
  - Hand marks for prose: `HandMark` (underline, double, wavy, circle, box, strike, highlight, bracket).
  - `Wash` (watercolour wash, off-register, multiply blend) and `PencilLayer` (`#nb-pencil` construction layer).
- **K-B, viz primitives**:
  - Figures: hand "Fig. n" lettering and hand captions.
  - Sections: lettered headings with a partial marker underline.
  - Callouts: the three Laws voices (notice, wonder, reminds me of), plus one boxed conclusion with overshoot.
  - Steps: circled stations.
  - Plot: pen axes that stop short, hand ticks and titles, direct labels.
  - explain: sketched boxes.
  - real.tsx: the photo overlay's top stroke becomes a pen pass, with hand-caps peak names.
  - Also `HandRange`, `MarginNote` and `StoryMap`.
- **K-C, shell and furniture**:
  - Every sheet opens with a register entry (date, time, place and altitude, weather, initials, route).
  - The H1 is lettered with a marker underline, with one fact-bearing stamp per sheet.
  - The index is a hand table of contents.
  - The Tafel hero is sketched.
  - Furniture: a hand Wegweiser (prev/next), a hand scale bar, hand LV95 ticks, italic hand heights, pencil contours in the ContourField, and a Kroki title block.

Pages (after the kit, by page group): every sheet gets the full grammar.
- Notes: hand notes with leaders, at least 4 per page (`MIN_HAND_NOTES`).
- Corrections: struck guesses with red corrections, and circled numbers keyed to figures.
- Figures: a pencil construction layer under each figure, washes where an area means something, and Kroki hatch instead of flat tints.
- Map figures: the Kroki title on every map-like figure, with peak leaders on every skyline.
- Remaining crisp shapes become pen primitives.

## 5. Verification

Per change: `npx tsc --noEmit -p .`, `npx biome check --write <files>`, `node scripts/ci/run.mjs fast --only gipfelbuch,gipfelbuch-notebook,gipfelbuch-contrast,tafel,tafel-sheets`, then the whole fast tier before commit. Browser-unverified: no browser runs in cook mode. The batch pass should check `/gipfelbuch` and every `/gipfelbuch/<id>` in both themes, plus `/dev/gipfelbuch-sheet`. It should look at font loading (Playpen, Patrick Hand SC), title sizing under `font-size-adjust`, label overlap in figures (hand faces are wider than Fira Mono), and wash and pencil filter cost.
