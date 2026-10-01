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
// copyTextureToBuffer (rows padded to 256 B) → unpack → H pass → V pass → normalise, one submit
// after the texture copy. The pixels equal getImageData's only if the bitmap was made from the same
// raster with premultiplyAlpha/colorSpaceConversion 'none' (sky/index.ts); the first photos per
// device are compared byte-for-byte against the CPU pixels (sky/prep.ts), never trusted blindly.
import type { Buffer, Device } from "@luma.gl/core";
import {
	type BindKind,
	defineKernel,
	dispatchAll,
	kernel,
	storage,
	submit,
	uniform,
} from "#/lib/gpu/core/kernel";
import { pooledStorage, withLease } from "#/lib/gpu/core/pool";
import { readBack } from "#/lib/gpu/core/readback";
import { PREP_H, PREP_NORM, PREP_UNPACK, PREP_V } from "./prep.wgsl";
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
	const kUnpack = kernel(device, K_PREP_UNPACK);
	const kH = kernel(device, K_PREP_H);
	const kV = kernel(device, K_PREP_V);
	const kNorm = kernel(device, K_PREP_NORM);
	return withLease(GROUP, () => {
		const n = lw * lh;
		const N = W * H;
		const gd = device.handle as GPUDevice;
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
		const tmp = storage(device, 3 * H * lw * 4);
		const rgbLo = storage(device, 3 * n * 4);
		const input = storage(device, 3 * n * 4);
		const scratch = [prm, pad, tmp];
		const outs = [rgba, rgbLo, input];
		try {
			// pixels → texture (no conversion, unpremultiplied) → padded rows in `pad`
			const tex = gd.createTexture({
				size: [W, H, 1],
				format: "rgba8unorm",
				// COPY_SRC | COPY_DST | RENDER_ATTACHMENT (copyExternalImageToTexture renders into it)
				usage: 0x04 | 0x08 | 0x10,
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
			const enc = device.createCommandEncoder({ id: "sky-prep" });
			dispatchAll(
				enc,
				[
					{
						k: kUnpack,
						bindings: { prm, pad, rgba },
						x: Math.ceil(N / WG),
					},
					{
						k: kH,
						bindings: { prm, axH, cst, lut, rgba, tmp },
						x: Math.ceil((3 * H * lw) / WG),
					},
					{
						k: kV,
						bindings: { prm, axV, cst, tmp, lo: rgbLo },
						x: Math.ceil((3 * n) / WG),
					},
					{
						k: kNorm,
						bindings: { prm, cst, lo: rgbLo, inp: input },
						x: Math.ceil((3 * n) / WG),
					},
				],
				"sky-prep",
			);
			submit(device, enc);
		} catch (e) {
			for (const b of [...scratch, ...outs]) b.destroy();
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
				for (const b of outs) b.destroy();
			},
		};
		return prep;
	});
}
