# Gipfelbuch: a Swiss map-sheet aesthetic

**Revision, 2026-10-01 (later):** the user found the sheet "a bit clumsy" and asked for something softer, with no paper texture and no full notebook look. The paper is now W 96% + YY 4% (warm white, not cream), panels are paper 91% + LG 9%, the grain tile is gone, and `SheetFrame` has no graticule ticks. The rules are in the Gipfelbuch README ("Soft sheet"). Where this document says otherwise below, the revision wins.

Status: landed in the working tree on 2026-10-01, uncommitted (session mt-image-2f). The notebook skin from mt-image-c2 sits on top of it. Following the user's minimal-strokes feedback, the frames are typographic: ticks, coordinates and the Blatt number, with no boxes. Research brief: Swiss cartography traditions (Dufour, Siegfried, Landeskarte, Imhof, Heim/Imfeld panoramas, SAC waymarks, the summit register book itself).

## Goal

Give /gipfelbuch a distinct veneer that reads as a Swiss topographic sheet and a summit register: printed on paper, inked in the Landeskarte separations, framed with map furniture, and grounded in the real Niederhorn / Thunersee data the pages already use. Content, page structure and props stay as they are.

## Principles

1. **Paper, not screen.** Gipfelbuch flips to a light, warm map-paper ground. The landing page, library and workspace keep the dark Rigi theme.
2. **Three inks plus paper.** Following the Siegfried rule, the base palette is black (rock drawing and text), brown (contours) and blue (water), plus red for the route and the Swiss cross. Every ink is a Brezine chart swatch, per the brand rule. The paper tint is a mix of chart swatches (W warmed with YY).
3. **Map furniture as structure.** Sheet frame with graticule ticks, LV95 corner coordinates, sheet number (Blatt), scale bar, legend (Zeichenerklärung), imprint line. These are decoration, and none of them carries content the reader needs.
4. **Real data, not stock texture.** Contours and relief come from the Niederhorn DEM (Mapterhorn) and the swisstopo relief shading (OGD, attributed).
5. **Cheap and reversible.** The theme is a scoped class, `.gb-swiss`, that remaps tokens. Most of the roughly 600 Tailwind `white/NN` uses re-ink with no edit (Tailwind v4 compiles `text-white/70` to `color-mix(in oklab, var(--color-white) 70%, transparent)`; verified).

## Tokens (scoped to `.gb-swiss`)

| Token | Value | Chart code | Role |
| --- | --- | --- | --- |
| `--gb-paper` | mix W 90% + YY 10% | W, YY | page ground (warm cream) |
| `--gb-paper-deep` | mix paper 80% + LG 20% | W, YY, LG | panels, figure wells |
| `--gb-ink` | #131313 | LK | text, rock drawing |
| `--gb-contour` | #95500c | NB | contour brown, rules |
| `--gb-water` | #30626b | GL | water ink, links |
| `--gb-forest` | #575e4e | GG | forest, "result" |
| `--gb-relief` | #919192 | BL | relief shading, hairlines |
| `--gb-red` | #bf2233 | SR | route red, Swiss cross, primary accent |
| `--gb-sign` | #ffdb8b / #e59e1f | YY / SY | Wegweiser yellow |
| `--gb-navy` | #002f55 | PB | peak lettering |

Remaps inside the scope: `--color-white → --gb-ink`, `--color-black → --gb-paper`, `--rigi-ink ↔ --rigi-paper`, callout tones darkened for paper (lesson NB, trap RM, result GG, negative MG).

## Type

- Titles: Fraunces (kept), engraved-cartouche feel.
- Body and labels: Fira Sans plus Fira Sans Condensed, standing in for swisstopo's Frutiger. Use italic for water and hydrological names, and spaced condensed caps for regions and kickers.
- Coordinates and figures: IBM Plex Mono with tabular numerals.

## Components (`src/components/gipfelbuch/swiss/`)

- `SheetFrame`: a page-level neatline with graticule ticks, LV95 corners, the sheet block "Blatt NN / 19" and an imprint line.
- `ContourField`: real Niederhorn contours (baked by `scripts/gipfelbuch/data-sheet.ts`) as a header background.
- `SheetMap`: the index hero. It shows relief, contours, Thunersee and the 12 demo viewpoints, with peaks lettered in the Imhof style.
- `Waymark`: status chips styled as SAC blazes (yellow, white-red-white, white-blue-white).
- `Signpost`: prev/next links styled as yellow Wegweiser signs.
- `Legend`: a Zeichenerklärung footer.
- `ScaleBar`, `HachureRule` (section divider) and `Cartouche` (title block).
- `palette.ts`: the map palette, plus group colours re-tuned for paper. Group colours stay as 6-digit hex.

## Waves

1. **Foundation**, run in parallel:
   - A: theme CSS, palette and group colours, and the GraphCanvas palette.
   - B: furniture components.
   - C: baked sheet data and the `SheetMap` and `ContourField` components.
2. **Integration:**
   - Apply the components to ConceptPage, CoreMap and the viz kit (explain, real, math, Figure, Callout, Section, Steps, Plot), OntologyPanel and GraphView.
   - Once mt-image-74's page rewrites have landed, do the index route and a mechanical page codemod of literal `#ece6da`, `#0e1012` and the `rgba` equivalents to tokens. Photo overlays keep their `LAYER_STYLE`.
3. **Review:** screenshots under the render lock, fixes, Biome, tsc, the fast tier, SPDX, docs.

## Ownership

Pages (`src/lib/gipfelbuch/pages/*.tsx`) and `src/routes/gipfelbuch.index.tsx` belong to mt-image-74 until their rewrite lands. The kit edits keep every export and prop stable.
