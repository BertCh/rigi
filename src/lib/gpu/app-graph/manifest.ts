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
 * module's own switch, e.g. ?lookgpu=off, keep the CPU twin), "opt-in", "not wired" (built, no app
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
		contents: "ORT U²-Net + sky refine",
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
		contents: "range maps, drape atlas, cull, gains, panorama (WebGL2 only)",
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
		paths: ["src/lib/gpu/ingest/terrarium-tile.ts"],
		groups: ["ingest-terrarium-tile"],
		graphIdPrefixes: ["ingest-terrarium-layer|"],
		realms: ["page"],
		cadence: "per tile",
		resources: [
			"tile rgba8unorm texture (import; staging per source size for the layer writer)",
			"heights f32 + stats u32×8 (transients)",
			"height atlas r32float 2d-array (import, per-run layer)",
		],
		readbacks: ["stats: 32 B per tile (read node)"],
		status: "not wired",
		notes:
			"WAG W2.3: Terrarium tile decode (+2× box downsample) → validateTile out-of-range count, lo/hi, stride-7 lo/hi (terrariumTileStatsGpu), and TerrariumLayerWriter into a height-atlas layer. CPU twin: decodeTerrarium + validateTile + downsampleHeights2",
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
		notes: "each worker owns its own compute device (worker realm)",
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
		status: "opt-in",
		notes:
			"certified-f32 tan → degrees and ENU / resample (D7, D8); ?horizonPrecision=certified-f32; ties recomputed by the f64 path",
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
		status: "opt-in",
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
		status: "opt-in",
		notes:
			"certified-f32 coordinate descent (WAG W3.3): R rounds per submit, DECIDE → EVAL (indirect) → EVAL2 double-f32 (indirect); ?alignPrecision=certified-f32",
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
		notes: "certified f32 fold; flagged rows fold on the CPU in f64",
	},
	{
		id: "skyglobal",
		island: "I5",
		paths: ["src/lib/gpu/skyglobal/graph.ts", "src/lib/gpu/skyglobal/index.ts"],
		groups: ["skyglobal"],
		realms: ["bench"],
		cadence: "bench",
		resources: [
			"score maps, profile (pooled imports)",
			"cells, red (transients)",
		],
		readbacks: ["candidate list: count + head slots, rare second exact read"],
		status: "bench only",
		notes: "T6 skyline global search; not wired into the service",
	},
	{
		id: "sky-model",
		island: "I6",
		paths: ["src/lib/sky/sky.worker.ts"],
		groups: [],
		realms: ["worker:sky"],
		cadence: "per photo",
		resources: ["ORT WebGPU session (ORT's device, attached to luma)"],
		readbacks: [],
		status: "external",
		notes:
			"ORT owns the dispatch; its output buffer feeds sky-refine without leaving the GPU",
	},
	{
		id: "sky-refine",
		island: "I6",
		paths: ["src/lib/gpu/sky/refine-graph.ts", "src/lib/gpu/sky/refine.ts"],
		groups: ["sky-refine"],
		realms: ["worker:sky"],
		cadence: "per photo",
		resources: [
			"ORT P(sky) buffer (wrapped per run)",
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
		readbacks: [],
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
		status: "opt-in",
		notes:
			"WAG W1.5: batched-terrain frustum cull → stable compaction → drawIndexedIndirect (Model.setIndirectBuffer), recorded in the pass prepass on the frame encoder; flag terrainGpuCull (default off: no CPU saving measured; ?terrainGpuCull=on, WebGPU only; off / ?gpu=off / WebGL: the CPU twin visibleRows)",
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
			"per-call uniforms, inputs, outputs (imports, created per call)",
		],
		readbacks: [
			"read: verdicts 4 B per peak + skyline 4 B per column (one graph run)",
			"read: gather 20 B per pixel (nonce + 4 raw words), only for undecided samples",
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
			"array-input masks path (WebGL deck + sidecar); ?lookgpu=off keeps the CPU twin",
	},
	{
		id: "look-stats",
		island: "I9",
		paths: ["src/lib/gpu/look/color-stats-graph.ts"],
		groups: ["look-stats"],
		realms: ["page"],
		cadence: "per settle",
		resources: ["photo, layer, range, fg, LUT (imports)"],
		readbacks: ["partial: band stats partial sums (f64 fold on the CPU)"],
		status: "default",
	},
	{
		id: "look-haze",
		island: "I9",
		paths: ["src/lib/gpu/look/haze-graph.ts"],
		groups: [
			"look-haze-prep",
			"look-haze-compact",
			"look-haze-gather",
			"look-haze-grid",
		],
		realms: ["page"],
		cadence: "per settle",
		resources: [
			"range, pSky, photo, fg mask (pooled imports)",
			"lin, flags, bins, hist (transients)",
		],
		readbacks: [
			"prep head: counts + selection state",
			"compact head: counts",
			"gather sky: 3·K·4 B",
			"grid err: cells·4 B",
		],
		status: "default",
		notes:
			"graph breaks for the f64 airlight band / tail on the CPU (D16, D18)",
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
		groups: [],
		graphIdPrefixes: ["look-tex-"],
		realms: ["page"],
		cadence: "per settle",
		resources: [
			"renderer targets (geometry, photo, sky / fg masks, layer) as textures",
		],
		readbacks: ["band stats partials; haze head"],
		status: "default",
		notes:
			"texture-input look passes; its own per-key graph cache (not core cachedGraph). settleFusion (W1.2): masks submitted with the I8 query render, band stats with their layer render (core submitWithDefault)",
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
			"params, depth, mm, keys, rank, tmp, hist, base (imports, owned by each GpuSplatSorter)",
		],
		readbacks: [],
		status: "default",
		notes:
			'deck-webgpu splats sortBackend "gpu"; clear + 10 kernel nodes in one compute pass, encoded and submitted synchronously on the sorter\'s encoder (no lease); keyed by buffer sizes',
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
		paths: ["src/lib/roll"],
		groups: [],
		realms: ["page"],
		cadence: "per frame",
		resources: ["deck WebGL2 + raw GL2 programs"],
		readbacks: ["range maps"],
		status: "cpu",
		notes: "WebGL2 only; needs a WebGPU port before it can join a graph",
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
