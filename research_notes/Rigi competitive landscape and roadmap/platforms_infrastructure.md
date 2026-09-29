# Big-platform and infrastructure players overlapping with Rigi (ground photo to 3D terrain alignment), as of Sept 2026

Scope note: this covers large platforms and infrastructure (VPS, 3D maps, terrain data, depth/3D models, AI geolocation, licensing). Consumer peak-ID apps (PeakFinder, PeakVisor, PeakLens) are covered only briefly because they are the closest direct feature overlap. About 20 searches and fetches, run 2026-09-26. Items not confirmed by a source are listed under Gaps.

## 1. Visual positioning systems (VPS): do they work in mountains or off-street?

### Takeaway
None of the big VPS offerings gives 6DoF pose from arbitrary natural-terrain photos. Google's VPS is tied to Street View coverage. Apple's location anchors cover a list of cities. Niantic Spatial's VPS 2.0 (April 2026) claims global coverage without scanning, but that coverage is only "3DoF" GPS-drift correction, and centimetre-level 6DoF still needs pre-scanned areas. Rigi's niche, pose from skyline plus DEM for distant natural terrain with no prior scan, is still not served by these platforms.

### Cited Findings
- Google's ARCore Geospatial API anchors content "in any area covered by Google Street View" in 87+ countries. It matches the camera view against a localization model built from Google's VPS / Street View imagery. — [Google Developers Blog](https://developers.googleblog.com/en/make-the-world-your-canvas-with-the-arcore-geospatial-api/); [ARCore Geospatial docs](https://developers.google.com/ar/develop/geospatial)
- ARCore exposes an API to check VPS availability at the device's location, which implies coverage is patchy. — [ARCore: check VPS availability](https://developers.google.com/ar/develop/unity-arf/geospatial/check-vps-availability)
- Geospatial poses are also exposed in ARCore for Jetpack XR (Android XR headsets and glasses). — [Android Developers](https://developer.android.com/develop/xr/jetpack-xr-sdk/arcore/geospatial)
- Competitors to Google's Street View-based VPS set themselves apart by letting customers "bring their own data" for areas Street View doesn't reach. — [Geospatial World](https://geospatialworld.net/prime/business-and-industry-trends/what-is-visual-positioning-system-vps/)
- Niantic Spatial: in 2025 Niantic sold its games business (Pokémon GO) to Scopely for $3.5B and spun out Niantic Spatial with $250M, led by John Hanke. On 7 April 2026 it launched a revamped Scaniverse platform (web and mobile capture producing VPS maps, meshes and Gaussian splats; free tier plus paid plans) and VPS 2.0. — [GeekWire](https://www.geekwire.com/2026/from-pokemon-go-to-physical-ai-niantic-spatial-unveils-its-global-3d-mapping-platform/); [Robotics & Automation News](https://roboticsandautomationnews.com/2026/04/08/niantic-spatial-launches-two-new-world-models-to-support-real-world-ai-deployment/100393/)
- VPS 2.0 merges Lightship VPS and WPS (World Positioning System). It "operates at a global scale without prior scanning" by augmenting GPS with visual context to correct drift, giving "3DoF positioning anywhere". Centimetre-level accuracy applies in mapped (scanned) areas. — [Auganix](https://www.auganix.org/ar-news-nianctic-scaniverse-vps-2-0/); [note.com hands-on (Designium)](https://note.com/thedesignium/n/na2e60b0d1b15?hl=en); [GeekWire](https://www.geekwire.com/2026/from-pokemon-go-to-physical-ai-niantic-spatial-unveils-its-global-3d-mapping-platform/)
- Scaniverse positioning is aimed at robotics, industrial sites and "physical AI", not consumer photo annotation. — [Robotics 24/7](https://www.robotics247.com/article/niantic-spatial-launches-scaniverse-3d-space-capture-vps-2.0-virtual-positioning-platforms)
- Apple ARKit location anchors (ARGeoAnchor, since ARKit 4 in 2020) work only in supported cities. The most recent secondary source says 50+ US cities plus London and others. The authoritative list is in Apple's docs. — [Apple ARGeoAnchor docs](https://developer.apple.com/documentation/arkit/argeoanchor); [Medium / Saadia](https://ethansaadia.medium.com/ar-location-anchors-in-arkit-4-9a7ca19652f5); [Apple Dev Forums](https://developer.apple.com/forums/thread/650191)

### Inferences
- All major VPS systems are built from street-level imagery or user scans. Alpine terrain seen from a summit or trail has no Street View mesh, and the scenes are at kilometre ranges where VPS feature matching fails. The DEM-skyline approach is the right tool for this regime and is complementary: VPS fixes the camera near the user, while Rigi registers far-field terrain.
- Niantic's "3DoF anywhere" (likely orientation and position refinement from visual cues) is the closest threat. If it improves heading accuracy for phones outdoors, it would improve Rigi's compass prior rather than replace the skyline alignment. This is a possible partnership or input channel, not a substitute.
- Google could build skyline-DEM localization into ARCore (Google has global terrain and 3D Tiles). No announcement was found, so treat this as a latent threat.

### Gaps
- No source found for Snap (Lens Studio / Custom Landmarkers), Meta (Quest / Ray-Ban glasses world-locking), Immersal or MultiSet coverage in natural terrain. From general knowledge (unverified in this session), all of these rely on pre-scanned maps and are urban or indoor.
- Whether Niantic VPS 2.0's "3DoF" means orientation-only or 3-D position was not stated clearly in the fetched sources.
- The current Apple location-anchor city list (2025–26) was not retrieved.

## 2. Consumer photo apps: auto-labelling mountains in photos (Google Photos / Lens / Earth, Apple Photos, Adobe, Samsung)

### Takeaway
Consumer platforms identify famous landmarks and add generic 3D or parallax effects. Examples are Apple's iOS 26 Spatial Scenes and Google Earth's Gemini "Create image". None were found to register a photo to terrain or label every peak in it. Google Earth now ships global 20 m / 40 m contours and Gemini-driven analysis, so Google holds all the ingredients.

### Cited Findings
- Google Lens (including inside Google Photos) identifies landmarks and shows a card with the matched name. Tips say that visible mountains, skyline and roads improve confidence. This is single-label recognition, not per-peak annotation. — [Gadget Hacks](https://smartphones.gadgethacks.com/how-to/google-photos-101-use-google-lens-identify-landmarks-your-images-0184647/); [Bellingcat toolkit](https://bellingcat.gitbook.io/toolkit/more/all-tools/google-lens)
- Google Earth 2026: Gemini ("Nano Banana 2") "Create image" generates AI images grounded in Earth's satellite, aerial and 3D data for any location, rolling out globally on web. — [Android Authority](https://www.androidauthority.com/google-earth-ai-image-generation-3692696/)
- Google Earth: "Ask Google Earth" natural-language geospatial analysis, Gemini search over overhead imagery and Street View, and 20 m and 40 m elevation contours now available globally. Professional and Professional Advanced paid plans are also offered. — [Google Earth blog (Medium)](https://medium.com/google-earth/new-year-new-google-earth-major-upgrades-for-faster-sustainable-data-driven-decisions-in-2026-e6a835d8cb30); [What's coming to Google Earth in 2026](https://mapsplatform.google.com/resources/blog/from-the-product-lead-whats-coming-to-google-earth-in-2026/); [Pro plans](https://medium.com/google-earth/a-whole-new-way-to-work-onearth-introducing-google-earths-new-professional-plans-f80c20b944c9)
- Apple iOS 26 "Spatial Scenes": generative-AI depth turns any photo into a parallax 3D scene (iPhone 12+, no Apple Intelligence needed). Landscapes with foreground over mountains are cited as working especially well. Vision Pro shows them as spatial scenes. — [MacRumors](https://www.macrumors.com/how-to/ios-3d-lock-screen-effect-spatial-scenes/); [BGR](https://www.bgr.com/1989250/how-to-turn-iphone-photos-spatial-scenes-ios-26/); [Apple Support](https://support.apple.com/en-us/124145)
- Dedicated peak-ID apps are the direct feature incumbents. PeakFinder (since 2010, 1M+ peaks, $4.99 one-off, live panorama rendering) and PeakVisor (AR peak ID, 3D maps, trails, $39.99/yr) both mainly work on live camera or GPS. Reviewers report PeakVisor's accuracy is less consistent for distant summits. — [PeakFinder](https://www.peakfinder.com/mobile/); [PeakVisor](https://peakvisor.com/); [PeakSpotter comparison (vendor-authored; possible bias)](https://peakspotter.app/best-mountain-identifier-app/); [Alti-Mag](https://www.alti-mag.com/en/outdoor-activities/best-apps-identify-mountain-peaks)

### Inferences
- Threat: Google is best placed. It has Lens, Photos EXIF, Earth contours, 3D Tiles and Gemini. A "label the peaks in this photo" feature in Photos or Lens would be a small step but has not been announced. Apple has depth (Spatial Scenes) and Maps 3D but no terrain labelling of photos.
- Spatial Scenes shows that consumers now expect "photo becomes 3D". Rigi's projection onto real DEM geometry is geo-true where Apple's is hallucinated parallax, and that is worth stating in product positioning.

### Gaps
- No source found for Adobe Lightroom (map module / geotag features) or Samsung Gallery doing mountain or peak labelling. I believe neither does per-peak labelling (unverified).
- No confirmation of any Google Photos feature that places a photo inside Google Earth 3D. The older Earth/Photos "memories" integrations were not researched.

## 3. 3D mapping and terrain platforms (Cesium, Google 3D Tiles, Mapbox, MapLibre, Esri, swisstopo, Mapterhorn, Vantor/Maxar)

### Takeaway
The building blocks are commoditised: open DEM tiles (Mapterhorn, swisstopo OGD), open web renderers (MapLibre globe and terrain), and 3D-tile streaming (Cesium). Google's Photorealistic 3D Tiles cover famous mountain areas but carry licence terms that effectively prohibit Rigi's core use (image analysis and derivation). Esri and academic tools do oblique-photo georeferencing for professionals with manual GCPs, not automatically for consumers.

### Cited Findings
- Mapterhorn is an open project publishing terrain tiles built from open sources: Copernicus GLO DEM globally, plus high-res national data such as swissALTI3D. Tiles are Web Mercator, PMTiles and COG, ready for MapLibre. Code is BSD-3 and data attribution is per source. — [Mapterhorn GitHub](https://github.com/mapterhorn/mapterhorn); [Protomaps blog](https://protomaps.com/blog/mapterhorn-terrain/); [mapterhorn.com](https://mapterhorn.com/); [Oliver Wipfli](https://www.oliverwipfli.ch/mapterhorn-makes-public-terrain-data-accessible-2025-04-03/)
- MapLibre GL JS 5.0 (January 2025) added globe projection. MapLibre supports 3D terrain, raster draped over DEM, atmosphere and custom three.js layers on terrain. — [MapLibre globe roadmap](https://maplibre.org/roadmap/maplibre-gl-js/globe-view/); [MapLibre 3D terrain example](https://maplibre.org/maplibre-gl-js/docs/examples/3d-terrain/); [three.js on terrain](https://maplibre.org/maplibre-gl-js/docs/examples/adding-3d-models-using-threejs-on-terrain/)
- Google Photorealistic 3D Tiles are available through Cesium ion (2,500+ cities, 49 countries at launch). They use the OGC 3D Tiles standard and run in CesiumJS, Unreal, Unity and Omniverse. — [Cesium blog](https://cesium.com/blog/2023/10/26/photorealistic-3d-tiles-in-cesium-ion/)
- Cesium's Feb 2026 blog showcases Trailamo, a mountaineering planner. It uses Cesium World Terrain as its base, Google Photorealistic 3D Tiles for "well-known areas" (e.g. Mont Blanc from the French side), OpenTopoMap drapes, trails, ski runs, slope/avalanche-angle shading and NASA GIBS snow. It has no photo-overlay feature. — [Cesium blog: Trailamo](https://cesium.com/blog/2026/02/04/mountaineering-routes-in-cesiumjs-with-trailamo/)
- Esri ArcGIS Pro supports oblique frame-camera photogrammetry (Reality mapping, the "Oblique" option) and GCP-based georeferencing. It is aimed at aerial or frame imagery with known camera parameters, not consumer ground photos. — [ArcGIS Reality mapping](https://pro.arcgis.com/en/pro-app/3.1/help/data/imagery/reality-mapping-in-arcgis-pro.htm); [Managing frame camera imagery](https://doc.arcgis.com/en/imagery/workflows/resources/managing-frame-camera-imagery.htm); [Learn ArcGIS georeferencing](https://learn.arcgis.com/en/projects/georeference-imagery-in-arcgis-pro/)
- Academic and niche tool: photogeoref (Meteoexploration) georeferences oblique ground photos to a DEM, used for snow and glacier monitoring. It is a manual, GCP-driven precedent for Rigi's core operation. — [photogeoref GitHub](https://github.com/jgcmeteo/photogeoref); [Meteoexploration](https://www.meteoexploration.com/products/photogeoref.php)
- Vantor: Maxar Intelligence rebranded to Vantor on 1 Oct 2025 (the space business became Lanteris). It launched "Tensorglobe", an AI spatial-intelligence platform, and "Raptor", software that fuses Vantor 3D terrain with a drone's native camera for GPS-denied positioning. Its focus is defence and government. — [BusinessWire](https://www.businesswire.com/news/home/20251001760322/en/Vantor-Rebrands-from-Maxar-Intelligence-Unveils-AI-Powered-Platform); [SpaceNews](https://spacenews.com/maxar-retires-its-name-rebrands-as-vantor-and-lanteris/); [GPS World](https://www.gpsworld.com/maxar-intelligence-rebrands-to-vantor-unveils-ai-powered-platform/)

### Inferences
- Vantor Raptor is the closest technical analogue at enterprise scale: camera image registered to 3D terrain for pose. It is a military/drone product and is not aimed at consumers, but it confirms the technique is valued.
- Cesium plus Google 3D Tiles is the obvious "big platform" route to photoreal Alps rendering. However, Google's terms (next section) make it unsuitable as an alignment source. At most it could be used for pure display next to Rigi output, with attribution and no analysis.
- Rigi's stack (Mapterhorn DEM plus open renderers) is licence-clean and costs nothing per tile. The moat is the auto-alignment, not the data.

### Gaps
- No source found for Mapbox terrain-DEM v1 licence or pricing, for the Bing Maps 3D status (Bing Maps for Enterprise retirement was announced for 2025–2028; unverified here), or for the swisstopo map.geo.admin.ch 3D viewer feature set.
- Google Photorealistic 3D Tiles coverage and mesh quality specifically in the Swiss or Austrian high Alps (as opposed to "well-known areas") was not quantified. The Cesium forum notes the tiles carry no separate bare-earth terrain ([Cesium Community](https://community.cesium.com/t/google-photorealistic-3d-tileset-terrain-data/23924)).

## 4. Photo-to-3D and generative (Gaussian splatting, spatial photos, depth models, relighting)

### Takeaway
Monocular depth and multi-view pose models are now open and strong, including Depth Anything 3 (Nov 2025) and Apple Depth Pro (Oct 2024). Consumer "photo to 3D" (iOS 26 Spatial Scenes) and capture-to-splat (Scaniverse) are mainstream. These can enable Rigi features (occlusion masks, foreground separation, depth-aware blending) more than compete with them, because they lack geo-registration.

### Cited Findings
- Depth Anything 3 (ByteDance Seed, Nov 2025) extends depth to multi-view depth and camera-pose recovery. The code is Apache-2.0 and some model weights are CC BY-NC 4.0, depending on model size. Check the specific checkpoint before commercial use. — [arXiv 2511.10647](https://arxiv.org/html/2511.10647v1); [GitHub LICENSE](https://github.com/ByteDance-Seed/Depth-Anything-3/blob/main/LICENSE); [ComfyUI port note](https://github.com/PozzettiAndrea/ComfyUI-DepthAnythingV3)
- Apple Depth Pro (Oct 2024) does zero-shot metric monocular depth, a 2.25 MP depth map in 0.3 s on a GPU, without needing intrinsics. Weights are under a custom Apple licence. — [Apple ML Research](https://machinelearning.apple.com/research/depth-pro); [GitHub](https://github.com/apple/ml-depth-pro); [LICENSE](https://github.com/apple/ml-depth-pro/blob/main/LICENSE); [VentureBeat](https://venturebeat.com/ai/apple-releases-depth-pro-an-ai-model-that-rewrites-the-rules-of-3d-vision)
- Scaniverse (Niantic Spatial) produces Gaussian splats and meshes from phone or 360 capture. — [Auganix](https://www.auganix.org/ar-news-nianctic-scaniverse-vps-2-0/)
- iOS 26 Spatial Scenes: on-device generative depth and parallax for any photo. — [MacRumors](https://www.macrumors.com/how-to/ios-3d-lock-screen-effect-spatial-scenes/)
- Google Earth "Create image" (Gemini) produces generative renders grounded on real-location 3D data. This is adjacent to Rigi's "blend satellite or topo render into photo" feature. — [Android Authority](https://www.androidauthority.com/google-earth-ai-image-generation-3692696/)

### Inferences
- Opportunity: use depth models to separate near foreground (people, rocks, trees) from far terrain. Only far terrain gets the DEM projection or overlay, and depth ordering can resolve contour and trail occlusions. Monocular depth degrades at kilometre ranges, so the DEM should stay the far-field authority.
- DA3's pose-recovery capability hints that learned pose from a single image could become a competitor to skyline alignment for rough pose. However, it produces relative pose, not a geo pose, without a map prior.
- Generative "photo in 3D" from Apple and Google sets user expectations. Rigi's differentiator is geographic truth: correct names, elevations and trails.

### Gaps
- No source reviewed on AI relighting or generative-fill products (Adobe Firefly / Photoshop, Google Magic Editor) applied to terrain composites.
- Single-photo-to-splat models (e.g. Apple SHARP / similar 2025–26 work) were not researched in this session.

## 5. AI geolocation (GeoSpy, Google Lens, ChatGPT, Gemini): can they name mountains or peaks?

### Takeaway
LLMs can often infer a region from a landscape photo, and in Bellingcat tests Google AI Mode (Gemini 2.5) led. They still hallucinate and give region-level answers, not per-peak labelled overlays with pixel alignment. GeoSpy restricted itself to law enforcement in early 2025 and is not a consumer competitor.

### Cited Findings
- Bellingcat (June 2025): Google AI Mode (Gemini 2.5) beat all GPT models, including o4-mini-high, at geolocation. In one test, a field near Zurich with mountains behind, Gemini 2.5 Pro declined to narrow it down, while o4-mini placed it at "Jura foothills in northern Switzerland". "The majority of models, at some point, returned a hallucination." — [Bellingcat Jun 2025](https://www.bellingcat.com/resources/how-tos/2025/06/06/have-llms-finally-mastered-geolocation/)
- Bellingcat (Aug 2025): GPT-5 performed worse than other models at geolocation. — [Bellingcat Aug 2025](https://www.bellingcat.com/resources/2025/08/14/llms-vs-geolocation-gpt-5-performs-worse-than-other-ai-models/)
- GIJN's updated test covers 24 LLMs for geolocation. — [GIJN](https://gijn.org/stories/updated-test-24-llms-ai-geolocation/)
- GeoSpy (Graylark Technologies) closed public access in January 2025 after 404 Media reported stalking misuse. It is now marketed only to law enforcement and government (product line "Raven"). — [404 Media](https://www.404media.co/the-powerful-ai-tool-that-cops-or-stalkers-can-use-to-geolocate-photos-in-seconds/); [heise](https://www.heise.de/en/news/Graylark-closes-public-access-to-AI-tool-for-geolocation-10252293.html); [Glitchwire](https://glitchwire.com/news/graylarks-raven-turns-pixels-into-actionable-intelligence-for-law-enforcement/)
- Google Lens returns a single landmark card (see Q2). Mountain-specific apps such as PeakLens exist because generic Lens does not label every peak. — [Gadget Hacks](https://smartphones.gadgethacks.com/how-to/google-photos-101-use-google-lens-identify-landmarks-your-images-0184647/); [PeakLens](https://play.google.com/store/apps/details?id=com.peaklens.ar&hl=en_US&gl=US)

### Inferences
- For Rigi, EXIF GPS makes coarse geolocation moot. Where LLM geolocation helps is photos with stripped EXIF, as a fallback prior. Its failures (hallucination, region-level answers) argue for DEM verification, which is Rigi's core.
- A "name that peak" chat feature in Gemini or ChatGPT is plausible at famous-peak level (Matterhorn, Eiger). Pixel-accurate labelling of dozens of peaks, contours and trails needs geometric registration that LLMs don't do.

### Gaps
- No benchmark found specifically testing LLMs on naming multiple individual peaks in a mountain panorama. Results for 2026 model versions (Gemini 3.x, GPT-5.x) were not found.

## 6. Licensing constraints (Google 3D Tiles, swisstopo, Esri imagery)

### Takeaway
swisstopo OGD (since 1 March 2021) is free for commercial use with attribution, which makes it ideal for Rigi. Google Map Tiles / Photorealistic 3D Tiles explicitly forbid image analysis, machine interpretation, measurement and caching, so they can't be used as an alignment source or baked into exported composites. Mapterhorn inherits per-source open licences.

### Cited Findings
- Google Map Tiles API policies: you "may not use Map Tiles API for any non-visualization use cases, such as: Image analysis, Machine interpretation, Object detection or identification, Geodata extraction or resale, Offline uses". Pre-fetching, caching and storage are restricted. Attribution is required, e.g. "Map data: Google, Maxar Technologies". — [Map Tiles API Policies](https://developers.google.com/maps/documentation/tile/policies)
- Your own 3D overlays on Photorealistic 3D Tiles must not be "extracted, traced, or otherwise derived by hand or machine" from the tiles. Overlays must not obscure attribution, and users must be able to tell Google content from yours. Programmatic measurement of heights and elevations from the tiles counts as derivative and is prohibited. — [Map Tiles API Policies](https://developers.google.com/maps/documentation/tile/policies); [3D Tiles overview](https://developers.google.com/maps/documentation/tile/3d-tiles-overview); [Google FAQ blog](https://mapsplatform.google.com/resources/blog/commonly-asked-questions-about-our-recently-launched-photorealistic-3d-tiles/)
- swisstopo: from 1 March 2021, all federal geodata under its responsibility (elevation models such as swissALTI3D and swissSURFACE3D, imagery such as SWISSIMAGE, national maps) are OGD. They may be used, processed, enriched, redistributed and used commercially free of charge, with source attribution as the only condition. — [swisstopo OGD terms](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices); [Free geodata (OGD)](https://www.swisstopo.admin.ch/en/free-geodata-ogd); [FAQ](https://www.swisstopo.admin.ch/en/faq-free-geodata)
- Mapterhorn data licences follow each source (list at mapterhorn.com/attribution), and code is BSD-3. — [Mapterhorn GitHub](https://github.com/mapterhorn/mapterhorn)

### Inferences
- Rigi's alignment (analysis of rendered terrain against the photo) would breach Google Tiles terms if run on Google tiles. Any Google-3D-Tiles mode would have to be display-only and live-streamed, and exports blending Google imagery into user photos are legally risky. swisstopo plus Copernicus (via Mapterhorn) plus OSM trails is the defensible stack.
- Partnership angle: swisstopo already hosts a 3D viewer and OGD data. A swisstopo or Swiss-tourism collaboration is licence-simple. Cesium (open 3D Tiles ecosystem, mountain-app showcases like Trailamo) is a natural distribution or showcase partner.

### Gaps
- Esri World Imagery terms for derived products (blending into exported photos) were not retrieved. From general knowledge, Esri basemap use requires an ArcGIS account and attribution and restricts offline or derived redistribution (unverified).
- Copernicus DEM GLO-30 licence specifics (free, with attribution and some redistribution conditions) were not re-verified here. Mapbox and Bing imagery terms for composites were not researched.
