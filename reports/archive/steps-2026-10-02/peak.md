<!-- Rigi -->
<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: Copyright (c) Rigi contributors -->

# Step ⑫ peak: review, research, plan (2026-10-02)

Gipfelbuch node `peak` (`src/lib/gipfelbuch/graph.ts`): *"A summit becomes a label only if the eye can see it."* Step lead: Opus pod under coordinator mt-image-17 (STEP-RULES). Status at the bottom of this file; dev evidence only, no benchmark numbers.

## 1. Current state: two peak pipelines

The node lists `src/lib/geo/peaks.ts` and `src/lib/photos.ts`. The **live app does not run geo/peaks.ts's visibility or layout at all**; there are two pipelines.

| Stage | Live app (`/photo/*`, both engines) | Baseline (`/baseline`, node scripts, Gipfelbuch bakes) |
|---|---|---|
| Catalogue | Region JSON `RegionPeak {name, lat, lon, ele, prominence}` (`src/lib/photos.ts:43`), built by `scripts/ingest.mjs:324` (bundled, `node["natural"~"peak\|volcano"]["name"]` in a 60 km bbox) or `src/lib/upload/region.ts:49` (uploads; optional static extract `src/lib/osm/extract.ts:142`) | Overpass `around` query `src/lib/geo/peaks.ts:34`, `parseOverpassPeaks` (falls back to `name:de`/`name:en`, keeps `wikidata`) |
| Snap | `src/lib/deck/scene.ts:115` `snapPeaksNear`: 150 m – 110 km, lazily near the frame, radius `min(250, 60 + 0.004·d)`, `localMaxOf` 9×9 grid (now `src/lib/geo/peaks.ts`, re-exported by `deck/terrain-data.ts`); WebGPU gathers the same calls (`deck-webgpu/engine.ts:1576`) | `viewPeaks` used a 60 m, 17-sample ring and kept the OSM node position (fixed in U2 below) |
| Visibility | Screen-space: two samples of the rendered range buffer 0.4 % and 0.9 % of the height below the projected summit; visible if either is sky or farther than `0.97·range − 50 m` (`deck/engine.ts:2192`, `deck-webgpu/engine.ts:3177`; GPU verdict twin `deck/geo-query.ts`, exact by construction) | Ray march along the bearing, `apparentElevation` with curvature + refraction (k = 0.13), tolerance 0.05°, last `max(150 m, 2 %·d)` ignored (`geo/peaks.ts viewPeaks`) |
| Rank / declutter | `look/labels/rank.ts:19` `peakRank = 3·prominence + ele − 0.012·range`, greedy `declutterClassic` (classic layout is the default of every preset); panorama/inline use `layout.ts:405` (log prominence with an ele fallback, screen isolation, hysteresis) | `geo/peaks.ts score` (prominence + 800·wikidata − 3000·unnamed + 0.1·height + 400·elevation° − 0.002·d), `layoutPeakLabels` 3 % spacing |

Curvature/refraction are consistent: `EnuFrame.fromGeo` and both terrain shaders apply the same k = 0.13 lift (`geodesy.ts:20`, `deck/batched-terrain-layer.ts:111`, `deck-webgpu/layers/batched-terrain.ts:200`).

Data facts (bundled regions 0–7, `public/photos/region-*.json`): 193–3052 named peaks per region; `ele` missing on 0.2–4 %; `prominence` tagged on < 1 % (21 of 2607 in region-0, mostly the famous summits: Finsteraarhorn 2278, Eiger 364, Rigi 1289); bilingual or compound names ("Blinnenhorn / Corno Cieco", "Adula - Rheinwaldhorn", and non-bilingual "Geisspfadspitzen - Südgipfel") on 24 / 17 peaks in regions 0 / 1.

## 2. Findings (ranked)

**P1**
- **F1 Gipfelbuch claim vs code.** The peak page (`src/lib/gipfelbuch/pages/peak.tsx:65-70`, steps at ~1950-2090) explains `viewPeaks` / `layoutPeakLabels` as *the* mechanism. The app's labels come from `snapPeaksNear` → render-buffer occlusion → `rankPeaks`/`declutterClassic`. The page also said the local-max search "is the one described on the snapping page" (9×9, `min(250, 60+0.004·d)`), which geo/peaks.ts did not do (60 m ring). Fixed in code by U2; page text: see §6.
- **F2 Classic rank is effectively `ele − 0.012·range`, plus a large bonus for the 1 % of peaks with a tagged prominence** (`3·prom`: Finsteraarhorn gets +6834, worth 6.8 km of extra height or 570 km less range). Untagged notable summits (Niesen, Stockhorn, Pilatus) compete on height alone; peaks without `ele` rank at 0 m. The tags we have are on major peaks, so the bias is mostly benign in CH, but it is arbitrary elsewhere. `rank.ts` is peer-owned and pinned by `labels.check` + the STYLE gate → proposal P-R1.
- **F3 About a quarter of snaps climb a flank instead of finding a summit.** No snap-quality evidence existed before (only CPU = GPU identity, batch-ledger B4). The U4 dev study used 9,435 catalogue peaks in regions 0–7, 150 m–110 km from the region's photos, with cached Mapterhorn z10–13 (mostly z11–12) and the live rule reimplemented verbatim. Results:
  - **Border hits.** 22 % of peaks put the argmax on the 9×9 grid's outer ring (10 % under 5 km, 23 % at 20–110 km). For 84 % of those, the maximum still rises at 2× radius: the grid is walking up the slope towards a higher neighbour.
  - **Angular error.** The median shift for border hits is 0.36° (p90 0.52°), against the pose budget of about 0.3°.
  - **Collisions.** There are 98 pairs of distinct peaks whose snaps land within 30 m of each other; in 93 of them the OSM nodes are more than 30 m apart (e.g. Berneuse + Geteillon, Crêta + Crêta Besse).
  - **Corners.** The grid is a square in lat/lon, so the reach is 1.41·r at the corners: 353 m, not the documented 250 m.
  - **Height.** `h_snap − ele` has median −4 m and p90 +40…58 m in the Alps.
  - **DEM dependence.** At z10 (~150 m cells), border hits rise to 25 %.
  - Script: `scratchpad/peak-study/snap-study.mts` (session scratchpad, not tracked). These are dev evidence only, not a benchmark.
  - **Response.** The flag `peakSnapInterior` (U6, off) keeps the node when the maximum is on the ring.

**P2**
- **F4 Three OSM height parsers disagreed.** `geo/peaks.ts` read `"4'478"` as 1 ft (0.3 m) and only lower-case `ft`; `upload/region.ts` read `"6000'"` as 6000 m; `ingest.mjs:341` uses bare `parseFloat` (`"4'478"` → 4, `"9,000 ft"` → 9). No bundled region shows a mis-parse today (one ele < 60 m, Laurel Hill 56 m, real). Fixed in U1 (geo + upload) and U5 (lakes); `ingest.mjs` (plain `.mjs`, bundled regions) remains → P-N3.
- **F5 Names are not localised.** Only `name` reaches the region JSON; bilingual "A / B" labels are long and widen the declutter box (`rank.ts:42` uses `name.length`). `name:de/fr/it/en` and `wikidata` exist in OSM and the extract keeps `name:de/en` (`osm/extract.ts:49`) but not `fr/it`. Needs a data-schema change in `photos.ts RegionPeak` (photo step owns `photos.ts`) and a re-ingest (network) → P-N1.
- **F6 Catalogue is a 60 km bbox, the app culls at 110 km.** Peaks 60–85 km away appear only in the box corners (diagonal), so a 70 km summit is labelled to the NE but not to the N. Either make the catalogue a disc or document it → P-N2.
- **F7 Duplicated occlusion literals.** Both engines' CPU loops hard-coded `[0.004, 0.009]` and `0.97·r − 50`; the GPU kernel and its exactness proof read `OCC_DVS` / `occThreshold` from `geo-query.ts`. Tuning one would silently break CPU = GPU. Fixed in U3.

**P3**
- **F8 Partial visibility.** A tip that pokes < 0.4 % of the frame height above a nearer ridge is dropped (both samples hit the nearer ridge). Precision-first, so acceptable; noted for the label owner.
- **F9 Twin code.** The occlusion loop, the people-mask pass and the label mapping are copied in `deck/engine.ts:2174` and `deck-webgpu/engine.ts:3155`. A shared helper in `deck/scene.ts` would remove ~40 lines (eye-rule owns scene.ts → P-S2).
- **F10 `SnappedPeak.ele` is the OSM tag, not the DEM summit**: the label shows OSM ele (fine), but rank uses it too, so an `ele`-less peak ranks as 0 m (part of F2).
- Ontology note already recorded: three `Peak` shapes (`geo/peaks.ts`, `photos.ts RegionPeak`, `deck/scene.ts Peak`), no id on RegionPeak (`reports/ontology.md:35`).

## 3. Research summary

Internal (no prior work on prominence, isolation, Wikidata, `name:xx`, snap radius or visibility thresholds; no recorded negatives for this step):
- `reports/swiss-map-typography.md` items 2(a), 3, 5: `peakRank` "a good seed", add hysteresis; DEM line-of-sight then prominence/elevation/distance weighting; `name:latin`-style single labels; bilingual labelling not researched.
- `reports/licences.md:25, 46, 111-145`, `NOTICE.md:31`: region JSON and `public/osm/*.json` are ODbL derivative databases; "© OpenStreetMap contributors" is on the PNG footer; the kumi mirror lags ~10 nodes.
- VSWEEP (peaks as pitch evidence) is KILLED (`reports/negative-results.md:21`): do not reuse matched peaks as a pose signal under this step.

External (sources):
- OSM is ODbL 1.0; rendered labels are Produced Works (attribution), shipped region/extract JSON are Derivative Databases (share-alike). https://osmfoundation.org/wiki/Licence/Community_Guidelines
- Wikidata is CC0 (P2044 elevation, P2660 prominence, multilingual labels); join on the OSM `wikidata` tag. Licence-clean enrichment at build time.
- Kirmse & de Ferranti global prominence/isolation (Progress in Physical Geography 2017; code MIT, https://github.com/dfunke/mountains): no explicit dataset licence found → do not ship the data; the method (isolation, prominence from DEM) is reusable.
- swissNAMES3D: swisstopo OGD, attribution "© swisstopo"; OSM wiki judged it ODbL-compatible. https://wiki.openstreetmap.org/wiki/Switzerland/swissNAMES3D
- Bilingual OSM names: `name="A / B"` (CH) or `"A - B"` (South Tyrol) plus `name:xx`; " - " is also used for sub-summits, so splitting `name` is unsafe without `name:xx`. https://wiki.openstreetmap.org/wiki/Switzerland/swissNAMES3D
- PeakVisor uses prominence to decide which summits get labels (Ultras > 1500 m flagged): https://peakvisor.com/en/news/mountain_prominence.html. PeakFinder/PeakLens visibility rules are not published; Baboud et al. 2011 (https://resources.mpi-inf.mpg.de/photo-to-terrain) annotate after silhouette alignment. Our render-buffer depth test is the standard approach for an already-rendered view.
- OpenMapTiles `mountain_peak` ships `name:xx` and a per-tile `rank`: https://openmaptiles.org/layers/mountain_peak

## 4. Plan

| Unit | What | Size / risk | Gate | When |
|---|---|---|---|---|
| U1 | One OSM height parser `parseOsmMetres` (geo/peaks.ts), `upload/region.ts parseMetres` delegates; Swiss `1'234` = thousands, trailing `'`/ft/feet (any case) = feet | S / low | vitest geo + upload specs, tsc | now (landed) |
| U2 | Single snap rule: `peakSnapRadiusM` + `localMaxOf` move to geo/peaks.ts (terrain-data re-exports, app bit-identical); `viewPeaks` snaps with it and aims at the snapped summit | S / low (baseline outputs change; app unchanged) | vitest, height-gather, labels, tsc | now |
| U3 | Engines' CPU occlusion loop uses `OCC_DVS` / `occThreshold` | XS / very low, bit-identical | tsc, geo-query spec | now |
| U4 | Snap-quality study (node, cached DEM): displacement, border hits, flank climbs, collisions | S / none (scratchpad script) | evidence only | now (done, F3) |
| U5 | `parseOsmMetres` moves to a leaf module `src/lib/osm/metres.ts` (no camera/concord imports for upload and lakes); `geocam/lakes/levels.ts parseEle` delegates | XS / low | vitest geo, upload, lakes | now |
| U6 | `?peakSnapInterior=on` (default off): a ring maximum keeps the OSM node position and its DEM height; both engines (CPU `TerrainSet.localMax`, WebGPU gathered replay) | S / medium when on, none off (bit-identical) | specs; label batch A/B before any default flip | now (flag); flip later |
| P-S3 | Collision dedupe: when two snaps land within ~30 m, keep the higher-ranked name there and put the other back at its node | S / low | specs + label batch | later (scene.ts, eye-rule owner) |
| P-S4 | Disc instead of square (drop the 12 grid points beyond r, or scale the corners) so the reach is the documented 250 m | XS / medium (moves labels) | label batch, together with U6 | later |
| P-R1 | Rank without tag lottery: `peakRank` uses `prominence ?? isolationProxy`, `ele ?? demSummit`. Proxy = catalogue isolation (distance to the nearest higher catalogued peak, capped) or the layout.ts fallback | M / medium (changes default labels) | labels.check rebaseline + STYLE gate in a batch | later, labels owner |
| P-S1 | Flip `peakSnapInterior` to on after a label batch on `/photo/demo-*` (both renderers) shows labels sitting on summits, not flanks | XS / medium | label batch A/B (`?peakSnapInterior=on` vs off) | later, batch owner |
| P-S2 | Factor the twin occlusion + people-mask + mapping into `deck/scene.ts` | S / low | tsc, deck smoke in a batch | later, eye-rule owner |
| P-N1 | Keep `name:de/fr/it/en` + `wikidata` in RegionPeak (`photos.ts`), `osm/extract.ts EXTRACT_TAGS` + `fr/it`, label picks the UI-locale name, falls back to `name` | M / low | specs; needs re-ingest (network) | later, photo step + user |
| P-N2 | Catalogue disc of 60 km (or a 110 km disc to match the cull) | S / low | specs | needs user (label density vs Overpass load) |
| P-N3 | `ingest.mjs` uses `parseOsmMetres` (run via tsx) | XS / low | re-ingest | later |
| P-W1 | Wikidata enrichment at build time (P2660/P2044, CC0) for prominence | M / low | licences.md row | needs user (new data source) |

## 5. Decisions for the user
- D1: Should labels follow the UI locale (P-N1)? This needs a re-ingest of the bundled regions with `name:xx`.
- D2: Catalogue shape (P-N2): a 60 km disc (fewer, consistent labels) or a 110 km disc (more distant labels, ~3× Overpass payload).
- D3: Wikidata as a second catalogue source (P-W1, CC0) for prominence; and whether the rank change P-R1 may move default labels (STYLE gate rebaseline).

## 6. Gipfelbuch corrections (for the Gipfelbuch owner; graph.ts and pages not edited)
- `peak.modules`: add the live path. Suggested: `["src/lib/geo/peaks.ts", "src/lib/deck/scene.ts", "src/lib/deck/geo-query.ts", "src/lib/look/labels/rank.ts", "src/lib/photos.ts"]`.
- `peak.summary` (suggested): "A named OpenStreetMap summit with its height (prominence where tagged), moved onto the highest DEM point within 60–250 m and labelled only when the rendered terrain just below it is the peak itself or sky."
- `pages/peak.tsx`: the "March the ray" step and the header comment describe the baseline (`/baseline`, node scripts). Add one line that the app answers the same question from its rendered range buffer (`deck/geo-query.ts`: two samples just below the summit, visible if sky or farther than 0.97·range − 50 m). After U2 the "Settle the height" step's reference to the snapping page's local max is true; the page's own constants block (line 66) should say the snap uses `min(250, 60 + 0.004·d)`.
- The ranking formula on the page (`score`) is the baseline's; the app's classic rank is `3·prominence + ele − 0.012·range` (`look/labels/rank.ts:19`).

## 7. Status (2026-10-02)

Landed on master:
- `81cbb99` U1: `parseOsmMetres`, the one OSM height parser.
- `d0a1a4f` U3: both engines' CPU occlusion loop reads `OCC_DVS` / `occThreshold`. Bit-identical; batch-ledger row added.
- `72fefe8` U2: `peakSnapRadiusM` + `localMaxOf` live in `geo/peaks.ts`; `viewPeaks` snaps and aims at the snapped summit. The app is bit-identical; `/baseline` and Gipfelbuch bake outputs move to the snapped summit the next time they are regenerated.
- This branch (U5, U6 + review fixes): `osm/metres.ts` leaf module, `levels.ts` delegates; `?peakSnapInterior=on` (off by default, bit-identical off; the replay-order spec covers it); `viewPeaks` skips far peaks before snapping and takes `snapInterior`. The landed shas are in the git log under "geo/peaks" / "osm/metres".

Iterations:
1. Implement U1–U3.
2. Evidence (U4), which turned up flank climbs → U6.
3. An adversarial Sonnet review: no blockers. Fixed from it:
   - viewPeaks snapped peaks beyond `maxDistance` (82 wasted samples each).
   - viewPeaks did not take the interior rule.
   - Missing specs for `osm/metres`, interior replay and the lakes feet mark.
   - The flag doc did not say snaps are cached per terrain.
   Kept as a nit: viewPeaks filters on the snapped distance with a 50 m minimum, while the app filters on the node distance with a 150 m minimum.

Negative / not done: none of the units was negative. Snap quality is measured only as dev evidence; whether interior snapping puts labels *more correctly* on summits has not been measured against labelled photos. That needs a label batch, or a hand-labelled set of summit pixel positions.

Not verified: no browser runs (cook mode). `d0a1a4f` and U6 are browser-unverified; U6 is behind a default-off flag.

Next (top 3):
1. A label batch A/B for `?peakSnapInterior=on`, together with P-S4 (disc) and P-S3 (collision dedupe), then flip the default if labels sit on summits.
2. P-R1 rank without the prominence-tag lottery (labels owner, STYLE rebaseline).
3. P-N1 localised names (`name:xx` in RegionPeak, re-ingest; user decision D1).
