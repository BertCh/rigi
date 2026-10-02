// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Swiss-style shaded relief drawn from the DEM (design book R1 to R5, I4). Offline CPU bake (node build script, so the
 * GPU-first rule does not apply). Steps:
 *   R2  generalise: blend a light and a heavy Gaussian low-pass so the shading shows landforms, not DEM noise
 *   R1  Lambert shading, main light from 315 deg at 45 deg, with the azimuth bent locally towards the dominant slope
 *       axis where a ridge runs parallel to the light (structure tensor, one direction per landform)
 *   R3  aerial perspective: contrast and base brightness rise with elevation ("higher is brighter")
 *   R5  sky illumination: 12 azimuth horizon march, 1 - mean(sin h), darkens valleys without a directional bias
 *   R4  masks: sun tone on lit slopes only (flats masked) and a cool shade mask for shaded slopes
 * The colour (warm lit, cool shaded) is NOT baked: SheetMap multiplies the Brezine inks through these masks (I6).
 */
import { blurGrid, clamp01, gradientEN, smoothstep } from "./sheet-util";

export interface ReliefInput {
	grid: Float64Array;
	w: number;
	h: number;
	/** Ground metres per grid cell. */
	cellMetres: number;
	lakeLevel: number;
}

export interface TerrainFields {
	/** Lightly smoothed elevation (m). */
	z: Float32Array;
	/** Slope in degrees from the lightly smoothed DEM. */
	slopeDeg: Float32Array;
	/** Unit downhill direction (east, south) per cell, smoothed so hachures flow coherently. */
	downX: Float32Array;
	downY: Float32Array;
}

const LIGHT_AZIMUTH = (315 * Math.PI) / 180;
const LIGHT_ALTITUDE = (45 * Math.PI) / 180;

export function analyseTerrain(input: ReliefInput): TerrainFields {
	const { grid, w, h, cellMetres } = input;
	const z = blurGrid(grid, w, h, 1.2);
	const { gx, gy } = gradientEN(z, w, h, cellMetres);
	const slopeDeg = new Float32Array(w * h);
	for (let i = 0; i < w * h; i++)
		slopeDeg[i] = (Math.atan(Math.hypot(gx[i], gy[i])) * 180) / Math.PI;
	// downhill = -grad; gy is northward, rows run south, so downhill (east, south) = (-gx, +gy)
	const dx = new Float32Array(w * h);
	const dy = new Float32Array(w * h);
	for (let i = 0; i < w * h; i++) {
		dx[i] = -gx[i];
		dy[i] = gy[i];
	}
	const sx = blurGrid(dx, w, h, 2.5);
	const sy = blurGrid(dy, w, h, 2.5);
	for (let i = 0; i < w * h; i++) {
		const m = Math.hypot(sx[i], sy[i]) || 1;
		sx[i] /= m;
		sy[i] /= m;
	}
	return { z, slopeDeg, downX: sx, downY: sy };
}

export interface ReliefOutput {
	tone: Uint8ClampedArray;
	sun: Uint8ClampedArray;
	shade: Uint8ClampedArray;
}

export function bakeRelief(input: ReliefInput): ReliefOutput {
	const { grid, w, h, cellMetres, lakeLevel } = input;
	const n = w * h;
	// R2 generalise
	const zFine = blurGrid(grid, w, h, 2.2);
	const zCoarse = blurGrid(grid, w, h, 7);
	const zShade = new Float32Array(n);
	for (let i = 0; i < n; i++) zShade[i] = 0.62 * zFine[i] + 0.38 * zCoarse[i];
	const { gx, gy } = gradientEN(zShade, w, h, cellMetres);

	// R1 local light bend from the structure tensor of the landform-scale gradient
	const { gx: lx, gy: ly } = gradientEN(
		blurGrid(grid, w, h, 9),
		w,
		h,
		cellMetres,
	);
	const jxx = new Float32Array(n);
	const jyy = new Float32Array(n);
	const jxy = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		jxx[i] = lx[i] * lx[i];
		jyy[i] = ly[i] * ly[i];
		jxy[i] = lx[i] * ly[i];
	}
	const bxx = blurGrid(jxx, w, h, 14);
	const byy = blurGrid(jyy, w, h, 14);
	const bxy = blurGrid(jxy, w, h, 14);

	// R5 sky illumination (horizon march over the lightly generalised DEM)
	const AZIMUTHS = 12;
	const STEPS = 22;
	const skyView = new Float32Array(n);
	const dirs = Array.from({ length: AZIMUTHS }, (_, k) => {
		const a = (k / AZIMUTHS) * 2 * Math.PI;
		return [Math.cos(a), Math.sin(a)];
	});
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const z0 = zFine[y * w + x];
			let sum = 0;
			for (const [cx, cy] of dirs) {
				let tanMax = 0;
				let r = 1.5;
				for (let s = 0; s < STEPS; s++) {
					const px = Math.round(x + cx * r);
					const py = Math.round(y + cy * r);
					if (px < 0 || py < 0 || px >= w || py >= h) break;
					const t = (zFine[py * w + px] - z0) / (r * cellMetres);
					if (t > tanMax) tanMax = t;
					r *= 1.17;
				}
				sum += 1 / Math.sqrt(1 + tanMax * tanMax); // cos of horizon elevation = 1 - sin(slope-free approx)
			}
			skyView[y * w + x] = sum / AZIMUTHS;
		}

	const tone = new Uint8ClampedArray(n);
	const sun = new Uint8ClampedArray(n);
	const shade = new Uint8ClampedArray(n);
	const flat = Math.sin(LIGHT_ALTITUDE);
	for (let i = 0; i < n; i++) {
		const elev = grid[i];
		if (elev <= lakeLevel + 1.5) {
			tone[i] = 255;
			continue;
		}
		const p = gx[i] * 1.35;
		const q = gy[i] * 1.35;
		// dominant slope axis (east, north) from the tensor, as a compass angle
		const phi = 0.5 * Math.atan2(2 * bxy[i], bxx[i] - byy[i]);
		const axisCompass = Math.atan2(Math.cos(phi), -Math.sin(phi));
		const coherence =
			Math.hypot(bxx[i] - byy[i], 2 * bxy[i]) / (bxx[i] + byy[i] + 1e-9);
		let theta = LIGHT_AZIMUTH - axisCompass;
		theta =
			((((theta + Math.PI / 2) % Math.PI) + Math.PI) % Math.PI) - Math.PI / 2;
		const bendW = 0.55 * smoothstep(0.95, 1.5, Math.abs(theta)) * coherence;
		const az = LIGHT_AZIMUTH - theta * bendW;
		const nrm = Math.hypot(p, q, 1);
		const lE = Math.cos(LIGHT_ALTITUDE) * Math.sin(az);
		const lN = Math.cos(LIGHT_ALTITUDE) * Math.cos(az);
		const lambert = (-p * lE - q * lN + Math.sin(LIGHT_ALTITUDE)) / nrm;
		const d = lambert - flat; // 0 on flats; positive lit; negative shaded
		// R3 aerial perspective: contrast and brightness rise with elevation
		const hi = smoothstep(600, 2000, elev);
		const k = 0.62 + 0.75 * hi;
		const shaped = d >= 0 ? 0.5 * d : 0.72 * d;
		let v = 0.9 + 0.035 * hi + k * shaped;
		const ao = 1 - skyView[i];
		v *= 1 - 0.5 * ao * (1 - 0.4 * hi);
		tone[i] = Math.round(255 * clamp01(v));
		const steep = smoothstep(
			9,
			28,
			(Math.atan(Math.hypot(p, q)) * 180) / Math.PI,
		);
		sun[i] = Math.round(255 * clamp01(d / 0.22) * steep);
		shade[i] = Math.round(255 * clamp01((-d - 0.05) / 0.5) * steep);
	}
	return { tone, sun, shade };
}
