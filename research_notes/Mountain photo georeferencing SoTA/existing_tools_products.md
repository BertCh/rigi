# Existing Tools and Products: Mountain Photo Peak Labelling and Georeferencing/Monoplotting (as of Sept 2026)

## Q1. Consumer apps: what they do, live AR vs after-the-fact photo annotation, and how they align

### Takeaway
All the major consumer peak apps render a synthetic panorama from a DEM at the viewpoint and overlay peak labels on it. Only PeakLens clearly advertises computer-vision skyline matching (a CNN skyline extractor) to correct GPS and compass error. PeakVisor and PeakFinder can annotate an existing photo afterwards, but the user has to align it by hand: set the viewpoint on a map, then drag the rendered panorama until it matches the horizon. FATMAP is defunct (shut down Oct 1, 2024). No consumer app publicly offers full 6-DoF photo georeferencing, draping a photo onto terrain, or projecting trails onto a photo through an API.

### Cited Findings
**PeakVisor**
- Labels summits both in the live camera view and in "photos from past outdoor adventures"; the in-app flow is "Import Photo" → choose a photo. — [PeakVisor Android manual](https://peakvisor.com/android_tutorial_en.html)
- A web version also exists: "import any photo, then it will overlay it with a 3D landscape model and highlight... peaks, mountain huts, lakes, and even castles." The feature is described as "totally free." — [PeakVisor: Identify Mountains in your Photos](https://peakvisor.com/en/news/identify_mountains_in_photos.html)
- Alignment is manual. If EXIF location is missing or wrong, "use a map to properly position the viewpoint", then "adjust the rendered 3D terrain panorama to perfectly match horizon in the photo". The manual also says to slide the label panorama "to the side or up and down until you have a perfect match." The PeakVisor page does not claim any automatic skyline matching. — [PeakVisor photo page](https://peakvisor.com/en/news/identify_mountains_in_photos.html); [PeakVisor manual](https://peakvisor.com/android_tutorial_en.html)
- Its database covers more than 1 million named peaks. — [PeakVisor Android manual](https://peakvisor.com/android_tutorial_en.html)
- Bellingcat documents PeakVisor being used for OSINT geolocation, i.e. matching a photo's skyline to find where it was taken. — [Bellingcat 2023](https://www.bellingcat.com/resources/2023/07/13/more-than-mountaineering-using-peakvisor-for-geolocation/)

**PeakFinder (Fabio Soldati, Switzerland)**
- AR mode needs a gyroscope and a compass. With the device held upright, the panorama auto-aligns to the compass. If it is still off after calibration, the user drags the panorama, and a small dot circling the compass icon shows the offset. — [PeakFinder manual](https://www.peakfinder.com/mobile/manual/); [PeakFinder compass page](https://www.peakfinder.com/mobile/compass/)
- Users can "import any image from other sources" and annotate it. The photo editor has fine adjustment of the silhouette overlay. — [PeakFinder manual](https://www.peakfinder.com/mobile/manual/); [Google Play listing](https://play.google.com/store/apps/details?id=org.peakfinder.area.alps&hl=en_IN)
- Works fully offline, using an elevation model and peak directory built into the app. — [PeakFinder manual](https://www.peakfinder.com/mobile/manual/)
- There is a public embeddable **PeakFinder API** (URL link, iFrame, or Canvas JS with a PanoramaPanel and a MapPanel). Parameters: lat/lon, elevation, azimuth, altitude, FOV, elevation offset, date for sun/moon, and telescope az/alt. It runs on WebGL/WebAssembly and supports GeoJSON on the map. No photo overlay is documented. — [GitHub Fabiz/PeakFinder-API](https://github.com/Fabiz/PeakFinder-API)

**PeakLens (Politecnico di Milano spin-off)**
- Compares the camera view with a virtual panorama rendered from a 3D terrain model, and uses AI "to correct GPS and compass errors." Data sources are SRTM DEM plus OpenStreetMap peaks (ODbL). Offline maps are supported. The site lists Android (Google Play, Huawei) only. — [PeakLens site](https://www.peaklens.com/); [Google Play](https://play.google.com/store/apps/details?id=com.peaklens.ar&hl=en_GB)
- The research behind it: a CNN for pixel-wise skyline detection with 94.45% accuracy in the best conditions and 86.87% in the worst, a 9.36 MB model, and 273 ms per frame on a Nexus 6. — [Springer: CNN for Pixel-Wise Skyline Detection](https://link.springer.com/chapter/10.1007/978-3-319-68612-7_2)
- Related PoliMi work: "Mountain Peak Detection in Online Social Media" (annotating photos after the fact) and "Learning Contours for Automatic Annotations of Mountains Pictures on a Smartphone." — [arXiv 1508.02959](https://arxiv.org/pdf/1508.02959); [ResearchGate](https://www.researchgate.net/publication/272826616_Learning_Contours_for_Automatic_Annotations_of_Mountains_Pictures_on_a_Smartphone)
- Its landing page does not say whether gallery photos can be annotated after the fact. — [PeakLens site](https://www.peaklens.com/)

**Newer "AI identifier" apps (2025–26)**
- "Mountain Identifier: Peak Lens" (iOS, MWM) is a different app from PeakLens despite the similar name. It claims to identify a mountain from a photo, a live scan or a gallery upload "within seconds." — [App Store](https://apps.apple.com/us/app/mountain-identifier-peak-lens/id6752770531); [MWM](https://mwm.ai/apps/mountain-identifier-peak-lens/6752770531)
- "Peak Identifier" offers live AR labels plus "snap a photo and get instant AI identification." — [mountainidentifierapp.com](https://www.mountainidentifierapp.com/)
- SummitPeek offers AR labels for 70,000 peaks in the US and Canada. — [summitpeek.com](https://www.summitpeek.com/)

**FATMAP (defunct)**
- Strava bought FATMAP in Jan 2023 and discontinued the app on **Oct 1, 2024**. Some features moved into Strava Premium. Waypoints, guidebooks, national topo maps (IGN, OS), offline FATMAP maps and snow data were not carried over in time. — [Strava press](https://press.strava.com/articles/fatmap-is-transitioning-to-strava); [TechCrunch](https://techcrunch.com/2024/06/26/strava-to-shutter-3d-mapping-platform-fatmap-18-months-after-acquisition); [POWDER](https://www.powder.com/gear/strava-is-turning-off-fatmap-what-that-means-for-skiers-)

**CalTopo**
- The web-only "Simulated View" shows "exactly what you will see from a specific point on the map – with labeled peaks near and distant," with wireframe and elevation options. There are also Viewshed and Sun Exposure layers. None of the reviewed CalTopo pages mentions photo overlay or alignment. — [CalTopo blog, Jul 2026](https://blog.caltopo.com/2026/07/27/finding-the-perfect-viewpoint-with-caltopo/); [CalTopo viewshed](https://blog.caltopo.com/2013/05/18/viewshed-analysis/); [CalTopo 3D, Sept 2024](https://blog.caltopo.com/2024/09/30/new-feature-3d/)

**Ulrich Deuschle panorama generator (udeuschle.de)**
- A web generator for rendered, labelled panoramas. Viewpoints can be picked from more than 50,000 summits (mostly in the Alps) or set by lat/lon. Parameters: view direction, horizontal extent, altitude, camera height, and resolution/zoom. It models the Earth as a sphere with refraction coefficient 0.13, and caps output at 28,800 px (a 4× zoomed 360°). There is no photo overlay. — [udeuschle make panoramas](https://www.udeuschle.de/panoramas/makepanoramas_en.htm); [Help](https://www.udeuschle.de/panoramas/help_01_en.htm); [astro-geo-gis tips](https://astro-geo-gis.com/5-fantastic-tips-tricks-for-the-urlich-deuschle-panorama-generator/)

**HeyWhatsThat**
- "Calculate viewshed and panorama for any point on Earth": a labelled panorama plus a viewshed. — [Hacker News thread](https://news.ycombinator.com/item?id=30640846)

### Inferences
- Every photo-annotation feature in this segment uses the same UX: (1) set the viewpoint from EXIF GPS or a map pin, (2) set heading from the compass or EXIF, (3) have the user drag or scale the rendered silhouette onto the photo horizon. This amounts to a manual fit of yaw, pitch and (maybe) FOV at a fixed position. Only PeakLens automates it, using a CNN skyline plus matching against the rendered skyline.
- None of these apps exposes a pose output (a camera matrix) or supports trail projection or photo draping. That combination is the gap the user's app can fill.
- PeakFinder's embeddable panorama API and CalTopo's Simulated View are possible benchmarks for renderer fidelity, e.g. refraction and curvature handling. Deuschle documents k=0.13 refraction.

### Gaps
- No usable primary material was found for PeakAR, Peak ID, "Peakitt", "Mountains Scene", "Horizon", Gaia GPS, AllTrails, Komoot or Strava peak-labelling features. Their current status and alignment methods are unverified.
- Google Earth's photo overlay, Google Maps Live View and Apple Maps look-around peak labels were not researched in time. Live View relies on Street View VPS (see Q5), so it probably does not work in the backcountry. This is unverified for mountain trails.
- No published accuracy figures (degrees of heading error, label placement error) exist for PeakVisor or PeakFinder photo import.
- PeakVisor's web and app pricing beyond "totally free" for photo import, and whether it offers any automatic skyline snap in 2026, is unconfirmed.
- The CalTopo "Point of View" feature named in the brief was not found under that name. "Simulated View" appears to be the equivalent.

## Q2. Research and scientific tools (monoplotting, historical photo georeferencing, glaciology)

### Takeaway
In science, monoplotting has settled on one approach: GCP-based camera pose estimation against a DEM (Smapshot, Pic2Map, WSL Monoplotting Tool, ImGRAFT), or, in the Mountain Legacy Project's IAT and MIAS, a "virtual photograph" rendered from the DEM and aligned with control points. Newer work (Golparvar & Wang 2021/2025) automates the GCPs using keypoint detection between the photo and DEM-derived rasters, SAM segmentation and gradient-based pose optimisation. Smapshot is the closest analogue to the user's web app: a CesiumJS globe, volunteer GCP clicking, a 3D textured photo drape, and an open API.

### Cited Findings
**Smapshot (HEIG-VD, Produit, Blanc, Ingensand)**
- A web-based participatory virtual globe. Volunteers georeference historical landscape images "by clicking a minimum of six well identifiable correspondence points between the image and a 3D virtual globe", and a "state of the art photogrammetry camera orientation algorithm" hides the 3D complexity from them. — [Blanc, Produit, Ingensand 2018, PeerJ preprint](https://peerj.com/preprints/27204/) (via search snippet; the full page returned 403); [ResearchGate copy](https://www.researchgate.net/publication/327678132_A_semi-automatic_tool_to_georeference_historical_landscape_images)
- Camera orientation is stored in PostgreSQL/PostGIS, and "a 3D model textured with the picture is drawn in Cesium." Georeferenced images are placed in the Cesium globe so the historical and current landscape can be compared. — [Cesium blog 2017](https://cesium.com/blog/2017/04/21/smapshot/); [ResearchGate figure](https://www.researchgate.net/figure/sMapShot-3D-models-of-the-photographs-are-displayed-in-the-virtual-globe_fig3_309405571)
- Its open API, live at https://smapshot.heig-vd.ch/api/v1/ with docs at /api/v1/docs/, is open source at GitHub MediaComem/smapshot-api. — [GitHub smapshot-api](https://github.com/MediaComem/smapshot-api); [paper "An open API for 3D-georeferenced historical pictures"](https://www.researchgate.net/publication/362510547_AN_OPEN_API_FOR_3D-GEOREFERENCED_HISTORICAL_PICTURES)
- Lessons-learned paper comparing a QGIS plugin with a web app for a 3D georeferencer (Pic2Map → Smapshot). — [ResearchGate](https://www.researchgate.net/publication/309405571_QGIS_plugin_or_web_app_Lessons_learned_in_the_development_of_a_3D_georeferencer)
- FOSS4G paper "Crowdsourcing the georeferencing of historical pictures." — [UMass ScholarWorks](https://scholarworks.umass.edu/foss4g/vol18/iss1/6/)

**Pic2Map (QGIS plugin; Produit et al., now maintained by IG group SA)**
- Computes a photo's location and orientation from 3D GCPs, saving the orientation in Google Earth format. It then uses the DEM to overlay vector layers on the photo, digitise in the photo, and orthorectify it. Inputs are an image plus a GeoTIFF DEM in the same projected CRS. — [QGIS plugin repo](https://plugins.qgis.org/plugins/Pic2Map/); [GitHub iggroup/pic2map](https://github.com/iggroup/pic2map); [EPFL docs](https://documents.epfl.ch/groups/l/la/lasig-unit/www/pic2map/documentation/index.html)
- Current fork: Qt6/QGIS 3.40 only, Python, last updated around March 2025, and small (about 3 stars). The license was not visible on the fetched page. — [GitHub iggroup/pic2map](https://github.com/iggroup/pic2map)

**WSL Monoplotting Tool (Bozzini et al., 2012; WSL Switzerland)**
- Relates each pixel of an oblique photo to real-world lat/lon/elevation. It is used to orthorectify and georeference oblique photos and to extract vector data, and is described as "likely the most widely used monoplotting software." It has been applied to natural hazards, glacial processes and land-cover change. — [Stockdale et al. 2015, Applied Geography](https://www.sciencedirect.com/science/article/abs/pii/S0143622815001770) ([PDF](https://www.erichiggs.ca/uploads/4/5/2/9/45292581/applied_geography_2015_stockdale.pdf)); [IntechOpen chapter](https://www.intechopen.com/chapters/61775); [Application potential for natural hazards](https://www.researchgate.net/publication/283598842_Application_potential_of_the_WSL_monoplotting_tool_for_natural_hazard_management)
- Stockdale et al. 2015 evaluated its accuracy on Mountain Legacy Project images. Another accuracy assessment of monoplotting-derived geodata appears in IJGIS 2021. — [Stockdale 2015](https://www.sciencedirect.com/science/article/abs/pii/S0143622815001770); [IJGIS 2021](https://www.tandfonline.com/doi/full/10.1080/13658816.2021.1871910)

**Mountain Legacy Project (University of Victoria): IAT and MIAS**
- The Image Analysis Toolkit (IAT) builds a "virtual photograph" from camera metadata (location, azimuth, FOV) and a shaded terrain model that replicates the original image. The classified image is then aligned to the virtual photo with control points, producing a georeferenced land-cover raster. — [MLP IAT page](https://mountainlegacy.ca/image-analysis-toolkit/); [IAT methodology](https://mountainlegacy.ca/project/iatmethods/); [Mountain Research and Development 2016](https://bioone.org/journals/mountain-research-and-development/volume-36/issue-4/MRD-JOURNAL-D-16-00038.1/Exploring-Landscape-Change-in-Mountain-Environments-With-the-Mountain-Legacy/10.1659/MRD-JOURNAL-D-16-00038.1.full)
- The Mountain Image Analysis Suite (MIAS, Wright et al. 2024, Transactions in GIS) is a newer open QGIS plugin with four tools for classifying and georeferencing oblique images, and works on greyscale and colour historical photos. — [Wiley TGIS 2024](https://onlinelibrary.wiley.com/doi/full/10.1111/tgis.13229)
- Blog post: "Placing oblique photos on the map." — [MLP 2018](https://mountainlegacy.ca/2018/11/20/placing-oblique-photos-on-the-map/)

**ImGRAFT (Messerli & Grinsted 2015; glaciology)**
- An open-source MATLAB toolbox for georectification and feature tracking of terrestrial oblique and time-lapse images. It optimises the camera view per image from a DEM plus GCPs, projects between pixels and world coordinates, and produces viewsheds and geo/orthorectified images. Demonstrated on Engabreen, Norway. Mostly MIT-licensed. — [GI journal paper](https://gi.copernicus.org/articles/4/23/2015/gi-4-23-2015.html); [GitHub grinsted/ImGRAFT](https://github.com/grinsted/ImGRAFT)

**Semi-automatic and AI monoplotting (Golparvar & Wang)**
- The pipeline runs "key point detection in images and DEM rasters, retrieving georeferenced 3D DEM GCPs, regularized gradient-based optimization, pose estimation, ray tracing" to link oblique photos and DEMs at the pixel level with minimal human input. — [arXiv 2111.14021](https://arxiv.org/abs/2111.14021)
- The 2025 journal version in Computers & Geosciences (published Mar 21, 2025) adds the Segment Anything Model (SAM). — [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S0098300425000652)
- An older ISPRS paper, "Monoplotting – a semi-automated approach," also exists. — [ISPRS XXXVII](https://www.isprs.org/proceedings/XXXVII/congress/3b_pdf/125.pdf)

**Skyline-based azimuth refinement**
- A PFG journal paper, "A New Method of Improving the Azimuth in Mountainous Terrain by Skyline Matching," corrects compass heading by matching the photo skyline to a DEM skyline. — [Springer PFG 2020](https://link.springer.com/article/10.1007/s41064-020-00093-1)
- "A virtual reality application for augmented panoramic mountain images" (Virtual Reality, 2019). — [Springer](https://link.springer.com/article/10.1007/s10055-019-00385-x)

### Inferences
- The standard scientific pipeline is: (a) an initial guess for position, heading and FOV; (b) at least 4–6 GCPs (Smapshot requires 6, which suits a DLT-style solve that also estimates focal length); (c) nonlinear refinement; (d) ray-casting pixels into the DEM (monoplotting). For iPhone photos with EXIF focal length and GPS, a reduced solve is possible: fix position and intrinsics, estimate 3 rotation angles, and optionally refine altitude and focal length. That needs only 2–3 GCPs, a much lighter burden than Smapshot's 6.
- Smapshot's Cesium textured-frustum model is a proven way to "drape" a photo in a web 3D globe.

### Gaps
- The exact pose algorithms were not confirmed from primary text. Smapshot is thought to use DLT for initialisation and then LM with a priori constraints, as in Produit's thesis; Pic2Map's methods are likewise only implied. The source pages returned 403.
- No quantitative accuracy numbers were retrieved. The Stockdale 2015 and IJGIS 2021 accuracy results sit behind paywalls or were not fetched.
- The following were not investigated for lack of time: swisstopo historical terrestrial photo orientation, ETH/EPFL workflows, PhotoMapper, PointCatcher, and Python time-lapse tools (e.g. PyTrx, glimpse).
- Code availability for Golparvar & Wang is unconfirmed. The arXiv version is licensed CC BY-NC-ND.

## Q3. Open-source code for peak labelling, skyline matching, and photo overlay on Cesium/three.js

### Takeaway
Open-source work here is fragmented. There are research-grade skyline and edge matchers (e.g. sourav-ranjan/Mountain_Peak_Identification using ASTER GDEM and Hausdorff distance), MATLAB/QGIS monoplotting tools (ImGRAFT under MIT, Pic2Map, MIAS), and the Smapshot API. No maintained, permissively licensed TypeScript library for "label peaks on a photo" or "project a photo onto terrain" was found. The CesiumJS building blocks exist: terrain, imagery draping, and 3D Tiles draping added in 2025.

### Cited Findings
- **sourav-ranjan/Mountain_Peak_Identification** tags peaks in geotagged photos by edge-matching the photo against terrain synthesised from ASTER GDEM. It takes the top-k candidates, computes the Hausdorff distance between the photo skyline edge points and the rendered panorama, and combines that with rank into a score. — [GitHub](https://github.com/sourav-ranjan/Mountain_Peak_Identification)
- The academic basis is "Mountain Peak Identification in Visual Content Based on Coarse Digital Elevation Models" (ACM MAED 2014), which claims high accuracy even with a coarse DEM. — [ACM DL](https://dl.acm.org/doi/10.1145/2661821.2661825)
- A patent landscape exists: "Automated annotation of a view" (US 8432414, US 8675016) and "Landmark configuration matcher" (US 11164330, US 11928837, US 12456222). — [USPTO 8432414](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/8432414); [USPTO 11928837](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11928837); [USPTO 12456222](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/12456222)
- **ImGRAFT** (MATLAB, mostly MIT) — [GitHub](https://github.com/grinsted/ImGRAFT). **Pic2Map** (Python/QGIS) — [GitHub](https://github.com/iggroup/pic2map). **Smapshot API** (open source) — [GitHub](https://github.com/MediaComem/smapshot-api).
- **CesiumJS** is open source (Apache-2.0 per its repo) and streams terrain, imagery and 3D Tiles. In June 2025 it added imagery draping over 3D Tiles, alongside its existing draping of imagery on terrain. — [Cesium blog 2025](https://cesium.com/blog/2025/06/30/draping-imagery-over-3d-tiles-in-cesiumjs/); [GitHub CesiumGS/cesium](https://github.com/CesiumGS/cesium)
- Draping or projecting arbitrary camera images onto terrain is a long-standing feature request, e.g. MAVCesium issue #13 "Support real time image / sensor draping onto terrain" and CesiumJS issue #6531 on imagery layers with transformations. This suggests there is no built-in perspective-projected-texture primitive. — [MAVCesium #13](https://github.com/goodrobots/MAVCesium/issues/13); [Cesium #6531](https://github.com/CesiumGS/cesium/issues/6531)
- The three.js terrain repos found (turban/webgl-terrain, THREE.Terrain, Mountain 3D Viewer on Copernicus DEM 30 m + Sentinel-2) are rendering demos, not photo-alignment tools. — [turban/webgl-terrain](https://github.com/turban/webgl-terrain); [THREE.Terrain](https://github.com/IceCreamYou/THREE.Terrain); [Mountain 3D Viewer](https://monica-alegre.github.io/mountain-3d-viewer/)

### Inferences
- The user will probably have to write their own projective-texture shader for draping (a texture matrix from the solved camera, with a depth or shadow-map occlusion test) in CesiumJS or three.js. Alternatively, they can use Smapshot's approach of a textured 3D frustum model.
- Peak labelling is simple once the pose is known: project OSM `natural=peak` nodes, then run a visibility test against the DEM depth buffer.

### Gaps
- Specific GitHub repos named in the brief ("peaks-on-photo", "horizon-matching", "mountain-annotator", "skyline-peak", a PeakFinder clone in three.js) were not found in searches. Their existence and licences are unverified.
- The licences of Pic2Map, sourav-ranjan's repo and MIAS were not confirmed.
- No CesiumJS example of perspective photo projection was located. Community demos (e.g. a "video fusion" shader in Chinese Cesium forks) are thought to exist but were not verified.

## Q4. UX patterns for semi-automatic alignment (fallback when automatic alignment fails)

### Takeaway
Tools use four recurring patterns: (1) **drag the rendered silhouette or panorama** onto the photo horizon (PeakVisor, PeakFinder); (2) **pin the viewpoint on a map** when EXIF GPS is missing or wrong (PeakVisor); (3) **click paired correspondence points** in the photo and the 3D globe or map, with a minimum of 6 in Smapshot and GCP tables in Pic2Map, WSL and ImGRAFT; (4) **align to a virtual photograph** rendered from metadata using control points (MLP IAT and MIAS). Automatic methods either extract the skyline with a CNN and match it to a DEM skyline (PeakLens, PFG 2020 azimuth refinement, ACM 2014), or detect keypoints between the photo and DEM rasters (Golparvar & Wang).

### Cited Findings
- PeakVisor: map-pin viewpoint, then drag and slide the panorama left/right and up/down to match the horizon. — [PeakVisor](https://peakvisor.com/en/news/identify_mountains_in_photos.html); [manual](https://peakvisor.com/android_tutorial_en.html)
- PeakFinder: auto-aligns to the compass, then the user drags to correct; the correction offset is shown on the compass icon; the photo editor offers fine silhouette adjustment. — [PeakFinder manual](https://www.peakfinder.com/mobile/manual/); [Google Play](https://play.google.com/store/apps/details?id=org.peakfinder.area.alps&hl=en_IN)
- Smapshot: at least 6 correspondence clicks between photo and globe, with the camera solve abstracted away for non-experts. — [PeerJ preprint](https://peerj.com/preprints/27204/)
- MLP IAT: builds a virtual photo from location, azimuth and FOV, then aligns it with control points. — [MLP IAT](https://mountainlegacy.ca/image-analysis-toolkit/)
- Skyline matching to fix azimuth — [PFG 2020](https://link.springer.com/article/10.1007/s41064-020-00093-1); CNN skyline for real-time correction — [PeakLens CNN](https://link.springer.com/chapter/10.1007/978-3-319-68612-7_2)
- A "vantage point adjustment method" overlays the initial photograph with a rectangle to adjust the viewpoint. — [ResearchGate figure](https://www.researchgate.net/figure/antage-point-adjustment-method-The-initial-photograph-is-overlaid-with-a-rectangular_fig1_331006885)

### Inferences
- A good fallback ladder for an iPhone app: auto skyline match → "drag the silhouette" (1–3 DOF: yaw, pitch, optionally FOV) → "tap 2–3 known peaks" (solve rotation with fixed GPS and EXIF focal length) → full GCP mode with 6 or more points (solve all 6 DOF plus focal length, Smapshot-style). No surveyed consumer app implements the "tap 2–3 known peaks" step. It would be a differentiator.

### Gaps
- There are no user studies comparing these UX patterns on speed or accuracy.

## Q5. Commercial visual positioning APIs and whether they work in mountains

### Takeaway
Google's ARCore Geospatial VPS, Apple's ARKit location anchors and Niantic Spatial VPS all depend on pre-captured imagery (Street View, Apple Look Around, or Niantic scans). They are built around cities and places Niantic has mapped, so they will generally not localise in alpine terrain. ARCore falls back to GPS and compass there. None of them georeferences a photo that has already been taken. They are live-AR session APIs.

### Cited Findings
- ARCore Geospatial API is built on VPS using Street View imagery and is available in 87–93+ countries. With VPS, accuracy is "typically better than 5 meters and often around 1 meter" with rotation better than 5°. Without VPS coverage it can use GPS "in outdoor environments with few or no overhead obstructions." — [Google Developers Blog](https://developers.googleblog.com/en/make-the-world-your-canvas-with-the-arcore-geospatial-api/); [Check VPS availability](https://developers.google.com/ar/develop/java/geospatial/check-vps-availability)
- ARCore also offers Geospatial Depth for extended range. — [Google Developers](https://developers.google.com/ar/develop/unity-arf/depth/geospatial-depth)
- There is a GitHub issue about the Geospatial API reporting incorrectly high accuracy. — [arcore-unity-extensions #211](https://github.com/google-ar/arcore-unity-extensions/issues/211)
- Apple ARGeoAnchor (location anchors) needs areas Apple has mapped. It launched in 5 US metros, later grew to 25+ US cities, and added London. — [WWDC21 Explore ARKit 5](https://developer.apple.com/videos/play/wwdc2021/10073/); [ARGeoAnchor docs](https://developer.apple.com/documentation/arkit/argeoanchor)
- Niantic Spatial VPS 2.0 claims centimetre precision in pre-scanned places and "reliable position and heading" where no map exists. It has more than 1M VPS-activated locations, and its SDK has added outdoor VPS on Quest 3. — [Niantic VPS 2.0 blog](https://www.nianticspatial.com/en/blog/vps2); [UploadVR](https://www.uploadvr.com/niantic-spatial-sdk-brings-outdoor-vps-live-meshing-semantic-segmentation-to-quest-3/); [Niantic docs](https://www.nianticspatial.com/docs/nsdk/features/lightship_vps/)

### Inferences
- In mountain terrain, DEM skyline matching is effectively the "VPS." Commercial VPS will not replace it and is useless for post-hoc photo georeferencing. The user's in-app approach (EXIF GPS and heading plus DEM skyline alignment) stands on its own.

### Gaps
- No official statement was found on VPS availability on trails or in national parks. Niantic's "reliable heading without a map" claim is not quantified for alpine settings.
- Google Maps Live View's reliance on the same VPS was not verified from a primary source.
