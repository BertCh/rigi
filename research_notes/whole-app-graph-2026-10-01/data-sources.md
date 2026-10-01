# Rigi data sources, loaders.gl check, loader-to-luma adapter design (2026-10-01)

Read-only study of /Users/robertchristie/Documents/GitHub/mt-image. Prototypes in scratchpad/proto-loaders (t1..t4.mjs).

## 1. Data-source inventory

### 1.1 Mapterhorn terrain-RGB DEM (the core dataset)
- URL: `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`, overridable by VITE_MAPTERHORN_URL (src/lib/dem/sources.ts:42-62). Licence: user-approved; self-host option in reports/licences.md (sources.ts:35-41).
- Format: Terrarium RGB (h = R*256 + G + B/256 - 32768), 512 px, lossless WebP (VP8L, confirmed with curl), maxZoom 17 (sources.ts:59-61). Measured 2026-10-01 near Niederhorn: z12 143 KB, z14 166 KB, z16 212 KB per tile.
- Count per photo: TerrainStreamer radius 120 km, z7..17, lod 2 in the view wedge, 0.6 outside (deck/terrain-stream.ts:104-107); load.ts:11 comment says ~200 tiles per /photo load. Estimate 200 x ~170 KB = ~35 MB on the wire, 200 x 1 MiB = ~200 MiB of decoded Float32 (512 x 512 x 4 B; 256 px tiles are 256 KiB).
- Fetch: `cachedFetch` (cache/index.ts:80; memory 64 MB, Cache API 300 MB LRU, 24 concurrent, priority queue). dem/load.ts:fetchTile 62-81 adds retry, 404 negative cache and ancestor fallback (fetchDemBytes 93-118). Workers get a read-only view (cache/index.ts WORKER_OPTIONS).
- Decode: createImageBitmap(colorSpaceConversion none, premultiplyAlpha none) -> OffscreenCanvas 2D -> getImageData -> decodeTerrarium CPU loop into Float32Array (dem/image.ts:11-35, dem/decode.ts:11-19; sea clamp negatives to 0). Page: 1-4 worker pool (dem/load.ts:17-23 + decode.worker.ts), result transferred. Then validateTile (dem/decode.ts:79-192: NO_DATA fill and a BFS connected-component repair of +/-256 m R-channel errors) on the main thread (load.ts:141) or in horizon workers.
- To the GPU: Float32Array -> TileMesh.heights (kept, terrain-data.ts:56) -> `HeightPool.write` = `texture.writeData` into an r32float 2d-array, 256 or 512 layers (deck-webgpu/layers/batched-terrain.ts:241-292 pool, :413 write). Vertex stage does textureLoad + hand bilinear. Needs the float32-filterable feature (gpu/core/device.ts:COMPUTE_FEATURES).
- Duplicates: see 1.8.

### 1.2 Imagery (draped)
- Providers (licences/imagery.ts): default = swisstopo SWISSIMAGE WMTS in the CH bbox z>=8, Esri World Imagery fallback/elsewhere (`https://server.arcgisonline.com/.../World_Imagery/MapServer/tile/z/y/x`); topo = swisstopo Pixelkarte then OSM; `?imagery=esri|swisstopo|custom`. Licence note: Esri is the global default pending owner decision (imagery.ts:11, reports/licences.md); swisstopo OGD needs "(c) swisstopo".
- Format 256 px JPEG/PNG, web-mercator. Per DEM tile a mosaic of 1..16 tiles (extra 0-2 zoom levels, capped z19, until a pixel is <= 1.5 mrad; deck/terrain-data.ts:500-546). Rough count: ~200 DEM tiles x avg ~4 imagery tiles x ~25 KB = ~20 MB per photo (estimate, no measurement in repo).
- Fetch: cachedFetch (terrain-data.ts:483-497, pool of 8). Decode: createImageBitmap on the MAIN thread (fetchBitmap :491), drawn into an OffscreenCanvas mosaic (256*2^k px) and `transferToImageBitmap` (:546).
- To the GPU: ImageryArray (deck-webgpu/imagery.ts) re-resizes each bitmap with createImageBitmap(resize) to 512 px (:150-158), `texture.copyExternalImage` into a rgba8unorm-srgb 2d-array layer (:172-177), then a render-pass mip chain per layer (:187-240). Capacity 64 layers growing to maxTextureArrayLayers (256 core / 2048 Apple); overflow draws hillshade only (imagery.ts:1-8).
- Duplicate: the source ImageBitmaps stay alive in the `images` map (`sources` map, imagery.ts:40) next to the GPU layer; mosaic canvas draw = a second 2D-canvas pass (CPU/2D raster) before upload.

### 1.3 swisstopo COGs (DSM/DTM occluder, flag ?concord=occl)
- STAC `https://data.geo.admin.ch/api/stac/v0.9/collections/{ch.swisstopo.swisssurface3d-raster | ch.swisstopo.swissalti3d}/items?bbox=...&limit=100` (concord/occl/swiss-cog.ts:122-124, 151-190); assets `https://data.geo.admin.ch/ch.swisstopo.swissalti3d/swissalti3d_YYYY_KKKK-KKKK/..._{0.5|2}_2056_5728.tif`. OGD, free incl. commercial, "(c) swisstopo" (swiss-cog.ts:11).
- Format: 1 km COG, float32, LZW, predictor 1, nodata -9999, LV95/EPSG:2056, internal tiles 512 (DSM) or 128 (DTM); swissALTI3D 2 m = 500x500 (1.23 MB file, one overview 250x250). Probed 2026-10-01 (see 2).
- Own minimal parser: IFD/BigTIFF, LZW/Deflate (swiss-cog.ts:273 openCog, :411 lzwDecode, :541 readWindow, :657 pickLevel). Fetch: plain `fetch` with Range (httpRangeFetcher :92-108), NOT cachedFetch, so no persistent cache. Used by concord/occl/ndsm.ts:29,333-334 (DSM 0.5 m + DTM 2 m), only behind the flag. Decode location: wherever ndsm runs (main/worker not fixed in the module). CPU Float32 consumers only (no GPU texture upload found for the nDSM raster; the occluder is a photo-space mask, renderer.ts:85).

### 1.4 3D Tiles (swisstopo buildings/vegetation, Google photorealistic), flag ?tiles3d=
- URLs: `https://3d.geo.admin.ch/ch.swisstopo.swissbuildings3d.3d/v1/tileset.json`, `.../ch.swisstopo.vegetation.3d/v1/tileset.json`, `https://tile.googleapis.com/v1/3dtiles/root.json` (tiles3d/config.ts:51-80). Google is display-only (Map Tiles API terms): never read back, no persistent cache (config.ts:7-9; tiles.ts:7-8). swisstopo heights are MSL, Google ellipsoidal (config.ts:31-35).
- Pipeline: `3d-tiles-renderer` (three) + DRACOLoader/GLTF in tiles.ts:11-18 build THREE meshes; deck-layer.ts turns the THREE geometry/ImageBitmap maps into luma Models (deck-layer.ts:217-225 textureOf). The HTTP cache only, NOT cachedFetch. Decode (glTF/Draco/KTX) inside three loaders on main/worker, unrelated to loaders.gl. Bytes: not estimable from code (screen-space-error driven, errorTarget 8-12 px).
- Duplicate: THREE BufferGeometry on CPU + luma buffers per tile.

### 1.5 Splats (Step Inside near-field)
- Source: our Python service on :8767 (`/gaussians`, nearfield/client.ts:190, :269) returning `.splat-v1` or standard 3DGS .ply (client.ts:96-101). Demo: public/demo/step/splats.splat (802,616 B = 17,835 splats x 45 B + 40 B header; despite the extension it is RIGISPL1 .splat-v1) plus scene.json (1.0 MB) and photo.jpg.
- Format .splat-v1 (nearfield/splat-io.ts:1-10): header 40 B, f32 positions(3), scales(3), rotations(4 wxyz), u8 colors RGBA, u8 provenance, optional u16 source[], ENU origin f64 x3. 45 B/splat. Typical few 100k splats = ~10-40 MB per photo (estimate; demo = 0.8 MB).
- Fetch: plain `fetch`/POST (no cachedFetch). Decode: main (decodeSplatV1/decodeGaussianPly, splat-io.ts) into Float32Array GaussianCloud; deck-splat-layer.ts:112,162 repacks to a 12-float/splat RGBA32F data texture (`Float32Array(width*rows*4)`), sorted on CPU by SplatSorter worker (splat-sort.worker.ts). Duplicate: GaussianCloud CPU arrays kept for export/measure/anchor + the repacked Float32 texture + sort-worker copy.

### 1.6 Demo rolls (public/demo)
- manifest.json 2.8 MB (12 photos with pose/EXIF + data inline), photos 5.9 MB (2048 px JPEG), thumbs 292 KB, shots 1.6 MB, atlas 1.6 MB, step 2.7 MB, how 84 KB. Static same-origin fetch, JPEG decoded via createImageBitmap (no loaders.gl). Image texture upload by copyExternalImage (deck-webgpu/textures.ts:51).

### 1.7 User uploads
- upload/decode.ts: native createImageBitmap for JPEG/PNG/WebP/Safari HEIC; otherwise libheif-js wasm in a worker (LIBHEIF_URL via Vite ?url, LGPL, upload/decode.ts:5-12), output upright JPEG capped at MAX_PX. EXIF in upload/exif.ts. Stored blobs -> bitmap -> texture later as for demo photos.

### 1.8 Vector / peaks / other
- Peaks: Overpass (src/lib/overpass.ts:6-9: overpass-api.de + 3 mirrors) with `overpassPeaksQuery` (geo/peaks.ts:28), parsed in baseline-ui/pipeline.worker.ts:178; the app also has OSM extracts (lib/osm/extract.ts) and regions baked at ingest (scripts/ingest.mjs). JSON, small (KBs). Pure CPU data (labels, SVG/canvas), no GPU path.
- Sky model: onnxruntime-web U2-Net (sky/model.ts:17, ONNX file fetched in sky.worker.ts:108); lakes levels (geocam/lakes), terroir packs (scripts/terroir): JSON/packs, CPU.

### 1.9 Where the same data is decoded twice or held CPU+GPU
1. DEM heights, CPU+GPU: TileMesh.heights Float32 (terrain-data.ts:56) feeds heightAt/sampleGrid/raycast (terrain-data.ts:97-117) AND is written to the r32float array (batched-terrain.ts:413). Same ~1 MiB per 512 tile twice (+ position/normal arrays on the non-batched path).
2. DEM tile bytes decoded 5+ times per photo load, each with its own fetch path: (a) page decode pool (dem/load.ts:17-23, loadDemTile), (b) horizon-fast-app: main fetchDemBytes (integration/horizon-fast-app.ts:192) then worker blobHeights + validateTile (horizon-fast-app.worker.ts:61), (c) unknown-pose worker fetchDemTileCached (unknown-pose.worker.ts:153; read-only cache, re-downloads via HTTP cache), (d) eye worker raw fetch + blobHeights (gpu/eye/index.ts:74, bypasses cachedFetch), (e) near-dem loadDemTile (nearfield/near-dem.ts:76), roll-terrain (roll/map/roll-terrain.ts:109), ridgelines worker (roll/mosaic/ridgelines.worker.ts:82), viewpointTerrain (fetchDemBytes). Each holds its own Float32 copy; horizon-fast mosaics are SharedArrayBuffer Float32 (horizon-fast/mosaic.ts:105-109).
3. DEM CPU+GPU third copy: gpu/horizon/index.ts:109 uploadMosaics writes mosaic heights + mips again into storage pages (separate from the terrain r32float array); relief-heights.ts reads the render copy (residentHeights, engine.ts:909-910) = the one good reuse.
4. Imagery: ImageBitmap map + GPU layer + (transient) 2D canvas mosaic + resize bitmap (see 1.2).
5. Splats: cloud arrays + data texture + sorter copy (1.5).
6. 3D Tiles: three geometry + luma buffers (1.4).

## 2. Hands-on loaders.gl check (scratchpad/proto-loaders, node 22)

Installed @loaders.gl/{core,geotiff,splats,images,terrain}@5.0.0-alpha.7 (geotiff.js 2.1.3 underneath). Note: package.json of the app already lists core/images/loader-utils/schema 5.0.0-alpha.7 but nothing in src imports them.

- #4088 numeric raster loader: NOT published. alpha.7 was cut 2026-09-25; #4088 (commit 5206285b5) merged 2026-09-30; npm dist-tags beta = alpha.7. Source read from up/loaders.gl/modules/geotiff/src/geotiff-raster-loader.ts: `GeoTIFFRasterLoader` is `parse(ArrayBuffer)` over geotiff.js fromArrayBuffer: it reads the WHOLE file (no window/range, no overview selection other than `imageIndices`), returns `{images:[{index,width,height,bands:[{index,data:TypedArray (native dtype),metadata}],geoKeys,metadata,noData,fileDirectory,crs:'EPSG:2056'}]}`, no resampling. Good for 1 km 2 m tiles (1.23 MB, 96 ms decode) but not for streaming windows of large COGs. I did not build it (needs the monorepo install); emulated it with geotiff.js: Float32Array(250000), noData -9999.
- What alpha.7 does ship and works: `GeoTIFFSourceLoader` (RasterSource). Test on swissalti3d_2025_2625-1173_2_2056_5728.tif: `createDataSource(url,[GeoTIFFSourceLoader])`; getMetadata() -> {crs:'EPSG:2056', boundingBox:[[2625000,1173000],[2626000,1174000]], width/height 500, bandCount 1, dtype 'float32', tileSize 128x128, overviews:[{500,res 2},{250,res 4}], noData -9999, geoKeys}. getRaster({viewport:{id,zoom,center,bounds:[[x0,y0],[x1,y1]],crs,width:128,height:128}, resampleMethod:'nearest'}) -> `{data: Float32Array(16384), width 128, height 128, dtype 'float32', noData -9999, boundingBox, crs}`; 2 range requests, 524 KB total (first request 64 KB header). Heights 1257-1621 m = real. Range requests and CORS-style 206 reads work against data.geo.admin.ch.
- Raw geotiff.js (fromUrl, allowFullFile false): 128x128 window = 2 range requests (0-64 KB header, then tile ranges ~197 KB each); `readRasters({window,width,height})` resamples (a 500->64 px read fetched the 250 px overview-sized ranges, 5 requests, 1.1 MB all told). Overview IFD has NewSubfileType 1 and no georeferencing tags (getResolution throws): geo metadata is only on image 0.
- Caveats: it reads Range via `fetch` (loaders.gl RangeRequestScheduler wraps), so cachedFetch is not in the loop unless a custom fetch is injected (core `fetch` option) - doable. Needs bounds in source CRS (LV95): our wgs84ToLv95 stays ours; no reprojection (loader refuses CRS mismatch).
- Our swiss-cog.ts duplicates this (LZW, predictor, readWindow) so it could be retired in favour of the source loader plus the STAC step; check LZW/predictor 1 perf in browsers first (geotiff.js uses worker pools).
- Splats: `@loaders.gl/splats@5.0.0-alpha.7` IS published (alpha.6 version string in the clone). Exports SPLATLoader (antimatter15 .splat 32 B/gaussian), SPZLoader, KSPLATLoader, RADLoader, parseSPZ/parseSPZToGaussianSplats. Tested SPLATLoader on a synthetic 3-splat buffer: output = Arrow table {shape:'arrow-table', schema fields POSITION (FixedSizeList f32 x3), f_dc_0..2, opacity, scale_0..2, rot_0..3 (all float32, rotations wxyz, SH DC colors, opacity linear), data.batches}. The raw typed-array form `GaussianSplats` (positions/scales/rotations f32, colors u8 RGB, opacities f32, optional SH, loaderData) is available through parseSPZToGaussianSplats and lib/parse-*.
- vs our .splat-v1 (nearfield/splat-io.ts): ours has RGBA u8 (opacity in alpha), a per-splat provenance u8 (Truth/generated tint, export gating), optional u16 source, ENU origin f64 and a frame flag, none of which exist in loaders.gl's schema, and no `.splat-v1`/`.ply` parser is registered (SPLATLoader would misread RIGISPL1 as 32 B records; the demo file is named .splat but is v1). Options: write a `SplatV1Loader` (small, plugin form with Arrow columns incl. provenance/source as extra columns and origin in loaderData), keep it in our repo; use SPZ/KSPLAT/SPLAT from loaders.gl for imports. Ours is 45 B/splat vs SPZ ~16 B/splat (SPZ loader gives ~3x smaller uploads/downloads if the service emitted it).
- Also in alpha.7: @loaders.gl/terrain TerrainLoader (terrarium/mapbox decode to mesh on CPU; not useful for GPU decode), @loaders.gl/images (ImageBitmap/ImageLoader with `image.type:'imagebitmap'`).

## 3. Adapter design: loader result -> luma resource

### 3.1 Interface (one module, e.g. src/lib/gpu/ingest/, sitting beside gpu/core)

```ts
// raster: typed-array raster -> Texture
uploadRaster(device, r: {data: TypedArray; width; height; bands?: number; dtype; noData?: number|null; origin/bbox/crs},
             opts: {format?: 'r32float'|'r16float'|'r8unorm'|'rgba8unorm'; layer?: {array: TextureArrayAtlas, z}}): TextureRef
// mesh/attributes -> Buffers
uploadAttributes(device, attrs: Record<string, {value: TypedArray; size: number; normalized?}>, indices?): {buffers: Record<string,Buffer>; indexBuffer?}
// bitmap -> Texture
uploadBitmap(device, bmp: ImageBitmap, {format:'rgba8unorm'|'rgba8unorm-srgb', mips?, layer?}): TextureRef   // copyExternalImage
```
Each returns a `Resource` (id, texture|buffer, byteLength, label, version) so the graph can import it: for compute use the existing `ComputeGraph.importTexture(descriptor, texture)` / `importBuffer(id, byteLength, buffer)` (gpu/core/graph.ts:192-221). Notes: graph kernels reject texture bindings (graph.ts: "texture binding (not supported in a graph)") - so heights are either bound as storage buffer (pool.pooledStorage, gpu/core/pool.ts:76-96, as horizon does) or sampled only by render passes; an adapter must pick per consumer (the relief gather uses resident arrays through its own kernel, relief-heights.ts:137).
- Ownership: loader output is `Transferable`; the adapter always takes ownership of the ArrayBuffer (transferred from the worker), `Buffer.write`/`writeData` copies to the GPU, then the CPU array is dropped or kept only if a CPU consumer registered interest (refcount: `keepCpu`).
- Pooling: reuse `acquire(device,key,bytes,usage)` for buffers (grow-only power-of-two) and a generalised `HeightPool`/`ImageryArray` as `TextureArrayAtlas` (below) for textures; both already survive device loss through core/lifecycle onLost.
- Colour/convention rules to keep: row 0 = north (dem/grid.ts), copyExternalImage ignores flipY (gpu/look/textures.ts:11), srgb formats for imagery (imagery.ts), `colorSpaceConversion: 'none', premultiplyAlpha: 'none'` for terrain-RGB (dem/image.ts:25-28).

### 3.2 Plugging into the graph as imports
A loader-backed node = `ResourceNode {key, load(signal): Promise<LoaderResult>, upload}`; `ensure(keys)` returns handles; the compute graph treats its output as `importTexture/importBuffer` with a version stamp; cachedGraph(P, X) (graph.ts:608-675) re-binds by id per run, so streaming only needs the texture/buffer identity to stay stable (atlas grows by re-creation; note HeightPool.reserve loses contents, imagery grow uses copyTextureToTexture: use the latter). The render side consumes the same atlas (batched-terrain.ts residentHeights()).

### 3.3 Worker transfer
Workers return `{out: Float32Array, transfer:[buffer]}` already (dem/decode.worker.ts:8-10 through worker-pool.ts). Next step is to have workers do the *decode only* and return raw typed arrays (heights, or even the undecoded RGBA8 so the GPU decodes) while the main realm owns the device: the page sidecar is one device per realm (gpu/core/device.ts header: 3-4 devices per photo), so cross-realm GPU sharing is not possible; hence "decode in worker, transfer, upload on main" for the page, and "worker has its own device" only for compute workers that already have one (horizon-fast-app, unknown-pose). A WorkerPool-style `LoaderWorker` should wrap loaders.gl `parse` with `worker: false` (we own the pool) and `options.fetch = cachedFetch`-based fetch. SharedArrayBuffer (already used by horizon-fast mosaics) can let page + horizon worker share one decode.

### 3.4 GPU-side terrain-RGB decode (compute node)
- Today: bitmap -> 2D canvas -> getImageData (CPU readback of GPU/colour-managed pixels) -> JS loop (decodeTerrarium) -> r32float via writeData. Proposed: `createImageBitmap(blob, {colorSpaceConversion:'none', premultiplyAlpha:'none'})` -> `copyExternalImage` into a rgba8unorm 2d-array layer (no sRGB view; need exact bytes) -> compute (or render) node `terrarium_decode` writes `h = R*256 + G + B/256 - 32768` (f32 exact: R*256+G integer, B/256 exact) with the sea clamp `h<0 && h>-12000 ? 0 : h` into the r32float layer (storage texture write needs `r32float` storage support - available core in WebGPU; else write to a storage buffer and copyBufferToTexture). Result is bit-identical to decodeTerrarium (all values are exact in f32, same ops), testable with the existing `.check.ts` pattern.
- Risk: copyExternalImage may colour-convert / premultiply: use `colorSpace:'srgb'`, `premultipliedAlpha:false` on a bitmap decoded with 'none'; alpha is 255 so safe. The 256 m R-channel corruption (dem/decode.ts:79 comment) was a *canvas/worker decode* failure; a GPU path bypasses the canvas, so it may vanish, but validate before dropping validateTile.
- validateTile (CPU BFS connected components) has no GPU equivalent today: GPU path would need NO_DATA fill (stencil-like neighbour median: easy, single pass) and a component-label pass (iterative min-label propagation, or skip repair and test on the 100-photo wild set). Until proven, CPU keeps validateTile, so GPU decode is an option for tiles with `jumps == 0` (check requires a reduction pass + 4-byte readback).

### 3.5 Streaming / tiling with a texture-array atlas
- Generalise the two existing atlases (HeightPool in batched-terrain.ts:241-292, ImageryArray in imagery.ts) into one `TextureArrayAtlas {format, size, layers, free list, grow by copyTextureToTexture, tile id -> layer, version}` with `request(tileKey, priority)`, LRU eviction past maxTextureArrayLayers, per-layer mips optional. Mapterhorn: 512 px r32float (1 MiB/layer, 256 layers = 256 MiB: the cap forces the existing SMALL(256)/BIG(512) split and 150 spare meshes) - alternative `r16float` is lossy (not acceptable for sub-metre heights; an `r32float` height with half the layers, or rg16/`rgba8` terrarium kept raw and decoded on sample: 512x512x4 = 1 MiB too, so no memory saving, but no CPU decode at all).
- The ancestor fallback (ancestorCrop, dem/grid.ts:30-58) becomes a layer sampled with a (offset, scale) uv in the tile table row (like TileRow fields) instead of a CPU bilinear resample: eliminates the upsampled Float32 copies.
- Tile table already carries layer + size (batched-terrain.ts header comment): extend with source layer + uv window.
- For COGs (swiss 0.5/2 m nDSM): window request -> Float32Array -> same atlas with a different `TextureArrayAtlas` instance (r32float 128-512 px layers), LV95 bounds in a per-layer table.

### 3.6 CPU consumers that block a GPU-only DEM (they need the Float32 array)
1. TerrainSet.heightAt / localMax / raycast / lineOfSight (deck/terrain-data.ts:97-205): labels, draping, picking, trail, peaks snapping, engine.ts:1215/1238/1337 (photo base elevation, lake floor).
2. Horizon: horizon-fast mosaic + march CPU twins (horizon-fast/mosaic.ts, march.ts, visibility.ts) and their workers (horizon-fast-app.worker.ts, unknown-pose.worker.ts, ridgelines.worker.ts): all run in workers w/o the page device, plus CPU twins required for every GPU kernel ("Every caller keeps its CPU twin", gpu/core/device.ts header). They also need validateTile output.
3. Geometry builders: buildMesh/buildBatchGrid read heights on CPU (terrain-data.ts:buildMesh, batched-terrain-grid.ts:63-153, bounding spheres for CPU culling, batched-terrain.ts instance culling).
4. gpu/look relief heights (look/relief/heights.ts) has a CPU twin; the GPU twin already reads resident textures (good template).
5. concord priors/ground.ts, nearfield/near-dem.ts (anchoring), nearfield/roll/eyes.ts and roll-spot, roll/map/roll-terrain.ts + drape code, geocam lakes, roll/mosaic/ridgelines.ts, terroir roll-map-extras/viz profile, geo/terrain.ts TerrainSampler (+ ontology/atlas pages). All call heightAt/sampleAt on CPU.
6. Scripts/Node pipelines (scripts/lib/pipeline-node.ts, benchmarks) run without WebGPU: they need the Float32 path and the identical bits.
Path to GPU-only: (a) make Float32 a lazy, read-through *view* (`getCpuHeights(tile)` readback via core/readback.ts, cached) so only workers/CPU twins that need it pay; (b) move heightAt callers to batched GPU gathers (like geo-query-gpu.ts, deck-webgpu `sampleAtAsync`); (c) keep the horizon CPU twin until the GPU horizon kernel is the sole path; realistic target: GPU holds the single decode, CPU arrays materialised only on demand.

## 4. Recommendations (order)
1. Add `@loaders.gl/geotiff` GeoTIFFSourceLoader behind the swiss-cog.ts API (stacTiles stays), through a custom fetch = cachedFetch with Range support (persistent cache for COG header ranges); keep our reader as fallback until LZW perf is compared. Don't wait for #4088 (whole-file only).
2. Write a `SplatV1Loader` (+ PLY) following the loaders.gl Loader contract so `parse(buf, SplatV1Loader)` is uniform; import SPZ/KSPLAT via the published loaders.
3. Decode-once DEM: a single shared (page) `DemStore` that owns bytes -> Float32 (SharedArrayBuffer) and feeds terrain, horizon, eye, near-dem, roll through one cachedFetch path; then add the GPU terrarium decode as a node and compare bits with decodeTerrarium on the wild set.
4. Unify atlases (`TextureArrayAtlas`) and add the resource-ref import into ComputeGraph.
