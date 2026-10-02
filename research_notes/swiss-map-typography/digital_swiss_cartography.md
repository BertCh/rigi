# Contemporary (2010-2026) Swiss and Swiss-influenced digital cartography: typography, relief, rock, colour

Method note: I fetched swisstopo's published style JSON and tilejson directly on 2026-10-02 (items marked "primary, fetched"). Everything else comes from web search/fetch of abstracts and papers. Search snippets are noted where a page could not be read in full. Claims I could not source are in Gaps.

## 1. Research: ETH IKG (Hurni), Oregon State/RMIT (Jenny): Eduard, rock drawing, plan oblique, colour, Atlas of Switzerland, 3D labelling

### Takeaway
The research line is strong on relief shading (Eduard, U-Net) and rock-drawing theory, and swisstopo officially plans to replace manual terrain depiction with AI-derived layers. Automated rock hachures have not been solved (a 2018-ish OST thesis failed with pix2pix). I found no dedicated publication on type placement in 3D atlases; the Atlas of Switzerland has "3D object labelling" but only as a feature mention.

### Cited Findings
- Eduard / "Cartographic Relief Shading with Neural Networks" (Jenny, Heitzler, Singh, Farmakis-Serebryakova, Liu, Hurni; IEEE TVCG vol 27 issue 2, Feb 2021, pp 1225-1235): U-Nets trained on swisstopo manual shaded reliefs plus matching DEMs. The networks learn removal of unneeded detail, locally adjusted illumination direction, brighter large landforms, aerial-perspective accentuation of high peaks. — [ETH Research Collection](https://www.research-collection.ethz.ch/items/0fdf1a68-f911-4ff4-a54f-305bf3362026); [arXiv 2010.01256](https://www.arxiv.org/abs/2010.01256); TVCG citation in [ICC 2023 swisstopo abstract](https://ica-abs.copernicus.org/articles/6/274/2023/ica-abs-6-274-2023.pdf)
- Eduard is the app that wraps this: Mac-only, initially on the Mac App Store, launch price reported as USD 69.99 (secondary source, from a search summary; price/platform may have changed). Controls: illumination direction, aerial perspective, detail. Described as commercial, developed with Monash and ETH. — search summaries of [Gigazine](https://gigazine.net/news/20230304-eduard) and [Tom Patterson's site/Wikipedia-type results](https://www.shadedrelief.com/bio.html); not verified against the vendor page
- 2025-26 uptake: Stefanakis (Calgary) evaluates Eduard neural hillshading for Alberta/Banff, noting the NW-illumination convention (Biland and Coltekin 2017) and arguing southern illumination can improve cross-slope tone in aligned ranges. — [CaGIS 2026 abstract](https://cartogis.org/docs/conferences/CaGIS_2026/abstracts/research/Stefanakis_research_abstract_CaGIS_2026.pdf) and [ICA abstract 12-135-2026](https://ica-abs.copernicus.org/articles/12/135/2026/ica-abs-12-135-2026.pdf)
- Farmakis-Serebryakova and Hurni (ETH IKG, ICA abstract 2025): doctoral project on multi-scale neural relief shading using U-Net terrain segmentation, to pick shading technique per landform and generate shading at arbitrary scale/resolution from limited manual data; mentions Lambertian, multidirectional oblique-weighted (MDOW) shading and aerial perspective. — [ica-abs 10-73-2025 PDF](https://ica-abs.copernicus.org/articles/10/73/2025/ica-abs-10-73-2025.pdf)
- swisstopo's own roadmap (ICC 2023, Wigley, Pippig, Forte, Denier, Geisthovel): the "NextGenerationMap" vector-tile map "deliberately abandons previous principles of the classic national map in favour of performance and legibility"; terrain representation is transferred to vector form; manual terrain creation is to be eliminated and derived by AI, with hill-shading pilots using U-Nets and expectation that this extends to rock depictions, enabling "worldwide Swiss-style terrain representation". — [ica-abs 6-274-2023](https://ica-abs.copernicus.org/articles/6/274/2023/ica-abs-6-274-2023.pdf)
- Rock drawing theory: Jenny, Gilgen, Geisthovel, Marston, Hurni, "Design Principles for Swiss-style Rock Drawing", The Cartographic Journal 51(4), 360-371, 2014. Key facts: hachures are all black, with width/density modulated for shading; ground-view perspective; three defining characteristics (continuous 3D terrain illustration, ground-view perspective, characterisation of rock type); illumination from NW, adjusted locally, ideally one direction per massif; principles apply 1:25,000 to 1:500,000; manual scribing took about 1 hour per cm2 and about 2000 hours per mountain sheet; combination of shaded relief + yellow light tone + rock drawing + scree (Jenny et al. 2010) gives the 3D impression. — [PDF](https://mail.colororacle.org/berniejenny/pdf/2014_Jenny_etal_DesignPrinciplesForSwiss-styleRockDrawing.pdf) (text extracted locally)
- Failed ML for rock: OST (Rapperswil) bachelor thesis by Philipp Koster, "Automated Swiss-style Rock Drawing using Deep Learning", used pix2pix on DEM + rock mask + hachure pairs; result "dissatisfying", "not possible to find an effective machine learning model". Year not stated in the abstract. — [OST abstract PDF](https://www.ost.ch/fileadmin/dateiliste/97_daten/abstracts/f61cb68f-dec3-4ed7-9490-6fd587cbd138.pdf)
- Colour hypsometry/shading: Jenny and Hurni, "Swiss-Style Colour Relief Shading Modulated by Elevation and by Exposure to Illumination", Cartographic Journal 43(3), 198-207, 2006: colourizes grey shading via a look-up table of (grey value x elevation) built from interactively placed colour reference points. — [ETH Research Collection](https://www.research-collection.ethz.ch/handle/20.500.11850/1574?show=full)
- Plan oblique relief: Jenny and Patterson, "Introducing Plan Oblique Relief", Cartographic Perspectives 57; later web work: server-side renderer that shears a tiled terrain model in y and drapes 2D tiles; Esri Terrain Tools 1.1 includes a Plan Oblique tool based on Jenny's algorithms; technique traced to Xaver Imfeld, 1887 Reliefkarte der Centralschweiz. — [CP article](https://cartographicperspectives.org/index.php/journal/article/view/cp57-jenny-patterson); [Esri blog](https://www.esri.com/arcgis-blog/products/arcgis-pro/3d-gis/terrain-tools-1-1-released/)
- Atlas of Switzerland online: project lead Lorenz Hurni, manager Rene Sieber; 2-D plan maps can be viewed in 3-D; the atlas was enhanced with "3D object labelling", a query system and a smart legend; related paper "Atlas of Switzerland Goes Online and 3D - Concept, Architecture and Visualization Methods" (Sieber, Serebryakova, Schnurer, Hurni). — [ETH Research Collection](https://www.research-collection.ethz.ch/items/5773c12d-b52f-49fc-88b9-c0a89e03a55b); search summaries only for the 3D labelling statement
- Atlas web migration: Neumann et al., "Migrating the Atlas of Switzerland to the Web: A comparative analysis of 2D and 3D open-source web rendering frameworks" (ICC 2024 abstract); abstract text not retrievable by me. — [ica-abs 7-117-2024](https://ica-abs.copernicus.org/articles/7/117/2024/ica-abs-7-117-2024-relations.html)
- Andreas Neumann (AoS project manager, ETH IKG) gave a QGIS UC 2026 talk "Styling a Swiss topographic map" on Swiss Map Vector 25: hillshading, rock drawing and contours, hachures via line pattern fills that follow geometry orientation, and labelling with "selective masking to better distinguish labels from darker geometry symbols". — [talk page](https://talks.osgeo.org/qgis-uc2026/talk/P7EBXR/)

### Inferences
- The shift from manual national map to AI-derived vector terrain means the "Swiss look" is now a data layer (hillshade fills, hachure polygons, scree patterns) plus a style, not hand-lettering; any reproduction should treat type as a separate, rules-driven layer.
- Label masking over dark hachure/rock (Neumann talk) suggests Swiss digital practice for dense relief is local masks/halos rather than moving labels.

### Gaps
- No publication found on label/type placement specifically in 3D atlases or panoramas by ETH IKG; only a feature mention of "3D object labelling". The Atlas "Goes Online and 3D" paper text was not read.
- Year of Koster thesis not found. Eduard's current price, version and the Jenny 2021 journal citation form (arXiv vs TVCG) not verified on the vendor page.

## 2. swisstopo web products: style JSON, fonts, label hierarchy, colours

### Takeaway
All three swisstopo vector basemaps (Basiskarte, Light, Imagery) use only Frutiger Neue (Regular, Italic, Medium, Condensed Regular/Medium/Bold) via a self-hosted glyph endpoint, with italic for natural features, condensed for settlements/POIs, thin light halos on light maps and dark halos with light text on imagery.

### Cited Findings (all primary, fetched 2026-10-02 from vectortiles.geo.admin.ch unless stated)
- Glyph endpoint in every style: `https://vectortiles.geo.admin.ch/fonts/{fontstack}/{range}.pbf`; `Frutiger%20Neue%20Regular/0-255.pbf` returned HTTP 200 (75,601 bytes, last-modified 2021-11-24). — [basemap style](https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json)
- Styles: basemap `basemap_v1.26.0` (88 layers), `lightbasemap_v1.19.0` (66), `imagerybasemap_v1.19.0` (35). Sources: `ch.swisstopo.base.vt/v1.0.0` (maxzoom 14, OpenMapTiles-like schema) and `ch.swisstopo.relief.vt/v1.0.0`. — [light](https://vectortiles.geo.admin.ch/styles/ch.swisstopo.lightbasemap.vt/style.json), [imagery](https://vectortiles.geo.admin.ch/styles/ch.swisstopo.imagerybasemap.vt/style.json), [base tilejson](https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/tiles.json)
- Fonts used (text-font values counted across symbol layers): Basiskarte: Frutiger Neue Condensed Regular (12 layers), Italic (9), Regular, Medium, Condensed Medium; place_town_village switches Condensed Medium for towns and Condensed Regular for villages; spot_elevation uses Italic for lake elevations, Regular otherwise. Light basemap adds Condensed Bold (place_city, towns, road_number). Imagery uses Regular for peaks/spot heights/massif/park and Condensed Bold for cities, towns, countries.
- Typographic roles in Basiskarte: peaks = Frutiger Neue Italic, colour rgb(27,36,62), name plus elevation on a second line via `format` with `font-scale 0.75`, size 12-23 depending on class (alpine_peak > main_peak > peak) and zoom, letter-spacing 0.025; waterways/lakes/glaciers = Italic in blue rgb(47,134,188) with positive tracking (water points 0.05-0.1 em by size, glacier line labels 0.15-0.3, waterway 0.1); cities Condensed Medium rgb(32,32,32), size up to 61 (>=100k pop) at z18, tracking 0.029; countries uppercase, tracking 0.12, magenta-ish rgb(195,85,146); boundary labels uppercase for admin levels 2 and 4, tracking 0.2; parks Medium green rgb(70,121,39); road numbers Condensed Regular 11.
- Halo recipe on light map: colour rgba(242,242,242,0.9), blur 0.25, width interpolates 0.5 at z12 to 1.0 (peaks) or 1.25 (cities/places) at z14-16; water labels use light-blue halo rgb(210,238,255) width 0.5 and waterway halo rgba(220,241,254,0.9). Light basemap halos are rgba(242,242,242,0.6) at width 1-2. i.e. thin, near-background-coloured, semi-transparent halos rather than strong white outlines.
- Imagery basemap inverts: text near-white rgba(255,255,250/248,1) with dark halo rgba(48,48,48,1) width 1.5 (places), rgba(16,16,16,1) for boundaries (pink hsl(300,90%,84%) text), blue-tinted water labels (rgba(135,220,255)) with dark navy halo rgba(42,42,56). Light text on dark halos on photographic ground.
- Tiles carry multilingual fields: `name`, `name:de`, `name:fr`, `name:it`, `name:rm`, `name:latin` on place, mountain_peak, area_name, transportation_name; boundaries carry adm2/4/8 left/right names. The styles label with `name:latin` everywhere I inspected (not language-switched). — [base tilejson](https://vectortiles.geo.admin.ch/tiles/ch.swisstopo.base.vt/v1.0.0/tiles.json)
- Relief layers in the style (group "terrain"): `hillshade_grey` fill with a per-feature `luminosity` class (-15..) mapped to cool greys, e.g. rgb(173,188,199) at -15 to rgb(220,226,231) at -5 and up; `hillshade_yellow` fill rgb(255,235,5) at opacity 0.04 from z10 (the Swiss yellow light tone); `scree_z11..z17` pattern fills (sprites `scree_medium_1..4` chosen by `weight`) at opacity 0.25-0.35; `hachure` polygon fill, black rgb(12,12,12) for rock class 1 and blue rgb(25,133,200) otherwise (glacier cracks), opacity 0 at z9 to 0.27 at z11; contours brown rgba(180,110,13,0.35), grey for scree, 100 m lines heavier (0.75 to 3 px by zoom), drawn from z11; contour/elevation labels Frutiger Neue Italic. Hachure is rendered as pre-vectorised polygons, not stroked lines. — [basemap style](https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json)
- Light-bg colour: `background` rgb(253,253,254).
- Typeface identity: the swisstopo stack name is "Frutiger Neue"; Monotype's Neue Frutiger (2009, Frutiger with Akira Kobayashi) and Neue Frutiger World (2018, 150 languages) are commercial, and Frutiger is a Monotype trademark. Equating swisstopo's "Frutiger Neue" with Monotype's Neue Frutiger is my inference. — [Wikipedia: Frutiger](https://en.wikipedia.org/wiki/Frutiger_(typeface))
- Terms: base map and geoservice usable under swisstopo OGD terms with attribution (swisstopo, FDFA, FOEN, FOCP, SAC, Naturefriends Switzerland, opentransportdata.swiss); worldwide data restricted to the Federal Administration. — [swisstopo Base Map page](https://www.swisstopo.admin.ch/en/web-maps-base-map)
- MapTiler helped build the vector styles with "color codes, fonts, and symbols inspired by official Swiss cartography" and processed handmade relief shading, rock, scree and glacier features. — [MapTiler news 2020](https://maptiler.com/news/2020/08/swisstopo-vector-tiles-development)
- Third-party reuse: gpx.studio's map source list references font 'Frutiger Neue Condensed Regular' for swisstopo vector styles (shows others consume the glyph endpoint). — [gpx.studio commit mirror](https://code.stevenpolley.net/steven/gpx.studio/commit/4128649060a8d9308b2443e2f048838fe1f442a1)
- Light Base Map is MapLibre style spec; Relief Vector Tileset has hachure and hillshade layers. — [opendata.swiss](https://opendata.swiss/en/dataset/light-base-map-vector-tile-style)

### Inferences
- Swisstopo's label hierarchy encodes meaning in posture, not just size: italic = natural/physiographic (peaks, water, glaciers, contours), upright condensed = human/settlement, uppercase + wide tracking = administrative. This matches classic Swiss convention (assumed from Imhof tradition; not directly verified here).
- Halo is used on relief but kept faint (about 0.5-1.25 px, 90% of near-white) so that it separates type from hillshade without a visible outline; dark-ground versions use the inverse.

### Gaps
- Licence status of the Frutiger Neue glyph PBFs for third-party reuse is unverified (data is OGD; fonts are typically commercially licensed). Not found in swisstopo terms.
- Classic Landeskarte lettering (the printed map's typeface history, including the Wikipedia-snippet claim that swisstopo "recently changed typeface" to its first sans-serif) could not be confirmed; the Wikipedia page fetch had no typeface content.
- I did not capture the full hillshade luminosity ramp or the exact peak-label visibility rules by rank/zoom beyond the quoted filters (peak_rank1 minzoom 8, rank <= 1).

## 3. Other Swiss-style digital map makers and their typography

### Takeaway
Outside swisstopo, the Swiss relief look is mostly reproduced by Tom Patterson (hand-painted/digital relief and panoramas), Jenny's tools (Terrain Tools, plan oblique, Eduard) and QGIS styling; I found little citable detail on the lettering of SchweizMobil, SAC, Hallwag/Kummerly+Frey, FATMAP or Swiss Map Mobile.

### Cited Findings
- Tom Patterson (ex-US NPS Harpers Ferry Center, retired 2018) uses digital techniques to mimic Berann, Imhof, Raisz, Shelton; made manual shaded relief for Natural Earth in Photoshop with a Wacom (Jan 2015) and prototype maps with DEM-derived textures resembling Alpine rock hachures. — [shadedrelief.com bio](https://www.shadedrelief.com/bio.html); [Natural Earth manual relief](https://naturalearthdata.com/?p=4915)
- Patterson's Banff relief page exists on shadedrelief.com (Eduard-related work in 2026 literature uses Banff). — [shadedrelief.com/banff](https://shadedrelief.com/banff/)
- Berann: generally regarded as the most accomplished panoramist; 4 panoramas for US NPS before retiring in 1994; known for rotating mountains and widening valleys; Jenny's group translated such manual deformations into algorithms (Local Terrain Deformation 2011, Texture Synthesis for Panoramic Maps 2013). — [Cartographic Perspectives 36 (Patterson)](https://cartographicperspectives.org/index.php/journal/article/view/cp36-patterson); [Jenny 2011](https://mail.colororacle.org/berniejenny/pdf/2011_Jenny_etal_Local_Terrain_Deformation.pdf)
- Eduard Imhof: "Positioning Names on Maps" (1975) is widely regarded as canonical for label placement and form. — search summary of [Cartographic Perspectives cp65](https://cartographicperspectives.org/index.php/journal/article/download/cp65-youngblood/pdf/976); Imhof's "Cartographic Relief Presentation" (Esri Press reissue) — [Esri Press release coverage](https://geospatialworld.net/news/esri-press-releases-new-edition-of-cartographic-relief-presentation)
- SchweizMobil is a showcase consumer of swisstopo data. — search summary of [swisstopo](https://www.swisstopo.admin.ch/en/web-maps-swiss-map-web)

### Inferences
- Because swisstopo's vector styles and Patterson/Jenny tools carry the "look", third-party Swiss-style products mostly inherit swisstopo/Frutiger or substitute a humanist or neo-grotesque sans; no evidence found of an independent Swiss-style type canon in digital outdoor apps.

### Gaps
- Typography of SchweizMobil, SAC maps, Hallwag, Kummerly+Frey, FATMAP, Swiss Map Mobile, Berann panorama lettering and Imhof panorama lettering: no citable source found (shadedrelief.com/berann returned 403). Daniel Huffman: no Swiss-specific type work found.
- No citable open Mapbox/MapLibre "Swiss-topo-like" community style beyond swisstopo's own.

## 4. How digital tools reproduce Swiss type on relief: halos, light/dark type, multilingual, font choices

### Takeaway
Concrete, citable practice is swisstopo's: faint halos on light maps, light-on-dark halos on imagery, italic/condensed role split, multilingual attributes in the data but a single `name:latin` label field.

### Cited Findings
- See Section 2 for exact halo widths/colours, tracking and size ramps (primary, fetched).
- Neumann (ETH) uses selective masking behind labels in QGIS rather than strong halos for dense dark symbology. — [QGIS UC 2026 talk](https://talks.osgeo.org/qgis-uc2026/talk/P7EBXR/)
- Illumination convention: NW light for rock/scree/shading (Jenny et al. 2014); labels on relief are therefore normally set over mid-grey blue-ish shadows and yellow-tinted lights; swisstopo's yellow tone overlay is only 4% opacity at z10 (primary).

### Inferences
- A Swiss-like rendering for a 3D/photo overlay: upright condensed for settlements, italic for peaks and water, name+elevation two-line peak labels at 0.75 scale elevation, tracked small caps/uppercase for regions, halo about 1 px at 90% background-matched colour on light ground and dark halo + light fill on photo/imagery ground. This is a synthesis of swisstopo's style, not a published rule.

### Gaps
- No research found comparing halo vs no-halo performance on shaded relief specifically (search did not surface such a study).
- No source found on how Romansh/de/fr/it names are chosen for label (swisstopo styles use `name:latin`; resolution logic is in tiles, not visible).

## 5. Open fonts for Swiss-style maps, diacritics, licences, self-hosted SDF glyphs

### Takeaway
No open font is a metric clone of Frutiger, but humanist OFL sans (Source Sans 3, Fira Sans, Hind, Noto Sans, Open Sans, Roboto) come close; SDF PBFs can be generated with fontnik-compatible tools and must respect the font licence (OFL permits it, with reserved-name caveats).

### Cited Findings
- Source Sans 3, Hind and Fira Sans are all on Google Fonts under OFL-1.1; Source Sans 3 covers 806 languages, Fira Sans 1,023; Noto covers 800+ languages. — [Fontsource Source Sans 3](https://fontsource.org/fonts/source-sans-3/about), [Fontsource Fira Sans](https://fontsource.org/fonts/fira-sans/about), [OFL fonts list](https://openfontlicense.org/ofl-fonts/) (via search snippets)
- Frutiger-like open alternatives named by sources: Hind (about 82% similar per a font-alternatives site), Roboto, Open Sans. — [fontalternatives.com](https://fontalternatives.com/alternatives/frutiger/) (low-authority source; opinion)
- Frutiger was designed by Adrian Frutiger for Charles de Gaulle airport (1968), released by Linotype 1976; humanist sans with open apertures and high x-height. — [Wikipedia](https://en.wikipedia.org/wiki/Frutiger_(typeface))
- Font Squirrel keeps a Romansh-support filter list. — [Font Squirrel](https://www.fontsquirrel.com/fonts/list/language/romansh/250) (list contents not read)
- SDF glyph tooling: a font stack is 256 PBF files (0-255.pbf .. 65280-65535.pbf, 256 glyphs each, covering the BMP); tools: node-fontnik, build_pbf_glyphs (Rust), glyphore (`glyphore build ./fonts -o ./public/glyphs`), MapLibre Font Maker / MapTiler Server. "Generated PBF files contain data derived from the source font. Check the font's license before redistributing." — [MapLibre fonts/glyphs skill page](https://www.skills.sh/maplibre/maplibre-agent-skills/maplibre-fonts-glyphs), [build_pbf_glyphs](https://docs.rs/build_pbf_glyphs), [glyphore](https://docs.rs/glyphore), [fontnik](https://npmjs.com/package/fontnik), [MapTiler docs](https://docs.maptiler.com/guides/self-hosting/map-server/how-to-create-and-use-custom-fonts-in-maptiler-server/)
- Style must set `glyphs` to a URL pattern `.../{fontstack}/{range}.pbf` as swisstopo does (primary, Section 2).

### Inferences
- Romansh needs only standard Latin letters with grave/acute/circumflex/diaeresis/cedilla (a, e, i, o, u, c variants) used in de/fr/it, so any Latin-1 + Latin Extended-A font with these precomposed glyphs should suffice; I did not verify against a Romansh-specific list. Recommend testing a string set such as "a e i o u with grave, acute, circumflex, diaeresis; c-cedilla; oe ligature" in the target PBFs.
- For a condensed/italic role split like swisstopo's, Source Sans 3 (has Light to Black plus italics; no true condensed) or Fira Sans (ships Condensed, plus italics, per Google Fonts) are the most straightforward OFL matches; Noto Sans has a Condensed width axis. Width/axis availability is from my knowledge and not verified in this session.
- OFL reserved font names may force a rename when modified/derivative PBFs are shipped; check each family's "Reserved Font Name" clause before publishing (not verified per font).

### Gaps
- Per-font Romansh glyph coverage and exact OFL reserved-name clauses not checked.
- Whether swisstopo's glyph endpoint allows hot-linking/CORS or reuse of the Frutiger PBFs is unverified; do not assume it is permitted.
- deck.gl-specific guidance (TextLayer uses bitmap/SDF font atlas via `fontSettings`, not PBF) was not researched in this pass; the PBF route is MapLibre-specific.
