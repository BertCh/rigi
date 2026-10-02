// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { cameraFromAngles } from "../../geo/camera";
import type { HorizonProfile } from "../../geo/horizon";
import { projectSkylineRows } from "../../geo/solve";
import {
	correlateCpu,
	DEFAULT_INIT,
	finishInit,
	globalInit,
	globalInitAsync,
	prepareInit,
} from "../init";
import { columnsFromSkyline, paramsFromCamera } from "../model";

function profile(): HorizonProfile {
	const step = 0.25;
	const n = 1440;
	const elevation = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const az = i * step;
		elevation[i] =
			2 +
			1.5 * Math.sin((az * Math.PI) / 23) +
			1.0 * Math.sin((az * Math.PI) / 7 + 2) +
			5 * Math.exp(-(((az - 150) / 3) ** 2));
	}
	return {
		step,
		elevation,
		distance: new Float32Array(n).fill(8000),
		ridges: Array.from({ length: n }, () => []),
	};
}
const W = 600;
const H = 450;
const mk = (yaw: number) =>
	cameraFromAngles({ width: W, height: H, f: 700, yaw, pitch: 2, roll: 0 });
const truth = mk(150);
const rows = projectSkylineRows(truth, profile(), W);
const cols = columnsFromSkyline({
	width: W,
	rows,
	weight: Float32Array.from(rows, (r) => (Number.isFinite(r) ? 1 : 0)),
});
const prior = mk(141);
const geom = { width: W, height: H, cx: prior.cx, cy: prior.cy, f0: prior.f };

describe("globalInit split (prepare, correlate, finish)", () => {
	it("globalInitAsync with the CPU correlator equals globalInit exactly", async () => {
		const p = paramsFromCamera(prior);
		const a = globalInit(p, geom, cols, profile());
		const b = await globalInitAsync(
			p,
			geom,
			cols,
			profile(),
			DEFAULT_INIT,
			async (prep) => correlateCpu(prep),
		);
		expect(b.modes).toEqual(a.modes);
		expect(b.psr).toBe(a.psr);
		expect(Array.from(b.score)).toEqual(Array.from(a.score));
		expect(Array.from(b.shifts)).toEqual(Array.from(a.shifts));
	});
	it("correlateCpu returns 2S+1 shifts per focal scale at the needed grid indices", () => {
		const prep = prepareInit(
			paramsFromCamera(prior),
			geom,
			cols,
			profile(),
			DEFAULT_INIT,
		);
		const c = correlateCpu(prep);
		expect(c).toHaveLength(DEFAULT_INIT.fScales.length);
		expect(prep.nShift).toBe(2 * prep.S + 1);
		for (const f of c)
			for (const v of [f.C1, f.C2, f.C3, f.C4])
				expect(v).toHaveLength(prep.nShift);
		// C2[k] = Σ_j W[j]·H[j+k]: check one shift directly
		const k = 7;
		let ref = 0;
		for (let j = 0; j < prep.M; j++)
			ref += prep.binned[0].W[j] * prep.H[(j + k) % prep.M];
		expect(c[0].C2[k + prep.S]).toBeCloseTo(ref, 6);
	});
	it("finishInit is deterministic on the same correlations", () => {
		const prep = prepareInit(
			paramsFromCamera(prior),
			geom,
			cols,
			profile(),
			DEFAULT_INIT,
		);
		const c = correlateCpu(prep);
		const a = finishInit(prep, c, DEFAULT_INIT, 0);
		const b = finishInit(prep, c, DEFAULT_INIT, 0);
		expect(b.modes).toEqual(a.modes);
	});
});
