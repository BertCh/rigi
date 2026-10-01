// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU prep of the sky segmenter's input: an ImageBitmap of the working-size photo → on the compute
// device, with no CPU pixels:
//   dense RGBA words   (the refine's full-res guide, refine.ts `rgba`)
//   rgbLo              (3·lw·lh f32 planar: the refine's low-res guide, `guideLo`)
//   input              (the same, ImageNet-normalised: ONNX Runtime's NCHW input tensor buffer)
// all BIT-IDENTICAL to the CPU chain in sky/core.ts (rgbPlanes → resamplePlanes → normalise); see
// prep.wgsl.ts for how (an exact u32 soft-float of the CPU's f64 chain) and prep-ref.ts for its node
// twin. Nothing here reads back unless the caller verifies (readPrep / readRgba).
//
// Steps: copyExternalImageToTexture (rgba8unorm, no colour conversion, unpremultiplied) →
// copyTextureToBuffer (rows padded to 256 B) → unpack → H pass → V pass → normalise, the kernels on
// a core ComputeGraph per shape (buildPrepGraph, cachedGraph group "sky-prep"; since 2026-10-01, it was
// a dispatchAll chain) submitted after the texture copy. The pixels equal getImageData's only if the bitmap was made from the same
// raster with premultiplyAlpha/colorSpaceConversion 'none' (sky/index.ts); the first photos per
// device are compared byte-for-byte against the CPU pixels (sky/prep.ts), never trusted blindly.
import { Buffer, type Device } from "@luma.gl/core";
import {
	type ComputeGraph,
	cachedGraph,
	releaseCachedGraphs,
} from "#/lib/gpu/core/graph";
import {
	type BindKind,
	defineKernel,
	storage,
	uniform,
} from "#/lib/gpu/core/kernel";
import { pooledStorage, withLease } from "#/lib/gpu/core/pool";
import { readBack } from "#/lib/gpu/core/readback";
import {
	PREP_ALPHA,
	PREP_H,
	PREP_NORM,
	PREP_UNPACK,
	PREP_V,
} from "./prep.wgsl";
import { axisTapsF64, constsTable } from "./prep-ref";
import { lutTable } from "./refine";

const GROUP = "sky-prep";
const def = (id: string, src: string, layout: [string, BindKind][]) =>
	defineKernel(id, src, layout, { group: GROUP, label: `sky-${id}` });
const RO = "read-only-storage" as const;

export const K_PREP_UNPACK = def("prep-unpack", PREP_UNPACK, [
	["prm", "uniform"],
	["pad", RO],
	["rgba", "storage"],
]);
export const K_PREP_ALPHA = def("prep-alpha", PREP_ALPHA, [
	["prm", "uniform"],
	["rgba", RO],
	["flag", "storage"],
]);
export const K_PREP_H = def("prep-h", PREP_H, [
	["prm", "uniform"],
	["axH", RO],
	["cst", RO],
	["lut", RO],
	["rgba", RO],
	["tmp", "storage"],
]);
export const K_PREP_V = def("prep-v", PREP_V, [
	["prm", "uniform"],
	["axV", RO],
	["cst", RO],
	["tmp", RO],
	["lo", "storage"],
]);
export const K_PREP_NORM = def("prep-norm", PREP_NORM, [
	["prm", "uniform"],
	["cst", RO],
	["lo", RO],
	["inp", "storage"],
]);

const WG = 256;

/** The prepared buffers, owned by the caller (`dispose()` destroys them; ORT / the refine only wrap them). */
export interface SkyPrepGpu {
	W: number;
	H: number;
	/** Model resolution. */
	lw: number;
	lh: number;
	/** W·H RGBA words (one u32 per pixel, byte 0 = R). */
	rgba: GPUBuffer;
	/** 3·lw·lh f32, planar: resamplePlanes(rgbPlanes(rgba), W, H, 3, lw, lh). */
	rgbLo: GPUBuffer;
	/** 3·lw·lh f32 NCHW: normalise(rgbLo), ORT's input. */
	input: GPUBuffer;
	/** True when every pixel's alpha is 255 (4 bytes read back): the precondition of the bitmap's bytes equalling getImageData's. */
	isOpaque(): Promise<boolean>;
	/** The photo's bytes (W·H·4) read back from the GPU: only for a CPU fallback. */
	readRgba(): Promise<Uint8Array>;
	/** All three buffers read back (rgba bytes, rgbLo and input as f32 bit patterns): the verification. */
	readAll(): Promise<{
		rgba: Uint8Array;
		rgbLo: Uint32Array;
		input: Uint32Array;
	}>;
	dispose(): void;
}

/** Why the GPU prep cannot run on `device` for this shape (undefined: it can). */
export function skyPrepUnsupported(
	device: Device,
	W: number,
	H: number,
	lw: number,
	lh: number,
): string | undefined {
	if (!(W >= lw && H >= lh))
		return `upsampling ${W}x${H} -> ${lw}x${lh} stays on the CPU`;
	const L = device.limits;
	const rowBytes = Math.ceil((W * 4) / 256) * 256;
	const need = Math.max(rowBytes * H, 3 * H * lw * 4, 4 * W * H);
	if (need > L.maxStorageBufferBindingSize || need > L.maxBufferSize)
		return `${need} B buffer over the device limits`;
	if (W > L.maxTextureDimension2D || H > L.maxTextureDimension2D)
		return `${W}x${H} over maxTextureDimension2D`;
	if (
		Math.ceil((3 * Math.max(H, lh) * lw) / WG) >
		L.maxComputeWorkgroupsPerDimension
	)
		return "dispatch over maxComputeWorkgroupsPerDimension";
	return undefined;
}

const tableCache = new Map<
	string,
	{
		axH: Uint32Array;
		axV: Uint32Array;
		cst: Uint32Array;
	}
>();

function tables(W: number, H: number, lw: number, lh: number) {
	const key = `${W}x${H}>${lw}x${lh}`;
	let t = tableCache.get(key);
	if (!t) {
		const h = axisTapsF64(W, lw);
		const v = axisTapsF64(H, lh);
		t = {
			axH: h.table,
			axV: v.table,
			cst: constsTable([h.scaleLo, h.scaleHi], [v.scaleLo, v.scaleHi]),
		};
		if (tableCache.size > 8) tableCache.clear();
		tableCache.set(key, t);
	}
	return t;
}

const handleOf = (b: Buffer) => (b as unknown as { handle: GPUBuffer }).handle;

type Params = Record<string, never>;

/** Compiled prep graphs kept per device (one per photo shape; each holds its `tmp` transient). */
const MAX_GRAPHS = 2;

/**
 * The five prep kernels for one shape as a core ComputeGraph (cachedGraph group "sky-prep"; one compute
 * pass). Imports, bound per run: the params, the padded rows, the pooled tables and the four outputs
 * (caller-owned: ORT and the refine wrap them after the run). The H pass's `tmp` is the graph's only
 * transient; every kernel writes every element of its output range, except prep-alpha, which only sets
 * `flag` (an import created zeroed per run).
 */
export function buildPrepGraph(
	g: ComputeGraph<Params>,
	W: number,
	H: number,
	lw: number,
	lh: number,
): void {
	const n = lw * lh;
	const N = W * H;
	const rowBytes = Math.ceil((W * 4) / 256) * 256;
	const t = tables(W, H, lw, lh);
	const imp = (id: string, bytes: number, usage = Buffer.STORAGE) =>
		g.importBuffer(id, bytes, undefined, usage);
	const prm = imp("prm", 32, Buffer.UNIFORM | Buffer.COPY_DST);
	const pad = imp("pad", rowBytes * H);
	const axH = imp("axH", t.axH.byteLength);
	const axV = imp("axV", t.axV.byteLength);
	const cst = imp("cst", t.cst.byteLength);
	const lut = imp("lut", 512 * 4);
	const rgba = imp("rgba", N * 4);
	const flag = imp("flag", 4);
	const rgbLo = imp("rgbLo", 3 * n * 4);
	const input = imp("input", 3 * n * 4);
	const tmp = g.transientBuffer("tmp", 3 * H * lw * 4);
	g.addKernel({
		id: "unpack",
		spec: K_PREP_UNPACK,
		bindings: { prm, pad, rgba },
		workgroups: [Math.ceil(N / WG)],
	})
		.addKernel({
			id: "alpha",
			spec: K_PREP_ALPHA,
			bindings: { prm, rgba, flag },
			workgroups: [Math.ceil(N / WG)],
		})
		.addKernel({
			id: "h",
			spec: K_PREP_H,
			bindings: { prm, axH, cst, lut, rgba, tmp },
			workgroups: [Math.ceil((3 * H * lw) / WG)],
		})
		.addKernel({
			id: "v",
			spec: K_PREP_V,
			bindings: { prm, axV, cst, tmp, lo: rgbLo },
			workgroups: [Math.ceil((3 * n) / WG)],
		})
		.addKernel({
			id: "norm",
			spec: K_PREP_NORM,
			bindings: { prm, cst, lo: rgbLo, inp: input },
			workgroups: [Math.ceil((3 * n) / WG)],
		});
}

/** Destroy this device's cached prep graphs (each after its runs). */
export function releasePrepGraphs(device: Device): Promise<void> {
	return releaseCachedGraphs(device, GROUP);
}

/**
 * Upload `bitmap` (exactly W × H, consumed by the caller afterwards) and run the prep on `device`.
 * Throws when unsupported or on any GPU error: the caller then runs the CPU path.
 */
export function prepSkyGpu(
	device: Device,
	bitmap: ImageBitmap,
	W: number,
	H: number,
	lw: number,
	lh: number,
): Promise<SkyPrepGpu> {
	const why = skyPrepUnsupported(device, W, H, lw, lh);
	if (why) return Promise.reject(new Error(`sky prep: ${why}`));
	if (bitmap.width !== W || bitmap.height !== H)
		return Promise.reject(
			new Error(
				`sky prep: bitmap ${bitmap.width}x${bitmap.height} is not ${W}x${H}`,
			),
		);
	const gd = device.handle as GPUDevice;
	// pixels → texture (no conversion, unpremultiplied) → padded rows in `pad`
	return runPrep(device, W, H, lw, lh, (pad, rowBytes) => {
		const tex = gd.createTexture({
			size: [W, H, 1],
			format: "rgba8unorm",
			// copyExternalImageToTexture needs COPY_DST | RENDER_ATTACHMENT on the destination, and the
			// copy into `pad` needs COPY_SRC. (These were TEXTURE_BINDING | STORAGE_BINDING |
			// RENDER_ATTACHMENT before 2026-10-01: every browser prep failed validation and fell back.)
			// GPUTextureUsage bits: COPY_SRC 0x01 | COPY_DST 0x02 | RENDER_ATTACHMENT 0x10
			usage: 0x01 | 0x02 | 0x10,
		});
		try {
			gd.queue.copyExternalImageToTexture(
				{ source: bitmap, flipY: false },
				{ texture: tex, premultipliedAlpha: false, colorSpace: "srgb" },
				[W, H],
			);
			const enc0 = gd.createCommandEncoder();
			enc0.copyTextureToBuffer(
				{ texture: tex },
				{ buffer: handleOf(pad), bytesPerRow: rowBytes },
				[W, H],
			);
			gd.queue.submit([enc0.finish()]);
		} finally {
			tex.destroy();
		}
	});
}

/**
 * The prep from RGBA rows already padded to 256 B (`padded`: rowBytes · H bytes, rowBytes =
 * ceil(4W / 256) · 256), written with a queue write instead of the bitmap upload: the same graph and
 * outputs as prepSkyGpu, for node checks without ImageBitmap (scripts/gpu/sky-prep-dawn.ts --graph).
 */
export function prepSkyGpuFromRows(
	device: Device,
	padded: Uint8Array,
	W: number,
	H: number,
	lw: number,
	lh: number,
): Promise<SkyPrepGpu> {
	const why = skyPrepUnsupported(device, W, H, lw, lh);
	if (why) return Promise.reject(new Error(`sky prep: ${why}`));
	return runPrep(device, W, H, lw, lh, (pad) => pad.write(padded));
}

/** The prep after `fill` wrote the padded rows into `pad` (queue order puts the graph after it). */
function runPrep(
	device: Device,
	W: number,
	H: number,
	lw: number,
	lh: number,
	fill: (pad: Buffer, rowBytes: number) => void,
): Promise<SkyPrepGpu> {
	return withLease(GROUP, async () => {
		const n = lw * lh;
		const N = W * H;
		const rowBytes = Math.ceil((W * 4) / 256) * 256;
		const t = tables(W, H, lw, lh);
		const words = new Uint32Array(8);
		words.set([W, H, lw, lh, rowBytes / 4]);
		const prm = uniform(device, words.buffer);
		const axH = pooledStorage(device, "sky-prep/axH", t.axH);
		const axV = pooledStorage(device, "sky-prep/axV", t.axV);
		const cst = pooledStorage(device, "sky-prep/cst", t.cst);
		const lut = pooledStorage(device, "sky-prep/lut", lutTable());
		const pad = storage(device, rowBytes * H);
		const rgba = storage(device, N * 4);
		const flag = storage(device, 4);
		const rgbLo = storage(device, 3 * n * 4);
		const input = storage(device, 3 * n * 4);
		const scratch = [prm, pad];
		const keep = [flag];
		const outs = [rgba, rgbLo, input];
		try {
			fill(pad, rowBytes);
			// the kernels on the shape's cached graph (queue order puts them after the copy above);
			// cachedGraph inside the group's lease, run() right after it (no await between)
			const { graph } = cachedGraph<Params, void>(
				device,
				GROUP,
				`${W}x${H}>${lw}x${lh}`,
				(g) => buildPrepGraph(g, W, H, lw, lh),
				MAX_GRAPHS,
			);
			await graph.run(
				{},
				{
					buffers: { prm, pad, axH, axV, cst, lut, rgba, flag, rgbLo, input },
				},
			);
		} catch (e) {
			for (const b of [...scratch, ...keep, ...outs]) b.destroy();
			throw e;
		}
		// the scratch is released after the submitted work (destroy is deferred by WebGPU)
		for (const b of scratch) b.destroy();
		let dead = false;
		const prep: SkyPrepGpu = {
			W,
			H,
			lw,
			lh,
			rgba: handleOf(rgba),
			rgbLo: handleOf(rgbLo),
			input: handleOf(input),
			isOpaque: async () => {
				const [b] = await readBack(
					device,
					() => [{ buffer: flag, size: 4 }],
					undefined,
					{ id: "sky-prep-alpha" },
				);
				return new Uint32Array(b)[0] === 0;
			},
			readRgba: async () => {
				const [b] = await readBack(
					device,
					() => [{ buffer: rgba, size: N * 4 }],
					undefined,
					{ id: "sky-prep-rgba" },
				);
				return new Uint8Array(b);
			},
			readAll: async () => {
				const [a, b, c] = await readBack(
					device,
					() => [
						{ buffer: rgba, size: N * 4 },
						{ buffer: rgbLo, size: 3 * n * 4 },
						{ buffer: input, size: 3 * n * 4 },
					],
					undefined,
					{ id: "sky-prep-verify" },
				);
				return {
					rgba: new Uint8Array(a),
					rgbLo: new Uint32Array(b),
					input: new Uint32Array(c),
				};
			},
			dispose: () => {
				if (dead) return;
				dead = true;
				for (const b of [...outs, ...keep]) b.destroy();
			},
		};
		return prep;
	});
}
