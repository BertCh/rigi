# Scientific, open-source and heritage tools that georeference oblique (ground-level) photos against terrain (as of Sept 2026)

Scope note: algorithm internals (Baboud, Baatz, Brejcha/Čadík, LandscapeAR, PeakLens, RoMa v2, Geo-LoFTR) are covered in `reports/Mountain photo georeferencing SoTA.md`. These notes cover tools, platforms, communities and positioning. The research used about 25 search and fetch calls. Several named targets (CALVI, "alpenwelt", "TopoCamera", MountNet, Time Machine Europe, Google Earth photo placement, OpenAerialMap) were not verified and are listed under Gaps.

## Q1. What each project/tool does: inputs, automation, accuracy, license, activity

### Takeaway
Almost every heritage and science tool is a **manual-GCP or manual "virtual photograph" matcher**: a human clicks correspondences or drags camera parameters until a DEM render matches. The fully automatic horizon-based methods exist only as research code or papers. These are TU Wien 2022 (63% success on 204 historical Alpine images), the Brno LOCATE family and LandscapeAR. None of them is packaged as a maintained end-user tool. Active maintained software is scarce: Pic2Map (QGIS 4, released June 2025), MIAS (QGIS plugin, 2024) and Smapshot (open API, Node/PostGIS).

### Cited Findings

**Smapshot (HEIG-VD, Switzerland): crowdsourced 3D georeferencing of historical photos**
- A web-based participatory virtual globe. Users georeference historical landscape images by clicking **at least six correspondence points** between the image and a 3D virtual globe. The result is a 6-DoF pose — [PeerJ preprint](https://peerj.com/preprints/27204/); [FOSS4G 2022 talk](https://talks.osgeo.org/foss4g-2022-academic-track/talk/YXFEWL/)
- More than 150,000 digitized historical pictures have been georeferenced in 3D by more than 700 participants — [FOSS4G 2022 academic track](https://talks.osgeo.org/foss4g-2022-academic-track/talk/YXFEWL/); [ZORA paper PDF](https://www.zora.uzh.ch/server/api/core/bitstreams/880b0365-3dd2-4fe6-ab4a-4a025b448c56/content)
- A semi-automatic mode exists. It propagates poses between overlapping images using pairwise SIFT matching, which is image-to-image, not image-to-DEM — [ResearchGate: semi-automatic tool](https://www.researchgate.net/publication/327678132_A_semi-automatic_tool_to_georeference_historical_landscape_images)
- Open API (`smapshot-api`): Node.js 18 + Express, PostgreSQL/PostGIS, Python image tools, Docker, Google/Facebook OAuth. About 459 commits on staging, 8 open issues, public API at smapshot.heig-vd.ch/api/v1/ — [GitHub MediaComem/smapshot-api](https://github.com/MediaComem/smapshot-api)
- Has a swisstopo collection page, so swisstopo's archive images are crowdsourced through Smapshot — [smapshot.heig-vd.ch/swisstopo](https://smapshot.heig-vd.ch/swisstopo)
- A third-party mobile app project for re-photographing Smapshot images exists — [GitHub smapshot-application](https://github.com/Christoffer9612/smapshot-application)
- Stated use cases: glacier melt, urbanisation and natural hazards. Historical pictures have higher temporal and spatial resolution than satellite imagery — [ResearchGate: Open API paper](https://www.researchgate.net/publication/362510547_AN_OPEN_API_FOR_3D-GEOREFERENCED_HISTORICAL_PICTURES)
- I found no evidence of a 2024–2026 deep-learning or automatic image-to-DEM mode in Smapshot. Searches returned only the 2018 SIFT semi-automatic work — [search result set incl. PeerJ](https://peerj.com/preprints/27204/)

**WSL Monoplotting Tool (Swiss Federal Institute WSL)**
- A desktop interface for georeferencing and orthorectifying single oblique photographs and drawing georeferenced vector data directly on them for export to GIS — [WSL product page](https://www.wsl.ch/en/services-produkte/monoplotting-tool/); [Stockdale et al. 2015, Applied Geography](https://www.sciencedirect.com/science/article/abs/pii/S0143622815001770)
- Accuracy: objects georeferenced to within **less than 15 m** of their real 3D location. The mean displacement over more than 121 control points was **under 3 m** — [Stockdale et al. 2015 PDF](https://www.erichiggs.ca/uploads/4/5/2/9/45292581/applied_geography_2015_stockdale.pdf)
- Users are ecologists (treeline and landcover change back to the late 1800s) and natural-hazard managers documenting events before the traces disappear — [IntechOpen chapter](https://www.intechopen.com/chapters/61775); [ResearchGate: hazard management](https://www.researchgate.net/publication/283598842_Application_potential_of_the_WSL_monoplotting_tool_for_natural_hazard_management)
- A 2021 IJGIS accuracy assessment of monoplotting for repeat photography also exists — [Taylor & Francis IJGIS 2021](https://www.tandfonline.com/doi/full/10.1080/13658816.2021.1871910)
- Workflow is manual GCPs (the WSL page describes calibration; the published evaluations use control points). License and last release date were not found.

**Pic2Map (EPFL LASIG → iggroup fork), QGIS plugin**
- Computes the 3D location and orientation of a picture **from 3D ground control points**. It then overlays vector layers on the photo, digitizes in the photo, orthorectifies, and exports the pose to Google Earth format. Stated uses include rapid mapping after avalanches and landslides, change detection and landscape augmentation — [QGIS plugin page](https://plugins.qgis.org/plugins/Pic2Map/); [GitHub iggroup/pic2map](https://github.com/iggroup/pic2map)
- Latest version **4.0, released June 3, 2025**, for QGIS 4.0–4.99. About 2,056 downloads of that version. Maintainer "produitt" (T. Produit) — [QGIS plugin page](https://plugins.qgis.org/plugins/Pic2Map/)
- Originated in Gillian Milani's EPFL master thesis. The current repo is a fork of the deprecated original and supports Qt6 only — [GitHub tproduit/pic2map README](https://github.com/tproduit/pic2map/blob/master/README.md)
- The same author team wrote "QGIS plugin or web app? Lessons learned in the development of a 3D georeferencer", linking Pic2Map to the Smapshot web approach — [ResearchGate](https://www.researchgate.net/publication/309405571_QGIS_plugin_or_web_app_Lessons_learned_in_the_development_of_a_3D_georeferencer)

**Mountain Legacy Project (MLP, Univ. of Victoria, Canada): IAT and MIAS**
- The world's largest systematic collection of high-resolution historical mountain photographs (**more than 120,000** glass plates from 1880s–1950s surveys) and **more than 8,000 repeat pairs**. Field teams re-shoot from the surveyors' original stations. The project has run since 1998 — [ACC blog](https://blog.alpineclubofcanada.ca/state-of-the-mountains/2019/04/22/the-mountain-legacy-project); [mountainlegacy.ca](https://mountainlegacy.ca/)
- Explorer web app (explore.mountainlegacy.ca) launched in 2022 for browsing the collection — [MLP Explorer news](https://mountainlegacy.ca/2022/02/26/explorernews/)
- Image Analysis Toolkit (IAT): a browser-based toolkit for working directly on oblique photos, offered as an alternative to monoplotting — [IAT page](https://mountainlegacy.ca/image-analysis-toolkit/); [MRD 2016 paper](https://bioone.org/journals/mountain-research-and-development/volume-36/issue-4/MRD-JOURNAL-D-16-00038.1/Exploring-Landscape-Change-in-Mountain-Environments-With-the-Mountain-Legacy/10.1659/MRD-JOURNAL-D-16-00038.1.full)
- MIAS (Mountain Image Analysis Suite, 2024): a QGIS plugin with four tools, including deep-learning landcover classification (PyLC) and georeferencing. It outputs a classified, spatially referenced viewshed. GNU licensed, about 179 commits, targets QGIS 3.28.1 and Python 3.9+ — [GitHub MLP-Hub/MLP_IA_Suite](https://github.com/MLP-Hub/MLP_IA_Suite); [Wright et al. 2024, Transactions in GIS](https://onlinelibrary.wiley.com/doi/full/10.1111/tgis.13229)
- MIAS georeferencing is **manual "virtual photograph" matching**. The user enters camera parameters and a DEM, then adjusts position, azimuth and FOV until a shaded-terrain render matches the photo — [Wright et al. 2024 (via search summary)](https://onlinelibrary.wiley.com/doi/full/10.1111/tgis.13229); [MLP "Placing oblique photos on the map"](https://mountainlegacy.ca/2018/11/20/placing-oblique-photos-on-the-map/)

**Glaciology terrestrial-camera toolboxes (time-lapse, fixed cameras)**
- **ImGRAFT** (MATLAB, open source, Messerli & Grinsted 2015): georeferencing, georectification, viewsheds and feature tracking for terrestrial oblique time-lapse images. Inputs are a DEM plus **ground control points**. Demonstrated on Engabreen, Norway — [GI journal](https://gi.copernicus.org/articles/4/23/2015/); [GitHub grinsted/ImGRAFT](https://github.com/grinsted/ImGRAFT)
- **PyTrx** (Python, pip-installable, P. How): velocities, areas and distances from oblique glacial time-lapse imagery — [GitHub PennyHow/PyTrx](https://github.com/PennyHow/PyTrx); [Frontiers 2020](https://www.frontiersin.org/journals/earth-science/articles/10.3389/feart.2020.00021/full)
- **Pointcatcher** (MATLAB GUI): time-lapse feature tracking, image registration, Monte Carlo error, georeferencing and multitemporal DEM integration — [Journal of Glaciology](https://www.cambridge.org/core/journals/journal-of-glaciology/article/pointcatcher-software-analysis-of-glacial-timelapse-photography-and-integration-with-multitemporal-digital-elevation-models/23EC92804DE7C5EED7229D0ACE31D90B/core-reader)
- **Glacier Image Velocimetry (GIV)**: open-source velocity toolbox that automatically georeferences velocity grids to GeoTIFF — [TC preprint](https://tc.copernicus.org/preprints/tc-2020-204/tc-2020-204-manuscript-version6.pdf)

**Automatic horizon-based orientation of historical images (TU Wien)**
- Mikolka-Flöry, Ressl, Schimpl and Pfeifer (ISPRS Open J. Photogramm. RS, 2022) automatically oriented **204 historical terrestrial Alpine images** using the visible horizon, estimating interior and exterior orientation. **129 (63%)** reached the same monoplotting accuracy as manual orientation. Another **44 (22%)** were good enough as initial estimates. Rationale: the horizon stays stable over a century while glaciers and vegetation change, so feature matching fails — [ADS abstract](https://ui.adsabs.harvard.edu/abs/2022OJPRS...600026M/abstract); [ScienceDirect](https://www.sciencedirect.com/science/article/pii/S2667393222000151)
- Won the journal's 2022 Best Paper Award and is a Fritz Ackermann Award candidate at the 2026 ISPRS Congress — [TU Wien news](https://www.tuwien.at/en/mg/geo/photo/news/news-detail/news/isprs-open-journal-of-photogrammetry-and-remote-sensing-best-paper-award-2022-fuer-mikolka-floery-et-al)
- No released code or tool was found (the ScienceDirect page returned 403, and no repository appeared in searches).

**Swiss glacier and archive programmes**
- swisstopo holds about 57,000–60,000 terrestrial glass-plate negatives from the 1915–1947 phototheodolite surveys of the Alps. The images are black-and-white on 9×12 to 13×18 cm plates, with station position and altitude measured. They can be searched in the LUBIS viewer — [swisstopo terrestrial images](https://www.swisstopo.admin.ch/en/the-terrestrial-images); [swisstopo fact sheet](https://www.swisstopo.admin.ch/dam/en/sd-web/q1TjmYtsDYDW/Fact%20Sheet%20Image%20Collection-EN.pdf); [LUBIS viewer](https://www.swisstopo.admin.ch/en/application-lubis-viewer)
- The WSL project "Hundred years of Swiss glacier changes from historical terrestrial images" (E. Hodel, 2020–2021, with HEIG-VD and MeteoSwiss) reconstructed glaciers photogrammetrically from **stereo pairs** of the 1920s–40s swisstopo plates — [WSL project page](https://www.wsl.ch/en/projects/hundred-years-of-swiss-glacier-changes-from-historical-terrestrial-images/)
- GletscherVergleiche.ch / SwissGlaciers.org (Simon Oberli, Oberli Engineering GmbH) publishes interactive before/after glacier photo comparisons (for example, Rhone Glacier since 2007). This is repeat photography only, with no DEM georeferencing, and the content is proprietary — [gletschervergleiche.ch](https://www.gletschervergleiche.ch/Pages/ImageCompare.aspx?Id=6)

**French IGN "Remonter le temps"**
- Free comparison viewer for maps and **vertical aerial** photographs across France: more than 6 million old aerial photos, about 50,000 maps, and orthophotos from 1950–1965 to today, with a swipe comparison mode. It has no oblique ground-photo georeferencing — [IGN news](https://www.ign.fr/actualites/remonter-le-temps-les-archives-photographiques-et-cartographiques-de-lign-souvrent-encore-et-toujours-plus-vous); [remonterletemps.ign.fr](https://remonterletemps.ign.fr/comparer/?pointer=true)

**Street-level platforms**
- Panoramax: an open-source, federated street-level imagery platform started in 2022 by IGN and OSM France. Six or more instances were online in 2025 — [Wikipedia: Panoramax](https://en.wikipedia.org/wiki/Panoramax)
- Mapillary: crowdsourced geotagged and 360° street-level imagery, launched 2013, owned by Meta since 2020 — [Wikipedia: Mapillary](https://en.wikipedia.org/wiki/Mapillary)
- Neither registers photos against a DEM. Both rely on GPS and SfM, and I found no mountain-trail-specific features.

**Research datasets and code (mountain visual localization)**
- GeoPose3K (Brno University of Technology): more than 3,000 precisely posed mountain photos with synthetic depth, normals, illumination and semantic labels — [project page](https://cphoto.fit.vutbr.cz/geoPose3K/)
- CrossLocate (WACV 2022): 12,353 photos combining GeoPose3K and LandscapeAR over the Alps, with a geographically disjoint split (Switzerland held out for test). Code is on GitHub — [GitHub JanTomesek/CrossLocate](https://github.com/JanTomesek/CrossLocate)
- The LOCATE project (M. Čadík, Brno) covers geo-registration, pose estimation and place recognition in natural environments — [LOCATE page](https://cadik.posvete.cz/locate/)
- Baatz et al. ECCV 2012 (CH1/CH2 Swiss sets): 88% of queries within 1 km over 40,000 km², but 49% needed manual sky correction — [Baatz ECCV'12 PDF](https://www.inf.ethz.ch/personal/pomarc/pubs/BaatzECCV12.pdf) (full detail in the repo SoTA report)
- LandscapeAR code — [GitHub brejchajan/LandscapeAR](https://github.com/brejchajan/LandscapeAR)

**Map-based and global geolocation models (adjacent, not DEM-based)**
- OrienterNet (Meta, CVPR 2023): localizes a single image against 2D OpenStreetMap tiles with neural matching. Code and weights are **CC-BY-NC** — [GitHub facebookresearch/OrienterNet](https://github.com/facebookresearch/OrienterNet); [CVPR paper](https://openaccess.thecvf.com/content/CVPR2023/papers/Sarlin_OrienterNet_Visual_Localization_in_2D_Public_Maps_With_Neural_Matching_CVPR_2023_paper.pdf)
- MapLocNet (2024) is a coarse-to-fine image-to-navigation-map registration method. OSMLoc (Information Fusion 2026) adds geometric and semantic guidance — [arXiv 2407.08561](https://arxiv.org/html/2407.08561v1); [GitHub WHU-USI3DV/OSMLoc](https://github.com/WHU-USI3DV/OSMLoc)
- PIGEON (Stanford): 40% of guesses within 25 km, 92.0% country accuracy, 44.4 km median error on Street View. The StreetCLIP backbone is public — [arXiv 2307.05845](https://arxiv.org/abs/2307.05845)
- GeoCLIP (NeurIPS 2023): MIT-licensed, pip-installable worldwide GPS regressor — [GitHub VicenteVivan/geo-clip](https://github.com/VicenteVivan/geo-clip); [PyPI geoclip](https://pypi.org/project/geoclip/)
- GeoSpy (Graylark): public access was closed in 2025 after 404 Media reported stalking misuse. Rebranded as **Raven** in April 2026 and restricted to law enforcement, government and verified businesses — [404 Media](https://www.404media.co/the-powerful-ai-tool-that-cops-or-stalkers-can-use-to-geolocate-photos-in-seconds/); [Graylark GeoSpy→Raven](https://graylark.com/geospy)

### Inferences
- The field splits cleanly in three. (a) **Human-in-the-loop monoplotters** (WSL, Pic2Map, MIAS, Smapshot, ImGRAFT) have high accuracy (metres to tens of metres) but need 6+ GCPs or manual render matching. (b) **Automatic research methods** (TU Wien horizon, LandscapeAR, CrossLocate) have no maintained UI. (c) **Coarse geolocators** (PIGEON, GeoCLIP, GeoSpy) work at kilometre scale and produce no pose.
- Licenses: most academic tools are GPL or permissive (MIAS GNU, GeoCLIP MIT, ImGRAFT and PyTrx open). The main neural map-localizer, OrienterNet, is non-commercial (CC-BY-NC), which matters for any commercial Rigi use.

## Q2. Which are closest to Rigi's automatic single-photo DEM alignment plus rich visualization, and which need manual GCPs?

### Takeaway
On automation, the closest analogues are the **TU Wien horizon method** (automatic interior and exterior orientation, 63% success on hard historical images) and **LandscapeAR** (automatic render-and-match, iPhone demo). Neither ships as a usable product. On visualization and output, the closest is **Smapshot** (3D-globe draping of posed photos, open API), but it is fully manual. Pic2Map, WSL Monoplotting, ImGRAFT and Smapshot need GCPs. MIAS and MLP need manual virtual-photo matching.

### Cited Findings
- Smapshot needs 6 or more user-clicked GCPs per image — [PeerJ](https://peerj.com/preprints/27204/)
- Pic2Map needs 3D ground control points — [QGIS plugin page](https://plugins.qgis.org/plugins/Pic2Map/)
- ImGRAFT needs a DEM plus GCPs — [GI journal](https://gi.copernicus.org/articles/4/23/2015/)
- MIAS uses manual adjustment of position, azimuth and FOV against a shaded-terrain virtual photo — [Wright et al. 2024](https://onlinelibrary.wiley.com/doi/full/10.1111/tgis.13229)
- TU Wien: automatic horizon-based orientation, 63% matching manual accuracy — [ADS](https://ui.adsabs.harvard.edu/abs/2022OJPRS...600026M/abstract)
- LandscapeAR: automatic, iPhone-capable, code on GitHub — [GitHub](https://github.com/brejchajan/LandscapeAR) (see the repo SoTA report for accuracy numbers)
- WSL Monoplotting reaches under 15 m object accuracy, which sets the "science-grade" bar a Rigi pose must approach to be usable for measurement — [Stockdale 2015](https://www.erichiggs.ca/uploads/4/5/2/9/45292581/applied_geography_2015_stockdale.pdf)

### Inferences
- Rigi's distinguishing combination is: automatic pose from EXIF priors, DEM skyline alignment, and live overlays (contours, peaks, trails, satellite and topo blends, photo draped on 3D) **in the browser**. No non-consumer tool found offers all of these. Smapshot has the browser plus 3D draping but is manual. The TU Wien method is automatic but ships no tool. MIAS/QGIS has landcover classification but is desktop and manual.
- The heritage tools target **historical photos with no EXIF**. Rigi's priors (GPS, compass, gravity) make its problem much easier. For Rigi to serve archives it would need a no-prior mode, such as "tap two peaks" or a known camera station (swisstopo plates record station coordinates).
- A clear opportunity: Rigi's automatic solver could act as a **pose initializer for Smapshot-style or MIAS-style workflows**. Even the TU Wien approach counted "good enough as an initial estimate" (22%) as useful.

## Q3. User communities served and unmet needs

### Takeaway
The communities are glaciologists (time-lapse velocity, centennial glacier change), ecologists and landcover researchers (treeline and vegetation change from repeat photos), natural-hazard managers (rapid event mapping), archives and heritage (swisstopo, MLP, Smapshot volunteers), and OSINT and law enforcement (GeoSpy/Raven). The common unmet need is **fast, automatic, accurate pose for a single oblique photo, with results exportable to GIS**. Today that takes minutes to hours of GCP clicking per image, against archives of 57k–150k+ images.

### Cited Findings
- Glaciology: ImGRAFT, PyTrx, Pointcatcher and GIV serve fixed-camera time-lapse velocity work — [ImGRAFT](https://gi.copernicus.org/articles/4/23/2015/); [PyTrx](https://github.com/PennyHow/PyTrx)
- Ecology: WSL monoplotting of treeline change back to the late 1800s; MLP/MIAS landcover maps — [Stockdale 2015](https://www.sciencedirect.com/science/article/abs/pii/S0143622815001770); [MIAS](https://github.com/MLP-Hub/MLP_IA_Suite)
- Hazards: WSL and Pic2Map are both positioned for rapid avalanche and landslide mapping — [IntechOpen](https://www.intechopen.com/chapters/61775); [Pic2Map](https://plugins.qgis.org/plugins/Pic2Map/)
- Archive scale: MLP has more than 120k plates, swisstopo about 57k terrestrial plates, Smapshot more than 150k images georeferenced by more than 700 volunteers — [ACC blog](https://blog.alpineclubofcanada.ca/state-of-the-mountains/2019/04/22/the-mountain-legacy-project); [swisstopo](https://www.swisstopo.admin.ch/en/the-terrestrial-images); [FOSS4G 2022](https://talks.osgeo.org/foss4g-2022-academic-track/talk/YXFEWL/)
- Historical terrestrial images "are largely unused for quantifying environmental changes because of the difficult and time-consuming estimation of unknown camera parameters" — [ADS abstract, Mikolka-Flöry 2022](https://ui.adsabs.harvard.edu/abs/2022OJPRS...600026M/abstract)
- OSINT: GeoSpy showed demand for photo geolocation but also its misuse risk, which led to closure to the public — [404 Media](https://www.404media.co/the-powerful-ai-tool-that-cops-or-stalkers-can-use-to-geolocate-photos-in-seconds/)

### Inferences
- Unmet needs Rigi could address:
  - (1) Automatic or one-tap pose for modern geotagged photos, for citizen science and hazard reporting.
  - (2) Browser-based monoplotting (digitize on the photo and get GIS vectors) without installing QGIS.
  - (3) Rephotography guidance: overlay a historical pose on a live camera view so the user can stand where the surveyor stood. This is the MLP field-team workflow and what the Smapshot mobile-app project attempted.
  - (4) Measurement-grade outputs: export the camera model and per-pixel XYZ, and report uncertainty.
- Privacy is a positioning risk. The GeoSpy episode shows that coarse "where was this taken" tools draw scrutiny. Rigi's GPS-prior design (aligning photos where the user's own EXIF already gives the location) avoids that framing.

## Q4. Newer 2024–2026 work: foundation models, neural matching against DEM renders, Gaussian-splat terrain

### Takeaway
There is little mountain-specific activity. The notable 2026 item is USC's **LTM** (arXiv 2607.08711). It uses ray-traced pixel-to-pixel alignment between posed iPhone images and outdated DEMs to update terrain and fuel maps for wildfire. It uses no Gaussian splats and has no code release found. Neural matchers (SuperGlue, LightGlue) are now routine for historical **aerial** and map georeferencing, and 3DGS is being used for aerial-ground matching. I found no published tool doing MASt3R or RoMa matching of ground photos against DEM renders.

### Cited Findings
- LTM (Fu, Hu, Chen, Beerel, Raghavan, USC, 2026): uses outdated DEMs as geometric priors, with ray-traced photo↔DEM alignment instead of feature matching. Keeps depth error "within tens of meters" for distant mountains, where UniDepth and DepthPro fail beyond about 100 m. Data comes from the Getty Fire area (iPhone 14 Pro) plus an Unreal Engine simulator. Licensed CC BY-NC-SA and assumes **already-posed** cameras — [arXiv 2607.08711](https://arxiv.org/html/2607.08711)
- 2025 map georeferencing with SuperPoint + SuperGlue and Delaunay consistency — [T&F CaGIS 2025](https://www.tandfonline.com/doi/full/10.1080/15230406.2025.2566789)
- Historical aerial "cold cases" solved with AI matching — [ISPRS JPRS 2023](https://www.sciencedirect.com/science/article/pii/S0924271623003131). Geo-referencing historical Antarctic photos — [IJDE 2024](https://www.tandfonline.com/doi/full/10.1080/17538947.2024.2406384)
- Aerial-ground feature matching via 3D Gaussian Splatting intermediate-view rendering (2025) — [arXiv 2509.19898](https://arxiv.org/pdf/2509.19898)
- Historical Structure from Motion (HSfM): automated historical aerial DEM time series without manual GCPs — [RSE 2022](https://www.sciencedirect.com/science/article/pii/S0034425722004850)
- VLM and agentic geolocation (GeoLocSFT, SpotAgent, GeoX-Bench) is active but works at kilometre scale — [arXiv 2506.01277](https://arxiv.org/pdf/2506.01277); [arXiv 2602.09463](https://arxiv.org/pdf/2602.09463); [arXiv 2511.13259](https://arxiv.org/pdf/2511.13259)

### Inferences
- The automation gains in historical imagery (HSfM, SuperGlue) have gone to **aerial** photos, not oblique ground photos. The oblique-ground, single-photo, DEM-anchored niche is still open.
- LTM is a possible complement rather than a competitor. Once Rigi has a pose, a DEM-prior depth like LTM's "TopoDepth" is the kind of thing that could let Rigi place near-field objects (people, trails) more accurately than raw DEM ray-casting.

## Gaps
- **Not verified or not found:** CALVI; "alpenwelt"; ImageJ "TopoCamera" (no hits; possibly confused with ImGRAFT or other tools); "MountNet"; Saurer et al. 2016 and Tomasi-era horizon code availability; Time Machine Europe projects on oblique photo georeferencing; Google Earth Pro photo-overlay placement workflow; OpenAerialMap (vertical imagery, likely out of scope).
- WSL Monoplotting Tool license, platform, current download availability and last release date were not found.
- MIAS last commit date and recent activity were not visible. The MLP IAT's current status (maintained or legacy) is unclear.
- Smapshot's current (2026) image and participant counts: the homepage fetch returned no stats. The 150k/700 figures date from 2022.
- The TU Wien horizon-orientation code: no public repository found, and the full paper was blocked (403).
- I could not open Čadík's 2025 Brno visual geo-localization document (PDF over 10 MB). It may contain a recent survey of the LOCATE line of work.
- No 2024–2026 paper was found that benchmarks MASt3R, RoMa or LightGlue matching of ground photos against DEM renders, or that builds Gaussian-splat terrain for photo localization. The absence is consistent with the repo SoTA report.
- MapLocNet and OSMLoc licenses were not confirmed.
