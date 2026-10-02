// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { DEG } from "#/lib/geodesy";
import { bits32, fr, fromBits32 } from "../../precision/df32";
import {
	CERT_MAX_LAT,
	CI,
	certify,
	elevationF64,
	emuSkylineDirs,
	emuStageA,
	enuLump,
	enuLumpRel,
	F32C,
	FLAG_CERT,
	FLAG_SKIP,
	finishStageA,
	NO_HIT_T,
	packAzimuths,
	packColumns,
	packConsts,
	packProfile,
	resetTieStats,
	setBoundScale,
	setFaultInjection,
	stageBUniform,
	tieStats,
} from "../certified-cpu";

describe("packConsts", () => {
	it("is COUNT f32 triples; geometry null leaves the per-call slots zero", () => {
		const c = packConsts(null);
		expect(c.length).toBe(CI.COUNT * 3);
		expect(c[3 * CI.EYEH]).toBe(0);
		expect(c[3 * CI.INV_DEG]).not.toBe(0);
	});
	it("fills the per-call slots from the geometry", () => {
		const c = packConsts({ lat: 46.5, lon: 8, k: 0.13, eyeH: 2000 });
		expect(c[3 * CI.EYEH] + c[3 * CI.EYEH + 1]).toBeCloseTo(2000, 3);
		const sp = c[3 * CI.SP] + c[3 * CI.SP + 1];
		const cp = c[3 * CI.CP] + c[3 * CI.CP + 1];
		expect(sp).toBeCloseTo(Math.sin(46.5 * DEG), 6);
		expect(cp).toBeCloseTo(Math.cos(46.5 * DEG), 6);
		// every tracked value carries a non-negative error bound
		for (const i of [CI.INV2R, CI.KAPPA, CI.SP, CI.CP, CI.EYEH])
			expect(c[3 * i + 2]).toBeGreaterThanOrEqual(0);
	});
	it("tabulates sin/cos/atan at k/32", () => {
		const c = packConsts(null);
		const at = (i: number) => c[3 * i] + c[3 * i + 1];
		expect(at(CI.SIN_TAB + 52 + 32)).toBeCloseTo(Math.sin(1), 6);
		expect(at(CI.COS_TAB + 52 + 0)).toBeCloseTo(1, 7);
		expect(at(CI.ATAN_TAB + 32)).toBeCloseTo(Math.PI / 4, 6);
		expect(at(CI.ATAN_TAB)).toBe(0);
	});
});

describe("packAzimuths / packColumns", () => {
	it("packs 8 f32 per azimuth with sin/cos/degrees as df32", () => {
		const out = packAzimuths(10, 3, 0.5);
		expect(out.length).toBe(24);
		for (let i = 0; i < 3; i++) {
			const az = (10 + i) * 0.5;
			expect(out[8 * i] + out[8 * i + 1]).toBeCloseTo(Math.sin(az * DEG), 7);
			expect(out[8 * i + 2] + out[8 * i + 3]).toBeCloseTo(
				Math.cos(az * DEG),
				7,
			);
			expect(out[8 * i + 4] + out[8 * i + 5]).toBeCloseTo(az, 5);
		}
	});
	it("packs columns with the exact-float floor(c / step) in slot 6", () => {
		const out = packColumns(0.5, [0, 10.25, 359.9]);
		expect(out[6]).toBe(0);
		expect(out[8 + 6]).toBe(20);
		expect(out[16 + 6]).toBe(719);
		expect(out[8] + out[9]).toBeCloseTo(10.25, 5);
	});
});

describe("lumps", () => {
	it("grow with latitude and stay finite", () => {
		const eq = enuLump(0, 0);
		const hi = enuLump(CERT_MAX_LAT, 0);
		expect(eq).toBeGreaterThan(0);
		expect(hi).toBeGreaterThan(eq);
		expect(Number.isFinite(hi)).toBe(true);
		expect(enuLumpRel(60, 5)).toBeGreaterThan(0);
	});
	it("stageBUniform mirrors the two lump functions", () => {
		const u = stageBUniform({ lat: 47, lon: 8, k: 0.13, eyeH: 0 });
		expect(u.lumpEnu).toBe(enuLump(47, 8));
		expect(u.lumpEnuRel).toBe(enuLumpRel(47, 8));
	});
});

describe("certify", () => {
	it("certifies a value far from a rounding boundary", () => {
		expect(certify([1.5, 0, 0])).toBe(bits32(1.5));
	});
	it("refuses when the error bound straddles a rounding boundary", () => {
		const hi = fr(1);
		// the f32 neighbour spacing at 1 is 2^-23, so an error of 2^-24 reaches the midpoint
		expect(certify([hi, 0, 2 ** -23])).toBe(-1);
	});
	it("refuses zero, out-of-range and non-finite values", () => {
		expect(certify([0, 0, 0])).toBe(-1);
		expect(certify([Number.NaN, 0, 0])).toBe(-1);
		expect(certify([Number.POSITIVE_INFINITY, 0, 0])).toBe(-1);
	});
	it("fault injection breaks certification soundness detection hook, bound scale tightens", () => {
		// a huge bound scale makes a previously certified value uncertain
		setBoundScale(1e12);
		expect(certify([1.5, 1e-9, 1e-7], 1e12)).toBe(-1);
		setBoundScale(1);
		setFaultInjection(0.5);
		const faulty = certify([1.5, 0, 0]);
		setFaultInjection(0);
		expect(faulty === -1 || faulty !== bits32(1.5)).toBe(true);
		expect(certify([1.5, 0, 0])).toBe(bits32(1.5));
	});
});

describe("tieStats", () => {
	it("resets every counter", () => {
		tieStats.bracket = 3;
		tieStats.out = [1, 2, 3];
		resetTieStats();
		expect(tieStats).toEqual({
			bracket: 0,
			minDen: 0,
			out: [0, 0, 0],
			sampleBad: 0,
		});
	});
});

describe("stage A", () => {
	const tds = Float32Array.from([
		0.5,
		100,
		-0.25,
		200,
		0,
		300,
		-3.4e38,
		0,
		Number.NaN,
		0,
		1e-42,
		0,
		3,
		50,
	]);
	const n = tds.length / 2;
	it("NO_HIT_T is a float at most -3e38", () => {
		expect(NO_HIT_T).toBeLessThanOrEqual(-3e38);
		expect(fr(NO_HIT_T)).toBe(NO_HIT_T);
	});
	it("flags the no-hit, zero and ordinary values certified; NaN and subnormals are left to f64", () => {
		const out = emuStageA(tds, n);
		expect(out[1]).toBe(FLAG_CERT); // 0.5
		expect(out[3]).toBe(FLAG_CERT); // -0.25
		expect(out[5]).toBe(FLAG_CERT); // 0
		expect(fromBits32(out[4])).toBe(0);
		expect(fromBits32(out[6])).toBe(-90); // no hit
		expect(out[7]).toBe(FLAG_CERT);
		expect(out[9]).toBe(0); // NaN
		expect(out[11]).toBe(0); // subnormal
	});
	it("certified elevations agree with the f64 path to f32 rounding", () => {
		const out = emuStageA(tds, n);
		for (let i = 0; i < n; i++) {
			if (!(out[2 * i + 1] & FLAG_CERT)) continue;
			const want = elevationF64(tds[2 * i]);
			expect(fromBits32(out[2 * i])).toBeCloseTo(want, 4);
		}
	});
	it("finishStageA returns the f64 value for uncertified entries and counts them", () => {
		const out = emuStageA(tds, n);
		const { elevation, ties } = finishStageA(tds, out, n);
		expect(ties).toBeGreaterThanOrEqual(2);
		expect(elevation[0]).toBeCloseTo(Math.atan(0.5) / DEG, 4);
		expect(elevation[3]).toBe(-90);
		expect(Number.isNaN(elevation[4])).toBe(true);
	});
	it("elevationF64 maps the no-terrain sentinel to -90", () => {
		expect(elevationF64(-3.1e38)).toBe(-90);
		expect(elevationF64(1)).toBeCloseTo(45, 10);
	});
});

describe("packProfile", () => {
	it("interleaves elevation and distance", () => {
		const p = packProfile({
			step: 1,
			i0: 0,
			elevation: Float32Array.from([1, 2]),
			distance: Float32Array.from([10, 20]),
		});
		expect(Array.from(p)).toEqual([1, 10, 2, 20]);
	});
});

describe("emuSkylineDirs", () => {
	it("a flat 360-sample profile gives unit directions, finishing every skipped column via f64", () => {
		const n = 360;
		const prof = {
			step: 1,
			i0: 0,
			elevation: new Float32Array(n).fill(2),
			distance: new Float32Array(n).fill(5000),
		};
		const r = emuSkylineDirs(prof, { lat: 46.7, lon: 8.1, k: 0.13 }, 2000);
		expect(r.dirs.length).toBeGreaterThan(0);
		expect(r.dirs.length % 3).toBe(0);
		for (let i = 0; i < r.dirs.length; i += 3) {
			const len = Math.hypot(r.dirs[i], r.dirs[i + 1], r.dirs[i + 2]);
			expect(len).toBeCloseTo(1, 5);
			expect(r.dirs[i + 2]).toBeGreaterThan(0);
		}
		expect(r.outC.length % 4).toBe(0);
	});
	it("a profile with no terrain skips every column", () => {
		const n = 360;
		const prof = {
			step: 1,
			i0: 0,
			elevation: new Float32Array(n).fill(-90),
			distance: new Float32Array(n).fill(0),
		};
		const r = emuSkylineDirs(prof, { lat: 46.7, lon: 8.1, k: 0.13 }, 2000);
		expect(r.dirs.length).toBe(0);
		expect(FLAG_SKIP).toBe(2);
	});
});

describe("F32C", () => {
	it("holds f32-exact constants only", () => {
		for (const [name, v] of Object.entries(F32C)) expect(fr(v), name).toBe(v);
	});
});
