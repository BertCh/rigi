# Rigi internal audit: what it does, how well, how it is built, what is unfinished

Scope: an audit of the local repo `/Users/robertchristie/Documents/GitHub/mt-image` as of 2026-09-26, with no web research. Sources are repo-relative file paths. "Memory" means the session memory notes in `~/.claude/projects/-Users-robertchristie-Documents-GitHub-mt-image/memory/`. Those notes are the project's own records, but they are secondary to the reports. Note that the repo has **no git commits yet**: every file is untracked (`git log` reports "does not have any commits yet"). Several concurrent Claude sessions edit one working tree, and file ownership is split between them (memory `multi-session-ownership.md`).

## 1. User-facing features, and which are polished vs experimental

### Takeaway
Rigi (renamed from "Summit Lens" on 2026-09-26) is a browser app. It automatically poses an iPhone mountain photo against a DEM, then offers three ways to view the result: **Overlay**, **Blend** and **In map**. It also has manual Drag and Pin-peaks correction, people segmentation, an upload flow with map-pin fallback, a "camera roll" multi-photo view, six export formats and style presets. The main `/photo/$id` workspace is the product surface. `/studio`, `/lab/*` and `/baseline` are showcase and test benches, and the deck.gl renderer is an opt-in second backend.

### Cited Findings
**Core modes (`/photo/$id`, `src/components/PhotoWorkspace.tsx`)**
- **Overlay:** contours or elevation bands (20/50/100/200 m intervals), ridgelines and skyline, occlusion-tested OSM peak labels, SAC-coloured hiking trails, a distance tint, and a hover readout of lat/lon/elevation/distance for any pixel. — [README.md](README.md); [PhotoWorkspace.tsx l.707–716](src/components/PhotoWorkspace.tsx)
- **Blend** (internal mode name `replace`): swaps parts of the photo for a 3D Satellite, Topo map, Relief or Bands render from the same viewpoint. It has four methods: Lens, Swipe, Distance cut-off (e.g. "everything beyond 3 km") and Brush. The sky and people stay photographic. — [README.md](README.md); [PhotoWorkspace.tsx l.747–764](src/components/PhotoWorkspace.tsx)
- **In map** (internal mode name `world`): projects the photo onto 3D terrain, using the photo camera's range buffer as a shadow map so only surfaces the camera saw receive pixels. The user can orbit, then "Fly into the photo". — [README.md](README.md)
- **Tools:** Inspect, Drag (drag moves the terrain, Shift rolls, the wheel sets FOV) and Pin peaks (click a peak marker, then its true image position). A Levenberg–Marquardt solve fits yaw and pitch from 1 pin, adds roll with 2 pins and FOV with 3. Poses persist in localStorage. — [README.md](README.md); [PhotoWorkspace.tsx l.847–849](src/components/PhotoWorkspace.tsx)
- **People segmentation:** runs in the browser with MediaPipe `selfie_multiclass_256x256`. Overlays skip people, blends keep them in front, and projection does not smear them over the ground. — [README.md](README.md); [src/lib/segment.ts](src/lib/segment.ts)

**Verification badges ("second opinion")**
- After first paint, a CPU cascade in a worker re-solves the pose. The badge is one of verified, refined, kept, unverified, matched or timeout. Exports are locked while the verdict is pending, with a 20 s cascade deadline. If the optional matcher service is up, the pose can escalate to it ("matched"). — [src/lib/integration/second-opinion.ts](src/lib/integration/second-opinion.ts)

**Upload (`/upload`, `src/routes/upload.tsx`, `src/lib/upload/*`)**
- Accepts drag-drop or a file picker.
- HEIC is decoded natively in Safari and through libheif-js (LGPL, in a worker) elsewhere. The page tells the user how to export JPEG if needed. — [src/lib/upload/decode.ts](src/lib/upload/decode.ts); [upload.tsx l.204–232](src/routes/upload.tsx)
- A slippy-map pin sets the position when EXIF GPS is missing. The page warns that Safari strips location from picker uploads since iOS 16.4. Diagnostics cover an unknown lens (defaulting to the iPhone main camera f35) and missing gravity or heading. — [upload.tsx l.380–400](src/routes/upload.tsx); [src/lib/upload/SlippyMap.tsx](src/lib/upload/SlippyMap.tsx)
- The OSM region (peaks and trails) is fetched from Overpass at upload time, with 4 mirror endpoints. Local photos live in IndexedDB. — [src/lib/overpass.ts](src/lib/overpass.ts); [src/lib/upload/region.ts](src/lib/upload/region.ts)
- For uploads with unknown heading, gravity or focal, the unknown-pose worker runs in three steps: (1) the CPU cascade with the unknowns declared (360° yaw, free tilt); (2) fused `/match` if the matcher service is up, taken only at HIGH; (3) otherwise the pose is shown as "unverified". The app aligner is never auto-accepted for these photos. — [src/lib/integration/unknown-pose.ts](src/lib/integration/unknown-pose.ts)

**Camera rolls (`/roll`, `/roll/$id`, `src/lib/roll/**`)**
- Groups photos into "rolls" by single-linkage clustering (15 km link) and "viewpoints" (150 m radius). Each photo gets the best available pose, in the order saved pose → hand-fitted GT → EXIF prior. **No solver runs here.** — [src/lib/roll/roll.ts](src/lib/roll/roll.ts)
- Views: a roll map that drapes up to MAX_DRAPE photos onto terrain at once (a mip-mapped atlas plus a range-map atlas used as a per-photo shadow map, with incidence and distance weighting), a cylindrical panorama strip that warps photos through their camera models, a grid, a mini-map and a time scrubber. — [src/lib/roll/map/multi-drape-layer.ts](src/lib/roll/map/multi-drape-layer.ts); [src/lib/roll/mosaic/panorama.ts](src/lib/roll/mosaic/panorama.ts)

**Export (`src/lib/export/*`)**
- Six formats: an annotated PNG (overlay, labels and an attribution footer), KMZ (a Google Earth PhotoOverlay), GeoJSON (view wedge, peaks, footprint), pose JSON (K, R|t, lat/lon/alt), a COLMAP sparse text model (ECEF), and an XMP sidecar (GPS plus heading, pitch and roll). — [src/lib/export/engine-export.ts l.23–30](src/lib/export/engine-export.ts)
- The legacy format identifiers `summit-lens/pose` and the `slens` XMP namespace were kept for compatibility. — memory `multi-session-ownership.md`

**Styling:** ViewStyle presets are Classic, Minimal, Topo, Night, High-contrast and Photo-matched, set through a StylePanel. The Classic preset is guarded to stay pixel-identical by `scripts/style-baseline.mjs`. — [src/lib/style/presets.ts](src/lib/style/presets.ts); [src/components/StylePanel.tsx](src/components/StylePanel.tsx); memory `deck-renderer.md`

**Renderers:** three.js is the default. deck.gl is a full second backend at `/photo/<id>?renderer=deck` (the `DeckEngine` class, behind the interface in `src/lib/renderer.ts`). It matches three.js for overlay, ridges, blend modes, people mask, trails, world/fly, export, auto-align (Δyaw ≤ 0.04°) and presets. Known leftovers:
- align is about 1.3× slower;
- drape acne at grazing occlusion edges;
- a dark diagonal line on IMG_7086;
- `DeckEngine` is imported statically.
— memory `deck-renderer.md`; [src/lib/renderer.ts](src/lib/renderer.ts)

**Brand:** the home-page panorama shows the view south from Rigi Kulm, drawn as depth-layered ridgelines with visibility-tested OSM peaks. The logo is the Rigi Kulm summit contours. Both are generated from the same DEM by `scripts/brand/rigi.ts`. — [README.md](README.md)

**Showcase and experimental routes:**
- `/studio/$id` combines atmosphere, relief, composite and labels, with the presets Photo-matched, Swiss relief, Berann, Topo ink and Slope angle, plus auto-align through refinePose. First frame is 5.1 s cold. — [research_notes/implementation_summary.md](research_notes/implementation_summary.md)
- `/lab/{atmosphere,composite,horizon,labels,relief}` are per-module test benches. `/baseline` is the core CPU pipeline UI. The home page lists all of these as developer links. — [src/routes/index.tsx l.12–18](src/routes/index.tsx)
- A 2026-09-26 consolidation plan would fold studio and lab features into both renderer cores as opt-in features, lazy-load the sky model, and keep Classic pixel-identical. — memory `multi-session-ownership.md`

### Inferences
- The polished core is `/photo/$id` with its three modes, Drag/Pin, segmentation and export. The upload flow, camera rolls, verification badges and deck backend are newer and less battle-tested.
- Some UI strings still say "Summit Lens" (the `/upload` and `/studio` page titles). That is a sign the rebrand is incomplete.
- `/studio`'s richer rendering (photo-fitted haze, Swiss relief, Berann styles) was not yet merged into the main engine as of the latest notes.

### Gaps
- No usage data, user testing or UX evaluation exists in the repo.
- I did not run the app, so these feature claims come from code and docs, not live verification.

## 2. Alignment/pose pipeline and measured accuracy

### Takeaway
There are three tiers: (a) a GPU skyline aligner in the browser, (b) a CPU "cascade" (solvePose → refinePose) in a worker, and (c) an optional local Python render-and-match "fused" service (ALIKED+LightGlue against satellite-draped DEM renders plus the skyline, solved in a joint LM).

On the author's own 12 GT iPhone photos, the accuracy is sub-degree: median yaw error about 0.13–0.33°, with 11 of 12 correct accepts and 0 false accepts for the cascade. On 100 in-the-wild Swiss Commons photos, which have no gravity and often no heading, only **53/100 are solvable by any method**. The fused tier is correct on 50, with HIGH-confidence precision of 0.97. The conservative product accept rule auto-accepts only about 16–20 of 100 photos, and all of those accepts are correct.

On the pre-registered held-out test (50 photos), the current service gets 29/50 correct with 17/17 HIGH correct, and the product rule accepts 11 of the 34 photos that have any verified-correct pose.

### Cited Findings
**Prior.**
- Eye = max(GPS altitude, DEM + 1.6 m).
- Yaw comes from the compass (GPSImgDirection, true north).
- Pitch and roll come from the Apple MakerNote gravity vector (tag 0x0008 AccelerationVector).
- Focal comes from the 35 mm equivalent on the diagonal.
- The phone prior alone is off by about 100 px, and compass errors reach 10.6°.

Sources: [README.md](README.md); [src/lib/upload/exif.ts l.89–258](src/lib/upload/exif.ts). On the GT set the prior's median yaw error is 3.31° (max 10.28°) — [reports/leaderboard.md](reports/leaderboard.md).

**App GPU aligner (`src/lib/align.ts`).**
- A 360° DEM horizon is traced from 8 float geometry renders.
- A sky-aware edge map adds a per-photo sky/terrain colour model. The model is seeded by a top-down gradient scan and gated by the prior skyline, so cloud edges don't count.
- Search runs a coarse yaw×pitch grid (±25°/±6°), then coordinate descent on yaw, pitch, roll and FOV. The top 5 hypotheses are re-ranked by inner silhouettes.
- Confidence is the margin over a runner-up at least 3° away.
- Measured: all 8 control-point photos within 1° of yaw, median reprojection 7.9 px at 1600 px.

— [README.md](README.md)

**Leaderboard on 12 GT photos** ([reports/leaderboard.md](reports/leaderboard.md), generated 2026-09-25):

| method | correct accepts | false accepts | median yaw error | median time |
|---|---|---|---|---|
| CPU classic+cascade (recommended default) | 11/12 | 0 | 0.20° (mean 0.22°) | 958 ms |
| classic+skyfirst | 11/12 | 0 | 0.13° | — |
| app GPU aligner | 10/12 | 1 (IMG_7130, 2.98°) | 0.33° | 156 ms |
| f0 render-match | 10/12 | 0 | — | 18 s |
| f0 fusion | 9/12 | 0 | 0.07° | 22 s |

- The leaderboard compares itself against published figures: "mean 0.224° vs Porzi 1.23°, 100% ≤1° vs LandscapeAR 39%". The report itself warns that "every number below rests on 12 photo(s)" and that GT noise is about 0.2–0.4°.
- Live app after lead patches: 12/13 within 1° yaw, median 6.6 px; 0 false accepts even with heading, gravity or focal stripped; cold load 3–5 s, warm about 2.3 s. — memory `project-accuracy-state.md`

**Fusion (render-match + skyline).**
- Within 1° of yaw in **33/33** compass-stress cases (±15° heading offsets), worst 0.66°. Skyline alone: 30/33. Render-match alone: 32/33.
- All 10 synthetic wrong-GPS cases (1–3 km offsets) are flagged LOW.
- On the independent GT, median |Δyaw| is 0.075°, 0.136° and 0.172° across the three scenarios.

— [reports/fusion.md](reports/fusion.md)

**Metadata ablation.**
- Fused stays within 1° on 11, 11, 11 and 10 of 11 photos under full metadata, no gravity, no heading and neither, with 0 false HIGHs in 48 cases.
- The app aligner **cannot handle a missing heading**: 3/11 within 1°, and it accepts wrong poses.
- The cascade with the unknowns declared gets 10, 10, 9 and 8 of 11, with 0 false accepts.

— [reports/bench-ablation.md](reports/bench-ablation.md)

**Wild benchmark v2** ([reports/bench-wild.md](reports/bench-wild.md)):
- **The set:** 100 Wikimedia Commons photos, all in Switzerland. 43 have EXIF GPS and 57 were hand-placed; 58 have a heading, often coarse; none has gravity. Ground truth is blind visual verification by agents against a C1–C4 checklist. C2 requires a vertical fit within 1.5% of image height, which is about 0.3° at 20° vfov and 1° at 67°.
- **Results:** 53/100 solvable by any method.

| method | correct | accepted | precision | gross errors |
|---|---|---|---|---|
| fused | 50 | 31 HIGH | 0.97 | 1 |
| app | 39 | 60 | 0.64 | 19 |
| cascade (Terrarium) | 14 | 17 | 0.75 | 3 |

- **Product rule** (fused HIGH and (EXIF GPS or cascade agreement within 0.5°)): 16/16 correct. After the cascade was re-run on Mapterhorn, the cascade gets 25 correct, with 22/22 accepts at a 0.75 yaw-unknown gate, and the product rule gets 20/20.
- **Failure taxonomy (share of photos with at least one correct method):**
  - low light or dusk: 2/10;
  - heading unknown: 38%;
  - near-field terrain forming the skyline: 33%;
  - fog or haze: 42%;
  - cloud on the skyline: 53%.
- 47 photos are unsolved, and these are "search failures, not small misfits".
- **Runtime:** the app takes 3.1 s median (p90 9.3 s) for alignment compute and 12.4 s wall time including page load. Fused on a cold page takes 28.4 s median (p90 53.9 s).
- An earlier v1 verification was wrong because its overlays were drawn on the Terrarium DEM at a different eye height. It understated fused (33 → 50 correct).

**Held-out test, single pre-registered run (2026-09-26)** ([reports/test-results.md](reports/test-results.md)):

| arm | correct (of 50) | HIGH | product rule | median time |
|---|---|---|---|---|
| A, service v0.3.4 | 29 | 17/17, 0 gross | 11/11, recall 11/34 | 35 s |
| B, T6 stage-1 search | 30 | 22/24 (2 unsure) | 15/17 | 84 s |
| C, pose6 on B | 31 | — | recall 9/34 | 89 s |

- Arm C fails the pre-registered bar.
- A post-hoc addendum re-verified B's two unsure accepts. wc_0038 was judged wrong by 2 of 2 fresh verifiers and wc_0003 stayed split. **The service default stays v0.3.4, and T6 is opt-in.** — [reports/test-addendum.md](reports/test-addendum.md)
- A new held-out set, `tools/bench/data_v3`, holds 74 photos (60 Swiss, 14 non-Swiss) and is frozen. — [tools/bench/data_v3/README.md](tools/bench/data_v3/README.md)

**Stage-1 diagnosis (T6).** At the verified-correct pose, ALIKED+LightGlue gets ≥ 30 inliers on 23 of 24 dev photos, so appearance is not what makes the sweep fail. LightGlue on Apple MPS was **non-deterministic** (0–17 matches instead of about 1000), so the service now runs LightGlue on CPU. — [reports/stage1.md](reports/stage1.md); [reports/matcher-service.md](reports/matcher-service.md)

**Position refinement (T5, pose6).** Safe on GT, but it does not turn near-misses into correct poses. Its useful by-product is a "basin-gap" LOW trigger for hand-placed positions, which removed the one gross HIGH error on dev. — [reports/position.md](reports/position.md)

### Inferences
- For Rigi's target input (an iPhone photo with GPS, heading and gravity), accuracy is very high: about 0.1–0.3° median, which is below verification noise. That rests on about 12–13 photos from one phone and two regions.
- For arbitrary internet photos, auto-accepted coverage is low: roughly 16–22% of all photos, or about a third of the solvable ones. The system is tuned for precision over recall, and "please confirm" is the fallback.
- The fused service is the robustness tier, but it is slow (35–85 s per photo) and runs locally.

### Gaps
- There is no metric (survey-grade) ground truth. The wild numbers are visual verdicts.
- There is no large iPhone-with-gravity benchmark beyond about 13 photos, so accuracy on the product's intended input at scale is unmeasured.
- The non-Swiss accuracy on data_v3's 14 photos has not been evaluated yet.

## 3. Data sources, licensing and geographic constraints

### Takeaway
DEM coverage is global through Mapterhorn, with lidar-grade detail in Switzerland (swissALTI3D) and France (RGE ALTI). Imagery and topo maps are swisstopo inside a hard-coded Swiss bounding box and Esri or OSM elsewhere. Every benchmark, and all tuning, is Swiss. The app therefore runs anywhere, but it has been validated almost only in Switzerland.

### Cited Findings
- **DEM (Mapterhorn):**
  - `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp` serves 512 px Terrarium-encoded tiles, up to z17 where a national DEM exists (swissALTI3D in CH, RGE ALTI in FR), with coarser global coverage.
  - Distance bands run from z15 within 1 km to z9 within 150 km.
  - AWS Terrarium (256 px, global, about 30–90 m) is kept as a legacy option.
  - Sources: [src/lib/dem/sources.ts](src/lib/dem/sources.ts). The user stated that Mapterhorn is free to use — memory `project-data-sources.md`.
- **Imagery:**
  - `SWISS_BBOX = {west 5.9, east 10.55, south 45.8, north 47.85}`.
  - Satellite imagery inside CH (z ≥ 8) is swisstopo SWISSIMAGE WMTS, with Esri World Imagery as the fallback. Outside CH it is Esri only.
  - The topo map inside CH is swisstopo pixelkarte-farbe, with OSM tiles as the fallback. Outside CH it is OSM tiles.
  - — [src/lib/terrain.ts l.12–25](src/lib/terrain.ts)
- **Peaks and trails:** OSM through Overpass: 4 public mirrors at upload, and bundled region JSON for built-in photos. — [src/lib/overpass.ts](src/lib/overpass.ts); [README.md](README.md)
- **Attribution footer on exports:** "Terrain © Mapterhorn · Imagery © swisstopo / Esri · © OpenStreetMap contributors". — [src/lib/export/annotate.ts l.5](src/lib/export/annotate.ts)
- **Models:**
  - MediaPipe selfie_multiclass (a 16.4 MB tflite from Google storage, loaded from the jsDelivr and GCS CDNs);
  - U²-NetP sky model (MIT, 4.5 MB ONNX);
  - ALIKED+LightGlue weights in `tools/matcher/weights` (98 MB, server-side);
  - libheif (LGPL).
  - — [src/lib/segment.ts](src/lib/segment.ts); [research_notes/implementation_summary.md](research_notes/implementation_summary.md); [src/lib/upload/licenses.ts](src/lib/upload/licenses.ts)
- **Benchmarks:** the wild v2 set is 100 Swiss photos. data_v3 is 60 Swiss and 14 non-Swiss, and outside CH the DEM there is Mapterhorn z15–16. — [reports/bench-wild.md](reports/bench-wild.md); [tools/bench/data_v3/README.md](tools/bench/data_v3/README.md)
- **Prior research on licensing:** Google Photorealistic 3D Tiles are off-limits because their terms forbid elevation measurement. FABDEM is non-commercial. Copernicus GLO-30 RMSE is about 48 m on steep Alpine slopes. — [reports/Mountain photo georeferencing SoTA.md](reports/Mountain%20photo%20georeferencing%20SoTA.md)

### Inferences
- Commercial use of the Esri World Imagery and swisstopo WMTS endpoints, the public OSM tile server, and the public Overpass mirrors probably needs licence or usage-policy review before any public launch. The repo contains no such review; this is my inference.
- Outside CH and FR, the near-field DEM is coarser. The reports show that DEM error dominates near-ridge failures, so accuracy abroad is likely lower.

### Gaps
- There is no written licence analysis of the Mapterhorn, swisstopo, Esri or OSM terms for commercial use. Only the user's statement that Mapterhorn is free exists.
- The MediaPipe model licence is not recorded in the repo.

## 4. Architecture, stack, mobile support and inputs

### Takeaway
The product path is client-side: React 19, TanStack Start/Router, Vite 8, three.js (default) and deck.gl 9.4, MediaPipe and onnxruntime-web, with workers for the CPU cascade, HEIC decoding and the sky model. The optional "matcher service" is a local Python HTTP server on :8765. It drives a headless Chromium copy of the app to render views, and it has only been run on the developer's Mac (MPS). Mobile, and iOS in particular, is not supported for the core renderer yet.

### Cited Findings
- **Stack (`package.json`):**
  - `@tanstack/react-start` and `react-router`, `nitro` (beta), React 19;
  - three ^0.186 and deck.gl ^9.4;
  - `@mediapipe/tasks-vision` 1.0.1 and `onnxruntime-web` ^1.30;
  - `exifr` and `libheif-js`;
  - Tailwind 4, Vite 8, Biome; Playwright for headless screenshots and eval.
  - Routes use `ssr: false`, and no `createServerFn` server functions were found in `src/`. — [package.json](package.json); [src/routes/*.tsx](src/routes)
- **Ingest for bundled photos:** `npm run ingest` converts img/*.HEIC into public/photos JPEGs, photos.json and OSM region JSONs. — [README.md](README.md)
- **Engine:** `src/lib/engine.ts` (1371 lines) handles geometry readback → layer → composite passes. `materials.ts` is the terrain uber-shader. `terrain.ts` is a quadtree LOD in camera-local ENU in float64 with skirts. `geodesy.ts` does WGS84↔ECEF↔ENU with refraction k = 0.13. — [README.md](README.md)
- **Matcher service (`tools/matcher/server/`):**
  - FastAPI-style `app.py`, a `render_worker.mjs` that uses Playwright to drive the app page, and `fusion.py`.
  - ALIKED stays on MPS; LightGlue runs on CPU.
  - RSS is 650–1,380 MB, and each warm Chromium page holds about 1–1.5 GB.
  - Latency: warm fused about 6.2 s; cold page 16–21 s; a basin-gap check adds a median of about 10.6 s.
  - The client defaults to `http://localhost:8765` (`VITE_MATCHER_URL`) and degrades gracefully when the service is absent.
  - — [reports/matcher-service.md](reports/matcher-service.md); [src/lib/matcher-client.ts](src/lib/matcher-client.ts)
- **Load performance:**
  - Cold time-to-ready median was 11.1 s with 59.5 MiB on the wire, against a 10 s target, in the 09-25 leaderboard.
  - Bottlenecks: an O(#tiles) `heightAt` costing about 3 s (a fix drops it to 0.16 s), a 2.2 MB region JSON, and the 16.4 MB MediaPipe model.
  - After the lead's patches: cold 3–5 s, warm about 2.3 s.
  - — [reports/perf-photo-load.md](reports/perf-photo-load.md); [reports/leaderboard.md](reports/leaderboard.md); memory `project-accuracy-state.md`
- **Mobile:** "iOS: WebGL2 has no float32 colour targets. The geometry buffer and relief field need half-float or WebGPU paths", which is listed as an open issue. — [research_notes/implementation_summary.md](research_notes/implementation_summary.md). The upload page carries iOS-specific guidance on HEIC and location stripping — [src/routes/upload.tsx](src/routes/upload.tsx).
- **Input:** best results need an iPhone photo (HEIC or JPEG) with EXIF GPS, GPSImgDirection (true north), the MakerNote gravity vector and FocalLengthIn35mmFilm. Photos missing any of these go through the unknown-pose path, and the map pin replaces missing GPS. — [src/lib/upload/exif.ts](src/lib/upload/exif.ts); [src/lib/integration/unknown-pose.ts](src/lib/integration/unknown-pose.ts)

### Inferences
- There is no deployable backend or hosting story. The matcher tier is a developer-machine prototype: Python, Playwright, a local dev server, and GPU and memory heavy. A production launch would ship a browser-only product or need real server work.
- The heavy float-render-target design makes phones, where most mountain photos are taken, the biggest platform gap.

### Gaps
- There is no deployment config, CI or production build validation in the repo, and I did not run `vite build`.
- Android and desktop-browser compatibility beyond Chromium and Safari has not been measured.

## 5. What is technically novel vs standard

### Takeaway
The algorithms (skyline-to-DEM alignment, render-and-match with LightGlue, LM pose solves) follow published patterns. The prior SoTA report says so itself: "the core techniques are more than a decade old". Rigi's distinctiveness is in the integration:
- the Apple MakerNote gravity prior parsed in the browser;
- a sky-aware, cloud-gated edge score;
- a photo-camera range buffer used as a shadow map for occlusion-correct draping, extended to many photos at once;
- people-aware blending;
- "tap 1–3 peaks" pinning;
- a fused multi-cue confidence with a rigorous blind benchmark.

The prior research describes this whole closed loop as missing from consumer products.

### Cited Findings
- The **Apple MakerNote AccelerationVector** (0x0008) is parsed with a hand-written IFD parser to derive pitch and roll, and the holding orientation is inferred from the gravity vector plus the image aspect. The prior research notes that most JS EXIF parsers do not decode Apple MakerNotes. — [src/lib/upload/exif.ts l.89–144](src/lib/upload/exif.ts); [reports/Mountain photo georeferencing SoTA.md](reports/Mountain%20photo%20georeferencing%20SoTA.md)
- **Sky-aware edge scoring:** a per-photo sky/terrain colour model, seeded by a gradient scan and gated by the prior skyline so cloud edges don't count. Inner-silhouette re-ranking and a runner-up margin confidence sit on top. — [README.md](README.md)
- **Shadow-map projection:** the photo camera's range buffer decides which terrain the camera saw. The multi-photo version keeps range maps in an r32float atlas for up to MAX_DRAPE photos. The prior research found that three-projected-material has no occlusion test and that CesiumJS has no perspective-projection primitive. — [README.md](README.md); [src/lib/roll/map/multi-drape-layer.ts](src/lib/roll/map/multi-drape-layer.ts); [existing_tools_products.md Q3](research_notes/Mountain%20photo%20georeferencing%20SoTA/existing_tools_products.md)
- **People segmentation** keeps people in front of blends and off the drape. — [README.md](README.md)
- **Fused skyline + render-match joint LM:** a HIGH/LOW rule fixed a priori, a basin-gap LOW trigger for untrusted positions, and robustness to a bad compass. — [reports/fusion.md](reports/fusion.md); [reports/matcher-service.md](reports/matcher-service.md)
- **Other modules:**
  - photo-fitted Koschmieder haze (airlight and β per channel);
  - an NOAA sun position from the capture time;
  - Swiss multi-directional relief;
  - PeakFinder-style leader labels;
  - a horizon-fast ray-march 22× faster than baseline (240 ms vs 5.3 s);
  - an edge-rasterised GPU horizon in about 20 ms.
  - — [research_notes/implementation_summary.md](research_notes/implementation_summary.md)
- **Evaluation rigour:** a frozen dev/test split, pre-registration with sha1s, blinded verifier packs with decoys, and post-hoc addenda labelled as such. — [reports/test-prereg.md](reports/test-prereg.md); [reports/test-results.md](reports/test-results.md); [reports/test-addendum.md](reports/test-addendum.md)
- **Interoperable pose exports** (COLMAP, KMZ PhotoOverlay, XMP, pose JSON). The prior research found that no consumer app exposes a camera model. — [src/lib/export/engine-export.ts](src/lib/export/engine-export.ts); [existing_tools_products.md Q1](research_notes/Mountain%20photo%20georeferencing%20SoTA/existing_tools_products.md)

### Inferences
- The defensible differentiators are product-level: automatic pose, occlusion-correct draping and blending, exportable camera models and an honest confidence signal. They are not algorithmic breakthroughs.
- The claim to beat published SoTA (0.22° vs Porzi's 1.23°) compares a 12-photo, metadata-rich set against harder academic sets, so it is not apples to apples. The leaderboard's own caveats imply the same.

### Gaps
- There was no prior-art or patent check on the specific techniques. The existing notes list patents on "Automated annotation of a view" (US 8432414 and others) without analysing them.

## 6. What is incomplete, failing or next

### Takeaway
The main open problems are:
- low auto-accept recall on non-iPhone and in-the-wild photos, with stage-1 search failures, no heading, haze, low light and near-field terrain as the causes;
- the slow, local-only matcher tier;
- no iOS/mobile renderer path;
- small, Terrarium-biased ground truth;
- two renderer backends plus studio and lab duplicates still being consolidated;
- code-quality debt.

### Cited Findings
- **Recall is the bottleneck.** The bottleneck is stage-1 search. The looser accept rule HIGH ∧ (EXIF ∨ basinGap ≥ 0.20) reached 22/34 recall on test, but it is not adopted. T6 must be re-validated on data_v3 together with the v2 eye-search changes. — memory `project-accuracy-state.md` and `wild-benchmark.md`; [reports/test-results.md](reports/test-results.md)
- **Failure classes:** low light (2/10 solvable), no heading, fog or haze, near-field skyline, and narrow FOV below about 10° hfov, where fused falls back to the skyline and returns LOW. — [reports/bench-wild.md](reports/bench-wild.md)
- **Next matcher ideas, ranked:**
  1. Replace LightGlue with LoMa;
  2. a GeoCalib gravity and FOV prior for photos without a gravity vector;
  3. DINOv2 dense-feature yaw correlation;
  4. MoGe-2 near-field masking plus 6-DoF PnP;
  5. a cross-modal fallback matcher (MINIMA or MatchAnything).
  — [research_notes/matching_v2_research.md](research_notes/matching_v2_research.md)
- **Open issues from the SoTA build pass:**
  - near-field objects missing from the DEM (huts, signs, cables) are draped over in the In map view;
  - IMG_7059 fails for every method;
  - GT is "approx" and needs re-annotation on Mapterhorn;
  - the engine hasn't adopted the render modules;
  - iOS lacks float32 render targets.
  — [research_notes/implementation_summary.md](research_notes/implementation_summary.md)
- **GT bias:** GT-12 was fitted on Terrarium DEM notches, and re-annotating on Mapterhorn is pending the user's decision. — memory `baseline-pipeline-state.md` and `project-accuracy-state.md`
- **Structural debt (snapshot 2026-09-24):**
  - components exist two to four times with different DEMs and eye rules (LM ×3, label declutter ×4, visibility tests ×4);
  - wedge-loading bugs;
  - synchronous readbacks;
  - `GPSImgDirectionRef` ignored;
  - no CI or regression gate.
  - Some of this has since been fixed: Mapterhorn was adopted more widely, and readback and horizon modules were built. — [research_notes/current_state_audit.md §D–E](research_notes/current_state_audit.md)
- **Lint and type state (09-25):** tsc reported 2 errors and Biome 94 errors. — [reports/leaderboard.md](reports/leaderboard.md)
- **Consolidation in progress (2026-09-26):**
  - P0 backup → P1 deletions → P2 shared-core merge with zero numeric drift → P3 app pipeline → P4 harvest studio and lab → P5 docs.
  - The `/deck` route no longer appears in `src/routes`, which is consistent with P1 having started.
  - — memory `multi-session-ownership.md`; `ls src/routes`
- **deck.gl leftovers:** about 1.3× slower align, drape acne, an IMG_7086 artifact, and a static import. — memory `deck-renderer.md`
- **Upload-path risk:** Safari strips GPS on picker uploads since iOS 16.4, which removes the prior the design depends on. — [reports/Mountain photo georeferencing SoTA.md](reports/Mountain%20photo%20georeferencing%20SoTA.md); [src/routes/upload.tsx l.380](src/routes/upload.tsx)
- **Verification protocol lesson:** pose numbers in the overlay headers leaked decoys to the verifiers. Future packs must hide them. — [reports/test-results.md](reports/test-results.md)
- No TODO/FIXME/HACK markers were found in `src/`, `scripts/` or `tools/matcher/*.py` by grep. Open work is tracked in reports and memory instead.

### Inferences
- The roadmap priorities implied by the repo:
  1. more recall at the same precision (search, no-heading, haze);
  2. a mobile/iOS rendering path;
  3. a deployable backend for the matcher, or a browser port;
  4. finishing consolidation and a CI regression gate;
  5. non-Swiss validation (data_v3);
  6. licensing review of tile sources.
- A "full GCP mode" for photos with no GPS (the third rung of the fallback ladder in the prior research) does not appear to exist. Only the map pin plus automatic solve and the 1–3 peak pins do. I did not find a GCP UI.

### Gaps
- There is no product roadmap document, no prioritisation by the user, and no timeline in the repo.
- I did not verify which items in the 09-24 audit remain open today.

## 7. Prior research on competitors (already in the repo)

### Takeaway
Prior work (2026-09) concluded that consumer peak apps (PeakVisor, PeakFinder) require manual silhouette dragging for photo annotation, that PeakLens (Android) alone advertises CNN skyline matching, and that FATMAP is dead. No consumer app exposes a camera model, projects trails into photos or drapes photos on terrain. The closest analogues are academic GCP tools (Smapshot, which needs 6 or more clicks, plus Pic2Map, the WSL Monoplotting Tool, ImGRAFT and the Mountain Legacy Project's IAT and MIAS). "Tap 2–3 peaks" was identified as an unfilled market gap, and Rigi now implements it with 1–3 pins.

### Cited Findings
- **PeakVisor:** manual alignment ("adjust the rendered 3D terrain panorama to perfectly match horizon"), free photo import, and more than 1M peaks.
- **PeakFinder:** compass auto-align plus drag, offline use, and an embeddable panorama API with no photo overlay.
- **PeakLens:** Android only, SRTM plus OSM, with a CNN skyline to correct GPS and compass error.
- **Newer "AI identifier" apps:** Mountain Identifier (MWM, iOS), Peak Identifier and SummitPeek. Their methods were unverified.
- **Others:** CalTopo's Simulated View has no photo overlay, and the Deuschle panorama generator uses k = 0.13 with no photo overlay.
- **Commercial VPS** (ARCore Geospatial, Apple location anchors, Niantic) needs pre-captured urban imagery and runs only in live sessions. "In the mountains, DEM alignment is the VPS."

Source for all of the above: [research_notes/Mountain photo georeferencing SoTA/existing_tools_products.md](research_notes/Mountain%20photo%20georeferencing%20SoTA/existing_tools_products.md)

- **Published accuracy baselines:**
  - Baboud, Baatz and Brejcha: about 1–3° mean error on clean skylines;
  - Porzi: 1.23°;
  - LandscapeAR: 39% within 1°;
  - Flickr Alps registration: 2.75–9.75%;
  - PeakLens predecessor: 64.2% of geotagged photos.
- The recommended architecture was browser-first with a GPU-server escalation tier and a three-rung manual fallback (drag, tap peaks, full GCP).

Source: [reports/Mountain photo georeferencing SoTA.md](reports/Mountain%20photo%20georeferencing%20SoTA.md)

### Inferences
- Rigi has built most of the recommended architecture. It lacks the full-GCP rung, a hosted GPU tier and a mobile path.
- The prior competitor notes flagged gaps that later researchers should close: no accuracy figures for PeakVisor or PeakFinder photo import, the AI identifier apps unverified, and Gaia, AllTrails, Komoot and Strava not researched.

### Gaps
- The competitor research is about 2 days old (2026-09-24/25) and was not refreshed here, since no web research was done in this audit.
