/**
 * GPU photo prep for autoAlign: align.ts buildEdgeMap (after its canvas step) and fitPriorSky on the
 * GPU, BIT-IDENTICAL to the CPU (align.ts edgeMapFromPixels / scanLabels / fitSkyModel are the
 * reference). Every align decision downstream (the GPU pose grid, the certified-bound refine, the
 * silhouette re-rank) reads these planes, so nothing short of equality is acceptable.
 *
 *   const edge = await buildEdgeMapAsync(img, 512, fg);            // same EdgeMap as buildEdgeMap
 *   const fit = await fitPriorSkyGpu(device, prior, aspect, dirs, edge); // planes fitPriorSky writes
 *
 * DESIGN. The photo still goes through the 2D canvas (align.ts photoPixels): the browser's drawImage
 * downscale defines `rgb` and so every plane, and no GPU resample reproduces Skia's filter bit for bit,
 * so skipping the canvas would change the planes (kept on the CPU; it is one drawImage + getImageData).
 * From the RGBA bytes on, one core ComputeGraph per shape does the rest with GPU-resident
 * intermediates and one readback: L/B → E → exact percentile (3-pass radix select) → normalise →
 * box blurs (coarse = r5∘r5, fine = r1) → scan labels → colour counts → P(sky) table → S → r1 blur →
 * column sums. The prior refit (autoAlignAsync) is the sky half alone, on the resident rgb / fg.
 *
 * EXACTNESS, per output. The kernels use no float type at all: binary32 planes are u32 bit patterns
 * and every binary64 value of the CPU code is a vec2<u32> handled by ./softf64.wgsl.ts, an integer
 * implementation of IEEE-754 add / sub / mul / div / division by a small integer / widening /
 * narrowing with round-to-nearest-even (subnormals included). WGSL defines u32 arithmetic exactly, so
 * there is no device-dependent rounding (no FMA contraction, flush-to-zero or fast-math can apply).
 * Each kernel performs the CPU expression's binary64 operations in the CPU's evaluation order (JS
 * fixes it: left to right, no contraction, no extended precision), so each stored value is the CPU's
 * value, then narrowed exactly as a Float32Array store narrows (nearest-even):
 *  - L, B, E (intermediates): the per-pixel expressions of edgeMapFromPixels, op for op.
 *  - p (the 97th percentile): math.ts kthSmallest returns the k-th smallest VALUE; E ≥ +0 and never NaN
 *    (a sum of max(·,0), |·| and products of them with positive constants, stored from +0), so values
 *    order like their u32 bit patterns, and a 3-digit radix select on integer counts finds that
 *    pattern exactly; `|| 1` is applied to the result.
 *  - coarse, fine (and the sky blur): boxBlur's running float64 accumulator is REPLAYED, one thread per
 *    row / column, acc = 0, ⊕ the 2r+1 clamped taps, then per pixel fround(acc ⊘ k) and
 *    acc ⊕ (a ⊖ b). Integer window sums are not enough: the CPU's accumulator may round (a window
 *    mixing values ~1 and ~1e-10 needs more than 53 bits), and when it does the CPU result depends on
 *    the rounding sequence, which the replay reproduces. (On the repo photos no accumulator step was
 *    inexact, so window sums would agree in practice, but nothing guarantees it.)
 *  - sky labels: scanLabels' tests are integer (byte differences > 40, row bounds from Math.round on
 *    the CPU) except fg > 0.3 (binary32 widened, compared with the double 0.3: integer compare of bit
 *    patterns) and the prior-row test, which plan.ts bandLimits evaluates with align.ts stopHasBand
 *    itself for every candidate stop (the kernel only tests stop ∈ [lo, hi]).
 *  - colour counts: integer atomics (order-free); the CPU's Float32Array counts are exact below 2^24.
 *  - sky (S then blur), skyCum: fitSkyModel's per-pixel P(sky) depends on the colour bin only, so the
 *    table evaluates its exact double expression once per bin; S gathers it (0.5 under fg > 0.3);
 *    the blur and the column sums replay the CPU accumulators.
 * Evidence: ./photoprep.check.ts (node) fuzzes the soft-float's JS twin against hardware doubles and
 * runs ./emulate.ts (the JS twin of every kernel) against align.ts on the repo photos, with and
 * without masks and prior rows: every element Object.is-equal.
 *
 * RUNTIME GUARD (the argument assumes a correct compiler and driver, and that the WGSL equals its JS
 * twin): per device, the first PREP_VERIFY_FIRST GPU results, then 1 in PREP_VERIFY_EVERY at random,
 * are recomputed on the CPU and compared bit for bit; any mismatch returns the CPU result and turns
 * the GPU photo prep off for that device. Always: the read-back nonce echo (the graph really ran this
 * time; transients keep older bytes) and a CPU replay of skyCum from the returned sky (cheap, exact).
 * A pipeline that fails to compile turns the path off for the device too.
 *
 * FALLBACKS: no compute device, `?gpu=off`, `photoPrepOptions.gpu = false` or `{ gpu: false }`, an
 * unsupported size, kernels still compiling (never waited for: that call takes the CPU), any GPU error
 * → the CPU code. The WebGL renderers keep calling the synchronous buildEdgeMap.
 */
import { Buffer, type Device } from "@luma.gl/core";
import {
	type EdgeMap,
	edgeMapFg,
	edgeMapFromPixels,
	type FgMask,
	fitSkyModel,
	photoPixels,
	scanLabels,
	skylineRows,
} from "#/lib/align";
import type { Pose } from "#/lib/camera";
import { getComputeDevice } from "#/lib/gpu/core/device";
import { type ComputeGraph, cachedGraph } from "#/lib/gpu/core/graph";
import {
	type BindKind,
	defineKernel,
	warmKernelsAsync,
} from "#/lib/gpu/core/kernel";
import { acquire, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import * as K from "./kernels.wgsl";
import { bandLimits, photoPrepDims, photoPrepSupported } from "./plan";

/** core/kernel warm-up group, pool owner and cachedGraph group of this module. */
export const PHOTOPREP_GROUP = "photoprep";

const ro: BindKind = "read-only-storage";
const rw: BindKind = "storage";
const un: BindKind = "uniform";
const def = (id: string, source: string, layout: [string, BindKind][]) =>
	defineKernel(`photoprep-${id}`, source, layout, {
		group: PHOTOPREP_GROUP,
		label: `photoprep-${id}`,
	});

const LUMAB = def("lumab", K.LUMAB_WGSL, [
	["dims", un],
	["rgba", ro],
	["lum", rw],
	["blu", rw],
]);
const EDGE = def("edge", K.EDGE_WGSL, [
	["dims", un],
	["lum", ro],
	["blu", ro],
	["edge", rw],
]);
const HIST0 = def("hist0", K.histWgsl(0), [
	["dims", un],
	["edge", ro],
	["hist", rw],
]);
const HIST1 = def("hist1", K.histWgsl(1), [
	["dims", un],
	["edge", ro],
	["sel", ro],
	["hist", rw],
]);
const HIST2 = def("hist2", K.histWgsl(2), [
	["dims", un],
	["edge", ro],
	["sel", ro],
	["hist", rw],
]);
const selLayout: [string, BindKind][] = [
	["dims", un],
	["hist", ro],
	["sel", rw],
];
const SELECT0 = def("select0", K.selectWgsl(0), selLayout);
const SELECT1 = def("select1", K.selectWgsl(1), selLayout);
const SELECT2 = def("select2", K.selectWgsl(2), selLayout);
const NORM = def("norm", K.NORM_WGSL, [
	["dims", un],
	["edge", ro],
	["fg", ro],
	["sel", ro],
	["en", rw],
]);
const blurLayout: [string, BindKind][] = [
	["dims", un],
	["src", ro],
	["dst", rw],
];
const ROW5 = def("row5", K.blurRowWgsl(5), blurLayout);
const COL5 = def("col5", K.blurColWgsl(5), blurLayout);
const ROW1 = def("row1", K.blurRowWgsl(1), blurLayout);
const COL1 = def("col1", K.blurColWgsl(1), blurLayout);
const SCAN = def("scan", K.SCAN_WGSL, [
	["dims", un],
	["rgba", ro],
	["fg", ro],
	["lim", ro],
	["lbl", rw],
]);
const SKY_HIST = def("sky-hist", K.SKY_HIST_WGSL, [
	["dims", un],
	["rgba", ro],
	["fg", ro],
	["lbl", ro],
	["sh", rw],
]);
const SKY_TABLE = def("sky-table", K.SKY_TABLE_WGSL, [
	["sh", ro],
	["table", rw],
]);
const SKY_GATHER = def("sky-gather", K.SKY_GATHER_WGSL, [
	["dims", un],
	["rgba", ro],
	["fg", ro],
	["table", ro],
	["sp", rw],
]);
const SKY_CUM = def("sky-cum", K.SKY_CUM_WGSL, [
	["dims", un],
	["sky", ro],
	["cum", rw],
	["echo", rw],
]);

const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const cdiv = (a: number, b: number) => Math.ceil(a / b);

/** Process-wide default (A/B harnesses; not a src/lib/flags flag): false = always the CPU code. */
export const photoPrepOptions: { gpu: boolean } = { gpu: true };
export type PhotoPrepOptions = { gpu?: boolean };

/** Per-device verification state (see the header). */
export const PREP_VERIFY_FIRST = 3;
export const PREP_VERIFY_EVERY = 32;
type PrepState = {
	/** results verified so far, per graph (each gets its own first PREP_VERIFY_FIRST) */
	checked: { edge: number; sky: number };
	disabled: boolean;
	reason?: string;
	/** pipelines compiled (warmKernelsAsync resolved without failures) */
	ready: boolean;
	warming?: Promise<void>;
};
const states = new WeakMap<Device, PrepState>();
const stateOf = (device: Device) => {
	let st = states.get(device);
	if (!st) {
		st = { checked: { edge: 0, sky: 0 }, disabled: false, ready: false };
		states.set(device, st);
	}
	return st;
};
/** True once a mismatch or a compile failure turned the GPU photo prep off for `device`. */
export const gpuPhotoPrepDisabled = (device: Device) =>
	states.get(device)?.disabled ?? false;
/** Forget `device`'s verification state (tests). */
export const resetGpuPhotoPrep = (device: Device) => {
	states.delete(device);
};
const disable = (st: PrepState, reason: string) => {
	st.disabled = true;
	st.reason = reason;
	console.warn(`[gpu] photo prep off for this device: ${reason}`);
};
const shouldVerify = (st: PrepState, kind: "edge" | "sky") => {
	if (st.checked[kind] < PREP_VERIFY_FIRST) {
		st.checked[kind]++;
		return true;
	}
	return Math.random() < 1 / PREP_VERIFY_EVERY;
};

/** Compile the kernels for `device` (once; async pipelines, never blocks). */
function warm(device: Device, st: PrepState) {
	st.warming ??= warmKernelsAsync(device, PHOTOPREP_GROUP).then(
		(failed) => {
			if (failed) disable(st, `${failed} kernel(s) failed to compile`);
			else st.ready = true;
		},
		(e) => disable(st, `warm-up failed: ${e}`),
	);
	return st.warming;
}

/** Start compiling the photo-prep kernels on the compute device (call early in a photo load). */
export async function warmPhotoPrep() {
	try {
		const device = await getComputeDevice();
		if (device) await warm(device, stateOf(device));
	} catch {}
}

export type PhotoPrepTiming = {
	/** which code produced the result */
	path: "gpu" | "cpu";
	/** why the CPU ran (no device, warming, disabled, unsupported, error, mismatch, option) */
	reason?: string;
	/** whole call incl. the canvas step, ms */
	totalMs: number;
	/** GPU upload + graph + readback, ms */
	gpuMs?: number;
	/** this call was re-computed on the CPU and compared */
	verified?: boolean;
};
/** Timing of the last buildEdgeMapAsync (benchmarks, engine stats). */
export let lastPhotoPrepTiming: PhotoPrepTiming | null = null;

// pooled slot → the host array last written into it (rgb / fg never change after the edge map is
// built, so the prior refit reuses them without an upload)
const resident = new WeakMap<Buffer, ArrayBufferView>();
function uploadOnce(device: Device, key: string, data: ArrayBufferView) {
	const b = acquire(device, key, Math.max(16, data.byteLength), STORAGE);
	if (resident.get(b) !== data) {
		b.write(data);
		resident.set(b, data);
	}
	return b;
}

let nonceSeq = 0;
const nextNonce = () => {
	nonceSeq = (nonceSeq % 0x7fffffff) + 1;
	return nonceSeq;
};

type Inputs = { dims: Buffer; rgba: Buffer; fg: Buffer; lim: Buffer };
type G = ComputeGraph<undefined>;
type H = ReturnType<G["importBuffer"]>;

function importInputs(g: G, b: Inputs) {
	return {
		dims: g.importBuffer("dims", b.dims.byteLength, undefined, UNIFORM),
		rgba: g.importBuffer("rgba", b.rgba.byteLength, undefined, STORAGE),
		fg: g.importBuffer("fg", b.fg.byteLength, undefined, STORAGE),
		lim: g.importBuffer("lim", b.lim.byteLength, undefined, STORAGE),
	};
}

/** The sky half (scanLabels + fitSkyModel): labels → counts → table → S → blur r1 → column sums. */
function skyNodes(
	g: G,
	i: ReturnType<typeof importInputs>,
	w: number,
	h: number,
) {
	const n = w * h;
	const { dims, rgba, fg, lim } = i;
	const lbl = g.transientBuffer("lbl", n * 4, STORAGE);
	const sh = g.transientBuffer("sky-counts", K.SKY_HIST_WORDS * 4, STORAGE);
	const table = g.transientBuffer("sky-table", K.NBINS * 4, STORAGE);
	const sp = g.transientBuffer("sky-s", n * 4, STORAGE);
	const sRow = g.transientBuffer("sky-row", n * 4, STORAGE);
	const sky = g.transientBuffer("sky", n * 4, STORAGE);
	const cum = g.transientBuffer("sky-cum", w * (h + 1) * 4, STORAGE);
	const echo = g.transientBuffer("echo", 16, STORAGE);
	g.addKernel({
		id: "scan",
		spec: SCAN,
		bindings: { dims, rgba, fg, lim, lbl },
		workgroups: [cdiv(w, K.WG)],
	});
	g.clearNode("clear-sky-counts", sh);
	g.addKernel({
		id: "sky-hist",
		spec: SKY_HIST,
		bindings: { dims, rgba, fg, lbl, sh },
		workgroups: [K.HIST_WG],
		writes: { sh: "atomic" },
	});
	g.addKernel({
		id: "sky-table",
		spec: SKY_TABLE,
		bindings: { sh, table },
		workgroups: [cdiv(K.NBINS, K.WG)],
	});
	g.addKernel({
		id: "sky-gather",
		spec: SKY_GATHER,
		bindings: { dims, rgba, fg, table, sp },
		workgroups: [cdiv(n, K.WG)],
	});
	g.addKernel({
		id: "sky-row",
		spec: ROW1,
		bindings: { dims, src: sp, dst: sRow },
		workgroups: [cdiv(h, K.WG)],
	});
	g.addKernel({
		id: "sky-col",
		spec: COL1,
		bindings: { dims, src: sRow, dst: sky },
		workgroups: [cdiv(w, K.WG)],
	});
	g.addKernel({
		id: "sky-cum",
		spec: SKY_CUM,
		bindings: { dims, sky, cum, echo },
		workgroups: [cdiv(w, K.WG)],
	});
	return { sky, cum, echo };
}

/** The whole edge map: imports → [coarse, fine, sky, skyCum, sel, echo] through one read node. */
function buildEdgeGraph(g: G, b: Inputs, w: number, h: number) {
	const n = w * h;
	const i = importInputs(g, b);
	const { dims, rgba, fg } = i;
	const t = (id: string, bytes: number) =>
		g.transientBuffer(id, bytes, STORAGE);
	const lum = t("lum", n * 4);
	const blu = t("blu", n * 4);
	const edge = t("edge", n * 4);
	const hist = [0, 1, 2].map((p) => t(`hist${p}`, K.RADIX_BINS * 4));
	const sel = t("sel", 16);
	const en = t("en", n * 4);
	g.addKernel({
		id: "lumab",
		spec: LUMAB,
		bindings: { dims, rgba, lum, blu },
		workgroups: [cdiv(n, K.WG)],
	});
	g.addKernel({
		id: "edge",
		spec: EDGE,
		bindings: { dims, lum, blu, edge },
		workgroups: [cdiv(n, K.WG)],
	});
	const specs = [
		[HIST0, SELECT0],
		[HIST1, SELECT1],
		[HIST2, SELECT2],
	] as const;
	specs.forEach(([hs, ss], p) => {
		g.clearNode(`clear-hist${p}`, hist[p]);
		g.addKernel({
			id: `hist${p}`,
			spec: hs,
			bindings:
				p === 0
					? { dims, edge, hist: hist[p] }
					: { dims, edge, sel, hist: hist[p] },
			workgroups: [K.HIST_WG],
			writes: { hist: "atomic" },
		});
		// every select writes all four words of sel (later passes from the earlier ones' values)
		g.addKernel({
			id: `select${p}`,
			spec: ss,
			bindings: { dims, hist: hist[p], sel },
			workgroups: [1],
		});
	});
	g.addKernel({
		id: "norm",
		spec: NORM,
		bindings: { dims, edge, fg, sel, en },
		workgroups: [cdiv(n, K.WG)],
	});
	const pass = (id: string, spec: typeof ROW1, src: H, dst: H, rows: boolean) =>
		g.addKernel({
			id,
			spec,
			bindings: { dims, src, dst },
			workgroups: [cdiv(rows ? h : w, K.WG)],
		});
	const c1 = t("coarse-row1", n * 4);
	const c2 = t("coarse-col1", n * 4);
	const c3 = t("coarse-row2", n * 4);
	const coarse = t("coarse", n * 4);
	const f1 = t("fine-row", n * 4);
	const fine = t("fine", n * 4);
	pass("coarse-row1", ROW5, en, c1, true);
	pass("coarse-col1", COL5, c1, c2, false);
	pass("coarse-row2", ROW5, c2, c3, true);
	pass("coarse-col2", COL5, c3, coarse, false);
	pass("fine-row", ROW1, en, f1, true);
	pass("fine-col", COL1, f1, fine, false);
	const s = skyNodes(g, i, w, h);
	g.readNode("read", [coarse, fine, s.sky, s.cum, sel, s.echo]);
}

/** The sky half alone (fitPriorSky): imports → [sky, skyCum, echo]. */
function buildSkyGraph(g: G, b: Inputs, w: number, h: number) {
	const s = skyNodes(g, importInputs(g, b), w, h);
	g.readNode("read", [s.sky, s.cum, s.echo]);
}

/** Run the graph of `kind` for (w, h) on `inputs` under the photoprep lease; resolves its read slots. */
async function runGraph(
	device: Device,
	kind: "edge" | "sky",
	w: number,
	h: number,
	inputs: Inputs,
): Promise<ArrayBuffer[]> {
	let key = `${kind},${w}x${h}`;
	for (const [k, buf] of Object.entries(inputs))
		key += `,${k}${buf.byteLength}`;
	const { graph } = cachedGraph<undefined>(
		device,
		PHOTOPREP_GROUP,
		key,
		(g) => {
			if (kind === "edge") buildEdgeGraph(g, inputs, w, h);
			else buildSkyGraph(g, inputs, w, h);
			return undefined;
		},
	);
	if (!graph.isCompiled) await graph.compileAsync();
	const { reads } = await graph.run(undefined, { buffers: inputs });
	const out = reads.read;
	if (!out) throw new Error(`${graph.id}: read node did not run`);
	return out;
}

/** The pooled inputs of a run (rgb / fg uploaded only when the slot holds other arrays). */
function inputsFor(
	device: Device,
	w: number,
	h: number,
	rgb: Uint8ClampedArray,
	fg: Float32Array,
	lim: Int32Array,
	nonce: number,
): Inputs {
	return {
		dims: pooledUniform(device, "photoprep/dims", photoPrepDims(w, h, nonce)),
		rgba: uploadOnce(device, "photoprep/rgba", rgb),
		fg: uploadOnce(device, "photoprep/fg", fg),
		lim: uploadOnce(device, "photoprep/lim", lim),
	};
}

const f32 = (b: ArrayBuffer, n: number) => new Float32Array(b, 0, n);

/** Always-on checks of a read-back result: the nonce echo, then skyCum replayed from sky (exact). */
function checkReadback(
	echo: Uint32Array,
	nonce: number,
	sky: Float32Array,
	skyCum: Float32Array,
	w: number,
	h: number,
) {
	if (echo[0] !== nonce) return `stale read-back (echo ${echo[0]} ≠ ${nonce})`;
	for (let x = 0; x < w; x++) {
		let acc = 0;
		if (!Object.is(skyCum[x], 0)) return "skyCum row 0";
		for (let y = 0; y < h; y++) {
			acc += sky[y * w + x];
			if (!Object.is(skyCum[(y + 1) * w + x], Math.fround(acc)))
				return `skyCum column ${x}`;
		}
	}
	return "";
}

/** Object.is on every element of the edge-map planes the GPU produces. */
function samePlanes(a: EdgeMap, b: EdgeMap, keys: readonly (keyof EdgeMap)[]) {
	for (const k of keys) {
		const x = a[k] as Float32Array;
		const y = b[k] as Float32Array;
		if (x.length !== y.length) return `${k} length`;
		for (let i = 0; i < x.length; i++)
			if (!Object.is(x[i], y[i])) return `${k}[${i}]: cpu ${x[i]} gpu ${y[i]}`;
	}
	return "";
}

/**
 * edgeMapFromPixels on the GPU: resolves the EdgeMap, or null when the GPU path cannot run now (the
 * caller then runs the CPU code). Throws on GPU errors. `rgb` must not be modified afterwards (it
 * becomes the map's `rgb` and stays resident on the device for the prior refit), nor `fg`.
 */
async function edgeMapGpu(
	device: Device,
	rgb: Uint8ClampedArray,
	w: number,
	h: number,
	fg: Float32Array,
): Promise<EdgeMap> {
	const n = w * h;
	const lim = bandLimits(w, h);
	const nonce = nextNonce();
	const out = await withLease(PHOTOPREP_GROUP, () =>
		runGraph(
			device,
			"edge",
			w,
			h,
			inputsFor(device, w, h, rgb, fg, lim, nonce),
		),
	);
	const [coarse, fine, sky, cum, sel, echo] = out;
	const map: EdgeMap = {
		w,
		h,
		coarse: f32(coarse, n),
		fine: f32(fine, n),
		sky: f32(sky, n),
		skyCum: f32(cum, w * (h + 1)),
		rgb,
		fg,
	};
	// select2 echoes the nonce too: the percentile chain ran in this run as well as the sky chain
	const s3 = new Uint32Array(sel, 0, 4)[3];
	const bad =
		s3 !== nonce
			? `stale percentile (echo ${s3} ≠ ${nonce})`
			: checkReadback(
					new Uint32Array(echo, 0, 4),
					nonce,
					map.sky,
					map.skyCum,
					w,
					h,
				);
	if (bad) throw new Error(`photoprep: ${bad}`);
	return map;
}

/**
 * buildEdgeMap with everything after the canvas on the GPU (see the header). Same EdgeMap, bit for
 * bit; the CPU code whenever the GPU path is unavailable, still compiling, fails or mismatches.
 */
export async function buildEdgeMapAsync(
	img: HTMLImageElement | ImageBitmap,
	width = 512,
	fgMask?: FgMask | null,
	opts: PhotoPrepOptions = {},
): Promise<EdgeMap> {
	const t0 = performance.now();
	const { d, w, h } = photoPixels(img, width);
	const fg = edgeMapFg(w, h, fgMask);
	const cpu = (reason: string) => {
		const map = edgeMapFromPixels(d, w, h, fg);
		lastPhotoPrepTiming = {
			path: "cpu",
			reason,
			totalMs: performance.now() - t0,
		};
		return map;
	};
	if (!(opts.gpu ?? photoPrepOptions.gpu)) return cpu("option");
	if (!photoPrepSupported(w, h)) return cpu("unsupported size");
	let device: Device | null = null;
	try {
		device = await getComputeDevice();
	} catch {}
	if (!device) return cpu("no device");
	const st = stateOf(device);
	void warm(device, st);
	if (st.disabled) return cpu(`disabled: ${st.reason}`);
	if (!st.ready) return cpu("warming");
	const tg = performance.now();
	let map: EdgeMap;
	try {
		map = await edgeMapGpu(device, new Uint8ClampedArray(d), w, h, fg);
	} catch (e) {
		console.warn("[gpu] photo prep failed, using the CPU", e);
		return cpu(`error: ${e}`);
	}
	const gpuMs = performance.now() - tg;
	let verified = false;
	if (shouldVerify(st, "edge")) {
		verified = true;
		const ref = edgeMapFromPixels(d, w, h, fg);
		const bad = samePlanes(ref, map, ["coarse", "fine", "sky", "skyCum"]);
		if (bad) {
			disable(st, `edge map mismatch (${bad})`);
			lastPhotoPrepTiming = {
				path: "cpu",
				reason: "mismatch",
				totalMs: performance.now() - t0,
				gpuMs,
				verified,
			};
			return ref;
		}
	}
	lastPhotoPrepTiming = {
		path: "gpu",
		totalMs: performance.now() - t0,
		gpuMs,
		verified,
	};
	return map;
}

/**
 * The sky planes fitPriorSky(prior, aspect, dirs, edge) would write, computed on the GPU without
 * touching `edge`: `sky` (a new array; fitSkyModel replaces edge.sky) and `skyCum` (fitSkyModel
 * rewrites edge.skyCum in place: copy it in). Resolves null when the GPU path cannot run now (the
 * caller runs fitPriorSky); never rejects. Verified like buildEdgeMapAsync (shared device state).
 */
export async function fitPriorSkyGpu(
	device: Device,
	prior: Pose,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	opts: PhotoPrepOptions = {},
): Promise<{ sky: Float32Array; skyCum: Float32Array } | null> {
	const { w, h } = edge;
	if (!(opts.gpu ?? photoPrepOptions.gpu) || !photoPrepSupported(w, h))
		return null;
	const st = stateOf(device);
	void warm(device, st);
	if (st.disabled || !st.ready) return null;
	const rows = skylineRows(prior, aspect, dirs, edge);
	let planes: { sky: Float32Array; skyCum: Float32Array };
	try {
		const lim = bandLimits(w, h, rows);
		const nonce = nextNonce();
		const [sky, cum, echo] = await withLease(PHOTOPREP_GROUP, () =>
			runGraph(
				device,
				"sky",
				w,
				h,
				inputsFor(device, w, h, edge.rgb, edge.fg, lim, nonce),
			),
		);
		planes = { sky: f32(sky, w * h), skyCum: f32(cum, w * (h + 1)) };
		const bad = checkReadback(
			new Uint32Array(echo, 0, 4),
			nonce,
			planes.sky,
			planes.skyCum,
			w,
			h,
		);
		if (bad) throw new Error(`photoprep: ${bad}`);
	} catch (e) {
		console.warn("[gpu] prior sky fit failed, using the CPU", e);
		return null;
	}
	if (shouldVerify(st, "sky")) {
		const ref: EdgeMap = {
			...edge,
			skyCum: new Float32Array(edge.skyCum.length),
		};
		fitSkyModel(ref, scanLabels(ref, rows));
		const bad = samePlanes(
			ref,
			{ ...edge, sky: planes.sky, skyCum: planes.skyCum },
			["sky", "skyCum"],
		);
		if (bad) {
			disable(st, `prior sky mismatch (${bad})`);
			return { sky: ref.sky, skyCum: ref.skyCum };
		}
	}
	return planes;
}
