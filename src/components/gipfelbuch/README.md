# Rigi Gipfelbuch: authoring guide

The Gipfelbuch lives at `/gipfelbuch` (index) and `/gipfelbuch/<id>` (one sheet per step). Data: `src/lib/gipfelbuch/graph.ts` (`GIPFELBUCH_NODES`, in data-flow order), helpers: `src/lib/gipfelbuch/graph-utils.ts`.

The design rules (type, inks, layout, hand and sketch, figures, motion, copy, lint), the sheet list, open fixes and decisions waiting are in **`reports/gipfelbuch.md`**. This file is the how-to: where things live and which kit piece to use.

In one line: a Swiss topographer's field book on map paper. Everything is written by hand (print only for code and equations), every figure is sketched, measured data stays on its pixels, photos and DEM rasters are never filtered, space separates (no boxes, no shadows), static is the design.

## Folders

| Folder | What |
| --- | --- |
| `ConceptPage.tsx` | The sheet shell: register entry, lettered H1, claim, Tafel hero, ledger, field notes, body, Glossar (`OntologyPanel`), colophon, `DevFold`, signposts, `NotebookTrail`. Do not repeat title, summary, modules or reports in a page. |
| `swiss/` | Theme (`GB_THEME` = `gb-swiss`, `theme.css`, `fonts.css`, `type.ts`, `palette.ts`, `inks.ts`) and map furniture: `SheetFrame`, `Cartouche`, `SheetMap` (Niederhorn sheet, baked by `scripts/gipfelbuch/data-sheet.ts`), `ContourField`, `Waymark`, `Signpost`, `Legend`, `ScaleBar`, `HachureRule`, `Colophon`, `Marks` (LK point symbols), `imhof.tsx`, `print.css`. Preview: `/dev/gipfelbuch-sheet`. |
| `notebook/` | Pen kit (`Ink.tsx`, `sketch.ts`, `sketchify.ts`), Kroki and LK primitives (`carto.tsx`), prose marks and washes (`marks.tsx`), the Feldbuch index (`NotebookMap`, order in `entries.ts`, notes in `notes.tsx`), `useNotebookPhoto` (the photo shared by index and sheets). |
| `viz/` | Figure kit: `Figure`, `Section`, `Callout`, `Steps`/`Flow`, `Plot`, explainer blocks (`explain.tsx`), real data (`real.tsx`, `GeoSpill.tsx`, `StoryMap.tsx`), `PhotoStory`, live plates (`live.tsx`, see `LIVE.md`), labels, math, margin notes, motion and overlay grammar (`motion.ts`, `overlay.tsx`, `ground.ts`, `sequence.ts`, `tiles.ts`). |
| `tafel/` | Sheet hero, ledger, the per-sheet `SHEETS` table, Blattübersicht, Wegnetz; see `tafel/README.md`. |

## Adding a page

Create `src/lib/gipfelbuch/pages/<id>.tsx` (the id is the node's `id`). Pages are found with `import.meta.glob` and lazy-loaded; without a file the sheet shows a generated fallback, and a crashing page is caught and replaced by it. A new sheet also needs its `SHEETS` entry in `tafel/sheets.tsx` and its place in `tafel/chapters.ts` (`tafel-sheets` check).

```tsx
import type { GipfelbuchNode } from "#/lib/gipfelbuch/types";
import { Figure, RealPhoto, useGipfelbuchPhoto } from "#/components/gipfelbuch/viz";
import { Beat } from "#/components/gipfelbuch/viz/explain";

export default function Page({ node }: { node: GipfelbuchNode }) {
	const d = useGipfelbuchPhoto("demo-01");
	return (
		<>
			<Figure label="Fig. 1" caption="The claim, one sentence, one measured number.">
				{d && <RealPhoto data={d} layers={["skyline", "solved"]} bleed />}
			</Figure>
			<Beat title="Every column casts one vote, with a confidence.">
				<p>One to three short sentences.</p>
			</Beat>
		</>
	);
}
```

**Recipe** (300–450 words of visible copy): hero figure on a real photo first (caption = the claim plus `<Measured data={d} />`); the idea as a `Beat`; how it works as a `Trio`; optionally one mechanism figure (synthetic, on the real demo-09 ground, `source="Skizze"`); where it fails (`Gallery` of real failures and what the system does); `Numbers` (2–4 measured values with units and denominators, plus source); `Details` (collapsed, the only place for code identifiers and `CodeRef`s). At least 6 hand notes (`HandText`, `MarginNote`, `HandMark`). Run `node scripts/ci/run.mjs fast --only gipfelbuch,gipfelbuch-notebook,gipfelbuch-contrast,tafel,tafel-sheets`.

## Real data (`public/demo/gipfelbuch/`)

Pages are grounded in measured output of the real pipeline on the 12 bundled Niederhorn photos (2026-09-07): detectSkyline → computeHorizon → solvePose (→ refinePose on reject) → viewPeaks / layoutPeakLabels. Regenerate with `npx tsx scripts/gipfelbuch/build-data.ts` (about 1 min with cached tiles); other bakes are `scripts/gipfelbuch/data-*.ts` and `bake-*.ts`.

| Export | Use |
| --- | --- |
| `useGipfelbuchPhoto(id)` | `GipfelbuchPhotoData \| null` for `demo-01`..`demo-12`: GPS and eye, sensors, prior and solved camera (confidence, residual, inliers, Δyaw…), skyline rows and weights, DEM rows at prior and solved, horizon profile, peaks, terrain profile, hillshade patch, sky probability, stage timings. All px are in the 800-px working frame. |
| `useGipfelbuchIndex()` | 12-photo summary plus the ground-truth eval rows. |
| `RealPhoto {data, layers, toggles?, crop?, bleed?, spillCursor?, spillT?, children?}` | The photo with measured overlays: `skyline`, `weight`, `prior`, `solved`, `peaks`, `priorPeaks`, `sky`. `crop` zooms (working px); `children(d)` draws in photo px. |
| `bleed` (on `RealPhoto`) | The spill: the photo's world runs past the frame to the window edge (ridge strokes in terrain ink, compass ruler, summits beyond the frame) and echoes the photo's layers through the bake's wide DEM horizon (yaw ±85°). `true` = up to 0.5 photo width per side, a number caps it; stops inside `[data-gb-bleed-bounds]`; phones get the ruler only. In a `Compare` give both sides the same `bleed`. Never in Trio, Gallery or thumbnails. |
| `spillCursor {x, az, label, layer}`, `spillT` | Mark a column or bearing on the spill; set the spill's pose (0 guess … 1 solved), which slides about 600 ms. |
| `DemPatch {data, cone?, coneFill?, peaks?, children?}` | Hillshade ±20 km, north up, camera dot, prior and solved view cones. |
| `StoryMap` | Map that follows the photo (cone, rays, guess ghost); the story can be scrubbed from it. |
| `PhotoPicker`, `Measured {data}` | Switch the photo a figure shows; provenance line ("Measured on photo NN.", details in `title`). |
| `inkFor(layer, "photo"\|"paper")`, `LAYER_INKS` (`viz/inks.ts`) | One colour per layer for RealPhoto, DemPatch, StoryMap, `Sym` and `Key layer=`. |

Facts from the 2026-10-01 run: 10/12 accepted (demo-12 only by refinePose); demo-07 and demo-11 rejected (a person occludes the skyline). Compass errors span −19° to +11.5°. Median skyline residual 5–43 px prior → 0.9–7.7 px solved. Only demo-01/02/03/06 are people-free full frame; crop the others to the skyline band (`skylineBand`) unless the person is the point.

## Figure kit (`#/components/gipfelbuch/viz`)

| Export | Use |
| --- | --- |
| `Figure {label?, caption?, bleed?, plate?, pinned?, source?, ground?}` | Every visual sits in one, on the wide track. `pinned="demo-NN"` for a figure fixed to one photo; `source="Skizze"` for synthetic ones; `plate` is a paper-deep ground; `ground` sets the `--fig-*` palette. |
| `Section {title, kicker?}`, `PROSE` | Titled prose block (lettered heading with marker underline). |
| `Beat {kicker?, title, figure?}` | Claim headline plus 1–3 sentences. |
| `Stages {stages:[{label, caption, render, kind?, frame?}]}` | Steps through stages on one frame; plays once when 45% in view, caption is `aria-live`. |
| `Compare {before, after, beforeLabel, afterLabel}` | Drag or arrow-key wipe between two pixel-aligned renderings. |
| `Trio`, `Gallery {ids, tile, tag?}`, `Numbers`, `Details`, `Mark`/`MarkList`, `Key`, `skylineBand` | Explainer blocks (`Beat`, `Stages`, `Compare` and these come from `viz/explain`); Gallery `tag` is a circled verdict (tones in `tiles.ts`). |
| `PhotoStory {focus?, playback?, crop?, bleed?}` | The alignment story as one film: guess, measure, correct, snap (or keep); see `LIVE.md`. |
| `LiveReveal`, `LiveCompare`, `LiveDrape`, `LiveStepInside`, … | The landing's engines as notebook plates, one per sheet at most; see `LIVE.md`. |
| `Callout {tone}` | `note`, `lesson`, `warning`, `result`, `negative` (killed ideas, with what was measured). |
| `Steps`, `Flow`, `Plot`, `Stat`, `CodeRef`, `FigureSkeleton` | Circled steps, pipeline, pen-axis plot (`PlotSeries` exact, `PlotArea` tint plus hatch), hand-figure stat, repo path chip, loading state. |
| `HandLabel {caps?, italic?}`, `HandNote`, `HandRange` | Figure labels (`viz/labels.tsx`): `caps` for names, `italic` for heights and derived values. No raw SVG `<text>`. |
| `Eq {where?}`, `Sym {c?}`, `Frac`, `Op` | One or two equations per page, next to the figure they explain; write what the code computes and colour symbols like their layer. |
| `MarginNote {mark, hand?}` | Inline in prose: red superscript mark, note in the margin lane at ≥ 1024 px (anchor positioning), inline below. About 20 words; keep notes apart; no transformed ancestor between the prose column and the note. |
| `useTime`, `useRaf`, `useInView`, `useReducedMotion`, `useDrawOn`, `useAutoScrub`, `useBeats`, `useBeatClock` | Motion hooks; every one freezes on the settled frame under reduced motion, webdriver and print. Never `setInterval`. |

## Pen kit (`#/components/gipfelbuch/notebook`)

All seeded and deterministic: pass a stable string seed such as `${figureId}-${seriesId}`, never an array index. Build paths in `useMemo`.

| Instead of | Use |
| --- | --- |
| `<path>` / `<polyline>` stroke | `SketchPath d seed`, `SketchPolyline points seed`; add `data` for measured lines (one pass within 0.5 px). Series over 400 points use one pass. |
| straight lines, ticks, axes | `PenLine from to seed` |
| arrows | `PenArrow from to seed bend` |
| circles, markers | `PenCircle`, `HandDot` |
| rejected or wrong | `PenCross`, or HTML `<s>` in red |
| measured gap | `PenDimension` |
| `<rect>` frame | nothing (separate by space); `SketchRect` only where a frame means something |
| flat fill or translucent band | `Hachure d seed angle` (one angle per figure), `Stipple` for assumed areas |
| SVG `<text>` | `HandText`, `HandLabel` |
| canvas strokes | `strokeSketchCanvas`, `hachureCanvas` |
| map-like figure furniture | `carto.tsx`: `KrokiTitle`, `NorthArrow`, `HandScaleBar`, `RockHachure`, `ScreeStipple`, `KrokiHatch`, `TrailLine`, `Blaze`, `GradeBox`, `HandName`, `PeakLeader`, `StationRays`, `ContourScribble`, `ProfileSketch` |
| emphasis in prose | `HandMark` (underline, double, wavy, circle, box, strike, highlight, bracket), `Wash`, `PencilLayer` |

Stroke tiers in an 800-px SVG: grid 0.5, index grid 0.9, axis 1.2, series 1.6, route 2.2. `#nb-wobble` / `#nb-grain` filters only on dense legacy art, never on text, photos, rasters or animated groups.

## Theme notes

- Page roots use `GB_THEME`. Inside it `--color-white` is ink and `--color-black` is paper, and `var(--rigi-paper)` / `var(--rigi-ink)` are swapped; the landing and library keep `SITE_THEME`. Live plates set `data-theme="dark"` on their frame only.
- Canvas and SVG attributes that cannot read CSS vars use `SWISS.*` from `swiss/inks.ts` (no CSS import, so node checks can load it). `var(--accent)` is the concept's group colour.
- Sheet links use `viewTransition={sheetTransition()}`.
- `gipfelbuch.check.ts` lints the pages; exempt one line with `// gb-lint-allow` (the rule list is in `reports/gipfelbuch.md`).

## Guidelines

- Be accurate to the code: read `node.modules` and say what they do. Numbers come from the measured data, the bakes or `reports/`, never invented.
- One strong visual that explains the mechanism beats three weak ones. Motion only for a change of state, a cause or an uncertainty.
- No wheel or scroll hijacking, no external fetches, no new npm dependencies; images and data only from `public/demo`.
- Pages work at 390 px: `viewBox` SVGs with `w-full h-auto`, flex-wrap, no fixed widths.
- Shared helpers go in `viz/`; a page stays self-contained in its file.
