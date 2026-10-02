// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The app graph manifest (WAG W0.3): which GPU module belongs to which graph island (I0–I12 of
// research_notes/whole-app-graph-2026-10-01/dataflow-map.md §5), the core cachedGraph groups it
// compiles, the resources it imports, its cadence, the realm it runs in and what it reads back.
//
// - ISLANDS and GPU_MODULES are the static declarations (one typed table; a module is described
//   here, not in its own file, so registering it never touches that module).
// - registerIsland(module) adds a module at run time (anything dynamic, e.g. an experiment that
//   compiles its own group); listModules() returns both.
// - The fast-tier check app-graph.check.ts keeps GPU_MODULES ∪ TEST_GRAPH_GROUPS equal to the
//   cachedGraph groups used in src/lib/gpu/** and src/lib/deck-webgpu/**, in both directions.
// - scripts/gpu/app-graph-table.ts prints the island table as Markdown
//   (research_notes/whole-app-graph-2026-10-01/islands.generated.md).
// - /dev/graph joins this table with the live graphs of the page (core/inspect.ts); modules whose
//   realms are all workers are shown as "remote".
//
// Pure data, no imports: safe for any chunk and for node scripts.

export const ISLAND_IDS = [
	"I0",
	"I1",
	"I2",
	"I3",
	"I4",
	"I5",
	"I6",
	"I7",
	"I8",
	"I9",
	"I10",
	"I11",
	"I12",
] as const;
export type IslandId = (typeof ISLAND_IDS)[number];

/** How often a module's work runs. */
export type Cadence =
	| "per photo"
	| "per tile"
	| "per eye"
	| "per align"
	| "per settle"
	| "per style"
	| "per frame"
	| "per view"
	| "per emit"
	| "bench";

/** Where the work runs: the page, a named worker realm (its own device), or bench / test pages only. */
export type Realm =
	| "page"
	| "worker:horizon-fast"
	| "worker:unknown-pose"
	| "worker:pipeline"
	| "worker:eye"
	| "worker:sky"
	| "worker:ridgelines"
	| "worker:decode"
	| "bench";

/**
 * Whether the GPU path is what the app runs today: "default" (on where WebGPU exists; ?gpu=off and the
 * module's own switch, e.g. ?gpu=off, keep the CPU twin), "opt-in", "not wired" (built, no app
 * caller), "bench only", "cpu" (no GPU path), "external" (another runtime owns the dispatch).
 */
export type ModuleStatus =
	| "default"
	| "opt-in"
	| "not wired"
	| "bench only"
	| "cpu"
	| "external";

export type Island = {
	id: IslandId;
	name: string;
	contents: string;
	cadence: Cadence[];
	/** the realms today (dataflow-map.md §5 "Realm today") */
	realms: Realm[];
	/** a graph island (false: I0 loaders, I10 labels: not a graph by nature) */
	graph: boolean;
};

export type GpuModule = {
	/** stable id (the module's lease / owner name where it has one) */
	id: string;
	island: IslandId;
	/** source files, repo-relative */
	paths: string[];
	/** core cachedGraph groups it compiles (src/lib/gpu/core/graph.ts cachedGraph(device, group, …)) */
	groups: string[];
	/** ids of ComputeGraphs it builds outside cachedGraph (prefix match), for /dev/graph */
	graphIdPrefixes?: string[];
	realms: Realm[];
	cadence: Cadence;
	/** what it imports / keeps resident (graph imports, pooled slots, textures) */
	resources: string[];
	/** what comes back to the CPU (empty: nothing) */
	readbacks: string[];
	status: ModuleStatus;
	notes?: string;
};

export const ISLANDS: readonly Island[] = [
	{
		id: "I0",
		name: "Loaders",
		contents:
			"upload decode / EXIF, region fetch, DEM fetch + WebP decode, imagery, 3D tiles / DRACO, nearfield service, matcher",
		cadence: ["per photo", "per tile"],
		realms: ["page", "worker:decode"],
		graph: false,
	},
	{
		id: "I1",
		name: "Terrain residency",
		contents:
			"TextureArrayAtlas r32f height arrays + imagery array + mips + batch grid table; terrarium decode",
		cadence: ["per tile"],
		realms: ["page"],
		graph: true,
	},
	{
		id: "I2",
		name: "Photo prep",
		contents:
			"photo → luma / edge / radix select / blur / sky fit (photoprep), mask inputs, sky-model input planes",
		cadence: ["per photo"],
		realms: ["page", "worker:sky"],
		graph: true,
	},
	{
		id: "I3",
		name: "Horizon",
		contents: "mosaic build + horizon march + atan / ENU resample → dirs",
		cadence: ["per eye"],
		realms: ["worker:horizon-fast", "worker:unknown-pose", "worker:eye"],
		graph: true,
	},
	{
		id: "I4",
		name: "Align",
		contents:
			"prior sky fit → POSE_GRID → hypotheses → POSE_BOUND rounds → silhouette renders + mask score",
		cadence: ["per align"],
		realms: ["page"],
		graph: true,
	},
	{
		id: "I5",
		name: "Unknown-pose solve",
		contents: "skyline detect → horizon → solve coarse → LM → refine",
		cadence: ["per photo"],
		realms: ["worker:unknown-pose", "worker:pipeline"],
		graph: true,
	},
	{
		id: "I6",
		name: "Sky model",
		contents: "U²-Net-P on the nn runtime + sky refine",
		cadence: ["per photo"],
		realms: ["worker:sky"],
		graph: true,
	},
	{
		id: "I7",
		name: "Frame",
		contents: "geometry → colour → composite (one encoder, one submit)",
		cadence: ["per frame"],
		realms: ["page"],
		graph: true,
	},
	{
		id: "I8",
		name: "Queries",
		contents:
			"query geometry render + geo-query verdict / skyline / gather + silhouette",
		cadence: ["per settle"],
		realms: ["page"],
		graph: true,
	},
	{
		id: "I9",
		name: "Look",
		contents: "masks, band stats, haze prep / compact / gather / grid, relief",
		cadence: ["per settle", "per style"],
		realms: ["page"],
		graph: true,
	},
	{
		id: "I10",
		name: "Labels",
		contents: "plan / resolve occlusion, snap, place, layout, SVG",
		cadence: ["per emit"],
		realms: ["page"],
		graph: false,
	},
	{
		id: "I11",
		name: "Nearfield",
		contents: "splat pack + GPU sort + draw; scene build on the CPU",
		cadence: ["per view"],
		realms: ["page"],
		graph: true,
	},
	{
		id: "I12",
		name: "Roll",
		contents:
			"range maps, drape atlas, cull, gains, panorama (WebGPU backend by default via renderer auto; WebGL2 fallback)",
		cadence: ["per photo", "per frame"],
		realms: ["page", "worker:ridgelines"],
		graph: true,
	},
];

/**
 * The GPU modules of the app. Groups here must match the cachedGraph(…, "<group>", …) calls exactly
 * (app-graph.check.ts). Readback sizes are the read-node ranges of the graph builders.
 */
export const GPU_MODULES: readonly GpuModule[] = [
	{
		id: "ingest-terrarium",
		island: "I1",
		paths: ["src/lib/gpu/ingest/terrarium.ts", "src/lib/gpu/ingest/upload.ts"],
		groups: ["ingest-terrarium"],
		realms: ["page"],
		cadence: "per tile",
		resources: ["tile rgba8unorm texture (import)", "heights f32 (transient)"],
		readbacks: ["heights: w·h·4 B (read node)"],
		status: "not wired",
		notes:
			"GPU Terrarium decode (W2.3); CPU twin dem/decode.ts decodeTerrarium",
	},
	{
		id: "ingest-terrarium-tile",
		island: "I1",
		paths: [
			"src/lib/gpu/ingest/terrarium-tile.ts",
			"src/lib/deck-webgpu/terrain-gpu-decode.ts",
			"src/lib/deck-webgpu/texture-array-atlas.ts",
			"src/lib/deck-webgpu/layers/batched-terrain.ts",
		],
		groups: ["ingest-terrarium-tile"],
		graphIdPrefixes: ["ingest-terrarium-layer|"],
		realms: ["page"],
		cadence: "per tile",
		resources: [
			"tile rgba8unorm texture (import; staging per source size for the layer writer)",
			"heights f32 + stats u32×8 (transients)",
			"terrain height atlas r32float 2d-array (import, per-run layer)",
		],
		readbacks: ["stats: 32 B per streamed tile (read node, load time)"],
		status: "default",
		notes:
			"WAG W2.3 wiring + W2.4: the GPU terrain decode (default on; WebGPU batched terrain, ?gpu=on). Load time: decode (+2× box downsample) straight into a height-atlas layer the tile leases (TextureArrayAtlas.writeTerrariumLeased, graph ingest-terrarium-layer|…|stats: one upload of the bitmap, layer + validateTile out-of-range count, lo/hi, stride-7 lo/hi); TileStore draws the leased layer with no further upload, also after a pan (spare meshes keep up to 48 leases, deck/terrain-stream.ts spareGpuLayers); without an atlas: the stats graph alone and a decode at draw time; CPU heights only on demand (dem/cpu-heights.ts getCpuHeights). CPU twin: decodeTerrarium + validateTile + downsampleHeights2",
	},
	{
		id: "atlas-resize",
		island: "I1",
		paths: [
			"src/lib/deck-webgpu/texture-array-atlas.ts",
			"src/lib/deck-webgpu/atlas-layout.ts",
			"src/lib/deck-webgpu/imagery.ts",
		],
		groups: [],
		graphIdPrefixes: ["atlas-resize|"],
		realms: ["page"],
		cadence: "per tile",
		resources: [
			"old + new atlas 2d-array textures (imports; one copy node, every mip, runs of layers)",
		],
		readbacks: [],
		status: "default",
		notes:
			"WAG perf-vram: TextureArrayAtlas grow (keep every layer) and compaction (live layers down to 0 … n−1 in a smaller texture; ImageryArray on idle, plus dropping an array with no live layer). Exact copies; layout math node-checked in atlas-layout.check.ts. CPU twin: none (texture plumbing)",
	},
	{
		id: "height-gather",
		island: "I1",
		paths: [
			"src/lib/deck-webgpu/height-gather.ts",
			"src/lib/deck-webgpu/engine.ts",
		],
		groups: ["height-gather"],
		realms: ["page"],
		cadence: "per view",
		resources: [
			"terrain height atlas r32float 2d-arrays, small + big (imports, bound per run)",
			"per-call uniform, texel words, output (imports, created per call)",
		],
		readbacks: [
			"read: 8 B per texel (nonce + raw f32 bits), 4 texels per height sample of a lazy tile",
		],
		status: "default",
		notes:
			"WAG W2.4 second half, under the GPU terrain decode: the WebGPU photo view's CPU height readers (camera DEM height, trails, peak snapping) take lazy tiles' heights from the atlas instead of materialising them; plan + blend on the CPU in f64 (TerrainSet.locate, gridCorners / blendCorners = sampleGrid), the GPU only copies texels, so a result is heightAt's bit for bit; nonce + slot certificate, heightAt fallback. CPU twin: TerrainSet.heightAt / localMax",
	},
	{
		id: "look-relief-heights",
		island: "I1",
		paths: ["src/lib/gpu/look/relief-heights.ts"],
		groups: [],
		realms: ["page"],
		cadence: "per settle",
		resources: [
			"terrain tile heights texture array (import)",
			"Mercator nodes, tile rows (imports)",
		],
		readbacks: [],
		status: "default",
		notes:
			'rasterises the relief height field from the resident tiles; compiles into the "look-relief" group (listed under look-relief)',
	},
	{
		id: "photoprep",
		island: "I2",
		paths: ["src/lib/gpu/photoprep/index.ts"],
		groups: ["photoprep"],
		realms: ["page"],
		cadence: "per photo",
		resources: [
			"rgba, fg, lim, dims (pooled imports)",
			"edge / sky scratch (transients)",
		],
		readbacks: [
			"read: coarse + fine edge planes, sky, sky-cum, select, echo (≈3.5 MB at 512 grid)",
		],
		status: "default",
		notes: "planes read back and re-uploaded by align (R1, dataflow-map §3)",
	},
	{
		id: "horizon-march",
		island: "I3",
		paths: ["src/lib/gpu/horizon/graph.ts", "src/lib/gpu/horizon/index.ts"],
		groups: ["horizon-march"],
		realms: ["worker:horizon-fast", "worker:unknown-pose", "worker:eye"],
		cadence: "per eye",
		resources: ["mosaic pages pg0…pgN (imports)", "u, params (imports)"],
		readbacks: ["read: out nE·nAz·8 B + stats"],
		status: "default",
		notes:
			"each worker owns its own compute device (worker realm); worker:unknown-pose marches its 360° scene here on the GPU since 2026-10-01 (?gpu=off: the CPU sceneHorizon)",
	},
	{
		id: "mosaic-mips",
		island: "I3",
		paths: ["src/lib/gpu/horizon/mosaic-mips.ts"],
		groups: ["mosaic-mips"],
		realms: ["worker:horizon-fast", "worker:unknown-pose", "worker:eye"],
		cadence: "per photo",
		resources: [
			"mosaic pages (imports, written in place)",
			"per-level params uniform",
		],
		readbacks: [],
		status: "default",
		notes:
			"max-mip pyramid built on the GPU inside the horizon march's page (the GPU mip build, default on; byte-identical to the CPU pyramid, scripts/gpu/mosaic-mips-dawn.ts); the CPU pyramid stays for ?the GPU mip build=off, ?gpu=off and the CPU march",
	},
	{
		id: "horizon-cert",
		island: "I3",
		paths: [
			"src/lib/gpu/horizon/certified.ts",
			"src/lib/gpu/horizon/certified.wgsl.ts",
			"src/lib/gpu/horizon/certified-cpu.ts",
		],
		groups: ["horizon-cert"],
		realms: ["worker:horizon-fast"],
		cadence: "per eye",
		resources: [
			"u, consts, td (march [t, d]) or prof + az + cols (pooled imports)",
			"samp (transient, B → C)",
		],
		readbacks: [
			"A: outA n·8 B (elevation bits + flag)",
			"B→C: outC 8192·16 B (direction bits + flag)",
		],
		status: "default",
		notes:
			"certified-f32 tan → degrees and ENU / resample (D7, D8); certified-f32 precision; ties recomputed by the f64 path",
	},
	{
		id: "precision-probe",
		island: "I3",
		paths: [
			"src/lib/gpu/precision/ieee-probe.ts",
			"src/lib/gpu/precision/df32.ts",
		],
		groups: ["precision-probe"],
		realms: ["worker:horizon-fast", "page"],
		cadence: "per photo",
		resources: ["u, pin (pooled imports)", "pout (transient)"],
		readbacks: ["read: pout 4096·80 B, once per device"],
		status: "default",
		notes:
			"strict-IEEE probe gating every certified-f32 stage (horizon in the horizon-fast worker; align on the page)",
	},
	{
		id: "align-pose",
		island: "I4",
		paths: [
			"src/lib/gpu/align/graph.ts",
			"src/lib/gpu/align/pose-grid.ts",
			"src/lib/gpu/align/pose-bound.ts",
		],
		groups: ["align-pose"],
		realms: ["page"],
		cadence: "per align",
		resources: [
			"u, poses, dirs, edge planes (uploaded once per photo), sky planes (pooled imports)",
			"out (transient, cleared)",
		],
		readbacks: ["read: nPoses·stride B per round (≈40 rounds per autoAlign)"],
		status: "default",
	},
	{
		id: "align-cert",
		island: "I4",
		paths: [
			"src/lib/gpu/align/cert-gpu.ts",
			"src/lib/gpu/align/cert.wgsl.ts",
			"src/lib/gpu/align/cert-refine.ts",
			"src/lib/gpu/align/cert-emulate.ts",
		],
		groups: ["align-cert"],
		realms: ["page"],
		cadence: "per align",
		resources: [
			"u, lane state, move logs, audit rings, jobs, results, indirect commands (pooled imports)",
			"f32 + double-f32 lattice tables (uploaded per autoAlign and on a window re-centre)",
			"dirs, edge planes (shared align slots / resident photo prep), private skyCum",
		],
		readbacks: [
			"read per submit (≈4 per autoAlign): lane states + move logs + audit rings ≤ 8·6.3 KB",
		],
		status: "default",
		notes:
			"certified-f32 coordinate descent (WAG W3.3): R rounds per submit, DECIDE → EVAL (indirect) → EVAL2 double-f32 (indirect); certified-f32 precision",
	},
	{
		id: "silhouette-gpu",
		island: "I4",
		paths: [
			"src/lib/deck-webgpu/silhouette-gpu.ts",
			"src/lib/deck-webgpu/graph-texture.ts",
		],
		groups: ["silhouette-mask"],
		realms: ["page"],
		cadence: "per align",
		resources: [
			"geometry targets rgba32float, one per pose (render device; imports bound per run)",
			"per-pose uniforms, mask output (imports, owned by SilhouetteMaskGpu)",
		],
		readbacks: [
			"read: pass mask, 18 KB per 384 × 288 pose (one read node per re-rank)",
		],
		status: "default",
		notes:
			"one kernel node per pose, one submit per re-rank; keyed by pose count and target shape",
	},
	{
		id: "solve-coarse",
		island: "I5",
		paths: [
			"src/lib/gpu/solve/graph.ts",
			"src/lib/gpu/solve/index.ts",
			"src/lib/gpu/solve/fused.ts",
		],
		groups: ["solve-coarse"],
		realms: ["worker:unknown-pose", "worker:pipeline"],
		cadence: "per photo",
		resources: ["resident horizon profile hz (per device)", "u, grid imports"],
		readbacks: [
			"rows: 16 B per yaw row",
			"blocks (flagged rows only): nYaw·nBlk·16 B",
		],
		status: "default",
		notes:
			"certified f32 fold; flagged rows fold on the CPU in f64; fused with the unknown-pose GPU horizon (resident hz primed by the march) on the GPU path",
	},
	{
		id: "ransac",
		island: "I5",
		paths: ["src/lib/gpu/ransac/score.ts", "src/lib/pose6dof/ransac/async.ts"],
		groups: ["ransac"],
		realms: ["page"],
		cadence: "per align",
		resources: [
			"prm uniform, correspondences N × 32 B, hypotheses K × 64 B (pooled imports)",
			"score K × 8 B, best 16 B (transients)",
		],
		readbacks: ["best: 16 B per batch (winner index, count, cost)"],
		status: "default",
		notes:
			"pose6dof *RansacAsync: K hypotheses × N correspondences per dispatch, arg-max on the GPU; batches under 2^19 work items and missing devices score on the CPU twin (scoreBatchCpu)",
	},
	{
		id: "basin-grid",
		island: "I5",
		paths: ["src/lib/matcher/basin-gpu.ts"],
		groups: ["basin-grid"],
		realms: ["page"],
		cadence: "per photo",
		resources: [
			"skyline score map S, node horizon dirs, candidate rotations, uniforms (pooled imports)",
			"scores nodes × cands (transient)",
			"best nodes × 3 (transient)",
		],
		readbacks: ["winners: nodes × 3 × (score f32, index u32)"],
		status: "default",
		notes:
			"basin-gap grid coarse rotation search (rotSearchGpu): SCORE (one workgroup per candidate × node, workgroup atomicMin column table) → TOP3 (1° NMS, per node); throws on a GPU failure and the caller takes rotSearchCpu",
	},
	{
		id: "skyglobal",
		island: "I5",
		paths: ["src/lib/gpu/skyglobal/graph.ts", "src/lib/gpu/skyglobal/index.ts"],
		groups: ["skyglobal"],
		realms: ["page", "bench"],
		cadence: "per photo",
		resources: [
			"score maps, profile (pooled imports)",
			"cells, red (transients)",
			'rescore "gpu": candidate scores, per-yaw best key / arg (transients)',
		],
		readbacks: [
			"candidate list: count + head slots, rare second exact read",
			'rescore "gpu": count + per-yaw best key and arg, 4 + 8·nYaw B',
		],
		status: "opt-in",
		notes:
			"T6 skyline global search; the in-browser matcher's policy t6 (?matcherPolicy=t6, src/lib/matcher/t6.ts) runs it with the candidate re-score on the graph (RESCORE → PICK)",
	},
	{
		id: "skyline",
		island: "I5",
		paths: [
			"src/lib/gpu/skyline/index.ts",
			"src/lib/gpu/skyline/skyline.wgsl.ts",
		],
		groups: ["skyline"],
		realms: ["worker:unknown-pose", "worker:eye"],
		cadence: "per photo",
		resources: [
			"photo planes (rgba, pooled import)",
			"features, prior, sky-model cost images (transients)",
		],
		readbacks: ["cost images for the CPU Viterbi + sky-model refit"],
		status: "opt-in",
		notes:
			"detectSkylineAsync: GPU cost images, Viterbi and refit stay on the CPU (f64); flag skylineGpu (default on: 0 of 77 unknown-pose decisions changed in the 2026-10-02 node A/B)",
	},
	{
		id: "sky-model",
		island: "I6",
		paths: ["src/lib/sky/sky.worker.ts"],
		groups: [],
		realms: ["worker:sky"],
		cadence: "per photo",
		resources: [
			"U²-Net-P fp16 weights on the compute device (src/lib/sky/model.ts, u2netp.ts)",
		],
		readbacks: [],
		status: "default",
		notes:
			"Rigi's nn runtime (src/lib/nn: WGSL kernels on one core ComputeGraph per forward, getNn registry, cachedGraph groups nn/<consumer>) on the sky worker's compute device; the nn CPU reference backend without WebGPU. No ONNX Runtime. The probability buffer feeds sky-refine without leaving the GPU",
	},
	{
		id: "sky-prep",
		island: "I6",
		paths: [
			"src/lib/gpu/sky/prep.ts",
			"src/lib/gpu/sky/prep.wgsl.ts",
			"src/lib/sky/prep.ts",
		],
		groups: ["sky-prep"],
		realms: ["worker:sky"],
		cadence: "per photo",
		resources: [
			"ImageBitmap → rgba8unorm texture (per photo)",
			"tmp (transient)",
			"axis taps, constants, LUT (pooled imports)",
			"rgba, rgbLo, normalised model input (handed to the model and sky-refine)",
		],
		readbacks: [
			"opacity flag (4 B)",
			"first 3 photos per device: rgba + rgbLo + input (verification)",
		],
		status: "default",
		notes:
			"cachedGraph per shape (2 per device), after the bitmap → texture → padded-rows copy; the GPU prep (default on since 2026-10-01; off / ?gpu=off / CPU nn backend: the CPU prep)",
	},
	{
		id: "sky-refine",
		island: "I6",
		paths: ["src/lib/gpu/sky/refine-graph.ts", "src/lib/gpu/sky/refine.ts"],
		groups: ["sky-refine"],
		realms: ["worker:sky"],
		cadence: "per photo",
		resources: [
			"nn P(sky) buffer (wrapped per run)",
			"guide, rgba, axis taps, LUT (pooled imports)",
		],
		readbacks: ["read: byte mask (+ float mask when asked)"],
		status: "default",
	},
	{
		id: "deck-webgpu-frame",
		island: "I7",
		paths: ["src/lib/deck-webgpu/engine.ts", "src/lib/deck-webgpu/pass.ts"],
		groups: [],
		realms: ["page"],
		cadence: "per frame",
		resources: [
			"geometry / colour / photo targets",
			"TextureArrayAtlas height + imagery arrays",
		],
		readbacks: [
			"matcher only (renderPoseView, offline): xyzr rgba32f + colour rgba16f per pose view",
		],
		status: "default",
		notes: "deck.gl layers in one encoder; not a ComputeGraph",
	},
	{
		id: "terrain-gpu-cull",
		island: "I7",
		paths: [
			"src/lib/deck-webgpu/layers/terrain-cull.ts",
			"src/lib/deck-webgpu/layers/terrain-cull.wgsl.ts",
			"src/lib/deck-webgpu/layers/batched-terrain.ts",
		],
		groups: [],
		graphIdPrefixes: ["terrain-cull-"],
		realms: ["page"],
		cadence: "per frame",
		resources: [
			"tile spheres + rows (import, per tile set)",
			"per-pass uniform, instance rows and indexed indirect records (imports, encoder ring)",
			"vis flags (transient)",
		],
		readbacks: [],
		status: "default",
		notes:
			"WAG W1.5: batched-terrain frustum cull → stable compaction → drawIndexedIndirect (Model.setIndirectBuffer), recorded in the pass prepass on the frame encoder; the GPU terrain cull (default on, WebGPU only; ?the GPU terrain cull=off, off / ?gpu=off / WebGL: the CPU twin visibleRows)",
	},
	{
		id: "geo-query-gpu",
		island: "I8",
		paths: [
			"src/lib/deck-webgpu/geo-query-gpu.ts",
			"src/lib/deck-webgpu/graph-texture.ts",
		],
		groups: ["geo-query"],
		realms: ["page"],
		cadence: "per settle",
		resources: [
			"geometry target rgba32float (render device; import bound per run)",
			"uniforms, inputs, outputs: persistent core pool slots geo-query/<kernel><job>/* (imports bound with exact ranges; written + submitted in one sync block via runNow)",
		],
		readbacks: [
			"read: verdicts 4 B per peak + skyline 4 B per column (one graph run)",
			"read: gather 20 B per pixel (nonce + 4 raw words), only for undecided samples",
			"read: unpack range plane 4 B per pixel and / or xyz plane 12 B per pixel (+ 8 B tag), on demand (ensureRange / ensureFull), instead of the 16 B texel + CPU loop",
		],
		status: "default",
		notes:
			"verdicts + skyline share one graph run (one submit, was two); gather runs after it; keyed by kernels and target shape",
	},
	{
		id: "look-guided",
		island: "I9",
		paths: ["src/lib/gpu/look/guided-filter-graph.ts"],
		groups: ["look-guided"],
		realms: ["page"],
		cadence: "per settle",
		resources: [
			"guide I, inputs p0…pk, params (imports)",
			"t4, ab, t2, q (transients)",
		],
		readbacks: ["q: n·4 B per filtered mask"],
		status: "default",
		notes:
			"array-input masks path (WebGL deck + sidecar); ?gpu=off keeps the CPU twin",
	},
	{
		id: "look-stats",
		island: "I9",
		paths: [
			"src/lib/gpu/look/color-stats-graph.ts",
			"src/lib/gpu/look/color-stats-fold.ts",
		],
		groups: ["look-stats"],
		realms: ["page"],
		cadence: "per settle",
		resources: [
			"photo, layer, range, fg, LUT, params (imports)",
			"partial, folded (GPUProgram vectors), stats (transient)",
		],
		readbacks: [
			"stats: folded ColorStats 256 B (fold f64: the 6.6 KB partials, f64 fold on the CPU)",
		],
		status: "default",
		notes:
			"WAG-4: one ComputeGraph: BAND_STATS(_SG) → luma GPUGroupAggregation fold → BAND_FINALIZE (f32); subgroups by default where available",
	},
	{
		id: "look-haze",
		island: "I9",
		paths: [
			"src/lib/gpu/look/haze-graph.ts",
			"src/lib/gpu/look/haze-band.ts",
			"src/lib/gpu/look/haze-argmin.ts",
		],
		groups: [
			"look-haze-prep",
			"look-haze-compact",
			"look-haze-gather",
			"look-haze-grid",
			"look-haze-band",
			"look-haze-argmin",
		],
		realms: ["page"],
		cadence: "per settle",
		resources: [
			"range, pSky, photo, fg mask (pooled imports)",
			"lin, flags, bins, hist (transients)",
			"arg-min program: luma GPUProgram scalar arena (gMin, tol, count, over) + pick (transients)",
		],
		readbacks: [
			"prep head: counts + selection state",
			"compact head: counts",
			"gather sky: 3·K·4 B (CPU band only)",
			"grid: 16 B + 256 candidate pairs (2 KiB; arg-min program, default) or err cells·4 B (`argminGpu: false`)",
			"band head (default on the texture path; `bandGpu: false` = CPU band): lists + their range, band counts / K / idx / lin, 8 spot columns (no range / P(sky) planes)",
		],
		status: "default",
		notes:
			"graph break for the f64 tail on the CPU (D18; the round trip before the grid is inherent: its inputs come from f64 code). Default: the airlight band on the GPU on the texture path (look-haze-band, one submit instead of two; D16 removed; `bandGpu: false`, WebGL / ?gpu=off / spot-check fault = CPU band) and the grid arg-min as a luma GPUProgram with a GPU indirect-gated selection (look-haze-argmin; `argminGpu: false` or a per-call check fault = whole-grid read)",
	},
	{
		id: "look-relief",
		island: "I9",
		paths: [
			"src/lib/gpu/look/relief-graph.ts",
			"src/lib/gpu/look/relief-heights.ts",
		],
		groups: ["look-relief"],
		realms: ["page"],
		cadence: "per style",
		resources: [
			"height field H (import or relief-heights transient)",
			"params",
		],
		readbacks: [
			"field + gen (array path only); texture path writes textures, no readback",
		],
		status: "default",
	},
	{
		id: "look-textures",
		island: "I9",
		paths: ["src/lib/gpu/look/textures.ts"],
		groups: ["look-tex"],
		realms: ["page"],
		cadence: "per settle",
		resources: [
			"renderer targets (geometry, photo, sky / fg masks, layer) as textures",
		],
		readbacks: [
			"band stats: folded ColorStats 256 B (f64: partials); haze head",
		],
		status: "default",
		notes:
			"texture-input look passes; core cachedGraph group look-tex (6 per device; graphs own their constant buffers, ComputeGraph.own; compileAsync before run, a sync encode of an uncompiled graph starts compileAsync and falls back for that frame). settleFusion (W1.2): masks submitted with the I8 query render, band stats with their layer render (core submitWithDefault)",
	},
	{
		id: "photo-palette",
		island: "I12",
		paths: ["src/lib/gpu/palette/palette.ts"],
		groups: ["palette"],
		realms: ["page"],
		cadence: "per photo",
		resources: ["64 x 64 RGBA8 thumbnail words (pooled)"],
		readbacks: ["k centroids + counts (the palette)"],
		status: "default",
		notes:
			"photo look: unpack kernel (RGBA8 to OKLab rows) + luma GPUKMeans in one graph; CPU twin kMeansCpu",
	},
	{
		id: "roll-look",
		island: "I12",
		paths: ["src/lib/gpu/palette/look-search.ts"],
		groups: ["roll-look", "roll-look-similar"],
		realms: ["page"],
		cadence: "per view",
		resources: ["look embeddings, LOOK_DIMS floats per photo (pooled)"],
		readbacks: [
			"labels + centroids + per-group ranked ids; similar-look top-k",
		],
		status: "default",
		notes:
			"group-by-look: luma GPUKMeans + GPUSimilaritySearch (centroids as queries) in one graph; similarLooks is a cosine GPUSimilaritySearch",
	},
	{
		id: "labels",
		island: "I10",
		paths: ["src/lib/look/labels"],
		groups: [],
		realms: ["page"],
		cadence: "per emit",
		resources: [],
		readbacks: [],
		status: "cpu",
		notes: "CPU / DOM by nature; fed by I8's small readbacks",
	},
	{
		id: "splat-sort",
		island: "I11",
		paths: ["src/lib/gpu/splat-sort/index.ts"],
		groups: ["splat-sort"],
		realms: ["page"],
		cadence: "per view",
		resources: [
			"splat storage buffer, order buffer (render device; imports bound per encode)",
			"params, depth, mm, keys, rank, tmp (imports, owned by each GpuSplatSorter)",
		],
		readbacks: [],
		status: "default",
		notes:
			'deck-webgpu splats sortBackend "gpu"; clear + depth + keys kernel nodes + one luma GPUSort in one compute pass, encoded and submitted synchronously on the sorter\'s encoder (no lease); keyed by buffer sizes',
	},
	{
		id: "horizon-ridges",
		island: "I12",
		paths: ["src/lib/gpu/horizon/ridges.ts"],
		groups: ["horizon-ridges"],
		realms: ["worker:ridgelines"],
		cadence: "per photo",
		resources: ["mosaic pages (imports)", "u, params"],
		readbacks: ["read: ridge tops outBytes"],
		status: "default",
	},
	{
		id: "roll-webgl",
		island: "I12",
		paths: ["src/lib/roll", "src/lib/roll/map/backend-webgpu.ts"],
		groups: [],
		realms: ["page"],
		cadence: "per frame",
		resources: [
			"WebGPU backend: luma-direct host + deck-webgpu cores (backend-webgpu.ts); WebGL2 fallback: deck + raw GL2 programs",
		],
		readbacks: ["range maps"],
		status: "cpu",
		notes:
			"src/lib/roll/map/backend-webgpu.ts is the default via ?renderer=auto (backend-select.ts); it draws with deck-webgpu render cores, not yet as a ComputeGraph island (range maps and cull are still outside the graph), so the status stays cpu until they join one",
	},
];

/** cachedGraph groups used only by self-tests and benches (accepted by the check, not islands). */
export const TEST_GRAPH_GROUPS: readonly string[] = [
	"selftest-cache",
	"look-haze-lint",
];

const dynamicModules: GpuModule[] = [];

/**
 * Register a module at run time (an experiment, a lab page): replaces a registered module of the same
 * id. Static modules belong in GPU_MODULES. Returns an unregister function.
 */
export function registerIsland(module: GpuModule): () => void {
	const i = dynamicModules.findIndex((m) => m.id === module.id);
	if (i >= 0) dynamicModules.splice(i, 1);
	dynamicModules.push(module);
	return () => {
		const j = dynamicModules.indexOf(module);
		if (j >= 0) dynamicModules.splice(j, 1);
	};
}

/** Static modules, then registered ones (a registered id overrides a static one). */
export function listModules(): GpuModule[] {
	const ids = new Set(dynamicModules.map((m) => m.id));
	return [...GPU_MODULES.filter((m) => !ids.has(m.id)), ...dynamicModules];
}

/** The module of a graph id (`${group}|${key}` for cached graphs, or a registered prefix). */
export function moduleOfGraph(
	graphId: string,
	group?: string,
): GpuModule | undefined {
	const g = group ?? graphId.split("|")[0];
	const modules = listModules();
	return (
		modules.find((m) => m.groups.includes(g)) ??
		modules.find((m) => m.graphIdPrefixes?.some((p) => graphId.startsWith(p)))
	);
}

/** A module runs only in worker realms: the page cannot see its graphs ("remote" on /dev/graph). */
export const isRemote = (m: GpuModule) =>
	m.realms.length > 0 && m.realms.every((r) => r.startsWith("worker:"));
