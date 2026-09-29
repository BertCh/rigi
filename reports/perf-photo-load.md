# /photo/$id load performance: profile, tile cache, recommendations

Date: 2026-09-24. Scope: time from navigation to `[data-ready]` on `/photo/<id>` (dev server :3100, headless Chromium with `--use-angle=metal --ignore-gpu-blocklist --enable-gpu`). Photos: IMG_7131, IMG_7033, IMG_7155.
Deliverables: `src/lib/cache/` (new module), this report. No app files were edited. The wiring diffs in §6 are for mt-image-9e to apply.

**TL;DR.** The ~10 s load has three causes. Tile networking is not one of them:

1. **`Terrain.heightAt` is O(#tiles) with trig per tile.** `buildPeaks` + `buildTrails` call it about 340 k times, which comes to **2.7–3.2 s on every load**, cold or warm, and blocks the main thread as one ~3.3 s task. Indexing tiles by `z/x/y` cut this to **0.16 s** with identical output (measured in the live engine).
2. **Init waits for `/photos/region-N.json` before doing anything.** The dev server brotli-compresses this 2.2 MB file on every request, which takes **2.2–5 s cold (up to 11 s)**. Tile loading, the photo and segmentation all start only after it arrives.
3. **MediaPipe segmentation (3.1 MB wasm + 16.4 MB model).** It takes 1.6–7.6 s after init starts, and alignment waits for it. Today it is partly hidden behind (1). Once (1) is fixed it becomes the critical path.

The DEM tiles take 1.2–2.3 s: about 1.1 s of main-thread mesh building plus 0.1–1 s of network. The cache removes the network part and the dev double-load, but it cannot remove the mesh building.

---

## 1. Method

The profiling harnesses are in the session scratchpad (`…/scratchpad/perf/`). None of them are in the repo.

| Harness | What it does |
|---|---|
| `instrument.js` (addInitScript) | Patches `fetch` (timing, in-flight count, body-read time), `createImageBitmap`, `(Offscreen)CanvasRenderingContext2D.getImageData`, `WebGL(2)RenderingContext.readPixels` and `HTMLImageElement.decode`, and adds a long-task `PerformanceObserver`. A `window.__engine` setter wraps `init` (with `onProgress` timestamps and a segment-callback timer), `computeHorizon`, `autoAlign`, `buildPeaks`, `buildTrails` and `renderNow`. It also imports the *same* `terrain.ts` module instance (exact `?t=` URL from Resource Timing) to wrap `Terrain.load`, `fetchTiles` and `buildMesh`. |
| `profile.mjs` | CDP `Network` (waterfall, bytes, cache flags), `Profiler` (250 µs sampling, self and inclusive time), `Performance.getMetrics`, and a Chromium trace for the cold runs. **cold** = fresh context with `Network.setCacheDisabled`. **first** = fresh context with cache on. **warm** = 2nd navigation in the same context. Run 3× per photo in two modes: **dev**, as served (React StrictMode mounts the effect twice, so there are 2 engines), and **single**, where init of the disposed StrictMode engine is skipped to emulate production. |
| `whatif.mjs` | After ready, re-times phases in isolation and validates candidate fixes by monkey-patching the live engine. |
| `bench-tiles.mjs`, `bench-cold.mjs` | Load the exact DEM URLs the app requested (from the network log) through plain `fetch` (the app's pool of 24) and through `cachedFetch`, each followed by `createImageBitmap`. Scenarios: cold, 2 concurrent loaders, and warm after a browser restart (persistent profile). |
| `app-shim.mjs` | Full-app before/after without editing app files. An init script reroutes the page's DEM `fetch` calls through `cachedFetch` (a service-worker-like shim). `--fixed` also patches `Terrain.prototype.heightAt` with the indexed version. |

**Noise warning.** Several sessions share this dev server and machine. HMR reloads, CPU contention and a shared uplink made individual samples swing by 2–3×. Medians of 3 runs are given below, with ranges where useful. Per-phase durations are much more stable than end-to-end `ready`.

---

## 2. Ranked bottlenecks

Numbers are medians over 3 runs; `a / b / c` = IMG_7131 / IMG_7033 / IMG_7155. **single** is production-like (one engine); **dev** is what localhost:3100 shows today. "Crit." marks whether the phase is on the critical path to `[data-ready]`.

| # | Phase | single cold (ms) | single warm (ms) | dev cold (ms) | dev warm (ms) | Crit. | Evidence |
|---|---|---|---|---|---|---|---|
| 1 | **Region JSON fetch before `engine.init`** (dev server brotli-compresses 2.18 MB on the fly) | 3521 / 5021 / 3370 (range 2178–8041) | 48 / 6 / 39 | 2995 / 4303 / 2517 (up to 11200) | 43 / 6 / 39 | **yes, blocks everything** | curl: identity 5 ms, gzip 60 ms, **br 3184 ms**, zstd 1981 ms. The photo JPEG is also br'd on the fly (1.3 s via curl). |
| 2 | **`buildPeaks` + `buildTrails`** (`Terrain.heightAt` → `tileBounds` → `tileYToLat` per tile per call) | 3067 / 2773 / 3152 | 3140 / 2796 / 3161 | 3139 / 2809 / 3159 | 3097 / 2799 / 3095 | **yes** (one ~3.3 s long task) | CPU profile: `heightAt` 2675 ms inclusive, `tileBounds` 2246, `tileYToLat` 1919. 250 k `heightAt` calls from peaks (3052 peaks × 81-sample `localMax`) + 87 k from trails. **Indexed lookup: 2209→103 ms and 834→54 ms, max position diff 0 m.** |
| 3 | **MediaPipe segmentation** (tasks-vision 0.7 MB + wasm 3.1 MB + `selfie_multiclass_256x256.tflite` 16.4 MB + GPU delegate init; inference only 22 ms) | done at init + 5320 / 5138 / 5593 | init + 5674 / 4447 / 5242 | init + 7236 / 3347 / 2513 | init + 5697 / 6037 / 1872 | partly now; **fully once #2 is fixed** | Starts at init together with the tiles. `init` awaits it before `buildEdgeMap`. The 16 MB model was re-downloaded on every "warm" run: it is too big for Playwright's in-memory HTTP cache, and GCS sends `max-age=3600`. |
| 4 | **DEM tiles: fetch + decode + mesh** (`fetchTiles`) | 1931 / 1574 / 2116 | 1327 / 1240 / 1276 | 9624 / 9013 / 3519 | 2503 / 5249 / 2435 | yes | 165 / 175 / 173 tiles, 21.5 / 22.5 / 24.5 MB. The main-thread floor is about 1.1 s: `buildMesh` 690–800 ms (of which `computeVertexNormals` about 380 ms), `decodeTerrarium` + `getImageData` about 200 ms. WebP decode runs off-thread (trace: 330 decodes = 1392 ms on the thread pool, about 4.2 ms each). The `createImageBitmap` wall time sum (16–60 s) is queueing, not work. |
| 5 | **Dev StrictMode double mount** | n/a | n/a | ×2 tiles (330–350 req, 43–49 MB), ×2 mesh (1.4–1.6 s), ×2 segmentation | ×2 | inflates #4 and #3 | The disposed engine's `Terrain.load` keeps running because no `AbortSignal` is passed. It is dev-only, but so is the reported 10 s. |
| 6 | JS bundle / Vite transform (engine constructed at) | 516 / 1004 / 388 | 235 / 216 / 388 | 670 / 624 / 466 | 257 / 282 / 316 | yes, small | 151–155 module requests, 17.2 MB unminified. `lucide-react` alone is 4 MB in dev (the barrel import is tree-shaken in production). |
| 7 | `autoAlign` (grid + coordinate descent) | 185 / 172 / 205 | 193 / 174 / 186 | 203 / 182 / 184 | 192 / 180 / 177 | yes | Plus a 30 ms `setTimeout` before it. |
| 8 | `computeHorizon` (8 geometry renders + 8 × 1024×1536 RGBA32F readbacks) | 139 / 159 / 260 | 162 / 204 / 217 | 208 / 171 / 183 | 179 / 228 / 152 | yes | `readPixels` for the 8 views takes 82–136 ms of that (7–25 ms each). |
| 9 | `buildEdgeMap` (512 px) | ~33 | ~33 | ~33 | ~33 | yes | Measured in isolation. |
| 10 | Photo JPEG `img.decode()` (2048×1536) | 15 / 17 / 19 | 42 / 16 / 18 | 15 / 22 / 13 | 15 / 14 / 17 | yes | Negligible. |
| 11 | Other GPU readbacks | 1024×768 float 6–13 ms per pose change; 384×288 ×5 at 3–10 ms | | | | no | `GLES2::ReadPixels` total 147 ms / 17 calls in the trace (including the horizon). |

End-to-end ready (median of 3; the environment is noisy): **single cold** 11.7 / 12.8 / 20.7 s (the IMG_7155 runs were hit by HMR reloads), **single warm** 8.1 / 7.3 / 7.0 s, **dev cold** 13.1 / 20.5 / 10.4 s, **dev warm** 6.5 / 6.9 / 6.3 s. With the region JSON served from disk (the `app-shim` harness), single-engine uncached ready is 6.1 / 7.2 / 6.8 s.

**Critical path, single-engine warm, IMG_7131 (typical):** init at 0.3 s → tiles +1.2 s → peaks/trails +3.1 s (long task) → wait for segmentation (done at +5.2–5.7 s) → edge map + horizon +0.2 s → autoAlign +0.2 s → ready at about 6.5–8 s.

### Network waterfall summary

- **DEM** (`tiles.mapterhorn.com`, HTTP/2, Cloudflare, `cache-control: public, max-age=604800`, `ACAO: *`). Each photo loads 165–175 unique 512 px WebP tiles, 21.5–24.5 MB, median 139 KB each. Single-engine cold (IMG_7131): **1.9 s span, TTFB p50 85 ms / p90 142 ms, per-request p50 69 ms / p90 232 ms, in-flight max 24 (capped by `pool(24)`) / avg 11.4, 0 failures, 0 fallbacks to AWS Terrarium.** Bytes by zoom: z14 7.4 MB (34%), z12 3.7, z10 3.5, z13 3.3, z11 3.1, z9 0.6.
- **Dev double mount**: 330–350 requests / 43–49 MB, **50% exact duplicates**, 48 in flight. Per-request p50 1.4 s / p90 6.4 s, because the uplink is saturated by the double load plus 20 MB of MediaPipe at the same moment.
- **Wedge**: IMG_7131 loads 165 of 345 selected tiles up front (z9 4, z10 26, z11 29, z12 31, z13 24, z14 51). The rest is `loadPending` for world view, after ready.
- **MediaPipe**: tasks-vision.js 0.7 MB (Vite dep), `vision_wasm_internal.js` 79 KB + `.wasm` 3.1 MB (jsDelivr), model 16.4 MB (GCS, `max-age=3600`). These start at init, alongside the tiles.
- **Region JSON**: 2.18 MB raw / 341 KB br. It is fetched first and alone, and nothing else starts until it lands.
- **Vite**: 151–155 requests, 17.2 MB, all done by 0.3–1.0 s cold.

---

## 3. `src/lib/cache/` API

Files: `index.ts` (public API), `tile-cache.ts` (tiers), `queue.ts` (priority queue, pure), `lru.ts` (byte-capped LRU index, pure), `store.ts` (Cache API / IndexedDB / memory / null stores). Formatted with biome (tabs, double quotes). `tsc` is clean. No new dependencies.

```ts
import { cachedFetch, cachedFetchBuffer, tilePriority, tileQueue, cacheStats, clearTileCache,
         configureTileCache, getTileCache, readDerived, writeDerived } from '#/lib/cache'

// Drop-in for fetch(url, { signal }) on tile URLs. Fresh Response per caller; header x-tile-cache: memory|persistent|network.
// Non-2xx resolve with that status and an empty body (like fetch); network errors and aborts reject (AbortError).
cachedFetch(url: string, { priority?: number, signal?: AbortSignal, persist?: boolean }): Promise<Response>
cachedFetchBuffer(url, opts): Promise<ArrayBuffer | null>        // private copy; null when not 2xx

tilePriority(distanceM: number, z?: number): number             // km to camera + 0.01·z; lower runs first
tileQueue.reprioritize((url, current) => number | undefined)    // e.g. after the camera moves
tileQueue.setPriority(url, p) / .cancel(url) / .cancelQueued(match?) / .stats() / .idle() / .concurrency (get/set)
cacheStats(): { backend, entries, bytes, capBytes, memory{…}, hits{memory,persistent}, misses,
                network{bytes,errors,notOk}, writes{ok,failed,pending}, evictions, queue{queued,running,deduped,cancelled,…} }
clearTileCache(): Promise<void>
configureTileCache({ capBytes = 300 MB, memoryCapBytes = 64 MB, concurrency = 24, writeConcurrency = 2,
                     backend: 'auto'|'cache'|'idb'|'memory'|'none', name = 'summit-lens-tiles-v1', metaDebounceMs = 2000,
                     fetchInit = { mode: 'cors', cache: 'no-store' } })   // cache-wide; no per-caller init (requests are deduped)
writeDerived(key, ArrayBuffer) / readDerived(key)                // e.g. decoded Float32 heights; shares the LRU cap
```

Behaviour:

- **Lookup order**: memory hot tier (64 MB LRU) → persistent store → network through the queue. Store reads are deduplicated too.
- **Persistent store**: Cache API under synthetic `https://summit-lens-tile-cache.invalid/<key>` URLs, so no Vary or opaque-response issues. It falls back to IndexedDB (with a 3 s open timeout, so a blocked upgrade can't hang loading), then to memory. `backend: 'none'` disables persistence. **Every storage call is wrapped in try/catch.** A failure is treated as a cache miss and never throws into the render path; this was tested with both `caches.open` and `indexedDB.open` throwing.
- **LRU with byte cap**: `LruIndex` is a Map in recency order with a byte total. It is persisted as JSON metadata (debounced 2 s, and flushed on `pagehide`). At open, a shrunk cap is enforced immediately. If the index is missing, any orphaned bodies are wiped. An index entry whose body the browser evicted is dropped. A write that fails (e.g. quota) sheds 25% of the cache and retries once.
- **Writes**: they go through their own 2-slot queue, so they don't compete with reads. `flushWrites()` / `flushMeta()` are available for tests and shutdown.
- **Queue** (`PriorityQueue`): lowest priority number runs first, FIFO on ties. In-flight dedupe: a joined job takes the minimum priority of its callers. **Per-caller AbortSignal**: aborting one caller rejects only that caller. The job is dequeued, or its fetch aborted if it is already running, only when *all* callers have aborted. A later request after a cancel starts a fresh job. `reprioritize()` works on queued jobs.
- **HTTP cache bypass**: network fetches default to `cache: 'no-store'`, so tiles aren't stored twice (HTTP cache + Cache API). Override via `configureTileCache({ fetchInit })`.
- **Negative cache**: 404/204 responses are remembered for the session, so DEM→Terrarium fallback chains don't re-request.
- **Default concurrency 24**: an interleaved A/B showed 16 was 100–160 ms slower on a 170-tile cold load over HTTP/2 (below).

**Tests** (in the scratchpad):
- `test-node.mts` (tsx): **21/21 pass**. Covers LRU eviction order, replace, oversize entries, JSON round-trip and malformed input; queue concurrency, priority, FIFO, dedupe, min-priority join, partial and full abort (queued and running), fresh re-request after abort, pre-aborted signals, reprioritize, cancelQueued, idle, and sync-throw, mid-flight abort counted as cancelled only (not failed); fetchInit defaults; TileCache tiers, LRU cap, 404 negative cache, network errors, abort, `none`/`memory` backends, the node fallback, bounded write concurrency, and `cachedFetch` Response semantics plus the derived API.
- `test-browser.mjs` (Playwright against the dev server's transformed TS, with small caps): **11/11 pass**. Covers the real Cache API and IndexedDB backends, WebP decoding from cached bodies, LRU cap enforcement (350 kB cap → evictions), **survival across a browser restart** (persistent profile, 0 network), and graceful fallback with both storage APIs throwing.

---

## 4. Before/after measurements

### 4a. Tile phase in isolation

Setup: the exact DEM URLs each photo requested, fetched and then `createImageBitmap`'d, like `terrain.ts`. Medians of 5 runs; the CDN edge was warmed first.

| scenario | IMG_7131 | IMG_7033 | IMG_7155 | network |
|---|---|---|---|---|
| plain fetch, no HTTP cache (the app today, cold) | 861 ms | 610 ms | 762 ms | 165–175 req, 21.5–24.5 MB |
| plain fetch ×2 concurrent loaders (StrictMode today) | 1082 ms | 1142 ms | 1435 ms | **330–350 req, 43–49 MB** |
| **cachedFetch ×2 concurrent loaders** (in-flight dedupe) | 974 ms | 1085 ms | 1175 ms | **165–175 req, 21.5–24.5 MB** |
| plain fetch, **warm HTTP disk cache** (after restart) | 82 ms | 79 ms | 97 ms | 0 MB |
| **cachedFetch, warm Cache API, HTTP cache off** (after restart) | 109 ms | 109 ms | 138 ms | **0 req** |
| cachedFetch, memory tier (same page) | 70 ms | 72 ms | 97 ms | 0 req |

Cold-path overhead (`bench-cold.mjs`, interleaved, 4 runs each, median):

| | plain | cachedFetch c=16 | **cachedFetch c=24 (default)** | c=24, no persistence |
|---|---|---|---|---|
| IMG_7131 | 567 ms | 662 ms | **564 ms** | 606 ms |
| IMG_7155 | 769 ms | 929 ms | **750 ms** | 725 ms |

At the default concurrency of 24, the cache costs nothing on a cold load, and write-behind persistence is free. Warm Cache API reads are within 30–40 ms of a warm HTTP disk cache for 170 tiles. The cache's value therefore comes from four things:
- (a) dedupe, which halves requests and bytes when two consumers load the same tiles;
- (b) persistence that doesn't depend on HTTP-cache heuristics or eviction. Tiles expire after 7 days. The 16 MB model expires after 1 h. The HTTP cache is shared with everything else. A re-fetch costs 0.6–0.9 s per photo on this connection and far more on a slow one;
- (c) nearest-first priority and cancellation when the user navigates away;
- (d) a home for derived data (`writeDerived`) and for the segmentation model.

### 4b. Full app via the fetch shim

Region JSON is served from disk in all arms to remove the brotli noise. Note that `ctx.route` disables Playwright's HTTP cache, so "no cache" means no HTTP cache. Values are medians: `ready` / tile phase.

| | IMG_7131 | IMG_7033 | IMG_7155 |
|---|---|---|---|
| single, no cache (n=6) | 6078 / 1242 ms | 7188 / 1703 ms | 6775 / 1443 ms |
| single, cachedFetch, empty store (n=4) | 5820 / 1689 ms | 6624 / 1480 ms | 6519 / 1893 ms |
| **single, cachedFetch, warm Cache API after restart** (n=2) | 6888 / **1019 ms** | 5676 / **1311 ms** | 6095 / **1175 ms** |
| dev, no cache: DEM requests | 330 req / 43.1 MB | 350 / 45.0 MB | 346 / 49.1 MB |
| **dev, cachedFetch: DEM requests** | **165 / 21.5 MB** (165 deduped) | **175 / 22.5 MB** | **173 / 24.5 MB** |
| **single + indexed `heightAt` (`--fixed`), no cache** (n=3) | **3155** / 1424 ms | **3425** / 1262 ms | **3595** / 1933 ms |
| **single + indexed `heightAt` + warm Cache API** (n=1) | 5274* / 1092 ms | **3487** / 1223 ms | **3334** / 1116 ms |

(*that sample's segmentation finished at init + 3.5 s: the model was re-downloaded, not cached.)

Reading the table:
- The warm Cache API brings the tile phase to its CPU floor, **−220 to −390 ms** (−17 to −23%), with **0 bytes** transferred.
- In dev it removes **50% of DEM requests and bytes**.
- End-to-end `ready` barely moves, because tiles aren't the long pole: peaks/trails (#2) and segmentation (#3) are.
- **Fixing `heightAt` alone takes ready from about 6.1–7.2 s to about 3.2–3.6 s** in the same harness. After that, segmentation (init + 1.4–3.5 s) and the tile phase (1.1–1.9 s) are what's left.

---

## 5. Recommendations (ranked by expected saving)

| # | Change | Files | Expected saving | Risk |
|---|---|---|---|---|
| R1 | Index tiles by `z/x/y` in `Terrain.heightAt` | terrain.ts | **~2.9 s every load**, cold and warm. Removes the 3.3 s main-thread freeze. Measured: 3.04 → 0.16 s, identical output. | very low |
| R2 | Don't await the region JSON before `engine.init`; import the segment module in parallel | PhotoWorkspace.tsx, engine.ts | **2.2–5 s cold in dev** (up to 11 s), because the region latency overlaps the tile loading. Production depends on how the server compresses; precompressing the public JSON also fixes it (build config is outside 9e's files). | low |
| R3 | Segmentation off the critical path: cache the model bytes (`cachedFetchBuffer` → `modelAssetBuffer`, priority −1); give alignment a mask deadline and refine when the mask lands; consider the ~0.25 MB `selfie_segmenter` for the first pass | segment.ts, engine.ts | After R1+R2, segmentation gates ready at init + 1.4–7.6 s. Caching the 16 MB model saves 0.7–6 s whenever it isn't in the HTTP cache (always after 1 h). A deadline caps the wait. | medium: the mask affects alignment accuracy, so re-check with `scripts/eval-app.mjs` |
| R4 | Tiles through `cachedFetch` with `tilePriority`, plus `AbortSignal` plumbing so a disposed engine stops loading | terrain.ts, engine.ts, PhotoWorkspace.tsx | Dev: −50% DEM requests/bytes and about 1.4 s less duplicate mesh CPU. Warm: tile phase to its CPU floor (−0.2 to −0.4 s here, 0.6–1 s+ on slower links), 0 bytes. Fast photo-to-photo navigation stops paying for the previous photo. | low |
| R5 | Tile decode + mesh in a worker pool (or at least replace `computeVertexNormals` with grid normals from the heightfield) | terrain.ts (+ a new worker file) | Tile phase ~1.1–1.3 s → network-bound (~0.1–0.3 s warm). The normals change alone saves about 380 ms. Also frees the main thread during load. | medium |
| R6 | Lower the initial LOD for the photo-view wedge (e.g. `lod: 1.5` up front, full LOD in `loadPending`) | engine.ts | 32% fewer tiles selected (345 → 236 for IMG_7131); roughly −0.3 to −0.5 s on the tile phase | medium: validate alignment with eval-app |
| R7 | Horizon: render at 512×768 per view (or into one atlas and read back once) | engine.ts | about 60–100 ms (readbacks are 82–136 ms) | low |
| R8 | `autoAlign` coarse grid in a worker, or run it at stride 4; drop the 30 ms `setTimeout` | align.ts, PhotoWorkspace.tsx | about 100–200 ms | low |

Not worth doing: the photo JPEG decode (15 ms) and `buildEdgeMap` (33 ms).

---

## 6. Suggested diffs for mt-image-9e (not applied)

These use terrain.ts/engine.ts style (2-space indent, no semicolons, single quotes).

### R1: `src/lib/terrain.ts`, indexed `heightAt` (validated in the live engine)

```diff
 export class Terrain {
   readonly frame: EnuFrame
   readonly group = new THREE.Group()
   tiles: TerrainTile[] = []
+  /** z/x/y → tile, and loaded zooms finest-first, for O(#zooms) height lookups */
+  private byKey = new Map<string, TerrainTile>()
+  private zooms: number[] = []
@@
   /** Metres above sea level at a point, from the finest loaded tile (null if outside). */
   heightAt(lat: number, lon: number): number | null {
-    let best: TerrainTile | null = null
-    for (const t of this.tiles) {
-      const b = tileBounds(t.key)
-      if (lat <= b.north && lat >= b.south && lon >= b.west && lon <= b.east && (!best || t.key.z > best.key.z)) best = t
-    }
-    if (!best) return null
-    const { z, x, y } = best.key
-    return sampleGrid(best.heights, best.size, lonToTileX(lon, z) - x, latToTileY(lat, z) - y)
+    for (const z of this.zooms) {
+      const fx = lonToTileX(lon, z)
+      const fy = latToTileY(lat, z)
+      const t = this.byKey.get(`${z}/${Math.floor(fx)}/${Math.floor(fy)}`)
+      if (t) return sampleGrid(t.heights, t.size, fx - t.key.x, fy - t.key.y)
+    }
+    return null
   }
@@ private async fetchTiles(…)
     this.tiles = [...this.tiles, ...added].sort((a, b) => a.distance - b.distance)
+    for (const t of added) this.byKey.set(`${t.key.z}/${t.key.x}/${t.key.y}`, t)
+    this.zooms = [...new Set(this.tiles.map((t) => t.key.z))].sort((a, b) => b - a)
     for (const t of added) this.group.add(t.mesh)
@@ dispose()
     this.tiles = []
+    this.byKey.clear()
+    this.zooms = []
```

(`tileBounds` stays imported for `inWedge`.)

### R4: `src/lib/terrain.ts`, tiles through the cache, nearest first

```diff
 import * as THREE from 'three'
+import { cachedFetch, tilePriority } from './cache'
 import { type EnuFrame, … } from './geodesy'
@@
-async function fetchImage(urls: string[], signal?: AbortSignal): Promise<ImageBitmap | null> {
+async function fetchImage(urls: string[], signal?: AbortSignal, priority = 0): Promise<ImageBitmap | null> {
   for (const url of urls) {
     try {
-      const res = await fetch(url, { signal, mode: 'cors' })
+      const res = await cachedFetch(url, { signal, priority })
       if (!res.ok) continue
@@ fetchTiles
-      const img = await fetchImage([DEM_URL(key), DEM_FALLBACK(key)], signal)
+      const img = await fetchImage([DEM_URL(key), DEM_FALLBACK(key)], signal, tilePriority(distance, key.z))
@@ loadImagery
-            fetchImage(imageryUrl(src, z, x, y, lat, lon), ac.signal)
+            // +1000: imagery never jumps ahead of DEM tiles
+            fetchImage(imageryUrl(src, z, x, y, lat, lon), ac.signal, 1000 + tilePriority(t.distance, z))
```

The queue already limits the network to 24 concurrent. `pool(keys, 24, …)` can stay as it is; it now limits decode + mesh concurrency. Optional: in `loadPending()`, pass `1e6 + distance` priorities so world-view tiles never compete with a new photo's wedge.

### R4 + R2: `src/lib/engine.ts`, abort on dispose, region as a promise

```diff
+  private abort = new AbortController()
   async init(
-    region: RegionData | null,
+    region: RegionData | null | Promise<RegionData | null>,
     onProgress?: …,
@@
     const terrain = await Terrain.load(this.frame, this.shared, makeTerrainMaterial, {
       onProgress: (d, t) => onProgress?.(`Loading terrain ${d}/${t}`, d / t),
       wedge: { center: this.prior.yaw, halfWidth: hfov / 2 + 32 },
+      signal: this.abort.signal,
     })
@@
-    this.region = region
-    if (region) {
+    const regionData = await region // usually resolved long ago; overlaps the tile phase
+    if (this.disposed) return
+    this.region = regionData
+    if (regionData) {
       onProgress?.('Placing peaks and trails', 1)
-      this.buildPeaks(region)
-      this.buildTrails(region)
+      this.buildPeaks(regionData)
+      this.buildTrails(regionData)
     }
@@ dispose()
     this.disposed = true
+    this.abort.abort()
```

### R2 + R4: `src/components/PhotoWorkspace.tsx`, start everything at once and ignore aborts

```diff
     ;(async () => {
-      const region = await loadRegion(photo.region).catch(() => null)
-      const { segmentForeground } = await import('#/lib/segment')
+      // don't block the photo/terrain/segmentation on the 2 MB region JSON (2–11 s on the dev server)
+      const region = loadRegion(photo.region).catch(() => null)
+      const seg = import('#/lib/segment')
       await engine.init(
         region,
         (msg, frac) => { if (engineRef.current === engine) setStatus({ msg, frac }) },
-        (img) => segmentForeground(img),
+        async (img) => (await seg).segmentForeground(img),
       )
@@
-    })().catch((e) => setError(String(e?.message ?? e)))
+    })().catch((e) => {
+      // a disposed (StrictMode / navigated-away) engine rejects with AbortError: not an error
+      if (engineRef.current === engine && e?.name !== 'AbortError') setError(String(e?.message ?? e))
+    })
```

### R3: `src/lib/segment.ts`, persistent model bytes (and optionally a deadline in engine.ts)

```diff
+import { cachedFetchBuffer } from "./cache";
@@ async function createSegmenter(model: Loaded): Promise<ImageSegmenter> {
-	const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
+	const [fileset, buf] = await Promise.all([
+		FilesetResolver.forVisionTasks(WASM_BASE),
+		// 16 MB model: persist it (GCS sends max-age=3600); priority -1 = ahead of tiles in the shared queue
+		cachedFetchBuffer(MODEL_URLS[model], { priority: -1 }).catch(() => null),
+	]);
 	const make = (delegate: "GPU" | "CPU") =>
 		ImageSegmenter.createFromOptions(fileset, {
-			baseOptions: { modelAssetPath: MODEL_URLS[model], delegate },
+			baseOptions: buf
+				? { modelAssetBuffer: new Uint8Array(buf), delegate }
+				: { modelAssetPath: MODEL_URLS[model], delegate },
```

Deadline option in `engine.ts` `init` (trade-off: without the mask, a person in the frame can mislead the first alignment):

```diff
-    const fg = await fgPromise
+    // don't let a slow model download hold the first alignment hostage; re-align when the mask lands
+    const fg = await Promise.race([fgPromise, new Promise<null>((r) => setTimeout(() => r(null), 1500))])
```

With this, the caller should re-run `autoAlign(false)` (a refine) once `fgPromise` resolves if the first run went without a mask. Validate with `scripts/eval-app.mjs`.

### R5 sketch: move tile decode + mesh off the main thread

- New `src/lib/terrain-worker.ts`. It takes `{ key, url, distance, frame params }`, runs `cachedFetch` → `createImageBitmap` → `OffscreenCanvas` `getImageData` → decode heights → builds `pos`/`uv`/`elev`/`normal`/`index` typed arrays, and posts them back with transfer.
- Normals can come from central differences on the heightfield grid, which is cheaper than `computeVertexNormals` (≈380 ms per photo on the main thread).
- The main thread only wraps them in `BufferAttribute`s.
- `cachedFetch` works unchanged in a worker: the Cache API and IndexedDB exist there. The memory tier is per-context, though, so give the worker pool its own `configureTileCache`.
- Use a pool of 3–4 workers, ordered by `tilePriority`.

### Secondary call sites (other owners)

`src/lib/deck/dem-tiles.ts:62` (the deck renderer) and `src/lib/geo/tiles-browser.ts:7` use plain `fetch` for the same Mapterhorn tiles. Switching either to `cachedFetch` makes the deck and three.js views share one cache and dedupe against each other.

---

## 7. Caveats

- All numbers come from the dev server (unminified modules, StrictMode double mount, on-the-fly brotli). Production will not show #5 or most of #6, and #1 depends on how production serves `/photos/*.json`. R1, R3, R4 and R5 are independent of the build mode.
- Playwright ephemeral contexts don't keep the 16 MB model in the HTTP cache, so the "warm" rows pay for it. A real Chrome profile would revalidate it hourly. The Cache API route (R3) makes that deterministic.
- The shared machine and uplink cause 2–3× variance per sample. Use medians and per-phase numbers, not single end-to-end samples.
