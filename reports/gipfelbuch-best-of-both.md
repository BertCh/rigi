# Gipfelbuch: best of both worlds (audit, spec, work packages)

Date: 2026-10-01. Code-only audit: nothing was rendered, measured or run. It compares five snapshots (1 explainer at 034856d → 5 current, under `scratchpad/snap/`) with the live tree.

**Summary.** The real data and the figure inventory survived every iteration. Every page still has its real-photo heroes, Trios, galleries, pickers and sliders, and most pages gained an `Eq` card and one strong new real figure. What regressed is the frame around the figures, in three ways:
1. **Two heroes stacked.** The shell's Tafel has a generic caption, and the page's own claim-captioned real-photo hero sits right under it.
2. **The notebook pen reached the data.** `SketchPath data`, `PenLine`, `PenCircle` and `HandDot` still jitter measured lines, rays, dots and bars, including lines drawn over photos.
3. **Too many furniture layers compete.** Provenance is stated 4 times per sheet, numbers sit in 3 rows, there are 2 Waymarks, 2 "next" devices, a footer legend of symbols the page doesn't draw, and 13 copies of page-local label and slider helpers.

The Swiss field-book identity was carried by a handful of devices: paper and the Swiss inks, the soft grid, the plain red Blatt number, real contours, the Tafel's compass ruler and spill, Wegweiser signposts and the follow-one-photo field notes. The soft grid was lost silently (`.nb-book` is applied only in components that were not mounted). 2d is now restoring the contour header, FieldNotes, the NotebookTrail and the NotebookMap index.

The target, in short:
- The page's explainer hero becomes *the* hero, printed as a Tafel (`RealPhoto bleed` on a wide Figure), and the shell Tafel steps aside on those sheets.
- Data lines are exact and only furniture wobbles.
- Every sheet gets a fixed furniture budget.
- The explainer recipe stays: hero → idea → trio → mechanism → failure gallery → numbers → details.

Ownership (coordinator, 2026-10-01):
- **2d** owns the kit (ConceptPage, `viz/**`, `swiss/**`, `notebook/**`, `tafel/**`, routes) and 7 pages: dem-source, terrain-sampler, eye-rule, dem-anchoring, photo-workspace, camera-roll and step-inside.
- **Session 25** owns the other 12 pages.

Ref convention:
- `1:` is the explainer snapshot (034856d; old directory names), `pages/<id>.tsx`.
- `5:` is the current snapshot, `src/lib/gipfelbuch/pages/<id>.tsx`, or `src/components/gipfelbuch/...` for kit files.
- 2d has edited the kit since snapshot 5, so kit line numbers may have drifted. The page line numbers were valid when the snapshot was taken.

---

## 1. Audit

### 1.1 Each state, in one line

| State | Did well | Did badly |
| --- | --- | --- |
| 1 explainer (034856d) | Real photo first, with a caption that states the claim. A strict recipe (Beat, Trio, Gallery, Numbers, Details). Crisp overlays with a dark under-stroke. Beat claims at 27–31 px bold serif. Figures with the photo the size of the prose column (712 px). One "Next:" line. | Dark site theme. `rounded-2xl ring-1` cards around every figure, Trio tile and Details. A coloured radial glow blob behind the header (`1:ConceptPage.tsx:206-216`). Pill chips. A force-graph "Connections". Half-pixel mono sizes and alpha-ladder text. "atlas" naming. |
| 2 swiss-sheet | Paper and three inks plus route red (Brezine). `SheetFrame` with LV95 corners and imprint. `Waymark` status. `Signpost` prev/next. `SheetMap` index on real data. `Eq` cards on all 19 pages. RollCompasses, RealSplit. | Graticule ticks, grain and the cream paper (later judged "clumsy"). The force graph was still in the shell. |
| 3 sketch notebook | A strong single look: the hand, circled numbers, pen arrows, Hachure terrain. FieldNotes as a chained, numbered, measured narrative for the followed photo. | Everything hand-drawn, data included: 200 `HandText`, 125 `SketchPath`, 98 `Hachure`. Hatching became the value encoding (R2), and Architects Daughter appeared on labels. |
| 4 field notebook | A design system: the `TYPE` scale, 6/24 grid, page lint, `Standortfeld`, route-topo Steps, the contrast gate. | Furniture inflation: a rail plus the Standortfeld, a contour header, a HandRule, a HachureRule and a Legend plus ScaleBar on every page. The data was still sketched. |
| 5 current | Wide figure track (R1). Crisp RealPhoto overlays (R7). `Stat`/`Numbers` sized by container (R3). `NoImprint` (R6). Ledger. Tafel with ruler and spill. Picker shared across sheets. Colophon in place of the rail. Softer sheet. | Double hero. Data still jitters (see 1.4). Furniture repeated (1.5). Dead kit (1.6). The soft grid is gone. Beat claims dropped to 20/24 sans, the same as `Section` h2 (`5:viz/explain.tsx:58`). |

### 1.2 The shell: explainer vs current

| Element | 1 (`1:ConceptPage.tsx`) | 5 (`5:ConceptPage.tsx`) | Verdict |
| --- | --- | --- | --- |
| Header | Title 2.6–3.8 rem serif, tagline, 4 pill chips (:246-269) | Eyebrow (red mono Blatt, group, Waymark), H1 at `TYPE.display` 56, claim dek, lede, Ledger (:125-166) | Keep 5. |
| Hero | None; the page's own Fig. 1 came first (:280) | Shell `Tafel` with the **generic caption** "The photo band with its measured skyline…" (`5:tafel/Tafel.tsx:255`, no caption passed at :169) | **Conflict:** two heroes. Fix in §2.1. |
| Picker | Per figure | Shell `PhotoPicker` (:172) plus 12 page pickers, some with local state (R9) | One picker. Page figures follow `useNotebookPhoto`. |
| Body width | `max-w-[760px]` article plus a 270 px rail | Prose in cols 3–8; figures break out to col 12 | Keep 5. |
| Provenance | `Measured` captions | SheetFrame imprint (:123) + LV95 corners (:122) + Tafel micro line (`Tafel.tsx:261`) + Figure/RealPhoto imprints + `Measured` | Too many. Budget in §2.5. |
| Status | Chip + rail | Waymark in the eyebrow (:146) **and** in the colophon (`SheetColophon.tsx:76`) | Keep one, in the eyebrow. |
| Connections | Force graph (banned) + NodeCards | Colophon "On this route" + 2 Signposts + (2d) NotebookTrail "Where it sits" | One device; see §2.5. |
| Next | Rail cards + a page "Next:" paragraph | Signposts (subtitle "1 Blatt") + a page "Next:" paragraph on 18 pages | Signposts only, with the subtitle set to the target's claim. Drop the page "Next:" lines. |
| Legend | None | Footer `Legend` of 2 map symbols (`legendItems.tsx`); most sheets draw no map symbol | Remove it from concept pages (F1: per-page and true, or none). Keep it on the index. |
| Soft grid | n/a | **Missing**: `.nb-book` (`notebook.css:39`) is used only by `NotebookMap`/`ConceptNotes`, and neither is mounted in 5 | Restore it on the sheet ground. |

### 1.3 The kit: explainer vs current

| Component | 1 | 5 | Verdict |
| --- | --- | --- | --- |
| `Figure` | `rounded-2xl ring-1` card, `bleed` = `-mx-12` | No frame, wide track, `well`, `imprint`, `number`, `reading`, deprecated `tape` (`5:viz/Figure.tsx`) | Keep 5. Drop `tape`. Add `plate` (KR3). |
| `Beat` title | 27–31 px bold serif (`1:explain.tsx:55`) | 20/24–24/30 sans semibold (`5:explain.tsx:58`) | Claims no longer outrank Section heads. Serif 24/30 (KR5). |
| `Trio` | Ring cards, accent numeral | No cards; `StepNumber` circled hand numeral; wide track | Keep 5. |
| `Numbers` | 2 rem accent serif between border rules | Container-sized mono, no rules, wide track | Keep 5. |
| `Compare` | White handle, black pills | Red sketched wipe line, PenCircle handle, paper labels | Keep 5. The handle is furniture. |
| `Mark`/`MarkList` | Dark disc, accent numeral | Paper disc, sketched ring, red PenCircle list | Keep 5. These are annotation. |
| `Key` | Solid line | `SketchPath` with a `color-mix(...)` stroke **written as an SVG attribute** through `Passes` (`5:explain.tsx:595-605`, `Ink.tsx:375`) | Violates invariant 4. Put the stroke in `style`, or use a token (KR7). |
| `RealPhoto` lines | Plain path + dark casing | `PhotoLine crisp` (`5:real.tsx:256-304`), deeper hues | Keep 5. |
| `RealPhoto` labels | Accent text, dark halo | White condensed text, dark halo, `HandDot` summit | Keep. Fix the overprint on close summits (KR8). |
| `DemPatch` cones | Plain | Sketched within 0.65 px (`5:real.tsx:738,748`) | Make exact (KR1). |
| `Plot` series | Plain | Redrawn by hand within 0.9 px (`5:viz/Plot.tsx:21-37`) | Make exact (KR1). |
| `SketchPath data` | n/a | Still runs `sketchify`, one pass, ≤ tolerance (`5:notebook/Ink.tsx:409-423`) | Not exact. KR1. |

### 1.4 Data wobble found (code)

Measured lines that still jitter:

| Where | Page lines |
| --- | --- |
| Over a photo | tap `5:818-832`, dem-horizon `5:1143-1150,1483`, pose `5:1426-1456`, baseline `5:2125`, photo `5:323` |
| Over a raster | terrain-sampler `5:1054`, terrain-snapping `5:410-430` |
| In plots and real-data figures | skyline `5:1070,595-613,941-951`; dem-source `5:236,244,352,359,390`; peak `5:1091,1099,1108,1633`; viewport `5:403-445,1015`; dem-horizon `5:1233`; camera-prior `5:1341` |
| Real data drawn with pen helpers that have no `data` mode | camera-roll rays `5:1485-1497`, GPS circles `5:1471`, links `5:1359`, cones `5:1884-1905`, bias bars `5:1696-1712`; step-inside knots `5:1466`; dem-anchoring dots `5:1798+` |

### 1.5 Cruft: devices competing on one sheet (state 5 plus 2d's restores)

| Kind | Instances per sheet | Target |
| --- | --- | --- |
| Provenance lines | SheetFrame imprint, LV95 corners, Tafel micro line, Figure `imprint`, `Measured` in captions | Two: the hero caption's `Measured`, and the colophon (imprint + LV95 corners). |
| Rows of numbers | Ledger (3), FieldNotes (2d, numbers again), `Numbers` (4), `Stat` in Details | Ledger = this photo. FieldNotes = the chain of *decisions*, with no number repeated from the Ledger. `Numbers` = the corpus (12 photos or the wild set). |
| Status | Waymark ×2 | 1 |
| Route and next | Signposts, colophon "On this route", NotebookTrail + "Leads to/Referenced by" (2d), page "Next:" lines | Signposts + one route device (2d's NotebookTrail **or** the colophon list, not both). No page "Next:" lines. |
| Pickers | Shell + 12 page `PhotoPicker`s | One shell picker. A page picker is allowed only if it writes `useNotebookPhoto`. |
| Terrain headers | ContourField (2d) + Tafel spill + hero `bleed` | ContourField at ≤ 0.2 opacity + **one** spilled hero. |
| Rules | HandRule under the header and per connection group (2d, `ConceptPage.tsx:183,361`) | One sanctioned rule under the header at most (canon 8). None between sections (canon 9; user, 10-01). |
| Duplicated page helpers | `PrintLabel`/`PrintNote` ×13, `HandRange` ×3 (page-local) | Hoist into the kit (KR6). |
| Duplicate figure labels | peak "Fig. 4"; camera-prior Figs 1–3; dem-horizon, tap "Fig. 2"; baseline Figs 1–3; terrain-snapping Figs 2–3; step-inside "Real 1"; photo-workspace "Fig. 2" | Body figures numbered 1…n in DOM order; Details figures D1…n. |

### 1.6 Dead kit in snapshot 5 (no live importer outside dev routes)

`swiss/StationTable.tsx`, `swiss/PencilFilter.tsx`, `swiss/Register.tsx` and `swiss/Marks.tsx` are used only by `/dev/gipfelbuch-sheet`. Also dead: `viz/Reveal.tsx`, `viz/MarginNote.tsx` (0 page uses, so the margin hand never shipped), `tafel/Multiples.tsx` (0 uses), `.nb-tape` CSS and `Figure.tape`.

2d is reviving `ContourField`, `ConceptNotes` and `NotebookMap`.

### 1.7 Code-level bugs still to verify

- peak: the visible-peak count reads 260 in one place and 257 in another, and the Fig. 2 hidden count (924) doesn't match the ringed summits.
- photo: the Fig. 2 table has `min-w-[640px]`, which hides the pitch and roll columns.
- baseline: Conveyor `min-w-[640px]` (`5:256`).
- viewport: the `tickFill` color-mix is an SVG `fill` attribute (`5:757,878`).
- viewport: the `Key` hexes are stale (`5:1859-60,1944`).
- accept-rule: `#e5604d` residual ticks, and `decoration-white/*` ×6.
- 89 page lines still carry dark-theme leftovers (`#f4d35e|#ff5fa2|#5ee0f4|decoration-white|--rigi-paper`). Counts per page are in §3.
- `tafel/sheets.tsx:1532` (dem-source ledger): `stat(…"demPatch.halfKm"…, {unit:"km"})` without `scale: 1`. Line 1592 has the fix, so 1532 probably still shows "0 km".

---

## 2. (a) The spec, for both sessions

### 2.1 The sheet recipe, in order

1. **Header:**
   - Eyebrow: plain red mono `Blatt NN / 19` · chapter · Waymark glyph.
   - H1 name (`TYPE.display`), the claim as a serif italic dek, and a lede of at most 640 px.
   - Right column: Ledger (3 values for the followed photo) and FieldNotes (2d).
   - ContourField sits behind the header at ≤ 0.2 opacity.
2. **Picker:** one strip, "Follow another photo". Every figure that can follow the photo does.
3. **One hero, printed as a Tafel.** The page's explainer hero, which is real and usually staged, is Fig. 1:
   - It sits in a wide Figure, with `RealPhoto bleed` as the main render.
   - Its caption is the measured instance of the claim: one sentence with one number, plus `<Measured>`.
   - The shell Tafel renders **only** on sheets with no page photo hero. As of this plan that is accept-rule, plus any sheet whose page sets no hero. The shell Tafel's caption is never the generic string.
4. **Beat "The idea":** a claim headline, 1–3 sentences, and its figure or `Eq`.
5. **Beat "How it works":** a `Trio` of 3, with real crops where possible and ≤ 15 words each.
6. **One mechanism figure** on real data, with its `Eq` next to it. Synthetic only if it says so.
7. **Beat "Where it fails":** a real failure `Gallery` (2–4 columns, tone-tagged labels) and what the system does about it.
8. **`Numbers`:** 2–4 corpus numbers with denominators and a source line.
9. **`Details`** (collapsed): code identifiers, legacy figures and the ontology panel.
10. **Foot:** colophon (status blurb, code, reports, ontology, imprint, LV95 corners), one route device and 2 Signposts.

### 2.2 Devices that stay, return or go

| Device | Decision | Why |
| --- | --- | --- |
| Paper, `--gb-*` inks, plain red Blatt number, `TYPE` scale, Source Serif titles | Stay | Identity, and on the scale. |
| Soft grid (6 % / 8 % index, 24 px) on the sheet ground | **Return** (lost in 5) | A hard user constraint. |
| Ledger + FieldNotes (follow one photo) | Stay (2d) | The notebook's best idea, driven by data. |
| ContourField header (real contours) | Stay at ≤ 0.2 (2d) | Real-data furniture. |
| Tafel look (plate, compass ruler, spill, out-of-frame summits) | Stay, carried by `RealPhoto bleed` on the hero | Swiss panorama practice, without stacking two heroes. |
| Wegweiser Signposts, Waymark, Cartouche, SheetMap (index) | Stay, once each | They carry facts. |
| Hand: `HandText`, `PenCircle`, circled numbers, `StepNumber`, sketched handles | Stay, for **furniture only** | "Only furniture may wobble." |
| `MarginNote` | **Return**, at most 2 per page, after 2d confirms the margin lane is free | The design book's observer voice; 0 uses today. |
| `Eq` cards | Stay, at most 2 per page, each next to its figure | The user values the maths next to the real visual. |
| Dark ink plate around live or synthetic interactive diagrams (`bg-[var(--gb-ink)]`) | Allowed (2d guidance a) | Dark only where live. |
| HandRule / HachureRule between sections | **Go** (at most one under the header) | Space separates. |
| Footer Legend on concept pages | **Go** | Lists symbols the page doesn't draw. |
| SheetFrame edge imprint and LV95 corners | **Move** into the colophon | One provenance place. |
| Second Waymark, page "Next:" lines, generic Tafel caption | **Go** | Duplicates. |
| Grain, tape, tilt, margin rule, frame ticks, rounded rings, coloured shadows | **Never** | User constraints. |
| Force or node-link graphs | **Never** | User constraint. NotebookTrail must stay a linear trail. |

### 2.3 Figure size rules

- Prose stays in cols 3–8. Figures use the wide track `lg:mr-[calc(-66.667%-16px)]`. `bleed` (adds `lg:ml-[calc(-33.333%-8px)]`) is for the hero, galleries of 4 columns and side-by-side pairs. Never widen the prose column.
- No `max-w-[…px]` below the wide track on a figure root. The one exception is a square raster (hillshade, DEM patch, dial) shown alone, at ≥ 560 px. A raster with a readout goes side by side (`lg:grid-cols-[1.5fr_1fr]`), not stacked.
- No `min-w-[…px]` inside `overflow-x-auto`. Stack with container queries instead.
- Minimum rendered sizes at 1280 px:
  - hero photo ≥ 720 px;
  - body photo ≥ 560 px;
  - Trio and Gallery tiles ≥ 200 px (Gallery `cols={4}` only with `bleed`).
- SVG text renders at 11–13 px. Size the viewBox text as `px × viewBoxW / renderedW`, or use HTML labels.

### 2.4 Data, photos and the hand

- **Data is exact.** A measured series, ray, dot, bar, cone or profile is a plain `<path>`, `<line>`, `<circle>` or `<rect>`. It is at least 1.2 px wide, constant width, single pass and untapered.
  - Certainty is shown by line style: solid = measured, dashed 4/2 = modelled, dotted = open.
  - `SketchPath`/`SketchPolyline` with `data` are acceptable once KR1 makes them exact. Until then pages use plain elements.
- **Fill encodes, hatch decorates.** Value-carrying areas and bars take a solid or graded tint, and hatch may sit on top. Class maps take distinct fills. Heat maps take a graded ramp, not bands.
- **Photos and rasters are never filtered, tinted or hatched.** Overlays on a photo follow these rules:
  - Lines use the crisp triple: a paper halo at 0.55 opacity, a dark under-stroke, then the `LAYER_STYLE` colour.
  - Fills are translucent solid tints at ≤ 30 %.
  - Labels are printed: condensed white type on a dark halo, never the hand.
  - Mark rings (`Mark`, at most one `PenCircle`) are the only pen on a photo.
- **The hand** states decisions and doubts, never numbers or body text.
  - At most 1 hand note per figure and at most 3 per sheet. That count includes hand `MarginNote`s and excludes the shell's Ledger note.
  - At most 12 words each, upright, rotation ≤ 2°.
- Numbers come only from `public/demo/gipfelbuch/*.json`, the bake or `reports/`. A figure fixed to one photo says "Fixed: demo-NN" in its caption.

### 2.5 Furniture budget per concept sheet

| Slot | Allowed |
| --- | --- |
| Header | 1 eyebrow, 1 Ledger, 1 FieldNotes, 1 ContourField, at most 1 HandRule |
| Hero | 1 (page Fig. 1 with `bleed`, or the shell Tafel) |
| Body | ≤ 6 figures excluding the Trio; ≤ 2 `Eq`; ≤ 2 MarginNotes; ≤ 3 hand notes; ≤ 1 `Numbers`; 0 legends (use `Key` inline); ScaleBar only on map or DEM figures with a known m/px |
| Foot | 1 colophon, 1 route device, 2 Signposts, 1 back link |

### 2.6 Invariants for every package (coordinator)

1. `tafel/README.md` is the contract. The `tafel` and `tafel-sheets` checks stay green, and the bake is `scripts/gipfelbuch/data-tafel.ts`.
2. Wide track as in §2.3. Don't widen the body column.
3. The role aliases (`--gb-terrain/measure/route/peak/result`) are declared in `tafel/tafel.css` on `.gb-swiss` and `[data-theme=dark]`. Re-declare them in any new scope.
4. Never write a resolved `color-mix()` string into an SVG attribute. Use `style={{fill}}` or a `var()` token.
5. Softer sheet: no grain, tape, tilt, margin rules or hand circles. The Blatt number is plain red mono.
6. Paper in both themes. The H1 is the name; the dek is the claim. The index is the picker-driven Blattübersicht (see conflict C1).
7. Everything depends on the staged atlas → gipfelbuch rename. Never name the Gipfelbuch "atlas" in text.

### 2.7 Open conflicts with 2d's restore direction (for the lead)

| # | Conflict | Recommendation |
| --- | --- | --- |
| C1 | 2d brought the NotebookMap index back. Invariant 6 and peak-notebook D-PN4 chose the Blattübersicht. | Blattübersicht stays the index. NotebookMap's chained notes either become the chapter field-notes lines inside it, or a "Feldbuch" section below it. Not both as the index. |
| C2 | HandRule under the header and per connection group | Keep at most the header one. Remove `ConceptPage.tsx:361`. |
| C3 | "Where it sits" (NotebookTrail + Leads to / Referenced by) and the colophon "On this route" | Keep one of them. |
| C4 | The shell Tafel plus the page hero with `bleed` would give two spilled photos | KR2: the shell Tafel steps aside on sheets with a page photo hero. |

---

## 3. (b) Kit requests (2d implements)

Each request lists its files, the change and an acceptance test. Run `npx tsc --noEmit -p .`, `npx biome check <files>` and `node scripts/ci/run.mjs fast --only gipfelbuch,gipfelbuch-contrast,gipfelbuch-notebook,tafel,tafel-sheets` after each one.

| KR | Files | Change | Acceptance |
| --- | --- | --- | --- |
| KR1 data exact | `notebook/Ink.tsx`, `notebook/notebook.check.ts`, `viz/Plot.tsx`, `viz/real.tsx` (DemPatch) | `SketchPath`/`SketchPolyline` with `data` return a plain `<path d>` (no `sketchify`, no taper). Add `data?: boolean` to `PenLine`, `PenCircle` and `HandDot`, so they draw exact `<line>`/`<circle>`. `Plot` series pass `data`. DemPatch cones are drawn exact. | The check asserts that `data` output `d` equals the input `d`. `grep -n "sketchify\|sketchPolyline" Plot.tsx` matches only furniture. |
| KR2 one hero | `ConceptPage.tsx`, `tafel/sheets.tsx`, `tafel/Tafel.tsx`, `tafel/README.md` | Add `hero: "page" \| "tafel"` to `SheetFigures`. ConceptPage renders `<Tafel>` only when it is `"tafel"`. Set `"page"` for every sheet except accept-rule. `Tafel` loses its generic default caption, and the shell passes a field-note caption (`notebook/notes.tsx` `noteFor`) in the body face. `tafel` layers stay as they are, for index bands. | `sheets.check` asserts that `hero` is set for all 19. `grep -n "The photo band with its measured skyline" tafel/Tafel.tsx` returns nothing. |
| KR3 plate | `viz/Figure.tsx` | Add `plate?: boolean`: a paper-deep, full-bleed ground for the hero figure from inside cols 3–8 (bleed calc plus 24 px each side). Remove the deprecated `tape` prop. | tsc is clean, and no page passes `tape`. |
| KR4 shell budget | `ConceptPage.tsx`, `swiss/SheetFrame.tsx`, `tafel/SheetColophon.tsx`, `legendItems.tsx` (delete), `swiss/theme.css` | Apply the §2.5 budget: move the imprint and LV95 corners into the colophon; drop the colophon Waymark; drop the footer Legend and `legendItems.tsx`; set the Signpost subtitle to the target's `claim`; wrap `OntologyPanel` in `Details`; put the soft grid (`.nb-book` gradients) on the SheetFrame paper ground; resolve C2 and C3. | `grep -c "<Waymark" ConceptPage.tsx SheetColophon.tsx` totals 1. `grep -n "<Legend" ConceptPage.tsx` returns nothing. |
| KR5 claim headline | `swiss/type.ts`, `viz/explain.tsx` | Add `TYPE.claim` = serif (`--gb-font-serif`) 24/30 (20/24 on a phone), semibold. `Beat` titles use it; `Section` h2 stays sans. | The contrast check passes; `Beat` imports `TYPE.claim`. |
| KR6 hoist helpers | new `viz/labels.tsx` (`PrintLabel`, `PrintNote`), new `viz/HandRange.tsx`, new `CrispLine` export (`PhotoLine crisp` from `real.tsx`), `viz/index.ts` | A single API that covers the 13 local variants: `PrintLabel {x,y,children,anchor?,size?,halo?}` and `PrintNote` the same. `HandRange` is the same as `5:eye-rule.tsx:179`. | Exported. A follow-up page sweep switches imports. |
| KR7 Key | `viz/explain.tsx`, `notebook/Ink.tsx` (`Passes`) | `Passes` sets `stroke` through `style` when the colour is not a `var(…)` or a hex. `Key` uses a token mix in `style` only. | `grep -n 'stroke={`color-mix' viz notebook` returns nothing. |
| KR8 label overprint | `viz/real.tsx` (`PeakLabels`) | Collision-test the name and the leader stub together, and drop the lower of two summits closer than the label width (peak Fig. 2). | Code review: the stub rectangle is part of the collision box. |
| KR9 imprint default | `viz/real.tsx` | `RealPhoto` `imprint` defaults to `false`; the hero shows `Measured`. | Pages may drop `imprint={false}`. |
| KR10 failure gallery | `viz/explain.tsx`, `tafel/Multiples.tsx` (delete), `tafel/index.ts`, `tafel/README.md` | `Gallery` gains `tone?: (d) => "result"\|"failure"\|"neutral"` for a caps label. Delete `Multiples` (0 uses). | `tafel-sheets` is green. |
| KR11 page lint | `src/lib/gipfelbuch/gipfelbuch.check.ts` | **After** the page sweeps, add `PAGE_RULES` for: `#f4d35e\|#ff5fa2\|#5ee0f4`; `decoration-white`; `var\(--rigi-paper\)`; `\brotate-\d`; `\bring-1\b`; `\bNext:`; `[a-z]=\{?["'\`]color-mix` (in an SVG attribute); duplicate `label="Fig. N"` per file; more than 3 `<HandText` per page. | `fast --only gipfelbuch` is green. |
| KR12 dead kit | `swiss/StationTable.tsx`, `swiss/PencilFilter.tsx`, `viz/Reveal.tsx`, `.nb-tape` in `notebook.css`, barrels | Delete them if no importer remains (`grep -rw`). | tsc and `/dev/gipfelbuch-sheet` still compile. |
| KR13 site embeds (site owner) | `src/components/site/how/HowItWorksScene.tsx`, `src/components/site/meta/RollCompasses.tsx` | rigi's embed may render blank or cramped. RollCompasses clips. Give both container-query sizing in the wide track. | Owner sign-off. Needs a render check under the lock (not code-verifiable). |

---

## 4. (c) Page packages for session 25 (12 pages, 4 packages, run in parallel)

### 4.0 Common to every package

**Kit APIs relied on.** All exist today:
- `#/components/gipfelbuch/viz`: `Figure {caption,label,number,bleed,well}`, `Section`, `Callout`, `Stat`, `Plot`, `MarginNote {mark,hand}`, `Eq/Sym/Op/Frac`, `CodeRef`.
- `viz/explain`: `Beat`, `Trio`, `Gallery`, `Numbers`, `Stages`, `Compare`, `Details`, `Mark`, `MarkList`, `Key`, `skylineBand`.
- `viz/real`: `RealPhoto {data,layers,toggles,crop,maxLabels,labelInfo,imprint,bleed,children}`, `DemPatch`, `PhotoPicker`, `Measured`, `LAYER_STYLE`, `rowsPath`, `useGipfelbuchPhoto`.
- `notebook/useNotebookPhoto`: `useNotebookPhoto(): [id, setId]`.
- `notebook/Ink`: `PenCircle`, `HandText`, `HandDot`, `Hachure`, `SketchPath`, used for furniture only.
- `swiss/type`: `TYPE`.

**Do:**
- Make page-local edits only.
- Use `RealPhoto bleed` on exactly one hero or real-photo figure per page. It must sit inside a wide Figure, or be the main render of `Stages`. Never use it in a Trio, Gallery, Compare or thumbnail.
- Draw measured marks as plain SVG elements with `var(--gb-*)` or `LAYER_STYLE` colours.
- Where a crisp photo line is needed, use a page-local `CrispLine`: three `<path>`s, the paper halo at 0.55, `rgba(12,14,18,.85)` at width + 1.4, then the colour. Copy it from `5:viz/real.tsx:278-298` until KR6 lands.
- Keep every improvement named in `reports/gipfelbuch-regression-2026-10-01/cluster-*.md`.
- Use `git show HEAD:src/lib/atlas/pages/<id>.tsx` (HEAD = the explainer) as the fidelity reference for sizes and fills.

**Don't:**
- Add HandText to photos.
- Wrap anything in `border`, `ring` or `rounded`.
- Move a real figure into Details.
- Delete the page hero. KR2 removes the shell Tafel instead.
- Add your own route or "connections" figure (the shell has one now).

**Common steps on every page:**
- S1. Delete the "Next:" paragraph.
- S2. Make figure labels unique: body `Fig. 1…n` in DOM order, Details `Fig. D1…`.
- S3. Replace the dark leftovers: `#f4d35e|#ff5fa2|#5ee0f4` → `LAYER_STYLE.{skyline,prior,solved}.color`; `decoration-white/NN` → `decoration-[var(--gb-red)]`; `var(--rigi-paper)` → `var(--gb-ink)`.
- S4. Cap hand notes at 3 per page and 1 per figure.
- S5. Write the hero caption as one sentence with one number, plus `<Measured data={d} />`.
- S6. Set no `max-w-[…px]` and no `min-w-[…px]` on figure roots (§2.3).

**Acceptance commands** (each package runs them on its own files):
```
F="src/lib/gipfelbuch/pages/<a>.tsx src/lib/gipfelbuch/pages/<b>.tsx src/lib/gipfelbuch/pages/<c>.tsx"
grep -nE '#f4d35e|#ff5fa2|#5ee0f4|decoration-white|var\(--rigi-paper\)|Next:' $F          # empty
for f in $F; do grep -o 'label="Fig\. [^"]*"' $f | sort | uniq -d; done                       # empty
for f in $F; do echo "$f $(grep -c '<HandText' $f)"; done                                      # each <= 3
for f in $F; do echo "$f $(grep -c ' bleed' $f)"; done                                          # >= 1 (the hero RealPhoto)
grep -nE '(fill|stroke)=\{?[a-zA-Z]*(Fill|Stroke|Mix)\}?' $F   # review: none may resolve to color-mix
npx biome check --write $F && npx tsc --noEmit -p . 2>&1 | grep -E 'pages/(<a>|<b>|<c>)' ; # no errors in these files
node scripts/ci/run.mjs fast --only gipfelbuch,gipfelbuch-contrast,gipfelbuch-notebook,tafel,tafel-sheets
```
Per-page acceptance lines are below. "plain" means a non-sketched SVG element, verified by reading the code at the cited symbol.

Line refs are `5:` (the snapshot) and may have drifted by a few lines. Find code by symbol name.

### PK-A: rigi, photo, peak

**rigi** (`5:rigi.tsx`; 4 leftovers, 0 Next lines, 4 figures)

| # | Change | Ref |
| --- | --- | --- |
| A1 | Hero `HeroStages` stays Fig. 1. Add `bleed` to its main `RealPhoto` (every stage). The Figure gets `bleed`. Caption: the Δ from prior to solved on the followed photo, plus `Measured`. | `5:~391` `HeroStages` |
| A2 | `GuessVsSolved`: the candidate and target skylines become plain `<path>`s (no SketchPath). Keep the slider, the PrintLabel verdict and the Hachure rock (decoration). | `5:166,174` |
| A3 | `Compare` (demo-03 prior vs solved): no `bleed` (Compare). | `5:~250` |
| A4 | HowItWorksScene: give it a `bleed` Figure and no extra wrapper sizing. If it renders blank or cramped, leave it and file it under KR13. | `5:` Beat "Watch it solve" |
| A5 | `Outcomes` Trio: keep the photo and split tile. `Twelve` Gallery: `cols={4}` with Figure `bleed`; label tiles "ok"/"ask" in the tone colours (forest/red) as text. | `5:573-603` |
| A6 | S2–S6. | — |

Accept:
- `grep -n "SketchPath" rigi.tsx` shows no skyline in `GuessVsSolved`.
- One `bleed` sits inside `HeroStages`.

**photo** (`5:photo.tsx`; 1 Next line, 5 figures)

| # | Change | Ref |
| --- | --- | --- |
| B1 | Hero `HeroMarks`: `RealPhoto bleed`, Figure `bleed`. Keep the 6 `Mark`s and the `MarkList`. | `1:HeroMarks`, `5:` same |
| B2 | Anatomy: the prior horizon becomes a plain dashed path in `LAYER_STYLE.prior.color`, with 6/5 dashes. The wedge, tilt and lens edges may stay sketched (furniture). | `5:323` |
| B3 | `FieldsTable` (promoted, keep it): remove `min-w-[640px]`. Below `lg`, stack the pitch and roll columns into a second row (CSS grid with `[container-type:inline-size]`), so the heading and the pitch/roll columns stay visible. | Fig. 2 table |
| B4 | `AltitudeCheck` Gallery: keep the `ring-2` red on outliers (it marks state). Label each tile with GPS minus ground in m (mono). | `5:1043` |
| B5 | Keep `LensEquation` next to the Trio. | `5:1205` |
| B6 | S1–S6. | — |

Accept: no `min-w-[640px]`; `grep -n 'prior' photo.tsx` shows the Anatomy horizon is a `<path` with `strokeDasharray`.

**peak** (`5:peak.tsx`; 6 HandText, 1 Next line, duplicate "Fig. 4", 9 figures)

| # | Change | Ref |
| --- | --- | --- |
| C1 | Hero `Compare` (priorPeaks vs peaks, crop `[0,40,800,360]`): Figure `bleed`, no RealPhoto `bleed` (it is a Compare). Caption: how many labelled summits moved, and by how many px, on the followed photo. | `1:` Fig. 1 |
| C2 | `RealSummits` (Fig. 2) is the page's `bleed` photo: `<RealPhoto bleed …>`. Interim fix for the overprint: `maxLabels={7}`. | `5:` RealSummits |
| C3 | Measured lines become plain `<path>`s: the terrain ridgeline, summit line and ridge ray in `HiddenSummit`, and the occlusion skyline in `RealOcclusion`. | `5:1091,1099,1108,1633` |
| C4 | One source for the counts. Derive the visible, hidden and labelled counts from the single `usePeakData` memo, so the Beat copy, `Numbers`, the Fig. 2 rings and the Gallery labels agree. Today they read 260 vs 257, and 924 hidden vs the rings drawn. | Beat copy, `Numbers`, `HiddenRings` `5:1527` |
| C5 | Hand notes: from 6 to at most 3. Keep the `HiddenSummit` note; convert the others to `PrintNote`. | `5:` HandText sites |
| C6 | Keep `HiddenSummit` and `YawSlide` (gains). Renumber: Fig. 1 Compare, 2 RealSummits, 3 HiddenSummit, 4 RealOcclusion, 5 YawSlide, 6 Gallery; Details D1 RayMarch, D2 LabelLayout. | S2 |
| C7 | S1, S3, S5, S6. | — |

Accept:
- `<HandText` count ≤ 3.
- No duplicate Fig labels.
- The numbers 260, 257 and 924 appear nowhere as literals; they are computed.

### PK-B: camera-prior, viewport-inference, pose-estimate

**camera-prior** (`5:camera-prior.tsx`; duplicate Figs 1–3, 1 Next line, 7 figures)

| # | Change | Ref |
| --- | --- | --- |
| D1 | Hero `HeroCompare` (sensors only vs solved): Figure `bleed`, no RealPhoto `bleed` (Compare). Keep `YawShift` `Eq` and `ColorKey` straight after it. | `5:1250` |
| D2 | `RealPrior` (Details → `Deep`): restore the photo and `DemPatch` side by side (`lg:grid-cols-[1.55fr_1fr]`); remove `sm:max-w-[26rem]`. No `RealPhoto bleed` here, because the bleed would overflow into the map. This page has none, and its hero is a Compare. | `5:200-212`, `1:RealPrior` |
| D3 | `YawBars`: rejected outlines become plain `<rect>`s (stroke `var(--gb-red)`, 1.2 px). Accepted bars are solid tints. | `5:1341` |
| D4 | Fails Beat: restore the explainer's "use it to start and to veto" only if `node.modules` code still vetoes on the prior. Read `src/lib/pose` before writing it; otherwise keep the current wording. | `5:1623` |
| D5 | S1–S6. Renumber the Deep figures as D1…; the body becomes Fig. 1 hero, 2 YawBars, 3 Gallery. | — |

Accept: no duplicate Fig labels; `RealPrior` has `lg:grid-cols-[1.55fr_1fr]`.

**viewport-inference** (`5:viewport-inference.tsx`; 5 leftovers, 3 HandText, 9 figures)

| # | Change | Ref |
| --- | --- | --- |
| E1 | Hero `HeroCompare` + `ResidualStrip`: Figure `bleed`. The `ResidualStrip` series are plain paths. | `5:1931` |
| E2 | `Key` swatches use `LAYER_STYLE.skyline/prior/solved.color`, not `#f4d35e` and the like. | `5:1859-60,1944` |
| E3 | `tickFill` (color-mix) moves from the `fill=` attribute to `style={{ fill: tickFill }}`. | `5:757,878` |
| E4 | `Verdicts`: `cols={4}` with Figure `bleed`. Restore the on-photo chip "rejected" / "2nd solver" (paper chip, red or ink text, top left) as in `1:1837-1843`. | `5:2102,2127` |
| E5 | `CostLandscape`: replace the 5 hachure bands (`BAND_TINT`) with a graded tint ramp (fill encodes; 9 or more steps or a continuous `heat()` in brown). Hatch may stay on top at ≤ 0.18 opacity. | `5:683` |
| E6 | The 8 `SketchPath data` (skyline, horizon, ring profile) become plain `<path>`s. | `5:403-445,1015` |
| E7 | Keep `SolveEquation` + `CameraTable` (gain). This page has **no** `RealPhoto bleed`: the hero is a Compare, and the other photos are Trio and Gallery tiles. The `grep ' bleed'` check is met by the hero Figure's `bleed`. | — |
| E8 | S1–S6. | — |

Accept:
- No `fill={tickFill}`.
- No `#f4d35e`.
- `BAND_TINT` is removed or unused, and the heat map uses a ramp function.

**pose-estimate** (`5:pose-estimate.tsx`; 12 leftovers, 9 figures)

| # | Change | Ref |
| --- | --- | --- |
| F1 | Hero `HeroPose`: `RealPhoto bleed`, Figure `bleed`. `OverPhoto`: the 5 `SketchPath`s (level, tilt, cross, FOV) become `CrispLine` (local). Keep the 3 `Mark`s and the `MarkList`. | `5:1426-1464` |
| F2 | `CompassShift` (bleed Figure, demo-09, peaks + priorPeaks): keep it, with no RealPhoto `bleed` (one per page). Its caption says "Fixed: demo-09". | `5:1717` |
| F3 | `CompassErrors` dials: dial needles are measured, so plain `<line>`. The dial ring may stay sketched. | `5:` CompassErrors |
| F4 | REJECTED Gallery (demo-07, demo-11): `cols={2}`, tone labels in red text. | — |
| F5 | S1–S6; the 12 leftovers go (S3). | — |

Accept: `grep -n "SketchPath" pose-estimate.tsx` shows no use inside `OverPhoto`; leftovers are 0.

### PK-C: skyline, dem-horizon, tap-a-peak

**skyline** (`5:skyline.tsx`; exemplar page; 5 figures)

| # | Change | Ref |
| --- | --- | --- |
| G1 | Hero `HeroStages` (plain, sky, skyline, + weight): `RealPhoto bleed` in each stage, Figure `bleed`. Caption: voted columns out of 800 on the followed photo, plus `Measured`. | `5:~1090` |
| G2 | `WeightStrip`: the weight line becomes a plain `<path>`. Restore per-column `<rect>` weight bars (solid tint, fill encodes) under it as in `1:513-545`; keep the `HandDot` marks only for non-ok columns. | `5:1070,595-613,941-951` |
| G3 | Viterbi figure: restore the helper text "(the path barely moves: sky evidence dominates)" after the jump-cost slider. Keep the dark panel (live, animated). Bound and lobe lines become plain. | `1:579-584`, `5:539-560,661` |
| G4 | `CleanAndFuse` (Details): the fuse line becomes plain. | `5:908` |
| G5 | Keep the `Eq` "The line we trace", the 6× clip reveal and the figure order. | — |
| G6 | S1–S6. | — |

Accept:
- `WeightStrip` has `<rect` bars.
- The helper string is present.
- No `SketchPath`/`SketchPolyline` on measured weight or skyline.

**dem-horizon** (`5:dem-horizon.tsx`; 9 leftovers, 3 HandText, duplicate "Fig. 2", 7 figures)

| # | Change | Ref |
| --- | --- | --- |
| H1 | Hero `HeroStages` (plain, map horizon, + photo skyline): `RealPhoto bleed`, Figure `bleed`. | `5:1339` |
| H2 | `HorizonOverlay`: replace the `SketchPolyline data` runs with crisp, distance-coloured `<path>` segments (paper halo plus colour, as `1:886-946`). Ridge dots become plain `<circle>`s with a `var(--gb-ink)` 1 px outline. | `5:1094-1150` |
| H3 | `Ladder`: the column dash becomes plain; keep `Eq` (gain) and `HandRange`. | `5:1483,1609` |
| H4 | `ProfilePlot`: data runs become plain. | `5:1233` |
| H5 | Keep the "Why it works: Far ridges are the fingerprint" Beat. `Misses` Gallery `cols={3}`. | `5:1852` |
| H6 | S1–S6 (renumber the duplicate "Fig. 2"). | — |

Accept: `HorizonOverlay` contains no `SketchPolyline`; 9 leftovers → 0.

**tap-a-peak** (`5:tap-a-peak.tsx`; duplicate "Fig. 2", 8 figures)

| # | Change | Ref |
| --- | --- | --- |
| I1 | Hero `HeroTaps` (4 stages on demo-10): `TapFrame` renders `RealPhoto bleed` as the main render; Figure `bleed`; caption "Fixed: demo-10". | `5:` HeroTaps |
| I2 | `TapFrame`: the solved skyline `SketchPath data` becomes `RealPhoto` `layers` including `"solved"` (crisp kit line), or a local `CrispLine`. Rings stay `PenCircle` (annotation). | `5:818-832` |
| I3 | `RealTaps`: replace the local `useState` photo with `useNotebookPhoto()`, so it follows the shell picker. Remove its own `PhotoPicker`, or make it call the shared setter. | `5:912` |
| I4 | `MissBars`: keep the solid `MissBar` with decorative hatch. It must stay in the body, not in Details (R5). | `5:1245-1355` |
| I5 | `PinLock` (Details): make the caption colour words match the drawing ("solid black line / dashed grey"); verify. | `5:316+` |
| I6 | Keep `OneTap` + `Eq` (gain). S1–S6. | `5:1075,1379` |

Accept:
- `RealTaps` uses `useNotebookPhoto`.
- No `SketchPath` with `data` in `TapFrame`.

### PK-D: baseline-pipeline, accept-rule, terrain-snapping

**baseline-pipeline** (`5:baseline-pipeline.tsx`; 8 leftovers, duplicate Figs 1–3, 9 figures)

| # | Change | Ref |
| --- | --- | --- |
| J1 | Hero `HeroStages` (5 stages, followed photo): `RealPhoto bleed` in each stage; Figure `bleed` (already). | `5:1658` |
| J2 | `Conveyor`: remove `min-w-[640px] lg:min-w-0`. Under 560 px of container width, stack the stages vertically (container query). The confidence gate and the `refinePose` stages stay visible. | `5:256` |
| J3 | `YawSearch` (gain, keep): the runner-up line on the photo becomes a crisp dashed path (no `SketchPath data`). | `5:2125` |
| J4 | Leftovers: `5:2158` `color-mix(… var(--rigi-paper) …)` becomes `var(--gb-paper-deep)`; `decoration-white/30` at `5:64`. | S3 |
| J5 | Renumber: body Fig. 1 hero, 2 YawSearch, 3 Gallery; Deep D1 Conveyor, D2 CascadeFlow, D3 Variants, DA/DB/DC become D4–D6. | S2 |
| J6 | S1, S4–S6. | — |

Accept:
- No `min-w-[640px]`.
- Unique Fig labels.
- Leftovers are 0.

**accept-rule** (`5:accept-rule.tsx`; 8 leftovers, 6 figures)

| # | Change | Ref |
| --- | --- | --- |
| K1 | This sheet keeps the **shell Tafel** as its hero (KR2 `hero:"tafel"`). Move `Verdicts` (12-photo Gallery) from the top of the page to the "Where it fails" Beat, as the failure gallery: `cols={4}`, Figure `bleed`, tone labels ("accepted" in forest, "rejected" in red). | `5:` first element |
| K2 | `ScoreFit` (gain): it becomes the page's one `RealPhoto bleed`. Residual ticks `#e5604d` become `var(--gb-red)`. | `5:1561` |
| K3 | `HandBar`/`Bar`: value bars become solid tints (fill encodes); `Hachure` on top at ≤ 0.18, or removed. | `5:121,184` |
| K4 | `decoration-white/25|30` ×6 become `decoration-[var(--gb-red)]`. | `5:1285,1358,1412-1426,1790` |
| K5 | Keep the promoted `RealDecisions` and `ConfidenceVsError` (gains). S1–S6. | `5:1820,1840` |

Accept:
- `Verdicts` renders after the fails `Beat`.
- No `#e5604d`.
- No `decoration-white`.

**terrain-snapping** (`5:terrain-snapping.tsx`; duplicate Figs 2–3, 5 figures)

| # | Change | Ref |
| --- | --- | --- |
| L1 | Hero (demo-03, 3 `Mark`s): `RealPhoto bleed`, Figure `bleed`. The summit label "Blüemlisalphorn" changes from `HandText size 30` to a printed label (white condensed 13 px, dark halo), as in `1:566`. | `5:649-672` |
| L2 | `PeakReal`: restore the 2-column layout (hillshade beside the table, `lg:grid-cols-[1fr_1fr]`) in a `bleed` Figure; drop the stacked `max-w-[560px]` pair. | `5:402,491`, `1:296` |
| L3 | Snap square and grid over the hillshade become plain dashed `<rect>`/`<path>` (no `SketchPath`). | `5:410-430` |
| L4 | `RealEye`: Terrarium and Mapterhorn bars get two distinct solid fills (brown `var(--gb-contour)` and pencil grey `var(--gb-relief)`, per the 1 distinction), with hatch decoration ≤ 0.18 at most. | `5:` RealEye, `1:123` |
| L5 | Keep `SnapEquation` and the local rule table in Details. S1–S6 (renumber). | `5:345,613` |

Accept:
- No `HandText` on the hero photo.
- `PeakReal` has a 2-column grid.
- No `SketchPath` in the snap-square block.

---

## 5. (d) Per-page notes for 2d's 7 pages

The same rules as §4.0. Hero: page Fig. 1 with `bleed` where it is a photo, `Figure plate` (KR3) otherwise.

| Page | Hero (target) | Must fix | Keep (gains) |
| --- | --- | --- | --- |
| dem-source | Hillshade wipe (Compare of the real `hs-terrarium.jpg`/`hs-mapterhorn.jpg`) on the plate. No RealPhoto bleed (Compare). | Measured profiles become plain (`5:236,244,352,359,390`). `Ladder`: drop `max-w-[760px]` (`5:720`). Ledger "0 km": add `scale: 1` at `tafel/sheets.tsx:1532`. | `DecodeEquation`, summit-anchored `PrintNote`s. |
| terrain-sampler | `AskTheMap` hillshade at ≥ 560 px (back to 1-column 560, or 2-column with the raster ≥ 560 in `bleed`). | Dashed line over the hillshade becomes plain (`5:1054`). `Plot` series exact (KR1). Profile area: solid tint, hatch decoration only. | Picker-linked point 1; `BilinearProbe` and the Blend Beat promoted. |
| eye-rule | Fig. 1 Stages (SideView + real demo-09 `RealPhoto bleed`, stacked, full width). | Data lines (`5:343,909,985`) become plain; the hero band (`5:395`) is plain. Fig. 4 "max rule" / "contour MAP" labels overprint: separate them. | `EyeEquation`, the datum paragraph, `HandRange`. |
| dem-anchoring | Fig. 1 Stages on demo-01 with `RangeCells`, `RealPhoto bleed`. | `RangeCells`: remove the hachure over the photo and go back to ≤ 28 % solid tints (`5:1403`; `1:1085-1100`). Drop `max-w-[720px]` on CurveFigure, Gauge and RealQuality (`5:470,1078,1812`). RealQuality dots become plain `<circle>`s. | `AnchorEquation`, the red median curve, ring-free code cards. |
| photo-workspace | `HeroJourney` 4 stages with `RealPhoto bleed`. | `AnnotatedWorkspace`: restore the full `viewBox="0 0 2048 1536"` (`5:1054`; `1:960`). Duplicate "Fig. 2" (`5:1049,1188`). The `PoseJourney` scrub becomes `HandRange`. | `PeakProjection` + `Eq`, scenario chips. |
| camera-roll | `HeroStages` (pile → place → drape) on the plate; the place-stage `DemPatch` with 12 cones. | Restore per-thumbnail accept/reject frames in the `RealRoll` strip (`1:1161-1175`; `5:1393-1402`). Restore cone fills at 12 % (`1:1601-1611`). Rays, GPS circles, links, bias bars and dots become exact (`5:1359,1471,1485-1497,1696-1712,1884-1905`; needs KR1 `data` on PenLine, PenCircle and HandDot). RollCompasses clip (KR13). Hard-coded `#1f9bb5`, `#c8683a` and `#c8397a` become tokens or `LAYER_STYLE`. | RollCompasses, "Where they stood", `Eq`, RayLabels. |
| step-inside | `RealSplit` (Compare photo ↔ split) + AnchorCurve as the hero on the plate. If the raw-photo stage hero stays as Fig. 1, it carries the `bleed`. | Duplicate "Real 1" (`5:931,1552`). AnchorCurve knots become plain `<circle>`s (`5:1466`). | RealSplit, the split-rule `Eq`, the honest Stat wording. |

---

## 6. Order and verification

1. **Now, in parallel:**
   - 2d: KR1, KR2, KR4, KR5, KR7 and KR8 first, because they change what pages see.
   - Session 25: PK-A to PK-D. These use existing APIs only, so they do not depend on the KRs.
2. **Then:**
   - 2d: KR3, KR6, KR9 and KR10.
   - Session 25: a short follow-up sweep that swaps the local `PrintLabel`/`PrintNote`/`HandRange`/`CrispLine` for the KR6 exports and drops `imprint={false}` after KR9.
3. **Last:** KR11 (lint, once every page is clean) and KR12 (dead kit).
4. **Gate:** after the final formatting, run the fast tier (`node scripts/ci/run.mjs fast`), `node scripts/ci/spdx.mjs` and `npx tsc --noEmit -p .`.
5. **Render check (not code-verifiable):** the hero sizes, the bleed spill and the KR13 site embeds need a screenshot pass of all 19 sheets, under `node scripts/gpu/with-render-lock.mjs -- …`. None of the visual claims in this report were measured.
