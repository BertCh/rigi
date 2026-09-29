# Input data for georeferencing iPhone mountain photos: iPhone metadata, DEM sources, geodesy/optics (as of Sept 2026)

Scope note: research was done with roughly 22 web searches and fetches. Primary sources used where possible: exiftool tag docs, Apple Developer docs and forums, WebKit Bugzilla, AWS Open Data registry, Tilezen/Mapbox docs, Google Maps Platform policies, peer-reviewed DEM accuracy studies. Items labelled "Inference" are the researcher's engineering judgement, not sourced facts.

## 1. What pose/position metadata do iPhones write (EXIF/XMP/MakerNote), and how accurate is it?

### Takeaway
iPhones write a rich GPS block: lat/lon, altitude (above mean sea level on EGM2008, **not** ellipsoidal), GPSHPositioningError, GPSImgDirection referenced to **True** north, and GPSSpeed/DestBearing. The Apple MakerNote tag 0x0008 **AccelerationVector** holds the CoreMotion gravity vector in the phone frame, which gives camera **pitch and roll**. Together with GPSImgDirection (yaw), that is a full orientation prior. Compass heading is the weakest prior: expect errors of several degrees or more. Altitude is also noisy, often ±10–20 m or worse.

### Cited Findings
- Apple MakerNote tag 0x0008 **AccelerationVector** stores the phone's acceleration in three axes: "positive X is toward the left side, positive Y is toward the bottom, and positive Z points into the face" of the device. — [ExifTool Apple tags](https://exiftool.org/TagNames/Apple.html)
- Other Apple MakerNote tags: AFStable (0x0007), HDRImageType (0x000a; 3 = HDR, 4 = original), BurstUUID (0x000b), FocusDistanceRange (0x000c), ContentIdentifier (0x0011, the Live Photo / MediaGroupUUID pairing), ImageUniqueID (0x0015), HDRHeadroom (0x0021), PhotoIdentifier (0x002b), CameraType (0x002e: back wide-angle / back normal / front), FocusPosition (0x002f), HDRGain (0x0030), AFMeasuredDepth (0x0038, time-of-flight AF), AFConfidence (0x003d). — [ExifTool Apple tags](https://exiftool.org/TagNames/Apple.html)
- AccelerationVector is "CoreMotion's gravity vector at capture, in the phone's frame". It is stored as three signed rationals, and one project uses it to fix the zenith direction relative to the frame centre (tilt relative to the horizon). Caveats from that implementation: work out how the phone was held from the tilt vector plus the image aspect, not from the Orientation tag; for mirrored orientations (2, 4, 5, 7), negate the left-right component. Android phones tested (Pixel, Samsung) had no equivalent tag. — [cwage/asterism PR #141](https://github.com/cwage/asterism/pull/141)
- Example raw value: `["-5691/6191","-677/22055","-1538/3835"]` (roughly unit magnitude, in g). — [photometadata.net Apple guide](https://www.photometadata.net/cameras/apple) (aggregator); see also the dedicated viewer [raleighlittles/iOS-Advanced-EXIF-Data-Viewer](https://github.com/raleighlittles/iOS-Advanced-EXIF-Data-Viewer) and the Go parser [goexif-apple-makernotes](https://github.com/mostlygeek/goexif-apple-makernotes)
- A real iPhone sample includes `GPSHPositioningError = 3.5355…` (metres), `GPSImgDirection = 240.48…`, and `GPSImgDirectionRef = T` (True north). — [Harley Turan, Exploring EXIF](https://hturan.com/writing/exploring-exif)
- GPSImgDirectionRef can be 'T' (true) or 'M' (magnetic). — [exiftool GPS.pm](https://github.com/exiftool/exiftool/blob/master/lib/Image/ExifTool/GPS.pm)
- Some users report GPSImgDirection values that do not match the actual camera direction. — [Apple Community thread](https://discussions.apple.com/thread/2129716); CoreLocation heading errors are also discussed in [Apple forum 756943](https://developer.apple.com/forums/thread/756943)
- Compass accuracy is affected by magnetic interference (even EarPods magnets). One user measured a 3–5° difference between holding the phone vertically and horizontally. — [DPReview forum](https://www.dpreview.com/forums/threads/is-there-much-error-in-iphone-compass.4724309/) (anecdotal)
- **Altitude datum:** an Apple engineer states that "CoreLocation altitude is indeed altitude above mean sea level (MSL), so it is a geoidal altitude. The reference geoid is currently EGM2008." This differs from Android, which reports ellipsoidal heights. — [Apple Developer Forums 125281](https://developer.apple.com/forums/thread/125281)
- Conflicting claim: a glossary site says EXIF GPSAltitude is WGS84-ellipsoidal and that smartphones often show "±10–20 m altitude error even when horizontal GPS is accurate to ±5 m". — [TarmacView glossary](https://www.tarmacview.com/glossary/exif/). The ellipsoidal claim is **contradicted** for iPhone by the Apple engineer above. The error magnitude is plausible but comes from a secondary source.

### Inferences
- The orientation prior is the Apple AccelerationVector (pitch/roll) plus GPSImgDirection (yaw, true north). In the camera frame with X left, Y down, Z into the screen (the back camera looks along −Z), pitch ≈ asin(−g_z/|g|) relative to the horizon and roll ≈ atan2(g_x, g_y). Signs must be checked empirically against known horizon photos. Tilt priors are probably accurate to about 1°, as accelerometer gravity usually is, but this is unverified here.
- The EXIF standard stores altitude "above sea level" via GPSAltitudeRef, so iPhone EXIF GPSAltitude is most likely MSL on EGM2008 too, matching CoreLocation. That is the same vertical datum as Copernicus DEM, which is convenient: compare directly with DEM values. Then add the camera height above ground (~1.5 m), or better, snap to the DEM surface when the GPS altitude is far off.
- The yaw prior should be treated as ±5–15° in mountains (magnetic anomalies, calibration). Search yaw fully and use the prior only for weighting.

### Gaps
- No authoritative published figures were found for iPhone compass (GPSImgDirection) accuracy or GPS altitude error specifically in mountain terrain.
- No source confirmed whether the barometer or fused altitude feeds the EXIF GPSAltitude, or whether the ellipsoidalAltitude (iOS 15+) API is ever written to EXIF.
- No source confirmed whether AccelerationVector is written for every lens and mode (Pano, Portrait, ProRAW DNG, front camera) or on iPhone 17-era firmware. Test sample files.
- GPSDestBearing/GPSSpeed semantics on iPhone and Apple XMP namespaces (HDR gain map, depth) were not researched in depth.

## 2. Deriving intrinsics (focal length, crops, distortion) and on-device calibration (AVFoundation / ARKit)

### Takeaway
For ordinary JPEG/HEIC, compute f_px = FocalLengthIn35mmFilm / 36 × image_width_px (landscape long side; use the diagonal form for non-3:2 aspects). Apple writes an effective 35 mm-equivalent value, which should already account for crop and zoom. Geometric distortion correction is **on by default** in iPhone capture pipelines, so a pinhole model is a reasonable prior. Exact intrinsics and distortion LUTs are only available to native apps via AVCameraCalibrationData. ARKit geo-tracking works only in Apple-mapped cities, so it is irrelevant for mountains.

### Cited Findings
- Geometric distortion correction is enabled by default. Developers set `isGeometricDistortionCorrectionEnabled = false` and `isCameraCalibrationDataDeliveryEnabled = true` to get raw images with a known intrinsic matrix. The ultra-wide lens's `lensDistortionLookupTable` contains trailing zeros that cause artefacts near edges if used naively. — [Apple Developer Forums 775111](https://developer.apple.com/forums/thread/775111)
- AVCameraCalibrationData provides the intrinsic matrix, lensDistortionLookupTable (radial distortion for rectifying) and inverseLensDistortionLookupTable (to re-apply distortion), plus a lens distortion centre that can differ from the principal point. A reference implementation is in AVCameraCalibrationData.h. — [Apple docs lensDistortionLookupTable](https://developer.apple.com/documentation/avfoundation/avcameracalibrationdata/lensdistortionlookuptable); [inverse LUT](https://developer.apple.com/documentation/avfoundation/avcameracalibrationdata/inverselensdistortionlookuptable); [header](https://github.com/xybp888/iOS-SDKs/blob/master/iPhoneOS13.0.sdk/System/Library/Frameworks/AVFoundation.framework/Headers/AVCameraCalibrationData.h)
- iPhone 17 Pro: three 48 MP rear cameras. The telephoto is 100 mm-equivalent (4x) at ƒ/2.8 (tetraprism), with a 12 MP "optical-quality" 8x (200 mm) sensor crop. — [DIYPhotography](https://www.diyphotography.net/iphone-17-pro-camera-specs-complete-technical-breakdown/); official specs at [Apple Support 125090](https://support.apple.com/en-us/125090)
- ARKit geo-tracking (ARGeoTrackingConfiguration / location anchors) matches the camera feed against Apple's downloaded city map data. It is limited to supported metro areas (50+ US cities, plus London and some others); use `checkAvailability(at:)`. — [Apple docs](https://developer.apple.com/documentation/arkit/argeotrackingconfiguration); [WWDC21 ARKit 5](https://developer.apple.com/videos/play/wwdc2021/10073/)

### Inferences
- Horizontal FOV = 2·atan(36/(2·f35)) for a 3:2 frame. iPhone sensors are 4:3, and a 35 mm "equivalent" is conventionally matched on the diagonal (43.27 mm). The more robust formula is f_px = f35 × sqrt(W² + H²) / 43.27. Across 4:3, 16:9 and 1:1 crops, this gives consistent results only if Apple recomputes f35 per crop. Verify against a calibration shot.
- 2x (crop of the 48 MP main sensor), 8x (crop of the tele), and digital zoom should all show up in FocalLengthIn35mmFilm and in a changed LensModel string (e.g. "iPhone 17 Pro back triple camera 6.765mm f/1.78"). Treat f_px as ±2–3 % uncertain and refine it in the solver.
- Pano mode images are cylindrical stitches. Their EXIF focal length describes the source lens, not the panorama geometry, so they need a cylindrical camera model. Their horizontal FOV must be estimated (e.g. from width / (f_px · 2π)). No source was found.
- ProRAW DNG: expect standard DNG OpcodeList (WarpRectilinear / GainMap) and the same EXIF/MakerNote. Apps rendering raw DNG without applying opcodes would see uncorrected distortion. Not verified.

### Gaps
- No source confirmed how Apple sets FocalLengthIn35mmFilm for 2x crop, 48 vs 24 vs 12 MP outputs, Portrait mode, or panoramas.
- No official statement was found on whether ultra-wide (0.5x) JPEG/HEIC output is fully rectilinear. Residual distortion likely remains near the edges.
- DNG OpcodeList contents on iPhone ProRAW were not verified.

## 3. JS/TS libraries for HEIC + EXIF + Apple MakerNote in the browser

### Takeaway
Only ExifTool (via WebAssembly) reliably decodes Apple MakerNote tags such as AccelerationVector. exifr and ExifReader parse HEIC EXIF/GPS/XMP well, but they do not document Apple MakerNote decoding. The practical pattern: use exifr for fast GPS/focal fields, and either the WASM ExifTool or a small hand-written Apple MakerNote IFD parser (the "Apple iOS\0" header followed by a standard IFD) for tag 0x0008.

### Cited Findings
- ExifReader supports JPEG, JPEG XL, TIFF, PNG, HEIC, AVIF, WebP and GIF, including Exif, IPTC, XMP, ICC and MPF. MakerNote support is "some" and covers only "some of the Canon-specific and Pentax-specific tags". Apple is not listed. — [ExifReader GitHub](https://github.com/mattiasw/ExifReader)
- exifr skips MakerNote and UserComment by default. It supports HEIC and can return the MakerNote as raw data. — [exifr npm](https://www.npmjs.com/package/exifr); [exifr GitHub](https://github.com/mikekovarik/exifr)
- `@uswriting/exiftool` runs full ExifTool in the browser or Node via WebAssembly using the zeroperl Perl runtime, with no native binaries. Its API is `parseMetadata` / `writeMetadata`. — [npm](https://www.npmjs.com/package/@uswriting/exiftool); [6over3/exiftool](https://github.com/6over3/exiftool). An alternative is [lucasgelfond/exiftool-web](https://github.com/lucasgelfond/exiftool-web).
- ExifTool's Apple module source is [Apple.pm](https://fossies.org/linux/Image-ExifTool/lib/Image/ExifTool/Apple.pm); a Go reference parser is [goexif-apple-makernotes](https://github.com/mostlygeek/goexif-apple-makernotes).

### Inferences
- The WASM ExifTool payload (Perl runtime plus ExifTool) is likely multiple MB. Lazy-load it or run it server-side with Python (PyExifTool / exiftool binary).
- To display HEIC in non-Safari browsers, you need libheif-js or heic2any to decode. Safari 17+ decodes HEIC natively. (Not re-verified in this session.)

### Gaps
- Exact bundle size and performance of @uswriting/exiftool were not measured.
- No confirmation was found on whether exifr's `makerNote: true` plus a custom parser has been published for Apple tags.

## 4. Browser upload realities: does iOS strip GPS on `<input type=file>`?

### Takeaway
Yes. Since iOS 16.4, photos chosen through a web file input have GPS stripped by default. iOS 17+ added an **Options** menu in the photo picker that lets the user opt in to sending location. WebKit treats this as intended privacy behaviour (resolved "Configuration Changed", Oct 2023). Make the app work without GPS, and tell users to tap Options > Location (or use Files / AirDrop / share-sheet flows).

### Cited Findings
- From iOS 16.4, file-input uploads strip GPS from EXIF regardless of the Most Compatible / High Efficiency setting (earlier, JPEG "Most Compatible" kept it). iOS 17 added an "options" menu in the photo picker that "gives the user control of whether or not location is shared". The bug was closed RESOLVED CONFIGURATION CHANGED on 2023-10-16. A WebKit engineer argued that a site's location permission is not sufficient justification to share photo location. — [WebKit bug 257534](https://bugs.webkit.org/show_bug.cgi?id=257534)
- An older report also covered EXIF stripping when uploading from the iOS photo library. — [WebKit bug 207088](https://bugs.webkit.org/show_bug.cgi?id=207088)
- Developers report that location is removed unless the browser has Location Services with Precise Location. Aggregated claim, weaker evidence. — [namma-indies/app issue #82](https://github.com/namma-indies/app/issues/82)

### Inferences
- Other metadata (FocalLength, MakerNote AccelerationVector) is generally reported to survive; only location is removed. The app should still check for MakerNote survival, because transcoding (HEIC→JPEG via the "Most Compatible" transfer) could drop the MakerNote.
- Fallbacks when GPS is missing: ask the user to drop a pin, use the browser Geolocation API for "I'm standing here now" workflows, or solve location from the skyline.

### Gaps
- iOS 18/26 changes to the PHPicker web flow (e.g. whether "Location" defaults on for some share paths) were not confirmed. No iOS 26-specific source was found.
- Whether MakerNote survives the picker's HEIC→JPEG conversion was not confirmed.

## 5. DEM data sources (global and regional): resolution, accuracy, access, licensing

### Takeaway
The default global choice is **Copernicus GLO-30**: free COGs on AWS, EGM2008 datum, about 4 m global RMSE. But it is an X-band DSM, and errors grow to tens of metres on very steep slopes. FABDEM (bare-earth Copernicus) is non-commercial only. For browser rendering, the easiest option is Terrarium PNG tiles (AWS terrain-tiles, free) or Mapbox/MapTiler terrain-RGB. Google Photorealistic 3D Tiles **must not** be used for analysis or elevation extraction. Use national lidar DTMs (swissALTI3D, 3DEP, etc.) where precision matters near the camera.

### Cited Findings
- **Copernicus DEM on AWS:** `copernicus-dem-30m` (GLO-30 Public, limited coverage) and `copernicus-dem-90m` (GLO-90, complete coverage), in eu-central-1, as Cloud Optimized GeoTIFFs. Free under the Copernicus licence, from the 2021 release, with STAC endpoints and Sinergise as manager. Some GLO-30 tiles for certain countries are not publicly released. Oceans have no tiles. — [AWS Registry Copernicus DEM](https://registry.opendata.aws/copernicus-dem/)
- A newer GLO-30 2024_1 release exists in the Earth Engine catalog. — [Earth Engine GLO30 2024_1](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_DEM_GLO30_2024_1); dataset hub at [Copernicus Data Space Ecosystem COP-DEM](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM)
- Copernicus DEM vertical datum is **EGM2008**; global RMSE is about 4 m; RMSE on selected Chinese terrains is 6.73 m (ICESat-2). — [Tandfonline 2022 China ICESat-2 study](https://www.tandfonline.com/doi/full/10.1080/17538947.2022.2094002); [LuxCarta](https://www.luxcarta.com/blog/10m-dtm-copernicus-glo-30)
- In a large Alpine study, RMSE on **very steep slopes** was 48.44 m for Copernicus GLO-30 and 46.09 m for ALOS AW3D30. — [ResearchGate: GLO-30 vs AW3D30, Alpine area](https://www.researchgate.net/publication/364558357_Global_digital_elevation_models_for_terrain_morphology_analysis_in_mountain_environments_insights_on_Copernicus_GLO-30_and_ALOS_AW3D30_for_a_large_Alpine_area)
- GLO-30, FABDEM and AW3D30 are the least affected by slope among free global DEMs. GLO-30 is the most affected by land cover, because X-band radar penetrates vegetation poorly. — [Tandfonline 2024, FABDEM/COP/NASADEM/AW3D30/SRTM comparison](https://www.tandfonline.com/doi/full/10.1080/17538947.2024.2308734)
- **FABDEM** (forests and buildings removed from Copernicus GLO-30), V1-2, is licensed **CC BY-NC-SA 4.0** with no commercial use; commercial licensing goes through Fathom (FABDEM+). — [Univ. Bristol data.bris](https://data.bris.ac.uk/data/dataset/s5hqmjcdj8yo2ibzi9b4ew3sn); [Fathom FABDEM+](https://www.fathom.global/product/global-terrain-data-fabdem/)
- A GEDTM30 global ensemble DTM at 30 m has also been published. — [GEDTM30 (PMC)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12296579/)
- **Mapzen/Tilezen Terrain Tiles on AWS:** the `elevation-tiles-prod` bucket (us-east-1, EU replica `elevation-tiles-prod-eu`) needs no AWS account. Attribution is required per the joerd attribution.md. — [AWS Registry terrain-tiles](https://registry.opendata.aws/terrain-tiles/)
- Terrain Tiles formats: **Terrarium** PNG (EPSG:3857, 256/260/512/516 px) decoded as `(R*256 + G + B/256) - 32768` metres; **Normal** PNG (RGB = surface normal, alpha = quantised height); **GeoTIFF** 512 px; **Skadi** 1°×1° HGT.gz in EPSG:4326 (int16 big-endian, void = -32768). — [tilezen/joerd formats.md](https://github.com/tilezen/joerd/blob/master/docs/formats.md)
- **Mapbox Terrain-DEM v1:** `height = -10000 + ((R*65536 + G*256 + B) * 0.1)`, data up to z14, 0.1 m increments, 1 px buffer. Sources use mixed vertical datums (NAVD88, EGM96, ODN). Terrain-DEM v1 is only for Mapbox SDKs, not the Raster Tiles API; the original Terrain-RGB v1 is still available. — [Mapbox Terrain-DEM v1 docs](https://docs.mapbox.com/data/tilesets/reference/mapbox-terrain-dem-v1/)
- **Google Photorealistic 3D Tiles** policies forbid extracting or deriving 3D objects; programmatic measurement of heights, distances and elevations; image analysis, machine interpretation and object detection; offline use; and pre-fetching or caching beyond limited terms. — [Google Map Tiles API policies](https://developers.google.com/maps/documentation/tile/policies); [3D Tiles overview](https://developers.google.com/maps/documentation/tile/3d-tiles-overview)
- Google stopped serving 3D Tiles to projects created after 8 July 2025 with EU/EEA billing addresses. — [blosm issue #644](https://github.com/vvoovv/blosm/issues/644) (community report; the EU/EEA terms change should be checked against Google's official announcement)

### Inferences
- Recommended stack: Terrarium (or MapTiler terrain-RGB) tiles in the browser for rendering and a coarse horizon. Server-side, Copernicus GLO-30 COGs, plus national lidar DTMs where available, for exact silhouette rendering. Use GLO-90 or z10–11 tiles for distances over 50 km. Mapzen Terrarium tiles mix SRTM/ETOPO/NED/etc. sources, often on EGM96 heights; the difference from EGM2008 is sub-metre to a few metres, negligible for peak labelling.
- DSM versus DTM matters little for skylines above the treeline. It matters for forested foregrounds, where a DSM can occlude peaks by tree height (~20–30 m).
- Mapbox Terrain mixes datums, so do not use it for absolute-height checks against GPS altitude.

### Gaps
- Not researched in this session, and needing verification by the report writer or others: USGS 3DEP (1 m lidar / 1/3" 10 m, public domain), swissALTI3D (0.5–2 m, free open data since 2021), IGN RGE ALTI (1–5 m, Etalab open licence), Austrian/South Tyrol/Italian regional lidar, Norway Høydedata (1 m), NZ LINZ lidar (CC BY 4.0), SRTM/NASADEM voids in steep terrain, MapTiler terrain-RGB and Terrain Quantized Mesh pricing, Cesium World Terrain (Cesium ion subscription), and ALOS AW3D30 licence (free, with registration for JAXA distribution).
- OpenTopography API access and quotas were not checked.

## 6. Peak/POI data, trails, glaciers

### Takeaway
OSM `natural=peak` nodes (with `ele`, `name`, `prominence`, `wikidata`) are the main open peak source; `natural=saddle`/`volcano` and `mountain_pass` are related. Query them via Overpass. OSM `ele` is meant to be above sea level, but values are of mixed quality and provenance.

### Cited Findings
- `natural=peak` is mapped as a node placed "as close to the centre of the top as you can". Key tags are `ele` (metres above sea level), `name`, `prominence` (difference between the peak's elevation and its key col), and `wikidata`/`wikipedia`. Related features: `natural=saddle`, `natural=volcano`, `natural=hill`, `natural=mountain_range`. — [OSM Wiki Tag:natural=peak](https://wiki.openstreetmap.org/wiki/Tag:natural=peak)

### Inferences
- Snap OSM peak positions to the DEM local maximum within about 50–100 m, because OSM nodes may be offset. Use DEM height, not `ele`, for projection; `ele` is suitable for labels.
- Rank labels by prominence (computed from the DEM if missing) to reduce clutter.

### Gaps
- Not researched here: Overpass API rate limits, peakbagger / GeoNames / Wikidata licensing, prominence computation tools (e.g. Andrew Kirmse's prominence code), GLIMS/RGI 7.0 glacier outlines, OSM `sac_scale` path tagging, and contour generation (gdal_contour / d3-contour).

## 7. Geodesy and optics: curvature, refraction, datums, coordinate frames

### Takeaway
For a target at distance d, the apparent drop relative to the camera's horizontal plane is d²/(2R)·(1−k), with R ≈ 6371 km and k ≈ 0.13 (standard). That is about 0.068·d² metres with d in km: roughly 680 m at 100 km. It matters for any peak beyond about 10 km. iPhone altitude and Copernicus both use EGM2008 MSL heights. For rendering, convert all points to ECEF, then to a local ENU frame at the camera. Precise ECEF conversion needs ellipsoidal height, i.e. orthometric height + geoid undulation N from EGM2008.

### Cited Findings
- Curvature drop is h = d²/(2R): about 8 cm at 1 km, 7.8 m at 10 km, 785 m at 100 km. The refraction coefficient k typically ranges 0.13–0.16 (0.143 nominal). The effective Earth radius is R/(1−k). Combined curvature plus refraction with k = 1/7 is about 0.0673·D² (m, D in km). — [Engicalchub surveying calculator](https://engicalchub.com/calculators/earth-curvature-refraction-correction-calculator/); [FIRGELLI calculator](https://www.firgelliauto.com/blogs/engineering-calculators/earth-curvature-calculator) (secondary; the formulas are standard surveying results)
- Horizon synthesis from DEMs for archaeo-astronomy (a similar ray-cast approach including refraction) is described in [arXiv 1107.1957](https://arxiv.org/pdf/1107.1957).
- iPhone CoreLocation altitude is MSL relative to EGM2008. — [Apple Developer Forums 125281](https://developer.apple.com/forums/thread/125281)
- Copernicus DEM heights are relative to EGM2008. — [Earth Engine GLO30 catalog](https://developers.google.com/earth-engine/datasets/catalog/COPERNICUS_DEM_GLO30_2024_1); [Tandfonline 2022](https://www.tandfonline.com/doi/full/10.1080/17538947.2022.2094002)
- Geoid–ellipsoid separation can be 20–100 m depending on location. — [TarmacView](https://www.tarmacview.com/glossary/exif/) (secondary)

### Inferences
- A simpler implementation that includes refraction: build ECEF from lat, lon and h_ellipsoidal for every DEM vertex, then transform to ENU at the camera. That automatically includes geometric curvature. Refraction is then added by raising each point by d²·k/(2R), or equivalently by scaling Earth's radius by 1/(1−k) in a spherical approximation. k varies strongly with temperature gradients (inversions, over snow), which matters at over 100 km.
- Geoid undulation N is nearly constant over a single photo's footprint (it varies by metres across ~100 km). For relative geometry, adding a constant N at the camera is adequate; per-vertex N matters only at the metre level.
- Viewshed: ray-march from the camera in ENU with the refraction-adjusted drop, keeping the max elevation-angle horizon per azimuth (the classic "horizon line" / R3/R2 viewshed). A peak is visible if its elevation angle exceeds the running maximum of the terrain between camera and peak.

### Gaps
- No authoritative geodesy text (e.g. NGS or IOGP guidance) was fetched. The ECEF/ENU formulas and the EGM2008 grid sources (PROJ `us_nga_egm08_25.tif`, GeographicLib) are standard, but were not re-cited in this session.
- No source quantified refraction variability in alpine conditions.
