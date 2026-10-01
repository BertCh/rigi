// Host side of the pose-bound kernel (./pose-bound.wgsl.ts): certified upper bounds of align.ts
// scorePose (stride 1, coarse or fine map) for a batch of poses, the ScoreBounds provider of
// align.ts autoAlignRefined (the refine's neighbour pre-screen). The CPU twin and reference is
// scorePose itself: a bound never replaces a score, it only lets the refine skip a neighbour the
// CPU would reject (proof in align.ts Descent), so the refine's result is the CPU's bit for bit as
// long as every bound is a true upper bound. That is what this file and the WGSL establish:
//
//   GPU (f32): per direction, one that could fall on either side of a frame-edge test is counted in
//   nAmb (its highest candidate term, if positive, in ambHi); one that could fall in either of two
//   pixels gets the min / max of the two terms; the rest are decided exactly as on the CPU, n of them
//   in the frame. Sums sumLo ≤ … ≤ sumHi, absA = Σ A_i over all counted directions.
//   Host (f64): a z-ambiguous direction → no bound. Otherwise the CPU counted n + k directions for
//   some 0 ≤ k ≤ nAmb, and whichever subset it counted,
//     CPU sum ≤ sumHi + ambHi + E,  E = ((24 + 2·depth)·2⁻²³ + nDirs·2⁻⁵²)·absA·1.01 + tiny
//   (depth = the f32 summation depth, ceil(nDirs/256) + 8; per-term f32-vs-f64 error ≤ 8u·A_i;
//   the WGSL header has the derivation, with ≥ 4× slack everywhere), so
//     U = max over k of scoreFromSum(sumHi + ambHi + E, n + k, total, vfov, aspect) ≥ scorePose
//   because scoreFromSum is the CPU's own final expression and monotone in the sum.
//
// Buffers: the gpu/core pool under the "align" lease (one dispatch per call). The edge planes
// (coarse, fine, fg) and the stride-1 direction table are uploaded once per photo (uploadOnce);
// skyCum, refit in place by fitPriorSky, is uploaded once per session (one autoAlign) and again
// only if another session wrote the slot in between. Readback: 48 B per pose via core/readback.
import type { Device } from "@luma.gl/core";
import {
	type EdgeMap,
	type ScoreBound,
	type ScoreBounds,
	scoreFromSum,
} from "#/lib/align";
import { type Pose, poseBasis } from "#/lib/camera";
import {
	defineKernel,
	dispatch,
	kernel,
	stage,
	submit,
} from "#/lib/gpu/core/kernel";
import {
	acquire,
	pooledStorage,
	pooledUniform,
	withLease,
} from "#/lib/gpu/core/pool";
import { POSE_BOUND_WGSL } from "./pose-bound.wgsl";
import {
	ALIGN_GROUP,
	type PoseGridStats,
	STORAGE,
	uploadOnce,
} from "./pose-grid";

const D = Math.PI / 180;
const ro = "read-only-storage" as const;
const POSE_BOUND = defineKernel(
	"align-pose-bound",
	POSE_BOUND_WGSL,
	[
		["u", "uniform"],
		["poses", ro],
		["dirs", ro],
		["coarse", ro],
		["fine", ro],
		["fg", ro],
		["skyCum", ro],
		["out", "storage"],
	],
	{ group: ALIGN_GROUP, label: "align-pose-bound" },
);

// stride-1 direction table (vec4 per direction) per horizon array
const dirTables = new WeakMap<Float32Array, Float32Array>();
function dirTable(dirs: Float32Array) {
	let t = dirTables.get(dirs);
	if (!t) {
		const n = Math.floor(dirs.length / 3);
		t = new Float32Array(Math.max(1, n) * 4);
		for (let k = 0; k < n; k++) {
			t[k * 4] = dirs[k * 3];
			t[k * 4 + 1] = dirs[k * 3 + 1];
			t[k * 4 + 2] = dirs[k * 3 + 2];
		}
		dirTables.set(dirs, t);
	}
	return t;
}

// pooled buffer → the session that last wrote it
const writer = new WeakMap<object, object>();

/** Raw per-pose outputs of one dispatch (see the WGSL header). */
export type PoseBoundRaw = {
	f: Float32Array;
	u: Uint32Array;
	n: number;
	nonce: number;
	/** the uploaded pose words (word 3 of each 12 = tan(vfov/2) bits, echoed by the kernel) */
	tanBits: Uint32Array;
};

// fg weights the terms by (1 − fg); the per-term error bound assumes fg ∈ [0, 1]
const fgChecked = new WeakMap<Float32Array, boolean>();
function fgInRange(fg: Float32Array) {
	let ok = fgChecked.get(fg);
	if (ok === undefined) {
		ok = true;
		for (let i = 0; i < fg.length; i++)
			if (!(fg[i] >= 0 && fg[i] <= 1)) {
				ok = false;
				break;
			}
		fgChecked.set(fg, ok);
	}
	return ok;
}

let nonces = 0;

/**
 * The CPU score's certified upper bound for pose i of `raw` (undefined: no bound). `nDirs` is the
 * direction count (scorePose's `total` at stride 1), `vfov`/`aspect` the pose's and the photo's.
 */
export function certifiedUpper(
	raw: PoseBoundRaw,
	i: number,
	nDirs: number,
	vfov: number,
	aspect: number,
): ScoreBound | undefined {
	const o = i * 12;
	// written by this dispatch for this pose, from this call's pose inputs (a silently failed
	// dispatch or a stale input leaves bytes that must not pass for a bound)
	if (
		raw.u[o + 3] !== raw.nonce ||
		raw.u[o + 6] !== i ||
		raw.u[o + 9] !== raw.tanBits[i * 12 + 3]
	)
		return undefined;
	if (raw.u[o + 5] > 0) return undefined; // z-ambiguous direction or a 3-pixel span
	const n = raw.u[o + 4];
	const nAmb = raw.u[o + 7];
	const sumHi = raw.f[o + 1];
	const absA = raw.f[o + 2];
	const ambHi = raw.f[o + 8];
	if (
		!Number.isFinite(sumHi) ||
		!Number.isFinite(absA) ||
		!Number.isFinite(ambHi) ||
		absA < 0 ||
		ambHi < 0
	)
		return undefined;
	const depth = Math.ceil(nDirs / 256) + 8;
	const E =
		((24 + 2 * depth) * 2 ** -23 + nDirs * 2 ** -52) * absA * 1.01 +
		1e-30 * (n + nAmb);
	// every sum the CPU can form (the certain terms plus any subset of the ambiguous ones) is ≤ this;
	// the f64 additions round by ≤ 2⁻⁵³ relative each: charged explicitly
	const s0 = sumHi + ambHi + E;
	const sum = s0 + 1e-15 * (Math.abs(sumHi) + ambHi + E);
	// the CPU counted n + k directions for some k ≤ nAmb: the bound is the largest of those scores
	let ub = Number.NEGATIVE_INFINITY;
	let ub0 = Number.NEGATIVE_INFINITY;
	for (let k = 0; k <= nAmb; k++) {
		ub = Math.max(ub, scoreFromSum(sum, n + k, nDirs, vfov, aspect));
		ub0 = Math.max(
			ub0,
			scoreFromSum(sumHi + ambHi, n + k, nDirs, vfov, aspect),
		);
	}
	// eps: how much of U is the error allowance (the refine re-checks skips that lean on it)
	return { ub, eps: Math.max(0, ub - ub0) };
}

/** One dispatch: raw bound outputs for `probes`. Throws on GPU errors. */
async function boundOnce(
	device: Device,
	session: object,
	probes: { pose: Pose; fine: boolean }[],
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	up: PoseGridStats,
): Promise<PoseBoundRaw> {
	const nPoses = probes.length;
	const { w, h } = edge;
	const nDirs = Math.floor(dirs.length / 3);
	const pose4 = new Float32Array(nPoses * 12);
	for (let i = 0; i < nPoses; i++) {
		const p = probes[i].pose;
		const b = poseBasis(p);
		pose4.set(b.forward, i * 12);
		pose4[i * 12 + 3] = Math.tan((p.vfov * D) / 2);
		pose4.set(b.right, i * 12 + 4);
		pose4[i * 12 + 7] = p.vfov;
		pose4.set(b.up, i * 12 + 8);
		pose4[i * 12 + 11] = probes[i].fine ? 1 : 0;
	}
	const uw = new ArrayBuffer(48);
	nonces = (nonces + 1) >>> 0 || 1;
	const nonce = nonces;
	const ui = new Uint32Array(uw);
	const ii = new Int32Array(uw);
	const uf = new Float32Array(uw);
	ui[0] = w;
	ui[1] = h;
	ui[2] = nDirs;
	ui[3] = nPoses;
	// band and gaps exactly as scorePose
	ii[4] = Math.max(2, Math.round(h * 0.035));
	ii[5] = Math.max(1, Math.round(h * 0.012));
	ii[6] = Math.max(1, Math.round(h * 0.006));
	uf[7] = aspect;
	ui[8] = nonce;

	const sky = acquire(
		device,
		"align/refine-skycum",
		Math.max(16, edge.skyCum.byteLength),
		STORAGE,
	);
	if (writer.get(sky) !== session) {
		sky.write(edge.skyCum);
		writer.set(sky, session);
		up.uploadBytes += edge.skyCum.byteLength;
	}
	const table = dirTable(dirs);
	// every slot is read only within its first w·h / nDirs / nPoses entries, and `out` is fully
	// overwritten for pi < nPoses, so pool capacity and stale bytes don't reach the result
	const bindings = {
		u: pooledUniform(device, "align/refine-u", uw),
		poses: pooledStorage(device, "align/refine-poses", pose4),
		dirs: uploadOnce(device, "align/dirs1", table, up),
		coarse: uploadOnce(device, "align/coarse", edge.coarse, up),
		fine: uploadOnce(device, "align/fine", edge.fine, up),
		fg: uploadOnce(device, "align/fg", edge.fg, up),
		skyCum: sky,
		out: acquire(device, "align/refine-out", nPoses * 48, STORAGE),
	};
	up.uploadBytes += 48 + pose4.byteLength;
	const enc = device.createCommandEncoder({ id: "align-pose-bound" });
	let staged: ReturnType<typeof stage> | undefined;
	try {
		// throws past maxComputeWorkgroupsPerDimension (core/kernel guard): the caller goes CPU
		dispatch(enc, kernel(device, POSE_BOUND), bindings, nPoses);
		staged = stage(device, enc, bindings.out, nPoses * 48);
		submit(device, enc);
	} catch (e) {
		staged?.cancel();
		throw e;
	}
	const buf = await staged.read();
	return {
		f: new Float32Array(buf),
		u: new Uint32Array(buf),
		n: nPoses,
		nonce,
		tanBits: new Uint32Array(pose4.buffer),
	};
}

export type PoseBoundStats = PoseGridStats & {
	/** dispatches and poses */
	calls: number;
	poses: number;
	/** poses returned without a bound (a z-ambiguous direction) */
	unbounded: number;
	/** wall ms spent awaiting the GPU (upload + dispatch + readback) */
	gpuMs: number;
};

/**
 * A ScoreBounds provider for one autoAlign on this photo (align.ts autoAlignRefined). Call it after
 * fitPriorSky: skyCum is taken as constant for the session's lifetime. Rejects on GPU errors.
 */
export function poseBoundSession(
	device: Device,
	aspect: number,
	dirs: Float32Array,
	edge: EdgeMap,
	stats?: PoseBoundStats,
): ScoreBounds {
	const session = {};
	const nDirs = Math.floor(dirs.length / 3);
	return (probes) => {
		if (!probes.length) return Promise.resolve([]);
		// scorePose reads whole triples; anything else is not this kernel's input
		// (and an fg outside [0, 1] voids the per-term error bound)
		if (dirs.length % 3 || !fgInRange(edge.fg))
			return Promise.resolve(probes.map(() => undefined));
		return withLease(ALIGN_GROUP, async () => {
			const t0 = performance.now();
			const up: PoseGridStats = { uploadBytes: 0 };
			const raw = await boundOnce(
				device,
				session,
				probes,
				aspect,
				dirs,
				edge,
				up,
			);
			const out = probes.map((q, i) =>
				certifiedUpper(raw, i, nDirs, q.pose.vfov, aspect),
			);
			if (stats) {
				stats.calls++;
				stats.poses += probes.length;
				stats.unbounded += out.filter((x) => x === undefined).length;
				stats.uploadBytes += up.uploadBytes;
				stats.gpuMs += performance.now() - t0;
			}
			return out;
		});
	};
}
