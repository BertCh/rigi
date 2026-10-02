// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Step Inside's near-field source (../client.ts NearFieldSource: available / depth / gaussiansWithMeta),
// computed in the browser.
//   depth     → MoGe-2 ViT-S (./depth-net.ts) on the src/lib/nn runtime (WGSL kernels on one core
//               ComputeGraph per forward, on the app's WebGPU device), then ./compose.ts (focal / shift,
//               metric depth, normals, intrinsics) — the service ran MoGe-2 ViT-L in PyTorch.
//   gaussians → the depth lift (./lift-gpu.ts, a graph kernel; ./lift.ts is its CPU twin), on the cached
//               depth of the same photo. No SHARP (research-only weights) and no DA3 multiview.
// "Available" = WebGPU compute is there and the weights are reachable (public/models or the Cache
// Storage copy); the first build downloads them (the int8 file, 36 MB, by default: `nearfieldWeights`,
// depth-net.ts MOGE2_WEIGHTS; progress through onProgress and the src/lib/models download store), and
// prefetch() can fetch them into Cache Storage ahead of that. WebGPU only: the nn CPU backend is far too
// slow for the page, so without WebGPU Step Inside reports "needs WebGPU" (availability().reason).
// available() / prefetch() never throw. depth() / gaussiansWithMeta() reject with a NearFieldError
// (../client.ts) or an AbortError. One FIFO lease ("nearfield/depth") serialises the inference of
// different photos; photos in flight share one job that is cancelled only when every caller left; the
// weights and the nn runtime are released after NEARFIELD_IDLE_UNLOAD_MS without a call.
import type { Device } from "@luma.gl/core";
import { getFlag } from "#/lib/flags";
import { abortable, isAbortError } from "#/lib/gpu/core/abort";
import { GpuDeviceLostError } from "#/lib/gpu/core/lifecycle";
import { withLease } from "#/lib/gpu/core/pool";
import { GpuValidationError } from "#/lib/gpu/core/queue";
import { getComputeDevice } from "#/lib/gpu/device";
import {
	describeModelDownload,
	fetchModel,
	modelEntry,
	modelUrl,
} from "#/lib/models";
import type { Nn } from "#/lib/nn";
import { getNn, releaseNn } from "#/lib/nn/registry";
import {
	type DepthModel,
	type GaussianModel,
	NearFieldError,
	type NearFieldErrorCode,
	type NearFieldUnavailableReason,
	type RequestOpts,
} from "../client";
import type { GaussianCloud, NearFieldDepth } from "../types";
import { composeDepth } from "./compose";
import {
	cacheStorageBackend,
	type DepthCacheBackend,
	depthCacheKey,
	getCachedDepth,
	putCachedDepth,
} from "./depth-cache";
import {
	FOCAL_GRID,
	MOGE2_VITS,
	MOGE2_WEIGHTS,
	MogeDepthNet,
	type MogeWeights,
	tokenGrid,
} from "./depth-net";
import type { LiftInput } from "./lift";
import { liftGaussiansGpu } from "./lift-gpu";

/** MoGe-2 base tokens in the browser: the bottom of its range (ViT-S at 2000 measured no better). */
export const LOCAL_TOKENS = 1200;
/** The service's /depth maxSide: the depth grid's long side. */
export const LOCAL_MAX_SIDE = 1024;
/** Without a depth / gaussians call for this long the weights and the nn runtime are released. */
export const NEARFIELD_IDLE_UNLOAD_MS = 5 * 60_000;
/** The nn registry consumer (and cachedGraph group nn/nearfield) of Step Inside's depth net. */
export const NEARFIELD_NN_CONSUMER = "nearfield";
/** The FIFO lease the depth inference of every photo runs under. */
export const DEPTH_LEASE = "nearfield/depth";
export const LOCAL_DEPTH_MODEL = "moge-2-vits-normal";

export type LocalOpts = RequestOpts & {
	model?: DepthModel | GaussianModel;
	maxSide?: number;
	/** Human-readable progress ("downloading model 34 MB (12%)", "estimating depth"). */
	onProgress?: (message: string) => void;
};

export type Decoded = {
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
export async function decodePhoto(
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
	signal?: AbortSignal,
): Promise<NearFieldDepth & { focal: number; shift: number }> {
	const { nn } = net;
	signal?.throwIfAborted();
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
			signal?.throwIfAborted();
			const [z, mask, normal, points64, mask64, scale] = await Promise.all([
				nn.read(out.z),
				nn.read(out.mask),
				out.normal ? nn.read(out.normal) : null,
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
			nn.dispose(Object.values(out).filter((t) => t !== null));
		}
	} finally {
		nn.dispose(image);
	}
}

/** Everything the client touches outside itself (the spec replaces them; defaults are the real ones). */
export type LocalDeps = {
	getDevice(): Promise<Device | null>;
	getNn(device: Device): Promise<Nn | null>;
	loadNet(
		nn: Nn,
		file: string,
		onProgress: (loaded: number, total: number) => void,
	): Promise<MogeDepthNet>;
	disposeNet(net: MogeDepthNet): void;
	releaseNn(device: Device): Promise<void>;
	decode(blob: Blob, maxSide: number, tokens: number): Promise<Decoded>;
	estimate(
		net: MogeDepthNet,
		dec: Decoded,
		signal: AbortSignal,
	): Promise<NearFieldDepth>;
	lift(
		device: Device,
		inp: LiftInput,
		signal: AbortSignal,
	): Promise<GaussianCloud>;
	/** Persistent depth cache storage (./depth-cache.ts); null = none (node, private mode). */
	cache: DepthCacheBackend | null;
};

const defaultDeps: LocalDeps = {
	getDevice: () => getComputeDevice().catch(() => null),
	getNn: (device) => getNn(NEARFIELD_NN_CONSUMER, device),
	loadNet: (nn, file, onProgress) =>
		MogeDepthNet.load(nn, { file, onProgress }),
	disposeNet: (net) => net.dispose(),
	releaseNn: (device) => releaseNn(NEARFIELD_NN_CONSUMER, device),
	decode: decodePhoto,
	estimate: estimateDepth,
	lift: (device, inp, signal) =>
		liftGaussiansGpu(device, inp, undefined, signal),
	cache: cacheStorageBackend(),
};

const FAILURE_MESSAGES: Partial<Record<NearFieldErrorCode, string>> = {
	"device-lost": "the GPU was lost",
	"out-of-memory": "the GPU ran out of memory",
};

/**
 * An error of `stage` as a NearFieldError: device loss and out-of-memory keep their own code, a cancel
 * passes through, anything else gets the stage's code (the original stays as `cause`).
 */
export function toNearFieldError(
	e: unknown,
	stage: NearFieldErrorCode,
): unknown {
	if (e instanceof NearFieldError || isAbortError(e)) return e;
	let code = stage;
	if (e instanceof GpuDeviceLostError) code = "device-lost";
	else if (e instanceof GpuValidationError && e.kind === "out-of-memory")
		code = "out-of-memory";
	const detail = e instanceof Error ? e.message : String(e);
	return new NearFieldError(
		code,
		FAILURE_MESSAGES[code] ?? `${code}: ${detail}`,
		{ cause: e },
	);
}

const abortReason = (signal: AbortSignal): unknown =>
	isAbortError(signal.reason)
		? signal.reason
		: new DOMException("aborted", "AbortError");

type Loaded = { net: MogeDepthNet; nn: Nn; device: Device };
type Job = {
	promise: Promise<PhotoResult>;
	ctrl: AbortController;
	waiters: number;
};

export class LocalNearFieldClient {
	readonly tokens: number;
	/** The weights on the current nn runtime (a new runtime after a device loss or an unload reloads). */
	private loaded: { nn: Nn; p: Promise<Loaded> } | null = null;
	private reachable: { ok: boolean; at: number } | null = null;
	private photos = new WeakMap<Blob, Job>();
	/** onProgress of every caller waiting on the shared load (the first caller's is not the only one) */
	private progress = new Set<(message: string) => void>();
	private readonly weights: MogeWeights | undefined;
	private readonly deps: LocalDeps;
	private readonly idleMs: number;
	/** depth / gaussians calls in flight; the idle timer runs only at 0 */
	private inflight = 0;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		opts: {
			tokens?: number;
			weights?: MogeWeights;
			deps?: Partial<LocalDeps>;
			idleMs?: number;
		} = {},
	) {
		this.tokens = opts.tokens ?? LOCAL_TOKENS;
		this.weights = opts.weights;
		this.deps = { ...defaultDeps, ...opts.deps };
		this.idleMs = opts.idleMs ?? NEARFIELD_IDLE_UNLOAD_MS;
	}

	/** The weight file: the constructor's choice, else the `nearfieldWeights` flag (a restart flag). */
	get weightsFile(): string {
		return MOGE2_WEIGHTS[this.weights ?? getFlag("nearfieldWeights")];
	}

	/**
	 * Downloads the weights into Cache Storage ahead of the first build (bytes only: no device memory
	 * until a build loads them). A build started meanwhile joins the same download (fetchModel shares
	 * it). Resolves false on failure or abort; never throws.
	 */
	async prefetch(signal?: AbortSignal): Promise<boolean> {
		if (this.loaded) return true;
		try {
			await fetchModel(this.weightsFile, { signal });
			this.reachable = { ok: true, at: Date.now() };
			return true;
		} catch {
			return false;
		}
	}

	/** ok = WebGPU compute + reachable weights; `reason` says which is missing. Never throws. */
	async availability(
		force = false,
	): Promise<{ ok: boolean; reason?: NearFieldUnavailableReason }> {
		const device = await this.deps.getDevice().catch(() => null);
		if (!device || !(await this.deps.getNn(device).catch(() => null)))
			return { ok: false, reason: "no-webgpu" };
		if (!(await this.weightsReachable(force)))
			return { ok: false, reason: "weights-unreachable" };
		return { ok: true };
	}

	/** Same shape as the service's /health. */
	async health(force = false) {
		const a = await this.availability(force);
		const device = a.reason === "no-webgpu" ? "" : "webgpu";
		return {
			ok: a.ok,
			reason: a.reason,
			models: a.ok ? ["moge2", "lift"] : [],
			device,
			version: this.weightsFile,
		};
	}

	async available(force = false): Promise<boolean> {
		return (await this.availability(force)).ok;
	}

	/** HEAD of the weights (or their Cache Storage copy); ok cached 10 min, a miss 30 s. */
	private async weightsReachable(force: boolean): Promise<boolean> {
		const now = Date.now();
		const r = this.reachable;
		if (!force && r && now - r.at < (r.ok ? 600_000 : 30_000)) return r.ok;
		let ok = false;
		try {
			const url = modelUrl(this.weightsFile);
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

	/** The weights on the registry's runtime; shared by every caller, reloaded when the runtime changed. */
	private async load(): Promise<Loaded> {
		const device = await this.deps.getDevice().catch(() => null);
		const nn = device ? await this.deps.getNn(device).catch(() => null) : null;
		if (!device || !nn)
			throw new NearFieldError("no-webgpu", "Step Inside needs WebGPU");
		let l = this.loaded;
		if (!l || l.nn !== nn) {
			const file = this.weightsFile;
			const total = modelEntry(file)?.bytes ?? 0;
			const p = (async (): Promise<Loaded> => {
				try {
					const net = await this.deps.loadNet(nn, file, (loaded, t) => {
						const message = describeModelDownload({
							file,
							state: "downloading",
							loaded,
							total: t || total,
						});
						for (const f of this.progress) f(message);
					});
					return { net, nn, device };
				} catch (e) {
					throw toNearFieldError(e, "weights-failed");
				}
			})();
			l = { nn, p };
			this.loaded = l;
			// a failed load is retried on the next call
			p.catch(() => {
				if (this.loaded === l) this.loaded = null;
			});
		}
		return l.p;
	}

	/** Dispose the weights and release the nn runtime's GPU memory (idle unload). */
	private async unload() {
		const l = this.loaded;
		this.loaded = null;
		if (!l) return;
		try {
			const { net, device } = await l.p;
			this.deps.disposeNet(net);
			await this.deps.releaseNn(device);
		} catch {
			// a load that failed holds nothing
		}
	}

	private idleStart() {
		this.inflight++;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private idleEnd() {
		if (--this.inflight > 0) return;
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => {
			this.idleTimer = null;
			// never while a call is in flight (a timer raced with a new call)
			if (this.inflight === 0) void this.unload();
		}, this.idleMs);
		// do not keep a node process alive for the unload
		(this.idleTimer as { unref?: () => void }).unref?.();
	}

	/**
	 * Run `fn` for one caller: its signal combines opts.signal and opts.timeoutMs (a timeout rejects with
	 * NearFieldError("timeout")), and the call counts as activity for the idle unload.
	 */
	private async caller<T>(
		opts: LocalOpts,
		fn: (signal: AbortSignal) => Promise<T>,
	): Promise<T> {
		const ctrl = new AbortController();
		const { signal: outer, timeoutMs } = opts;
		const onOuter = () => ctrl.abort(abortReason(outer as AbortSignal));
		let timer: ReturnType<typeof setTimeout> | null = null;
		if (outer?.aborted) onOuter();
		else outer?.addEventListener("abort", onOuter, { once: true });
		if (timeoutMs !== undefined && timeoutMs > 0)
			timer = setTimeout(
				() =>
					ctrl.abort(
						new NearFieldError("timeout", `timed out after ${timeoutMs} ms`),
					),
				timeoutMs,
			);
		this.idleStart();
		try {
			return await fn(ctrl.signal);
		} finally {
			if (timer) clearTimeout(timer);
			outer?.removeEventListener("abort", onOuter);
			this.idleEnd();
		}
	}

	/** One shared job per photo blob; a caller leaving rejects only that caller. */
	private photo(
		blob: Blob,
		opts: LocalOpts,
		signal: AbortSignal,
	): Promise<PhotoResult> {
		let job = this.photos.get(blob);
		if (!job) {
			const ctrl = new AbortController();
			const created: Job = {
				ctrl,
				waiters: 0,
				promise: this.runJob(blob, opts, ctrl.signal),
			};
			job = created;
			this.photos.set(blob, created);
			// a failed or cancelled job is dropped so the next call retries
			created.promise.catch(() => {
				if (this.photos.get(blob) === created) this.photos.delete(blob);
			});
		}
		const j = job;
		j.waiters++;
		const onAbort = () => {
			if (--j.waiters > 0) return;
			// every waiting caller left: cancel the job and let the next call start a new one
			if (this.photos.get(blob) === j) this.photos.delete(blob);
			j.ctrl.abort(abortReason(signal));
		};
		let left = false;
		const leave = () => {
			if (left) return;
			left = true;
			signal.removeEventListener("abort", onAbort);
		};
		if (signal.aborted) {
			left = true;
			onAbort();
		} else signal.addEventListener("abort", onAbort, { once: true });
		return abortable(j.promise, signal).finally(leave);
	}

	/** The persistent cache key of this photo + weights + grid + tokens, or null (flag off, no storage / crypto). */
	private async depthCacheKey(
		blob: Blob,
		opts: LocalOpts,
	): Promise<string | null> {
		if (!this.deps.cache || getFlag("nearfieldDepthCache") === "off")
			return null;
		return depthCacheKey(blob, {
			weights: this.weightsFile,
			size: opts.maxSide ?? LOCAL_MAX_SIDE,
			tokens: this.tokens,
		});
	}

	/** A stored depth: no weight load, no inference; the lift's rgba comes from decoding the blob. */
	private async depthCacheHit(
		blob: Blob,
		opts: LocalOpts,
		key: string | null,
	): Promise<PhotoResult | null> {
		if (!key) return null;
		const cached = await getCachedDepth(key, { backend: this.deps.cache });
		if (!cached) return null;
		try {
			const dec = await this.deps.decode(
				blob,
				opts.maxSide ?? LOCAL_MAX_SIDE,
				this.tokens,
			);
			if (dec.width !== cached.width || dec.height !== cached.height)
				return null;
			opts.onProgress?.("Depth from the local cache");
			return { depth: cached, rgba: dec.rgba };
		} catch {
			return null;
		}
	}

	private async runJob(
		blob: Blob,
		opts: LocalOpts,
		signal: AbortSignal,
	): Promise<PhotoResult> {
		const cacheKey = await this.depthCacheKey(blob, opts);
		const hit = await this.depthCacheHit(blob, opts, cacheKey);
		if (hit) return hit;
		const onProgress = opts.onProgress;
		if (onProgress) this.progress.add(onProgress);
		const { net } = await this.load().finally(() => {
			if (onProgress) this.progress.delete(onProgress);
		});
		signal.throwIfAborted();
		opts.onProgress?.("Estimating depth (MoGe-2)");
		// one photo's inference at a time on the device (the weight load above is shared and unleased)
		return withLease(
			DEPTH_LEASE,
			async () => {
				try {
					const dec = await this.deps.decode(
						blob,
						opts.maxSide ?? LOCAL_MAX_SIDE,
						this.tokens,
					);
					signal.throwIfAborted();
					const depth = await this.deps.estimate(net, dec, signal);
					if (cacheKey)
						void putCachedDepth(cacheKey, depth as never, {
							backend: this.deps.cache,
						});
					return { depth, rgba: dec.rgba };
				} catch (e) {
					throw toNearFieldError(e, "inference-failed");
				}
			},
			{ signal },
		);
	}

	/** MoGe-2 ViT-S depth for the photo (the `model` option is ignored: there is one depth model). */
	async depth(
		image: Blob,
		opts: LocalOpts = {},
	): Promise<NearFieldDepth | null> {
		return this.caller(
			opts,
			async (signal) => (await this.photo(image, opts, signal)).depth,
		);
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
		return this.caller(opts, async (signal) => {
			const { depth, rgba } = await this.photo(image, opts, signal);
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
			signal.throwIfAborted();
			let cloud: GaussianCloud;
			try {
				const device = await this.deps.getDevice().catch(() => null);
				if (!device)
					throw new NearFieldError("no-webgpu", "Step Inside needs WebGPU");
				cloud = await abortable(this.deps.lift(device, inp, signal), signal);
			} catch (e) {
				throw toNearFieldError(e, "lift-failed");
			}
			return {
				cloud,
				meta: { width: depth.width, height: depth.height, intrinsicsNorm: K },
			};
		});
	}
}

/** The shared in-browser client (Step Inside's default). */
export const localNearField = new LocalNearFieldClient();
