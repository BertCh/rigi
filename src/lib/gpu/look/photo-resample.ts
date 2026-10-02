// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The look bridge's photo input, resampled on the GPU from the engine's resident photo texture
// (deck-webgpu/compute-bridge.ts LookBridge.photoTexture) instead of re-rasterising the
// HTMLImageElement through a 2D canvas (look/composite.ts photoPixels: main-thread drawImage +
// getImageData + upload).
//
// One ComputeGraph per (source format and size, destination size): the source texture (an
// rgba8unorm-srgb photo or live video texture, imported; textureLoad decodes it to linear) ->
// "photo-resample" kernel (one invocation per output pixel; the rounded mean of the sRGB-ENCODED
// bytes of the strided taps of its box footprint, which is what a canvas downscale averages;
// alpha 255) -> packed rgba8 words in 256-byte rows -> copyBufferToTexture into the destination.
// The graph has no transients, so runNow records and submits synchronously in the caller's tick:
// a consumer graph submitted afterwards sees the finished texture (queue order).
//
// Parity: tolerance level, not bit-identical to photoPixels (a browser's drawImage uses its own
// resampling filter and colour handling). The footprint is the integer box of boxFootprint, with
// at most MAX_TAPS_PER_AXIS taps per axis (a stride beyond that), level 0 only (no mips: the live
// texture has none). scripts/gpu/look-photo-resample-dawn.ts measures the kernel against the CPU
// box filter (boxResampleRgba).
import { Buffer, type Device, Texture } from "@luma.gl/core";
import { cachedGraph } from "../core/graph";
import {
	defineKernel,
	uniform,
	warmKernels,
	warmKernelsAsync,
} from "../core/kernel";
import { MAX_TAPS_PER_AXIS, packedRowWords } from "./photo-resample-math";

const GROUP = "look-photo";
const WG = 256;

const PHOTO_RESAMPLE = /* wgsl */ `
struct P { W: u32, H: u32, sw: u32, sh: u32, rowWords: u32, srgb: u32, maxTaps: u32, pad0: u32 };
fn enc(v: f32) -> f32 { return select(1.055 * pow(v, 1.0 / 2.4) - 0.055, v * 12.92, v <= 0.0031308); }
fn byte8(v: f32) -> u32 { return u32(round(clamp(v, 0.0, 1.0) * 255.0)); }
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let i = id.x;
  if (i >= prm.W * prm.H) { return; }
  let y = i / prm.W;
  let x = i - y * prm.W;
  let x0 = (x * prm.sw) / prm.W;
  let x1 = max(x0 + 1u, min(prm.sw, ((x + 1u) * prm.sw) / prm.W));
  let y0 = (y * prm.sh) / prm.H;
  let y1 = max(y0 + 1u, min(prm.sh, ((y + 1u) * prm.sh) / prm.H));
  let stepX = max(1u, (x1 - x0 + prm.maxTaps - 1u) / prm.maxTaps);
  let stepY = max(1u, (y1 - y0 + prm.maxTaps - 1u) / prm.maxTaps);
  var s = vec3<u32>(0u);
  var n = 0u;
  for (var yy = y0; yy < y1; yy += stepY) {
    for (var xx = x0; xx < x1; xx += stepX) {
      var t = textureLoad(src, vec2<i32>(i32(xx), i32(yy)), 0);
      if (prm.srgb != 0u) { t = vec4<f32>(enc(t.r), enc(t.g), enc(t.b), t.a); }
      s += vec3<u32>(byte8(t.r), byte8(t.g), byte8(t.b));
      n += 1u;
    }
  }
  let b = (s + vec3<u32>(n / 2u)) / n;
  outp[y * prm.rowWords + x] = b.r | (b.g << 8u) | (b.b << 16u) | (255u << 24u);
}
`;

const K_PHOTO_RESAMPLE = defineKernel(
	"photo-resample",
	PHOTO_RESAMPLE,
	[
		["prm", "uniform"],
		["src", "texture"],
		["outp", "storage"],
	],
	{ group: GROUP, label: "look-photo-resample" },
);

const MAX_GRAPHS = 4;
const warmDevices = new WeakSet<Device>();

/** Build the resample pipeline off the main thread (call when the render device is adopted). */
export function warmPhotoResampleAsync(device: Device): Promise<number> {
	return warmKernelsAsync(device, GROUP).then((n) => {
		warmDevices.add(device);
		return n;
	});
}

/** Source formats the kernel handles (sRGB is decoded by the load and re-encoded in the kernel). */
const SOURCE_FORMATS = ["rgba8unorm-srgb", "rgba8unorm"];

function resampleGraph(device: Device, source: Texture, w: number, h: number) {
	const sw = source.width;
	const sh = source.height;
	const srgb = source.format === "rgba8unorm-srgb";
	return cachedGraph<void>(
		device,
		GROUP,
		`${source.format}:${sw}x${sh}>${w}x${h}`,
		(g) => {
			const owned: Buffer[] = [];
			g.own(owned);
			const rowWords = packedRowWords(w);
			const params = new Uint32Array([
				w,
				h,
				sw,
				sh,
				rowWords,
				srgb ? 1 : 0,
				MAX_TAPS_PER_AXIS,
				0,
			]);
			const prm = uniform(device, params.buffer);
			const packed = device.createBuffer({
				id: "look-photo-packed",
				byteLength: rowWords * 4 * h,
				usage: Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST,
			});
			owned.push(prm, packed);
			const input = g.importTexture({
				id: "src",
				format: source.format,
				width: sw,
				height: sh,
				usage: Texture.SAMPLE,
			});
			const dst = g.importTexture({
				id: "out",
				format: "rgba8unorm",
				width: w,
				height: h,
				usage: Texture.COPY_DST,
			});
			const packedHandle = g.importBuffer("packed", packed.byteLength, packed);
			g.addKernel({
				id: "resample",
				spec: K_PHOTO_RESAMPLE,
				bindings: {
					prm: g.importBuffer(
						"prm",
						prm.byteLength,
						prm,
						Buffer.UNIFORM | Buffer.COPY_DST,
					),
					src: input,
					outp: packedHandle,
				},
				workgroups: [Math.ceil((w * h) / WG)],
			});
			g.graph.addCopyPass({
				id: "to-texture",
				resources: [
					{ buffer: packedHandle, usage: "copy-source" },
					{ texture: dst, usage: "copy-destination" },
				],
				compile: () => ({
					encode: ({ commandEncoder, getBuffer, getTexture }) =>
						commandEncoder.copyBufferToTexture({
							sourceBuffer: getBuffer(packedHandle),
							destinationTexture: getTexture(dst),
							bytesPerRow: rowWords * 4,
							rowsPerImage: h,
							size: [w, h, 1],
						}),
				}),
			});
		},
		MAX_GRAPHS,
	);
}

/**
 * Resample `source` (rgba8unorm[-srgb], SAMPLE usage) to `target` (rgba8unorm, COPY_DST, w × h) and
 * submit, synchronously. Returns false (nothing submitted) when the kernel is not ready yet (its
 * pipeline compiles off-thread; the next call finds it) or the inputs do not fit; the caller then
 * takes its CPU path for this call.
 */
export function resamplePhotoInto(
	device: Device,
	source: Texture,
	target: Texture,
): boolean {
	if (device.isLost || source.destroyed || target.destroyed) return false;
	if (source.device !== device || target.device !== device) return false;
	if (!SOURCE_FORMATS.includes(source.format) || target.format !== "rgba8unorm")
		return false;
	if (!((source.props.usage ?? 0) & Texture.SAMPLE)) return false;
	const { graph } = resampleGraph(device, source, target.width, target.height);
	if (!graph.isCompiled) {
		if (warmDevices.has(device) && !graph.isCompiling) graph.compile();
		else {
			graph.compileAsync().catch((error) => {
				console.warn("[lookgpu] photo-resample compile failed", error);
			});
			return false;
		}
	}
	void graph
		.runNow(undefined, { textures: { src: source, out: target } })
		.catch((error) => {
			console.warn("[lookgpu] photo-resample run failed", error);
		});
	return true;
}

/** Compile every photo-resample pipeline now (sync; tests and node scripts). */
export function warmPhotoResample(device: Device): number {
	const n = warmKernels(device, GROUP);
	warmDevices.add(device);
	return n;
}
