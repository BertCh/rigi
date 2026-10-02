// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The basin gap's DEM (tools/matcher/dem.py's role): Mapterhorn ring mosaics around the photo, padded for
// the ±1000 m grid, and the batched GPU horizon march (src/lib/gpu/eye → src/lib/gpu/horizon: one
// invocation per (eye, azimuth) on the compute graph; the CPU march without a device). Heights and eyes are
// in the app's ENU frame (EnuFrame(lat, lon, 0): z = MSL height − (1 − k)·d²/2R, as dem.py's ground).

import { EARTH_R, REFRACTION_K } from "#/lib/geodesy";
import { arangeLen, type BasinDem, GRID_R, type Vec3 } from "./basin";

const drop = (E: number, N: number) =>
	((1 - REFRACTION_K) * (E * E + N * N)) / (2 * EARTH_R);

/** A BasinDem around (lat, lon) covering the azimuth sector [az0, az1]; release() frees the GPU copy. */
export async function loadBasinDem(
	lat: number,
	lon: number,
	sector: { az0: number; az1: number },
	o: { signal?: AbortSignal } = {},
): Promise<BasinDem & { release: () => void }> {
	const eye = await import("#/lib/gpu/eye");
	const mosaics = await eye.loadEyeMosaics(lat, lon, {
		sector,
		padMeters: GRID_R + 300,
		maxDistance: 100_000,
	});
	if (o.signal?.aborted) throw new DOMException("aborted", "AbortError");
	const hp = eye.createEyeHorizonProvider({
		lat,
		lon,
		mosaics,
		sector,
		signal: o.signal,
	});
	const ground = (E: number, N: number) => hp.ground(E, N) - drop(E, N);
	return {
		ground,
		async horizons(eyes: Vec3[], az0: number, az1: number, step: number) {
			const hs = await hp.horizonsAtEyes(
				eyes.map(([E, N, z]) => [E, N, z + drop(E, N)]),
			);
			const n = arangeLen(az0, az1 + step * 0.5, step);
			return hs.map((h) => {
				const m = h.elevation.length;
				const out = new Float64Array(n);
				for (let k = 0; k < n; k++) {
					const a = (az0 + k * step) / h.step;
					const i = Math.floor(a);
					const t = a - i;
					const e0 = h.elevation[((i % m) + m) % m];
					const e1 = h.elevation[(((i + 1) % m) + m) % m];
					out[k] =
						e0 <= -89 || e1 <= -89 ? Math.min(e0, e1) : e0 + t * (e1 - e0);
				}
				return out;
			});
		},
		release: hp.release,
	};
}
