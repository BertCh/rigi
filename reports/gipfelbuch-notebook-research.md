<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Gipfelbuch as a field notebook: design research

*2026-10-01. Web and desk research, no code changed. Other `reports/*.md` carry no header comment, so the three lines above follow the task brief. Only the licence facts (section 5) were checked against live pages in this pass; the precedent descriptions are from established knowledge and the links are the canonical project pages. Companion to [gipfelbuch-swiss-aesthetic.md](gipfelbuch-swiss-aesthetic.md), which covers the map-sheet side.*

**Problem.** The index "core map" (about 19 concepts, three lanes, node-link) reads as a network visualisation. The ask is a notebook: sketchy, handmade, still driven by real numbers and real crops from the 12 demo photos.

## 1. Precedents and what defines each

| Precedent | Defining visual moves | Take for Rigi |
|---|---|---|
| Naturalist and geologist field notebooks (Darwin, Humboldt, Heim's field books) | Dated entries, sketch plus a measured number beside it, arrows from a label to the thing, cross-sections with hatching, corrections written over in place | Entry = date or number, sketch, figure, correction |
| Swiss survey and topographer sheets (Dufour, Siegfried, triangulation sketches) | Fine ink hachures, station triangles, sight lines radiating from a station with bearings written along them | Sight lines from the camera to named peaks, bearings as text |
| [Imfeld](https://en.wikipedia.org/wiki/Xaver_Imfeld) and [Heim](https://en.wikipedia.org/wiki/Albert_Heim) panoramas | Long horizontal strip, ridgeline in outline, peaks labelled with a leader line and name plus altitude, a compass scale along the top | The skyline-on-horizon overlay should be a strip with leader-line labels |
| Engineering lab notebooks | Numbered pages, ruled or grid paper, "witnessed" sign-off, tabulated readings, struck-through errors (one line, still legible) | Numbered pages, "tried / failed" struck out, readings table |
| [Leonardo's notebooks](https://en.wikipedia.org/wiki/Codex_Leonardo_da_Vinci) | Text and drawing share one page, small studies repeated, mirror hand, diagrams annotated in margins | Several small studies on one page, not one big figure |
| [Bret Victor](https://worrydream.com/) | Drawing is the explanation, live values beside the picture, one picture that changes | Number next to the diagram, updated by the drawing |
| [Nicky Case](https://ncase.me/) | Chunky friendly hand-drawn shapes, a character voice, interaction to poke | Voice in the annotations, not the body |
| [Maggie Appleton](https://maggieappleton.com/) | Illustrated notes, warm paper tones, labelled sketches, margin gloss | Margin gloss pattern, restrained palette |
| [Distill](https://distill.pub/) | Wide margin column for side notes and small figures, clean sans body | Layout skeleton: body column plus margin column |
| [Observable notebooks](https://observablehq.com/) | Cells in sequence, each with a result below, reactive values | "Cell" = entry with live number |
| [Excalidraw](https://excalidraw.com/) and [tldraw](https://tldraw.com/) | Rough strokes at a fixed seed, hand font, flat fills with hachure | The target look for shapes |
| [xkcd](https://xkcd.com/) style: [rough.js](https://roughjs.com/), [roughViz](https://github.com/jwilber/roughViz), [chart.xkcd](https://github.com/timqian/chart.xkcd) | Wobbled axes, hachure bars, handwritten ticks, data stays exact | Charts: honest values, sketchy skin |

## 2. Visual vocabulary for dark and light grounds

**Ground.** Define paper as tokens, not images. Light: warm off-white (#f4efe4 range) with a graph grid at about 8% ink. Dark: a blackboard or blueprint ground (deep blue-grey) with the grid at about 6% light, ink in chalk white. Options, one per page type: dot grid (CSS `radial-gradient`, cheapest), graph grid (two `linear-gradient`s), ruled lines plus a red margin rule (a single 1 px gradient stripe at 3.5 rem). Use CSS only; no texture bitmaps. A faint SVG `feTurbulence` grain at 3 to 4% opacity is optional and should be one fixed overlay, not per element.

**Fonts (Google Fonts, all OFL).** Recommend two, annotations only:
- **Caveat**: most legible of the script-like faces, variable weight, good at 18 to 24 px. Use for margin notes, arrow labels, circled-number captions.
- **Patrick Hand** (or **Kalam** as the second choice): more upright, closer to print, readable at 16 px. Use for short dimension and axis labels where Caveat's slant crowds.
Skip Homemade Apple, Covered By Your Grace, Gochi Hand, Nanum Pen and Shadows Into Light for anything functional: the first three trade legibility for charm, and Nanum Pen is too thin on dark. Body stays in the existing serif or sans. Rule: handwriting never exceeds about 12 words per note and never carries a number that is not also in the figure's accessible text. Fallbacks: `font-family: "Caveat", "Segoe Print", "Bradley Hand", cursive;` with `font-display: swap`, and self-host the woff2 (subset Latin) so the build does not depend on the Google CDN.

**Strokes.**
- *rough.js*: genuine hachure fills and the Excalidraw look, but random per call unless seeded, and each shape expands into several path segments.
- *Hand-rolled seeded jitter*: a function that takes points, resamples every 6 to 10 px, offsets each perpendicular by a seeded value (mulberry32 on a string hash of the element id), and emits one smooth `path` (Catmull-Rom or quadratic midpoints). About 60 lines, deterministic, SSR-safe.
- *SVG `feTurbulence` plus `feDisplacementMap`*: cheap one-line wobble on a whole group (scale 1.5 to 3). Downsides: it rasterises the group, softens thin lines, can shimmer on zoom and is costly on big areas. Use only on small static items such as circles and highlighter.
Recommendation: seeded jitter for all lines, arrows, circles and underlines; CSS or a small hachure helper for fills; a displacement filter only for the highlighter and tape.

**Pasted-evidence and marginalia pieces.**
- Polaroid or taped photo: white border (bottom heavier), 1 to 2 degree rotation seeded per photo, two translucent tape strips (semi-opaque rect, rotated), soft 2 px shadow. The photo crop is real and unfiltered.
- Circled numbers: jittered ellipse around a digit, with the same digit as the key into the caption.
- Underline and highlighter: underline as a jittered stroke under the text bounding box; highlighter as a wide, 35%-opacity, `mix-blend-mode: multiply` (light) or `screen` (dark) stroke.
- Sticky note: flat square, rotated, Caveat text, used for caveats only.
- Crossed-out wrong guesses: one or two strokes through the value, value still readable, correction beside it in a second ink colour. This is the best fit for the pipeline's real story (first guess, residual, snapped result), and the data comes from the actual runs.
- Dimension lines: tick-ended line with the measured number centred, used for focal length, eye height, and horizon residual in pixels.
- Hand-lettered labels: Caveat on a leader line, never rotated past 8 degrees.
Use two inks only: one neutral and one accent (the khipu accent already in `--rigi-*` tokens), plus a third reserved for corrections.

## 3. Staying data-driven and honest

- Geometry is exact; only the stroke is wobbled. Jitter amplitude is capped (about 1 to 1.5 px for 1 px stroke, never more than 2 px) and applied to rendering only. The true values go into text, so a reader can check them: "yaw 214.3, roll -0.6, f 27 mm, residual 1.8 px".
- Charts: draw axes and bars with jitter, but place bars at exact scaled positions and print the exact value beside each. State the scale. Never use hachure density or wobble to encode data.
- The skyline-on-horizon overlay must use the real extracted skyline and the real DEM horizon polylines at the true pixel positions. Hand-style only the leader lines and labels, not the curves' coordinates. If the curves are smoothed for looks, say so in the caption.
- Accessibility: jittered paths are decorative (`aria-hidden`), with one text alternative per entry that carries the numbers. Contrast: handwriting at least 4.5:1 at its size on both grounds, so no pale pencil grey on cream, and on dark use chalk white at 85% or more. Respect `prefers-reduced-motion`: no draw-on strokes, no rotation wobble animation; otherwise draw-on with `stroke-dashoffset` is fine for a single beat per entry. Do not overdo jitter: if any glyph or arrowhead shape becomes ambiguous, reduce amplitude. Font fallback must keep layout (set `size-adjust` or fixed line boxes so notes do not reflow).
- Performance: rough.js generates path data on each call, around 5 to 20 sub-paths per shape for hachure fills. For 19 concepts and 12 photos that is acceptable but needlessly heavy on mobile, and non-deterministic output causes SSR hydration mismatches unless seeded. A seeded path function costs microseconds, produces one path element per stroke, and can be precomputed at build time or memoised by id.

## 4. Layout: from node-link to notebook spread

1. **Numbered entries instead of nodes.** Convert the 19 concepts into about 8 to 10 entries (No. 1 camera, 2 skyline, 3 horizon, 4 match, 5 snap peaks, 6 eye height, 7 depth, 8 what failed). Three lanes become three "chapters" (tabs or ribbon bookmarks), not columns of boxes. Dependencies become margin notes: "needs No. 3" as a circled number with a short arrow, rather than a drawn edge.
2. **One worked example.** A left-to-right strip following one demo photo: crop (taped photo) to extracted skyline (ink overlay on the crop) to DEM horizon (profile drawn as a sketched strip) to the overlay, to snapped peaks with Imfeld-style labels, to the final numbers. Each step is a small panel with a number and one-line caption. This replaces the abstract network with the actual evidence and makes the real numbers the content. Provide a photo switcher (the 12 photos as tabs or thumbs) that rewrites every number.
3. **Margin column** (Distill pattern): wide screens place notes and links to concept pages in the right margin, small screens fold them inline under the entry as indented notes.
4. **"The two worlds meet" hero.** Photo skyline traced in warm ink over the DEM horizon in cool ink on the same strip, gaps shown as short vertical residual ticks with pixel values, peak flags lifted off the ridge by a leader line, a compass scale along the top (yaw), and a hand-written note at the largest residual. Offset the layers first (sketched, apart), then slide them together on scroll, which is the one animated beat.
5. **Wrong-guess page.** A struck-out initial pose beside the corrected one, with residual before and after.
6. **Index.** A table of contents as a hand-ruled list with page numbers and small thumbnail sketches, the notebook's own index, not a graph.

## 5. Licences and the dependency question

- **rough.js**: MIT, Copyright Preet Shihn ([roughjs.com](https://roughjs.com/), [github.com/rough-stuff/rough](https://github.com/rough-stuff/rough), [JSR listing](https://jsr.io/@rough/roughjs)). It can be added from a licence standpoint, but it needs approval as an npm dependency here and would be listed in `NOTICE.md`.
- **Fonts**: Caveat and the other Google handwriting faces are SIL Open Font License 1.1 ([Font Squirrel entry](https://www.fontsquirrel.com/fonts/caveat)). The OFL permits embedding, self-hosting and bundling; fonts cannot be sold on their own and derivatives keep the OFL and cannot use reserved names. Self-hosted woff2 files should ship with the OFL text and be listed in `NOTICE.md` and `reports/licences.md`. Verify the exact copyright line for each file from the font's repository before bundling.
- **Substitute**: a roughly 60-line seeded-jitter helper (`jitterPolyline`, `jitterEllipse`, `jitterArrow`, mulberry32) is a good substitute here. It covers everything above except hachure fills, which can be done with a 15-line parallel-line clip pattern (SVG `pattern` or `clipPath`) if wanted. Benefits: no new dependency or approval, deterministic SSR and snapshot tests (the repo has style baselines), smaller bundle, and full control of amplitude for the accuracy rule. Cost: you own the look; if Excalidraw-grade fills later become important, revisit rough.js with a fixed `seed`.

## Recommendations in brief

1. Redesign the index as numbered notebook entries (8 to 10), three lanes as chapters, edges as margin notes.
2. Make the centrepiece a worked example following one of the 12 photos, with a photo switcher.
3. Hero: hand-traced skyline over DEM horizon with residual ticks and a compass scale; slide-together on scroll is the only animated beat.
4. Paper is CSS tokens (dot or graph grid, margin rule) for light and dark; no texture bitmaps.
5. Caveat for annotations, Patrick Hand for small labels, existing body font for text; self-host woff2, OFL notices.
6. Write a seeded-jitter helper (about 60 lines); no rough.js dependency now.
7. Wobble the stroke only; coordinates are exact; print the real numbers in the annotations.
8. Real photo crops as taped polaroids, unfiltered, with seeded rotation.
9. Wrong guesses shown crossed out and corrected, from real run data.
10. Two inks plus a correction ink, from the khipu tokens; chalk-on-dark in dark mode.
11. Jitter at 1 to 1.5 px; decorative SVG is `aria-hidden`; one text alternative per entry.
12. `prefers-reduced-motion` disables draw-on and slide-together.
