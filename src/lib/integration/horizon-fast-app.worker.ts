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
import { destination, EARTH_R, EnuFrame } from "#/lib/geodesy";
import { getComputeDevice } from "#/lib/gpu/device";
import { computeHorizonGpu, warmHorizonGpu } from "#/lib/gpu/horizon";
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
/**
 * Azimuths of the columns the old GPU horizon read back: 8 perspective renders, 1024 columns over 50° each,
 * every 45°. align.scorePose averages over the projected directions, so this density (denser towards each
 * render's edges, doubled in the 5° overlaps) is part of what autoAlign was tuned on.
 */
const GPU_COLUMNS = (() => {
	const out: number[] = [];
	const t = Math.tan((25 * Math.PI) / 180);
	for (let r = 0; r < 8; r++)
		for (let x = 0; x < 1024; x++)
			out.push(
				(r * 45 +
					(Math.atan((((x + 0.5) / 1024) * 2 - 1) * t) * 180) / Math.PI +
					360) %
					360,
			);
	return out;
})();

let built: Promise<{ mosaics: Mosaic[]; mosaicMs: number }> | null = null;

/**
 * The WebGPU compute device, requested as soon as the page allows it (the "spans" message, before the
 * tiles decode) so adapter/device creation and the kernel compile overlap the tile work. null = CPU.
 */
let gpu: ReturnType<typeof getComputeDevice> | null = null;

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
			const [prof] = await computeHorizonGpu(device, mosaics, [eye], opts);
			// opt-in path only (rigi.gpuHorizon=1), so this is not noise in the default app
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
	const step = j.step;
	const { prof, on } = await marchProfile(mosaics, j, eyeH);
	const t2 = performance.now();
	// ENU unit directions (x east, y north, z up) in PhotoEngine's frame. horizon-fast marches a sphere;
	// the engine's frame is WGS84 (EnuFrame, with the same k = 0.13 refraction lift), whose azimuths differ
	// by up to ~0.09° (M ≠ N). So each skyline sample goes back to its geographic point (the lat/lon
	// horizon-fast sampled, the DEM height it found) and through EnuFrame.fromGeo, exactly as the terrain
	// mesh vertices the GPU horizon rendered.
	const D = Math.PI / 180;
	const n = prof.elevation.length;
	const frame = new EnuFrame(j.lat, j.lon, 0);
	const inv2R = (1 - j.k) / (2 * EARTH_R);
	const az = new Float64Array(n); // ENU azimuth, unwrapped to within ±180° of the march azimuth (in practice < 0.1°)
	const el = new Float64Array(n); // ENU elevation, NaN where the ray found no terrain
	const v = [0, 0, 0];
	for (let i = 0; i < n; i++) {
		const a = (prof.i0 + i) * step;
		const d = prof.distance[i];
		const e0 = prof.elevation[i];
		if (!(e0 > -90) || !(d > 0)) {
			az[i] = a;
			el[i] = Number.NaN;
			continue;
		}
		const p = destination(j.lat, j.lon, a, d);
		frame.fromGeo(p.lat, p.lon, eyeH + d * (Math.tan(e0 * D) + d * inv2R), v);
		const z = v[2] - eyeH;
		const b = Math.atan2(v[0], v[1]) / D;
		az[i] = a + ((((b - a) % 360) + 540) % 360) - 180;
		el[i] = Math.atan2(z, Math.hypot(v[0], v[1])) / D;
	}
	// the profile, linearly interpolated at the GPU horizon's column azimuths (n samples cover 360°)
	const at = (m: number) => az[((m % n) + n) % n] + Math.floor(m / n) * 360;
	const out = new Float32Array(GPU_COLUMNS.length * 3);
	let k = 0;
	for (const c of GPU_COLUMNS) {
		let i = Math.floor(c / step);
		while (at(i) > c) i--;
		while (at(i + 1) <= c) i++;
		const e0 = el[((i % n) + n) % n];
		const e1 = el[(((i + 1) % n) + n) % n];
		if (Number.isNaN(e0) || Number.isNaN(e1)) continue;
		const t = Math.min(
			Math.max((c - at(i)) / Math.max(at(i + 1) - at(i), 1e-9), 0),
			1,
		);
		const e = (e0 + (e1 - e0) * t) * D;
		out[k++] = Math.sin(c * D) * Math.cos(e);
		out[k++] = Math.cos(c * D) * Math.cos(e);
		out[k++] = Math.sin(e);
	}
	let bytes = 0;
	for (const mo of mosaics) bytes += mo.data.byteLength;
	return {
		type: "dirs",
		eyeH,
		dirs: out.slice(0, k),
		stats: {
			decodeMs,
			mosaicMs,
			marchMs: t2 - t1,
			marchOn: on,
			tiles: store.tiles.size,
			mosaicMB: bytes / 1e6,
		},
	};
}

let spans: SectorSpan[] = [];
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
			if (m.gpu && !gpu) {
				gpu = getComputeDevice().then((d) => {
					if (d) warmHorizonGpu(d);
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
						true,
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
