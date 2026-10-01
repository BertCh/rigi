// The silhouette pass mask on WebGPU (WebGpuEngine's autoAlign re-rank): the WGSL twin of
// deck/silhouette-gl.ts. deck/silhouette-mask.ts has the predicate, the layout and the identity
// argument. The range lives in each re-rank source's `targets.geometry` (rgba32float, w = range,
// 0 = sky, row 0 = top) on the render device, so the kernel runs there (no compute-device gate is
// needed: nothing crosses devices). One invocation per 96-pixel group writes 3 words of pass bits
// + a header (nonce << 16 | positive texels << 8 | undecided); every pose of one re-rank is one dispatch in ONE
// encoder, submitted after the geometry passes (same queue → they see the finished targets), and
// read back with ONE staged copy (core/readback): 18 KB per 384 × 288 pose instead of the 1.77 MB
// rgba32float range readback.
// A dispatch that fails validation silently leaves the output untouched: the per-call nonce in
// every header makes scoreFromMask reject such a mask (that pose is then scored on the CPU).
import {
	Buffer,
	type ComputePipeline,
	type Device,
	type Texture,
} from "@luma.gl/core";
import {
	SIL_GROUP,
	silGroups,
	silhouetteThresholds,
	silMaskWords,
} from "#/lib/deck/silhouette-mask";
import { dispatch, type Kernel, type KernelSpec } from "#/lib/gpu/core/kernel";
import { submit } from "#/lib/gpu/core/queue";
import { stageReads } from "#/lib/gpu/core/readback";

const WG = 64;

const WGSL = /* wgsl */ `
struct P {
	w: i32, h: i32, groups: i32, base: u32,
	nonce: u32, rmax: f32, khi: f32, klo: f32,
	zlo: f32, zhi: f32, flo: f32, fhi: f32,
};
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var geo: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<u32>;

// 0 = surely fail, 1 = surely pass, 2 = undecided
const F = 0u;
const T = 1u;
const U = 2u;

fn odd(v: f32) -> bool {
	let b = bitcast<u32>(v) & 0x7fffffffu;
	return (b != 0u && b < 0x00800000u) || b >= 0x7f800000u; // denormal, Inf, NaN
}
fn rangeAt(x: i32, y: i32) -> f32 {
	return textureLoad(geo, vec2<i32>(x, y), 0).w;
}
fn nb(rn: f32, rc: f32, z: u32) -> u32 {
	if (odd(rn)) { return U; }
	if (!(rn > 0.0)) { return z; }
	var lt = U;
	if (rn <= prm.flo) { lt = T; } else if (rn >= prm.fhi) { lt = F; }
	var r = U;
	if (rn >= rc * prm.khi) { r = T; } else if (rn <= rc * prm.klo) { r = F; }
	if (lt == T) { return r; }
	if (lt == F) { return z; }
	if (r == z && r != U) { return r; }
	return U;
}

@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let j = i32(id.x);
	if (j >= prm.groups * prm.h) { return; }
	let y = j / prm.groups;
	let g = j - y * prm.groups;
	var bits = array<u32, 3>(0u, 0u, 0u);
	var und = 0u;
	// positive-range texels of the group's row (all rows / columns): the zero-texture guard
	var pos = 0u;
	for (var k = 0; k < ${SIL_GROUP}; k++) {
		let x = g * ${SIL_GROUP} + k;
		if (x >= prm.w) { break; }
		let r = rangeAt(x, y);
		if (!odd(r) && r > 0.0) { pos++; }
	}
	if (y >= 1 && y <= prm.h - 2) {
		for (var k = 0; k < ${SIL_GROUP}; k++) {
			let x = g * ${SIL_GROUP} + k;
			if (x < 1 || x > prm.w - 2) { continue; }
			let rc = rangeAt(x, y);
			if (odd(rc)) { und++; continue; }
			if (!(rc > 0.0) || rc > prm.rmax) { continue; }
			var z = U;
			if (rc <= prm.zlo) { z = T; } else if (rc >= prm.zhi) { z = F; }
			let a = nb(rangeAt(x, y - 1), rc, z);
			let b = nb(rangeAt(x + 1, y), rc, z);
			let c = nb(rangeAt(x - 1, y), rc, z);
			if (a == T || b == T || c == T) {
				bits[k >> 5u] |= 1u << u32(k & 31);
			} else if (a == U || b == U || c == U) {
				und++;
			}
		}
	}
	let o = prm.base + u32(j) * 4u;
	outp[o] = bits[0];
	outp[o + 1u] = bits[1];
	outp[o + 2u] = bits[2];
	outp[o + 3u] = (prm.nonce << 16u) | (pos << 8u) | min(und, 255u);
}
`;

const pipelines = new WeakMap<Device, Kernel>();
function silKernel(device: Device): Kernel {
	let k = pipelines.get(device);
	if (k) return k;
	const label = "silhouette-mask";
	const shader = device.createShader({
		id: label,
		source: WGSL,
		language: "wgsl",
		stage: "compute",
	});
	const pipeline: ComputePipeline = device.createComputePipeline({
		id: label,
		shader,
		entryPoint: "main",
		shaderLayout: {
			bindings: [
				{ name: "prm", type: "uniform", group: 0, location: 0 },
				{
					name: "geo",
					type: "texture",
					group: 0,
					location: 1,
					viewDimension: "2d",
					sampleType: "unfilterable-float",
				},
				{ name: "outp", type: "storage", group: 0, location: 2 },
			],
		},
	});
	const spec: KernelSpec = {
		id: label,
		source: WGSL,
		layout: [],
		entryPoint: "main",
		group: "silhouette",
		label,
	};
	k = { pipeline, names: ["prm", "geo", "outp"], spec };
	pipelines.set(device, k);
	return k;
}

/** One per WebGpuEngine (one render device). */
export class SilhouetteMaskGpu {
	private prms: Buffer[] = [];
	private out: Buffer | null = null;
	private busy = false;
	private destroyed = false;
	/** Bytes the last run() read back. */
	lastBytes = 0;

	constructor(readonly device: Device) {}

	/**
	 * Masks of the poses drawn into `ranges` (rgba32float geometry targets, `W` × `H`, top-first),
	 * in one submit and one readback: pose k's words at k · silMaskWords(W, H). null = not run
	 * (busy / lost / compile or submit failure): the caller scores on the CPU.
	 */
	async run(
		ranges: Texture[],
		W: number,
		H: number,
		nonce: number,
	): Promise<Uint32Array | null> {
		const device = this.device;
		if (this.destroyed || this.busy || device.isLost || !ranges.length)
			return null;
		this.busy = true;
		try {
			const k = silKernel(device);
			const per = silMaskWords(W, H);
			const bytes = per * ranges.length * 4;
			if (!this.out || this.out.byteLength < bytes) {
				this.out?.destroy();
				this.out = device.createBuffer({
					id: "silhouette-mask-out",
					byteLength: bytes,
					usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
				});
			}
			const t = silhouetteThresholds();
			const G = silGroups(W);
			const enc = device.createCommandEncoder({ id: "silhouette-mask" });
			ranges.forEach((tex, i) => {
				const words = new ArrayBuffer(48);
				const iv = new Int32Array(words);
				const uv = new Uint32Array(words);
				const fv = new Float32Array(words);
				iv[0] = W;
				iv[1] = H;
				iv[2] = G;
				uv[3] = i * per;
				uv[4] = nonce;
				fv.set([t.rmax, t.khi, t.klo, t.zlo, t.zhi, t.flo, t.fhi], 5);
				// one uniform buffer per pose: writes land at write time, before this one submit
				this.prms[i] ??= device.createBuffer({
					id: `silhouette-mask-prm-${i}`,
					byteLength: 48,
					usage: Buffer.UNIFORM | Buffer.COPY_DST,
				});
				this.prms[i].write(new Uint8Array(words));
				dispatch(
					enc,
					k,
					{ prm: this.prms[i], geo: tex, outp: this.out as Buffer },
					Math.ceil((G * H) / WG),
				);
			});
			const st = stageReads(device, enc, [{ buffer: this.out, size: bytes }]);
			submit(device, enc);
			const [ab] = await st.read();
			if (this.destroyed) return null;
			this.lastBytes = bytes;
			return new Uint32Array(ab.slice(0, bytes));
		} catch (e) {
			console.warn("[silhouette-gpu] mask pass failed, CPU re-rank", e);
			return null;
		} finally {
			this.busy = false;
		}
	}

	destroy() {
		this.destroyed = true;
		for (const b of this.prms) b.destroy();
		this.prms = [];
		this.out?.destroy();
		this.out = null;
	}
}
