<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Gipfelbuch: drawing data in a Swiss topographer's sketch idiom

*2026-10-01. Design research, no code changed. Extends [gipfelbuch-swiss-aesthetic.md](gipfelbuch-swiss-aesthetic.md) (inks, furniture) and [gipfelbuch-notebook-research.md](gipfelbuch-notebook-research.md) (seeded jitter, paper, honesty). Not repeated here: tokens, fonts, polaroids, rough.js vs hand-rolled jitter.*

**Verification note.** Web searches confirmed the broad claims (Imhof's relief system of shaded relief, rock drawing, contours and spot heights; Swiss rock hachures and scree dots whose size and density follow illumination; Imfeld as engineer-topographer and panorama draughtsman). The PDFs with line-weight detail (Jenny et al.) could not be text-extracted. Stroke widths below are therefore design numbers for an 800 px SVG derived from the practice, not measurements from swisstopo specifications.

## 1. What the tradition teaches

**Imhof** ([Cartographic Relief Presentation](https://www.perlego.com/de/book/1138803/cartographic-relief-presentation-pdf); [Jenny's review](https://mail.colororacle.org/berniejenny/pdf/2008_Jenny_ImhofBookReview.pdf)). Four rules carry over.
- *Hierarchy by layers.* Draw in print order: pale ground tint, then hatch or relief, then contours, then lettering on top. Each layer is legible alone.
- *Tonal economy.* Few inks, many values. Use light tints for large areas and keep full ink for small things.
- *Harmony.* Large areas are pale and desaturated; small areas may be strong. Never a saturated fill over a large region.
- *Generalise, then exaggerate what matters.* Ridges and gullies are simplified and the essential ones emphasised. A chart omits ticks and series that are not the point.

**Dufour, Siegfried, Landeskarte.** Dufour (1840s onward) shows relief by dense engraved hachures, with lines running down the slope, thicker where steeper. Siegfried (from 1870) switched to contours and kept hachure-like rock drawing. The Landeskarte (from 1935) uses brown contours, black rock hachures with a light source from the northwest, and scree as dots whose size and density follow illumination (see the [Jenny scree paper](https://mail.colororacle.org/berniejenny/pdf/2010_Jenny_etal_Scree.pdf)). Hand marks, even when engraved, are regular in intent and imperfect in execution. That gives us the rule: the intent is orderly, the wobble is the pen's.

**Contours.** Intermediate line thin, index (every fifth) about twice as heavy and the only one labelled, labels broken into the line and read uphill. Water is blue italic, peaks upright navy or black, spaced capitals for ranges.

**Heim and Imfeld panoramas** ([Imfeld](https://en.wikipedia.org/wiki/Xaver_Imfeld), [Heim](https://en.wikipedia.org/wiki/Albert_Heim)). A pen-and-wash ridgeline, hatching only on the shaded faces, and peaks lettered above the skyline with a hairline leader, name plus altitude. The leader never crosses another leader.

**Feldbuch triangulation sketches.** Pencil, one station triangle per observed point, rays from the station labelled in the margin along the ray with the measured angle, a north arrow, tiny circles for sighted targets, corrections struck out once and rewritten. Numbers sit on the geometry, not in a table.

## 2. Chart grammar

All sizes for an 800 px wide SVG; scale proportionally (`stroke * width/800`, minimum 0.5 px). Inks are existing `--gb-*` tokens.

### Stroke hierarchy

| Role | Width | Ink | Opacity | Notes |
|---|---|---|---|---|
| Gridline, intermediate | 0.5 | `--gb-relief` | 0.35 | pencil, ruled straight, almost no jitter |
| Gridline, index (every 5th) | 0.9 | `--gb-contour` | 0.5 | only this one gets a tick label |
| Axis (the one baseline) | 1.2 | `--gb-ink` | 0.85 | pen, 0.6 px jitter, ticks 4 px, outward |
| Series line | 1.6 | `--gb-ink` or role ink | 0.9 | the data stroke; second series 1.2 |
| Leader / callout line | 0.6 | `--gb-ink` | 0.7 | hairline, ends in a 1.5 px hand dot |
| Hachure strokes | 0.6 to 0.9 | role ink | 0.55 to 0.8 | see fills |
| Emphasis (route) | 2.2 | `--gb-red` | 0.9 | the only heavy line on the page |
| Highlight halo | 8 to 10 | `--gb-sign-light` | 0.35 | multiply, behind text or line, not an outline |

Rules: at most four widths per figure; ratio between adjacent tiers at least 1.5, or the difference reads as a mistake. Opacity below 0.3 is reserved for paper-ruling and nothing the reader must read.

### Elements

- **Axes.** One baseline and one left rule only, no top or right frame. Ticks are short strokes with slightly uneven lengths (jitter 0.5 px). The axis may stop short of the plot edge by 6 px, as a pen lifts. Axis label in Fira Sans Condensed italic, 11 px, with unit; numerals in Plex Mono 10 px, tabular. Water-like quantities (flow, probability mass, "air") may use italic blue; peaks and angles upright navy.
- **Gridlines.** Pencil, faint, only on the axis that needs reading, and drawn behind with a gap where data labels sit. No grid on both axes. Never dashed (dashes read as digital); use a dotted run of 0.8 px dots at 5 px spacing if a dotted line is wanted for "assumed" or "predicted".
- **Bars.** Do not fill flat. Fill with parallel hachure at 45 degrees, spacing 3.5 px (denser = darker, but never encode data with density), 0.7 px strokes in the role ink, all one angle across a figure (single light source, northwest, like the Landeskarte). The bar outline is two pen strokes on the lit left and top edges only, none on the shaded sides, or no outline at all. Exact top at the true value; print the value above in Plex Mono.
- **Area fills.** Same hachure, and for stochastic or uncertain masses (point clouds, error regions, scree-like quantities) use stipple: dots 0.8 to 1.6 px, density falling to the edge. Edges are a single 1.2 px line that fades out, not a closed outline. No gradient fills.
- **Line series.** One continuous stroke, rendered from true points (the jitter helper offsets perpendicular, amplitude 0.6 px, wavelength 8 to 10 px, seeded). Smooth with Catmull-Rom only if the caption says so. Direct label at the line end in italic, not a legend.
- **Scatter points.** Small hand dots: 2 to 2.5 px radius, slightly irregular (r varies plus or minus 0.3), 0.85 opacity so overlaps darken as pencil does. Observations that are stations (camera, viewpoint, survey point) are a 5 px open triangle, 1 px stroke, with a centre dot. Rejected points get a single short cross (3 px), not a bigger dot. Never use circles with outlines for ordinary data.
- **Legends.** Avoid. Direct labels beside the series with a hairline leader. If needed, a Zeichenerklärung of at most four rows: the real mark drawn at real size, then a text of 11 px, no box, ruled by a single pencil line above.
- **Callouts.** Caveat or Patrick Hand 16 px (existing fonts), at most 12 words, hairline leader with a dot on the data end, no bubble. Place text in empty paper; leader at most 40 px. Callout text colour `--gb-ink`, with the number in `--gb-red` only when it is the finding.
- **Highlights.** Emphasis is route ink: the key series or segment goes in `--gb-red` at 2.2 px, everything else stays ink or pencil. A second highlight type, the sign-yellow marker band, is for text only. Only one red thing per figure unless comparing two states (then red for the answer, `--gb-relief` struck-through for the discarded guess).
- **Panels and boxes.** Default is no box: separate by 24 px of paper and a small caps kicker. When a region must be bounded, use four pen-ruled corner ticks (8 px legs, 1 px, 0.7 opacity) as map neatline marks, or a hachure rule (HachureRule) above. Never draw a closed rectangle with a stroke; figure wells use `--gb-paper-deep` fill with no stroke.
- **Arrows.** One 1.2 px jittered stroke with an open two-line head (6 px legs, 25 degrees), never a filled triangle. Curved by a single quadratic bow of 5 to 10 per cent of length. Used for causation or movement only; dependencies stay margin notes as in the notebook research.
- **Numbered markers.** Digit in Plex Mono 11 px in a hand-drawn circle (r 8, 1 px, jitter 0.6, not closed at the seam: gap of 10 degrees overlap). The same circle style in red only for the current step. The key to the caption uses the same digit.
- **Measured angles and distances.** Taken from the Feldbuch: write the value along the ray, text rotated to the ray (cap 25 degrees from horizontal, flip so it reads upward), 10 px Plex Mono italic, with a 1.5 px gap in the ray under the text. Station = open triangle; target = 3 px ring; North arrow at most once per sheet.

### Hachure and stipple recipe

- Angle 45 degrees (light from NW), spacing 3 to 4.5 px, line width 0.6 to 0.9, slight length jitter at the ends (plus or minus 1 px), spacing jitter 10 per cent, clipped to the exact shape. Shaded side of a form: spacing 3 px; lit side: 5 px; this mimics rock drawing and gives volume, but the same fill is used for the same quantity across figures.
- Cross-hatch (second angle at 135 degrees) only once per figure, for the single darkest element.
- Stipple count follows area, not data. A single seeded generator per element id keeps SSR output stable.

### Ink roles

| Ink | Role in a chart |
|---|---|
| `--gb-ink` | axis, series, text, leader lines, rock-drawing hatch |
| `--gb-relief` | pencil: grid, rejected or prior state, uncertainty stipple |
| `--gb-contour` | index lines, terrain, elevation axes, "model" quantities |
| `--gb-water` | italic labels, DEM, measured-from-image quantities, water-like fields |
| `--gb-forest` | success or result states, fits |
| `--gb-navy` | peak names, angles, bearings |
| `--gb-red` | the one route: the answer, the current step, the residual |
| `--gb-sign-light` | highlighter behind text only |

Two photo and DEM world colours: image-derived quantities in water, DEM-derived in contour brown. That mapping holds on every page.

## 3. Where to stop

1. **Jitter budget.** Lines 0.4 to 0.8 px amplitude at 1.2 px width; never more than 1 px; never on text, hachure spacing beyond 10 per cent, or marker alignment. Data position is exact; only the pen moves.
2. **One seed per figure.** Seeds from element ids; no animation of the wobble; no shimmer on resize.
3. **Textures never touch photos.** Photographs, crops and DEM rasters get no hachure, no filter, no displacement. Overlays on a photo are plain 1.5 to 2 px strokes with a paper-coloured 3 px halo for legibility, and no hatch fills.
4. **Legibility floors.** Text 4.5:1 on paper, at least 10 px in the SVG at 800 px, hachure never under body text (clear a margin of 4 px around labels or knock out with paper colour). Strokes under 0.5 px are never used.
5. **One hand.** Handwriting font for notes only. Axes, ticks and values stay in Plex Mono and Fira so numbers can be read exactly.
6. **Ornament budget.** One piece of map furniture per figure (scale bar or north arrow or neatline corners). Stipple or hatch covers less than 25 per cent of the figure area.
7. **No outline-and-fill pairs.** A shape is either filled (hachure or stipple, no outline) or lined (pen stroke, no fill). If both, the line is only on the lit edges.
8. **Reduced motion and print.** Drawing-on is optional; the static state is the design. Everything survives greyscale: redundant encoding by position and label, never by ink colour alone.

## Sources

- Imhof, *Cartographic Relief Presentation*: [Perlego entry](https://www.perlego.com/de/book/1138803/cartographic-relief-presentation-pdf), [Jenny's review](https://mail.colororacle.org/berniejenny/pdf/2008_Jenny_ImhofBookReview.pdf), [Cartographic Perspectives](https://cartographicperspectives.org/index.php/journal/article/download/cp65-youngblood/pdf/976)
- Swiss rock drawing and scree: [Jenny et al. 2014](https://mail.colororacle.org/berniejenny/pdf/2014_Jenny_etal_DesignPrinciplesForSwiss-styleRockDrawing.pdf) (text not extractable), [Jenny et al. 2010](https://mail.colororacle.org/berniejenny/pdf/2010_Jenny_etal_Scree.pdf), [Hurni and Dahinden, ICC 2007](https://icaci.org/files/documents/ICC_proceedings/ICC2007/abstracts/html/20_Oral2_2.htm)
- Imfeld: [HLS](https://hls-dhs-dss.ch/de/articles/031187/), [Geographicus](https://www.geographicus.com/P/RareMaps/imfeldxaver)
- Feldbuch conventions and contour weights are from established practice, not a fetched page; treat the numbers as design choices to tune on screen.
