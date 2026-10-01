# Rigi Atlas: authoring guide

The atlas lives at `/atlas` (graph index) and `/atlas/<id>` (one page per concept).
Data: `src/lib/atlas/graph.ts` (`ATLAS_NODES`), helpers: `src/lib/atlas/graph-utils.ts`.

## Adding a bespoke page

Create `src/lib/atlas/pages/<id>.tsx` (the id is the node's `id`). No registry to edit: pages are found with
`import.meta.glob` and lazy-loaded. Without a file the page shows a generated "constellation" fallback.

```tsx
import type { AtlasNode } from "#/lib/atlas/types";
import { Callout, CodeRef, DemoImage, Figure, Flow, Plot, Section, Stat, Steps, useTime } from "#/components/atlas/viz";

export default function Page({ node }: { node: AtlasNode }) {
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

## Theme

The page root sets `--accent` to the concept's group colour. Use `var(--accent)` for strokes and highlights,
`var(--rigi-paper)` (#ece6da) for text, `var(--rigi-ink)` (#0e1012) for the ground, `text-white/NN` for
secondary text. Headings use the serif via class `display-title`. Dark only; keep contrast high on `#0e1012`.
Group colours: `groupColor(node.group)` from `#/lib/atlas/graph-utils`.

## Primitives (`#/components/atlas/viz`)

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

## Real data (`scripts/atlas/build-data.ts` → `public/demo/atlas/`)

Pages are grounded in **measured** output of the real CPU pipeline run on the 12 bundled Niederhorn photos
(7 Sept 2026): detectSkyline → computeHorizon (Terrarium DEM) → solvePose (→ refinePose on reject) → viewPeaks /
layoutPeakLabels. Regenerate with `npx tsx scripts/atlas/build-data.ts` (~1 min, cached tiles).

| Export | Use |
| --- | --- |
| `useAtlasPhoto(id)` | `AtlasPhotoData \| null` for `demo-01`..`demo-12`: gps/eye, raw sensors, prior + solved camera (confidence, residual, inliers, coverage, ambiguity, Δyaw…), the live app's saved pose, skyline rows+weight, DEM rows at prior/solved, residual stats, horizon profile across the view (with ridge crests), peaks (visible / labelled / px at prior+solved), terrain profile along the view axis, DEM hillshade patch, sky-probability image, stage timings. All px are in the 800-px-wide working frame. |
| `useAtlasIndex()` | 12-photo summary (accepted, stage, Δ, residuals, labelled names, ms) + `groundTruthEval` rows from `out/eval*/report.json`. |
| `RealPhoto {data, layers, toggles?, crop?, labelInfo?, maxLabels?, children?}` | The real photo with measured overlays: `skyline` `weight` `prior` `solved` `peaks` `priorPeaks` `sky`. `crop=[x0,y0,x1,y1]` (working px) zooms; `children(d)` draws extra SVG in photo px. |
| `DemPatch {data, cone?, peaks?, children?}` | Hillshade ±20 km, north up, camera dot, prior (dashed magenta) / solved (cyan) view cones, labelled peaks; `children(d, toPx(az, distM))`. |
| `PhotoPicker {value, onChange, ids?, mark?}` | Thumbnail strip to switch the demo photo a figure shows. |
| `Measured {data}` | Provenance line for captions ("Measured on demo-03 (terrarium DEM) by scripts/atlas/build-data.ts, 2026-10-01."). |
| `LAYER_STYLE`, `rowsPath` | Shared colours (prior magenta dashed, solved cyan, detected yellow) and the row→path helper. |

Facts worth knowing (2026-10-01 run): 10/12 accepted (9 by solvePose, demo-12 only by refinePose); demo-07 and demo-11
rejected (a person's head/hair occludes the skyline in 11/12). Compass errors span −19°…+11.5° (demo-09/10 ≈ −19°).
Median skyline residual falls from 5–43 px (prior) to 0.9–7.7 px (solved). Horizon ≈ 3.5–5 s, skyline ≈ 0.1–0.3 s,
solve 0.02–1.3 s on CPU. People: only demo-01/02/03/06 are people-free full frame; for the others crop to the
skyline band (crop) unless the person is the point (occlusion in demo-11/12).

## Guidelines for page authors

- Be accurate to the code: read the modules in `node.modules` and state what they really do. Numbers must come
  from `reports/` or the measured atlas data, never invented.
- Ground every page in real images and data: lead with a `RealPhoto` / `DemPatch` / a plot of measured values
  for the concept, and caption it with `<Measured data={d} />`. Synthetic or schematic figures are fine for
  showing a mechanism in isolation, but say so in the caption and pair them with the real case.
- One strong custom visual beats three weak ones. Make it explain the mechanism, ideally with light motion
  (use `useTime`, never `setInterval`; respect reduced motion).
- No wheel or scroll hijacking, no external fetches, no new npm deps. Images and data only from `public/demo` (incl. `public/demo/atlas`).
- Pages must work at 390 px wide: use `viewBox` SVGs with `w-full h-auto`, flex-wrap, no fixed widths.
- Killed concepts: tell the story of why (what was measured), with the `negative` callout.
- Keep each page self-contained in its file; shared helpers go in `src/components/atlas/viz/`.

## Graph components

- `GraphView` is the full index graph (search, group/status filters, zoom buttons; zoom needs Ctrl/Cmd+wheel or pinch).
- `NeighbourhoodGraph {id, depth?}` is the compact ego graph used on concept pages.
- Layout is a hand-rolled force sim (`force.ts`), drawing and interaction are in `GraphCanvas.tsx`.

## Explainer pages (concise, visual-first) — `#/components/atlas/viz/explain`

Research behind this: `reports/explainer-research.md`. Exemplar: `src/lib/atlas/pages/skyline.tsx`.

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
| `Gallery {ids, tile(d), label?(d), cols?}` | Small multiples over demo photos (loads each `useAtlasPhoto`). |
| `Numbers {items:[{value,label}], source?}` | Headline numbers row + source line. |
| `Mark {x,y,n,k?}` + `MarkList {items}` | Numbered in-place annotations on a `RealPhoto` (inside `children`), with the notes below. |
| `Key {color, dashed?}` | Inline colour key for captions ("<Key color=… dashed>sensor guess</Key>"). |
| `Details {title?}` | Collapsed "Details for engineers". |
| `skylineBand(d, minH?)` | Crop to the skyline band (keeps people out, ridge large). |
