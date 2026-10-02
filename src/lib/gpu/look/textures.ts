// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Texture-input look passes: the guided-filter masks, the band colour stats and the haze prep, fed
// straight from the renderer's GPU targets instead of CPU arrays read back from them.
//
// ── API note for the deck-webgpu renderer (mt-image-be) ──────────────────────────────────────────
// 1. Hand the render device to compute once: adoptRenderDevice(device) (#/lib/gpu/device; your
//    adoptForCompute already does it). Then `const d = await getComputeDevice()` returns YOUR
//    device while it lives. Only call these when `d && d === yourDevice` (textures cannot cross
//    devices); otherwise (null, ?gpu=off, WebGL, sidecar) keep the CPU / array path.
// 2. Inputs are luma Textures on that device, with Texture.SAMPLE usage, read with textureLoad
//    (no sampler, no filtering). Pass `{ texture, flipY: true }` when the texture's row 0 is the
//    image's BOTTOM row (GL readPixels order, or copyExternalImage, which ignores flipY); a plain
//    Texture means row 0 = top (a WebGPU render target):
//    - geometry: rgba32float with RGBA = ENU xyz, range (the three engine's geoRT), or r32float
//      range (deck). Range in metres, 0 = sky. f16 overflows at 65 km: float32 only.
//    - photo: rgba8unorm, or rgba8unorm-srgb (re-encoded to the stored bytes; exact for all 256
//      values; level 0 of a mip chain is read). Box-resampled to each
//      pass's grid; bit-exact vs the CPU when it already has the grid's size (the CPU resamples
//      with canvas drawImage, which the GPU cannot reproduce). For haze, any size is exact
//      against the array path given the same photo (the prep kernel box-filters on the GPU).
//    - sky / fg masks: r8unorm (or rgba8unorm, .r), P·255, as the segmentation's Uint8 masks.
//    - layer (stats): the band-stats layer target, LINEAR, PREMULTIPLIED RGBA float (rgba32float /
//      rgba16float); the stats kernel un-premultiplies and only counts texels with alpha > 0.98, so
//      sky (0,0,0,0) drops out.
//    - Formats of the deck-webgpu targets (deck-webgpu/targets.ts TARGET_FORMATS): geometry
//      rgba32float xyz ENU + w range (0 = sky), colour rgba16float linear premultiplied, photo
//      rgba8unorm-srgb, all row 0 = top: pass them as plain Textures (no flipY).
// 3. Outputs stay on the GPU unless asked (`read: true`):
//    - masksTex → `texture`: an rgba8unorm (r = coverage, g = cut, b = people, a = 255: exactly
//      CompositeLook.masks) or r8unorm (coverage) texture to sample directly, plus the f32 planes
//      (`q`) and the padded RGBA8 words (`packed`) as GPU buffers.
//    - bandStatsTex → the per-workgroup partial sums on the GPU; the 4-band ColorStats (a few
//      uniforms) is read back by default since the composite's uniforms are set from the CPU.
//    - hazePrepTex → range, P(sky), linear photo, bins, counts and percentile state on the GPU
//      (what haze.ts fitHazeGpu's CPU tail consumes; `read: true` returns them as arrays).
//    Buffers are pooled per pass: valid until that pass's next call. A mask texture created here
//    is kept per format and valid until a masks call with another grid size (then it is replaced);
//    sample it, never destroy it.
// 4. Input textures must stay alive and unchanged until the returned promise resolves: calls of
//    a pass are serialised, so a queued call can run frames later. A destroyed input (or a lost
//    device) rejects the call instead of submitting.
// 5. Every call is one GPU submit through a core ComputeGraph (textures → gather node → the
//    existing look WGSL → outputs). Graphs are compiled once per (sizes, formats, flags).
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// Parity (textures-bench.ts, scripts/gpu/textures-bench.mjs): the gathered inputs are bit-identical
// to the arrays capture.ts / composite.ts / haze.ts build on the CPU, so every downstream kernel
// output is bit-identical to the array path's.
import {
	Buffer,
	type CommandEncoder,
	type Device,
	Texture,
} from "@luma.gl/core";
import { type ColorStats, N_BANDS } from "#/lib/look/color-stats";
import { gridSize, MASK_LONG_SIDE } from "#/lib/look/composite";
import { srgbToLinear } from "#/lib/style/color";
import {
	type CachedGraph,
	ComputeGraph,
	cachedGraph,
	cachedGraphFrom,
	type GraphBinding,
	releaseCachedGraphs,
} from "../core/graph";
import {
	type BindKind,
	defineKernel,
	type KernelSpec,
	storage,
	uniform,
	warmKernels,
	warmKernelsAsync,
} from "../core/kernel";
import type { GraphBufferHandle, GraphTextureHandle } from "../core/luma";
import { acquire, withLease } from "../core/pool";
import { stageReads } from "../core/readback";
import {
	finalizeBands,
	statsParamWords,
	statsSubgroupsOn,
} from "./color-stats";
import { BAND_STATS, BAND_STATS_SG, STATS_VALUES } from "./color-stats.wgsl";
import {
	buildFoldGraph,
	markFoldFailed,
	STATS_BYTES,
	statsFoldOn,
	statsFromWords,
	subgroupLayoutFailed,
} from "./color-stats-fold";
import {
	PACK_MASKS,
	TEX_FGBITS,
	TEX_HAZE,
	TEX_MASKS,
	TEX_PHOTO,
	TEX_STATS,
	ZERO_U32,
} from "./gather-tex.wgsl";
import { GF_H0, GF_H1, GF_V0, GF_V1 } from "./guided-filter.wgsl";
import {
	BUCKETS,
	HZ_BIN,
	HZ_DILH,
	HZ_HIST,
	HZ_PREP,
	HZ_SCAN,
	HZ_SCAN_SG,
	HZ_SEL_INIT,
	SEL,
} from "./haze.wgsl";
import {
	GUIDED_PARAMS,
	HAZE_PASS_PARAMS,
	HAZE_PREP_PARAMS,
	PACK_MASKS_PARAMS,
	TEX_HAZE_PARAMS,
	TEX_MASKS_PARAMS,
	TEX_PHOTO_PARAMS,
	TEX_STATS_PARAMS,
} from "./uniform-blocks";

/** A texture input; `flipY` = its row 0 is the image's bottom row. */
export type TexIn = Texture | { texture: Texture; flipY?: boolean };

// ── kernels ─────────────────────────────────────────────────────────────────────────────────────

const GROUP = "look-tex";
const buf = (id: string, source: string, layout: [string, BindKind][]) =>
	defineKernel(id, source, layout, { group: GROUP, label: `look-tex-${id}` });

const K_GF_H0 = buf("gf-h0", GF_H0, [
	["prm", "uniform"],
	["gI", "read-only-storage"],
	["gp", "read-only-storage"],
	["outv", "storage"],
]);
const K_GF_V0 = buf("gf-v0", GF_V0, [
	["prm", "uniform"],
	["inv", "read-only-storage"],
	["ab", "storage"],
]);
const K_GF_H1 = buf("gf-h1", GF_H1, [
	["prm", "uniform"],
	["ab", "read-only-storage"],
	["outv", "storage"],
]);
const K_GF_V1 = buf("gf-v1", GF_V1, [
	["prm", "uniform"],
	["inv", "read-only-storage"],
	["gI", "read-only-storage"],
	["q", "storage"],
]);
const K_PACK = buf("pack-masks", PACK_MASKS, [
	["prm", "uniform"],
	["qc", "read-only-storage"],
	["qg", "read-only-storage"],
	["qf", "read-only-storage"],
	["outp", "storage"],
]);
const STATS_LAYOUT: [string, BindKind][] = [
	["prm", "uniform"],
	["photo", "read-only-storage"],
	["layer", "read-only-storage"],
	["range", "read-only-storage"],
	["fg", "read-only-storage"],
	["lut", "read-only-storage"],
	["partial", "storage"],
];
const K_BAND_STATS = buf("band-stats", BAND_STATS, STATS_LAYOUT);
// needs the "subgroups" feature: its own warm-up group
const K_BAND_STATS_SG = defineKernel(
	"band-stats-sg",
	BAND_STATS_SG,
	STATS_LAYOUT,
	{
		group: `${GROUP}-subgroups`,
		label: "look-tex-band-stats-sg",
	},
);
const K_HZ_PREP = buf("hz-prep", HZ_PREP, [
	["prm", "uniform"],
	["photo", "read-only-storage"],
	["xb", "read-only-storage"],
	["yb", "read-only-storage"],
	["lut", "read-only-storage"],
	["range", "read-only-storage"],
	["fgm", "read-only-storage"],
	["lin", "storage"],
	["flags", "storage"],
]);
const K_HZ_DILH = buf("hz-dilh", HZ_DILH, [
	["prm", "uniform"],
	["flags", "read-only-storage"],
	["outf", "storage"],
]);
const K_HZ_BIN = buf("hz-bin", HZ_BIN, [
	["prm", "uniform"],
	["flagsH", "read-only-storage"],
	["range", "read-only-storage"],
	["psky", "read-only-storage"],
	["bins", "storage"],
	["counts", "storage"],
]);
const K_HZ_SEL_INIT = buf("hz-sel-init", HZ_SEL_INIT, [
	["counts", "read-only-storage"],
	["state", "storage"],
]);
const K_ZERO = buf("zero-u32", ZERO_U32, [["buf", "storage"]]);
const K_HZ_HIST = buf("hz-hist", HZ_HIST, [
	["prm", "uniform"],
	["bins", "read-only-storage"],
	["lin", "read-only-storage"],
	["state", "read-only-storage"],
	["hist", "storage"],
]);
const HZ_SCAN_LAYOUT: [string, BindKind][] = [
	["prm", "uniform"],
	["hist", "read-only-storage"],
	["state", "storage"],
];
const K_HZ_SCAN = buf("hz-scan", HZ_SCAN, HZ_SCAN_LAYOUT);
// HZ_SCAN by subgroupInclusiveAdd (same bits); needs the "subgroups" feature: its own warm-up group
const K_HZ_SCAN_SG = defineKernel("hz-scan-sg", HZ_SCAN_SG, HZ_SCAN_LAYOUT, {
	group: `${GROUP}-subgroups`,
	label: "look-tex-hz-scan-sg",
});

// Kernels that read textures: the same core defineKernel with "texture" layout entries (the WGSL's
// auto layout makes the textureLoad-only textures 'unfilterable-float', which accepts rgba32float
// and unorm formats; core's explicit layout declares exactly that).
/** this file's kernels bind 2-D textures only */
type TexBind = Exclude<BindKind, "texture-array">;
const texSpec = (id: string, source: string, layout: [string, TexBind][]) =>
	buf(id, source, layout);

const K_TEX_PHOTO = texSpec("photo", TEX_PHOTO, [
	["prm", "uniform"],
	["xb", "read-only-storage"],
	["yb", "read-only-storage"],
	["src", "texture"],
	["outp", "storage"],
]);
const K_TEX_MASKS = texSpec("masks", TEX_MASKS, [
	["prm", "uniform"],
	["tab", "read-only-storage"],
	["photo", "read-only-storage"],
	["geo", "texture"],
	["skyT", "texture"],
	["fgT", "texture"],
	["gI", "storage"],
	["cov", "storage"],
	["fgv", "storage"],
]);
const K_TEX_STATS = texSpec("stats", TEX_STATS, [
	["prm", "uniform"],
	["tab", "read-only-storage"],
	["geo", "texture"],
	["layerT", "texture"],
	["fgT", "texture"],
	["range", "storage"],
	["layer", "storage"],
	["fgv", "storage"],
]);
const K_TEX_HAZE = texSpec("haze", TEX_HAZE, [
	["prm", "uniform"],
	["tab", "read-only-storage"],
	["geo", "texture"],
	["skyT", "texture"],
	["range", "storage"],
	["psky", "storage"],
]);
const K_TEX_FGBITS = texSpec("fgbits", TEX_FGBITS, [
	["prm", "uniform"],
	["tab", "read-only-storage"],
	["fgT", "texture"],
	["fgm", "storage"],
]);

/** Compile every texture-look pipeline now (core warmKernelsAsync(d, "look-tex") does the same in parallel). */
export function warmTextureKernels(device: Device): number {
	return warmKernels(device, GROUP);
}

/** Devices whose texture-look pipelines are all built (a sync graph compile then only looks them up). */
const warmDevices = new WeakSet<Device>();

/** warmTextureKernels without blocking the thread: call it when the render device is adopted. */
export function warmTextureKernelsAsync(device: Device): Promise<number> {
	return warmKernelsAsync(device, GROUP).then((n) => {
		warmDevices.add(device);
		return n;
	});
}

/**
 * The graph is compiled for a SYNCHRONOUS encode (encodeMasksTex / encodeBandStatsTex record into the
 * caller's encoder in the same tick as the submit): when it is not yet, start compileAsync (so the
 * pipelines never compile on the main thread) and throw, which sends the caller to its non-fused
 * path for this frame. The next frame finds the graph compiled.
 */
function assertCompiled(
	graph: ComputeGraph,
	what: string,
	onFail?: (error: unknown) => void,
) {
	if (graph.isCompiled) return;
	// pipelines already cached: the sync compile builds no pipeline on the main thread
	if (warmDevices.has(graph.device) && !graph.isCompiling) {
		graph.compile();
		return;
	}
	graph.compileAsync().catch((error) => {
		console.warn(`[lookgpu] ${what} graph compile failed`, error);
		onFail?.(error);
	});
	throw new Error(`[lookgpu] ${what} graph compiling`);
}

type TexBinding = GraphBinding | GraphTextureHandle;

/** A graph node running a texture-reading kernel: `groups` workgroups along x. */
function addTexNode<P>(
	g: ComputeGraph<P>,
	id: string,
	spec: KernelSpec,
	bindings: Record<string, TexBinding>,
	groups: number,
) {
	g.addKernel({ id, spec, bindings, workgroups: [groups] });
}

// ── shared plumbing ─────────────────────────────────────────────────────────────────────────────

const WG = 256;
const STORAGE = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;

type Src = { texture: Texture; flip: boolean };
const src = (t: TexIn): Src =>
	t instanceof Texture
		? { texture: t, flip: false }
		: { texture: t.texture, flip: !!t.flipY };

const GEO_FORMATS = ["rgba32float", "r32float"];
const PHOTO_FORMATS = ["rgba8unorm", "rgba8unorm-srgb"];
const MASK_FORMATS = ["r8unorm", "rgba8unorm"];
const LAYER_FORMATS = ["rgba32float", "rgba16float", "rgba8unorm"];

function check(device: Device, s: Src, what: string, formats: string[]) {
	if (s.texture.device !== device)
		throw new Error(
			`[lookgpu] ${what} texture is on another device (adoptRenderDevice first)`,
		);
	if (!formats.includes(s.texture.format))
		throw new Error(
			`[lookgpu] ${what} texture is ${s.texture.format}, want ${formats.join(" | ")}`,
		);
	if ((s.texture.props.usage ?? 0) & Texture.SAMPLE) return;
	throw new Error(`[lookgpu] ${what} texture lacks Texture.SAMPLE usage`);
}

/**
 * Re-checked inside the pass lease, just before the submit: a queued call may run frames after it
 * was made, and a destroyed input would fail validation and read back stale staging bytes.
 */
function assertAlive(device: Device, srcs: (Src | null)[]) {
	if (device.isLost) throw new Error("[lookgpu] device lost");
	for (const s of srcs)
		if (s?.texture.destroyed)
			throw new Error(
				`[lookgpu] input texture ${s.texture.id} was destroyed before the pass ran`,
			);
}

const dummies = new WeakMap<Device, Texture>();
/** 1 × 1 r8unorm for an absent mask (the kernels branch on a flag and never read it). */
function dummyMask(device: Device): Texture {
	let t = dummies.get(device);
	if (!t) {
		// WebGPU zero-initialises it
		t = device.createTexture({
			id: "look-tex-dummy",
			format: "r8unorm",
			width: 1,
			height: 1,
			usage: Texture.SAMPLE | Texture.COPY_DST,
		});
		dummies.set(device, t);
	}
	return t;
}

/** The texture-look graphs' core cachedGraph group (graph ids `look-tex|<key>`). */
const MAX_GRAPHS = 6;

/**
 * The graph for `key` (core cachedGraph, group "look-tex": LRU of 6 per device, an evicted graph is
 * destroyed with the buffers it owns, ComputeGraph.own). `build` adds the nodes; the graph is
 * NOT compiled: await graph.compileAsync() before run(), or compile() where the call is synchronous
 * (core README, "Page-side graphs"). Call it INSIDE the pass lease and queue graph.run synchronously
 * after the compile: run() queues on the graph's lease, so an eviction (which destroys under that
 * same lease) always lands after it.
 */
function lookGraph<X>(
	device: Device,
	key: string,
	build: (g: ComputeGraph, owned: (Buffer | Texture)[]) => X,
): CachedGraph<void, X> {
	return cachedGraph<void, X>(
		device,
		GROUP,
		key,
		(g) => {
			const owned: (Buffer | Texture)[] = [];
			g.own(owned);
			try {
				return build(g, owned);
			} catch (error) {
				for (const r of owned) r.destroy();
				throw error;
			}
		},
		MAX_GRAPHS,
	);
}

/** The per-pass leases (every call of a pass is serialised under its lease). */
const PASS = {
	masks: "look-tex/masks",
	stats: "look-tex/stats",
	haze: "look-tex/haze",
} as const;

/**
 * Free every cached texture-look graph of `device` (and its constant buffers), the output mask
 * textures and the dummy mask. Each graph is destroyed after any run of it in flight, the textures
 * after every queued pass; calls made afterwards rebuild what they need.
 */
export async function releaseTextureGraphs(device: Device): Promise<void> {
	const done = [releaseCachedGraphs(device, GROUP)];
	// every pass samples the dummy; masks also writes the output textures (no pass nests leases,
	// so taking all three here cannot deadlock)
	done.push(
		withLease(PASS.masks, () =>
			withLease(PASS.stats, () =>
				withLease(PASS.haze, () => {
					for (const t of outTextures.get(device)?.values() ?? []) t.destroy();
					outTextures.delete(device);
					dummies.get(device)?.destroy();
					dummies.delete(device);
				}),
			),
		),
	);
	await Promise.all(done);
}

/** Graph-side constants: a uniform / storage buffer imported with a fixed default. */
function constants(g: ComputeGraph, owned: (Buffer | Texture)[]) {
	return {
		uniform(id: string, words: ArrayBuffer) {
			const b = uniform(g.device, words);
			owned.push(b);
			return g.importBuffer(id, b.byteLength, b, UNIFORM);
		},
		storage(id: string, data: ArrayBufferView) {
			const b = storage(g.device, data);
			owned.push(b);
			return g.importBuffer(id, b.byteLength, b);
		},
	};
}

/**
 * Box footprints [x0, x1) of each of `n` output pixels over `size` source texels, in f64 as
 * haze.ts prepUploads (1 texel each when n = size).
 */
function footprints(n: number, size: number): Uint32Array {
	const s = size / n;
	const t = new Uint32Array(2 * n);
	for (let x = 0; x < n; x++) {
		const x0 = Math.floor(x * s);
		t[2 * x] = x0;
		t[2 * x + 1] = Math.max(x0 + 1, Math.min(size, Math.floor((x + 1) * s)));
	}
	return t;
}

/** composite.ts / capture.ts maskAt's texel index of cell k of n over a mask of `size` texels. */
const maskIndex = (k: number, n: number, size: number) =>
	Math.min(size - 1, Math.floor(((k + 0.5) / n) * size));

/** TEX_PHOTO node: `photo` box-resampled to w × h packed RGBA8 words in transient `id`. */
function addPhoto(
	g: ComputeGraph,
	c: ReturnType<typeof constants>,
	photo: Src,
	w: number,
	h: number,
	id: string,
) {
	const pw = photo.texture.width;
	const ph = photo.texture.height;
	const tex = g.importTexture({
		id: `${id}-tex`,
		format: photo.texture.format,
		width: pw,
		height: ph,
		usage: Texture.SAMPLE,
	});
	const out = g.transientBuffer(id, w * h * 4);
	addTexNode(
		g,
		`${id}-gather`,
		K_TEX_PHOTO,
		{
			prm: c.uniform(
				`${id}-prm`,
				TEX_PHOTO_PARAMS.pack({
					W: w,
					H: h,
					srcH: ph,
					flip: photo.flip ? 1 : 0,
					srgb: photo.texture.format === "rgba8unorm-srgb" ? 1 : 0,
				}),
			),
			xb: c.storage(`${id}-xb`, footprints(w, pw)),
			yb: c.storage(`${id}-yb`, footprints(h, ph)),
			src: tex,
			outp: out,
		},
		Math.ceil((w * h) / WG),
	);
	return out;
}

const texKey = (s: Src | null) =>
	s
		? `${s.texture.format}:${s.texture.width}x${s.texture.height}:${+s.flip}`
		: "-";

/** Import a sampled texture (a 1 × 1 dummy stands in for an absent mask). */
function importSampled(g: ComputeGraph, id: string, s: Src | null) {
	const t = s?.texture ?? dummyMask(g.device);
	return g.importTexture({
		id,
		format: t.format,
		width: t.width,
		height: t.height,
		usage: Texture.SAMPLE,
	});
}

/** An output slot of pass `pass`: a pooled buffer (valid until the pass's next call). */
const slot = (device: Device, pass: string, name: string, bytes: number) =>
	acquire(device, `look-tex/${pass}/${name}`, Math.max(4, bytes), STORAGE);

/** Read `bytes` from each buffer, resolved after the graph's submit. */
const reads = (list: [Buffer, number][]) =>
	list.map(([buffer, size]) => ({ buffer, size: Math.max(4, size) }));

// ── masks (guided filter) ───────────────────────────────────────────────────────────────────────

export type MasksTexInput = {
	geometry: TexIn;
	/** The photo; exact vs the CPU when it is already the mask grid's size. */
	photo: TexIn;
	/** P(sky) (composite.sky "photo"); null = coverage from the DEM alone. */
	sky?: TexIn | null;
	/** People (segmentation). */
	fg?: TexIn | null;
	/** The blend cut plane, w × h row 0 = top (CompositeLook builds it from a CPU closure). */
	cut?: Float32Array | null;
	/** Mask grid; default composite.ts gridSize(gw / gh, MASK_LONG_SIDE). */
	size?: [number, number];
};

export type MasksTexOptions = {
	/**
	 * Also write the packed masks into a texture: "rgba8unorm" (r coverage, g cut, b people, a 255)
	 * or "r8unorm" (coverage) creates and caches one of the grid's size; or pass your own (COPY_DST
	 * usage, the grid's size, one of those formats).
	 */
	texture?: "rgba8unorm" | "r8unorm" | Texture;
	/** Read the float planes and the RGBA8 masks back (default false: GPU only). */
	read?: boolean;
};

export type MasksTexResult = {
	w: number;
	h: number;
	/** refined planes, in CompositeLook's job order: coverage, cut (if any), people (if any) */
	q: Buffer[];
	/** packed masks: `rowWords` u32 per row (rgba: one texel a word; r8: four) */
	packed: Buffer;
	rowWords: number;
	texture?: Texture;
	/** with `read`: the planes and the RGBA8 masks (w × h × 4, as CompositeLook.masks.data) */
	data?: { q: Float32Array[]; masks: Uint8Array };
};

/** One output texture per format, recreated when the grid changes (call under the masks lease). */
const outTextures = new WeakMap<Device, Map<string, Texture>>();
function ownTexture(
	device: Device,
	format: "rgba8unorm" | "r8unorm",
	w: number,
	h: number,
): Texture {
	let m = outTextures.get(device);
	if (!m) {
		m = new Map();
		outTextures.set(device, m);
	}
	let t = m.get(format);
	if (t && (t.width !== w || t.height !== h || t.destroyed)) {
		// WebGPU defers the destroy until the work already submitted with it completes
		t.destroy();
		t = undefined;
	}
	if (!t) {
		t = device.createTexture({
			id: `look-tex-masks-${format}:${w}x${h}`,
			format,
			width: w,
			height: h,
			usage: Texture.SAMPLE | Texture.COPY_DST | Texture.COPY_SRC,
		});
		m.set(format, t);
	}
	return t;
}

/** masksTex' validated inputs, grid and packing layout (shared by masksTex and encodeMasksTex). */
function masksPlan(
	device: Device,
	input: MasksTexInput,
	texture: MasksTexOptions["texture"],
) {
	const geo = src(input.geometry);
	const photo = src(input.photo);
	const sky = input.sky ? src(input.sky) : null;
	const fg = input.fg ? src(input.fg) : null;
	check(device, geo, "geometry", GEO_FORMATS);
	check(device, photo, "photo", PHOTO_FORMATS);
	if (sky) check(device, sky, "sky", MASK_FORMATS);
	if (fg) check(device, fg, "fg", MASK_FORMATS);
	const gw = geo.texture.width;
	const gh = geo.texture.height;
	const [w, h] = input.size ?? gridSize(gw / gh, MASK_LONG_SIDE);
	const n = w * h;
	const cut = input.cut ?? null;
	if (cut && cut.length !== n) throw new Error("[lookgpu] cut is not w × h");
	const given = texture instanceof Texture ? texture : null;
	if (given) {
		if (given.device !== device)
			throw new Error("[lookgpu] mask texture is on another device");
		if (given.format !== "rgba8unorm" && given.format !== "r8unorm")
			throw new Error(
				`[lookgpu] mask texture is ${given.format}, want rgba8unorm | r8unorm`,
			);
		if (!((given.props.usage ?? 0) & Texture.COPY_DST))
			throw new Error("[lookgpu] mask texture lacks Texture.COPY_DST usage");
		if (given.width !== w || given.height !== h)
			throw new Error("[lookgpu] mask texture is not the grid's size");
	}
	const outFormat: "rgba8unorm" | "r8unorm" | null = given
		? (given.format as "rgba8unorm" | "r8unorm")
		: typeof texture === "string"
			? texture
			: null;
	const fmt = outFormat === "r8unorm" ? 1 : 4;
	const rowWords = fmt === 4 ? Math.ceil(w / 64) * 64 : Math.ceil(w / 256) * 64;
	// masksAsync's jobs: coverage, cut, people
	const jobs = [
		{ name: "cov", r: Math.max(2, Math.round(w * 0.008)), eps: 4e-4 },
	];
	if (cut)
		jobs.push({
			name: "cut",
			r: Math.max(2, Math.round(w * 0.008)),
			eps: 3e-3,
		});
	if (fg)
		jobs.push({ name: "fg", r: Math.max(3, Math.round(w * 0.012)), eps: 1e-3 });
	const key = [
		"masks",
		w,
		h,
		texKey(geo),
		texKey(photo),
		texKey(sky),
		texKey(fg),
		+!!cut,
		outFormat ?? "-",
	].join("|");
	return {
		geo,
		photo,
		sky,
		fg,
		given,
		outFormat,
		w,
		h,
		n,
		jobs,
		rowWords,
		key,
		gw,
		gh,
		fmt,
		cut,
	};
}

type MasksPlan = ReturnType<typeof masksPlan>;

/**
 * The compiled masks graph of `plan` (one per key, cached). Call it INSIDE the masks lease (or
 * synchronously before encoding into the caller's encoder, as encodeMasksTex does): see lookGraph.
 */
function masksGraph(device: Device, plan: MasksPlan) {
	const {
		geo,
		photo,
		sky,
		fg,
		outFormat,
		w,
		h,
		n,
		jobs,
		rowWords,
		key,
		gw,
		gh,
		fmt,
		cut,
	} = plan;
	return lookGraph(device, key, (g, owned) => {
		const c = constants(g, owned);
		const groups = Math.ceil(n / WG);
		const words = addPhoto(g, c, photo, w, h, "photo");
		const sx = gw / w;
		const sy = gh / h;
		const ss = Math.max(1, Math.round(sx));
		const tab = new Uint32Array(4 * w + 4 * h);
		for (let x = 0; x < w; x++) tab[x] = Math.floor(x * sx);
		for (let y = 0; y < h; y++) tab[w + y] = Math.floor(y * sy);
		for (const [m, o] of [
			[sky, w + h],
			[fg, 2 * w + 2 * h],
		] as const)
			if (m) {
				for (let x = 0; x < w; x++)
					tab[o + x] = maskIndex(x, w, m.texture.width);
				for (let y = 0; y < h; y++)
					tab[o + w + y] = maskIndex(y, h, m.texture.height);
			}
		const gI = g.transientBuffer("gI", n * 4);
		const cov = g.transientBuffer("cov", n * 4);
		const fgv = g.transientBuffer("fgv", n * 4);
		addTexNode(
			g,
			"gather",
			K_TEX_MASKS,
			{
				prm: c.uniform(
					"gather-prm",
					TEX_MASKS_PARAMS.pack({
						w,
						h,
						gw,
						gh,
						ss,
						flipGeo: +geo.flip,
						sky: +!!sky,
						flipSky: +!!sky?.flip,
						skyH: sky?.texture.height ?? 1,
						fg: +!!fg,
						flipFg: +!!fg?.flip,
						fgH: fg?.texture.height ?? 1,
						geoR: +(geo.texture.format === "r32float"),
					}),
				),
				tab: c.storage("gather-tab", tab),
				photo: words,
				geo: importSampled(g, "geo", geo),
				skyT: importSampled(g, "sky", sky),
				fgT: importSampled(g, "fg", fg),
				gI,
				cov,
				fgv,
			},
			groups,
		);
		const cutIn = cut ? g.importBuffer("cut", n * 4) : null;
		const qs: GraphBufferHandle[] = [];
		for (const j of jobs) {
			const prm = c.uniform(
				`${j.name}-prm`,
				GUIDED_PARAMS.pack({ w, h, r: j.r, eps: j.eps }),
			);
			const p =
				j.name === "cov"
					? cov
					: j.name === "fg"
						? fgv
						: (cutIn as GraphBufferHandle);
			const t4 = g.transientBuffer(`${j.name}-t4`, n * 16);
			const ab = g.transientBuffer(`${j.name}-ab`, n * 8);
			const t2 = g.transientBuffer(`${j.name}-t2`, n * 8);
			const q = g.importBuffer(`q-${j.name}`, n * 4);
			qs.push(q);
			g.addKernel({
				id: `${j.name}-h0`,
				spec: K_GF_H0,
				bindings: { prm, gI, gp: p, outv: t4 },
				workgroups: [groups],
			});
			g.addKernel({
				id: `${j.name}-v0`,
				spec: K_GF_V0,
				bindings: { prm, inv: t4, ab },
				workgroups: [groups],
			});
			g.addKernel({
				id: `${j.name}-h1`,
				spec: K_GF_H1,
				bindings: { prm, ab, outv: t2 },
				workgroups: [groups],
			});
			g.addKernel({
				id: `${j.name}-v1`,
				spec: K_GF_V1,
				bindings: { prm, inv: t2, gI, q },
				workgroups: [groups],
			});
		}
		const packed = g.importBuffer("packed", rowWords * h * 4);
		const qOf = (name: string) =>
			qs[jobs.findIndex((j) => j.name === name)] ?? qs[0];
		g.addKernel({
			id: "pack",
			spec: K_PACK,
			bindings: {
				prm: c.uniform(
					"pack-prm",
					PACK_MASKS_PARAMS.pack({
						w,
						h,
						rowWords,
						fmt,
						cut: +!!cut,
						fg: +!!fg,
					}),
				),
				qc: qs[0],
				qg: qOf("cut"),
				qf: qOf("fg"),
				outp: packed,
			},
			workgroups: [Math.ceil((rowWords * h) / WG)],
		});
		if (outFormat) {
			const dst = g.importTexture({
				id: "out",
				format: outFormat,
				width: w,
				height: h,
				usage: Texture.COPY_DST,
			});
			g.graph.addCopyPass({
				id: "to-texture",
				resources: [
					{ buffer: packed, usage: "copy-source" },
					{ texture: dst, usage: "copy-destination" },
				],
				compile: () => ({
					encode: ({ commandEncoder, getBuffer, getTexture }) =>
						commandEncoder.copyBufferToTexture({
							sourceBuffer: getBuffer(packed),
							destinationTexture: getTexture(dst),
							bytesPerRow: rowWords * 4,
							rowsPerImage: h,
							size: [w, h, 1],
						}),
				}),
			});
		}
		return null;
	});
}

/**
 * CompositeLook.updateMasks on the GPU from textures: the mask-grid inputs gathered from the
 * geometry / photo / mask textures, the guided filters (same radii and ε as masksAsync), the RGBA8
 * packing, and optionally the texture copy. One submit; nothing read back unless `read`.
 */
export function masksTex(
	device: Device,
	input: MasksTexInput,
	opts: MasksTexOptions = {},
): Promise<MasksTexResult> {
	const plan = masksPlan(device, input, opts.texture);
	const { geo, photo, sky, fg, given, outFormat, w, h, n, jobs, rowWords } =
		plan;
	const { fmt, cut } = plan;
	const graphOf = () => masksGraph(device, plan);
	return withLease(PASS.masks, async () => {
		assertAlive(device, [geo, photo, sky, fg, given && src(given)]);
		const outTex =
			given ?? (outFormat ? ownTexture(device, outFormat, w, h) : null);
		const e = graphOf();
		await e.graph.compileAsync();
		const buffers: Record<string, Buffer> = {};
		const q = jobs.map((j) => {
			const b = slot(device, "masks", `q-${j.name}`, n * 4);
			buffers[`q-${j.name}`] = b;
			return b;
		});
		const packed = slot(device, "masks", "packed", rowWords * h * 4);
		buffers.packed = packed;
		if (cut) {
			const b = slot(device, "masks", "cut", n * 4);
			b.write(cut);
			buffers.cut = b;
		}
		const textures: Record<string, Texture> = {
			geo: geo.texture,
			sky: sky?.texture ?? dummyMask(device),
			fg: fg?.texture ?? dummyMask(device),
			"photo-tex": photo.texture,
		};
		if (outTex) textures.out = outTex;
		const { data } = await e.graph.run(undefined, {
			buffers,
			textures,
			read: opts.read
				? reads([
						...q.map((b) => [b, n * 4] as [Buffer, number]),
						[packed, rowWords * h * 4],
					])
				: [],
		});
		const r: MasksTexResult = { w, h, q, packed, rowWords };
		if (outTex) r.texture = outTex;
		if (opts.read) {
			const words = new Uint32Array(data[q.length]);
			const masks = new Uint8Array(n * 4);
			if (fmt === 4)
				for (let y = 0; y < h; y++)
					masks.set(
						new Uint8Array(words.buffer, y * rowWords * 4, w * 4),
						y * w * 4,
					);
			else {
				// r8: coverage only, as rgba with g = b = 0, a = 255
				const bytes = new Uint8Array(words.buffer);
				for (let y = 0; y < h; y++)
					for (let x = 0; x < w; x++) {
						masks[(y * w + x) * 4] = bytes[y * rowWords * 4 + x];
						masks[(y * w + x) * 4 + 3] = 255;
					}
			}
			r.data = {
				q: data.slice(0, q.length).map((b) => new Float32Array(b)),
				masks,
			};
		}
		return r;
	});
}

/**
 * masksTex recorded into the CALLER's encoder: no lease, no submit, nothing read back (WAG W1.2:
 * the query geometry's own encoder, so the masks ride on the geometry pass's submit). Same plan,
 * same cached compiled graph and same kernels as masksTex, so the output texture holds the same
 * bytes masksTex would write from the same input bytes.
 *
 * Rules (the caller's, since no lease serialises this path):
 * - `encoder` is submitted synchronously after this returns (no await in between). Graph
 *   transients are then shared with masksTex runs only across command buffers, which the queue
 *   executes in order, and each encoding writes them before it reads them.
 * - `texture` is the caller's (COPY_DST, the grid's size) and no other queued pass writes it until
 *   the caller has consumed it.
 * - No blend cut: its plane is a CPU upload from the range readback, which a draw-time encode does
 *   not have.
 * Every check runs before anything is recorded, so a throw leaves `encoder` untouched.
 */
export function encodeMasksTex(
	device: Device,
	encoder: CommandEncoder,
	input: Omit<MasksTexInput, "cut">,
	texture: Texture,
): { w: number; h: number } {
	const plan = masksPlan(device, input, texture);
	const { geo, photo, sky, fg, w, h, n, jobs, rowWords } = plan;
	assertAlive(device, [geo, photo, sky, fg, src(texture)]);
	const e = masksGraph(device, plan);
	assertCompiled(e.graph, "masks");
	// own pooled slots: the masks lease's q / packed may still be in use by a queued masksTex
	const buffers: Record<string, Buffer> = {};
	for (const j of jobs)
		buffers[`q-${j.name}`] = slot(device, "masks-enc", `q-${j.name}`, n * 4);
	buffers.packed = slot(device, "masks-enc", "packed", rowWords * h * 4);
	e.graph.encode(encoder, undefined, buffers, {
		geo: geo.texture,
		sky: sky?.texture ?? dummyMask(device),
		fg: fg?.texture ?? dummyMask(device),
		"photo-tex": photo.texture,
		out: texture,
	});
	return { w, h };
}

// ── band colour stats ───────────────────────────────────────────────────────────────────────────

export type StatsTexInput = {
	geometry: TexIn;
	/** the band-stats layer (linear RGBA, alpha = coverage), w × h */
	layer: TexIn;
	/** the photo; exact vs the CPU when it is already w × h */
	photo: TexIn;
	fg?: TexIn | null;
	/** nearer terrain doesn't count (composite.ts trustedRange) */
	minRange: number;
	/** reduceBands' minCount (default 60) */
	minCount?: number;
};

export type StatsTexResult = {
	/**
	 * the result on the GPU: with the GPU fold (fold "gpu", the default) the folded ColorStats words
	 * (STATS_WORDS f32, color-stats-fold.wgsl.ts STATS_LAYOUT); with fold "f64" the per-workgroup
	 * partial sums (32 × 52 f32)
	 */
	buffer: Buffer;
	/** which of the two `buffer` holds */
	fold: "gpu" | "f64";
	/** with `read` (default true): the ColorStats CompositeLook.stats holds */
	stats: ColorStats | null;
};

const SRGB_LUT_STATS = Float32Array.from({ length: 256 }, (_, i) => {
	const c = i / 255;
	return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
// color-stats.ts GROUPS (statsParamWords dispatches GROUPS × WG invocations)
const SGROUPS = 32;
const PARTIAL_BYTES = SGROUPS * STATS_VALUES * 4;

/** bandStatsTex' validated inputs and graph key (shared by bandStatsTex and encodeBandStatsTex). */
function statsPlan(
	device: Device,
	input: StatsTexInput,
	opts: { subgroups?: boolean; fold?: "gpu" | "f64" },
) {
	const geo = src(input.geometry);
	const layer = src(input.layer);
	const photo = src(input.photo);
	const fg = input.fg ? src(input.fg) : null;
	check(device, geo, "geometry", GEO_FORMATS);
	check(device, layer, "layer", LAYER_FORMATS);
	check(device, photo, "photo", PHOTO_FORMATS);
	if (fg) check(device, fg, "fg", MASK_FORMATS);
	const w = layer.texture.width;
	const h = layer.texture.height;
	const n = w * h;
	const gw = geo.texture.width;
	const gh = geo.texture.height;
	const sg = statsSubgroupsOn(device, opts.subgroups);
	const fold: "gpu" | "f64" = statsFoldOn(device, opts.fold) ? "gpu" : "f64";
	const key = [
		"stats",
		fold,
		+sg,
		texKey(geo),
		texKey(layer),
		texKey(photo),
		texKey(fg),
	].join("|");
	const outBytes = fold === "gpu" ? STATS_BYTES : PARTIAL_BYTES;
	return { geo, layer, photo, fg, w, h, n, gw, gh, sg, fold, key, outBytes };
}

type StatsPlan = ReturnType<typeof statsPlan>;

/** The gather node and the band-stats node of `plan` on `g`, writing `partial`. */
function addStatsNodes(
	g: ComputeGraph,
	c: ReturnType<typeof constants>,
	plan: StatsPlan,
	prm: GraphBinding,
	partial: GraphBinding,
) {
	const { geo, layer, photo, fg, w, h, n, gw, gh, sg } = plan;
	const words = addPhoto(g, c, photo, w, h, "photo");
	const tab = new Uint32Array(2 * w + 2 * h);
	for (let x = 0; x < w; x++) tab[x] = Math.floor(((x + 0.5) * gw) / w);
	for (let y = 0; y < h; y++) tab[w + y] = Math.floor(((y + 0.5) * gh) / h);
	if (fg) {
		for (let x = 0; x < w; x++)
			tab[w + h + x] = maskIndex(x, w, fg.texture.width);
		for (let y = 0; y < h; y++)
			tab[2 * w + h + y] = maskIndex(y, h, fg.texture.height);
	}
	const range = g.transientBuffer("range", n * 4);
	const lay = g.transientBuffer("layer", n * 16);
	const fgv = g.transientBuffer("fgv", n * 4);
	addTexNode(
		g,
		"gather",
		K_TEX_STATS,
		{
			prm: c.uniform(
				"gather-prm",
				TEX_STATS_PARAMS.pack({
					w,
					h,
					gh,
					flipGeo: +geo.flip,
					flipLayer: +layer.flip,
					fg: +!!fg,
					flipFg: +!!fg?.flip,
					fgH: fg?.texture.height ?? 1,
					geoR: +(geo.texture.format === "r32float"),
				}),
			),
			tab: c.storage("gather-tab", tab),
			geo: importSampled(g, "geo", geo),
			layerT: importSampled(g, "layer-tex", layer),
			fgT: importSampled(g, "fg", fg),
			range,
			layer: lay,
			fgv,
		},
		Math.ceil(n / WG),
	);
	g.addKernel({
		id: "band-stats",
		spec: sg ? K_BAND_STATS_SG : K_BAND_STATS,
		bindings: {
			prm,
			photo: words,
			layer: lay,
			range,
			fg: fgv,
			lut: c.storage("lut", SRGB_LUT_STATS),
			partial,
		},
		workgroups: [SGROUPS],
	});
}

/**
 * The compiled band-stats graph of `plan` (cached; extra = its per-call parameter buffer). The output
 * import "out" (bound per run) receives the folded ColorStats words (GPU fold: a GPUProgram lowered
 * onto the graph, color-stats-fold.ts) or the partials (fold "f64").
 */
function statsGraph(device: Device, plan: StatsPlan) {
	return cachedGraphFrom<void, Buffer>(
		device,
		GROUP,
		plan.key,
		(id) => {
			const owned: (Buffer | Texture)[] = [];
			// per call: minRange / minCount (bandStatsGpu's words)
			const prmBuf = uniform(device, new ArrayBuffer(24));
			owned.push(prmBuf);
			const importPrm = (g: ComputeGraph) =>
				g.importBuffer("stats-prm", prmBuf.byteLength, prmBuf, UNIFORM);
			let g: ComputeGraph;
			try {
				if (plan.fold === "gpu") {
					g = buildFoldGraph(device, id, SGROUPS, {
						params: importPrm,
						produce: (pg, partial, prm) =>
							addStatsNodes(pg, constants(pg, owned), plan, prm, partial),
						output: (pg) => pg.importBuffer("out", STATS_BYTES),
					}).graph;
				} else {
					g = new ComputeGraph(device, id);
					addStatsNodes(
						g,
						constants(g, owned),
						plan,
						importPrm(g),
						g.importBuffer("out", PARTIAL_BYTES),
					);
				}
			} catch (error) {
				for (const r of owned) r.destroy();
				throw error;
			}
			g.own(owned);
			return { graph: g, extra: prmBuf };
		},
		MAX_GRAPHS,
	);
}

/** bandStatsTex' parameter words (bandStatsGpu's). */
function statsWords(plan: StatsPlan, minRange: number, minCount: number) {
	return new Uint8Array(
		statsParamWords(plan.w, plan.h, !!plan.fg, minRange, minCount),
	);
}

/** bandStatsGpu's float64 fold of the partials (keep in sync; fold "f64"). */
function foldPartials(data: ArrayBuffer, minCount: number): ColorStats {
	const p = new Float32Array(data);
	const acc = new Float64Array(N_BANDS * 12);
	const cnt = new Uint32Array(N_BANDS);
	for (let gi = 0; gi < SGROUPS; gi++)
		for (let b = 0; b < N_BANDS; b++) {
			const s = gi * STATS_VALUES + b * 13;
			cnt[b] += Math.round(p[s]);
			for (let v = 0; v < 12; v++) acc[b * 12 + v] += p[s + 1 + v];
		}
	return finalizeBands(acc, cnt, minCount);
}

/** The read-back result as ColorStats; null when BAND_STATS_SG's layout check failed. */
function statsOf(plan: StatsPlan, data: ArrayBuffer, minCount: number) {
	if (plan.fold === "gpu")
		return plan.sg && subgroupLayoutFailed(data) ? null : statsFromWords(data);
	if (plan.sg && new Float32Array(data).some((v, i) => i % 13 === 0 && v < 0))
		return null;
	return foldPartials(data, minCount);
}

/**
 * CompositeLook.setStats' GPU band stats from textures: one submit, 256 B back with the GPU fold (the
 * default; 6.6 KB with fold "f64"), or none (`read: false`: the result stays in `buffer`).
 * `subgroups` as bandStatsGpu's (default subgroups, on where the device has them). When
 * BAND_STATS_SG's layout check fails, a read call re-runs without subgroups; without a read, the
 * folded words say valid = -1 (a GPU consumer treats them as invalid stats).
 */
export function bandStatsTex(
	device: Device,
	input: StatsTexInput,
	opts: { read?: boolean; subgroups?: boolean; fold?: "gpu" | "f64" } = {},
): Promise<StatsTexResult> {
	const plan = statsPlan(device, input, opts);
	const { geo, layer, photo, fg, fold, outBytes } = plan;
	const read = opts.read ?? true;
	const minCount = input.minCount ?? 60;
	return withLease(PASS.stats, async () => {
		// a dead input or device is not a fold fault: it rejects as is (no f64 switch below)
		assertAlive(device, [geo, layer, photo, fg]);
		let data: ArrayBuffer[];
		const buffer = slot(device, "stats", `out-${fold}`, outBytes);
		try {
			const e = statsGraph(device, plan);
			await e.graph.compileAsync();
			(e.extra as Buffer).write(
				statsWords(plan, input.minRange ?? 0, minCount),
			);
			({ data } = await e.graph.run(undefined, {
				buffers: { out: buffer },
				textures: {
					geo: geo.texture,
					"layer-tex": layer.texture,
					"photo-tex": photo.texture,
					fg: fg?.texture ?? dummyMask(device),
				},
				read: read ? reads([[buffer, outBytes]]) : [],
			}));
		} catch (error) {
			if (fold !== "gpu" || device.isLost) throw error;
			return { foldFault: error };
		}
		if (!read) return { buffer, fold, stats: null };
		const stats = statsOf(plan, data[0], minCount);
		if (stats) return { buffer, fold, stats };
		// the subgroup layout check failed: the plain reduction (outside this lease: re-queue)
		return null;
	}).then((r) => {
		if (!r)
			return bandStatsTex(device, input, {
				...opts,
				subgroups: false,
				read: true,
			});
		if ("foldFault" in r) {
			// the fold graph faulted: the f64 fold (and from now on, on this device)
			markFoldFailed(device, r.foldFault);
			return bandStatsTex(device, input, { ...opts, fold: "f64" });
		}
		return r;
	});
}

/** encodeBandStatsTex's own parameter buffer per device (the graph's is the stats lease's). */
const encStatsPrm = new WeakMap<Device, Buffer>();

/**
 * bandStatsTex recorded into the CALLER's encoder, with its readback (256 B with the GPU fold) staged
 * on it (WAG W1.2: the stats layer render's own encoder, so render + stats are one submit instead of
 * two). Same plan, same cached compiled graph, same parameter words and the same fold, so the same
 * ColorStats. Own parameter / output buffers (the stats lease's may belong to a queued bandStatsTex).
 * Submit `encoder` synchronously after this returns (see encodeMasksTex), then call read(); if
 * the submit throws, call cancel() (it returns the staged readback slot). Every check runs before
 * anything is recorded. A failed subgroup layout check resolves through a bandStatsTex re-run
 * without subgroups (the textures must still be alive: they are until read() resolves).
 */
export function encodeBandStatsTex(
	device: Device,
	encoder: CommandEncoder,
	input: StatsTexInput,
	opts: { subgroups?: boolean; fold?: "gpu" | "f64" } = {},
): { read: () => Promise<StatsTexResult>; cancel: () => void } {
	let plan = statsPlan(device, input, opts);
	const { geo, layer, photo, fg } = plan;
	assertAlive(device, [geo, layer, photo, fg]);
	let e: ReturnType<typeof statsGraph>;
	try {
		e = statsGraph(device, plan);
	} catch (err) {
		if (plan.fold !== "gpu") throw err;
		// building the fold graph faulted: the f64 fold (and from now on, on this device)
		markFoldFailed(device, err);
		plan = statsPlan(device, input, { ...opts, fold: "f64" });
		e = statsGraph(device, plan);
	}
	const { fold, outBytes } = plan;
	// a fold graph that fails to compile is the fold's fault, as a failed build (above)
	assertCompiled(e.graph, "stats", (error) => {
		if (plan.fold === "gpu" && !device.isLost) markFoldFailed(device, error);
	});
	const graphPrm = e.extra as Buffer;
	let prm = encStatsPrm.get(device);
	if (!prm || prm.destroyed || prm.byteLength !== graphPrm.byteLength) {
		prm?.destroy();
		prm = uniform(device, new ArrayBuffer(24));
		encStatsPrm.set(device, prm);
	}
	const minCount = input.minCount ?? 60;
	prm.write(statsWords(plan, input.minRange ?? 0, minCount));
	const buffer = slot(device, "stats-enc", `out-${fold}`, outBytes);
	e.graph.encode(
		encoder,
		undefined,
		{ out: buffer, "stats-prm": prm },
		{
			geo: geo.texture,
			"layer-tex": layer.texture,
			"photo-tex": photo.texture,
			fg: fg?.texture ?? dummyMask(device),
		},
	);
	const staged = stageReads(device, encoder, reads([[buffer, outBytes]]));
	return {
		read: async () => {
			const [data] = await staged.read();
			const stats = statsOf(plan, data, minCount);
			if (stats) return { buffer, fold, stats };
			return bandStatsTex(device, input, {
				...opts,
				subgroups: false,
				read: true,
			});
		},
		cancel: () => staged.cancel(),
	};
}

// ── haze prep ───────────────────────────────────────────────────────────────────────────────────

export type HazeTexInput = {
	geometry: TexIn;
	/** the photo at any size (the haze controller's CPU path uses it at 2W × 2H) */
	photo: TexIn;
	sky?: TexIn | null;
	fg?: TexIn | null;
	/** geometry decimation (the haze controller's STEP, 2) */
	step?: number;
};

/** The haze prep's outputs as arrays (row 0 = top, W × H): what fitHazeGpu's CPU tail reads. */
export type HazePrep = {
	W: number;
	H: number;
	range: Float32Array;
	pSky: Float32Array;
	lin: Float32Array;
	bins: Int32Array;
	counts: Uint32Array;
	/** order statistic per (bin, channel, slot), as f32 */
	stat: Float32Array;
};

export type HazePrepResult = {
	W: number;
	H: number;
	/** pooled GPU buffers (valid until the next haze prep; see `gen`) */
	buffers: Record<
		"range" | "pSky" | "lin" | "bins" | "counts" | "state",
		Buffer
	>;
	/** the device's haze prep counter when this prep ran (hazePrepGen): a later prep overwrote the
	 * buffers (or grew and retired them) once hazePrepGen(device) moved on */
	gen: number;
	/** with `read` */
	data?: HazePrep;
};

const hazeGens = new WeakMap<Device, number>();
/** How many haze preps (tex or arrays) have been issued on `device`; read it under the haze lease. */
export const hazePrepGen = (device: Device) => hazeGens.get(device) ?? 0;

// mirror of haze.ts / haze-fit.ts (keep in sync)
const NBINS = 24;
const DMIN = 200;
const DMAX = 150000;
const SRGB_LUT_HAZE = (() => {
	const t = new Float32Array(256);
	for (let i = 0; i < 256; i++) t[i] = srgbToLinear(i / 255);
	return t;
})();

/** The array-path inputs of the haze prep (for the bench: same graph, CPU-built inputs). */
export type HazeArrays = {
	W: number;
	H: number;
	photo: {
		width: number;
		height: number;
		data: Uint8Array | Uint8ClampedArray;
	};
	range: Float32Array;
	pSky: Float32Array;
	/** people bits as haze.ts packs them (bit i & 31 of word i >> 5) */
	fgBits: Uint32Array;
	/** whether a people mask was given (fgRad) */
	hasFg: boolean;
};

type HazeGeom = {
	W: number;
	H: number;
	pw: number;
	ph: number;
	hasFg: boolean;
};

function hazeGraph(
	device: Device,
	key: string,
	d: HazeGeom,
	gather: null | {
		geo: Src;
		photo: Src;
		sky: Src | null;
		fg: Src | null;
		step: number;
	},
) {
	const scanSg = statsSubgroupsOn(device);
	return lookGraph(device, scanSg ? `${key}-sg` : key, (g, owned) => {
		const { W, H, pw, ph } = d;
		const N = W * H;
		const c = constants(g, owned);
		const groups = Math.ceil(N / WG);
		const range = g.importBuffer("range", N * 4);
		const psky = g.importBuffer("pSky", N * 4);
		let photo: GraphBufferHandle;
		let fgm: GraphBufferHandle;
		if (gather) {
			const { geo, sky, fg, step } = gather;
			const gh = geo.texture.height;
			photo = addPhoto(g, c, gather.photo, pw, ph, "photo");
			fgm = g.transientBuffer("fgm", Math.ceil(N / 32) * 4);
			// fitHazeGpu: range row y (top) = the ×step buffer's GL row H−1−y = geometry GL row
			// (H−1−y)·step, i.e. image row gh−1−(H−1−y)·step
			const tab = new Uint32Array(4 * W + 4 * H);
			for (let x = 0; x < W; x++) tab[x] = x * step;
			for (let y = 0; y < H; y++) tab[W + y] = gh - 1 - (H - 1 - y) * step;
			for (const [m, o] of [
				[sky, W + H],
				[fg, 2 * W + 2 * H],
			] as const)
				if (m) {
					for (let x = 0; x < W; x++)
						tab[o + x] = Math.min(
							m.texture.width - 1,
							Math.floor(((x + 0.5) * m.texture.width) / W),
						);
					for (let y = 0; y < H; y++)
						tab[o + W + y] = Math.min(
							m.texture.height - 1,
							Math.floor(((y + 0.5) * m.texture.height) / H),
						);
				}
			const gprm = c.uniform(
				"gather-prm",
				TEX_HAZE_PARAMS.pack({
					W,
					H,
					gh,
					flipGeo: +geo.flip,
					sky: +!!sky,
					flipSky: +!!sky?.flip,
					skyH: sky?.texture.height ?? 1,
					fg: +!!fg,
					flipFg: +!!fg?.flip,
					fgH: fg?.texture.height ?? 1,
					geoR: +(geo.texture.format === "r32float"),
				}),
			);
			const gtab = c.storage("gather-tab", tab);
			addTexNode(
				g,
				"gather",
				K_TEX_HAZE,
				{
					prm: gprm,
					tab: gtab,
					geo: importSampled(g, "geo", geo),
					skyT: importSampled(g, "sky", sky),
					range,
					psky,
				},
				groups,
			);
			addTexNode(
				g,
				"fgbits",
				K_TEX_FGBITS,
				{ prm: gprm, tab: gtab, fgT: importSampled(g, "fg", fg), fgm },
				Math.ceil(Math.ceil(N / 32) / WG),
			);
		} else {
			photo = g.importBuffer("photo", pw * ph * 4);
			fgm = g.importBuffer("fgm", Math.ceil(N / 32) * 4);
		}
		// haze-graph.ts prepGraph, node for node
		const pxScale = W / 1024;
		const rad = Math.max(1, Math.round(3 * pxScale));
		const fgRad = d.hasFg ? Math.max(2, Math.round(8 * pxScale)) : 0;
		const lo = Math.log(DMIN);
		const prm = c.uniform(
			"prep-prm",
			HAZE_PREP_PARAMS.pack({
				W,
				H,
				pw,
				rad,
				fgRad,
				lo,
				span: Math.log(DMAX) - lo,
				rmin: Math.max(150, DMIN),
				rmax: DMAX,
			}),
		);
		const lin = g.importBuffer("lin", N * 12);
		const flags = g.transientBuffer("flags", N * 4);
		const flagsH = g.transientBuffer("flagsH", N * 4);
		const bins = g.importBuffer("bins", N * 4);
		const counts = g.importBuffer("counts", NBINS * 4);
		const state = g.importBuffer("state", SEL * 8);
		const hist = g.transientBuffer("hist", SEL * BUCKETS * 4);
		g.addKernel({
			id: "prep",
			spec: K_HZ_PREP,
			bindings: {
				prm,
				photo,
				xb: c.storage("xb", footprints(W, pw)),
				yb: c.storage("yb", footprints(H, ph)),
				lut: c.storage("lut", SRGB_LUT_HAZE),
				range,
				fgm,
				lin,
				flags,
			},
			workgroups: [groups],
		});
		g.addKernel({
			id: "dilh",
			spec: K_HZ_DILH,
			bindings: { prm, flags, outf: flagsH },
			workgroups: [groups],
		});
		// the counts must start at zero (haze-graph.ts prepGraph clears them)
		g.addKernel({
			id: "zero-counts",
			spec: K_ZERO,
			bindings: { buf: counts },
			workgroups: [1],
		});
		g.addKernel({
			id: "bin",
			spec: K_HZ_BIN,
			bindings: { prm, flagsH, range, psky, bins, counts },
			workgroups: [groups],
		});
		g.addKernel({
			id: "sel-init",
			spec: K_HZ_SEL_INIT,
			bindings: { counts, state },
			workgroups: [Math.ceil(SEL / 64)],
		});
		for (let p = 0; p < 3; p++) {
			const pp = c.uniform(
				`pass${p}`,
				HAZE_PASS_PARAMS.pack({ W, H, pass_: p }),
			);
			g.addKernel({
				id: `clear${p}`,
				spec: K_ZERO,
				bindings: { buf: hist },
				workgroups: [Math.ceil((SEL * BUCKETS) / 256)],
			});
			g.addKernel({
				id: `hist${p}`,
				spec: K_HZ_HIST,
				bindings: { prm: pp, bins, lin, state, hist },
				workgroups: [groups],
			});
			g.addKernel({
				id: `scan${p}`,
				spec: scanSg ? K_HZ_SCAN_SG : K_HZ_SCAN,
				bindings: { prm: pp, hist, state },
				// one workgroup per selection (haze.ts SCAN_GROUPS)
				workgroups: [SEL],
			});
		}
		return null;
	});
}

async function runHaze(
	device: Device,
	e: { graph: ComputeGraph },
	W: number,
	H: number,
	read: boolean,
	extra: {
		buffers?: Record<string, Buffer>;
		textures?: Record<string, Texture>;
		/** write the array path's inputs into the (pooled) range / pSky slots */
		fill?: (b: HazePrepResult["buffers"]) => void;
	},
): Promise<HazePrepResult> {
	// pipelines through createComputePipelineAsync (a no-op once compiled); graph.run follows in this
	// pass lease
	await e.graph.compileAsync();
	const N = W * H;
	const sizes = {
		range: N * 4,
		pSky: N * 4,
		lin: N * 12,
		bins: N * 4,
		counts: NBINS * 4,
		state: SEL * 8,
	};
	const buffers = {} as HazePrepResult["buffers"];
	for (const [k, b] of Object.entries(sizes))
		buffers[k as keyof typeof sizes] = slot(device, "haze", k, b);
	const gen = hazePrepGen(device) + 1;
	hazeGens.set(device, gen);
	extra.fill?.(buffers);
	const names = Object.keys(sizes) as (keyof typeof sizes)[];
	const { data } = await e.graph.run(undefined, {
		buffers: { ...buffers, ...extra.buffers },
		textures: extra.textures,
		read: read ? reads(names.map((k) => [buffers[k], sizes[k]])) : [],
	});
	const r: HazePrepResult = { W, H, buffers, gen };
	if (read) {
		const st = new Uint32Array(data[5]);
		const stat = new Float32Array(SEL);
		const bits = new Uint32Array(stat.buffer);
		for (let k = 0; k < SEL; k++) bits[k] = st[2 * k];
		r.data = {
			W,
			H,
			range: new Float32Array(data[0]),
			pSky: new Float32Array(data[1]),
			lin: new Float32Array(data[2]),
			bins: new Int32Array(data[3]),
			counts: new Uint32Array(data[4]),
			stat,
		};
	}
	return r;
}

/**
 * fitHazeGpu's GPU prep from textures: geometry decimated ×step (row 0 = top), P(sky), people,
 * the photo box-resampled to linear, depth edges, dilations, log-range bins and the percentile
 * order statistics. One submit; GPU buffers out (arrays too with `read`).
 */
export function hazePrepTex(
	device: Device,
	input: HazeTexInput,
	opts: { read?: boolean } = {},
): Promise<HazePrepResult> {
	return hazePrepTexThen(
		device,
		input,
		async (r) => r,
		opts,
	) as Promise<HazePrepResult>;
}

/**
 * hazePrepTex, then `then(prep)` under the SAME haze lease: no other haze prep can overwrite (or
 * grow and retire) the prep's buffers before `then` has finished with them (haze-graph.ts
 * prepAndFitHazeTex). `valid` is re-checked inside the lease just before the submit (the caller's
 * inputs, e.g. the geometry target, may have been re-rendered while the call was queued): false
 * resolves null and submits nothing. `then` must not take the haze lease itself.
 */
export function hazePrepTexThen<T>(
	device: Device,
	input: HazeTexInput,
	then: (prep: HazePrepResult) => Promise<T>,
	opts: { read?: boolean; valid?: () => boolean } = {},
): Promise<T | null> {
	const geo = src(input.geometry);
	const photo = src(input.photo);
	const sky = input.sky ? src(input.sky) : null;
	const fg = input.fg ? src(input.fg) : null;
	check(device, geo, "geometry", GEO_FORMATS);
	check(device, photo, "photo", PHOTO_FORMATS);
	if (sky) check(device, sky, "sky", MASK_FORMATS);
	if (fg) check(device, fg, "fg", MASK_FORMATS);
	const step = input.step ?? 2;
	const W = Math.floor(geo.texture.width / step);
	const H = Math.floor(geo.texture.height / step);
	const pw = photo.texture.width;
	const ph = photo.texture.height;
	const key = [
		"haze",
		step,
		texKey(geo),
		texKey(photo),
		texKey(sky),
		texKey(fg),
	].join("|");
	return withLease(PASS.haze, async () => {
		assertAlive(device, [geo, photo, sky, fg]);
		if (opts.valid && !opts.valid()) return null;
		const e = hazeGraph(
			device,
			key,
			{ W, H, pw, ph, hasFg: !!fg },
			{ geo, photo, sky, fg, step },
		);
		// runHaze compiles the graph (async), then queues graph.run, inside this pass lease
		const prep = await runHaze(device, e, W, H, !!opts.read, {
			textures: {
				geo: geo.texture,
				"photo-tex": photo.texture,
				sky: sky?.texture ?? dummyMask(device),
				fg: fg?.texture ?? dummyMask(device),
			},
		});
		return then(prep);
	});
}

/** The same prep graph fed from CPU arrays (fitHazeGpu's inputs): the bench's array path. */
export function hazePrepArrays(
	device: Device,
	a: HazeArrays,
	opts: { read?: boolean } = {},
): Promise<HazePrepResult> {
	const { W, H } = a;
	const pw = a.photo.width;
	const ph = a.photo.height;
	const key = ["haze-arrays", W, H, pw, ph, +a.hasFg].join("|");
	return withLease(PASS.haze, () => {
		if (device.isLost) throw new Error("[lookgpu] device lost");
		const e = hazeGraph(device, key, { W, H, pw, ph, hasFg: a.hasFg }, null);
		const photo = slot(device, "haze", "photo-in", pw * ph * 4);
		photo.write(
			new Uint8Array(a.photo.data.buffer, a.photo.data.byteOffset, pw * ph * 4),
		);
		const fgm = slot(device, "haze", "fgm-in", Math.ceil((W * H) / 32) * 4);
		fgm.write(a.fgBits);
		return runHaze(device, e, W, H, !!opts.read, {
			buffers: { photo, fgm },
			fill: (b) => {
				b.range.write(a.range);
				b.pSky.write(a.pSky);
			},
		});
	});
}
