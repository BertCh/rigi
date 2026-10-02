# Export / interchange: `src/lib/export`

These are pure TypeScript modules with no UI and no new dependencies. They turn a solved photo into formats other tools can read:

| Output | Function | Consumers |
|---|---|---|
| Pose JSON (`rigi/pose` v1) | `buildPoseJson` | scripts, re-import, archival |
| COLMAP text model (zip of `sparse/0/{cameras,images,points3D}.txt`) | `buildColmapZip`, `colmapFiles` | COLMAP, nerfstudio, OpenMVG (via COLMAP) |
| OpenCV R,t and K | `buildCameraModel`, which is also in the JSON | cv::projectPoints, custom tools |
| KML PhotoOverlay | `buildPhotoOverlayKml` | Google Earth Pro/Web |
| KMZ (doc.kml + JPEG) | `buildKmz`, `kmzBlob` | Google Earth |
| GeoJSON | `buildGeoJson` | QGIS, geojson.io, Mapbox, deck.gl |
| Annotated image | `composeAnnotatedPng` | sharing |
| XMP sidecar | `buildXmp` | exiftool, Lightroom, darktable, digiKam |
| Store-only ZIP writer | `zipStore`, `crc32` | generic |
| Gaussian splats (`.ply`, `.splat-v1`) in ENU with a geo origin | `splat.ts` (`exportSplatsFromEngine`) | Step Inside; `generated` content always stripped, per-model licence note |

Import everything from `#/lib/export` (the barrel is `index.ts`).

## Exports

- `buildCameraModel(input: CameraInput): CameraModel` is the core. Every other builder accepts either a `CameraInput` or a `CameraModel`.
  - `CameraInput` has these fields: `{ photoId, imageName?, width, height, pose: Pose, frame: {lat,lon,h}, eye: [x,y,z], demAtCamera?, geoidUndulation?, takenAt? }`.
  - `CameraModel` provides:
    - `K` and `Kopencv`, plus `f`, `vfov`, `hfov`, `dfov` and `f35`
    - `lat`, `lon`, `altMsl`, `altEllipsoid` and `eyeOffset`
    - `R_cam2enu`, `R_enu2ecef`, `R_cam2ecef`, `C_ecef` and `frameOriginEcef`
    - `R_w2c_ecef` and `t_w2c_ecef` (OpenCV convention, world = ECEF)
    - `R_w2c_enu` and `t_w2c_enu`
    - `q_w2c_ecef` and `q_w2c_enu` (COLMAP qvec: w,x,y,z with w ≥ 0)
  - All matrices are row-major `number[9]`.
- Helpers: `projectEcef(model, X, K?)`, `enuToEcef(model, enu)`, `ecefToGeodetic`, `enuToEcefRotation`, `mat3ToQuat`, `mat3Mul`, `mat3T`, `mat3Vec`, `hfovFromVfov`, `kmlCameraAngles(pose)`, `wrap360`, `fixedAzimuth(deg, digits)` (never prints 360) and `colmapLines(model, {world})`.
  - `colmapLines` gives only the single data lines and is not a loadable file on its own.
- COLMAP (`colmap.ts`):
  - `colmapFiles(inputOrModel, {cameraId?, imageId?, world?: 'ecef'|'enu'}) → {'cameras.txt', 'images.txt', 'points3D.txt'}` returns the full file texts with headers.
  - `images.txt` has the pose line followed by an empty POINTS2D line. Without that second line, COLMAP's `ReadImagesText` silently drops the image.
  - `points3D.txt` is empty apart from its header.
  - `buildColmapZip(inputOrModel, {…, dir = 'sparse/0'}) → Uint8Array` packs the three files into a store-only zip.
- `buildPoseJson(inputOrModel, {exportedAt?}) → PoseJson`, with constants `POSE_SCHEMA` and `POSE_SCHEMA_VERSION`.
  - `estimate` says how the pose is known: `trusted`, the provenance axes (`status`, `agent`, `method`, `role`, `outcome`, `level`, `corroborated`), `label`, `confidence` and `sigmaDeg`. It comes from `CameraInput.estimate` (a `PoseEstimateNote`) and is `null` when the exporter did not say. The block was added to v1 on 2026-10-02, so older v1 files do not have the key.
  - `trusted` is `isTrustedEstimate(note)`: a person's endorsed pose, or an automatic pose that ontology `isTrustedAuto` accepts. A compass prior is never trusted.
- `readPoseJson(textOrObject) → {ok: true, json, input, claimed} | {ok: false, error}` reads a v1 file and fails closed. It rejects:
  - a wrong schema or version
  - a missing or non-finite field
  - a vfov outside (0, 180)
  - a frame latitude or longitude out of range
  - angles that disagree with the file's own `R_cam2enu` (by more than 1e-6) or with `fx`
  - any provenance word the ontology does not know

  `input` rebuilds the camera with `buildCameraModel`. `json` is re-derived from `input`, so the file's extra or stale fields do not survive it. The file's provenance comes back as `claimed`, which cannot be verified. `json.estimate.trusted` is always false: an importer records the pose as its own (for example, a person's endorsed pose).
- KML and KMZ:
  - `buildPhotoOverlayKml(inputOrModel, {href?, name?, description?, near?}) → string`. The default href is `files/<imageName>`.
  - `buildKmz(inputOrModel, jpegBytes, opts) → Uint8Array`, and `kmzBlob(bytes)`.
- `buildGeoJson(inputOrModel, {maxRange?, arcSteps?, peaks?, includeHiddenPeaks?, pixelToLatLon?, footprintCols?, footprintRows?}) → FeatureCollection`. Features carry a `kind` of `camera`, `view-direction`, `fov-wedge`, `peak` or `footprint`.
  - Other exports: `destination`, `ringSignedArea`, `sampleFootprint`, `unwrapLon`, `polygonGeometry` and `lineGeometry`.
  - **Antimeridian:** longitudes are unwrapped around the camera. Any wedge, view line or footprint that crosses ±180° is split into a `MultiPolygon` or `MultiLineString`, as RFC 7946 §3.1.9 requires, so every longitude stays within [−180, 180].
  - **Heights (RFC 7946 §4):** a third coordinate means height above the ellipsoid. So the camera and peak points get a z value (altEllipsoid, or ele + N) only when `geoidUndulation` was passed. Otherwise they are 2D, and the MSL heights are in `properties.altMsl` and `ele`. The camera's `properties.heightDatum` says which case applies.
- `buildXmp(inputOrModel) → string` (the .xmp text), plus `xmpGpsCoord` and `RIGI_NS`.
  - When the input has an `estimate`, the sidecar also carries `rigi:PoseTrusted` (`True`/`False`), `rigi:PoseStatus`, `rigi:PoseMethod`, `rigi:PoseLabel` and `rigi:PoseConfidence`. Without one, none of these tags is written: the provenance is unknown, which is not the same as untrusted.
  - `xmpGpsCoord` rounds the total minutes first, so a value like 46.99999999999 becomes `47,0.000000N` and never `46,60.000000N`.
  - `GPSImgDirection` stays within 0 to 359.99: it rounds to hundredths and then takes the result mod 36000.
- `exportFromEngine(engine, kind, {estimate})` passes the estimate through. When the estimate is not trusted, every export adds the note "Pose not verified (label): check it before use".
- `composeAnnotatedPng(photo, overlays[], {width?, height?, attribution?, title?, footerHeight?, type?, quality?, createCanvas?}) → Promise<Blob>`.
  - It uses `OffscreenCanvas` when available and otherwise `document.createElement('canvas')`, or a factory you pass in.
  - Overlays are stretched onto the photo rectangle.
  - A footer strip (about 2.6 % of the height) is added below the photo. It holds the optional title on the left and `DEFAULT_ATTRIBUTION` on the right: "Terrain © Mapterhorn · Imagery © swisstopo, Esri, Maxar, Earthstar Geographics, and the GIS User Community · © OpenStreetMap contributors".
- `zipStore(entries: {name, data: Uint8Array|string, date?}[]) → Uint8Array`, and `crc32(bytes)`.

## Conventions (all verified in `scripts/test-export.ts`)

- **Pose:** pose.ts exactly. The camera sits in the engine's ENU frame (`engine.frame` = `EnuFrame(photo.lat, photo.lon, 0)`, eye = `engine.eye` = `(0,0,eyeAlt)`). Yaw is the true heading clockwise from north, pitch is up +, roll is right-side-down +, and vfov is the vertical FOV.
- **Camera axes:** OpenCV/COLMAP, with x right, y down and z forward. `R_cam2enu` has the columns `[right, −up, forward]` from `poseBasis`.
- **Pixels:**
  - `K` uses the corner-origin convention: `cx = W/2`, `cy = H/2`, and pose.ts `(u,v)` maps to `(u·W, v·H)`. COLMAP uses the same convention (the centre of the top-left pixel is (0.5,0.5)).
  - `Kopencv` is `K` with 0.5 subtracted from cx and cy, for OpenCV's convention where pixel centres fall on integers.
  - Pixels are square: fx = fy = (H/2)/tan(vfov/2).
- **ECEF:** WGS84. The heights are the DEM's (Mapterhorn, orthometric, roughly EGM2008 mean sea level). The engine uses these heights directly as the frame's h, so by default `geoidUndulation = 0` and the "ECEF" places MSL heights on the ellipsoid.
  - Pass `geoidUndulation` (N is about 47–51 m in the Swiss Alps) to get true ellipsoidal ECEF. `altMsl` stays the same either way.
- **Refraction:** `EnuFrame.fromGeo` lifts distant points by k·d²/2R (k = 0.13). The exported matrices are purely geometric. Projecting a real geo point through them gives a result that differs from the in-app overlay by k·d/(2R) rad: 0.31 px at 10 km, 0.93 px at 30 km and 1.86 px at 60 km, at f ≈ 3028 px on a 4032-px image (measured by the test).

### Google Earth KML camera: how the angles are derived

Reference: https://developers.google.com/kml/documentation/kmlreference#camera and https://developers.google.com/kml/documentation/cameras

- The KML camera starts looking straight down. Its X axis points right (east), Y is up on the screen (north), and Z points from the screen toward the eye. The rotations are applied in order: heading about Z, then tilt about X, then roll about Z.
- **heading = yaw**, normalised to [0,360). It is printed with `fixedAzimuth`, so a heading that rounds to 360 is written as 0. This is the compass azimuth, clockwise from true north.
- **tilt = 90 + pitch**. The reference says that "a value of 0 indicates that the view is aimed straight down… 90… toward the horizon". So a pitch of −90 gives a tilt of 0, and a level camera gives a tilt of 90.
- **roll = −roll**.
  - The cameras guide says a `<roll>` of 45 "causes the camera to roll to the left". That means the left side goes down and the right side goes up.
  - This matches a right-handed rotation about the camera's +Z axis, which points toward the viewer.
  - Our roll is positive when the right side goes down, so the sign flips.
- **Test (a consistency check, not a verification):** the test builds R = Rz(−heading)·Rx(tilt)·Rz(roll) from the same reading of the KML reference. Its columns reproduce poseBasis right/up/−forward to 3e-16 over 200 random poses.
  - This catches composition and algebra mistakes, but it cannot catch a wrong roll sign, because both sides share the same assumption.
  - Only a manual check in Google Earth can settle the sign (see Known limitations).
- **Altitude:** `altitudeMode absolute` means metres above sea level (Google Earth uses the EGM96 geoid). That is the same datum as `altMsl`.
- **ViewVolume:** leftFov = −hfov/2, rightFov = +hfov/2, bottomFov = −vfov/2, topFov = +vfov/2. `near` defaults to 50 m and sets how far from the eye the rectangle is drawn.
- **Other elements:** `<Point>` holds the camera position (absolute), `<shape>` is `rectangle`, and `<rotation>` is 0 because roll is carried by the Camera.

### XMP

- **GPS:** the standard EXIF-in-XMP tags `exif:GPSLatitude`, `exif:GPSLongitude`, `exif:GPSAltitude`/`Ref` (MSL), `exif:GPSImgDirection` (T) and `FocalLengthIn35mmFilm`.
- **Orientation:** Google Photo Sphere tags `GPano:PoseHeadingDegrees`, `PosePitchDegrees` and `PoseRollDegrees`, with `UsePanoramaViewer=False`.
  - Per the GPano spec, "as roll increases, the horizon rotates counterclockwise in the image". That happens when the camera's right side goes down, so GPano roll = our roll.
- **Full model:** a custom namespace `rigi` = `https://rigi.app/ns/pose/1.0/`. It holds yaw, pitch and roll, vfov and hfov, focal length in pixels, image size, MSL and ellipsoidal altitude, the ECEF centre and the row-major camera→ECEF rotation.

## Verification

`npx tsx scripts/test-export.ts` (29 of 29 checks; CI `export` row) and the Vitest specs in `__tests__/` (`npx vitest run src/lib/export`). Key numbers from the 2026-09-29 run:

- **K[R|t] (world = ECEF) vs `projectPoint`:** 9000 points, 150 pose/frame/eye cases on a 4032×3024 image, at 50 m to 120 km, in three hemispheres, with and without a horizontal eye offset. Max error 3.9e-7 px, against a 0.01 px limit.
- **Other projection and rotation checks:**
  - With world = ENU, the max error is 1e-12 px.
  - Reprojecting from the serialised, rounded JSON gives a max error of 3.8e-4 px.
  - The rotation is orthonormal with det = 1, and qvec reproduces R to 1e-16.
- **ENU→ECEF vs geodesy.ts:** matches `toEcef` with 0 m error when the refraction lift is removed.
- **KML:**
  - The heading/tilt/roll construction matches poseBasis. This is a consistency check only; see above.
  - Azimuths wrap correctly: 359.9999999 is written as `<heading>0</heading>`, and 359.998 as `GPSImgDirection="0/100"`.
  - xmllint and a built-in checker both accept the file.
  - For the IMG_7131 prior: heading 20.844269, tilt 86.592486, roll 0.727778, alt 1361.317.
- **KMZ:**
  - `unzip -t` reports "No errors detected".
  - doc.kml is the first entry, and the extracted JPEG is byte-identical to the original.
  - `crc32("123456789")` = cbf43926.
- **COLMAP:**
  - `images.txt` is parsed with a simulation of COLMAP's `ReadImagesText`: it skips `#` and empty lines, and an image needs its POINTS2D line.
  - The parse gives exactly 1 image, and its qvec and t match the model. The old single-line output gives 0 images, which reproduces the reported defect.
  - The zip passes `unzip -t` and contains `sparse/0/cameras.txt`, `images.txt` and `points3D.txt`.
  - COLMAP itself is not installed here, so the files were not loaded with the real binary.
- **GeoJSON:**
  - Structure is valid, rings are closed and counter-clockwise, and coordinates are in range.
  - `destination()` (the spherical direct problem) agrees with geodesy.ts `bearingDeg` (the inverse problem) to within 0.1° of yaw.
  - Antimeridian: the wedge and line are split into Multi* geometries for cameras at lon ±179.9 or ±179.99, with every ring counter-clockwise and less than 1° wide. A camera that doesn't cross stays a plain Polygon.
  - Height datum: z is written only when `geoidUndulation` is given (camera 500 + 48.5 gives z = 548.5, and the peak gets 3048.5).
  - The file has 25 peaks and a footprint.
- **XMP:**
  - xmllint accepts it.
  - Latitude, longitude and altitude round-trip to within 1e-7° and 1 mm.
  - `xmpGpsCoord` edge cases (x.99999999999, negative values, 0, 179.99999999999) never print 60 minutes and carry into the degrees.
- **Annotated PNG:** 2048×1576 (the photo plus a 40 px footer), made with @napi-rs/canvas.

## Known limitations

- **Google Earth rendering not checked:** the KML angles are derived from the KML reference and checked against an independent rotation built from that reference, but I did not open them in Google Earth.
  - One thing to confirm in Google Earth Pro: whether it honours `<Camera><roll>` when placing the PhotoOverlay rectangle, or only when flying to the view. If it only uses roll for flying, set `<rotation>` = roll as well.
  - Roll is below 1° for most photos, so the practical effect is small.
- **Geoid:** the builders have no geoid model of their own (`geoidUndulation` defaults to 0 there), but the engine entry points (`engineCameraModel`, `exportFromEngine`, `exportSplatsFromEngine`) default it to the EGM2008 value at the frame origin (`src/lib/tiles3d/geoid.ts`, N about 48 m at the Rigi), so app exports are truly ellipsoidal in ECEF and XMP `AltitudeEllipsoid` ([code review](../../../reports/code-review-2026-09-30.md) CR-04, fixed). Pass `geoidUndulation` to override. Everything else (KML absolute altitude, XMP GPSAltitude, `altMsl`) is MSL.
- **FOV wedge:** it is the horizontal FOV about the yaw bearing and ignores roll and pitch. The footprint is a per-column near/far outline, so it can be ragged across occluded valleys. It is not a true viewshed.
- **Hidden peaks:** only peaks the caller marks visible are exported, unless `includeHiddenPeaks` is set.
- **ZIP limits:** the writer is store-only with no ZIP64, so it handles up to 65535 entries and 4 GiB. That is fine for KMZ.
- **Timestamps:** `composeAnnotatedPng` uses the system font stack (Fira Sans if it is loaded). ZIP entries use local-time DOS timestamps.
- **Footprint test path:** the test's footprint uses a synthetic flat plane. `engine.sampleAt` (the geometry buffer) needs a GPU engine, so it is not exercised headlessly. Check it in-app once the Export menu is wired: the footprint should sit in front of the camera, not mirrored behind it.
- **Lens distortion:** the pinhole model assumes square pixels, a centred principal point and no distortion. That matches the engine.

## ExportMenu integration

`src/lib/export/ExportMenu.tsx` is a drop-in dropdown (same look as the header's "Save image" pill) with six items. Each downloads `<photo.id><ext>`:

| Item | File | Built by |
|---|---|---|
| Annotated image | `<id>.annotated.png` | `engine.exportImage(withLabels)` (full-res render + labels) → `composeAnnotatedPng` footer (title + attribution) |
| Google Earth | `<id>.kmz` | `buildKmz` with the original JPEG bytes (`fetch(photo.src)`; re-encoded from `engine.photoElement` if not a JPEG) |
| GeoJSON | `<id>.geojson` | `buildGeoJson` with camera, view ray, FOV wedge, every visible in-frame peak, and the monoplotted footprint via `engine.sampleAt` |
| Pose | `<id>.pose.json` | `buildPoseJson` |
| COLMAP | `<id>.colmap.zip` | `buildColmapZip` (world = ECEF) |
| XMP sidecar | `<id>.xmp` | `buildXmp` |

The runtime glue is in `src/lib/export/engine-export.ts`: `exportFromEngine(engine, kind, opts) → {blob, filename, notes}`, `engineCameraModel`, `enginePeaks`, `engineReady`, `geometryBufferState`, `refreshGeometry`, `downloadBlob` and `EXPORT_FORMATS`. It is also re-exported from the `#/lib/export` barrel. `ExportMenu.tsx` itself is NOT in the barrel, so the Node tests don't pull in React.

The workspace mounts it as `<ExportMenu engine={engineRef} disabled={exportLocked} withLabels={showPeaks} photo={photo} />`. `engine` accepts the engine, a ref or a getter (resolved at click time). Optional props: `geoidUndulation`, `maxRange` (default 30 km), `onExported`, `className`, `align`.

**Readiness: `disabled` is required, not cosmetic.** `engine.terrain` is set in `init()` before segmentation, horizon tracing and auto-align; for about 200–1100 ms after that `engine.pose` is still the compass prior (IMG_7131: yaw 20.84° vs final 10.77°). Only the host knows when alignment is done, so it must pass `disabled` until the pose is final; `disabled` locks the toggle and every item, even in an open menu.

### Engine data used (public API only; no engine changes needed)

`engine.photo`, `pose`, `aspect`, `frame` (lat/lon/h + `toGeo`), `eye`, `demAtCamera`, `terrain` (necessary for readiness, not sufficient), `settings.{protectPeople,mode}`, `peaksInFrame()`, `sampleAt(u,v)`, `isForeground(u,v)`, `exportImage(withLabels)`, `photoElement` and `setPose()` (called with the *same* pose only to force a geometry refresh).

- **Peaks:** `enginePeaks` takes `peaksInFrame()`, keeps those inside [0,1]², and re-applies the same occlusion test `peakLabels()` uses (geometry-buffer range just below the summit, plus the people mask). It does this without `peakLabels`' label decluttering, so the GeoJSON gets every visible peak (10 for IMG_7131, where the decluttered overlay shows only 5 labels). If the engine ever exposes an undecluttered visibility accessor (e.g. `engine.visiblePeaks()`), `enginePeaks` should switch to it so the two can't drift apart.
- **Geometry-buffer freshness (applies to peaks and footprint):** `sampleAt` reads a CPU copy that the engine refreshes only 90 ms after the last pose change. Right after a nudge or drag it therefore describes the previous pose, and before the first readback it is all zeros. The old peak test then marked every in-frame peak `visible: true` through its `!s` branch. `geometryBufferState(engine)` now checks freshness directly: on a 24×24 grid, the direction from the eye to each hit's `world` must match the current pose's pixel ray (median < 0.15°; a fresh buffer measures 0.036°, and a +2° nudge measures 1.92°). The GeoJSON export first calls `refreshGeometry`, which re-sets the same pose to force a render and readback, then polls for up to 1.5 s. If the buffer is still stale or empty, the export leaves out **both** the footprint and the peaks, and says why in the status line. `enginePeaks` on its own returns `visible: null` (untested) when the buffer isn't fresh, and `PeakInput.visible` is now `boolean | null`. A future `await engine.readback()` on the engine would replace the poll.
- **Footprint:** monoplotted with `engine.sampleAt`, skipping people pixels, and only from a fresh buffer.
- **Annotated image:** `engine.exportImage` returns a JPEG (the docstring says PNG), which is then decoded and recomposed as PNG. In world mode it renders the 3D map view, and the status line notes that. A `engine.exportImage({ mode: 'overlay' })` override would allow a photo export from any mode.

### Menu verification (2026-09-29, browser)

A local-only Playwright script (`out/lead/export/menu/verify-menu.mjs`, gitignored) on `/photo/IMG_7131` and `/photo/IMG_6971`: no item enabled before ready (0 of the 10 ms samples), all six downloads in 31–275 ms, a GeoJSON exported right after a +2° nudge carries the footprint about the **new** yaw (refresh worked), the same buffer read without refresh is stale (3.9°) and reports `visible: null`. The KMZ JPEG is byte-identical to the source; `unzip -t` and `xmllint` pass on KMZ, COLMAP and XMP. Not re-run since the three.js removal.
