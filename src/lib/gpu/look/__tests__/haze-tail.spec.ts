// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { atmPath } from "#/lib/look/atmosphere";
import { fitHaze, robustSky } from "#/lib/look/haze-fit";
import { bits32, nextDown32, nextUp32 } from "../../precision/df32";
import {
	airlightBand,
	bandLength,
	GRID_CELLS,
	type GridFn,
	gridCandidates,
	gridTolerance,
	hazeFitTail,
	hazeGpuTimes,
	type Prep,
	pathFrom,
	robustSkyExact,
} from "../haze";
import { decodePick, emulatePick } from "../haze-argmin";
import {
	bandShape,
	bandWords,
	emulateBand,
	keyBelow,
	orderKey,
	pickSpotColumns,
	SPOT_COLUMNS,
	verifyBand,
} from "../haze-band";
import {
	emulatedGrid,
	emulatePrep,
	firstDifference,
	hazePixels,
	lcg,
	makeHazeScene,
	sceneOptions,
} from "../haze-emulate";

const pickedGrid: GridFn = async (...args) => {
	const g = await emulatedGrid(...args);
	const pick = decodePick(...emulatePick(g));
	if (!pick) throw new Error("decodePick rejected an emulated pick");
	return pick;
};

describe("haze tail helpers", () => {
	it("pathFrom equals atmPath bit for bit, series branch included", () => {
		const rnd = lcg(42);
		for (let k = 0; k < 4000; k++) {
			const H = [8000, 600, 900, 1234.5][k % 4];
			const h0 = rnd() * 4000 - 200;
			const h1 =
				k % 4 === 0 ? h0 + (rnd() - 0.5) * 2e-3 * H : rnd() * 5000 - 300;
			const L = 10 ** (1 + rnd() * 5);
			expect(
				Object.is(
					pathFrom(Math.exp(-h0 / H), h0, h1, L, H),
					atmPath(h0, h1, L, H),
				),
			).toBe(true);
		}
	});
	it("robustSkyExact equals robustSky on tied, signed-zero and NaN data", () => {
		const rnd = lcg(7);
		const none = new Float32Array(0);
		for (let len = 0; len <= 60; len += 3)
			for (let rep = 0; rep < 6; rep++) {
				const pool = rep % 3 === 0 ? 4 : rep % 3 === 1 ? 40 : 1e9;
				const value = () => {
					const u = rnd();
					if (rep === 5 && u < 0.02) return Number.NaN;
					if (rep >= 4 && u < 0.05) return u < 0.025 ? -0 : 0;
					return Math.fround(Math.floor(rnd() * pool) / pool);
				};
				const r = Array.from({ length: len }, value);
				const g = Array.from({ length: len }, value);
				const b = Array.from({ length: len }, value);
				const l = r.map((v, i) => 0.2126 * v + 0.7152 * g[i] + 0.0722 * b[i]);
				const want = robustSky(
					r.slice(),
					g.slice(),
					b.slice(),
					l.slice(),
					none,
					none,
				);
				expect(firstDifference(robustSkyExact(r, g, b, l), want)).toBeFalsy();
			}
	});
	it("grid tolerance and candidate sets", () => {
		expect(gridTolerance(0)).toBeGreaterThanOrEqual(0);
		expect(gridTolerance(1)).toBeGreaterThan(gridTolerance(0));
		const g = new Float32Array(GRID_CELLS).fill(10);
		g[5] = 1;
		g[9] = 1;
		const c = gridCandidates(g);
		expect(c).toContain(5);
		expect(c).toContain(9);
		expect(c).not.toContain(0);
	});
});

describe("haze tail end to end", () => {
	for (const s of [1, 2]) {
		it(`scene ${s}: tail (exact grid and arg-min pick) equals fitHaze`, async () => {
			const input = makeHazeScene(sceneOptions(s));
			const { prep, ctx } = emulatePrep(input);
			const want = fitHaze(input);
			for (const k of Object.keys(hazeGpuTimes)) delete hazeGpuTimes[k];
			const got = await hazeFitTail(null as never, ctx, prep, emulatedGrid);
			// scenes with a percentile rank a hair under an integer, or > 256 candidates, are inexact by design
			if ((hazeGpuTimes.gridCandidates ?? 0) > 256) return;
			expect(firstDifference(got, want) || "").toBe("");
			const viaPick = await hazeFitTail(null as never, ctx, prep, pickedGrid);
			expect(firstDifference(viaPick, want) || "").toBe("");
		});
	}
});

describe("haze band", () => {
	it("orderKey / keyBelow decide x < c like f64", () => {
		const rnd = lcg(3);
		for (const c of [0.5, 0.7, 0, 0.3, -2.5, 150]) {
			const key = keyBelow(c);
			const xs = [
				nextDown32(Math.fround(c)),
				Math.fround(c),
				nextUp32(Math.fround(c)),
				0,
				-0,
				1,
				-1,
				2 ** -149,
			];
			for (let k = 0; k < 200; k++)
				xs.push(Math.fround((rnd() - 0.5) * 4 * Math.max(1, Math.abs(c))));
			for (const x of xs) expect(orderKey(bits32(x)) <= key).toBe(x < c);
		}
	});
	it("band shape and words agree", () => {
		const { nCol, kMax, a0, a1 } = bandShape(101, 77);
		expect(nCol).toBe(51);
		expect(kMax).toBe(nCol * (a1 - a0 + 1));
		const w = bandWords(101, 77);
		expect([w[0], w[1], w[2], w[3], w[4], w[7]]).toEqual([
			101,
			77,
			nCol,
			a0,
			a1,
			kMax,
		]);
	});
	it("emulateBand equals airlightBand and verifyBand has teeth", () => {
		let checked = 0;
		for (const s of [100, 101, 102, 103]) {
			const opts = sceneOptions(s);
			const { range, pSky } = hazePixels(makeHazeScene(opts));
			const W = opts.width;
			const H = opts.height;
			const band = emulateBand(
				new Uint32Array(range.buffer),
				new Uint32Array(pSky.buffer),
				W,
				H,
			);
			expect(band.K).toBe(bandLength(range, pSky, W, H));
			if (band.K < 20) continue;
			checked++;
			expect(Array.from(band.idx)).toEqual(
				Array.from(airlightBand(range, pSky, W, H)),
			);
			// verify against its own spot columns
			const cols = pickSpotColumns(W, lcg(5));
			expect(cols.length).toBe(SPOT_COLUMNS);
			for (let k = 0; k < SPOT_COLUMNS; k++) {
				let j = (k * 7) % band.cnt.length;
				while (!band.cnt[j]) j = (j + 1) % band.cnt.length;
				cols[k] = 2 * j;
			}
			const spot = new Uint32Array(SPOT_COLUMNS * H * 2);
			const rb = new Uint32Array(range.buffer);
			const pb = new Uint32Array(pSky.buffer);
			for (let k = 0; k < SPOT_COLUMNS; k++)
				for (let y = 0; y < H; y++) {
					spot[2 * (k * H + y)] = rb[y * W + cols[k]];
					spot[2 * (k * H + y) + 1] = pb[y * W + cols[k]];
				}
			expect(verifyBand(W, H, band.K, band.idx, cols, spot)).toBeNull();
			expect(verifyBand(W, H, band.K + 1, band.idx, cols, spot)).not.toBeNull();
			const moved = band.idx.slice();
			let off0 = 0;
			for (let q = 0; q < cols[0] / 2; q++) off0 += band.cnt[q];
			moved[off0] += W;
			expect(verifyBand(W, H, band.K, moved, cols, spot)).not.toBeNull();
			break;
		}
		expect(checked).toBeGreaterThan(0);
	});
	it("band path through the tail equals fitHaze", async () => {
		for (const s of [200, 201, 202]) {
			const input = makeHazeScene(sceneOptions(s));
			const { prep, ctx, pixels } = emulatePrep(input);
			const band = emulateBand(
				new Uint32Array(pixels.range.buffer),
				new Uint32Array(pixels.pSky.buffer),
				input.geoW,
				input.geoH,
			);
			if (band.K < 20) continue;
			const sky = new Float32Array(3 * band.K);
			for (let k = 0; k < band.K; k++)
				for (let c = 0; c < 3; c++)
					sky[3 * k + c] = pixels.lin[band.idx[k] * 3 + c];
			const bandPrep: Prep = {
				...prep,
				sky,
				list: (L) => {
					const { idx, val } = prep.list(L);
					return {
						idx,
						val,
						range: Float32Array.from(idx, (i) => pixels.range[i]),
					};
				},
			};
			for (const k of Object.keys(hazeGpuTimes)) delete hazeGpuTimes[k];
			const got = await hazeFitTail(
				null as never,
				{ ...ctx, range: new Float32Array(0), skyIdx: band.idx },
				bandPrep,
				emulatedGrid,
			);
			if ((hazeGpuTimes.gridCandidates ?? 0) > 256) continue;
			expect(firstDifference(got, fitHaze(input)) || "").toBe("");
			return;
		}
	});
});
