# Gipfelbuch sketch style: research for an aggressive hand-made restyle

*2026-10-01. Desk and web research, no code changed. Builds on `reports/gipfelbuch-notebook-research.md`, `reports/gipfelbuch-swiss-sketch-research.md`, `reports/gipfelbuch-sketch-rendering.md`, `reports/gipfelbuch-design-book.md` (canon, section 22) and the toolkit in `src/components/gipfelbuch/notebook/`. Marks: **[V]** checked on a fetched page this session, **[R]** recalled or established practice, not re-fetched. All filter costs and font sizes are design numbers, not measured in this repo.*

**One-line diagnosis.** The toolkit already draws like a hand (seeded two-pass strokes, hachure, stipple, scree, tapered outlines, wobble and grain filters). The *canon* is what turned it off. Rules 11, 52–54 and the README's "never hand for body paragraphs or subtitles", "at most three 12-word notes", "rotation ≤ 2°" and "print is the form" make every page a typeset map sheet with a few pencil notes on it. Only 11 of 19 bespoke pages use `HandText` at all. To get "informal, hand written, all visuals are sketches" back, invert the hierarchy: **the hand is the form; print is the measurement.** Numbers, tables, code and the photo stay exact and in print. Everything else is lettered, sketched or washed.

---

## 1. Already covered and gaps

| Topic | Covered where | Status |
|---|---|---|
| Seeded jitter, two-pass strokes, accuracy budget (≤ 0.9–1.5 px), `sketchify(d)` | sketch-rendering §1, `sketchify.ts`, `notebook.check.ts` | Done, keep |
| Hachure, cross-hatch, stipple, scree; NW light; LK ratios | swiss-sketch §2, canon 30, 42–43 | Done, keep |
| Wobble filter (0.035 / 2 oct / scale 2.4) and graphite grain filter | sketch-rendering §2, `SketchDefs` | Done; only used on "legacy" art |
| Tapered pen outline, ink blobs | `sketch.ts` `taperedOutline`, `inkBlob` | Exists, barely used |
| Precedents list (Darwin, Heim, Imfeld, Leonardo, Excalidraw, xkcd) | notebook-research §1 | Names only, no page grammar |
| Fonts: Caveat for notes, Shantell for labels, D2 open | notebook-research §2, design book H5 | Undecided; no body hand; no headline lettering face |
| Paper, grain, tape, polaroid tilt, red margin rule | notebook-research §2 | Built, then removed at user request (soft sheet) |
| Sketchiness vs trust (Wood 2012, Boukhelifa 2012) | design book §6 | Done: wobble is furniture, certainty is line style |

**Gaps this report fills.**
1. What real summit registers, field books and journals *look like* as pages (entry anatomy, lettering hierarchy, how pencil and ink layer), not just "dated entries".
2. A page grammar: titles, boxed vs unboxed notes, leaders, underlines, circled numbers, crossings-out, inset "zoom" sketches, Fig. call-outs.
3. Colour wash (watercolour/marker) as a layer: none of the earlier reports has a wash recipe.
4. Pencil construction layer as a *visible* layer (not just a grain filter).
5. A hand font *system* (headline lettering, note cursive, block caps), including body-hand options with built-in glyph shufflers (Playpen Sans, Shantell `rlig`).
6. How to draw mountains like a sketcher in SVG from real DEM data.
7. HTML-level hand treatments (headings, lists, tables, callouts, tabs, buttons) without bitmaps or props.
8. A verdict per prop, and a ranked move list.

---

## 2. Artefacts and what to steal

| Artefact | What the page actually looks like | Steal for Rigi |
|---|---|---|
| **Gipfelbuch (summit register)** | Documented from the 1850s; summit bottles with visiting cards from 1786. Early entries were documentary: date plus name or signature, later route, arrival and departure times, weather and view; rhymes and sayings came after WWII [V, bergwelten/DAV]. Guidance today: date and time, name, planned route; drawings and decoration discouraged [V]. In practice: many hands on one page, each entry a short block ruled off from the next, the section or hut stamp, names often in block capitals, times in 24 h, "Nebel", "klar", "Sturm" [R]. | **Each sheet opens as a register entry**: one hand-lettered line `1.10.2026 · 14:20 · Niederhorn 1949 m · klar, Föhn · R. C.` plus "Route:" (the pipeline step). Entries are separated by a hand rule, not a box. Multiple voices = multiple runs/photos, each a short entry. One stamp only where it carries a fact (sheet number / status), drawn as a ring with lettering, never a raster. |
| **Hüttenbuch / SAC hut book** | Wider entries, party lists, conditions reports, the hut stamp [R]. | "Conditions" box per page: one line of state (works / partial / killed) in the voice of a conditions report. |
| **Albert Heim** (geologist, draughtsman) | ETH holds his student watercolours and sketches, profiles and panoramas later used as publication illustrations, and sketches from field books [V, HLS / ETH 1988 exhibition]. His sections: one clean outline, hatching by rock type, numbered strata with a key, notes lettered along the section [R]. | Profiles and cross-sections as the default chart form for any 1-D quantity (horizon, residual along yaw). Number the layers, key in the margin. |
| **Xaver Imfeld** | Engineer-topographer, Heim's pupil, 40+ panoramas, 13 reliefs [V, HLS]; Rigi-Kulm panorama: contours engraved by Imfeld from photography [V, swisscollections]. Panorama grammar: ridge outline, peaks named above with hairline leaders and altitudes, compass ticks along the top [R]. | The panorama strip with leader ticks is *the* Gipfelbuch figure. Already in Tafel; make it lettered by hand (names in block caps, altitude in print). |
| **Hans Conrad Escher von der Linth** | 1,000+ drawings and watercolours 1780–1822, panoramas up to 4 m; rock layers with clearly defined contours; sometimes finished on site, sometimes sketched with "detailed notes describing the forms and positions of rock formations" then completed later [V, Wikipedia, Cabinet]. | Two-stage figures: a pencil field state (construction lines, notes) and an ink-and-wash finished state, both visible at once. |
| **Eduard Imhof** | Pen-and-ink and watercolour studies from student years; copies of Siegfried sheets revised in glacier areas; green contour experiments [V, kartensammlung.ch]. Field sketches: loose pencil, a few confident lines, colour as flat transparent wash by elevation [R]. | Washes in 2–3 elevation tones under ink lines; never a gradient. |
| **Surveyor's field book (Feldbuch)** | Split spread: left page tabular readings, right page header metadata (weather, equipment, party), remarks and the sketch; north arrow on every sketch; point ids matching the table; text reads left to right; no erasing, single strike-through plus correct value plus initials [V, open-exam-prep, Atlantic OER]. | **Left = numbers (print table), right = sketch and remarks (hand).** Single-strike corrections with initials. North arrow on every plan sketch. |
| **Darwin (Beagle field books, notebook B)** | Pencil pocket books; few but complex "eye-sections" later stitched into published plates; specimen notebooks unruled with one vertical left margin line, specimen number in the margin, symbols and short annotations in the margin [V, darwin-online]. "I think" above the tree sketch [V]. | Marginal numbers keyed to figures; "eye-section" = an honest, labelled, approximate sketch; a two-word hand headline ("I think") above a figure is enough. |
| **John Muir Laws nature journal** | Words + pictures + numbers on every page; prompts "I notice / I wonder / it reminds me of"; metadata (date, time, weather, location) in a corner; flexible grid with title, conditions, colour-match dots, notes, close-up "zoom" insets, a landscape for sense of place; boxes around some layouts [V, Laws via Tweney, parks/sierra pages]. | Each section has the three voices: *I notice* (measurement, print), *I wonder* (open question, hand, pencil), *it reminds me of* (analogy, hand). Zoom insets: a circled region on a photo with a leader to an enlarged crop. Colour-match dots = the legend swatches, painted. |
| **Lab notebooks** | Every page dated, single-line strike for errors, sections separated by rules and initialled [V, Illinois SOP, Weber]. | "Tried / failed" entries struck once, still readable, initials and date beside the correction. |
| **Urban Sketchers** | "Our drawings are a record of time and place. We are truthful to the scenes we witness." [V]. Common page conventions: lettered place-name title, date, small text blocks wrapping around the drawing, drawing bleeding off the page edge, colour only where it matters [R]. | Truthfulness as licence: the real photo is the scene; the sketch annotates it. Let figures run to the page edge on wide screens. |
| **Excalidraw / tldraw** | Excalidraw: rough.js shapes at a fixed per-element seed and a hand font; Virgil replaced by Excalifont (OFL-1.1, Latin/Greek/Cyrillic) to improve legibility [V]. tldraw: "draw" style uses perfect-freehand for variable-width strokes; solid/dashed/dotted styles are uniform width [V]. | Hand-drawn reading comes from three things together: wobble + a hand font + flat, few colours. Missing any one and it looks like a diagram tool. |

---

## 3. Page grammar of a sketched page

**Lettering hierarchy (three hands, one person).**
1. *Headline lettering*: big (2.5–3.5× body), heavier marker or brush pen, often underlined twice or boxed by a hand rule, sometimes with a short wave or zig-zag under it. Written once per page/section.
2. *Block capitals*: labels on drawings, place names, peak names, axis titles. Small, upright, evenly spaced (ISO 3098 / architects' lettering: single-stroke gothic, guide-line discipline [V, lettering guides]).
3. *Cursive or joined notes*: running remarks, questions, asides. Smaller, faster, can tilt 2–6°.
4. *Print* only where a reading must be exact (numbers, tables, code) — the "stamped" or "typed" layer pasted into the hand page.

**Notes.** Unboxed by default; box only (a) the conclusion, (b) the metadata block, (c) a warning. Boxes are hand rules with overshoot at the corners, not closed rectangles. Notes sit next to the thing and connect with a leader: thin, curved slightly, ending in a dot on the object and starting at the note's first or last letter, not its middle.

**Arrows.** Three kinds: *leader* (hairline, dot end), *movement/causation* (pen, open head, curved, can cross a gutter), *"see here"* (short, heavy, hooked; used once per page). Arrows across the page into the margin are the strongest "notebook" signal.

**Emphasis marks.** Single underline = term; double underline = result; wavy underline = doubt; circled word = keyword to remember; marker highlight = the one sentence to read; asterisk with a margin note = caveat; check marks ✓ for done, single cross for failed; strike-through with correction beside it.

**Numbering.** Circled step numbers (①②) keyed into the prose; "Fig. 3" lettered by hand at the figure's top-left, with the caption as a hand note, not a typeset line.

**Dated entries.** Every page and every major figure carries a date and place; corrections carry a later date ("rev. 30.9.").

**Layers.** Pencil first (construction lines, grid ticks, rough layout, guide lines for lettering, light and grey, partly erased look), then ink (final lines, lettering), then wash (one or two transparent tones, edges darker, slightly outside the ink lines), then a marker (only highlights). Leaving the pencil visible under the ink is what makes a page look worked rather than printed.

**Colour.** Limited palette: graphite, one black/brown ink, one red pen for corrections and the answer, two or three washes (sky/water blue, rock/earth ochre, forest green), one highlighter. The existing `--gb-*` inks map onto this directly.

**Mountains, the sketcher's way.** (a) Ridge line first, one confident stroke, heavier on the near ridge; (b) a second, lighter, more distant ridge behind; (c) shading strokes only on shaded faces, running down the fall line, short and spaced, denser near the ridge and fading downwards; (d) a few gully lines; (e) snow left as paper; (f) a wash band under the ridge for distance (blue-grey far, warm near); (g) labels above, leader ticks down to the summits [R; Heim/Imfeld practice; consistent with swiss-sketch §1]. Few lines: the ridge and the label do 80% of the work.

**Panorama strip.** Ridge outline from the real horizon; peak names in block caps above, rotated 0° (or up to 60° on crowded strips, all the same angle); hairline ticks down to the summit; altitude in print after the name; compass bearings along the top edge with every 10° tick and lettered N/E/S/W; a dashed line for "hidden" peaks.

**Contour sketch.** Index contours inked, intermediates in pencil, labels broken into the line, a few spot heights with a dot and number, a north arrow, scale bar hand-lettered "0 — 500 m".

---

## 4. Techniques with code-level recipes

### 4.1 Strokes: map our helpers to rough.js / perfect-freehand vocabulary

rough.js defaults [V wiki]: `roughness 1`, `bowing 1`, `strokeWidth 1`, `fillStyle hachure` (also `solid, zigzag, cross-hatch, dots, dashed, zigzag-line`), `fillWeight = strokeWidth/2`, `hachureAngle -41`, `hachureGap = 4 × strokeWidth`, `curveStepCount 9`, `disableMultiStroke false`, `preserveVertices false`, `seed 0`.

perfect-freehand `getStroke` defaults [V]: `size 8`, `thinning 0.5`, `smoothing 0.5`, `streamline 0.5`, `simulatePressure true`, `start/end {taper, cap, easing}`; MIT. tldraw uses it for its "draw" style.

Recommended presets for `sketch.ts` / `sketchify.ts` (names are ours; numbers in px at 1:1):

| Preset | Use | Equivalent | Values |
|---|---|---|---|
| `pen` | figure furniture, boxes, arrows | rough.js | roughness 1.2, bowing 1.5, 2 passes, preserveVertices false, overshoot 2–4 px at ends |
| `pencil` | construction lines, guides, grid ticks | rough.js + grain | roughness 0.6, bowing 0.5, 1 pass, opacity 0.45, `filter: url(#nb-pencil)` |
| `marker` | headline underlines, the "see here" arrow | perfect-freehand | size 3.2, thinning 0.25, smoothing 0.6, streamline 0.5, taper start 0, end 12 |
| `fineliner` | leaders, hatch strokes | perfect-freehand | size 1.1, thinning 0.6, taper start 4, end 10 |
| `data` | measured lines | existing `data` prop | exact, 1 pass, constant width ≥ 1.2 (unchanged) |

Note: `taperedOutline` in `sketch.ts` already does the perfect-freehand job; no dependency needed. Use it everywhere a stroke is furniture (canon 33 already says "furniture tapers").

Furniture amplitude can go up: the 0.9 px tolerance protects *data*; furniture (boxes, underlines, arrows, frames) can take roughness 1–1.5 and overshoot, because it encodes nothing. This is the cheapest aggressive move.

### 4.2 Filters

**Pencil (graphite) layer** — high-frequency displacement breaks a line into grainy fragments (pattern from Olivia Vane's Observable notebook: `baseFrequency 0.5`, `scale 7` [V]); tuned down for screen:

```html
<filter id="nb-pencil" x="-2%" y="-2%" width="104%" height="104%">
  <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="1" seed="5" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" xChannelSelector="R" yChannelSelector="G" result="d"/>
  <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="1" seed="9" result="g"/>
  <feColorMatrix in="g" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -1.8 1.45" result="mask"/>
  <feComposite in="d" in2="mask" operator="in"/>
</filter>
```
Use on a `<g>` of pencil strokes in `--nb-pencil` at opacity 0.45–0.6. Never on text or photos.

**xkcd wobble** — chart.xkcd's `xkcdify` filter is `feTurbulence baseFrequency 0.05` + `feDisplacementMap scale 5` [V source]. Ours (0.035, scale 2.4) is half as strong; for HTML furniture (boxes, rules made with CSS borders) use scale 3–4.

**Wobble on HTML boxes** — the same filter works on HTML via CSS `filter: url(#nb-wobble-html)`; put the border on a pseudo-element so the text is not displaced:

```css
.nb-box { position: relative; padding: 12px 16px; }
.nb-box::before {
  content: ""; position: absolute; inset: -2px;
  border: 1.4px solid var(--nb-ink);
  border-radius: 255px 15px 225px 15px / 15px 225px 15px 255px; /* classic hand-drawn radius trick */
  filter: url(#nb-wobble-html); pointer-events: none;
}
```
(`255px 15px 225px 15px/15px 225px 15px 255px` is the widely copied CSS sketch-border recipe [V].) Better still: an absolutely positioned SVG `SketchRect` sized by a `ResizeObserver` or `preserveAspectRatio="none"` with `vector-effect: non-scaling-stroke` (the pattern `PenRule` already uses).

**Watercolour wash** (new; untested) — displaced fill, darker edge, paper grain, multiply:

```html
<filter id="nb-wash" x="-6%" y="-6%" width="112%" height="112%" color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="3" seed="21" result="flow"/>
  <feDisplacementMap in="SourceGraphic" in2="flow" scale="10" xChannelSelector="R" yChannelSelector="G" result="shape"/>
  <feMorphology in="shape" operator="erode" radius="2.5" result="core"/>
  <feComposite in="shape" in2="core" operator="out" result="rim"/>            <!-- edge ring -->
  <feComponentTransfer in="rim" result="rimDark"><feFuncA type="linear" slope="0.55"/></feComponentTransfer>
  <feComponentTransfer in="shape" result="body"><feFuncA type="linear" slope="0.32"/></feComponentTransfer>
  <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="4" result="paper"/>
  <feColorMatrix in="paper" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -0.9 1.2" result="tooth"/>
  <feMerge result="pigment"><feMergeNode in="body"/><feMergeNode in="rimDark"/></feMerge>
  <feComposite in="pigment" in2="tooth" operator="in"/>
</filter>
```
Apply to a `<path>` filled with the wash colour (`--gb-water`, `--gb-contour` light tints), with `style="mix-blend-mode: multiply"` on the group so ink lines show through. Draw the wash 2–4 px *outside* the ink outline and offset by a few px; real washes never register to the line. Cost: three turbulences; limit to ≤ 3 washes visible at once or bake to a static SVG at build time (the Tafel bake pipeline already exists).

**Generative alternative (no filter, SSR-safe)** — Tyler Hobbs' method: deform a polygon recursively (base ~7 passes, each layer 4–5 more), stack 30–100 layers at about 4 % opacity; interleave colours; mask with ~1000 small circles for texture [V]. For the web: 8–12 layers at 6–8 % opacity is enough, one `<path>` per layer, generated once in `useMemo` from a seed. Use for the few hero washes (sky band, lake, a glacier).

**Never animate the filter seed** (squigglevision "boil") except possibly a single hover on one element; it re-rasterises every frame.

### 4.3 CSS for hand marks on HTML text

```css
/* marker highlight: a skewed band, multiply so ink stays black */
.nb-mark { background: linear-gradient(104deg, transparent .3em, var(--nb-highlight) .5em,
           var(--nb-highlight) calc(100% - .4em), transparent 100%) 0 78% / 100% .7em no-repeat;
           mix-blend-mode: multiply; box-decoration-break: clone; }

/* hand underline: an SVG path as a background, stretched; two variants seeded by nth-child */
.nb-u { background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 6' preserveAspectRatio='none'%3E%3Cpath d='M1 4 C 30 2.6, 60 5, 99 3.2' stroke='%23bf2233' stroke-width='1.6' fill='none' stroke-linecap='round' vector-effect='non-scaling-stroke'/%3E%3C/svg%3E")
        0 100% / 100% .4em no-repeat; padding-bottom: .15em; }
.nb-u2 { /* double underline for results: two paths, second shorter and offset 3px */ }

/* doubt: wavy */
.nb-doubt { text-decoration: underline wavy color-mix(in srgb, var(--nb-red) 60%, transparent);
            text-decoration-thickness: 1px; text-underline-offset: 4px; }

/* correction: single strike, value still readable, correction after in red hand */
.nb-struck { text-decoration: line-through 1.5px var(--nb-red); color: var(--nb-faint); }

/* seeded tilt without JS: a per-element custom property set at render from hashSeed(id) */
.nb-tilt { rotate: calc(var(--seed-unit, .5) * 6deg - 3deg); transform-origin: 0 50%; }
```

Static rough-notation equivalents (rough-notation types: underline, box, circle, highlight, strike-through, crossed-off, bracket; options `padding 5`, `iterations 2`, `strokeWidth 1`, `animate true 800 ms`, MIT [V]): implement the same seven as a `<HandMark type>` React component that measures its child with `getClientRects()` (multi-line) and draws one absolutely positioned SVG overlay per line with our `sketchCurve`/`sketchCircle`. Animation off under reduced motion and webdriver, as `.nb-draw` already does. Pulling in rough-notation itself is possible (MIT, tiny) but it draws randomly per mount, which breaks SSR stability.

### 4.4 Lettering in SVG figures

- Labels in block caps: `HandText variant="caps"` (new): Patrick Hand SC or Shantell Sans `INFM 40` uppercase, `letter-spacing .06em`, 11–13 px in an 800 px viewBox.
- Headline on a figure ("Fig. 3 – the two worlds meet"): note hand 22–28 px, slight rotation −1.5°, a marker underline beneath *part* of the line (not the full width).
- Leaders: `fineliner` taper, starting 3 px from the text, ending in a 1.5 px dot. Curve by a quadratic bow of 8–15 % of length; leaders never cross; if they must, break the lower one (cartographic convention).

### 4.5 Mountains from real data (SVG recipe)

1. Ridge: real DEM horizon polyline (exact, `data`), stroked with `marker` taper width 1.8–2.2 near ridge; a farther ridge (second horizon band if available) at width 1.0, `--nb-pencil`.
2. Fall-line strokes: for each ridge sample every 7–12 px on the shaded side (normal facing away from NW light), emit a stroke downwards along the local gradient, length 6–18 px decreasing with distance from the ridge, `fineliner` taper, opacity 0.6. Skip on lit faces. This is the sketcher's version of the LK rock hachure; exactness is not needed because the ridge carries the data.
3. Wash band under the ridge: `nb-wash` (or Hobbs layers) in blue-grey, 18–30 px tall, offset 3 px below.
4. Labels: block-caps names, print altitude, hairline ticks.
5. Sky: paper. No gradient.

### 4.6 Performance notes

- Filters rasterise their subtree; feTurbulence dominates; keep ≤ 3 filtered regions visible and filter regions tight (sketch-rendering §2.3). Washes and pencil layers are good candidates to **bake** to static SVG/PNG at build time (the `scripts/gipfelbuch` bakers exist).
- Fonts: four hand files is the ceiling. Subset Latin; variable fonts (Caveat, Shantell, Playpen) are one file per family.
- Do not filter HTML text, ever; `filter` on a pseudo-element only.
- Hand-drawn HTML marks: one SVG per mark, generated in `useMemo`; ≤ 40 per page.

---

## 5. Font system recommendation

**Candidates** (Google Fonts, all OFL unless noted; legibility judgements are design opinion [R] unless marked):

| Face | Character | Axes / features | Headline | Body 18–20 px | Label 12–14 px | Verdict |
|---|---|---|---|---|---|---|
| **Caveat** (Impallari) | quick ballpoint cursive, narrow | variable wght 400–700; contextual alternates vary letters by position [V] | good | readable at 20+, tiring in paragraphs | too small x-height | **Note cursive** |
| **Playpen Sans** (TypeTogether, 2023) | neat felt-tip print, school research basis | variable wght 100–800; 7 alternates per glyph with a built-in shuffler that avoids repeats nearby [V] | ok | **best hand body** | good | **Hand body** (if body goes hand) |
| **Shantell Sans** (Shantell Martin / ArrowType) | marker print, playful | wght 300–800, ital, INFM 0–100, BNCE −100–100, SPAC 0–100; randomised alternates via `rlig` [V] | good at INFM 60–100 | good at INFM 20–35, BNCE 0 | good | Labels / alt body (already bundled as GB Hand Small) |
| **Kalam** (ITF) | slanted felt-pen | 300/400/700 [V] | ok | good at 19 px | ok | Backup body |
| **Patrick Hand** / **Patrick Hand SC** | upright neat print / small caps | 400 only [V for Patrick Hand] | weak | good at 18 px | **SC is ideal block caps** | **Block-caps labels** |
| Architects Daughter | architect's print caps | 400 | ok | fair | good | Was in code; flatter than Patrick Hand SC |
| Gaegu | round, childish | 300/400/700 | – | fair | – | Too cute |
| Gochi Hand, Covered By Your Grace, Reenie Beanie, Nanum Pen Script, Indie Flower | various | single weight | display only | poor | poor | Skip (legibility or cliché) |
| Just Another Hand | tall condensed caps | 400 | **good for headline lettering** | no | ok | Option for headlines |
| Rock Salt, Permanent Marker | heavy marker | 400 | posters only | no | no | Skip (shouting) |
| Excalifont | Excalidraw's revised Virgil, legibility-tuned | OFL-1.1, Latin/Greek/Cyrillic [V] | good | fair | good | Strong but reads "Excalidraw" |
| osifont | ISO 3098 technical lettering | GPLv3 + font exception [V] | – | – | good, engineer | Needs licence approval; too CAD for "informal" |

**Recommended 3-face system** (+ print for numbers):

| Role | Face | Size (px) | Settings |
|---|---|---|---|
| Headline lettering (page title, section titles) | **Caveat 700** (or Shantell Sans `INFM 100, wght 700`) | H1 56–64, H2 36–40, H3 28 | `rotate: -1deg` max on H1; a `marker` underline under 60–80 % of the line; never all caps |
| Note cursive (margin notes, captions, figure titles, asides, callouts) | **Caveat 500** | 20–22 (never < 18) | contextual alternates on (`calt`), line-height 1.15 |
| Block-caps labels (figure labels, peak names, kickers, tab labels, axis titles) | **Patrick Hand SC** (or Shantell Sans `INFM 35` + `text-transform: uppercase`) | 12–15 | `letter-spacing .06em`, upright, no rotation |
| Hand body (optional, see below) | **Playpen Sans 400** (or Shantell `INFM 25, BNCE 0, SPAC 10`) | 18–19, line-height 1.55, measure ≤ 62 ch | built-in shuffler; `font-variant-numeric: tabular-nums` irrelevant—digits go print |
| Print (numbers, units, tables, code, equations) | existing GB Mono / Fira | as today | unchanged |

**Should body prose be hand?** The user asked for "hand written". Evidence says spacing matters more than letter shape for readability [design book §6], and Playpen Sans was designed from handwriting-education research with alternates that defeat the "repeated glyph" fake look [V]. Recommendation: **yes, body in Playpen Sans at 18–19 px**, but (a) only on Gipfelbuch, (b) long technical paragraphs (> 120 words) stay possible in print via a per-section `print` switch, (c) all numbers, units and code inside prose render in print automatically (extend `splitPrintRuns` from `HandText` to `PROSE`), (d) a reader toggle "Druckschrift" in the sheet header switches body to Fira (stored per viewer, default hand). This gives the hand page without making the 66-ch research prose a chore. If the team rejects hand body, the fallback is: hand for *everything but* paragraphs (titles, kickers, captions, callouts, lists' bullets/numbers, tables' headers, notes).

**Repeated-glyph avoidance.** Prefer faces with automatic alternation: Playpen (7 alternates, shuffler), Shantell (`rlig` cycling under INFM/BNCE), Caveat (`calt`). Do not use faces with one glyph per letter for running text (Patrick Hand, Kalam) — repetition is what makes handwriting fonts look fake.

---

## 6. Prop verdicts

The rule: *practice yes, defect no* (canon 57) — a mark a real author makes deliberately is in; damage and decoration are out. Aggressiveness comes from the *hand*, not from the *object*.

| Prop | Verdict | Why / how |
|---|---|---|
| Paper grain texture | **No** | User rejected; it is a defect, not a practice; costs paint. Paper stays flat warm white. |
| Pencil graphite grain on *strokes* | **Yes** | That is the pencil, not the paper. `#nb-pencil` on construction layers only. |
| Soft graph grid | **Keep** | User approved; it is the surveyor's paper and the baseline grid. |
| Ruled (lined) paper | **No** | Competes with the grid; school-exercise connotation. |
| Red margin rule | **No** (as decoration) / **Yes** (as Darwin's single *pencil* margin line on wide screens, only if the margin column holds keyed numbers) | Only when it organises something. Default off. |
| Tape strips | **No** | Kitsch prop; fakes a physical act. Prints sit square on a mat. |
| Tilted prints/polaroids | **No** for photos (photo = evidence, square) / **Yes, ≤ 4°** for *hand notes and sticky-free note blocks* | Tilt belongs to writing, not to evidence. |
| Dog-ears, torn edges, page curl | **No** | Damage simulation. |
| Coffee stains, smudges, fingerprints | **No** | Pure kitsch, also reads as dirt on a research site. |
| Stamps (summit/hut stamp) | **Yes, one per sheet, carrying a fact** | Ring + lettering: sheet number, date, status ("geprüft", "verworfen"). Drawn vector, not grungy raster. |
| Sticky notes | **No** | Office prop; use a hand-boxed note instead. |
| Washi, paper clips, binder rings | **No** | Props. |
| Crossings-out, corrections with initials | **Yes, many** | Core notebook practice and honest about failed attempts. |
| Erased-pencil ghosts | **Yes, sparingly** | Pencil construction lines left visible at 30–40 % (not "erased smudge"). |
| Watercolour wash | **Yes** | A practice (Imhof, Escher, Heim). Limited palette, transparent, off-register. |
| Highlighter | **Yes, one sentence per section** | Practice; multiply blend. |
| Doodles unrelated to content | **No** | Every mark carries a fact (canon 56). |

---

## 7. Aggressive restyle moves, ranked by impact

1. **Rewrite the canon's hand rules** (52–54, README "Hand vs print"): hand is the form; print carries only numbers, units, tables, code and equations. Lift the 3-notes/12-words cap to "notes as needed, ≤ 20 words each"; rotation ≤ 4° for notes, 0° for labels.
2. **Hand headlines**: H1/H2/H3 and section titles in Caveat 700 (or Shantell INFM 100) with a partial marker underline; drop the serif H1 on Gipfelbuch.
3. **Hand body** in Playpen Sans 18–19 px with automatic print runs for digits/units/code, plus a "Druckschrift" toggle.
4. **Register-entry header** on every sheet: date · time · place/altitude · weather · initials · "Route:" (pipeline step), hand-lettered, ruled off by a hand line.
5. **Every figure gets a pencil layer** (construction lines, guide ticks, a rough first outline 2–4 px off the final line) under `#nb-pencil` at 40–55 % opacity.
6. **Raise furniture roughness** to rough.js-like 1.2 with 2 passes, corner overshoot 2–4 px, tapered ends; data lines stay exact.
7. **Kill crisp UI chrome on Gipfelbuch**: tabs, toggles, buttons, table rules, list bullets and the photo switcher get hand marks (circled active tab, hand check boxes, hand-rule table headers, `①②` list numbers).
8. **Margin notes with arrows across the gutter**: on wide screens, 1–3 notes per section live in the margin column connected by curved leaders to the exact phrase or figure region (anchor positioning).
9. **Washes**: one or two transparent washes per figure (sky band, lake, terrain tint) via `#nb-wash` or baked Hobbs layers, offset from the ink.
10. **Panorama strips lettered by hand**: block-caps peak names, print altitudes, leader ticks, compass ticks; used as the recurring hero across pages.
11. **Fig. call-outs lettered**: "Fig. 2" in note cursive at the figure's top-left with the caption as a hand note below; remove typeset captions.
12. **Zoom insets** (Laws): circle a region on the real photo, leader to an enlarged crop with notes; the crop itself unfiltered.
13. **Corrections as content**: struck first guesses with red corrections, initials and dates, on every page that has a before/after.
14. **Left numbers, right sketch** (Feldbuch spread) for data-heavy sections on wide screens: print table on the left, sketch and remarks on the right.
15. **"I notice / I wonder / It reminds me of"** as the three note voices: notice = ink, wonder = pencil, reminds = blue; replaces generic Callout tones.
16. **Conclusion box**: the one boxed thing per section, a hand box with overshoot and double underline on the result.
17. **Mountain sketch recipe** (§4.5) for every terrain figure: ridge, fall-line strokes on shaded faces only, wash band, labels.
18. **Highlighter on one sentence per section**, multiply blend.
19. **Hand marks component** (`<HandMark type="underline|circle|box|bracket|strike|cross|highlight">`), static, seeded, multi-line aware; used in prose.
20. **Circled numbers in prose** keyed to figure markers (`①` in text = `①` on the drawing).
21. **Hand-drawn charts everywhere**: axes as single pen strokes that stop short, hand tick labels in print, hachure bars, direct hand labels at line ends; no legends.
22. **One stamp per sheet** (status + date + sheet no.) as a vector ring, slightly rotated (≤ 8°), in red or navy.
23. **Informal layout**: allow figures to break the text column (bleed into margin or past the right edge on wide screens), notes to sit beside or overlap figure whitespace, and two small studies side by side rather than one big figure.
24. **Index as a hand table of contents**: hand-lettered entry titles with dotted leaders to page numbers and a tiny thumbnail sketch per entry.
25. **Signposts and prev/next** as hand arrows with lettered destinations.
26. **Draw-on once**: entries' ink strokes draw on scroll (already wired as `.nb-draw`), headlines underline themselves; off under reduced motion/webdriver (static is the design).
27. **Dark mode**: chalk-on-slate variant of the same hands (pencil becomes 50 % chalk, washes become screen-blended low-saturation tints), or force paper (light) for Gipfelbuch; decide once.

Guardrails that still hold: photos and DEM rasters never filtered; data geometry exact; ≥ 4.5:1 text contrast (Caveat at 20+ px and Playpen at 18 px pass on the warm paper with `--gb-ink`); every mark carries a fact; static state is the design.

---

## 8. Sources

Artefacts
- Gipfelbuch history and entry content: https://www.bergwelten.com/a/vom-sinn-und-unsinn-des-gipfelbuchs ; https://www.bergwelten.com/a/was-schreibe-ich-ins-gipfelbuch ; DAV, "Spuren des Dagewesenseins", Panorama 1/2014: https://bibliothek.alpenverein.de/webOPAC/04_FAQ_oft_gestellte_Fragen/Gipfel_und_Huettenbuecher/SpurendesDagewesenseinsArtikelimPanorama-1-2014-Kultur-MedienS.74.pdf (image PDF, not text-extracted)
- Albert Heim: https://hls-dhs-dss.ch/de/articles/028851/2008-05-29/ ; ETH 1988 exhibition: https://www.albert-heim-stiftung.ch/wp-content/uploads/2023/01/1988_Gedenkausstellung-Albert-Heim-ETH.pdf
- Xaver Imfeld: https://hls-dhs-dss.ch/de/articles/031187/ ; Rigi-Kulm panorama: https://swisscollections.ch/Record/991171236089905501
- Escher von der Linth: https://en.wikipedia.org/wiki/Hans_Conrad_Escher_von_der_Linth ; https://cabinetmagazine.org/issues/27/kastner.php ; https://kunsthausglarus.ch/en/exhibitions/archive/panoramas
- Eduard Imhof virtual library: https://www.kartensammlung.ch/Imhof/imhof_engl.html ; https://www.kartensammlung.ch/Imhof/imhof7engl.html
- Surveyor field books: https://open-exam-prep.com/study-guides/nsps-cst-1/field-operations-notes-communication/field-note-bookkeeping ; https://pressbooks.atlanticoer-relatlantique.ca/lined/chapter/surveying-field-notes/
- Darwin: https://darwin-online.org.uk/EditorialIntroductions/Chancellor_fieldNotebooks1.7.html ; https://darwin-online.org.uk/EditorialIntroductions/Chancellor_Geological_specimen_notebooks_CUL-DAR236.html ; https://darwinproject.ac.uk/darwin-s-species-notebooks-i-think
- John Muir Laws: https://dylan.tweney.com/nature-journaling-with-john-muir-laws/ ; https://sierraclub.org/sierra/2016-3-may-june/green-life/understand-natural-world-first-pay-close-attention ; https://www.MtArboretum.org/s/Nature-Journaling-Tutorial.pdf
- Lab notebooks: https://scs.illinois.edu/system/files/inline-files/SOP-notebooks.pdf ; https://faculty.weber.edu/fonbrown/CEET1140/Lab%20Book%20Guidelines.pdf
- Urban Sketchers manifesto: https://en.wikipedia.org/wiki/Urban_Sketchers
- SAC legend (dashed approximate routes): https://sac-cas.ch/en/legende

Techniques
- rough.js options: https://github.com/rough-stuff/rough/wiki
- rough-notation: https://github.com/rough-stuff/rough-notation
- perfect-freehand: https://github.com/steveruizok/perfect-freehand ; tldraw draw shape: https://tldraw.dev/sdk-features/draw-shape
- chart.xkcd filter: https://raw.githubusercontent.com/timqian/chart.xkcd/master/src/utils/addFilter.js
- Pencil filter: https://observablehq.com/@oliviafvane/simple-pencil-ink-pen-effect-for-svg-path-using-filters ; https://css-tricks.com/creating-a-pencil-effect-in-svg/
- feTurbulence / feDisplacementMap: https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feTurbulence
- Watercolour: https://www.tylerxhobbs.com/words/a-guide-to-simulating-watercolor-paint-with-generative-art ; https://sighack.com/post/generative-watercolor-in-processing
- CSS sketch border radius: https://coliss.com/articles/build-websites/operation/css/css-border-radius-exercise-by-jrcharvey.html

Fonts
- Shantell Sans axes and `rlig` randomisation: https://shantellsans.com/ ; https://github.com/arrowtype/shantell-sans
- Playpen Sans: https://fonts.google.com/specimen/Playpen+Sans/about ; https://type-together.com/playpen-sans-font
- Caveat: https://fontalternatives.com/fonts/caveat/
- Kalam, Patrick Hand overview: https://madegooddesigns.com/handwriting-fonts/
- Excalifont: https://plus.excalidraw.com/excalifont
- osifont (ISO 3098, GPLv3 + font exception): https://fedoraproject.org/wiki/OSI_fonts
