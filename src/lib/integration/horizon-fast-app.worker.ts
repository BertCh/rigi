// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/// <reference lib="webworker" />
// Worker half of horizon-fast-app.ts. It decodes the Terrarium tiles that the main thread fetched through
// the shared tile cache into a horizon-fast TileStore. It then builds the ring mosaics (with max-mips),
// marches the 360° skyline for each requested eye height and pushes the directions back. One job per
// worker; the main thread terminates it afterwards.
import {
	ancestorCrop,
	blobHeights,
	MAPTERHORN,
	type TileKey,
	tileId,
	validateTile,
} from "#/lib/dem";
import { applyRealmGpuOptions, takeGpuProfile } from "#/lib/gpu/core/realm";
import { getComputeDevice } from "#/lib/gpu/device";
import {
	certElevationStats,
	computeHorizonGpu,
	warmHorizonGpu,
} from "#/lib/gpu/horizon";
import {
	type HorizonPrecision,
	skylineDirs,
	warmCertifiedAsync,
} from "#/lib/gpu/horizon/certified";
import { mergeSpotLedger, spotLedger } from "#/lib/gpu/precision/spot-policy";
import {
	computeHorizonFast,
	type FastHorizonOptions,
	type FastHorizonProfile,
} from "#/lib/horizon-fast/march";
import {
	buildMosaic,
	type Mosaic,
	ringWindow,
	TileStore,
} from "#/lib/horizon-fast/mosaic";
import type {
	HorizonWorkerIn,
	HorizonWorkerOut,
	SectorSpan,
} from "./horizon-fast-app";

const scope = self as unknown as DedicatedWorkerGlobalScope;

const T = MAPTERHORN.tileSize;
const store = new TileStore(
	{ tileSize: T, maxZoom: 30, load: async () => null },
	false,
);
const decodes: Promise<void>[] = [];
let decodeMs = 0;

/** Decoded + validated source tiles by id: an ancestor standing in for several missing tiles decodes once. */
const sources = new Map<string, Promise<Float32Array>>();

async function decode(
	key: TileKey,
	source: TileKey | null,
	buf: ArrayBuffer | null,
) {
	if (!buf || !source) {
		store.tiles.set(tileId(key), null);
		return;
	}
	const t0 = performance.now();
	let src = sources.get(tileId(source));
	if (!src) {
		// validateTile repairs the 256 m R-channel decode corruption (horizon-fast README / deck.gl #10400)
		src = blobHeights(new Blob([buf])).then((h) => {
			validateTile(h, Math.round(Math.sqrt(h.length)));
			return h;
		});
		sources.set(tileId(source), src);
	}
	// a missing tile is its nearest ancestor's quadrant, bilinear-upsampled to the store's tile size
	store.tiles.set(tileId(key), ancestorCrop(await src, source, key, T));
	decodeMs += performance.now() - t0;
}

type Job = Extract<HorizonWorkerIn, { type: "build" }>;
let job: Job | null = null;

let built: Promise<{ mosaics: Mosaic[]; mosaicMs: number }> | null = null;

/**
 * The WebGPU compute device, requested as soon as the page allows it (the "spans" message, before the
 * tiles decode) so adapter/device creation and the kernel compile overlap the tile work. null = CPU.
 */
let gpu: ReturnType<typeof getComputeDevice> | null = null;
/** The tan → degrees and ENU stages' precision (horizonPrecisionOptIn: certified-f32 needs the GPU march). */
let precision: HorizonPrecision = "f64";

/** The profile on the GPU (src/lib/gpu/horizon, parity-checked against this CPU march), else the CPU. */
async function marchProfile(
	mosaics: Mosaic[],
	j: Job,
	eyeH: number,
): Promise<{ prof: FastHorizonProfile; on: "gpu" | "cpu" }> {
	const eye = { lat: j.lat, lon: j.lon, h: eyeH };
	const opts: FastHorizonOptions = {
		step: j.step,
		k: j.k,
		maxDistance: j.maxDistance,
		minDistance: j.minDistance,
		noRidges: true,
	};
	const device = gpu ? await gpu : null;
	if (device)
		try {
			const [prof] = await computeHorizonGpu(device, mosaics, [eye], {
				...opts,
				precision,
			});
			// per-march log is dev-only
			if (import.meta.env?.DEV)
				console.info(
					`[horizon worker] marched on the GPU (${prof.stats.ms.toFixed(0)} ms)`,
				);
			return { prof, on: "gpu" };
		} catch (e) {
			console.warn("[horizon worker] GPU march failed, using the CPU", e);
			gpu = null;
		}
	return { prof: computeHorizonFast(mosaics, eye, opts), on: "cpu" };
}

async function march(
	mosaics: Mosaic[],
	j: Job,
	eyeH: number,
	mosaicMs: number,
): Promise<Extract<HorizonWorkerOut, { type: "dirs" }>> {
	const t1 = performance.now();
	const { prof, on } = await marchProfile(mosaics, j, eyeH);
	const t2 = performance.now();
	// ENU unit directions in the renderer's frame (gpu/horizon/dirs-cpu.ts: the f64 stage, moved there
	// verbatim; certified-f32 gives the same bits through the GPU plus the f64 tie path)
	const device = on === "gpu" && gpu ? await gpu : null;
	// this march's tan → degrees stage stats (certified-f32 requests only; per profile, since several
	// eye heights can march at once in this worker)
	const elev = on === "gpu" ? certElevationStats.get(prof) : undefined;
	const { dirs, stats: cert } = await skylineDirs(
		device,
		prof,
		j,
		eyeH,
		on === "gpu" ? precision : "f64",
	);
	if (import.meta.env?.DEV && cert.precision !== "f64")
		console.info(
			`[horizon worker] ${cert.precision} directions: ${cert.certified} certified, ${cert.ties} ties` +
				(cert.fellBack ? ` (fell back: ${cert.fellBack})` : ""),
		);
	let bytes = 0;
	for (const mo of mosaics) bytes += mo.data.byteLength;
	// profiling only (undefined, nothing awaited, when the page does not profile)
	const pending = takeGpuProfile();
	const gpuProfile = pending && (await pending);
	return {
		type: "dirs",
		...(gpuProfile ? { gpuProfile } : {}),
		eyeH,
		dirs,
		stats: {
			decodeMs,
			mosaicMs,
			marchMs: t2 - t1,
			marchOn: on,
			tiles: store.tiles.size,
			mosaicMB: bytes / 1e6,
			...(cert.precision !== "f64"
				? {
						precision: {
							mode: cert.precision,
							ties: cert.ties,
							certified: cert.certified,
							gpuMs: cert.gpuMs,
							finishMs: cert.finishMs,
							...(cert.fellBack ? { fellBack: cert.fellBack } : {}),
							...(cert.spotChecked !== undefined
								? { spotChecked: cert.spotChecked, spotFull: cert.spotFull }
								: {}),
							...(elev
								? {
										elevations: {
											certified: elev.certified,
											ties: elev.ties,
											spotChecked: elev.spotChecked,
											spotFull: elev.spotFull,
											...(elev.fellBack ? { fellBack: elev.fellBack } : {}),
										},
									}
								: {}),
							spotLedger: spotLedger(),
						},
					}
				: {}),
		},
	};
}

let spans: SectorSpan[] = [];
/** CPU max-mips are skipped when the GPU march builds them ; a CPU march still builds them lazily. */
let cpuMips = true;
const sent = new Set<number>();
const send = (res: Extract<HorizonWorkerOut, { type: "dirs" }>) => {
	sent.add(res.eyeH);
	scope.postMessage(res, [res.dirs.buffer]);
};

scope.onmessage = async (e: MessageEvent<HorizonWorkerIn>) => {
	const m = e.data;
	try {
		if (m.type === "spans") {
			spans = m.spans;
			cpuMips = !m.gpu;
			precision = m.precision ?? "f64";
			mergeSpotLedger(m.spotLedger);
			applyRealmGpuOptions(m.gpuOpts);
			if (m.gpu && !gpu) {
				gpu = getComputeDevice().then((d) => {
					if (d) warmHorizonGpu(d);
					if (d && precision !== "f64") void warmCertifiedAsync(d);
					return d;
				});
				gpu.catch(() => {});
			}
		} else if (m.type === "tile") decodes.push(decode(m.key, m.source, m.buf));
		else if (m.type === "build") {
			const j = m;
			job = j;
			built = (async () => {
				await Promise.all(decodes);
				const t0 = performance.now();
				const mosaics = spans.map((s) =>
					buildMosaic(
						store,
						ringWindow(j.lat, j.lon, s.span, store.tileSize, s.az0, s.az1),
						s.span,
						j.lat,
						cpuMips,
					),
				);
				return { mosaics, mosaicMs: performance.now() - t0 };
			})();
		} else if (m.type === "march") {
			if (!built || !job) throw new Error("march before build");
			const { mosaics, mosaicMs } = await built;
			if (!sent.has(m.eyeH)) {
				const res = await march(mosaics, job, m.eyeH, mosaicMs);
				if (!sent.has(m.eyeH)) send(res);
			}
		}
	} catch (err) {
		scope.postMessage({
			type: "error",
			error: String((err as Error)?.stack ?? err),
		} satisfies HorizonWorkerOut);
	}
};
