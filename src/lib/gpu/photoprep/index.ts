// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * GPU photo prep for autoAlign: align.ts buildEdgeMap (after its canvas step) and fitPriorSky on the
 * GPU, BIT-IDENTICAL to the CPU (align.ts edgeMapFromPixels / scanLabels / fitSkyModel are the
 * reference). Every align decision downstream (the GPU pose grid, the certified-bound refine, the
 * silhouette re-rank) reads these planes, so nothing short of equality is acceptable.
 *
 *   const prep = await buildPhotoPrepAsync(img, 512, fg);          // planes resident on the device
 *   const edge = await prep.cpu();                                  // same EdgeMap as buildEdgeMap (lazy read)
 *   const edge = await buildEdgeMapAsync(img, 512, fg);            // the two lines above in one
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
 * RESIDENCY (WAG W1.1, ./resident.ts). The four output planes (coarse, fine, sky, skyCum) and the fg
 * input are buffers OWNED by the returned PhotoPrep, not graph transients, so they outlive the run:
 * gpu/align binds coarse / fine / fg directly (pinResidentPlanes) instead of uploading the CPU arrays
 * again, and fitPriorSkyGpu binds fg. The run itself reads back only the two 16-byte nonce echoes; the
 * ≈ 3.5 MB of planes come back on the first prep.cpu() (memoized; prep.cpuSync() computes the CPU
 * reference instead when a synchronous consumer asks first: same planes). The CPU consumers of the
 * planes (align.ts autoAlign's exact re-scoring and refine, the silhouette re-rank's coarse / fg
 * lookups, the picker's scorePose, the matcher's skyline export) all go through that one EdgeMap.
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
 *    pattern exactly; `|| 1` is applied to the result. The digit histograms are luma GPUHistogram
 *    (kernels.wgsl.ts explains why its equal-width binning of u32 keys is the digit exactly).
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
 *  - colour counts: a luma GPUGroupAggregation count over a key column (integer atomics, order-free);
 *    the CPU's Float32Array counts are exact below 2^24.
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
 * With residency: the nonce echoes are read with the run (eagerly, 32 B); the device's first
 * PREP_VERIFY_FIRST results are still read and compared eagerly (they qualify the device before any
 * plane is bound unread); the sampled comparisons and the skyCum replay run on the lazy read, out of
 * band (a prep whose planes are never read is not sampled). A failed lazy read withdraws the prep's
 * planes from residency, falls back to the CPU reference, and (on a mismatch) turns the device off.
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
import { type ComputeGraph, cachedGraph } from "#/lib/gpu/core/graph";
import {
	type BindKind,
	defineKernel,
	warmKernelsAsync,
} from "#/lib/gpu/core/kernel";
import { GPUGroupAggregation, GPUHistogram } from "#/lib/gpu/core/luma";
import { acquire, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import { readBack } from "#/lib/gpu/core/readback";
import { getComputeDevice } from "#/lib/gpu/device";
import * as K from "./kernels.wgsl";
import { bandLimits, photoPrepDims, photoPrepSupported } from "./plan";
import {
	PhotoPrep,
	type PinnedPlanes,
	pinResidentPlanes as pinPlanes,
	type ResidentPlanes,
	retireResident,
} from "./resident";

export { PhotoPrep, prepOf } from "./resident";
/** The prep buildPhotoPrepAsync resolves. */
export type GpuPhotoPrep = PhotoPrep<Device, Buffer>;

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
const keyLayout: [string, BindKind][] = [
	["dims", un],
	["edge", ro],
	["sel", ro],
	["keys", rw],
];
const KEY1 = def("key1", K.radixKeyWgsl(1), keyLayout);
const KEY2 = def("key2", K.radixKeyWgsl(2), keyLayout);
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
const SKY_KEY = def("sky-key", K.SKY_KEY_WGSL, [
	["dims", un],
	["rgba", ro],
	["fg", ro],
	["lbl", ro],
	["keys", rw],
]);
const SKY_TOTALS = def("sky-totals", K.SKY_TOTALS_WGSL, [["sh", rw]]);
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
	device: Device;
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
		st = {
			device,
			checked: { edge: 0, sky: 0 },
			disabled: false,
			ready: false,
		};
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
	// unread resident planes of this device are no longer trusted: their preps read the CPU reference
	retireResident(st.device);
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
	/** GPU path: the planes stayed on the device (the CPU map is read on first use) */
	resident?: boolean;
	/** GPU path: the CPU comparison was deferred to the lazy read (sampled, out of band) */
	verifyOnRead?: boolean;
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
/** The edge graph's inputs plus its outputs, the prep's own (resident) buffers. */
type EdgeInputs = Inputs & {
	coarse: Buffer;
	fine: Buffer;
	sky: Buffer;
	skyCum: Buffer;
};
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

/**
 * The sky half (scanLabels + fitSkyModel): labels → counts → table → S → blur r1 → column sums, into
 * `out` (imports) when given, else into transients.
 */
function skyNodes(
	g: G,
	i: ReturnType<typeof importInputs>,
	w: number,
	h: number,
	out?: { sky: H; cum: H },
) {
	const n = w * h;
	const { dims, rgba, fg, lim } = i;
	const lbl = g.transientBuffer("lbl", n * 4, STORAGE);
	const sh = g.transientBuffer("sky-counts", K.SKY_HIST_WORDS * 4, STORAGE);
	const table = g.transientBuffer("sky-table", K.NBINS * 4, STORAGE);
	const sp = g.transientBuffer("sky-s", n * 4, STORAGE);
	const sRow = g.transientBuffer("sky-row", n * 4, STORAGE);
	const sky = out?.sky ?? g.transientBuffer("sky", n * 4, STORAGE);
	const cum =
		out?.cum ?? g.transientBuffer("sky-cum", w * (h + 1) * 4, STORAGE);
	const echo = g.transientBuffer("echo", 16, STORAGE);
	g.addKernel({
		id: "scan",
		spec: SCAN,
		bindings: { dims, rgba, fg, lim, lbl },
		workgroups: [cdiv(w, K.WG)],
	});
	// the colour counts: keys → luma GPUGroupAggregation count (hs, ht = words 0..3455; it clears them),
	// then the two totals ns, nt (words 3456, 3457), so every word of `sh` is written each run
	const skyKeys = g.transientBuffer("sky-keys", n * 4, STORAGE);
	g.addKernel({
		id: "sky-key",
		spec: SKY_KEY,
		bindings: { dims, rgba, fg, lbl, keys: skyKeys },
		workgroups: [cdiv(n, K.WG)],
	});
	g.add(
		new GPUGroupAggregation({
			id: "sky-hist",
			keys: g.view(skyKeys, "uint32", n),
			output: g.view(sh, "uint32", K.SKY_KEY_COUNT),
		}),
	);
	g.addKernel({
		id: "sky-totals",
		spec: SKY_TOTALS,
		bindings: { sh },
		workgroups: [1],
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

/**
 * The whole edge map: imports → the output imports coarse, fine, sky, skyCum (the prep's resident
 * buffers, read lazily) and [sel, echo] (the nonce echoes) through one read node.
 */
function buildEdgeGraph(g: G, b: EdgeInputs, w: number, h: number) {
	const n = w * h;
	const i = importInputs(g, b);
	const out = (id: keyof EdgeInputs) =>
		g.importBuffer(id, b[id].byteLength, undefined, STORAGE);
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
	// radix select: pass 0 is a luma GPUHistogram over the edge bits themselves; passes 1 and 2 over a key
	// column (the digit of the elements matching sel's prefix, else KEY_NONE). Every histogram clears its
	// own output, so no clear nodes; every select writes all four words of sel (later passes from the
	// earlier ones' values)
	const selects = [SELECT0, SELECT1, SELECT2] as const;
	const keyKernels = [null, KEY1, KEY2] as const;
	for (const pass of [0, 1, 2] as const) {
		const bins = K.radixBins(pass);
		const keys = keyKernels[pass] ? t(`keys${pass}`, n * 4) : null;
		const spec = keyKernels[pass];
		if (spec && keys)
			g.addKernel({
				id: `key${pass}`,
				spec,
				bindings: { dims, edge, sel, keys },
				workgroups: [cdiv(n, K.WG)],
			});
		g.add(
			new GPUHistogram({
				id: `hist${pass}`,
				input: g.view(keys ?? edge, "uint32", n),
				domain: keys ? [0, bins] : [0, 0xffffffff],
				output: g.view(hist[pass], "uint32", bins),
			}),
		);
		g.addKernel({
			id: `select${pass}`,
			spec: selects[pass],
			bindings: { dims, hist: hist[pass], sel },
			workgroups: [1],
		});
	}
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
	const coarse = out("coarse");
	const f1 = t("fine-row", n * 4);
	const fine = out("fine");
	pass("coarse-row1", ROW5, en, c1, true);
	pass("coarse-col1", COL5, c1, c2, false);
	pass("coarse-row2", ROW5, c2, c3, true);
	pass("coarse-col2", COL5, c3, coarse, false);
	pass("fine-row", ROW1, en, f1, true);
	pass("fine-col", COL1, f1, fine, false);
	const s = skyNodes(g, i, w, h, { sky: out("sky"), cum: out("skyCum") });
	g.readNode("read", [sel, s.echo]);
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
	inputs: Inputs | EdgeInputs,
): Promise<ArrayBuffer[]> {
	let key = `${kind},${w}x${h}`;
	for (const [k, buf] of Object.entries(inputs))
		key += `,${k}${buf.byteLength}`;
	const { graph } = cachedGraph<undefined>(
		device,
		PHOTOPREP_GROUP,
		key,
		(g) => {
			if (kind === "edge") buildEdgeGraph(g, inputs as EdgeInputs, w, h);
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
	fgBuffer?: Buffer,
): Inputs {
	return {
		dims: pooledUniform(device, "photoprep/dims", photoPrepDims(w, h, nonce)),
		rgba: uploadOnce(device, "photoprep/rgba", rgb),
		fg: fgBuffer ?? uploadOnce(device, "photoprep/fg", fg),
		lim: uploadOnce(device, "photoprep/lim", lim),
	};
}

const f32 = (b: ArrayBuffer, n: number) => new Float32Array(b, 0, n);

/** The nonce echo of a read-back sky run, then replaySkyCum. */
function checkReadback(
	echo: Uint32Array,
	nonce: number,
	sky: Float32Array,
	skyCum: Float32Array,
	w: number,
	h: number,
) {
	if (echo[0] !== nonce) return `stale read-back (echo ${echo[0]} ≠ ${nonce})`;
	return replaySkyCum(sky, skyCum, w, h);
}

/** Always-on check of read-back sky planes: skyCum replayed from sky (exact). */
function replaySkyCum(
	sky: Float32Array,
	skyCum: Float32Array,
	w: number,
	h: number,
) {
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

/** The prep's own buffers: the four outputs and the fg input (written here, once). Exported for scripts/gpu/photoprep-hist-dawn.ts. */
export function allocPlanes(
	device: Device,
	w: number,
	h: number,
	fg: Float32Array,
): ResidentPlanes<Buffer> {
	const n = w * h;
	const made: Buffer[] = [];
	const buf = (id: string, bytes: number) => {
		const b = device.createBuffer({
			id: `photoprep:${id}`,
			usage: STORAGE,
			byteLength: Math.max(16, bytes),
		});
		made.push(b);
		return b;
	};
	try {
		const planes = {
			coarse: buf("coarse", n * 4),
			fine: buf("fine", n * 4),
			fg: buf("fg", n * 4),
			sky: buf("sky", n * 4),
			skyCum: buf("skyCum", w * (h + 1) * 4),
		};
		planes.fg.write(fg);
		return planes;
	} catch (e) {
		for (const b of made) b.destroy();
		throw e;
	}
}

/**
 * The edge graph into `planes` (the prep's buffers): resolves once the run's nonce echoes are back
 * (the percentile chain and the sky chain both ran this time). Throws on GPU errors or a stale echo.
 * Exported for scripts/gpu/photoprep-hist-dawn.ts.
 */
export async function runEdgeGpu(
	device: Device,
	rgb: Uint8ClampedArray,
	w: number,
	h: number,
	fg: Float32Array,
	planes: ResidentPlanes<Buffer>,
): Promise<void> {
	const lim = bandLimits(w, h);
	const nonce = nextNonce();
	const [sel, echo] = await withLease(PHOTOPREP_GROUP, () =>
		runGraph(device, "edge", w, h, {
			...inputsFor(device, w, h, rgb, fg, lim, nonce, planes.fg),
			coarse: planes.coarse,
			fine: planes.fine,
			sky: planes.sky,
			skyCum: planes.skyCum,
		}),
	);
	// select2 echoes the nonce too: the percentile chain ran in this run as well as the sky chain
	const s3 = new Uint32Array(sel, 0, 4)[3];
	const e0 = new Uint32Array(echo, 0, 4)[0];
	if (s3 !== nonce)
		throw new Error(`photoprep: stale percentile (echo ${s3} ≠ ${nonce})`);
	if (e0 !== nonce)
		throw new Error(`photoprep: stale read-back (echo ${e0} ≠ ${nonce})`);
}

/**
 * The lazy read of a GPU prep: the four planes back into an EdgeMap (rgb / fg = the prep's arrays),
 * the skyCum replay, and, when `reference` is given, the bit-for-bit comparison with the CPU (a
 * mismatch turns the device off). Throws on any failure (the prep then takes the CPU reference).
 */
async function readPlanes(
	device: Device,
	p: ResidentPlanes<Buffer>,
	w: number,
	h: number,
	rgb: Uint8ClampedArray,
	fg: Float32Array,
	reference: (() => EdgeMap) | null,
	st: PrepState,
): Promise<EdgeMap> {
	const n = w * h;
	const [coarse, fine, sky, cum] = await readBack(
		device,
		() => [
			{ buffer: p.coarse, size: n * 4 },
			{ buffer: p.fine, size: n * 4 },
			{ buffer: p.sky, size: n * 4 },
			{ buffer: p.skyCum, size: w * (h + 1) * 4 },
		],
		undefined,
		{ id: "photoprep-read" },
	);
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
	// the device was turned off while the read was in flight: its planes are no longer trusted
	if (st.disabled) throw new Error(`photoprep: device disabled (${st.reason})`);
	const bad = replaySkyCum(map.sky, map.skyCum, w, h);
	if (bad) throw new Error(`photoprep: ${bad}`);
	if (reference) {
		const diff = samePlanes(reference(), map, [
			"coarse",
			"fine",
			"sky",
			"skyCum",
		]);
		if (diff) {
			disable(st, `edge map mismatch (${diff})`);
			throw new Error(`photoprep: edge map mismatch (${diff})`);
		}
	}
	return map;
}

/**
 * buildEdgeMap with everything after the canvas on the GPU, as a PhotoPrep (see the header and
 * ./resident.ts): on the GPU path the planes stay on the device and `prep.cpu()` reads them on first
 * use; on the CPU path (no device, `?gpu=off`, option, unsupported size, warming, disabled, error,
 * mismatch) the map is computed now, exactly as before. Either way `prep.cpu()` resolves the same
 * EdgeMap as buildEdgeMap, bit for bit.
 */
export async function buildPhotoPrepAsync(
	img: HTMLImageElement | ImageBitmap,
	width = 512,
	fgMask?: FgMask | null,
	opts: PhotoPrepOptions = {},
): Promise<PhotoPrep<Device, Buffer>> {
	const t0 = performance.now();
	const { d, w, h } = photoPixels(img, width);
	const fg = edgeMapFg(w, h, fgMask);
	// the map's rgb (buildEdgeMap copies the canvas bytes too); stays resident in "photoprep/rgba"
	const rgb = new Uint8ClampedArray(d);
	const compute = () => {
		const map = edgeMapFromPixels(rgb, w, h, fg);
		map.rgb = rgb;
		return map;
	};
	const cpu = (reason: string) => {
		const prep = new PhotoPrep<Device, Buffer>({
			w,
			h,
			rgb,
			fg,
			compute,
			map: compute(),
		});
		lastPhotoPrepTiming = {
			path: "cpu",
			reason,
			totalMs: performance.now() - t0,
		};
		return prep;
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
	let planes: ResidentPlanes<Buffer> | null = null;
	try {
		planes = allocPlanes(device, w, h, fg);
		await runEdgeGpu(device, rgb, w, h, fg, planes);
	} catch (e) {
		if (planes) for (const b of Object.values(planes)) b.destroy();
		console.warn("[gpu] photo prep failed, using the CPU", e);
		return cpu(`error: ${e}`);
	}
	const gpuMs = performance.now() - tg;
	// the device's first results qualify it (compared now, before any plane is bound unread); later
	// ones are sampled and compared on the lazy read
	const qualifying = st.checked.edge < PREP_VERIFY_FIRST;
	const verify = shouldVerify(st, "edge");
	const dev = device;
	const prep = new PhotoPrep<Device, Buffer>({
		w,
		h,
		rgb,
		fg,
		compute,
		gpu: {
			device: dev,
			planes,
			read: (p) =>
				readPlanes(dev, p, w, h, rgb, fg, verify ? compute : null, st),
			onReadFailure: (e) =>
				console.warn("[gpu] photo prep read failed, using the CPU", e),
		},
	});
	if (qualifying) {
		await prep.cpu();
		if (prep.source !== "gpu-read") {
			lastPhotoPrepTiming = {
				path: "cpu",
				reason: st.disabled ? "mismatch" : "read failed",
				totalMs: performance.now() - t0,
				gpuMs,
				verified: true,
			};
			return prep;
		}
	}
	lastPhotoPrepTiming = {
		path: "gpu",
		totalMs: performance.now() - t0,
		gpuMs,
		verified: qualifying,
		resident: prep.resident,
		verifyOnRead: verify && !qualifying,
	};
	return prep;
}

/**
 * buildEdgeMap with everything after the canvas on the GPU (see the header): buildPhotoPrepAsync and
 * its CPU map at once. Same EdgeMap, bit for bit.
 */
export async function buildEdgeMapAsync(
	img: HTMLImageElement | ImageBitmap,
	width = 512,
	fgMask?: FgMask | null,
	opts: PhotoPrepOptions = {},
): Promise<EdgeMap> {
	const prep = await buildPhotoPrepAsync(img, width, fgMask, opts);
	const map = await prep.cpu();
	// the caller keeps the map only: free the planes now (align uploads this map's arrays)
	prep.retire();
	return map;
}

/**
 * Pin the resident { coarse, fine, fg } buffers of `edge` (a map from buildPhotoPrepAsync, or a
 * copy sharing its planes) on `device`, or null: the caller uploads the CPU arrays instead. Release
 * the pin after the GPU job's submit (the buffers stay alive until then, even if evicted).
 */
export const pinResidentPlanes = (
	device: Device,
	edge: Pick<EdgeMap, "coarse" | "fine" | "fg">,
) => pinPlanes(device, edge) as PinnedPlanes<Buffer> | null;

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
		// the prep's resident fg when `edge` is a resident prep's map on this device (no re-upload)
		const pinned = pinResidentPlanes(device, edge);
		const [sky, cum, echo] = await withLease(PHOTOPREP_GROUP, () =>
			runGraph(
				device,
				"sky",
				w,
				h,
				inputsFor(device, w, h, edge.rgb, edge.fg, lim, nonce, pinned?.fg),
			),
		).finally(() => pinned?.release());
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
