<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Gipfelbuch sketch rendering: engineering spec

Goal: every Gipfelbuch figure (inline SVG and a few `<canvas>`) looks hand-drawn, while measured data
(skylines, profiles, pins) stays within about 1.5 px of the true pixels. No new npm dependency.

Evidence status. rough.js numbers marked (fetched) were read from `rough-stuff/rough` `src/renderer.ts`
this session. Numbers marked (recalled) are from memory of rough.js, chart.xkcd, Wood et al. and
Boukhelifa et al.; they were not re-fetched and must be checked against the source before we cite
them in code comments. Nothing in this document has been benchmarked in this repo; all costs are
estimates to be confirmed by the check in section 4.

Existing code read: `src/components/gipfelbuch/notebook/sketch.ts` (mulberry32 `createRandom`,
FNV `hashSeed`, `sketchLine`, `sketchCurve`, `sketchCircle`, `sketchArrow`, `hachureLines`) and
`Ink.tsx` (`Stroke`, `PenLine`, `PenArrow`, `PenCircle`, `PenCross`, `PenDimension`, `HandText`,
`StepNumber`). Today only furniture wobbles; data lines are exact. `hachureLines` is a single fixed
45 degree comb with a crisp clip. `notebook.css` already disables `.nb-draw` under reduced motion.

## 1. How rough.js draws, and what to copy

Sources: rough-stuff/rough `src/renderer.ts`, `src/core.ts`, `src/fillers/*`
(https://github.com/rough-stuff/rough); the algorithm write-up by Preet Shihn is the author's own
"Rough.js" talk and README. MIT licence; copy with an attribution comment.

### 1.1 Core primitives (fetched unless noted)

- Seeded PRNG: `randomizer = new Random(seed || 0)`, one stream per shape; same seed gives the same
  drawing. Ours: `createRandom(hashSeed(id))` already equals this.
- Offset: `offset(min,max) = roughness * roughnessGain * (rand * (max - min) + min)`;
  `offsetOpt(x) = offset(-x, x)`.
- Line = two strokes (`doubleLine`). Each stroke is a cubic from a jittered start (a "move" op) to a
  jittered end. Defaults (recalled): `maxRandomnessOffset = 2`, `roughness = 1`, `bowing = 1`,
  `curveFitting = 0.95`, `curveTightness = 0`, `curveStepCount = 9`, `simplification = 1`,
  `hachureAngle = -41`, `hachureGap = 4 * strokeWidth`, `fillWeight = strokeWidth / 2`,
  `dashOffset = dashGap = zigzagOffset = hachureGap`.
- Per-line math (fetched): if `maxRandomnessOffset^2 * 100 > length^2` the offset shrinks to
  `length / 10`. `divergePoint = 0.2 + rand * 0.2`. Bow displacement perpendicular to the line:
  `midDispX = bowing * maxRandomnessOffset * (y2 - y1) / 200`, `midDispY = bowing * maxRandomnessOffset * (x1 - x2) / 200`,
  each then passed through `offsetOpt`. The cubic is
  `C (mid.x + midDispX + dx*divergePoint + off, ...)  (p1.x + midDispX + 2*dx*divergePoint + off, ...)  (p2 + off)`.
  The second stroke ("overlay") repeats with start/end offsets of `offset/2` (recalled) and a new random draw.
- Length gain (fetched): `gain = 1` below 200 px, `0.4` above 500 px, linear in between
  (`-0.0016668 * length + 1.233334`). Long strokes get proportionally less wobble.
- `preserveVertices` skips the endpoint offsets (we want this for data).
- Curves: Catmull-Rom to cubic with `s = 1 - curveTightness`, control points
  `p1 + (s*(p2 - p0))/6` and `p2 + (s*(p1 - p3))/6` (fetched). Each knot is first perturbed by
  `offsetOpt(1 + roughness*0.2)` or so (recalled); `curveFitting` (0.95) scales how far the curve may
  leave the true path. Ours already matches this in `sketchCurve`.
- Ellipse (fetched): `stepCount = ceil(max(curveStepCount, curveStepCount / sqrt(200) * sqrt(2*PI*sqrt((rx^2 + ry^2)/2))))`,
  radius jitter `rx += offsetOpt(rx * (1 - curveFitting))`, drawn about 1.0 to 1.2 turns twice with a
  random start angle and overshoot, so the loop never closes exactly. `sketchCircle` is already close.
- Rectangles/polygons: four/n `doubleLine`s, no closing curve; the start of each side is not the end
  of the previous one, which is what makes a box look ruled by hand.
- Fill styles (recalled; hachure confirmed as `polygonHachureLines` then `renderLines` via `doubleLine`):
  - hachure: parallel lines at `hachureAngle` (default -41 deg), spacing `hachureGap`, each a doubleLine.
  - zigzag: same lines, but consecutive lines are joined end to start into one zigzag; offset `zigzagOffset`.
  - cross-hatch: hachure, then hachure at `angle + 90`.
  - dots: along each hachure line, a dot every `gap`, jittered by `gap / 4`, radius `fillWeight`.
  - dashed: hachure lines cut into dashes `dashOffset` long with `dashGap` between.
  - zigzag-line: scribbled zigzag along each line, amplitude `zigzagOffset`.
  - solid: filled polygon. Never use for sketch fills.
- Hachure line generation (`polygonHachureLines`): rotate polygon by `-angle` about its first point;
  build an edge table sorted by y; sweep scanlines at `y += gap`; intersect, sort x, pair them
  (even-odd); rotate each pair back. We reproduce this exactly below.

### 1.2 Why we cannot copy rough.js numbers directly

Default `maxRandomnessOffset = 2` with two strokes puts pixels up to roughly 2 to 3 px from the true
line. Our budget is 1.5 px for data. So: (a) scale amplitudes so worst case deviation `<= tol`,
(b) pin vertices on data, (c) use spatially correlated noise for long series (per-segment random
offsets on a 2000 point series read as fuzz, not as pen movement; the NPR literature uses a low
frequency offset along the stroke: Kalnins et al. "WYSIWYG NPR" SIGGRAPH 2002 and Northrup and
Markosian 2000, recalled).

Related evidence (recalled, verify before citing): Wood et al. "Sketchy rendering for information
visualization" (IEEE VIS 2012, handy.js) shows sketchy charts stay readable; Boukhelifa et al. 2012
"Evaluating sketchiness as a visual variable for the depiction of qualitative uncertainty" found
people read sketchiness as uncertainty. Consequence for us: keep sketch amplitude uniform across a
figure so it carries style, not a data claim; uncertainty that we do mean (a wider pose error) must
be encoded by something else too (band width, label).

### 1.3 Proposed pure functions for `sketch.ts`

All take a `seed: number`, return SVG path `d` strings (or `Point[]` when marked), are deterministic,
and have no DOM access, so the same code also drives canvas via `Path2D(d)`.

Shared option type:

```ts
export interface SketchOptions {
  seed: number;
  tolerance?: number;      // max px distance from the true shape, default 1.2
  strokes?: 1 | 2;         // default 2
  roughness?: number;      // 0..2, default 1; scales amplitude inside tolerance
  bowing?: number;         // default 1
  preserveVertices?: boolean; // default true for data
}
```

Amplitude rule: `amp = tolerance * roughness / 2` (clamped so roughness 2 reaches tolerance). Second
stroke uses `amp * 0.7` and a new random draw. A cubic with end offsets `e` and control offsets `c`
deviates from the chord by at most about `max(e, 0.75*c)`, so set `e = amp * 0.5`, `c = amp * 1.2` for
`<= tolerance` at roughness 1 (check with the unit test below).

#### sketchPolyline (data series)

```ts
export function sketchPolyline(points: Point[], opts: SketchOptions & {
  maxKnots?: number;     // default 400 per stroke
  wavelength?: number;   // px of correlated noise, default 24
  simplifyTolerance?: number; // default 0.35 px
  closed?: boolean;
}): string;
```

Pseudocode:

```
pts = douglasPeucker(points, simplifyTolerance)          // keeps data within 0.35 px
pts = capKnots(pts, maxKnots)                             // see 4: min/max bucket per column
for stroke s in 0..strokes-1:
   rng = createRandom(seed + 977*s); amp_s = amp * (s ? 0.7 : 1)
   arc = cumulative length of pts
   noise = valueNoise1D(rng, arc/wavelength)              // smooth, in [-1, 1], cosine interpolated
   for each knot i (skip first/last when preserveVertices=false; always jitter ends by amp*0.4):
       n = unitNormal(pts, i)                              // average of adjacent segment normals
       d_i = amp_s * (0.75*noise(arc_i) + 0.25*(rng()*2-1))   // mostly smooth, a little tremor
       q_i = pts[i] + n * d_i                             // |d_i| <= amp_s <= tolerance
   split at corners (turn angle > 35 deg) so the spline does not round them
   emit Catmull-Rom as cubic C segments through q (tension 0 -> s = 1)
   for stroke 1 also: random start in [0, 0.04] of length trimmed/extended by 1..2 px (overshoot)
join strokes: "M... C... M... C..."
```

Because `d_i` is bounded and Catmull-Rom between nearby bounded points overshoots little (about 10%
at 400 knots over 600 px), final error is `<= 1.1 * tolerance`. Use 1.0 as the default tolerance for
data and 1.5 for furniture. The unit check must sample the produced path at 4x and assert the max
distance to the original polyline (see 4.3).

#### sketchRect / sketchPolygon

```ts
export function sketchRect(x, y, w, h, opts: SketchOptions): string;
export function sketchPolygon(points: Point[], opts: SketchOptions & { closed?: boolean }): string;
```

```
for each side (a -> b): d += sketchSegment(a, b, rng, amp)    // rough.js _line, below
sketchSegment:
   len = |b - a|; off = min(amp, len/10); gain = lengthGain(len)   // 1 / 0.4 as in rough.js
   bow = bowing * amp * perp(b - a) / len * rand(-1, 1) * gain
   diverge = 0.2 + rng()*0.2
   start = a + jitter(off*0.5); end = b + jitter(off*0.5)         // 0 if preserveVertices
   c1 = a + (b-a)*diverge       + bow + jitter(off*1.2)
   c2 = a + (b-a)*2*diverge     + bow + jitter(off*1.2)
   emit M start C c1 c2 end
second stroke: new draws, jitter halved, reversed direction half the time
```

Rects get an extra 1 to 2 px corner overshoot on one stroke so corners look hand-ruled.

#### hachureFill, crossHatch, stipple

```ts
export function hachureFill(polygon: Point[][], angleDeg: number, gap: number, opts: SketchOptions): string;
export function crossHatchFill(polygon: Point[][], gap: number, opts: SketchOptions & { angleDeg?: number }): string;
export function stippleFill(polygon: Point[][], gap: number, opts: SketchOptions & { radius?: number }): string;
export function flattenPath(d: string, tolerance?: number): Point[][];   // subpaths, used by all three and sketchify
```

Parameter values (copy rough.js: gap = 4 x stroke width, weight = half the stroke width):

| fill | angle | gap (px) | stroke width | notes |
|---|---|---|---|---|
| hachure (terrain, shade) | -41 deg (rough default), use -45 for slopes facing the sun | 5 to 7 | 0.8 to 1.0 | per line jitter of gap `+-12%` |
| cross-hatch (deep shade) | angle and angle + 90 (rough) or +70 (looks more drawn) | 6 to 8 | 0.7 | second set at 80% opacity |
| stipple | none | 4 to 6 | dot radius 0.6 to 0.9 | positions on hachure lines, jitter `gap/4` |
| zigzag (water, scree) | -41 | 5 | 0.9 | join line ends alternately |

```
hachureFill(polys, angle, gap):
   c = polygon[0][0]; rot(p, -angle about c)
   edges = all non-horizontal edges of all subpaths, with ymin, ymax, x@ymin, slope
   for y from ymin_all + gap/2 + rng()*gap*0.2 step gap*(1 + (rng()-0.5)*0.24):
       xs = sorted x of active edges at y (edges with ymin <= y < ymax)
       for each pair (xa, xb) in xs (even-odd):
           trim = (rng()-0.5)*2 (px)      // hand stops short or overshoots by 1 px
           segment = rot(({xa+trim_a, y}, {xb+trim_b, y}), +angle about c)
           emit segment with one thin wobble: sketchSegment(..., strokes=1, amp*0.5)
```

Rules: hatch ends are computed from the polygon (not by a crisp `clip-path`), so there is no
mechanical boundary; the outline is drawn separately as a sketched stroke over it. When the polygon
is an arbitrary SVG path (a mask, a terrain area), `flattenPath` first (tolerance 0.25 px). When the
caller wants the SVG `clipPath` route instead (cheaper for huge polygons), use `<clipPath>` with the
sketched outline and accept crisp hatch ends. Skip the clip entirely for photos.

Stipple: for each hachure line (gap `g`), `n = floor(len / g)`, dot `k` at
`t = (k + 0.5 + (rng()-0.5)*0.5)/n` plus normal offset `(rng()-0.5)*g/2`; emit as `M x y h 0.01` with
`stroke-linecap: round` and `stroke-width = 2 * r`, one path for all dots (one DOM node instead of
thousands of circles). A zero-length round-capped subpath renders as a dot in SVG and canvas.

#### sketchify(pathD)

```ts
export function sketchify(pathD: string, opts: SketchOptions & { fill?: false }): string;
export function parsePath(d: string): Segment[];   // exported for tests
```

Supports M m L l H h V v C c S s Q q T t A a Z z.

```
1. tokenise: regex /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:e[-+]?\d+)?)/g
   (arc flags can be glued: "a1 1 0 00.5.5"; parse flags as single chars 0|1)
2. to absolute; H/V -> L; S/T -> reflect previous control; Q -> C (elevate: c1 = p0 + 2/3(q - p0), c2 = p + 2/3(q - p))
3. A -> cubics (standard endpoint-to-centre conversion, split into arcs <= 90 deg)
4. flatten each subpath to a polyline, adaptive subdivision, tolerance 0.25 px; mark corners
   where the tangent turn exceeds 35 deg (L joins always corners)
5. per subpath: d += sketchPolyline(points, { ...opts, corners, closed: Z })
   closed subpath: second stroke starts at a different vertex and overshoots the closure by 2 to 4 px
6. return the joined string
```

Mechanical conversion of existing figures: find `<path d={...}>`, `<line>`, `<rect>`, `<circle>`
(convert to `d` first via `lineToPath`, `rectToPath`, `ellipseToPath`), wrap in `<Sketchy d=... seed=...>`.
Do not run sketchify at render for static `d` strings; memoise (section 4).

Unit checks to add (plain tsx script like the other `*.check.ts`): determinism (same seed, same string),
`maxDeviation(sketchPolyline(skyline)) <= 1.5` over 50 seeds on a real 2000 point skyline,
`sketchify` of M/L/H/V/C/Q/A/Z round-trips bounding box within 2 px, hachure segments lie inside the
polygon within 1.5 px, no NaN for degenerate input (zero-length, 1 point, repeated points).

## 2. SVG filter route

Sources: MDN `feTurbulence`, `feDisplacementMap`, `baseFrequency`, `numOctaves`; chart.xkcd uses an
`feTurbulence` + `feDisplacementMap` filter for its wobble (recalled: `baseFrequency 0.05`,
`scale 5`, `numOctaves` 1; check the repo `utils/index.js` before citing).

### 2.1 Pencil wobble on a group

```html
<filter id="nb-wobble" x="-2%" y="-2%" width="104%" height="104%"
        color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.4"
                     xChannelSelector="R" yChannelSelector="G"/>
</filter>
```

- Displacement = `scale * (channel - 0.5)`, so range is `+-scale/2` user units. Fractal noise
  channels cluster near 0.5 (std about 0.1 to 0.15), so real displacement is mostly under `scale/4`.
  `scale = 2.4` gives a hard max of +-1.2 and typical +-0.4. For a 1.5 px bound use `scale <= 3`.
- Units: `scale` is in user space (`primitiveUnits=userSpaceOnUse` default). If the SVG is scaled by a
  viewBox (a 800-wide viewBox shown at 400 px), divide by the scale factor, or pass
  `scale = targetPx / pxPerUnit`. Do not let the figure width change the px amplitude by accident.
- `baseFrequency` is cycles per user unit. 0.02 to 0.04 gives wavelengths of 25 to 50 px: slow pen
  drift. 0.06 to 0.1 gives hand tremor but starts to read as jaggedness at 1.5 px; stay under 0.08.
  `numOctaves` 2 (cost grows roughly linearly; above 3 not worth it).
- Use separate filters with different `seed` per figure so wobble does not repeat identically.
- Apply to the stroke layer only, in a `<g filter="url(#nb-wobble)">` that contains no text and no
  `<image>`. Hachure and furniture layers are good candidates.
- Accuracy: the filter moves data pixels by up to scale/2. With `scale = 2.4` it is within budget but
  it is not controllable per point, so for the measured skyline prefer the geometry route
  (`sketchPolyline`, bounded and testable) and use the filter only on decorative layers.

### 2.2 Grain and pencil texture on strokes

```html
<filter id="nb-grain" x="0" y="0" width="100%" height="100%">
  <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" result="g"/>
  <feColorMatrix in="g" type="matrix" result="mask"
     values="0 0 0 0 0   0 0 0 0 0   0 0 0 0 0   0 0 0 -2.2 1.7"/>   <!-- alpha = 1.7 - 2.2*noiseAlpha, grainy mask -->
  <feComposite in="SourceGraphic" in2="mask" operator="in"/>
</filter>
```

Tune the last matrix row: output alpha `A' = k*A + b`; `k = -2.2, b = 1.7` keeps about 80 to 90 percent
of the pixels with light dropouts. Use `baseFrequency 0.7 to 1.0` (about 1 px grain). Alternative that
keeps strokes opaque: `feComposite operator="arithmetic" k1=1 k2=0 k3=0 k4=0` multiplying source by
a mid-grey noise, giving 10 to 20 percent luminance variation.

### 2.3 Cost and pitfalls (estimates; not measured here)

- Filters rasterise their subtree (Skia, mostly CPU for `feTurbulence`) at device resolution
  including DPR. Cost is proportional to filter region area times octaves, and `feTurbulence` is the
  expensive part (per pixel Perlin evaluation). A 600 x 400 region at DPR 2 is 1.9 Mpx.
  Expect single digit ms for one figure on a laptop, more on phones. Ten large filtered figures
  repainting together will cause visible jank. Measure with Chrome DevTools Performance (Paint) and
  `performance.now()` around a forced repaint.
- Re-filtering on every frame: animating anything inside a filtered group (the existing `.nb-draw`
  `stroke-dashoffset` draw-on) re-runs the filter each frame. Either run the draw-on on an unfiltered
  copy and swap, or keep the filter on a wrapper that sits above a static layer. Do not animate
  `baseFrequency` or `seed` (a "boil" effect) except on one small element.
- Safari and filters inside `<foreignObject>`, CSS transforms and large regions have a history of bugs
  and blurriness; check on Safari before shipping. Firefox renders it correctly but slower.
- Set `filter` regions tight (the default -10 percent/120 percent region adds area); set
  `will-change` off; do not stack with CSS `filter`.
- Text: never filter text (displacement shears glyphs at 1 px scale and makes handwriting fonts
  unreadable). The `HandText` layer must sit outside any filtered `<g>`.
- Photos: never filter photos or `<image>`; displacement resamples with nearest neighbour and
  shows stair-steps, and it would also violate the "photo is evidence" rule.
- When acceptable: static, small to medium decorative groups (frames, hachure, arrows, background
  furniture), at most about 3 filtered regions visible at once, total filtered area under about
  1.5 Mpx at DPR 1. Otherwise use the geometry route.

## 3. Canvas route

Use the same pure functions (`Path2D` takes the `d` string; or return `Point[][]` strokes for direct
drawing). Seeds make redraws on resize identical.

```ts
function drawSketchStroke(ctx: CanvasRenderingContext2D, d: string, o: { color: string; width?: number; passes?: number }) {
  const path = new Path2D(d);                 // d from sketchPolyline, two strokes already inside
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.strokeStyle = o.color;
  ctx.globalAlpha = 0.85;  ctx.lineWidth = o.width ?? 1.3;  ctx.stroke(path);
  ctx.globalAlpha = 0.45;  ctx.lineWidth = (o.width ?? 1.3) * 0.7;  // optional pass with the same path
  ctx.stroke(path);
  ctx.restore();
}
```

- Two passes with different alpha and width mimic pencil pressure variation; `lineJoin = "round"`
  hides the facets of jittered polylines. Prefer `miter` never.
- DPR: size the backing store `cssSize * devicePixelRatio`, `ctx.scale(dpr, dpr)`, so amplitudes in CSS
  px stay constant.
- Hachure with clip: `ctx.save(); ctx.clip(new Path2D(outlineD)); ctx.stroke(new Path2D(hachureD)); ctx.restore();`
  Canvas clip edges are anti-aliased in Chrome and Firefox. Better: use `hachureFill` which already
  stops at the polygon with jitter, and skip clip, or clip with an outline inset by 0.5 px.
- Grain on canvas: draw strokes to an offscreen canvas, then `globalCompositeOperation = "destination-out"`
  with a pre-generated noise tile (256 x 256, built once from `createRandom`, alpha 0 to 0.25) via
  `createPattern`. One tile per page; far cheaper than a per-figure SVG filter.
- Text on canvas: draw with `fillText` after strokes, never through the grain pass.
- Redraw only on data or size change; do not use `requestAnimationFrame` loops for static figures.

## 4. Performance budgets

Page: about 10 figures, up to 2000 point series. Targets (estimates, to be validated by a check
script in `scripts/` or the notebook check): sketch generation under 25 ms total on load on a mid laptop, under
60 ms on a phone; no layout work during scroll; SVG DOM under 3000 nodes per page.

### 4.1 Cost model

- `sketchPolyline` on 400 knots, 2 strokes: about 0.1 to 0.3 ms (arithmetic only; string building
  dominates). On 2000 knots about 1 ms. So 10 figures x 3 series x 2000 points is about 30 ms
  uncapped: acceptable once, not on every render.
- Path string size: 12 bytes per knot with `toFixed(1)` and `C` triples about 40 bytes per knot. 2000
  knots x 2 strokes = 160 KB per series; 30 series = 4.8 MB of attribute text. Too much. Cap.
- Hachure fill: lines = height / gap (60 to 120 per polygon), negligible.
- Stipple: dots = area / gap^2; a 300 x 200 region at gap 5 gives 2400 dots; emit as one path.

### 4.2 Rules

1. Cap knots: before sketching, reduce to at most one knot per 1.5 css px of figure width:
   `maxKnots = ceil(width / 1.5)` (a 600 px figure gets 400). For skylines, reduce by column
   min/max bucketing then Douglas-Peucker at 0.35 px; that is lossless to the eye and keeps the
   measured pixel within 0.35 px, leaving about 1 px of budget for the wobble.
2. Cap the double stroke: second stroke uses every k-th knot (`k = ceil(n / 150)`), since it is
   deliberately loose. Beyond 800 raw points per series, draw stroke 2 only along 60 percent of the
   length (random span). This halves string size and looks more hand-drawn.
3. `useMemo`: all sketch strings keyed by `[id/seed, geometry identity, width, tolerance]`. Geometry
   from props/data must be referentially stable (module constants or useMemo upstream); do not
   recompute on hover, scroll, or reveal state. Static `d` strings in figures: compute at module
   scope (`const OUTLINE = sketchify(RAW, {seed: 1})`) so nothing runs in render.
4. Resize: recompute only when the quantised width (round to 32 px) changes; use `ResizeObserver`
   with a debounce; keep seeds so the drawing does not "change" on resize.
5. Offscreen: do not generate for figures not yet near the viewport (IntersectionObserver with
   `rootMargin: 600px`); the existing `nb-armed`/`nb-on` arming is the hook. Figures above the fold
   generate immediately.
6. Heavy cases (more than 3 series x 1000 points, or a hatched region with more than 20k px of
   outline) go to a canvas component, not an SVG with thousands of nodes.
7. Filters: at most 3 filtered regions visible; none on animated groups.
8. Precompute offline for baked scenes: demo figures with fixed data can store the sketched `d` in
   the baked JSON (see `scripts/meta/bake.ts`), shrinking runtime work to zero.

### 4.3 Accuracy check

`sketch.check.ts`: for each fixture (real 2000 point skyline from `public/demo/gipfelbuch`), 50 seeds,
sample the produced path (parse with the same `parsePath` plus flatten at 0.1 px) and compute the
max distance to the source polyline (point to segment); assert `<= 1.5` for tolerance 1.0 and fail
with the seed otherwise. Also assert string length `<= 60 * maxKnots` bytes per series.

## 5. Accessibility and reduced motion

- Sketch is style only. Each figure keeps one accessible name: `<svg role="img" aria-labelledby>`
  with `<title>` and `<desc>` carrying the finding (for example "Skyline match: median error 1.3 px"),
  and every sketched layer `aria-hidden="true"`. Do not put the same text in both a visible
  `HandText` and `<title>`. Provide the numbers as real HTML text or a `<table>` near each
  data figure, since sketched axes cannot be read precisely.
- Contrast (WCAG 1.4.11, non text 3:1): minimum stroke width 1.2 px for meaningful lines, 0.8 px only
  for hatch fill, and hatch must never be the only carrier of a category (add label or position).
  Pencil grain must not drop mean alpha below 0.8. Test stroke colours against `--nb-paper` in both themes.
- Do not encode data in sketchiness (uncertainty reading, section 1.2). Keep roughness constant
  per figure.
- Reduced motion: the draw-on already turns off in `notebook.css` under `prefers-reduced-motion: reduce`.
  Keep it. Never ship a "boil" (re-seeded redraw at 8 to 12 fps); if added later it must be opt-in and off under
  reduced motion and `webdriver`. Filter seeds and baseFrequency must be static.
- `forced-colors: active`: strokes use `var(--nb-ink)`; in forced colours map them to `CanvasText`
  and drop filters (`@media (forced-colors: active) { .nb-filtered { filter: none } }`).
- Print and screenshot baselines: same seed means pixel stable; filter output can differ across GPU
  and OS, so style baselines should not include filtered groups, or accept a tolerance.

## 6. Summary (20 lines) and recommended API

1. rough.js = seeded PRNG + double stroke: each line is two cubics with jittered ends, perpendicular bow,
   divergePoint 0.2 to 0.4, wobble scaled by length (gain 1 below 200 px, 0.4 above 500 px).
2. Defaults wobble +-2 px; we must scale amplitude to `tolerance` (1.0 data, 1.5 furniture), and pin vertices.
3. For data series use correlated 1D noise along arc length (wavelength about 24 px), not per-segment randoms.
4. Reduce data first: min/max column bucket plus Douglas-Peucker 0.35 px, at most width/1.5 knots.
5. Second stroke: lower amplitude (0.7), every k-th knot, partial span; new seed offset.
6. Fills: hachure (angle -41, gap 5 to 7, 0.8 to 1 px), cross-hatch (+90 or +70), stipple (gap 4 to 6, r 0.6 to 0.9, one path), zigzag.
7. Hatch ends computed from the flattened polygon with 1 px trim jitter, not a crisp clip-path.
8. `sketchify(d)`: tokenise M L H V C S Q T A Z, absolutise, flatten at 0.25 px, split at corners over 35 deg, sketch each subpath.
9. Filter route (decorative `<g>` only): feTurbulence fractalNoise 0.035, 2 octaves, feDisplacementMap scale 2.4 (+-1.2 px).
10. Grain: feTurbulence 0.9 to alpha matrix to feComposite `in`; or on canvas one 256 px noise tile with destination-out.
11. Never filter text or photos; never animate inside a filtered group; at most 3 filtered regions visible.
12. Canvas: Path2D from the same `d`, two passes (alpha .85 / .45, width x1 / x0.7), round joins, DPR scaling.
13. Budgets: under 25 ms generation per page, strings under 60 bytes per knot, under 3000 SVG nodes.
14. useMemo keyed by id + geometry + quantised width; module-scope constants for static paths; bake demo figures.
15. Lazy-generate figures far below the fold via IntersectionObserver (reuse nb-armed).
16. Accuracy test: 50 seeds on a real 2000 pt skyline, max deviation <= 1.5 px, deterministic strings.
17. Sketchiness reads as uncertainty (Boukhelifa 2012): keep it uniform, encode real uncertainty otherwise.
18. A11y: role img + title/desc, sketch layers aria-hidden, numbers as HTML text, stroke >= 1.2 px, hatch never sole encoding.
19. Reduced motion: keep `.nb-draw` off rule; no boil; static filter params; filters off in forced-colors.
20. Nothing here was benchmarked; costs are estimates until the section 4.3 check and a DevTools run.

Recommended `sketch.ts` additions (keep existing exports unchanged):

```ts
export interface SketchOptions { seed: number; tolerance?: number; strokes?: 1 | 2; roughness?: number; bowing?: number; preserveVertices?: boolean }
export function sketchPolyline(points: Point[], opts: SketchOptions & { maxKnots?: number; wavelength?: number; simplifyTolerance?: number; closed?: boolean; corners?: number[] }): string;
export function sketchSegment(from: Point, to: Point, opts: SketchOptions): string;       // rough.js _line
export function sketchRect(x: number, y: number, width: number, height: number, opts: SketchOptions): string;
export function sketchPolygon(points: Point[], opts: SketchOptions & { closed?: boolean }): string;
export function flattenPath(pathD: string, tolerance?: number): Point[][];
export function parsePath(pathD: string): PathSegment[];
export function sketchify(pathD: string, opts: SketchOptions): string;
export function hachureFill(polygons: Point[][], angleDeg: number, gap: number, opts: SketchOptions): string;
export function crossHatchFill(polygons: Point[][], gap: number, opts: SketchOptions & { angleDeg?: number }): string;
export function stippleFill(polygons: Point[][], gap: number, opts: SketchOptions & { radius?: number }): string;
export function simplifyPolyline(points: Point[], tolerance: number, maxKnots?: number): Point[];
export function maxDeviation(sketchD: string, reference: Point[]): number;              // test helper
```

Recommended `Ink.tsx` additions (props include `seed: string`, `color`, `width`, `delay` as today):

```tsx
export function PenPolyline(p: StrokeProps & { points: Point[]; tolerance?: number; maxKnots?: number }): JSX.Element;  // data series, memoised
export function PenRect(p: StrokeProps & { x: number; y: number; width: number; height: number }): JSX.Element;
export function PenPolygon(p: StrokeProps & { points: Point[]; closed?: boolean }): JSX.Element;
export function PenPath(p: StrokeProps & { d: string }): JSX.Element;                    // sketchify(d), memoised
export function Hachure(p: { seed: string; polygons: Point[][] | string /* path d */; angle?: number; gap?: number; color?: InkColor; width?: number; cross?: boolean; stipple?: boolean }): JSX.Element;
export function SketchFilterDefs(p: { id?: string; scale?: number; baseFrequency?: number }): JSX.Element;  // one per figure; wobble + grain
export function useSketch<T>(factory: () => T, deps: unknown[]): T;                      // useMemo plus width quantisation
```

Notes: every component calls its pure function inside `useMemo` keyed on the seed string and geometry;
`PenPolyline` and `Hachure` render a single `<path>` each; `HandText` stays unfiltered; the existing
`Stroke` gets an optional `grain` prop that applies `filter="url(#nb-grain)"` only when the figure
declared `SketchFilterDefs`.

## Sources

- rough-stuff/rough: `src/renderer.ts` (fetched), `src/core.ts`, `src/fillers/*` (partly fetched), https://github.com/rough-stuff/rough
- Excalidraw (roughness 0/1/2, seed per element, uses roughjs), https://github.com/excalidraw/excalidraw (recalled)
- roughViz (rough.js based charts), https://github.com/jwilber/roughViz (recalled)
- chart.xkcd (feTurbulence/feDisplacementMap wobble), https://github.com/timqian/chart.xkcd (recalled)
- Wood, Isenberg, Isenberg, Dykes, Boukhelifa, Slingsby, "Sketchy Rendering for Information Visualization", IEEE TVCG 2012 (recalled)
- Boukhelifa, Bezerianos, Isenberg, Fekete, "Evaluating Sketchiness as a Visual Variable for the Depiction of Qualitative Uncertainty", IEEE TVCG 2012 (recalled)
- Kalnins et al., "WYSIWYG NPR: Drawing Strokes Directly on 3D Models", SIGGRAPH 2002; Northrup and Markosian, "Artistic Silhouettes", NPAR 2000 (recalled)
- MDN: feTurbulence, feDisplacementMap, baseFrequency, numOctaves (search results, https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Attribute/baseFrequency)
