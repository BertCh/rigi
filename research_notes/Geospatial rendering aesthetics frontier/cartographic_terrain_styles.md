# Cartographic terrain styles and relief aesthetics (2023–2026), for a real-time DEM renderer

Scope: style and art direction for terrain, not the physics. The earlier note `research_notes/rendering_aesthetics_sota.md` already covers these topics, and they are not repeated here:
- haze and aerial perspective;
- Lambert and photo-light sun;
- swisstopo 6-direction multidirectional hillshade weights;
- the sky-view factor (SVF) and horizon-map recipe;
- a basic Tanaka GLSL snippet;
- OKLab LUT tints;
- the screen-space ink-line pass;
- a basic Berann vertex bend.

Research was done on 2026-09-30 with about 30 search and fetch calls. Coverage is uneven. Several named artists (Helen McKenzie, Owen Powell, Kenneth Field) returned no usable primary sources and are listed under Gaps.

## 1. State of the art in shaded relief (Swiss/Imhof, neural, texture shading, multi-directional, raytraced, plan-oblique)

### Takeaway
- **Neural Swiss-style shading (Eduard) is now an established production tool.** Its developers are Monash and ETH; the user guide is at v1.4 in 2025. Its academic follow-ups in 2024–2026 move toward scale/resolution adaptation and terrain-type segmentation, not new styles.
- **The practical web frontier is multidirectional hillshading and colour-relief layers as built-ins of MapLibre and MapTiler (2025–2026).**
- Texture shading (a fractional Laplacian) remains the main non-lighting "structure" layer.
- Raytraced (Blender/rayshader) relief is the dominant "look" in popular cartography. It is hard on slippy maps because shadows cross tile boundaries.

### Cited Findings

**Eduard and neural Swiss-style shading**
- Eduard creates shaded relief with machine learning to match Swiss manual shading. It follows these principles:
  - removes unnecessary detail;
  - locally adjusts the illumination direction;
  - accentuates high peaks with aerial perspective;
  - emphasises large landforms.

  It is a macOS app. — [Apple App Store: Eduard – Relief Shading](https://apps.apple.com/us/app/eduard-relief-shading/id6443577400?mt=12); [Gigazine 2023-03](https://gigazine.net/gsc_news/en/20230304-eduard/); [ETH research collection: "Eduard: beautiful relief shading with neural networks"](https://www.research-collection.ethz.ch/items/285f6c19-7fb4-4741-a8cc-ba6074c04afb)
- The underlying method is Jenny, Heitzler, Singh, Farmakis-Serebryakova, Liu & Hurni (2021), "Cartographic relief shading with neural networks", IEEE TVCG 27(2):1225–1235 (a U-Net trained on Swiss manual shadings). The Eduard 1.4 User Guide (2025) is credited to Monash University and ETH Zurich. Eduard exposes these controls:
  - terrain-type settings;
  - generalisation;
  - aerial perspective.

  — [Stefanakis, EuroCarto 2026 abstract, ica-abs-12-135-2026](https://ica-abs.copernicus.org/articles/12/135/2026/ica-abs-12-135-2026.pdf)
- Stefanakis (EuroCarto 2026, Brno) evaluates Eduard across six 50×50 km Alberta sites (10 m and 100 m DEMs) at 1:50k, 1:250k and 1:500k.
  - He argues that in strongly NW–SE-aligned ranges (Banff), NW light runs parallel to the terrain grain and reduces contrast.
  - Southern-sector illumination may give stronger cross-slope variation and a "more naturalistic" alpine look.
  - He frames the future as hybrid analytical plus neural.
  - He cites Biland & Çöltekin 2017 ("NNW is better than NW") and Morgenstern et al. 2011 (the light-from-above prior is weak).

  — [ica-abs-12-135-2026](https://ica-abs.copernicus.org/articles/12/135/2026/ica-abs-12-135-2026.pdf)
- Farmakis-Serebryakova & Hurni (ICC 2025, Vancouver), a PhD summary:
  - An online survey compared six analytical shading methods across nine Swiss landforms.
  - **The "clear sky model" performed best for most mountain and valley landforms.**
  - Cluster shading worked best for hilly regions.
  - **Texture shading and MDOW (multidirectional oblique-weighted) "often overemphasize detail, reducing readability".**
  - U-Net terrain segmentation is used to pick a shading technique per landform.
  - The project also covers scale- and resolution-adapted neural shading.

  — [ica-abs-10-73-2025](https://ica-abs.copernicus.org/articles/10/73/2025/ica-abs-10-73-2025.pdf)
- Related paper: "Scale- and Resolution-Adapted Shaded Relief Generation Using U-Net", IJGI 13(9):326, September 2024. — [MDPI PDF](https://mdpi-res.com/d_attachment/ijgi/ijgi-13-00326/article_deploy/ijgi-13-00326.pdf); [DOAJ](https://doaj.org/article/a922c29f6c154107a57f5c22439e5997)

**Texture shading (Leland Brown)**
- Texture shading is not a lighting model. It applies a fractional Laplacian to the DEM.
  - It is isotropic and scale-invariant in a particular sense.
  - It highlights the ridge and canyon network and gives a clear visual hierarchy.
  - It is meant to be merged with conventional shaded relief.

  — [Leland Brown, Texture Shading (SIPG mirror)](https://sipg.isr.tecnico.ulisboa.pt/texture-shading/); [shadedrelief.com Terrain Texture Shader](https://www.shadedrelief.com/texture_shading/)
- Parameters:
  - The filter is |f|^α in the frequency domain.
  - α=0 gives no detail.
  - α=2 is the full Laplacian, "probably too high".
  - α ≤ 1 is "aesthetically pleasing", and 0.8 is used in the examples.
  - Post-process by clamping to the 1st–99th percentile.
  - A spatial FIR approximation (an nDiameter² kernel) with overlap-save enables tiled processing.

  — [fasiha/texshade-py](https://github.com/fasiha/texshade-py); [fasiha/texshade](https://github.com/fasiha/texshade)
- xDEM ships `DEM.texture_shading(alpha=0.8)`, adapted from texshade-py. It cites Brown 2010 (Mountain Cartography Workshop, Banff) and Allmendinger & Karabinos 2023 (doi:10.1130/GES02531.1). — [xdem docs](https://xdem.readthedocs.io/en/latest/gen_modules/xdem.DEM.texture_shading.html)
- GMT.jl exposes it as `lelandshade`. — [GMT.jl lelandshade](https://www.generic-mapping-tools.org/GMTjl_doc/documentation/utilities/lelandshade)

**Multidirectional hillshade and colour relief on the web**
- MapLibre hillshade layers now support these algorithms:
  - `standard`;
  - `basic`;
  - `combined`;
  - `igor`, after GDAL `-igor`, which minimises the effect on features beneath;
  - `multidirectional`, which uses multiple light directions in multiple colours, with array-valued `hillshade-illumination-direction`, `-altitude`, and `-highlight-color` / `-shadow-color`.

  — [MapLibre example: multidirectional hillshade](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-multidirectional-hillshade-layer/); [MapLibre Native hillshade-method](https://maplibre.org/maplibre-native/android/api/-map-libre%20-native%20-android/org.maplibre.android.style.layers/-property-factory/hillshade-method.html); [MapTiler HillshadeLayerSpecification](https://docs.maptiler.com/sdk-js/api-reference/types/HillshadeLayerSpecification/)
- MapTiler (February 2026) productised this:
  - 4 coloured shades combined into one layer;
  - a colour-relief layer with 9 preset ramps (temperate, ice and desert variants, 5 ocean ramps, dark-mode variants, plus custom ramps).

  — [MapTiler news 2026-02](https://www.maptiler.com/news/2026/02/multidirectional-hillshades-and-terrain-color-ramps-for-web-maps/)

**Raytraced and Blender relief**
- Stamen (Alan McConchie, September 2022) charts the history:
  - The raytraced-shadow relief wave traces back to Daniel Huffman's 2017 Blender tutorial and Lee Griggs (2014).
  - Practitioners include Scott Reinhard, Alasdair Rae, Frank Ramspott, 4DMapArt, VizCart and @researchremora (rayshader); Aerialod is another tool.
  - **Key web constraint: cast shadows "spill out" across tile boundaries, so dynamic, zoom-aware raytraced shadows don't fit the isolated-tile slippy-map model. Pre-rendered shadow overlays are the workaround.**

  — [Stamen: Shadows on maps are getting a lot more exciting](https://stamen.com/shadows-on-maps-are-getting-a-lot-more-exciting-and-heres-why/)
- Scott Reinhard drapes vintage USGS maps on a Blender-displaced DEM with oblique lighting. Vertical exaggeration is the key aesthetic dial. — [GeoExPro "Vintage maps reborn"](https://geoexpro.com/vintage-maps-reborn/); [Engadget 2019](https://www.engadget.com/2019-02-10-the-big-picture-3d-us-geological-survey-maps.html)
- Sean Conway does the same "vintage map plus relief" genre. He georeferences public-domain scans to modern elevation, using ArcGIS Pro per the article. — [My Modern Met](https://mymodernmet.com/sean-conway-vintage-relief-maps/)
- rayshader v0.38.6 was released on 2024-12-23. It includes built-in hillshade textures, a path tracer and water detection. — [r-universe rayshader](https://ar-puuk.r-universe.dev/rayshader/citation.cff)
- CRAN `hillshader` does raytraced hillshades. — [CRAN hillshader](https://cran.r-project.org/web/packages/hillshader/index.html)
- GMT.jl has a "Shading with Blender" raytracing tutorial. — [GMT.jl Blender shading](https://www.generic-mapping-tools.org/GMTjl_doc/tutorials/blender_shading/blender_rt.html)

**Seasonal relief**
- Andy Woodruff (2018) made seasonal relief:
  - Blender relief with the same sun for spring, summer and autumn.
  - A lower, weaker sun for winter, with blue shadows and warmer highlights.
  - Per-season colour grades, with masks driven by elevation and by the shaded relief itself.
  - Autumn uses a "splotchy" multi-hue texture.

  — [andywoodruff.com/blog/seasonal-relief](https://andywoodruff.com/blog/seasonal-relief/)

**Plan-oblique relief**
- Jenny & Patterson (Cartographic Perspectives 57) shift pixels "up" in proportion to elevation. Relief appears to stand up while planimetry is preserved. — [CP57 Introducing Plan Oblique Relief](https://cartographicperspectives.org/index.php/journal/article/view/cp57-jenny-patterson)
- Jenny & Šavrič built a server-side renderer that turns tiled terrain plus 2D tiles into plan-oblique tiles for standard web maps. — [AutoCarto 2014 abstract](https://cartogis.org/docs/proceedings/2014/Jenny_etal_AutoCarto2014%20Abstract.pdf)

**Generalised shading (Hormann/imagico)**
- Christoph Hormann (imagico, 2015) generalises shaded relief using the shading and the 3D geometry jointly. This stops side valleys bleeding across main valleys. He also renders custom hachures and says they suit high-resolution print, not low-resolution screens. — [imagico.de blog p=4146](https://imagico.de/blog/?p=4146)

### Inferences

**Cheap Eduard-like look.** In a browser:
- multiscale normals (coarse mip weighted high, fine mip about 30 %, as in the prior note);
- elevation-dependent contrast;
- a texture-shading layer blended at low weight.

Note that the ETH survey suggests texture shading and MDOW over-detail mountains, so keep α ≈ 0.5–0.8 and blend weight ≤ 0.3.

**Texture shading on the GPU.** It is cheap enough to precompute per DEM tile, with a 2-px+ apron to avoid seams:
- WebGPU: 2D FFT compute on 512² tiles.
- WebGL2: an FIR kernel of about 31² in a fragment pass.

**Neural Eduard output.** It cannot run in-browser from public artefacts (no public weights found). The realistic paths are:
- pre-baked raster tiles, licence permitting;
- training a small U-Net distillation, which is a research project.

**Dynamic relief light for a photo-matched app.** The Stefanakis finding (NW light vs. terrain grain) argues for exposing light azimuth as an art-direction control, distinct from the physical sun. Default it to NNW per Biland & Çöltekin, or auto-pick the azimuth that maximises cross-slope contrast against the dominant aspect histogram.

**Raytraced shadow look.** Our app renders a single continuous terrain view, not isolated tiles, so the Stamen tile-boundary problem largely doesn't apply. The "Blender look" is reproducible in real time as:
- horizon-map cast shadows;
- plus SVF as ambient term;
- plus soft-shadow penumbra by sampling the horizon angle with a sun disc of about 0.5–2° (artistically widened).

### Gaps
- No public Eduard model weights or API spec were found, so the licensing for baked tiles is unknown.
- I did not verify the exact MapLibre version that shipped `hillshade-method` / multidirectional, nor its `color-relief` layer spec.
- I found no primary 2023–2026 sources for Helen McKenzie, Owen Powell or Kenneth Field relief work. The search for "Helen McKenzie Blender" returned an unrelated 1888–1966 painter.
- Tom Patterson's 2023–2026 output: search only surfaced talks (the Library of Congress "From Airbrush to AI", 2024 Blue Earth Bathymetry) and no new technique documents.
- "Resolution bumping" (Patterson) has only an archive page ([maphew archive](https://maphew-archive.nfshost.com/Projects/resolution-bumping-shaded-relief)), which was not fetched.

## 2. Painterly, NPR and illustrative terrain (Berann panoramas, hachures, ridgelines, Tanaka, watercolour, ink, print styles)

### Takeaway
- **The best-documented real-time painterly terrain system is still Brown, Samavati & Sousa, "Real-Time Panorama Maps" (NPAR/Expressive 2017).** Its key insight is **per-terrain-class lit/shade palettes using complementary hues instead of a lighting model**, plus quadratic terrain curving and evenly spaced brush-stroke particles.
- Automatic hachures are an active research topic (2024–2026 rock "ladder style", using LIC-generalised DEMs) but still mostly offline/GIS.
- Ridgeline "Unknown Pleasures" plots exist in open-source web form (peak-map).

### Cited Findings

**Berann real-time panorama (Brown et al. 2017)**
- What is reproduced:
  - terrain deformation;
  - distorted projection;
  - terrain colouring;
  - tree brush strokes;
  - water rendering;
  - atmospheric scattering;
  - built on freely available DEM, imagery and land-cover data.

  — [Brown et al., Real-Time Panorama Maps, Expressive/NPAR 2017 (PDF)](https://giv.cpsc.ucalgary.ca/pdf/rtpanoramamaps-expressive2017-brown.pdf); [EG digital library](https://diglib.eg.org:443/handle/10.2312/npar2017a06); [thesis, U Calgary PRISM](https://prism.ucalgary.ca/handle/11023/3627)
- **Deformation:**
  - The flat terrain base is bent along a quadratic curve toward the horizon, with distances D1 (curve start) and D2 (horizon).
  - A slight horizon curvature uses a cosine factor on horizontal lines.
  - Vertical exaggeration is view-dependent: smaller scenes get more exaggeration (after Patterson).
  - Selective landmark exaggeration is used.

  — [Brown et al. 2017](https://giv.cpsc.ucalgary.ca/pdf/rtpanoramamaps-expressive2017-brown.pdf)
- **Colour:**
  - Berann does not use a standard lighting model. Brown mountains in light become blue in shade, and green trees become violet: complementary or split-complementary harmonisation (citing Cohen-Or et al. 2006).
  - The implementation uses continuous cel-shading palette textures for 6 classes: field, hill, cliff, snow, forest base and trees.
  - In each palette the top is fully lit, the middle unlit, and **negative n·l is used to index further into the shade colours**.
  - Palettes were built by sampling colours from Berann's Yellowstone painting and pairing each sample with the light-map value at the same location.
  - Classes come from land cover (trees, water) plus a slope threshold for cliffs.
  - The bottom 20–25 % of the frame is progressively darkened, as in Berann's paintings.

  — [Brown et al. 2017](https://giv.cpsc.ucalgary.ca/pdf/rtpanoramamaps-expressive2017-brown.pdf)
- **Brush strokes and atmosphere:**
  - Trees are view-aligned particles expanded in a geometry shader, masked by a rounded-stroke texture.
  - A level-of-detail scheme keeps stroke spacing even across zoom.
  - Atmosphere is a non-linear distance blend toward a sampled sky colour that **shifts hue but preserves value contrast**, so distant peaks stay legible: Berann's map-first haze, unlike physical haze.
  - Performance: 1621² DEM, 5.25 M triangles, about 715 k tree particles, 23 fps on a 2015 laptop (GLSL 4.2).

  — [Brown et al. 2017](https://giv.cpsc.ucalgary.ca/pdf/rtpanoramamaps-expressive2017-brown.pdf)
- **Jenny's foundations** for panorama geometry:
  - "Progressive projection": the foreground reads as a map and the background as perspective.
  - Local terrain deformation to fix occlusion and foreshortening as panorama painters did.

  — [Jenny et al. 2010 Progressive Projection (PDF)](https://mail.colororacle.org/berniejenny/pdf/2010_Jenny_etal_ProgressiveProjection.pdf); [Jenny et al. 2011 Local Terrain Deformation (PDF)](https://mail.colororacle.org/berniejenny/pdf/2011_Jenny_etal_Local_Terrain_Deformation.pdf)

**Hachures**
- Kyncl & Lysák (EuroCarto 2024, Vienna) automate "ladder-style" rock hachures for the Czech state map:
  - The DEM is generalised with **Line Integral Convolution (LIC)**, which preserves edges (after Geisthövel & Hurni 2018).
  - Vertical hachures follow the steepest gradient of the generalised DEM, seeded from the highest unprocessed pixel.
  - Terrain skeleton lines come from the generalised DTM.

  — [ica-abs-7-81-2024](https://ica-abs.copernicus.org/articles/7/81/2024/ica-abs-7-81-2024.pdf)
- The 2026 follow-up extends this to multiscale, with scale-dependent LIC parameters and parameterised skeleton-line extraction. — [ica-abs-12-71-2026](https://ica-abs.copernicus.org/articles/12/71/2026/ica-abs-12-71-2026.pdf)
- **Swiss-style rock hachuring:** evenly spaced lines perpendicular to the gradient, with vertices perturbed for a wiggly hand look (Gilgen & Jenny 2010 lineage). — [Lysák 2016, AUC Geographica](https://karolinum.cz/data/clanek/2821/Geogr_2016.1_Lysak_final.pdf)
- **Flowline hachures and "slope and aspect hachuring"** encode slope, aspect and flow direction at once. — [Morphometric mapping by flowline hachures (istina)](https://istina.ipmnet.ru/publications/article/5853946)
- **GIS-based slope-line hachures** start one line per raster cell from the DEM, with Gaussian pre-smoothing. — [Magyari 2017, Geographia Technica](https://mail.technicalgeography.org/pdf/1_2017/08_magyari.pdf); [Automatic generation of hachure lines](https://www.academia.edu/32288968/AUTOMATIC_GENERATION_OF_HACHURE_LINES)
- **Esri hachures:**
  - "Generate Hachures for Defined Slopes" tool;
  - John Nelson's ArcGIS Pro hachure and "Eduard Imhof Topography" styles, where the hachure is a rotated line-marker on contours;
  - an attribute-driven hachure workflow (2023).

  — [Esri GP tool](https://pro.arcgis.com/en/pro-app/latest/tool-reference/cartography/generate-hachures-for-defined-slopes.htm); [Esri "Mapping with Style"](https://www.esri.com/about/newsroom/arcwatch/map-with-style/); [Esri "Steal this hachure style"](https://www.esri.com/arcgis-blog/products/arcgis-pro/mapping/steal-this-hachure-style-for-pro-please); [ECCE attribute-driven hachures 2023](https://ecce.esri.ca/blog/dal-blog/2023/06/30/attribute-driven-hachure-lines/)
- **Kennelly's horizontal hachures:** closely spaced contours are iteratively buffered, clipped and selected to match hillshade tone. — [Penn State Pure: Complexities of designing terrain maps illustrated with horizontal hachures](https://pure.psu.edu/en/publications/complexities-of-designing-terrain-maps-illustrated-with-horizonta/fingerprints/)

**Tanaka contours**
- White lines on the NW (lit) side and black on the SE side, with width ∝ alignment to light. — [R `tanaka` package (riatelab)](https://cran.rstudio.com/web/packages/tanaka/index.html); [Golden Software Surfer note](https://support.goldensoftware.com/hc/en-us/articles/115004907034-Create-Tanaka-style-Illuminated-Contour-Maps-in-Surfer)

**Ridgeline plots**
- **anvaka/peak-map** draws filled-area ridgeline ("Unknown Pleasures") elevation plots. It takes Mapbox elevation for any region and renders on a 2D canvas overlay. It is open source. — [peak-map (fork listing)](https://github.com/sunjaxx/peak-map); original repo anvaka/peak-map
- Wolfram has a `RidgeLineMap` function. — [Wolfram RidgeLineMap](https://resources.wolframcloud.com/FunctionRepository/resources/RidgeLineMap/)

**Watercolour**
- Tangram (Mapzen) demonstrated GLSL-styled real-time maps including watercolour-like styles. — [Tangram talk (Vimeo)](https://vimeo.com/112300852)

### Inferences

These are design proposals based on the cited techniques, not sourced implementations.

**"Berann" style mode (orbit and Studio views).** Port Brown's palette approach almost directly:
- a 6×256 palette texture indexed by `u = class`, `v = 0.5 + 0.5·(n·l)`, using the signed value so the shade side gets complementary hues;
- a hue-shifting, value-preserving haze, `oklch(L_terrain, C·k, h → h_sky)`;
- bottom-of-frame darkening.

Classes for the Alps can be computed from DEM-only signals when land cover is unavailable:
- slope > ~40° → cliff;
- elevation above the snowline with low slope → snow;
- elevation below the treeline → forest;
- otherwise meadow or rock.

The quadratic bend breaks photo registration, so keep it out of the photo-overlay path (as the prior note says).

**Hachures in real time.** A GPU-friendly approximation is a fragment shader that draws strokes in a **flow-aligned coordinate frame**:
- integrate a "stream function" by LIC of noise along the gradient field (the same LIC the Czech papers use for generalisation);
- threshold it into lines whose density and width ∝ slope;
- hachure spacing = f(slope), stroke darkness = f(1 − n·l).

Proper vector hachures (evenly spaced streamlines, Jobard–Lefer) are better done per tile in a worker and drawn as deck.gl PathLayer.

**Ridgeline joy plots.** They are trivially done in a shader by sampling the DEM along horizontal scanlines in screen space. Better is a deck.gl PathLayer of N east–west profiles offset in y by `k·h`, with occlusion by filling each polygon with the background colour.

**Print-like styles** can all be done as post passes on our shaded-luminance buffer:
- risograph/halftone: a rotated-grid dot screen per ink channel, dot radius ∝ ink density;
- dithering: Bayer or blue-noise threshold;
- etching: line screens at angles keyed to aspect;
- woodblock: posterised 3–5 tone bands plus outline ink plus paper texture.

**Watercolour.** The standard NPR recipe is:
- edge darkening (a gradient of the colour-band mask);
- pigment granulation (high-frequency noise × (1 − luminance));
- paper texture multiply;
- wobble/turbulence displacement of the colour-band boundaries.

### Gaps
- I found no 2023–2026 peer-reviewed real-time Berann work newer than Brown 2017.
- I found no browser implementation of automatic hachures, Tanaka in GLSL, watercolour terrain, risograph/halftone, woodblock or ink-etching terrain with a citable source. These searches returned only generic three.js or GIS results. The shader recipes above are therefore unsourced engineering proposals.
- Jenny/Kennelly "automatic hachures" as a named 2023–2024 paper was not found. Search surfaced only the Czech ladder-style work and Kennelly's earlier horizontal-hachure paper.
- Isometric/low-poly terrain styles and 30DayMapChallenge highlights were not substantively covered. One result: a 2025 Day-29 raster map of Gran Sasso ([bookdown](https://bookdown.org/fede_gazzelloni/UPDVwR/content/mapchallenge/cases2025/posts2025/day29_raster/day29_raster.html)).

## 3. Colour (hypsometric tints, perceptual palettes, class-based colouring, seasonal and golden-hour looks)

### Takeaway
- Colour art direction in 2023–2026 web cartography is converging on **preset colour-relief ramps** (MapTiler's 9 presets including dark-mode variants) plus Patterson/Jenny cross-blended tints.
- For painterly looks the strongest documented principle is **class-specific lit/shade palettes with complementary shadow hues** (Berann via Brown 2017).
- **Seasonal looks** are done with elevation-and-shade-masked grades (Woodruff).

### Cited Findings
- **Cross-blended hypsometric tints** (Patterson & Jenny): tint ramps vary with climate zone (humid, arid, polar). — [shadedrelief.com hypso](https://www.shadedrelief.com/hypso/hypso.html); [Cartographic Perspectives 69](https://cartographicperspectives.org/index.php/journal/article/view/cp69-patterson-jenny) (both also cited in the prior note)
- **MapTiler colour relief (2026):** 9 presets covering temperate, ice and desert land ramps, 5 ocean/seafloor ramps and dark-mode variants, plus custom ramps. — [MapTiler 2026-02](https://www.maptiler.com/news/2026/02/multidirectional-hillshades-and-terrain-color-ramps-for-web-maps/)
- **MapLibre multidirectional hillshade** lets each light carry its own highlight and shadow colour. This enables coloured-light relief, for example warm key and cool fill. — [MapLibre example](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-multidirectional-hillshade-layer/)
- **Berann palettes** for 6 classes (field, hill, cliff, snow, forest base, trees), with shade hues on the complementary or split-complementary side: brown → blue, green → violet. — [Brown et al. 2017](https://giv.cpsc.ucalgary.ca/pdf/rtpanoramamaps-expressive2017-brown.pdf)
- **Seasonal relief:**
  - winter = low, weak sun, blue shadows, warm highlights, snow by elevation;
  - summer = warmer, yellowed greens;
  - spring = cooler, brighter lowlands;
  - autumn = splotchy multi-hue texture.

  — [Woodruff 2018](https://andywoodruff.com/blog/seasonal-relief/)
- **Glaciers:** the ETH survey found glaciers need a specific shading treatment. The text was truncated: "Glaciers are best depicted using…". — [ica-abs-10-73-2025](https://ica-abs.copernicus.org/articles/10/73/2025/ica-abs-10-73-2025.pdf)

### Inferences
- **Class and colour model** for an Alpine photo-matched app: a small "material classifier" in the fragment shader drives a palette LUT, so every style (Swiss, Berann, seasonal, golden hour) is just a different palette texture plus light settings. Inputs:
  - elevation vs. treeline and snowline uniforms;
  - slope (cliff > ~40°, snow-hold < ~35–40°);
  - aspect: raise the snowline on S aspects by about 100–300 m;
  - curvature (snow in concavities).
- **Golden-hour look:**
  - warm key (sun colour from the existing Rayleigh transmittance);
  - complementary cool shade;
  - Berann's value-preserving haze instead of physical haze, for legibility.
- **Ramp interpolation:** build all ramps in OKLCH/OKLab (as the prior note recommends) and allow chroma-limited dark-mode variants, mirroring MapTiler's dark presets.

### Gaps
- I found no sourced 2023–2026 work on OKLCH-specific terrain palettes, nor primary sources for "golden hour" terrain palettes. These are proposals.
- Snow/rock/vegetation classification thresholds from slope, aspect and elevation were not found in a primary source during this pass. The numbers above are engineering defaults to be tuned against our photo set.

## 4. Real-time GPU availability (what already runs in browsers; math and parameters for porting)

### Takeaway
- Out-of-the-box in browsers today: multidirectional and Igor hillshade plus colour relief (MapLibre/MapTiler), and the cel-palette and brush-particle Berann techniques (documented with enough detail to port).
- Everything else (texture shading, neural Swiss, hachures, raytraced soft shadows) is offline in the sources found. It is portable to WebGL2/WebGPU with modest effort except the neural model.

### Cited Findings
- **MapLibre hillshade methods** `standard | basic | combined | igor | multidirectional` run in WebGL. Multidirectional takes arrays of direction, altitude and colour. — [MapLibre example](https://maplibre.org/maplibre-gl-js/docs/examples/add-a-multidirectional-hillshade-layer/); [MapTiler hillshading guide](https://docs.maptiler.com/guides/map-design/terrain/hillshading/)
- **Berann renderer: complete real-time recipe at 23 fps on 2015 hardware:**
  - quadratic bend;
  - cosine horizon curve;
  - view-dependent exaggeration;
  - cel palettes indexed by signed n·l;
  - geometry-shader stroke particles with zoom LOD;
  - hue-preserving haze.

  — [Brown et al. 2017](https://giv.cpsc.ucalgary.ca/pdf/rtpanoramamaps-expressive2017-brown.pdf)
- **Texture shading:** filter |f|^α, α≈0.8, 1–99 % clamp, and an FIR approximation for tiling. — [texshade-py](https://github.com/fasiha/texshade-py)
- **Raytraced shadows** conflict with tiled slippy maps. Pre-rendered overlays are the workaround. — [Stamen 2022](https://stamen.com/shadows-on-maps-are-getting-a-lot-more-exciting-and-heres-why/)
- **Ridgeline maps:** run in-browser on canvas 2D (peak-map). — [peak-map](https://github.com/sunjaxx/peak-map)

### Inferences

**Porting priority for Rigi.** The cost estimates below are judgements, not sourced figures; the "prior note" mentioned is the earlier `rendering_aesthetics_sota.md`.
- (1) A palette-texture material system with signed-n·l indexing: Berann/cel, seasonal and golden-hour presets in one mechanism. About 1 day.
- (2) Texture-shading tile precompute (WebGPU FFT, or a WebGL2 FIR fallback), blended ≤ 0.3. About 1 day.
- (3) Expose MapLibre-style multidirectional coloured lights as a uniform array (4 lights). About half a day.
- (4) Print post-FX (halftone, dither, posterise and ink): a single fragment pass over the existing luminance and normal buffers. About 1 day.
- (5) LIC-based hachure shader. About 2–3 days, experimental.
- (6) Ridgeline mode via deck.gl PathLayer. About half a day.

**Neural Swiss shading** is the only item not realistically real-time without our own trained model. Treat it as a baked-tile option.

**One general caveat.** All photo-matched views must keep geometry undistorted. Berann bend and plan-oblique belong only to orbit, Studio and landing views.

### Gaps
- I found no Shadertoy or Observable implementations with citable URLs for hachures, Tanaka, watercolour or halftone terrain. The search returned only generic DEM notebooks: [observablehq d/638b04f52ce826a3](https://observablehq.com/d/638b04f52ce826a3) and [d/1823b803fa002866](https://observablehq.com/d/1823b803fa002866), which were not inspected.
- I did not check deck.gl/luma.gl-specific stylised terrain examples.
- I did not obtain WebGPU performance numbers for FFT texture shading.
