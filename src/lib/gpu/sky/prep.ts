// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU prep of the sky segmenter's input: an ImageBitmap of the working-size photo → on the compute
// device, with no CPU pixels:
//   dense RGBA words   (the refine's full-res guide, refine.ts `rgba`)
//   rgbLo              (3·lw·lh f32 planar: the refine's low-res guide, `guideLo`)
//   input              (the same, ImageNet-normalised: the nn model's NCHW input buffer)
// all BIT-IDENTICAL to the CPU chain in sky/core.ts (rgbPlanes → resamplePlanes → normalise); see
// prep.wgsl.ts for how (an exact u32 soft-float of the CPU's f64 chain) and prep-ref.ts for its node
// twin. Nothing here reads back unless the caller verifies (readPrep / readRgba).
//
// Steps: copyExternalImageToTexture (rgba8unorm, no colour conversion, unpremultiplied) →
// copyTextureToBuffer (rows padded to 256 B) → unpack → H pass → V pass → normalise, the kernels on
// a core ComputeGraph per shape (buildPrepGraph, cachedGraph group "sky-prep"; since 2026-10-01, it was
// a dispatchAll chain) submitted after the texture copy. buildPrepGraph also records the same kernels
// into the fused graph (gpu/sky/fused-graph.ts: prep → nn forward → refine in ONE submission, the
// steady-state path) with the outputs as graph transients. The pixels equal getImageData's only if the bitmap was made from the same
// raster with premultiplyAlpha/colorSpaceConversion 'none' (sky/index.ts); the first photos per
// device are compared byte-for-byte against the CPU pixels (sky/prep.ts), never trusted blindly.
import { Buffer, type Device, Texture } from "@luma.gl/core";
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
import { nativeWebGPUBuffer } from "#/lib/gpu/core/luma";
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
import { packSkyPrepParams } from "./uniforms";

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

/** The prepared buffers, owned by the caller (`dispose()` destroys them; the nn model / the refine only wrap them). */
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
	/** 3·lw·lh f32 NCHW: normalise(rgbLo), the model's input. */
	input: GPUBuffer;
	/** The same buffer as a luma Buffer (nn `fromBuffer`). */
	inputBuffer: Buffer;
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

type Params = Record<string, never>;

/** A graph buffer handle (importBuffer / transientBuffer result). */
type Handle = ReturnType<ComputeGraph<unknown>["importBuffer"]>;

/** Handles of the prep graph: the three outputs (imports, or transients when fused) and the alpha flag. */
export interface PrepHandles {
	rgba: Handle;
	rgbLo: Handle;
	input: Handle;
	flag: Handle;
}

/** How buildPrepGraph records into a graph shared with the model and the refine. */
export interface PrepFusion {
	/** Prefix of every import id (the refine's "prm" / "lut" live in the same graph). */
	prefix: string;
	/** The graph's shared LUT import (the prep and the refine read the same table). */
	lut: Handle;
}

/** Compiled prep graphs kept per device (one per photo shape; each holds its `tmp` transient). */
const MAX_GRAPHS = 2;

/**
 * The five prep kernels for one shape as a core ComputeGraph (cachedGraph group "sky-prep"; one compute
 * pass). Imports, bound per run: the params, the padded rows, the pooled tables and the four outputs
 * (caller-owned: the nn model and the refine wrap them after the run). The H pass's `tmp` is the graph's
 * only transient; every kernel writes every element of its output range, except prep-alpha, which only
 * sets `flag` (an import created zeroed per run). With `fusion`, the ids carry its prefix, the LUT is
 * shared and rgba / rgbLo / input are graph transients (aliased by lifetime) the next nodes read.
 */
export function buildPrepGraph<P = Params>(
	g: ComputeGraph<P>,
	W: number,
	H: number,
	lw: number,
	lh: number,
	fusion?: PrepFusion,
): PrepHandles {
	const n = lw * lh;
	const N = W * H;
	const rowBytes = Math.ceil((W * 4) / 256) * 256;
	const t = tables(W, H, lw, lh);
	const pre = fusion?.prefix ?? "";
	const imp = (id: string, bytes: number, usage = Buffer.STORAGE) =>
		g.importBuffer(pre + id, bytes, undefined, usage);
	const out = (id: string, bytes: number) =>
		fusion ? g.transientBuffer(pre + id, bytes) : imp(id, bytes);
	const prm = imp("prm", 32, Buffer.UNIFORM | Buffer.COPY_DST);
	const pad = imp("pad", rowBytes * H);
	const axH = imp("axH", t.axH.byteLength);
	const axV = imp("axV", t.axV.byteLength);
	const cst = imp("cst", t.cst.byteLength);
	const lut = fusion ? fusion.lut : imp("lut", 512 * 4);
	const rgba = out("rgba", N * 4);
	// fused: the refine graph's read node copies it out
	const flag = imp(
		"flag",
		4,
		fusion ? Buffer.STORAGE | Buffer.COPY_SRC : Buffer.STORAGE,
	);
	const rgbLo = out("rgbLo", 3 * n * 4);
	const input = out("input", 3 * n * 4);
	const tmp = g.transientBuffer(`${pre}tmp`, 3 * H * lw * 4);
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
	return { rgba, rgbLo, input, flag };
}

/** The prep's constant tables for one shape (axis taps, constants): fused runs bind them as imports. */
export const prepTables = tables;

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
	// pixels → texture (no conversion, unpremultiplied) → padded rows in `pad`
	return runPrep(device, W, H, lw, lh, (pad, rowBytes) =>
		uploadBitmapRows(device, bitmap, W, H, pad, rowBytes),
	);
}

/**
 * ImageBitmap (exactly W × H) → texture (no conversion, unpremultiplied) → `pad` as rows padded to
 * `rowBytes`, on the device queue (a graph run submitted after it sees the rows).
 */
export function uploadBitmapRows(
	device: Device,
	bitmap: ImageBitmap,
	W: number,
	H: number,
	pad: Buffer,
	rowBytes: number,
): void {
	{
		const tex = device.createTexture({
			id: "sky-prep-bitmap",
			width: W,
			height: H,
			format: "rgba8unorm",
			// copyExternalImage needs COPY_DST | RENDER_ATTACHMENT on the destination, and the
			// copy into `pad` needs COPY_SRC. (These were TEXTURE_BINDING | STORAGE_BINDING |
			// RENDER_ATTACHMENT before 2026-10-01: every browser prep failed validation and fell back.)
			usage: Texture.COPY_SRC | Texture.COPY_DST | Texture.RENDER_ATTACHMENT,
		});
		try {
			tex.copyExternalImage({
				image: bitmap,
				width: W,
				height: H,
				flipY: false,
				premultipliedAlpha: false,
				colorSpace: "srgb",
			});
			const encoder = device.createCommandEncoder();
			encoder.copyTextureToBuffer({
				sourceTexture: tex,
				width: W,
				height: H,
				destinationBuffer: pad,
				bytesPerRow: rowBytes,
			});
			device.submit(encoder.finish());
		} finally {
			tex.destroy();
		}
	}
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
		const prm = uniform(device, packSkyPrepParams(W, H, lw, lh, rowBytes));
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
			rgba: nativeWebGPUBuffer(rgba),
			rgbLo: nativeWebGPUBuffer(rgbLo),
			input: nativeWebGPUBuffer(input),
			inputBuffer: input,
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
