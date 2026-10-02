// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Skyline for the renderer via d1's src/lib/horizon-fast, run in a worker. It replaces the 8 float geometry
// renders of the old GPU horizon (1024×1536 RGBA32F each, read back synchronously). The worker marches the
// profile on the GPU by default (gpuEnabled, ?gpu=off kills it) and on the CPU otherwise.
//
//   const h = startFastHorizon({ lat, lon, az0, az1, signal })   // at init start: tiles stream in parallel
//   h.setEye(eyeH)                                                // as soon as the eye height is known
//   const r = h.take(eyeH) ?? (await h.dirs(eyeH))               // ENU unit directions, like the GPU path
//
// Tiles are fetched on the main thread through the shared tile cache and dem's fetchDemBytes (the same
// missing-tile policy as Terrain, in-flight dedupe with it, the same priority scale, 0 requests on a warm load) and transferred to a one-shot module worker. The worker
// decodes them, builds the ring mosaics and marches the profile. The main thread only posts buffers.
//
// Rings are horizon-fast's LITE_RINGS (one zoom coarser than its desktop default). That is still at least
// as fine as the terrain meshes the GPU horizon rendered (96–256 segments per 512 px tile), and it needs
// about a third of the default's mosaic memory (~60 MB for the wedge, ~116 MB for the full circle, all
// in the worker and freed when it terminates). Any failure terminates the worker and rejects `dirs()`; the
// engines then fall back to the CPU profile horizon (deck/engine.ts traceHorizon).
//
// Lifecycle: the worker is terminated after the first delivered eye, on failure, and on dispose or abort
// (including a signal that is already aborted at start). `dirs()` for an eye with no result after that
// rejects; several `dirs()` calls for one eye all resolve.
import { tilePriority } from "#/lib/cache";
import { fetchDemBytes, MAPTERHORN, type TileKey, tileId } from "#/lib/dem";
import { REFRACTION_K } from "#/lib/geodesy";
import {
	type GpuProfile,
	mergeGpuProfile,
	type RealmGpuOptions,
	realmGpuOptions,
} from "#/lib/gpu/core/realm";
import { gpuEnabled } from "#/lib/gpu/device";
import type { HorizonPrecision } from "#/lib/gpu/horizon/certified-cpu";
import { horizonPrecisionOptIn } from "#/lib/gpu/horizon/opt-in";
import {
	mergeSpotLedger,
	type SpotLedger,
	spotLedger,
} from "#/lib/gpu/precision/spot-policy";
import {
	LITE_RINGS,
	mosaicTileKeys,
	type Ring,
	type RingSpan,
	resolveRings,
} from "#/lib/horizon-fast/mosaic";

/** A ring and the azimuth sector its mosaic covers. */
export type SectorSpan = { span: RingSpan; az0: number; az1: number };

export type HorizonWorkerIn =
	| {
			type: "spans";
			spans: SectorSpan[];
			/** March on the GPU (src/lib/gpu/horizon) when the worker gets a WebGPU device. On whenever the compute device is (gpuEnabled). */
			gpu?: boolean;
			/** The page's GPU profiling / error-check switches (core/realm.ts); undefined when off. */
			gpuOpts?: RealmGpuOptions;
			/** Precision of the tan → degrees and ENU stages (horizonPrecisionOptIn()). */
			precision?: HorizonPrecision;
			/** The page's certified-f32 spot-check ledger (gpu/precision/spot-policy.ts); certified-f32 only. */
			spotLedger?: SpotLedger;
	  }
	| {
			type: "tile";
			key: TileKey;
			source: TileKey | null;
			buf: ArrayBuffer | null;
	  }
	| {
			type: "build";
			lat: number;
			lon: number;
			step: number;
			k: number;
			maxDistance: number;
			minDistance: number;
	  }
	| { type: "march"; eyeH: number };

export type HorizonStats = {
	decodeMs: number;
	mosaicMs: number;
	marchMs: number;
	tiles: number;
	mosaicMB: number;
	/** Where the profile was marched: "gpu" (src/lib/gpu/horizon) or "cpu" (horizon-fast). */
	marchOn?: "gpu" | "cpu";
	/** Only with certified-f32 precision: the certified ENU stage's columns and timing. */
	precision?: {
		mode: HorizonPrecision;
		ties: number;
		certified: number;
		gpuMs: number;
		finishMs: number;
		fellBack?: string;
		/** the ENU stage's spot check: outputs re-derived, and whether it was a full check */
		spotChecked?: number;
		spotFull?: boolean;
		/** the tan → degrees stage (gpu/horizon/certified.ts horizonElevations) of this march */
		elevations?: {
			certified: number;
			ties: number;
			spotChecked?: number;
			spotFull?: boolean;
			fellBack?: string;
		};
		/** the worker's spot-check ledger after this march (the page merges it) */
		spotLedger?: SpotLedger;
	};
};

export type HorizonWorkerOut =
	| {
			type: "dirs";
			eyeH: number;
			dirs: Float32Array;
			stats: HorizonStats;
			/** the worker's GPU pass times, when the page profiles (merged as "horizon-worker:…") */
			gpuProfile?: GpuProfile;
	  }
	| { type: "error"; error: string };

type Dirs = Extract<HorizonWorkerOut, { type: "dirs" }>;

export type FastHorizonOptions = {
	lat: number;
	lon: number;
	/** Azimuth sector that needs far terrain, in degrees clockwise from north (az1 − az0 ≥ 360 = full circle). */
	az0?: number;
	az1?: number;
	/**
	 * Rings within this distance cover the full circle anyway, like Terrain.load's wedge (`alwaysWithinM`,
	 * 3 km). The profile is always marched over 360°. align.scorePose's coverage term counts the directions
	 * in frame against all of them, so a profile of the sector alone would inflate it.
	 */
	fullWithinM?: number;
	/** Match Terrain.load's radius (120 km). */
	maxDistance?: number;
	rings?: Ring[];
	/** March azimuth step, in degrees. */
	step?: number;
	/** Refraction coefficient. 0.13 is the same as EnuFrame's lift of the terrain meshes. */
	k?: number;
	/** Nearest ground that can form the skyline, in metres (default 2: the GPU horizon's near plane was 1 m). */
	minDistance?: number;
	signal?: AbortSignal;
};

export type FastHorizonResult = {
	dirs: Float32Array;
	stats: HorizonStats & { totalMs: number };
};

export type FastHorizon = {
	/** Requests the march for this eye height. The worker pushes the result back as soon as it is done. */
	setEye(eyeH: number): void;
	/** The result for this eye height, synchronously, if the worker has already delivered it. */
	take(eyeH: number): FastHorizonResult | null;
	/** Resolves with ENU unit skyline directions (x east, y north, z up) seen from `eyeH` metres MSL. */
	dirs(eyeH: number): Promise<FastHorizonResult>;
	dispose(): void;
};

/** Stats of the latest march any fast horizon of this page delivered (harnesses: the precision gate). */
export let lastFastHorizonStats: HorizonStats | null = null;

export function startFastHorizon(o: FastHorizonOptions): FastHorizon {
	const t0 = performance.now();
	const az0 = o.az0 ?? 0;
	const az1 = o.az1 ?? 360;
	const maxDistance = o.maxDistance ?? 120_000;
	const worker = new Worker(
		new URL("./horizon-fast-app.worker.ts", import.meta.url),
		{ type: "module" },
	);
	const post = (m: HorizonWorkerIn, transfer: Transferable[] = []) =>
		worker.postMessage(m, transfer);
	// finished marches by eye height, and who waits for which
	const results = new Map<number, Dirs>();
	const waiters = new Map<
		number,
		{ resolve: (r: Dirs) => void; reject: (e: Error) => void }[]
	>();
	let failed: Error | null = null;
	let terminated = false;
	const terminate = () => {
		if (terminated) return;
		terminated = true;
		worker.terminate();
	};
	const fail = (e: unknown) => {
		failed ??= e instanceof Error ? e : new Error(String(e));
		terminate();
		for (const list of waiters.values()) for (const w of list) w.reject(failed);
		waiters.clear();
	};
	worker.onmessage = (e: MessageEvent<HorizonWorkerOut>) => {
		const m = e.data;
		if (m.type === "error") return fail(new Error(m.error));
		mergeGpuProfile("horizon-worker", m.gpuProfile);
		mergeSpotLedger(m.stats.precision?.spotLedger);
		lastFastHorizonStats = m.stats;
		results.set(m.eyeH, m);
		for (const w of waiters.get(m.eyeH) ?? []) w.resolve(m);
		waiters.delete(m.eyeH);
	};
	worker.onerror = (e) => fail(new Error(`horizon worker: ${e.message}`));

	const fetched = (async () => {
		if (o.signal?.aborted)
			throw new DOMException("Horizon disposed", "AbortError");
		const rings = await resolveRings(
			o.rings ?? LITE_RINGS,
			o.lat,
			o.lon,
			maxDistance,
		);
		const full = az1 - az0 >= 360;
		const spans: SectorSpan[] = rings.map((span) =>
			full || span.maxDistance <= (o.fullWithinM ?? 3000)
				? { span, az0: 0, az1: 360 }
				: { span, az0, az1 },
		);
		// The switches live in the page (URL, localStorage), which the worker can't read.
		const precision = horizonPrecisionOptIn();
		post({
			type: "spans",
			spans,
			gpu: gpuEnabled(),
			gpuOpts: realmGpuOptions(),
			precision,
			...(precision !== "f64" ? { spotLedger: spotLedger() } : {}),
		});
		const seen = new Set<string>();
		const keys = spans
			.flatMap((s) =>
				mosaicTileKeys(o.lat, o.lon, [s.span], MAPTERHORN.tileSize, s).map(
					(key) => ({ key, near: s.span.minDistance }),
				),
			)
			.filter(({ key }) => !seen.has(tileId(key)) && !!seen.add(tileId(key)));
		await Promise.all(
			keys.map(async ({ key, near }) => {
				// dem's policy: the Mapterhorn tile or its nearest existing ancestor (the worker crops + upsamples)
				const r = await fetchDemBytes(key, {
					signal: o.signal,
					priority: tilePriority(near, key.z),
				});
				if (o.signal?.aborted)
					throw new DOMException("Horizon disposed", "AbortError");
				// the worker is gone (failure or dispose): stop posting, and let the remaining fetches drain
				if (terminated) return;
				post(
					{ type: "tile", key, source: r?.source ?? null, buf: r?.buf ?? null },
					r ? [r.buf] : [],
				);
			}),
		);
		if (terminated) return;
		post({
			type: "build",
			lat: o.lat,
			lon: o.lon,
			step: o.step ?? 0.05,
			k: o.k ?? REFRACTION_K,
			maxDistance,
			minDistance: o.minDistance ?? 2,
		});
	})();
	fetched.catch(fail);

	const requested = new Set<number>();
	const setEye = (eyeH: number) => {
		if (failed || terminated || requested.has(eyeH)) return;
		requested.add(eyeH);
		fetched.then(() => post({ type: "march", eyeH })).catch(fail);
	};
	const finish = (r: Dirs): FastHorizonResult => {
		terminate();
		return {
			dirs: r.dirs,
			stats: { ...r.stats, totalMs: performance.now() - t0 },
		};
	};
	const dispose = () => {
		fail(new DOMException("Horizon disposed", "AbortError"));
	};
	if (o.signal?.aborted) dispose();
	else o.signal?.addEventListener("abort", dispose, { once: true });

	return {
		setEye,
		take(eyeH) {
			const r = results.get(eyeH);
			return r ? finish(r) : null;
		},
		async dirs(eyeH) {
			const r =
				results.get(eyeH) ??
				(await new Promise<Dirs>((resolve, reject) => {
					if (failed) return reject(failed);
					// the worker is gone after the first delivered eye: no later march can answer
					if (terminated)
						return reject(
							new Error(
								"horizon worker already terminated; no result for this eye",
							),
						);
					const list = waiters.get(eyeH) ?? [];
					list.push({ resolve, reject });
					waiters.set(eyeH, list);
					setEye(eyeH);
				}));
			return finish(r);
		},
		dispose,
	};
}
