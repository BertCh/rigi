// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside without the near-field service: the same surface as ../client.ts NearFieldClient
// (available / depth / gaussiansWithMeta), computed in the browser.
//   depth     → MoGe-2 ViT-S (./depth-net.ts) on the src/lib/nn runtime (WGSL kernels on one core
//               ComputeGraph per forward, on the app's WebGPU device), then ./compose.ts (focal / shift,
//               metric depth, normals, intrinsics) — the service ran MoGe-2 ViT-L in PyTorch.
//   gaussians → the depth lift (./lift-gpu.ts, a graph kernel; ./lift.ts is its CPU twin), on the cached
//               depth of the same photo. No SHARP (research-only weights) and no /multiview.
// "Available" = WebGPU compute is there and the weights are reachable (public/models or the Cache
// Storage copy); the first build downloads them (70 MB, progress through onProgress and the
// src/lib/models download store). The nn CPU backend runs the same forward (specs, node parity), far
// too slowly for the page, so without WebGPU Step Inside reports "needs WebGPU".
// Never throws: failures resolve false / null like the HTTP client.
import type { Device } from "@luma.gl/core";
import { getComputeDevice } from "#/lib/gpu/device";
import { describeModelDownload, modelEntry, modelUrl } from "#/lib/models";
import type { Nn } from "#/lib/nn";
import type { DepthModel, GaussianModel, RequestOpts } from "../client";
import type { GaussianCloud, NearFieldDepth } from "../types";
import { composeDepth } from "./compose";
import { FOCAL_GRID, MOGE2_VITS, MogeDepthNet, tokenGrid } from "./depth-net";
import { type LiftInput, liftGaussiansCpu } from "./lift";
import { liftGaussiansGpu } from "./lift-gpu";

/** MoGe-2 base tokens in the browser: the bottom of its range (ViT-S at 2000 measured no better). */
export const LOCAL_TOKENS = 1200;
/** The service's /depth maxSide: the depth grid's long side. */
export const LOCAL_MAX_SIDE = 1024;
export const LOCAL_DEPTH_MODEL = "moge-2-vits-normal";

export type LocalOpts = RequestOpts & {
	model?: DepthModel | GaussianModel;
	maxSide?: number;
	/** Human-readable progress ("downloading model 34 MB (12%)", "estimating depth"). */
	onProgress?: (message: string) => void;
};

type Decoded = {
	width: number;
	height: number;
	/** RGBA on the depth grid */
	rgba: Uint8ClampedArray;
	/** [3, 14·bh, 14·bw] RGB 0..1, the network input */
	planes: Float32Array;
	bh: number;
	bw: number;
};

type PhotoResult = { depth: NearFieldDepth; rgba: Uint8ClampedArray };

/** Long side → the depth grid (the service's decode_image: round(w · s), s = maxSide / long side ≤ 1). */
export function depthGridSize(
	w: number,
	h: number,
	maxSide = LOCAL_MAX_SIDE,
): [number, number] {
	const s = Math.min(1, maxSide / Math.max(w, h));
	return [Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))];
}

function canvas2d(w: number, h: number) {
	const c = new OffscreenCanvas(w, h);
	const ctx = c.getContext("2d", { willReadFrequently: true });
	if (!ctx) throw new Error("nearfield: no 2d context");
	ctx.imageSmoothingEnabled = true;
	ctx.imageSmoothingQuality = "high";
	return ctx;
}

/** Decode (EXIF orientation applied), the depth-grid RGBA and the network input planes. */
async function decodePhoto(
	blob: Blob,
	maxSide: number,
	tokens: number,
): Promise<Decoded> {
	const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
	try {
		const [width, height] = depthGridSize(bmp.width, bmp.height, maxSide);
		const g = canvas2d(width, height);
		g.drawImage(bmp, 0, 0, width, height);
		const rgba = g.getImageData(0, 0, width, height).data;
		const [bh, bw] = tokenGrid(tokens, width / height);
		const ih = bh * MOGE2_VITS.patch;
		const iw = bw * MOGE2_VITS.patch;
		const m = canvas2d(iw, ih);
		m.drawImage(bmp, 0, 0, iw, ih);
		const px = m.getImageData(0, 0, iw, ih).data;
		const n = iw * ih;
		const planes = new Float32Array(3 * n);
		for (let k = 0; k < n; k++) {
			planes[k] = px[4 * k] / 255;
			planes[n + k] = px[4 * k + 1] / 255;
			planes[2 * n + k] = px[4 * k + 2] / 255;
		}
		return { width, height, rgba, planes, bh, bw };
	} finally {
		bmp.close();
	}
}

/** The network + post-processing on decoded planes (also the node parity path). */
export async function estimateDepth(
	net: MogeDepthNet,
	input: {
		planes: Float32Array;
		bh: number;
		bw: number;
		width: number;
		height: number;
	},
): Promise<NearFieldDepth & { focal: number; shift: number }> {
	const { nn } = net;
	const t0 = performance.now();
	const { planes, bh, bw, width, height } = input;
	const image = nn.fromArray(planes, [
		1,
		3,
		bh * MOGE2_VITS.patch,
		bw * MOGE2_VITS.patch,
	]);
	try {
		const out = await net.run(image, width / height, [height, width]);
		try {
			const [z, mask, normal, points64, mask64, scale] = await Promise.all([
				nn.read(out.z),
				nn.read(out.mask),
				nn.read(out.normal),
				nn.read(out.points64),
				nn.read(out.mask64),
				nn.read(out.metricScale),
			]);
			return composeDepth(
				{
					width,
					height,
					z,
					mask,
					normal,
					points64,
					mask64,
					focalGrid: FOCAL_GRID,
					metricScale: scale[0],
				},
				LOCAL_DEPTH_MODEL,
				(performance.now() - t0) / 1000,
			);
		} finally {
			nn.dispose(Object.values(out));
		}
	} finally {
		nn.dispose(image);
	}
}

export class LocalNearFieldClient {
	readonly tokens: number;
	private loaded: Promise<{
		net: MogeDepthNet;
		device: Device | null;
	} | null> | null = null;
	private reachable: { ok: boolean; at: number } | null = null;
	private gpuNn: { device: Device; nn: Promise<Nn | null> } | null = null;
	private photos = new WeakMap<Blob, Promise<PhotoResult | null>>();

	constructor(opts: { tokens?: number } = {}) {
		this.tokens = opts.tokens ?? LOCAL_TOKENS;
	}

	/** Same shape as the service's /health. ok = WebGPU compute + reachable weights. */
	async health(force = false) {
		const device = await getComputeDevice().catch(() => null);
		const ok =
			!!device &&
			!!(await this.nnFor(device)) &&
			(await this.weightsReachable(force));
		return {
			ok,
			models: ok ? ["moge2", "lift"] : [],
			device: device ? "webgpu" : "",
			version: MOGE2_VITS.file,
		};
	}

	async available(force = false): Promise<boolean> {
		return (await this.health(force)).ok;
	}

	/** HEAD of the weights (or their Cache Storage copy); ok cached 10 min, a miss 30 s. */
	private async weightsReachable(force: boolean): Promise<boolean> {
		const now = Date.now();
		const r = this.reachable;
		if (!force && r && now - r.at < (r.ok ? 600_000 : 30_000)) return r.ok;
		let ok = false;
		try {
			const url = modelUrl(MOGE2_VITS.file);
			if (typeof caches !== "undefined") {
				const { MODEL_CACHE } = await import("#/lib/models");
				ok = !!(await (await caches.open(MODEL_CACHE)).match(url));
			}
			if (!ok) {
				const res = await fetch(url, { method: "HEAD" });
				ok = res.ok;
			}
		} catch {
			ok = false;
		}
		this.reachable = { ok, at: Date.now() };
		return ok;
	}

	/** The nn GPU backend on `device` (null when it cannot be created: no WebGPU kernels → unavailable). */
	private nnFor(device: Device): Promise<Nn | null> {
		if (this.gpuNn?.device !== device) {
			const nn = import("#/lib/nn")
				.then(({ createNn }) => createNn({ device, backend: "gpu" }))
				.catch((e) => {
					console.warn("[nearfield] no nn GPU backend", e);
					return null;
				});
			this.gpuNn = { device, nn };
		}
		return this.gpuNn.nn;
	}

	private load(onProgress?: (message: string) => void) {
		if (!this.loaded) {
			const p = (async () => {
				const device = await getComputeDevice();
				if (!device) return null;
				const nn = await this.nnFor(device);
				if (!nn) return null;
				const total = modelEntry(MOGE2_VITS.file)?.bytes ?? 0;
				const net = await MogeDepthNet.load(nn, {
					onProgress: (loaded, t) =>
						onProgress?.(
							describeModelDownload({
								file: MOGE2_VITS.file,
								state: "downloading",
								loaded,
								total: t || total,
							}),
						),
				});
				return { net, device };
			})();
			this.loaded = p;
			// a failed load is retried on the next call
			p.then((r) => {
				if (!r && this.loaded === p) this.loaded = null;
			}).catch(() => {
				if (this.loaded === p) this.loaded = null;
			});
		}
		return this.loaded;
	}

	private photo(blob: Blob, opts: LocalOpts): Promise<PhotoResult | null> {
		let p = this.photos.get(blob);
		if (!p) {
			p = (async () => {
				const loaded = await this.load(opts.onProgress);
				if (!loaded || opts.signal?.aborted) return null;
				opts.onProgress?.("Estimating depth (MoGe-2)");
				const dec = await decodePhoto(
					blob,
					opts.maxSide ?? LOCAL_MAX_SIDE,
					this.tokens,
				);
				if (opts.signal?.aborted) return null;
				const depth = await estimateDepth(loaded.net, dec);
				return { depth, rgba: dec.rgba };
			})().catch((e) => {
				console.warn("[nearfield] local depth failed", e);
				return null;
			});
			this.photos.set(blob, p);
			p.then((r) => {
				if (!r) this.photos.delete(blob);
			});
		}
		return p;
	}

	/** MoGe-2 ViT-S depth for the photo (the `model` option is ignored: there is one depth model). */
	async depth(
		image: Blob,
		opts: LocalOpts = {},
	): Promise<NearFieldDepth | null> {
		return (await this.photo(image, opts))?.depth ?? null;
	}

	async gaussians(
		image: Blob,
		opts: LocalOpts = {},
	): Promise<GaussianCloud | null> {
		return (await this.gaussiansWithMeta(image, opts))?.cloud ?? null;
	}

	/** The depth lift (stride 2, edge ratio 1.5: the service's /gaussians defaults) in the depth's camera. */
	async gaussiansWithMeta(
		image: Blob,
		opts: LocalOpts = {},
	): Promise<{
		cloud: GaussianCloud;
		meta: {
			width: number;
			height: number;
			intrinsicsNorm?: { fx: number; fy: number; cx: number; cy: number };
		};
	} | null> {
		const r = await this.photo(image, opts);
		if (!r || opts.signal?.aborted) return null;
		const { depth, rgba } = r;
		const K = depth.intrinsicsNorm;
		if (!K) return null;
		const inp: LiftInput = {
			width: depth.width,
			height: depth.height,
			depth: depth.depth,
			valid: depth.valid,
			normal: depth.normal ?? null,
			rgba,
			K,
		};
		try {
			const device = (await this.loaded)?.device ?? null;
			const cloud = device
				? await liftGaussiansGpu(device, inp)
				: liftGaussiansCpu(inp);
			return {
				cloud,
				meta: { width: depth.width, height: depth.height, intrinsicsNorm: K },
			};
		} catch (e) {
			console.warn("[nearfield] GPU lift failed, using the CPU twin", e);
			return {
				cloud: liftGaussiansCpu(inp),
				meta: { width: depth.width, height: depth.height, intrinsicsNorm: K },
			};
		}
	}

	/** /multiview (DA3) has no browser port: the roll spot uses per-photo depth instead. */
	async multiview(): Promise<null> {
		return null;
	}
}

/** The shared in-browser client (Step Inside's default). */
export const localNearField = new LocalNearFieldClient();
