// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Synthetic Terrarium-style tile sources for the horizon-fast specs: heights are a pure function of
// lon/lat, sampled at pixel centres, so a mosaic can be checked against the analytic answer.
import type { TileKey } from "../../dem";
import { DEG, destination, EARTH_R } from "../../geodesy";
import type { TileSource } from "../mosaic";

export const TILE = 64;

/** lon/lat of the centre of global pixel (gx, gy) at zoom z for tiles of `tileSize` px. */
export function pixelLonLat(
	z: number,
	tileSize: number,
	gx: number,
	gy: number,
) {
	const w = 2 ** z * tileSize;
	const lon = ((gx + 0.5) / w) * 360 - 180;
	const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (gy + 0.5)) / w))) / DEG;
	return { lon, lat };
}

export type HeightFn = (lon: number, lat: number) => number;

export function tileFromFn(k: TileKey, tileSize: number, f: HeightFn) {
	const out = new Float32Array(tileSize * tileSize);
	for (let j = 0; j < tileSize; j++)
		for (let i = 0; i < tileSize; i++) {
			const p = pixelLonLat(
				k.z,
				tileSize,
				k.x * tileSize + i,
				k.y * tileSize + j,
			);
			out[j * tileSize + i] = f(p.lon, p.lat);
		}
	return out;
}

export interface FakeSource extends TileSource {
	loads: string[];
}

/** A tile source serving `f`; `missing(k)` tiles answer null (404). Counts requests. */
export function fakeSource(
	f: HeightFn,
	opts: {
		tileSize?: number;
		maxZoom?: number;
		missing?: (k: TileKey) => boolean;
	} = {},
): FakeSource {
	const tileSize = opts.tileSize ?? TILE;
	const loads: string[] = [];
	return {
		tileSize,
		maxZoom: opts.maxZoom ?? 15,
		loads,
		async load(k) {
			loads.push(`${k.z}/${k.x}/${k.y}`);
			return opts.missing?.(k) ? null : tileFromFn(k, tileSize, f);
		},
	};
}

/** A Gaussian mountain of height `peak` (m) and radius sigma (m) at (lat, lon). */
export function gaussianPeak(
	lat: number,
	lon: number,
	peak: number,
	sigma: number,
): HeightFn {
	const mPerLat = EARTH_R * DEG;
	return (lo, la) => {
		const dy = (la - lat) * mPerLat;
		const dx = (lo - lon) * mPerLat * Math.cos(lat * DEG);
		return peak * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
	};
}

export { destination };
