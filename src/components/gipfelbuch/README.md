# Rigi Gipfelbuch: authoring guide

The gipfelbuch lives at `/gipfelbuch` (graph index) and `/gipfelbuch/<id>` (one page per concept).
Data: `src/lib/gipfelbuch/graph.ts` (`GIPFELBUCH_NODES`), helpers: `src/lib/gipfelbuch/graph-utils.ts`.

## Hand pass, 2026-10-01 night (session 16): this section overrides older rules below

Spec: `reports/gipfelbuch-hand-sketch-2026-10-01.md`. Research: `reports/gipfelbuch-hand-sketch-research/` (sketch style, Swiss cartography and swisstopo, an audit of what was lost).

- **Hand is the form; print is the exception.** The whole sheet is written by hand:
  - body: Playpen Sans (`--gb-font-body`);
  - titles and `h2`/`h3`: Caveat 700 lettering (`--gb-font-letter`);
  - kickers, labels and peak names: Patrick Hand SC block capitals (`--gb-font-caps`, `.gb-caps`, `.nb-label`);
  - numbers: hand figures, Shantell Sans with tabular figures (`--gb-font-figure`, `.gb-num`, `.nb-num`);
  - notes: Caveat (`HandText`, `MarginNote`).

  Print survives only for code (mono), equations (`--gb-font-math`) and an opt-in `.gb-print`. Never name a face inline.
- **Figure labels** are `HandLabel` / `HandNote` (`viz/labels.tsx`; formerly PrintLabel/PrintNote). Use `caps` for names and `italic` for heights and derived values (LK rule).
- **Data stays on its pixels, but it is drawn by hand.** `data` on `SketchPath`/`SketchPolyline`/`PenLine`/`PenCircle`/`HandDot` is one constant-width pen pass within `DATA_TOLERANCE` (0.5 px). Furniture gets two passes and more roughness. Photos and DEM rasters are still never filtered.
- **Notes are required, not capped.** Every page carries hand notes with leaders, struck first guesses with red corrections, and circled numbers keyed to figures (`gipfelbuch.check.ts` enforces a minimum). Hand notes may lean up to 4°; labels on drawings stay upright.
- **Swiss field-sketch vocabulary** lives in `notebook/carto.tsx`:
  - Kroki title, north arrow and hand scale bar on map-like figures;
  - trig triangle, spot ×, italic heights;
  - rock hachure, scree, Kroki hatch (forest diagonal, buildings vertical, water horizontal);
  - trail lines and blazes, grade boxes;
  - peak leaders and station rays;
  - contour scribbles and profile sketches.

  Hand marks for prose (underline, double, wavy, circle, box, strike, highlight), washes and a pencil construction layer live in `notebook/marks.tsx`.
- **Still out** (user, 2026-10-01): paper grain, tape, tilted photos, the red margin rule and sheet-edge ticks. The soft grid stays.

## Restore pass, 2026-10-01 (sessions 2d and 25)

The record is `reports/gipfelbuch-restore-2026-10-01.md`, and the spec is `reports/gipfelbuch-best-of-both.md` §2.

- **One hero per sheet.** A page whose Fig. 1 is a real photo drawn with `RealPhoto bleed` is listed in `PAGE_HERO` (`tafel/sheets.tsx`), and the shell then skips its Tafel. Every other sheet keeps the shell Tafel.
- **Geo bleed.** `RealPhoto bleed` (true = 0.14 of the frame per side) carries the photo's measured world past the frame onto paper. That means the Tafel bake's ridge strokes in contour brown, a compass ruler and the summits outside the frame, all faded to the edges. Use it on one big photo per wide figure. Never use it in Trio, Gallery or thumbnails; in a Compare, give both sides the same `bleed`.
- **Plate.** `<Figure plate>` is a paper-deep ground across the full track for the hero.
- **Data on its pixels.** `data` on `SketchPath`, `SketchPolyline`, `PenLine`, `PenCircle` and `HandDot` draws one pen pass within 0.5 px (hand pass; it was exact geometry). `PlotSeries` is exact, and `PlotArea` is a tint with hatch on top.
- **Shared figure helpers.** `HandLabel`, `HandNote` and `HandRange` live in `viz/labels.tsx`. `CrispLine` (the photo-overlay triple) lives in `viz/real.tsx`.
- **Galleries.** `Gallery tone` adds a result/failure tag. `RealPhoto` imprint is off by default.
- **Shell.** The ContourField sits behind the title, and FieldNotes sits under the Ledger. One HandRule closes the header. "Where it sits" (NotebookTrail + Leads to / Referenced by) is the sheet's only route device, and Signposts follow it. The soft grid is the SheetFrame ground (`nb-book`). The index is the Blattübersicht, then the Feldbuch (NotebookMap).
- **Inks for node code.** `SWISS` lives in `swiss/inks.ts`, which has no CSS import, so node checks can load modules that draw with it.

## Adding a bespoke page

Create `src/lib/gipfelbuch/pages/<id>.tsx` (the id is the node's `id`). No registry to edit: pages are found with
`import.meta.glob` and lazy-loaded. Without a file the page shows a generated "constellation" fallback.

```tsx
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { Callout, CodeRef, DemoImage, Figure, Flow, Plot, Section, Stat, Steps, useTime } from "#/components/gipfelbuch/viz";

export default function Page({ node }: { node: GipfelbuchNode }) {
	return (
		<>
			<Section title="How it works" kicker="Mechanism">
				<p>Prose goes here. <strong>Bold</strong>, <em>em</em>, <code>inline code</code>, lists and links are pre-styled.</p>
			</Section>
			<MyVisual />
			<Callout tone="lesson">Precision beats recall.</Callout>
		</>
	);
}
```

The shell (hero, summary lead, rail with status/code/reports, connections, neighbourhood graph, prev/next)
is already provided by `ConceptPage`: do NOT repeat the title, summary, modules or reports. A page is only the
body: sections and visuals. A crashing page is caught and replaced by the fallback.

## Design rules (the canon)

The programme is `reports/gipfelbuch-design-book.md` (rules T, I, G, L, F, H, A; the one-page canon is section 22).
Short form for page authors:

- **One object.** A surveyor's field book bound into a map sheet. Print is the form, the hand is the observer.
- **Every element carries a fact (F1).** The scale bar is true to its figure (`ScaleBar metresPerPixel`, or
  `SheetScaleBar` under the sheet map), and a page's legend lists only its own symbols
  (`legendItems.tsx`, `LEGEND_BY_CONCEPT`). A figure can carry an `imprint` (Aufnahme / Revision / Stich, F2);
  `RealPhoto` and `DemPatch` set theirs from the measured data.
- **Data on its pixels, everything by hand (hand pass).** Photos and DEM rasters are never filtered. Measured lines are
  at least 1.2 px, constant width, one pen pass within 0.5 px (`data` prop on `SketchPath` / `SketchPolyline`). Certainty is line
  style (solid measured, dashed 4/2 modelled, dotted open), never wobble.
- **The hand writes everything (hand pass).** Notes lean at most 4 degrees; photos sit square.
- **Type and ink (T1, I1).** Faces come from the hand role tokens (see Hand pass). Only `TYPE` sizes; text is ink, `gb-secondary` or a semantic ink, never an alpha ladder.
- **Grid and space (G1, G9).** A 6 px unit and a 24 px line; blocks sit a multiple of 24 px apart; sections are
  separated by space (48 px, chapters 72 px), not rules, boxes or rings. Body measure is at most 66 ch.
  `ConceptPage` uses named grid lines: Standortfeld, text, then margin and rail.
- **Static is the design (A1).** `useInView` / `Reveal` show everything at once without IntersectionObserver, under
  reduced motion, under webdriver and in print. Sheet-to-sheet links use `viewTransition={sheetTransition()}`
  and `SheetFrame` carries `view-transition-name: gb-sheet`.
- **No node-link graphs**, no decorative shadows, no coffee rings. When unsure, remove.

## Theme: the map sheet (`#/components/gipfelbuch/swiss`)

Gipfelbuch is printed on a Swiss topographic sheet: warm paper, three inks (rock black, contour brown,
water blue) plus route red, and map furniture around the content. Every ink is a Brezine chart swatch
(`swiss/palette.ts`, Ascher codes in comments). Plan and sources: `reports/gipfelbuch-swiss-aesthetic.md`.

- **Scope.** Page roots use `GB_THEME` (class `gb-swiss`, `swiss/theme.css`). Inside it, `--color-white`
  is ink and `--color-black` is paper, so `text-white/NN`, `ring-white/NN` and `bg-white/[..]` read as ink
  on paper. `var(--rigi-paper)` is ink and `var(--rigi-ink)` is paper (they are swapped). The landing page and
  library keep the dark `SITE_THEME`.
- **Inks.** `var(--gb-ink)` text and rock drawing, `--gb-contour` (NB) contours and rules, `--gb-water` (GL),
  `--gb-forest` (GG), `--gb-red` (SR) route and accent, `--gb-navy` (PB) peak lettering, `--gb-sign` (SY)
  Wegweiser yellow, `--gb-paper` / `--gb-paper-deep` grounds. Canvas and anywhere a CSS var can't reach:
  `SWISS.*`. `var(--accent)` is still the concept's group colour (`groupColor`, paper-tuned hex).
- **Type.** Seven sizes only, from the `TYPE` map in `swiss/type.ts` (micro, kicker, caption, body, lead,
  h3, h2, h1, stat). Titles use `.display-title` / `TYPE.h1` (hand lettering, Caveat 700, since the hand pass); body GB Hand Body
  (Fira Sans); `.gb-caps` condensed caps for kickers; `.gb-coord` / `.gb-num` GB Mono with tabular figures.
  Never name a font inline: use the `--gb-font-*` tokens. Italic marks a category (water, derived values),
  never ornament.
- **Literals.** Don't write light-on-dark literals (`white`, `#ece6da`) for off-photo drawings: use the
  tokens. Overlays drawn on a photo keep `LAYER_STYLE` colours; equation symbols use their darker paper
  kin (`math.tsx` `PAPER_INK`).
- **Furniture.** `SheetFrame` (LV95 corners, Blatt box, imprint; no margin ticks), `Cartouche`,
  `SheetMap` (the real Niederhorn / Thunersee sheet: swisstopo relief, Mapterhorn contours, swissNAMES3D
  peaks, the 12 demo viewpoints; baked by `scripts/gipfelbuch/data-sheet.ts`), `ContourField` (page-header
  contours), `Waymark` / `waymarkForStatus` (SAC blazes for status), `Signpost` (prev/next), `Legend` and
  symbols, `ScaleBar`, `HachureRule`. Preview them all at `/dev/gipfelbuch-sheet`.

## Design system (type, grid, inks)

The full rationale and sources are in `reports/gipfelbuch-field-notebook-design.md` §2. In short:
- Type sizes come only from `swiss/type.ts` (`TYPE.micro|kicker|caption|body|lead|h3|h2|h1|stat`).
- Hand pass: the H1 and section heads are Caveat 700 lettering; there is no serif except in equations.
- Secondary text uses `var(--gb-secondary,#4a545c)` and never BL.
- Italic (`.gb-derived`) marks an estimated or derived value.
- Tables use `.gb-table`: one header rule, right-aligned tabular numbers.
- Line style encodes certainty: solid = measured, dashed = approximate or model, dotted = open.
- Hand notes are Caveat at 18 px or more, up to about 20 words each, as many as the page needs. Figure labels use `variant="label"` (Shantell Sans). Digits inside `HandText` render in print automatically.
- Kitsch test: every material element (stamp, waymark) must carry a fact. No shadows.
- Soft sheet (user, 2026-10-01): no paper texture and no notebook props. The ground is flat warm white (`--gb-paper`, W 96% + YY 4%) with a faint grid (`--nb-grid` 6 %, index ruling 8 %). There is no grain, tape, tilted prints, red margin rule or sheet-edge ticks. Prints sit square on a thin white mat. Hand notes, circled numbers and sketched figures stay.
- `gipfelbuch.check.ts` lints the pages for the text contrast floor (`text-white/65` or higher), half-pixel sizes, rounded pills and `display-title`. To exempt a line, put `// gb-lint-allow` on it.

## Field notebook and sketch rules (`#/components/gipfelbuch/notebook`)

The whole Gipfelbuch is one look: a Swiss topographer's field book. That means map paper and --gb-* inks, the sheet chrome from `swiss/`, and every visualization drawn by hand. The research behind it is in `reports/gipfelbuch-swiss-sketch-research.md`, `reports/gipfelbuch-sketch-rendering.md` and `reports/gipfelbuch-notebook-research.md`. The index's core map is `NotebookMap`, with its order in `entries.ts`. `notebook.check.ts` requires every node to appear exactly once and every group to have a `#group-<id>` anchor.

**Toolkit** (`notebook/Ink.tsx`, `sketchify.ts` and `sketch.ts`; all seeded and deterministic, so pass a stable string seed such as `${figureId}-${seriesId}`, never an array index that can shift):

| Was | Becomes |
| --- | --- |
| `<path d>` / `<line>` / `<polyline>` stroke (data or furniture) | `<SketchPath d seed color width />` or `<SketchPolyline points seed />`. Two pen passes with jitter bounded to `tolerance` (0.9 px default; use 0.6–0.7 on photos). Data stays on its pixels; this is tested in `notebook.check.ts`. Series over 400 points use one pass. |
| Straight furniture lines, ticks, axes | `<PenLine from to seed />` |
| Arrows | `<PenArrow from to seed bend />` (an open two-line head) |
| Circles / rings / markers | `<PenCircle center radiusX seed />` (an open pen loop), or `<HandDot x y r seed />` for filled points |
| Rejected / wrong | `<PenCross center seed />`, or HTML `<s>` in red |
| Measured gap | `<PenDimension from to seed />` |
| `<rect>` frame / box | Remove it (separate by paper and spacing). Use `<SketchRect>` only where a frame carries meaning. Never a closed crisp rectangle. |
| Flat area fill / gradient / translucent band | `<Hachure d seed color gap angle />` at -45° and gap 4–7 px, one angle per figure. `<Stipple d seed />` for uncertain or "assumed" areas. A shape is filled or outlined, rarely both. |
| SVG `<text>` annotation | `<HandText x y>`. Ticks and numbers stay in Plex Mono (`className="nb-num"`). |
| Canvas strokes / fills | `strokeSketchCanvas(ctx, points, seed)`, `hachureCanvas(ctx, rings, seed)` |
| Dense legacy line art that would be costly to resample | wrap the `<g>` in `filter="url(#nb-wobble)"` (or `#nb-grain` for graphite edges). `<SketchDefs/>` is mounted once per page. Never on text, photos, DEM rasters or animated groups. |

**Rules.**
- Photos and DEM rasters are never filtered, tinted or hatched; overlays on them get a plain paper halo under a sketched stroke.
- There is at most one red (route) emphasis per figure, plus red for "the answer" against a struck grey guess.
- Ink roles: ink is axes, series and text. Pencil/relief is the prior or uncertainty. Brown is DEM and terrain. Water is image-measured quantities. Forest is results. Navy is peaks.
- Stroke tiers in an 800-px SVG: grid 0.5, index grid 0.9, axis 1.2, series 1.6, route 2.2.
- Hand vs print (hand pass): everything is hand, including headings, body, tables and tick numbers. Print is only for code and equations.
- HTML containers: no `border`/`ring`/`outline` boxes and no rounded cards. Separate by paper fill (`bg-[var(--gb-paper-deep)]`) and spacing. Strokes stay only for state (focus, selected tab).
- Interactive and animated figures keep their behaviour, ARIA and keyboard handling. Generate sketch paths in `useMemo`, and inside rAF loops reuse precomputed paths where possible.
- Step notes in `NotebookMap.tsx` (`notes.tsx`) are written from the selected photo's measured JSON. `useNotebookPhoto` shares the selected photo across the index and the concept pages.

## Primitives (`#/components/gipfelbuch/viz`)

| Export | Use |
| --- | --- |
| `Section` `{title, kicker?}` | Titled prose block. Styles `<p> <ul> <ol> <code> <strong> <em> <a>`. `PROSE` is the class string if you need it elsewhere. |
| `Figure` `{caption?, label?, bleed?, pad?}` | Framed, fade-in-on-view container for any visual. `label` is a small accent tag ("Fig. 1"). Wrap every visual in one. |
| `Callout` `{tone, title?}` | Margin-rule aside. tone: `note` `lesson` `warning` `result` `negative`. |
| `Flow` `{nodes:[{label, sub?, color?}]}` | Horizontal pipeline with animated arrows; wraps on phones. |
| `Steps` `{steps:[{title, body}]}` | Numbered vertical steps with a spine. |
| `Plot` `{x:[a,b], y:[a,b], xLabel?, yLabel?, width?, height?, fmtX?, fmtY?}` | Responsive SVG axes + grid; children is `(s) => svg` with `s.x(v) s.y(v) s.line(pts) s.area(pts) s.box`. |
| `Stat` `{value, label}` | Big serif number with a caption. |
| `CodeRef` `{path}` | A repo path as a chip (document glyph for `.md` / `reports/`). |
| `DemoImage` `{name, aspect?, alt?}` | Bundled imagery: `demo-01`..`demo-05` (thumbs), `hero`, `drape`, `overlay` (screenshots). |
| `useInView()` | `[ref, inView]`, once by default. |
| `useTime()` | `[ref, seconds]`, re-renders each frame only while visible; frozen under reduced motion. Attach `ref` to the figure root. |
| `useRaf(cb, active)` | `cb(seconds, dt)` per frame without re-rendering (for canvas). |
| `useReducedMotion()` | Boolean. |

### Example: an animated figure

```tsx
function Wave() {
	const [ref, t] = useTime<SVGSVGElement>();
	const pts: [number, number][] = Array.from({ length: 80 }, (_, i) => [i / 8, Math.sin(i / 8 + t)]);
	return (
		<Figure label="Fig. 1" caption="A horizon profile, sweeping.">
			<Plot x={[0, 10]} y={[-1, 1]} xLabel="azimuth" yLabel="elevation">
				{(s) => <path ref={undefined} d={s.line(pts)} fill="none" stroke="var(--accent)" strokeWidth={2} />}
			</Plot>
		</Figure>
	);
}
```
(For `useTime` attach the ref to an element you own, e.g. a wrapper `<div ref={ref}>` inside the Figure.)

## Real data (`scripts/gipfelbuch/build-data.ts` → `public/demo/gipfelbuch/`)

Pages are grounded in **measured** output of the real CPU pipeline run on the 12 bundled Niederhorn photos
(7 Sept 2026): detectSkyline → computeHorizon (Terrarium DEM) → solvePose (→ refinePose on reject) → viewPeaks /
layoutPeakLabels. Regenerate with `npx tsx scripts/gipfelbuch/build-data.ts` (~1 min, cached tiles).

| Export | Use |
| --- | --- |
| `useGipfelbuchPhoto(id)` | `GipfelbuchPhotoData \| null` for `demo-01`..`demo-12`: gps/eye, raw sensors, prior + solved camera (confidence, residual, inliers, coverage, ambiguity, Δyaw…), the live app's saved pose, skyline rows+weight, DEM rows at prior/solved, residual stats, horizon profile across the view (with ridge crests), peaks (visible / labelled / px at prior+solved), terrain profile along the view axis, DEM hillshade patch, sky-probability image, stage timings. All px are in the 800-px-wide working frame. |
| `useGipfelbuchIndex()` | 12-photo summary (accepted, stage, Δ, residuals, labelled names, ms) + `groundTruthEval` rows from `out/eval*/report.json`. |
| `RealPhoto {data, layers, toggles?, crop?, labelInfo?, maxLabels?, children?}` | The real photo with measured overlays: `skyline` `weight` `prior` `solved` `peaks` `priorPeaks` `sky`. `crop=[x0,y0,x1,y1]` (working px) zooms; `children(d)` draws extra SVG in photo px. |
| `DemPatch {data, cone?, peaks?, children?}` | Hillshade ±20 km, north up, camera dot, prior (dashed magenta) / solved (cyan) view cones, labelled peaks; `children(d, toPx(az, distM))`. |
| `PhotoPicker {value, onChange, ids?, mark?}` | Thumbnail strip to switch the demo photo a figure shows. |
| `Measured {data}` | Provenance line for captions ("Measured on demo-03 (terrarium DEM) by scripts/gipfelbuch/build-data.ts, 2026-10-01."). |
| `LAYER_STYLE`, `rowsPath` | Shared colours (prior magenta dashed, solved cyan, detected yellow) and the row→path helper. |

Facts worth knowing (2026-10-01 run): 10/12 accepted (9 by solvePose, demo-12 only by refinePose); demo-07 and demo-11
rejected (a person's head/hair occludes the skyline in 11/12). Compass errors span −19°…+11.5° (demo-09/10 ≈ −19°).
Median skyline residual falls from 5–43 px (prior) to 0.9–7.7 px (solved). Horizon ≈ 3.5–5 s, skyline ≈ 0.1–0.3 s,
solve 0.02–1.3 s on CPU. People: only demo-01/02/03/06 are people-free full frame; for the others crop to the
skyline band (crop) unless the person is the point (occlusion in demo-11/12).

## Guidelines for page authors

- Be accurate to the code: read the modules in `node.modules` and state what they really do. Numbers must come
  from `reports/` or the measured gipfelbuch data, never invented.
- Ground every page in real images and data: lead with a `RealPhoto` / `DemPatch` / a plot of measured values
  for the concept, and caption it with `<Measured data={d} />`. Synthetic or schematic figures are fine for
  showing a mechanism in isolation, but say so in the caption and pair them with the real case.
- One strong custom visual beats three weak ones. Make it explain the mechanism, ideally with light motion
  (use `useTime`, never `setInterval`; respect reduced motion).
- No wheel or scroll hijacking, no external fetches, no new npm deps. Images and data only from `public/demo` (incl. `public/demo/gipfelbuch`).
- Pages must work at 390 px wide: use `viewBox` SVGs with `w-full h-auto`, flex-wrap, no fixed widths.
- Killed concepts: tell the story of why (what was measured), with the `negative` callout.
- Keep each page self-contained in its file; shared helpers go in `src/components/gipfelbuch/viz/`.

## Explainer pages (concise, visual-first) — `#/components/gipfelbuch/viz/explain`

Research behind this: `reports/explainer-research.md`. Exemplar: `src/lib/gipfelbuch/pages/skyline.tsx`.

**Recipe (300–450 words of visible copy):**
1. **Hero figure first**, on a real photo (`RealPhoto`/`DemPatch`, usually inside `Stages` or `Compare`). Its caption is
   the claim, one sentence with one measured number, plus `<Measured data={d} />`.
2. **The idea** — a `Beat` whose title is a claim ("Every column casts one vote, with a confidence."), 1–3 short sentences.
3. **How it works** — a `Trio` of 3 steps, each a mini real crop (or a simple SVG) and ≤ 15 words.
4. Optional **one mechanism figure** (an existing synthetic demo is fine; caption says "Synthetic scene, real algorithm").
5. **Where it fails** — a real failure case (small multiples via `Gallery`), with what the system does about it.
6. **`Numbers`** — 2–4 measured/reported values with units and denominators, plus a source line.
7. A one-line **Next:** link to the following concept.
8. **`Details`** (collapsed) — the precise mechanism, code identifiers, parameters, extra figures, `CodeRef`s. This is
   the ONLY place for code identifiers; move the existing dense prose here rather than deleting it.

**Copy rules:** headline = claim; sentences ≤ 15 words, one number each; plain words, active voice ("we nudge the
camera until the lines overlap"); no code identifiers outside Details; explain a term once ("yaw, which way the camera
points") and reuse it; name failures honestly and say what the system does; numbers carry units and a denominator and
come from measured data or `reports/` only.

| Export | Use |
| --- | --- |
| `Beat {kicker?, title, children?, figure?}` | Short section: claim headline + 1–3 sentences (larger type than `Section`). |
| `Stages {stages:[{label, caption, render}]}` | Step through stages on one frame; auto-advances while visible until touched; last stage under reduced motion. |
| `Compare {before, after, beforeLabel, afterLabel, start?}` | Drag/arrow-key wipe between two pixel-aligned renderings (e.g. prior vs solved). Sweeps once on view. |
| `Trio {steps:[{title, body, visual}]}` | 3–4 numbered steps side by side, each with a mini visual. |
| `Gallery {ids, tile(d), label?(d), cols?}` | Small multiples over demo photos (loads each `useGipfelbuchPhoto`). |
| `Numbers {items:[{value,label}], source?}` | Headline numbers row + source line. |
| `Mark {x,y,n,k?}` + `MarkList {items}` | Numbered in-place annotations on a `RealPhoto` (inside `children`), with the notes below. |
| `Key {color, dashed?}` | Inline colour key for captions ("<Key color=… dashed>sensor guess</Key>"). |
| `Details {title?}` | Collapsed "Details for engineers". |
| `skylineBand(d, minH?)` | Crop to the skyline band (keeps people out, ridge large). |

## Math kit — `#/components/gipfelbuch/viz` (`math.tsx`)

Show the math next to the real visual it describes, the way the landing page's "Guess, measure, correct, snap"
scene pairs a live residual readout with the photo. Use at most one or two short equations per page, in a `Beat`
directly after (or beside) the figure they explain, and never one without a figure.

| Export | Use |
| --- | --- |
| `Eq {children, where?, label?}` | Display equation. `where: [{sym, c?, text}]` is a plain-words legend under it. |
| `Sym {c?, upright?}` | A symbol coloured like the figure layer it measures: `c="solved"` (cyan DEM line), `"prior"` (magenta), `"skyline"` (yellow) or any CSS colour. |
| `Frac {n, d}` | Stacked fraction. |
| `Op {op, under?}` | Operator with limits underneath (`Σ` over columns, `argmin` over yaw). |

```tsx
<Eq where={[
	{ sym: "r", c: "skyline", text: "detected skyline row in column x" },
	{ sym: "h", c: "solved", text: "DEM horizon row for camera pose θ" },
]}>
	<Sym>θ</Sym>* = <Op op="argmin" under={<Sym>θ</Sym>} /> <Op op="Σ" under={<Sym>x</Sym>} />
	<Sym>w</Sym><sub>x</sub> ρ(<Sym c="skyline">r</Sym><sub>x</sub> − <Sym c="solved">h</Sym><sub>x</sub>(<Sym>θ</Sym>))
</Eq>
```

Rules: write the equation the code really computes (cite the function in `Details`), name each symbol in plain
words, and colour symbols so the reader can find them in the figure.

## Margin notes — `#/components/gipfelbuch/viz` (`MarginNote.tsx`)

`<MarginNote mark="1" hand?>text</MarginNote>` sits inline in prose: a red superscript mark at the call site, the
note right after it in DOM order (`aria-describedby`). At >= 1024px the note moves into the margin lane (columns
11-12 of ConceptPage's grid; the rail has 9-10) level with its mark via CSS anchor positioning, Tufte float where
unsupported; below that it is an indented caption. Print sets it inline.

- At most 3 per entry, kept short; a `hand` note is 12 words or fewer, string children only, digits set in print.
- Notes are not stacked: keep two notes at least a few lines apart. The prose column must be `relative` (ConceptPage's
  is) and no transformed ancestor (a `Reveal` mid-animation) may sit between it and the note.
- Use it for asides that do not break the argument; keep measurements in the text, doubts in the margin.
