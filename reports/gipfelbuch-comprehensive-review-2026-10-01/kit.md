# Gipfelbuch kit and shell review (read-only, 2026-10-01)

Scope: `src/components/gipfelbuch/{ConceptPage,AutoVisual,OntologyPanel,legendItems,loadPage}.tsx`, `README.md`, `viz/**`, `notebook/**`, `swiss/**`, `tafel/**`, `src/routes/gipfelbuch.*.tsx`, `src/routes/dev.gipfelbuch-sheet.tsx`.
Method: I read the code and ran static checks only (no browser). Line numbers are from the working tree. `viz/real.tsx`, `viz/explain.tsx`, `viz/story.tsx` and `swiss/SheetFrame.tsx` have uncommitted changes from another session, and `viz/GeoSpill.tsx` is untracked.

Checks run:
- `npx biome check` on the scope: 0 errors, 4 warnings (`noImportantStyles` in `swiss/print.css`).
- `npx tsc --noEmit -p .`: no gipfelbuch errors.
- biome `useHookAtTopLevel` and `useExhaustiveDependencies`: clean.
- `node scripts/ci/run.mjs fast --only gipfelbuch,gipfelbuch-contrast,gipfelbuch-notebook,tafel,tafel-sheets`: 4 PASS, **tafel-sheets FAIL** (see B2).

---

## Regression list status (reports/gipfelbuch-regression-2026-10-01.md)

| Item | Status | Evidence |
|---|---|---|
| R1 figure track | **Fixed on concept pages, broken on /gipfelbuch/print** | `viz/Figure.tsx:83-87`: `lg:mr-[calc(-66.667%-16px)]` and, with bleed/plate, `lg:ml-[calc(-33.333%-8px)]`. Checked against `ConceptPage.tsx:76-77,297`: the 6-column cell W = 6c+120, and 2/3·W+16 = 4c+96 = columns 9-12 plus gap. Tailwind 4.3.3 emits `calc(-66.667% - 16px)`, so the value is valid. An AST scan found no Figure nested in a grid, flex or max-w wrapper in any page; only the `<Details>` wrappers (12 sites) are nested. The breakout is unconditional, so it also fires outside the ConceptPage grid (B1). |
| R3 Stat overflow | **Partly fixed** | `viz/Section.tsx:104-113`: `[container-type:inline-size]`, `whitespace-nowrap`, `clamp(26px,14cqi,40px)`, `size="hero"` for 56 px. `viz/explain.tsx:524-531`: `Numbers` uses `repeat(auto-fit,minmax(150px,1fr))`. Values no longer wrap, but `nowrap` with a 26 px floor now overflows sideways in the fixed `grid-cols-2 sm:grid-cols-4` page grids (risk K1). |
| R4 gb-coord colour | **Fixed** | `swiss/theme.css:109-118`: the rule is inside `@layer components`, so layered colour utilities win. The same hazard remains for other unlayered rules (K3). |
| R6 imprint default | **Fixed** | `viz/real.tsx:426-427` `createContext(false)`, and `:469-470` / `:865-866` take the prop or the context default. |
| R7 photo overlay contrast | **Fixed, with a new opacity bug** | `viz/real.tsx:271-299` `CrispLine`, and the crisp branch at `:340-361`: a paper halo at 0.55, a dark under-stroke `rgba(12,14,18,.85)` at width+1.4, and a one-pass pen within 0.5 px. Deeper hues in `LAYER_STYLE` `:243-252` (`#e0207f` / `#0aa5bd` / `#f0a30a`). The RealPhoto prior/solved/skyline lines use `crisp` (`:574-591`). The opacity bug is B3. |
| R8 Flow layout | **Fixed for layout; boxes deliberately not restored** | `viz/Steps.tsx:31-36`: an inline-size container that is vertical below 560 px, with vertical arrows `:61-76`. Nodes are circled numbers with no boxes, which follows the README "no boxes" rule. HowItWorksScene is outside this scope. |
| (bug list) halfKm "0 km" | Fixed | `tafel/sheets.tsx:1708-1711` and `:1768` pass `scale: 1`. The root cause is still in place (C11). |

---

## Bugs

### B1. /gipfelbuch/print on screen: every figure spills about 66 % past the sheet (bug)
- `src/routes/gipfelbuch.print.tsx:75` renders each bespoke page in a plain `px-6 pb-12` block inside `max-w-6xl`, with no 12-column grid.
- `viz/Figure.tsx:86` (`lg:mr-[calc(-66.667%-16px)]`), `:87` (bleed left), `viz/explain.tsx:524` (`Numbers`, the same right margin) and `viz/margin-note.css:41,61` all assume ConceptPage's 6-of-12 cell.
- Effect: at 1024 px and wider, every Figure and Numbers block is about 1.67× the page width. `<main>` on the print route has no `overflow-x-clip`, so the page gets horizontal scroll. Paper output is unaffected, because A4 width is below `lg`.
- **Fix:** scope the breakout to the concept grid. Mark the prose cell (`ConceptPage.tsx:297`) with `gb-track`, and write the Figure classes as `lg:[.gb-track_&]:mr-[…]`. Alternatively, set `--gb-fig-r` / `--gb-fig-l` custom properties on that cell (default 0) and use `margin-right: calc(-1 * var(--gb-fig-r,0px))`.

### B2. tafel-sheets CI check fails in the current tree (bug, working tree)
- The untracked `viz/GeoSpill.tsx:11` does `import "../tafel/tafel.css"`.
- `viz/real.tsx:23` imports GeoSpill, so `tafel/sheets.check.ts` → `sheets.tsx` → `viz/real` now loads a `.css` file under tsx/node: `ERR_UNKNOWN_FILE_EXTENSION`.
- The README already states this rule: "SWISS lives in swiss/inks.ts, which has no CSS import, so node checks can load modules".
- **Fix:** remove the CSS import from GeoSpill. `tafel.css` is already imported by `tafel/Tafel.tsx:26` and `tafel/Ledger.tsx:7`, and ConceptPage always mounts the Tafel/Ledger. If GeoSpill must own it, move the styles into `theme.css`.

### B3. Faded story lines still draw a full-strength dark under-stroke (bug, R7 follow-up)
- In `viz/real.tsx:340-361`, the crisp `PhotoLine` applies `opacity` only to the colour pass.
- The paper halo (0.55) and the `PHOTO_DARK` under-stroke (0.85) stay at full strength.
- Inside an alignment story, `lineOpacity` (`:499-502`) fades the off-end line to 0.3. That line then reads as a dark dashed or solid line, not a faded one.
- **Fix:** move `opacity` onto the wrapping `<g>`, and drop it from the colour `<path>`.

### B4. Print stylesheet hides every `<nav>`, app-wide (bug)
- `swiss/print.css:78-81` sets `nav, [data-site-nav] { display: none !important }` with no scope.
- In print it hides the index's hand-written contents (`gipfelbuch.index.tsx:52` is a `<nav>`) and the concept breadcrumb (`ConceptPage.tsx:216`).
- Vite keeps route CSS after SPA navigation, so once any Gipfelbuch page has loaded, the rule also strips `<nav>` from the printout of every other route.
- **Fix:** use `.gb-swiss [data-site-nav]`, plus `print:hidden` on the SiteNav.

### B5. Picking a photo blanks the sheet for a frame (bug/UX)
- `useJson` in `viz/real.tsx` (around `:196-210`) calls `setD(null)` whenever the URL changes.
- `ConceptPage.tsx:263` (`figures && data && <Ledger>`) then unmounts the Ledger, the register line loses its date and time, and every `RealPhoto` drops to its loading skeleton until the new JSON arrives. That causes layout shift on every pick.
- `notebook/notes.tsx:377-383` already works around this locally ("keep showing the previous photo").
- **Fix:** keep the previous value in `useJson` and expose a `loading` flag. Then remove the workaround in notes.tsx.

---

## Risks

- **K1. Stat/Numbers overflow sideways (R3 residual).**
  - The `Stat` cell is `min-w-[110px]` + `nowrap` (`viz/Section.tsx:105-112`), inside page grids that are still fixed at `grid-cols-2 sm:grid-cols-4`. Examples: `pages/viewport-inference.tsx:1749` with the value `"x.x → y.y px"` at `:1755`; `camera-prior.tsx:187,497,972`; `baseline-pipeline.tsx:1579`.
  - About 13 characters at the 26 px floor is roughly 180 px, in a cell of about 125 px. The value overprints the next cell.
  - **Fix:** either lower the clamp floor (`clamp(18px,14cqi,40px)`), or let ranges break at the arrow (`<wbr>` around " → " with `text-wrap: balance`). Move those page grids to `repeat(auto-fit,minmax(150px,1fr))`, as `Numbers` already does.
- **K2. MarginNote lane now overlaps the wide figure track.**
  - `viz/margin-note.css:6-9,61` places notes in columns 11-12. Since R1, Figures span to `full-end` (`Figure.tsx:86`).
  - The only use is `pages/step-inside.tsx:1676`, the last paragraph of a Beat directly before `<RealSplit/>`. A three-line note there can sit over the figure's top right.
  - The comment and README:308 ("the rail owns columns 9-10") are stale: ConceptPage has no rail.
  - **Fix:** either drop MarginNote (one use) or give notes `clear`/top padding against the next figure. Update the docs either way.
- **K3. The R4 mechanism is still present for other rules.**
  - The unlayered `.gb-swiss .display-title, .gb-swiss :is(h2,h3):not(.gb-print){color; font-weight:700}` (`swiss/theme.css:84-92`) and `.gb-swiss .gb-water{color}` (`:104-107`) beat every Tailwind colour and weight utility. `TYPE.h2`/`h3` `font-semibold` is silently 700, and any `text-[var(--gb-red)]` on an h2/h3 is ignored.
  - **Fix:** wrap these in `@layer components`, as the gb-coord rule now is.
- **K4. AutoVisual breaks two README rules.**
  - It is a node-link "constellation", which the README forbids ("No node-link graphs").
  - It animates with `useTime`, recomputing sketch geometry every frame. The orbit `x,y` changes each rAF, so `circlePath(x,y)` → `SketchPath` sketchify and `HandDot`'s memo both miss (`AutoVisual.tsx:99-140`). The README says to reuse precomputed paths in rAF loops.
  - It only renders as the no-page or crash fallback, because all 19 ids have bespoke pages.
  - **Fix:** draw each mark at the origin once and move it with `<g transform="translate(x y)">`, or make the fallback static.
- **K5. The index loads all 12 photo JSONs** (about 0.86 MB uncompressed) through `tafel/Blattuebersicht.tsx:34-57` `useAllPhotos`. Each of the 12 arrivals re-renders all 19 band sketches, and `out` is a new object on every render. **Fix:** bake the few fields the comparison bands need into `index.json`, or load them per chapter in view.
- **K6. `HandMark` measures only on mount, parent resize and fonts-ready** (`notebook/marks.tsx:185-231`, deps `[]`). Photo-driven text inside a mark that changes width without resizing the parent block leaves the sketched mark stale. **Fix:** add `children` (or a `measureKey`) to the effect deps, or observe the span's text with a MutationObserver.
- **K7. `useSheetRock` caches one module-global promise and ignores `url`** (`swiss/useSheet.ts:119-135`). `useStaticJson` caches a `null` from a non-OK response forever, and only deletes the cache entry on rejection (`notebook/notes.tsx:34-53`).

---

## Cleanup: architecture and duplication

**C1. Four kits, overlapping primitives.** The intended layering is: `notebook/` holds the pen primitives (Ink, sketch, sketchify); `viz/` holds the page blocks; `swiss/` holds the sheet chrome; `tafel/` holds the hero band. In practice hand marks are split across three files, and several primitives have 2-4 implementations:

| Role | Implementations |
|---|---|
| Underlines and rules | `viz/hand.tsx` HandUnderline / HandSideRule / HandFrame / HandLoop / HandStrike; `swiss/hand.tsx` MarkerUnderline / HandRule / ListArrow; `notebook/marks.tsx` HandMark (underline / circle / strike / box); `notebook/Ink.tsx` PenRule / SketchRect |
| Circled numbers | `Ink.tsx:369` StepNumber; `marks.tsx:360` CircledNumber; `carto.tsx:2058` CircledKey; `explain.tsx:633` Mark |
| SVG hand text | `viz/labels.tsx` HandLabel (267 uses) and `Ink.tsx:299` HandText (148 uses, whose `variant="label"` is HandLabel) |
| Tapered pen stroke | `Ink.tsx:73` Stroke and `carto.tsx:132` PenPath |
| Number displays | Stat, Numbers, Ledger, `TYPE.stat` |
| Scale bars | `swiss/ScaleBar.tsx` ScaleBar / SheetScaleBar and `carto.tsx` HandScaleBar. Pages use only HandScaleBar. |
| Hachure | `Ink.tsx` Hachure, `swiss/HachureRule.tsx` (its own RNG), `carto.tsx` RockHachure (unused) |

**Fix:**
- Merge `viz/hand.tsx` and `swiss/hand.tsx` into `notebook/`.
- Have one CircledNumber (an inline variant and an SVG variant).
- Make HandLabel a thin preset over HandText, or the other way round.
- Make PenPath the single stroke implementation.

**C2. Seeded hash and RNG copied 7×.**
- FNV-1a: `notebook/sketch.ts:24` hashSeed, `swiss/hand.tsx:11` unit, `swiss/Marks.tsx:226` rotationOf, `swiss/ContourField.tsx:23`, `AutoVisual.tsx:20` h32.
- mulberry32: `sketch.ts:12` and `swiss/HachureRule.tsx:16`.
- `seedUnit` (`viz/hand.tsx:32`) and `seedOf` (`sketchify.ts:28`) wrap them.
- **Fix:** import `hashSeed`/`createRandom`/`seedUnit` everywhere.

**C3. Ink-name → CSS resolver copied 4×:** `Ink.tsx:52` strokeColor, `viz/hand.tsx:18-29`, `marks.tsx:46-57`, `carto.tsx:62-73`. **Fix:** export `paint()` from Ink.tsx.

**C4. Five fetch caches:**
- `viz/real.tsx:182` load/useJson
- `notebook/notes.tsx:34` useStaticJson
- `swiss/useSheet.ts:81` fetchSheet
- `swiss/useSheet.ts:119` useSheetRock
- `tafel/useTafelBake.ts:35` loadBake (the only one with the dev-server content-type guard)

**Fix:** one `useStaticJson(url, {keepPrevious})` with that guard. This also fixes B5 and K7.

**C5. ResizeObserver width hooks copied 5×:** `tafel/Tafel.tsx:74`, `swiss/useSheet.ts:142`, `swiss/Signpost.tsx:33`, `swiss/ScaleBar.tsx:151`, `viz/GeoSpill.tsx:47`. **Fix:** use one `useElementSize`.

**C6. Dead or unused exports** (grep over src/scripts/examples, ignoring barrels and the defining file):
- `notebook/carto.tsx`: 14 components are never rendered: HeightFigure, TrigTriangle, SpotX, SummitCross, RockHachure, ScreeStipple, KrokiHatch, TrailLine, GradeBox, HandName, PeakLeader, StationRays, ContourScribble, ProfileSketch. Also unused: `PEN_TIER`, `formatScale`, `estimatePeakLabelWidth`. Only their geometry helpers are exercised by `notebook.check.ts`. The README hand-pass section advertises this vocabulary as the page kit. About 1,000 of carto's 2,098 lines are unused. Either use them or delete them.
- `viz/DemoImage.tsx` (`DemoImage`, `DEMO_IMAGES`): 0 uses, yet the README example imports it (README:59,185).
- `legendItems.tsx:45` `LEGEND_BY_CONCEPT`: unused. No concept page renders a legend, despite README:84-86 (F1).
- `loadPage.tsx:24` `bespokeIds`, `sketchify.ts` `strokeSketchCanvas`/`hachureCanvas` (listed in the README table), `viz/Plot.tsx` `PlotArea`, `entries.ts` `STEP_ENTRY`, `chapters.ts` `stepOf`, `ConceptPage.tsx:393` `NodeCard` (export only used internally).
- Dev-only (used only by `/dev/gipfelbuch-sheet`'s FurnitureSheet): `swiss/HachureRule.tsx`, `ScaleBar` with `metresPerPixel`, and `StationStamp`.
- **MarginNote is not unused:** `pages/step-inside.tsx:1676` uses it once.

**C7. Imprint leftovers.**
- `NoImprint` (`viz/real.tsx:430`) is now a no-op, because the context default is already false. It is still wrapped around Compare, Stages and Gallery content.
- `ImprintLine` (`real.tsx:412-423`) duplicates `formatImprint` (`Figure.tsx:18-25`).
- **Fix:** delete NoImprint, and export `formatImprint`.

**C8. Duplicated constants.**
- `STAND = "2026-10"` appears in `ConceptPage.tsx:57`, `gipfelbuch.print.tsx:32` and `gipfelbuch.index.tsx:116`. `total="19"` is hard-coded at `index.tsx:113`.
- The sheet imprint string is duplicated at `ConceptPage.tsx:199` and `print.tsx:47`.
- **Fix:** one `swiss/edition.ts`.

**C9. README is stale and contradicts itself.**
- `:83` "Print is the form" contradicts the hand pass at `:12`.
- `:115-117` "Seven sizes only… (Fira Sans)… GB Mono" is wrong: `TYPE` has 12 roles and uses the hand faces.
- `:159` says "Plex Mono"; `:183` says Stat is a "Big serif number".
- `:308` "columns 11-12 … rail has 9-10": there is no rail.
- `:311` "At most 3 per entry" contradicts `:20` "not capped".
- `:84` says to use `ScaleBar metresPerPixel`, but pages use HandScaleBar.
- **Fix:** keep one canonical "current rules" section and drop the superseded passes.

**C10. print.css cleanup.**
- `swiss/print.css:42-45`: `transform: none !important` has no effect on Tailwind 4 `translate-*` utilities, which use the `translate` property. The Figure and Reveal components already carry `print:translate-y-0`.
- This rule and the rule in B4 account for the 4 Biome warnings.

**C11. Tafel sheets bundle and the `stat()` unit footgun.**
- `tafel/sheets.tsx` (1,833 lines: ledgers and bands for all 19 sheets) is statically imported into both the concept and index route chunks. Pages themselves are properly code-split (`loadPage.tsx:9-23`, `import.meta.glob` + `lazy`, with `PageBoundary`).
- `stat()` (`sheets.tsx:109-117`) silently multiplies by 0.001 whenever `unit: "km"`. The halfKm fix patched the call sites with `scale: 1`.
- **Fix:** make scale explicit, e.g. `fromUnit: "m"`.

**C12. Figures inside `<Details>` end about 29 px short of the track.** The `%` breakout resolves against the `pl-6 pr-2` content box (`explain.tsx:104`). This is minor; fixing B1 with a CSS variable also fixes it.

**C13. Keys from user text:** `Flow` key={n.label} (`Steps.tsx:35`), `Steps` key={s.title} (`:135`), `Numbers` key={it.label} (`explain.tsx:526`), `Stages` key={st.label}. Duplicate labels would collide. Use `${i}-${label}`.

**C14. The concept not-found view uses site tokens on paper** (`gipfelbuch.$concept.tsx:32,40`: `--rigi-glow`, `hover:text-[var(--rigi-paper)]`, which is ink inside GB_THEME). Use the `--gb-*` tokens.

---

## Checked and fine

- **SPDX:** every file in scope, including CSS, has the three-line Rigi header.
- **Flags:** there is no `location.search`, `URLSearchParams` or flag parsing in scope.
- **SSR:** all four routes are `ssr: false`, so `matchMedia` in `useReducedMotion`'s lazy initialiser, `sheetTransition()` during render, and `localStorage` (inside an effect, wrapped in try) are not hydration hazards.
- **Hooks:** `useInView`, `useRaf`, `useTime`, `Compare`, `Stages`, `useTween` and every ResizeObserver hook clean up their observers, rAFs and timeouts.
- **Memoisation:** sketch geometry in `SketchPath`, `SketchPolyline`, `Hachure`, `Stipple`, `HandDot` and `PhotoLine` is memoised on value inputs. `SketchPolyline`'s memo depends on the identity of the `points` array, so callers must memo their arrays.
- **Fonts:** 28 `@font-face` rules, all `font-display: swap`, split by unicode-range.
