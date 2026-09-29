# Rigi owns automatic photo registration, for now

As of September 2026, no shipping product found does what Rigi does. Rigi takes a photo that has already been taken, registers it to the terrain automatically from its iPhone EXIF priors, and says how confident it is in the result. It then fuses the registered photo with map data three ways: overlays, satellite and topo blends inside the photo, and occlusion-correct draping of the photo onto 3D terrain. The consumer incumbents (PeakFinder, PeakVisor) import photos but make the user drag a silhouette into place. PeakLens is the only consumer app that matches skylines automatically, and it works only on the live camera on Android. Science and heritage tools are either manual GCP clickers or research code with no maintained interface. Big platforms (Google, Apple, Niantic) solve urban VPS or landmark naming, not DEM registration. The uniqueness is real, but it is **product integration, not invention**, and several pieces of it are thin:
- The algorithms are a decade old, and automatic DEM georectification has been published before.
- "Tap a few peaks" is a reduced-GCP interface that any incumbent could copy in a release cycle.
- The sub-degree accuracy headline rests on 12–13 photos from one phone.
- On in-the-wild photos, only about 16–22 in 100 are auto-accepted.

Rigi is not ready to launch publicly yet. The repo has no git commits, it relies on tile and Overpass endpoints whose licensing has not been reviewed, the robustness tier is a local Python and Playwright prototype, and there is no iOS rendering path. The recommended sequence has four steps:
1. Fix licensing, reproducibility and measurement now.
2. Ship a share-link web beta built around "your photo, registered and explained".
3. Win two or three B2B pilots where geometric truth has a budget: mountain railways and DMOs, OSINT and verification, and science monitoring.
4. Later, sell registration as a service for webcam and archive networks, rather than competing in the crowded $5–40/yr consumer peak-ID niche.

## Every competitor stops one step short of automatic post-hoc registration

The consumer market has two established specialists, and both leave alignment to the user. **PeakFinder** (Fabio Soldati, since 2010, $4.99 one-off, 4.7★ from 12,000+ iOS ratings) can "import any image from other sources." Its panorama is aligned to the compass, and fine-tuning means you "drag the panorama display to the desired direction". The manual does not mention reading EXIF direction or FOV ([PeakFinder manual](https://www.peakfinder.com/mobile/manual/); [App Store](https://apps.apple.com/us/app/peakfinder/id357421934)). **PeakVisor** (Routes Software SRL, self-financed) is the closest functional rival. It offers free photo import on both web and mobile, a 3D model with huts and lakes, and a subscription that rose to **$39.99/yr** in June 2025. Its own tutorial still tells users to "adjust the rendered 3D terrain panorama to perfectly match horizon in the photo" ([PeakVisor tutorial](https://peakvisor.com/en/news/identify_mountains_in_photos.html); [pricing update](https://peakvisor.com/en/news/2025-pricing-update.html)). Store copy mentions "automatic peak identification," but the vendor's own documentation contradicts that, so treat PeakVisor as manual until shown otherwise. **PeakLens**, a Politecnico di Milano research spin-out, is the only consumer app with peer-reviewed automatic alignment. A CNN extracts the skyline and aligns it to a DEM-rendered panorama to correct the compass ([Fedorov et al. 2016](https://link.springer.com/chapter/10.1007/978-3-319-40621-3_21); [peaklens.com](https://www.peaklens.com/)). It is Android-only and live-camera-only, it has no manual correction, and it publishes no accuracy figure ([Alti-Mag review](https://www.alti-mag.com/en/outdoor-activities/best-apps-identify-mountain-peaks)).

The rest of the consumer field is weaker still. AR AlpineGuide, SummitPeek, PeakID and Outdooractive's Skyline all state that they rely on GPS, compass and gyro. Outdooractive itself quotes compass accuracy of **±3°** and warns about magnetic cases ([Outdooractive](https://www.outdooractive.com/en/knowledgepage/identify-peaks-lakes-and-places-with-skyline-augmented-reality/44736566/)). Users complain about exactly this: compass error is a recurring PeakFinder complaint, with offsets reported up to 90°. The large navigation platforms (AllTrails, Gaia GPS, Komoot) have no photo peak identification. **FATMAP**, the best consumer 3D-terrain product, was shut down by Strava on 1 October 2024 ([Strava press](https://press.strava.com/articles/fatmap-is-transitioning-to-strava)). A 2025–26 wave of cheap iOS "Mountain Identifier" apps classifies photos with generic AI, including Gemini, and returns a name and trivia, not a registered overlay. Their pricing is aggressive: Peak Lens charges $1.99–6.99/week ([App Store](https://apps.apple.com/us/app/mountain-identifier-peak-lens/id6752770531)).

Rigi's own measurements speak to that pain point. On its ground-truth iPhone set, the phone prior alone has a median yaw error of **3.31°, max 10.28°**. The recommended CPU cascade brings that to a **0.20° median, with 11 of 12 correct accepts and 0 false accepts** in under a second ([leaderboard](leaderboard.md)). Under ±15° synthetic compass offsets, the fused skyline and render-match tier stays within 1° in **33 of 33** cases ([fusion](fusion.md)).

| Player | Photo input | Alignment | Draping / in-photo map blend | Camera model exported | Price |
|---|---|---|---|---|---|
| PeakFinder | Import + live | Compass + manual drag | No | No | $4.99 one-off |
| PeakVisor | Import (web + mobile) + live | Manual drag and tilt | Outline and labels only (unverified beyond) | No | Free photo tool; $39.99/yr Pro |
| PeakLens (PoliMi) | Live only, Android | Automatic CNN skyline | No | No | Free |
| Outdooractive Skyline, AR AlpineGuide, SummitPeek | Live | Compass / GPS only | No | No | €2.50/mo to free with ads |
| AI "Mountain Identifier" apps | Photo | None (image classification) | No | No | Weekly subscriptions |
| **Rigi** | Existing photo (web) | **Automatic, with confidence; 1–3 peak pins; drag** | **Yes: blend, drape, multi-photo roll** | **Yes: COLMAP, KMZ, XMP, pose JSON** | n/a |

## Scientists and archives click points by hand; platforms own the ingredients

The non-consumer world splits into three groups, and none combines automation with a usable tool. The first group is **human-in-the-loop monoplotters**, which are accurate but slow:
- **Smapshot** (HEIG-VD) needs at least six clicked correspondences per image. Volunteers have georeferenced **150,000+** historical photos this way, the collection includes swisstopo's, and the results are draped on a 3D globe behind an open API ([FOSS4G 2022](https://talks.osgeo.org/foss4g-2022-academic-track/talk/YXFEWL/); [smapshot-api](https://github.com/MediaComem/smapshot-api)).
- The **WSL Monoplotting Tool** reaches under 3 m mean displacement over 121 control points ([Stockdale 2015](https://www.erichiggs.ca/uploads/4/5/2/9/45292581/applied_geography_2015_stockdale.pdf)).
- **Pic2Map** 4.0 shipped for QGIS 4 in June 2025 ([QGIS plugins](https://plugins.qgis.org/plugins/Pic2Map/)).
- The Mountain Legacy Project's **MIAS** matches a "virtual photograph" by hand against 120,000+ survey plates ([Wright et al. 2024](https://onlinelibrary.wiley.com/doi/full/10.1111/tgis.13229)).
- **ImGRAFT** and photogeoref do the same with GCPs for glaciology ([ImGRAFT](https://gi.copernicus.org/articles/4/23/2015/); [photogeoref](https://github.com/jgcmeteo/photogeoref)).

The second group is **automatic research methods with no product**. TU Wien's horizon-based orientation matched manual accuracy on **129 of 204 (63%)** historical Alpine images and won a 2022 best-paper award, but no code was found ([ADS](https://ui.adsabs.harvard.edu/abs/2022OJPRS...600026M/abstract)). LandscapeAR and CrossLocate are research repositories ([LandscapeAR](https://github.com/brejchajan/LandscapeAR); [CrossLocate](https://github.com/JanTomesek/CrossLocate)). The third group is **coarse geolocators** such as PIGEON, GeoCLIP and GeoSpy. They work at kilometre scale and return no pose ([PIGEON](https://arxiv.org/abs/2307.05845)).

The stated pain point in the science literature is the one Rigi addresses. Historical terrestrial images "are largely unused for quantifying environmental changes because of the difficult and time-consuming estimation of unknown camera parameters" ([Mikolka-Flöry 2022](https://ui.adsabs.harvard.edu/abs/2022OJPRS...600026M/abstract)).

Big platforms do not solve the problem, but they hold every ingredient. **Google's ARCore Geospatial** VPS works only where Street View exists ([Google Developers Blog](https://developers.googleblog.com/en/make-the-world-your-canvas-with-the-arcore-geospatial-api/)). Apple's location anchors cover a list of cities ([ARGeoAnchor](https://developer.apple.com/documentation/arkit/argeoanchor)). **Niantic Spatial's VPS 2.0** (April 2026) claims global reach "without prior scanning" but only as "3DoF" drift correction, with centimetre accuracy only in scanned areas ([Auganix](https://www.auganix.org/ar-news-nianctic-scaniverse-vps-2-0/); [GeekWire](https://www.geekwire.com/2026/from-pokemon-go-to-physical-ai-niantic-spatial-unveils-its-global-3d-mapping-platform/)). Google Lens returns one landmark card per photo. Google Earth, however, now ships global 20/40 m contours and Gemini-grounded image generation ([Google Earth blog](https://medium.com/google-earth/new-year-new-google-earth-major-upgrades-for-faster-sustainable-data-driven-decisions-in-2026-e6a835d8cb30); [Android Authority](https://www.androidauthority.com/google-earth-ai-image-generation-3692696/)). Apple's iOS 26 **Spatial Scenes** turns any photo into hallucinated-depth parallax ([MacRumors](https://www.macrumors.com/how-to/ios-3d-lock-screen-effect-spatial-scenes/)). That has taught consumers to expect a photo to "become 3D" without delivering geographic truth.

At enterprise scale, **Vantor's Raptor** (formerly Maxar) fuses a drone camera with 3D terrain for GPS-denied positioning. That confirms the technique has value, but in defence ([BusinessWire](https://www.businesswire.com/news/home/20251001760322/en/Vantor-Rebrands-from-Maxar-Intelligence-Unveils-AI-Powered-Platform)). On the B2B side, **Panomax** (800+ webcams in 24 countries) sells "Mountain Labelling" on live 360° images. The available sources suggest the labels are set up once per fixed camera rather than registered automatically ([Panomax FAQ](https://www.panomax.com/en/faq); [Digitur](https://digitur.no/en/2025/03/05/we-are-now-a-panomax-partner/)). **Portenier et al. (2020)** already published automatic, GCP-free georectification of Swiss Alpine webcams from a DEM for snow mapping ([The Cryosphere](https://tc.copernicus.org/articles/14/1409/2020/)).

The most likely disruption is Google adding "label the peaks in this photo" to Photos or Lens. Nothing has been announced, and pixel-accurate registration of dozens of peaks, contours and trails is a different job from landmark naming. Bellingcat found that even the best LLM geolocators hallucinate and answer at region level ([Bellingcat 2025](https://www.bellingcat.com/resources/how-tos/2025/06/06/have-llms-finally-mastered-geolocation/)).

## What is genuinely unique, and where the claim is thin

Rigi's defensible position is the whole closed loop plus honesty about when it fails. No single part is a moat by itself. The table below grades each claim against the evidence.

| Claim | Strength | Why |
|---|---|---|
| Automatic registration of an *existing* photo from EXIF GPS, compass and the Apple MakerNote gravity vector, parsed in the browser | **Strong today, easy to erode** | No consumer product does it post-hoc. The gravity prior comes from a hand-written MakerNote parser ([exif.ts](../src/lib/upload/exif.ts)). Prior art exists: Fedorov's 2013 PoliMi work did post-hoc edge matching for geotagged social photos ([arXiv 1508.02959](https://arxiv.org/abs/1508.02959)), and PeakLens owns the live version |
| Calibrated confidence: fused HIGH precision 0.97, product-rule accepts all correct, blind pre-registered benchmark | **Strong and rare** | No vendor publishes any photo-alignment accuracy. Rigi has a frozen dev/test split, pre-registration and blinded verifier packs ([bench-wild](bench-wild.md); [test-results](test-results.md)). This is the most credible B2B asset |
| Occlusion-correct draping (range buffer used as a shadow map), extended to many photos at once in camera rolls | **Strong** | No consumer app drapes user photos. Smapshot drapes but is manual. Off-the-shelf libraries lack the occlusion test ([multi-drape-layer.ts](../src/lib/roll/map/multi-drape-layer.ts)) |
| Satellite, topo and relief blends *inside* the photo, with people kept in front | **Strong, low barrier** | Uncontested in the surveyed apps, but it follows directly from having a pose. Google Earth "Create image" is the adjacent generative threat |
| Interoperable camera-model exports (COLMAP, KMZ PhotoOverlay, XMP, pose JSON) | **Moderate, strategically important** | Unique among consumer apps. Bridges into GIS, science and OSINT workflows that want a pose initialiser |
| "Tap 1–3 peaks" correction via LM solve | **Weak as a moat** | Missing from the market today, but it is a reduced GCP interface. PeakVisor and PeakFinder already have drag UIs and could add it in one release |
| Sub-degree accuracy "beats SoTA" (0.22° vs Porzi's 1.23°) | **Weak / at risk** | It rests on **12 photos** with 0.2–0.4° ground-truth noise, all metadata-rich, against harder academic sets. The leaderboard's own caveats say so ([leaderboard](leaderboard.md)) |
| Robustness on arbitrary photos | **Weak** | Only 53/100 wild Swiss photos are solvable by any method. On the held-out test the service gets 29/50 correct, and the product rule accepts 11 of the 34 recoverable photos. The fused tier takes 35–85 s per photo and runs only locally ([test-results](test-results.md); [matcher-service](matcher-service.md)) |
| The algorithms themselves | **Not unique** | Skyline alignment and render-and-match follow Baboud, Baatz, Brejcha, LandscapeAR and TU Wien. Automatic DEM georectification of Alpine webcams was published in 2020 ([The Cryosphere](https://tc.copernicus.org/articles/14/1409/2020/)) |
| Data | **No moat** | Mapterhorn (BSD-3 code, per-source open data) and swisstopo OGD are open to everyone ([Mapterhorn](https://github.com/mapterhorn/mapterhorn); [swisstopo OGD](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices)) |

Three structural facts limit these claims. First, validation is almost entirely Swiss. The wild set is 100 Swiss photos, and the non-Swiss subset of data_v3 (14 photos) has not been evaluated ([data_v3 README](../tools/bench/data_v3/README.md)). Outside Switzerland and France the near-field DEM is coarser, and Copernicus has about 48 m RMSE on steep Alpine slopes, which is where near-ridge failures concentrate. Second, the core renderer needs float32 colour targets that iOS WebGL2 lacks ([implementation_summary](../research_notes/implementation_summary.md)). Phones take most mountain photos, so this is the biggest platform gap. Third, the input Rigi is best at, an iPhone photo with GPS, heading and gravity, is fragile in the browser. Since iOS 16.4, Safari's picker strips GPS unless the user enables a location toggle ([WebKit bug 257534](https://bugs.webkit.org/show_bug.cgi?id=257534)).

The durable strategy is therefore not "we invented automatic alignment." It is to own the **evaluation-backed, confidence-gated registration service and the outputs built on it**, and to turn accumulated corrections into a labelled dataset that competitors lack.

## Money sits where geometric truth has a budget

Consumer willingness to pay for "what peak is that?" is low. The range runs from PeakFinder's $4.99 one-off to PeakVisor's $39.99/yr, while navigation leaders bundle 3D features into $60–80/yr tiers: AllTrails Peak is $80/yr, and Komoot Premium is £/$59.99/yr ([TechCrunch](https://techcrunch.com/2025/05/12/alltrails-debuts-a-80-year-membership-that-includes-ai-powered-smart-routes); [DC Rainmaker](https://www.dcrainmaker.com/2025/03/komoots-expanded-paywalls-trying-to-make-sense-of-it.html)). In Switzerland, the free swisstopo app has **1.2M downloads and about 75,000 uses per day**, which caps what anyone can charge for base maps ([swisstopo](https://www.swisstopo.admin.ch/en/an-app-as-smart-as-swisstopo)). Exits in this space are feature acquisitions folded into a bigger subscription: FATMAP into Strava, and Komoot into Bending Spoons for a reported €300M, followed by about 85% layoffs ([BikeRadar](https://www.bikeradar.com/news/komoot-acquisition)). Consumers are Rigi's funnel and viral loop, not its revenue core.

Four B2B segments show real pull.

**Mountain railways and DMOs** have volume and budgets. Rigi Bahnen alone carried **1.02M first-time visitors** in 2025 on CHF 39.9M net revenue, and 30% of its guests are international ([schweizeraktien.net](https://www.schweizeraktien.net/blog/2026/04/28/rigi-bahnen-viertes-rekordjahr-in-folge-dank-jubilaeum-und-gutem-wetter-72876/)). Jungfrau had 3.91M visitors ([swissinfo](https://www.swissinfo.ch/eng/various/jungfrau-railways-with-record-guest-numbers-and-new-financial-targets/90741519)). Operators already pay recurring fees for labelled webcam panoramas. A QR code at the summit reading "label your own photo" is a white-label web product that needs no app install. The app shares its name with the mountain and with Rigi Bahnen's brand, which is an opening for a partnership. It is also a trademark question to settle before launch; that is my inference, not researched.

**OSINT and verification** has proven demand. Bellingcat teaches PeakVisor for geolocation through a fully manual workflow in which panoramas are "strongly affected by the horizontal field of view setting" ([Bellingcat](https://www.bellingcat.com/resources/2023/07/13/more-than-mountaineering-using-peakvisor-for-geolocation/)). GeoSpy sold police licences at **$5,000 each** before closing public access after stalking reports ([404 Media](https://www.404media.co/cops-are-buying-geospy-ai-that-geolocates-photos-in-seconds/)). The segment needs a no-GPS mode and global coverage, and it carries reputational risk. Journalists and NGOs are a safer first customer than police.

**Science and monitoring** (WSL, SLF, glaciology, Mountain Legacy Project, Smapshot) has clear technical need but grant-sized budgets. Its value is credibility, citations and data partnerships. Rigi's automatic pose makes a natural **initialiser for Smapshot- or MIAS-style workflows**. TU Wien counted even rough automatic poses as useful starting points for 22% of its images.

**Webcam networks** (Panomax, Roundshot, feratel) own the resort relationships. Panomax and Roundshot are better treated as channels or acquirers for "registration as a service" than as competitors.

Guides and ski tourers are a small but influential group. Slope-angle shading drawn on a photo of the face is not offered by White Risk or Skitourenguru, which work on 2D maps. SAR is high-value but slow to buy, and Rega's app already transmits GPS. Photographers are hard to reach, and Lightroom plugin distribution is weak ([Adobe dev blog](https://blog.developer.adobe.com/en/publish/2022/07/lightroom-classic-plugin-support-for-the-adobe-exchange-for-creative-cloud-14e4a0f690df)).

## Prioritised roadmap: de-risk first, then pilots, then a registration service

The ordering principle is to remove blockers that would make any launch unsafe, then invest in whatever widens the accept rate at constant precision, because recall is the measured bottleneck. B2B pilots come in parallel, because they validate willingness to pay far better than consumer downloads.

### Near term (0–3 months): make it launchable and measurable

| # | Item | Type | Rationale |
|---|---|---|---|
| 1 | **Commit the repo, add CI with a numeric regression gate** (leaderboard, Classic pixel-identical, tsc and Biome clean) | Technical | There are no git commits yet, several sessions edit one tree, and the 09-25 snapshot had 2 tsc errors and 94 Biome errors ([leaderboard](leaderboard.md)). Everything else depends on reproducibility |
| 2 | **Licensing review and swaps before any public URL** | Licensing | See the risk register below. Esri World Imagery, the public OSM tile server and the public Overpass mirrors are used without a documented review ([terrain.ts](../src/lib/terrain.ts); [overpass.ts](../src/lib/overpass.ts)). Keep Google 3D Tiles out entirely |
| 3 | **Measure the target input at scale**: 100+ iPhone photos *with gravity*, several regions, plus the 14 non-Swiss data_v3 photos | Technical / GTM | The headline accuracy rests on 12–13 photos from one phone. A publishable accuracy number is a marketing asset, since no competitor publishes one |
| 4 | **Finish consolidation** (P2–P5), complete the rename, lazy-load models | Technical | There are duplicate LM, declutter and visibility code paths, and "Summit Lens" strings remain. Cold load is 3–5 s against a 59.5 MiB earlier payload |
| 5 | **Share-link web beta**: a labelled PNG with a subtle watermark plus a link to the interactive view; an upload flow that coaches the iOS location toggle, with a map-pin fallback | Product / GTM | This is the viral loop. Post-hoc web avoids the App Store's AI-identifier race. The Strava API bars feed integration ([Strava](https://press.strava.com/articles/updates-to-stravas-api-agreement)) |
| 6 | **Make low confidence a first-class UX**: "please confirm with 2 taps", and log every correction as a labelled sample | Product | Converts the weak recall into a data flywheel. Copying the tap UI is easy; copying a correction dataset is not |

### Mid term (3–9 months): widen recall, reach phones, land pilots

| # | Item | Type | Rationale |
|---|---|---|---|
| 7 | **Deployable robustness tier**: replace the Playwright-driven renderer with a native or headless GPU render path, then host it as a queue-backed service | Technical | Fused gets 50/53 solvable wild photos correct against 25 for the cascade, but it runs only on a Mac at 35–85 s per photo ([matcher-service](matcher-service.md)) |
| 8 | **Recall work at constant precision**: stage-1 search, no-heading and haze cases, then the ranked matcher ideas (LoMa, a GeoCalib gravity and FOV prior, DINO yaw correlation) | Technical | Failures are "search failures, not small misfits". Heading-unknown is recoverable on only 38% of photos, and cloud on the skyline on 53% ([bench-wild](bench-wild.md); [matching_v2_research](../research_notes/matching_v2_research.md)) |
| 9 | **iOS rendering path** (half-float or WebGPU geometry buffers) | Technical | Phones are where the photos are, and this is the largest platform gap |
| 10 | **Full GCP / no-GPS mode** (6+ photo-to-map clicks, Smapshot-style), with a known-station import | Product | Unlocks archives (swisstopo's ~57k plates record station coordinates) and OSINT. This rung does not exist yet |
| 11 | **Pilots**: one Swiss railway or DMO (QR summit experience), one OSINT or newsroom partner (Bellingcat toolkit listing, workshop), one science partner (WSL, SLF or MLP) using pose export as the initialiser | GTM | Tests willingness to pay in the three segments with budgets. Rigi Bahnen is the obvious first conversation |
| 12 | **Public pose API and embeddable viewer** | GTM | Serves pilots and science users. Mirrors PeakFinder's panorama API but with a registered photo |

### Later (9–18+ months): registration as a service, beyond Switzerland

| # | Item | Type | Rationale |
|---|---|---|---|
| 13 | **Webcam and archive registration service**: automatically register fixed and panning cameras, keep labels correct under drift, and derive snow-line and cloud products | GTM / Technical | Partners with Panomax, Roundshot or feratel instead of competing with them. Portenier 2020 shows the science demand |
| 14 | **Global coverage with validated accuracy**: lidar DTMs where licences allow (3DEP, national agencies), and per-region accuracy reporting | Data / Technical | OSINT requires global coverage. DEM quality drives near-ridge failures |
| 15 | **Measurement outputs**: digitise on the photo to get GIS vectors (browser monoplotting), per-pixel XYZ with uncertainty, and slope-angle shading on the photo for guides | Product | Moves Rigi toward the WSL "science-grade" bar (<15 m) and a professional niche |
| 16 | **Depth-aware near field**: permissively licensed monocular depth to mask huts, trees and people from the drape | Technical | This is a known open issue in the In map view. Check each checkpoint's licence, because many are non-commercial |
| 17 | **Native or AR app only if pilots demand live use**, plus a patent and prior-art check (e.g. US 8432414 "automated annotation of a view") | Product / Legal | Live AR is PeakLens and PeakVisor territory. Enter it only with a reason |

Four things are worth avoiding: a standalone consumer subscription priced against PeakVisor, a race with the weekly-subscription AI identifier apps, a Strava or Komoot feed integration, and early sales to law enforcement before the ethics and coverage story is settled.

### Licensing and data risk register

| Asset | Status | Action |
|---|---|---|
| Mapterhorn DEM | Code BSD-3; data under each source's licence ([Mapterhorn](https://github.com/mapterhorn/mapterhorn)) | Implement the per-source attribution list. Ask about the hosted-tile usage policy for production traffic, or self-host the PMTiles |
| swisstopo SWISSIMAGE, pixelkarte, swissALTI3D | OGD, free commercial use with "© swisstopo" attribution ([swisstopo](https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices)) | Keep. This is the safest part of the stack |
| Esri World Imagery (fallback outside CH) | Terms for derived composites **not verified** | Review the terms or replace it before exporting blends that contain Esri pixels |
| OSM tile server and public Overpass mirrors | Community infrastructure with usage policies; the repo has no review | Move to a commercial or self-hosted tile provider and a self-hosted Overpass or pre-extracted region data |
| Google Photorealistic 3D Tiles | Terms forbid "image analysis, machine interpretation" and derived measurement ([Google policies](https://developers.google.com/maps/documentation/tile/policies)) | Never use for alignment or exports |
| Models: MediaPipe selfie_multiclass, U²-NetP (MIT), ALIKED + LightGlue, libheif (LGPL) | MediaPipe licence not recorded; LGPL needs dynamic linking and notices | Record licences in-app. Avoid non-commercial weights: DA3 large variants, MASt3R, OrienterNet (CC-BY-NC) ([OrienterNet](https://github.com/facebookresearch/OrienterNet)) |
| Name "Rigi" | Shared with a mountain and with Rigi Bahnen's brand (inference) | Run a trademark check, or turn it into a partnership |
| Privacy | GeoSpy shows the backlash risk ([404 Media](https://www.404media.co/the-powerful-ai-tool-that-cops-or-stalkers-can-use-to-geolocate-photos-in-seconds/)) | Position Rigi as registering *your own* geotagged photos. Gate no-GPS geolocation features |

## Conclusion

Rigi's advantage is a timing gap, not a technical moat. The field moved from inventing mountain-registration algorithms to assembling commodity components, so any incumbent with a DEM renderer (PeakVisor above all) or any platform with terrain data (Google) could close the automatic-alignment gap. What competitors cannot quickly copy is a measured, confidence-gated registration pipeline with a blind benchmark, a growing set of user-corrected poses, and B2B relationships in the places where geometric truth is paid for. Those three assets, not the skyline solver, deserve the next year of investment.

Two numbers frame the decision. In-the-wild auto-accept is about 20%, while accuracy on the intended iPhone input is sub-degree but measured on a dozen photos. Rigi is therefore strongest as a service for people who control how their photos are captured: railways, webcam networks, field scientists and trip reporters. It is weakest as a general "identify any mountain photo" app. Building around the controlled-capture segments first, while the recall work matures, uses the evidence Rigi actually has instead of the headline it would like to have.
