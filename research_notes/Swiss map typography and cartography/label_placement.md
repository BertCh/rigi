# Map label placement: classical rules, automation, mountain and panorama labelling

## 1. Classical rules (Imhof, Yoeli, Robinson, Brewer): point, line, area labels, type hierarchy, sizes

### Takeaway
Imhof (1962/1975) set six principles and per-geometry rules that every later system encodes. For points the order is upper-right first (Yoeli's 8-position ranking), for lines follow a straight stretch above the line, for areas stay inside and letter-space up to 4x letter height. Hierarchy is carried by size, case, weight, colour and italic (water only).

### Cited Findings
- Imhof's six principles: names easily readable and locatable; name and object easily associated; covering/overlap/concealment avoided; names reveal spatial situation, extent, connections, importance; type arrangement reflects classification and hierarchy; names neither densely clustered nor evenly dispersed. — [UNBC lettering lecture / search summary of Imhof 1975](https://gis.unbc.ca/wp-content/uploads/2025/01/lettering2025.pdf); [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Point labels: 8 candidate positions around the symbol. Yoeli (1972) ranked them, top priority upper-right, then lower-right, upper-left, lower-left (per search summary of the lecture notes). Imhof only said "where space allows, begin the name to the right of the symbol". — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Rationale (Freeman & Ahn 1987, quoted in Kern & Brewer): the name should read away from the feature (first character nearest it) and above rather than below, because English has more ascenders than descenders. — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Wu & Buttenfield (1991): across three road-map publishers only 4 of Yoeli's 8 positions were used by a majority of labels; they argue for more flexible positioning. — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- General positioning rules (lecture slides on Imhof): minimise ambiguity of reference; labels are movable, symbols are not, so labels yield; horizontal lettering unless no space (points) or feature is not horizontal (lines/areas); follow parallels or curve to avoid interference. — [UNBC lettering](https://gis.unbc.ca/wp-content/uploads/2025/01/lettering2025.pdf)
- Line labels: follow the line orientation; choose a relatively straight piece; place above the line far enough that descenders do not touch it; avoid extreme or complicated curvature; do not spread letters out, but repeat the name at reasonable intervals. — [UNBC lettering](https://gis.unbc.ca/wp-content/uploads/2025/01/lettering2025.pdf); [Imhof rules summary via Utrecht/van Dijk paper](https://dspace.library.uu.nl/bitstream/handle/1874/2561/2001-44.pdf) (search snippet only; page itself returned 403)
- Lettering should not go past vertical (readable orientation); the Imhof exception is contour labels where letter tops point uphill. Near-vertical-but-not-quite looks accidental. — [UNBC lettering](https://gis.unbc.ca/wp-content/uploads/2025/01/lettering2025.pdf)
- Area labels: fully inside the area; if too small, label as a point; orient to the shape and curve as needed, curvature not beyond 60 degrees; horizontal preferred; if the area is large, letter-space evenly but not more than 4x letter height; serifs help in spaced names. — [UNBC lettering](https://gis.unbc.ca/wp-content/uploads/2025/01/lettering2025.pdf); [Imhof summary snippet](https://dspace.library.uu.nl/bitstream/handle/1874/2561/2001-44.pdf)
- Hierarchy variables: italic and blue reserved for hydrography; bold implies prominence; UPPER CASE implies major features and should be used sparingly (about 13% less readable than lower case, per the lecture); colour is associative (blue water, brown contours, black standard, red important); size denotes importance; minimum size 6 pt; consistency within a class, more contrast between classes than within, few typefaces and vary form instead. — [UNBC lettering](https://gis.unbc.ca/wp-content/uploads/2025/01/lettering2025.pdf)
- Shortridge (1979): readers reliably discriminate font sizes differing by 34% or more (2 to 2.5 pt at typical label sizes, e.g. 10 pt vs 7.5 pt); a mask/window around letters over graphic patterns preserves size discrimination. — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Sadahiro (1995) targets: 95% visibility ratio, 90% legibility ratio (labels not overlapping other labels). — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Manual label placement can consume half or more of map production time (Yoeli 1972). — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Imhof's 1962 essay "Die Anordnung der Namen in der Karte" is the German original; Imhof led ETH's Institute of Cartography 1925-1965 and shaped the Swiss national map. — [Wikipedia, National Maps of Switzerland](https://en.wikipedia.org/wiki/National_Maps_of_Switzerland)

### Inferences
- Implementable ranking for a point candidate set: [NE, SE, NW, SW, then E, W, N, S] with a cost per rank, and a halo-aware box. A hard ceiling of 60 degrees of cumulative bend and 4x letter-height tracking can be coded directly as constraints.
- Defaults for a digital Swiss look: lower-case sentence-style names for ordinary peaks/villages, UPPER with tracking for ranges and major regions, italic blue only for water, 6 pt (about 8 px at 96 dpi) as a floor, size steps of at least 1.34x between classes.

### Gaps
- Imhof 1975 and Yoeli 1972 primary texts were not accessed; the numbers above come via secondary summaries. Imhof's own letter-size tables and his exact line-label offset distances were not found.
- Robinson (Elements of Cartography), Brewer (Designing Better Maps), Tyner, Kraak & Ormeling were not directly accessed; no verified type-size tables from them.

## 2. Halos, masks and casing

### Takeaway
Masking is supported by perception evidence (Shortridge), and halos are the standard digital equivalent; precise width/colour guidance was not retrievable.

### Cited Findings
- A window/mask around lettering over patterns preserves discrimination of type sizes; interrupted linework does not harm it. — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Esri discusses variable-depth masking for contour labels and polishing halos (blocky white halos criticised; halos used to reach WCAG-like text contrast of 4.5:1). — search results only: [Esri "Polishing your halo"](https://esri.com/arcgis-blog/products/arcgis-living-atlas/mapping/polishing-your-halo) (fetch returned 403)
- deck.gl TextLayer: outline is SDF-only; `outlineWidth` is relative to font size (default 0), `outlineColor` default black; `background`, `getBackgroundColor`, `backgroundPadding` give box knockouts. — [deck.gl TextLayer docs](https://deck.gl/docs/api-reference/layers/text-layer)
- Mapbox style spec has `text-halo-width` and `text-halo-blur` (defaults not retrieved). — [Mapbox style spec](https://docs.mapbox.com/style-spec/reference/layers/)

### Inferences
- A practical recipe (from general practice, not sourced here): halo colour = local ground colour at high opacity, width about 1 to 1.5 px for 10-12 px text, with slight blur so it reads as a mask not a box; use thinner halo for contour-dense areas, and avoid black halos on light terrain.

### Gaps
- No sourced numeric halo width/colour best practice (Esri page blocked). No source comparing hairline casing vs halo.

## 3. Automated placement: complexity, annealing, Maplex, PAL, Mapbox/MapLibre, deck.gl, SDF

### Takeaway
Point-feature label placement is NP-hard; practical systems use candidate positions plus greedy priority-ordered collision tests (Mapbox/MapLibre, deck.gl) or optimisation (annealing, Maplex, PAL). For a real-time deck.gl app, greedy priority + spatial grid is the proven approach.

### Cited Findings
- Christensen, Marks & Shieber (ACM TOG 14(3), 1995): PFLP and most interesting variants are NP-hard; the paper empirically compares algorithms (including simulated annealing). — [MERL TR94-12 / search result](https://www.merl.com/publications/docs/TR94-12.pdf); follow-up on variable-sized labels (SoCG 1997) — [MERL TR97-13](https://merl.com/publications/docs/TR97-13.pdf)
- History: rule-based then expert systems; simulated annealing and genetic algorithms in the 1990s; sliders around 2000; force-directed and fast dynamic-display methods later. — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Kern & Brewer: Maplex placed ~7% more labels than the Standard engine; ~93% placed without overlap and nearly 100% in preferred position; leader-line labelling in dense areas still needed manual work. — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Maplex: fitting strategies (stacking, feature overrun, font-size reduction, abbreviation, key numbering); conflict resolution via feature weight 0-1000 (0 = free space, 1000 = must not overlap), separate polygon interior/boundary weights. — [Esri Maplex docs](https://pro.arcgis.com/en/pro-app/3.5/help/mapping/text/label-with-the-maplex-label-engine.htm)
- QGIS/PAL API exposes line placement, curved perimeter placement for polygons, repeatDistance, overrunDistance and obstacle settings. — [QGIS API search results](https://api.qgis.org/api/3.16/qgspallabeling_8h_source.html)
- Mapbox GL collision algorithm: process symbols in importance order; each symbol's collision geometry is tested against a grid index and inserted if free, else marked collided. Point labels = rectangles; line labels = a series of circles along the line (stable under rotation). Grid example: 600x600 px viewport as 20x20 cells of 30 px. CrossTileSymbolIndex shares IDs across tiles/zooms so opacity fades (current/target 0-1) animate on the GPU. — [mapbox-gl-native wiki: Collision Detection](https://github.com/mapbox/mapbox-gl-native/wiki/Collision-Detection)
- Mapbox/MapLibre controls: `text-allow-overlap`, `text-ignore-placement` default false; `text-variable-anchor` tries anchors in order, with `text-radial-offset` and `text-justify: auto`; draw/priority order via layer order and `symbol-sort-key`; increase `text-padding` to reduce density. — [Mapbox: Optimize label placement](https://docs.mapbox.com/help/dive-deeper/optimize-map-label-placement/)
- MapLibre: `symbol-spacing` default 250 px (line placement only), `symbol-placement` point/line/line-center, `text-letter-spacing` default 0 em, `text-keep-upright` (requires line placement), `text-variable-anchor` requires point placement. — [MapLibre style spec](https://maplibre.org/maplibre-style-spec/layers/)
- deck.gl CollisionFilterExtension: GPU collision computed each frame; props `collisionEnabled`, `collisionGroup` (layers sharing a group collide together), `getCollisionPriority` (-1000..1000, higher wins), `collisionTestProps` (e.g. `{radiusScale: 2}` to pad; accessors not supported); uses point-in-polygon style testing rather than full geometric tests. — [deck.gl docs](https://deck.gl/docs/api-reference/extensions/collision-filter-extension)
- deck.gl TextLayer fontSettings: fontSize 64 (atlas resolution), buffer 4, sdf false by default (TinySDF), radius 12, cutoff 0.25, smoothing 0.1; `billboard` default true; `sizeUnits`, `sizeMinPixels/MaxPixels`. — [deck.gl TextLayer](https://deck.gl/docs/api-reference/layers/text-layer)
- SDF limits: single-channel SDF rounds sharp corners at small sizes; MSDF preserves corners and is more readable small; atlases typically 512 or 1024 px square. — [search summary of SDF font guides](https://www.redblobgames.com/articles/sdf-fonts), [gamedev.net thread](https://gamedev.net/forums/topic/694093-poor-signed-distance-font-quality-when-drawn-small)

### Inferences
- For this app: do point-label candidate selection on the CPU (priority-sorted greedy with grid, 8-position variable anchor) and let CollisionFilterExtension only as a fallback or for per-frame pruning during camera moves; CollisionFilter cannot choose alternate anchors, so the CPU pass must supply them. Collision boxes for tracked/curved text should be circles along the path (Mapbox approach).
- Because deck's SDF text has no hinting, expect blur below roughly 10-12 px; keep Swiss-style small labels at or above that or render a larger atlas fontSize and rely on `smoothing`.

### Gaps
- No verified text-max-angle default (memory says 45 degrees; unverified), text-padding default (memory says 2 px; unverified); spec pages did not give them.
- QGIS user-manual numbers (candidate counts, cost weights) not retrieved; PAL internals only from API listing.
- Simulated-annealing parameters and the finding that SA/tabu beat greedy on dense sets were not verified from the paper text.

## 4. Mountain features, 3D views and panoramas

### Takeaway
For panorama/photo overlays the best-studied formulation is boundary labelling: labels in rows above the skyline with vertical leaders, solved by dynamic programming. Dense peak sets need stacking rows, priority weights and occlusion/visibility filtering.

### Cited Findings
- Gemsa, Haunert & Nöllenburg (ACM GIS 2011): points in a panorama annotated by rectangular labels placed above the image in k rows, each joined to its peak by a vertical leader that crosses no other label; one-sided models "MinRow" (fewest rows for all labels, O(k* n^3)) and "MaxWeight" (max total weight in k rows); sliding labels (horizontal slide along the leader end) are allowed; the weighted variant is weakly NP-hard with a pseudo-polynomial algorithm. — [Gemsa et al. 2011](https://www1.pub.informatik.uni-wuerzburg.de/pub/haunert/pdf/GemsaEtAl2011.pdf)
- Two-sided panorama labelling (above and below) is NP-hard; MILP formulations proposed. — [Gemsa, Haunert, Nöllenburg: multi-row boundary labelling](https://i11www.iti.kit.edu/extra/publications/ghn-mrbla-14.pdf)
- Bell, Feiner & Höllerer (UIST 2001) view management: maintain visual constraints on projected objects (e.g. no mutual occlusion, related items near each other) by modifying position, size or transparency of tagged objects; labels in AR are placed relative to building projections. — [Columbia project page](https://graphics.cs.columbia.edu/projects/ViewManagement) (paper PDF was image-only, algorithm details not extracted)
- Kern & Brewer: leader lines are a last resort when no room next to the feature; both label space and a leader path must be found, and leaders should not cross more features than needed. — [Kern & Brewer 2008](https://cartographicperspectives.org/index.php/journal/article/download/cp60-kern-brewer/pdf/1397)
- Imhof contour-label exception (tops point uphill) and spaced area names with serifs apply to terrain: ranges/massifs use spaced capitals, along the main axis, curved at most about 60 degrees. — [UNBC lettering](https://gis.unbc.ca/wp-content/uploads/2025/01/lettering2025.pdf)

### Inferences
- Photo overlay algorithm: (1) project peaks, drop those occluded by a DEM line-of-sight test; (2) weight by prominence/elevation/distance; (3) place name+elevation labels in rows above the peak with vertical leaders, solving MaxWeight (greedy by weight with row assignment is a simple approximation); (4) shrink or fade labels with distance (depth sort, nearer drawn on top); (5) keep leader ends at the summit pixel.
- Valleys/ridges: fit a polyline along the axis in screen space, label with letter-spacing proportional to length, cap bend at 60 degrees, skip if shorter than the name.
- Glacier and pass labelling: treat glaciers as areas (italic blue, spaced inside), passes as points with elevation.

### Gaps
- PeakFinder's actual algorithm is not published in anything found; only an API repo and Panomax blog appeared. No source on Heim/Bollmann panorama lettering conventions, swisstopo 3D viewer or Google Earth label rules.
- No verified numbers for elevation numeral style (e.g. smaller, lining figures beneath name) from sources.

## 5. Multi-scale and priority ranking

### Takeaway
Zoom-dependent labelling is done by ranking features and running collision per frame/tile with fades; Mapbox's cross-tile ID design is the reference.

### Cited Findings
- Mapbox GL ranks by importance (layer order, `symbol-sort-key`) and runs collision at each zoom/view, with cross-tile symbol IDs to keep placement stable and fade opacity. — [Collision Detection wiki](https://github.com/mapbox/mapbox-gl-native/wiki/Collision-Detection), [Optimize label placement](https://docs.mapbox.com/help/dive-deeper/optimize-map-label-placement/)
- Maplex feature weights (0-1000) rank obstacles; deck.gl `getCollisionPriority` (-1000..1000) ranks labels. — [Esri](https://pro.arcgis.com/en/pro-app/3.5/help/mapping/text/label-with-the-maplex-label-engine.htm), [deck.gl](https://deck.gl/docs/api-reference/extensions/collision-filter-extension)

### Inferences
- Priority score suggestion: class rank dominates, then elevation/prominence, then population/size; make it stable between frames (hysteresis: a placed label keeps priority bonus) to avoid flicker.

### Gaps
- No sourced academic treatment of multi-scale label consistency (e.g. scale-aware consistent labelling; one Nottingham record appeared in search but was not read).
