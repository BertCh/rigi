// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it } from "vitest";
import {
	type AlignResult,
	autoAlign,
	autoAlignLanes,
	type CoarseGridScores,
	type EdgeMap,
	fitPriorSky,
	RefineBoundViolation,
} from "#/lib/align";
import type { Pose } from "#/lib/camera";
import {
	setDivSqrtPerturbation,
	setFlushSubnormals,
} from "#/lib/gpu/precision/df32";
import { type EmulateOptions, emulatedRunner } from "../cert-emulate";
import { alignProbeOk } from "../cert-gpu";
import {
	certifiable,
	certifiedRefine,
	f32Down,
	f32Up,
	latticeSlack,
	newCertStats,
} from "../cert-refine";

const D = Math.PI / 180;

function synthetic() {
	const ridge = (az: number) =>
		2.5 + 1.8 * Math.sin(az * 7 * D) + 0.9 * Math.sin(az * 19 * D + 1);
	const n = 192;
	const dirs = new Float32Array(n * 3);
	for (let i = 0; i < n; i++) {
		const az = 60 + (i / n) * 120;
		const el = ridge(az) * D;
		dirs[i * 3] = Math.sin(az * D) * Math.cos(el);
		dirs[i * 3 + 1] = Math.cos(az * D) * Math.cos(el);
		dirs[i * 3 + 2] = Math.sin(el);
	}
	const truth: Pose = { yaw: 120, pitch: 1, roll: 0.5, vfov: 40 };
	const aspect = 1.5;
	const w = 64;
	const h = 48;
	const rows = new Float32Array(w).fill(h);
	const t = Math.tan((truth.vfov * D) / 2);
	for (let i = 0; i < n; i++) {
		const az = 60 + (i / n) * 120;
		const x = 0.5 + Math.tan((az - truth.yaw) * D) / (t * aspect) / 2;
		const v = 0.5 - Math.tan((ridge(az) - truth.pitch) * D) / t / 2;
		const col = Math.floor(x * w);
		if (col >= 0 && col < w) rows[col] = Math.min(rows[col], v * h);
	}
	const rgb = new Uint8ClampedArray(w * h * 4);
	const coarse = new Float32Array(w * h);
	const fine = new Float32Array(w * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const i = y * w + x;
			const sky = y < rows[x];
			rgb.set(sky ? [120, 160, 230, 255] : [90, 80, 60, 255], i * 4);
			const d = Math.abs(y - rows[x]);
			coarse[i] = Math.exp(-(d * d) / 40);
			fine[i] = Math.exp(-(d * d) / 4);
		}
	const edge: EdgeMap = {
		w,
		h,
		coarse,
		fine,
		sky: new Float32Array(w * h),
		skyCum: new Float32Array(w * (h + 1)),
		rgb,
		fg: new Float32Array(w * h),
	};
	return { dirs, aspect, edge };
}

const same = (a: AlignResult, b: AlignResult) =>
	Object.is(a.score, b.score) &&
	Object.is(a.confidence, b.confidence) &&
	(["yaw", "pitch", "roll", "vfov"] as const).every((k) =>
		Object.is(a.pose[k], b.pose[k]),
	);

async function compare(emu?: EmulateOptions, verifyAll = false) {
	const s = synthetic();
	const prior: Pose = { yaw: 124, pitch: 0, roll: 0, vfov: 41 };
	fitPriorSky(prior, s.aspect, s.dirs, s.edge);
	const grid = (): CoarseGridScores => ({
		scores: new Float32Array(0),
		tol: 0,
		skyFitted: true,
	});
	const ref = autoAlign(prior, s.aspect, s.dirs, s.edge, 25, grid());
	const st = newCertStats();
	const got = await autoAlignLanes(
		prior,
		s.aspect,
		s.dirs,
		s.edge,
		25,
		grid(),
		(starts, ctx) => {
			expect(certifiable(starts, prior, s.aspect)).toBe(true);
			return certifiedRefine(starts, ctx, {
				runner: emulatedRunner(s.aspect, s.dirs, s.edge, emu),
				stats: st,
				verify: verifyAll ? { check: () => true } : undefined,
				audit: verifyAll ? 1e6 : 64,
				random: () => 0.5,
			});
		},
	);
	return { ref, got, st };
}

afterEach(() => {
	setFlushSubnormals(false);
	setDivSqrtPerturbation(0);
});

describe("certified-f32 refine (emulated device)", { timeout: 30_000 }, () => {
	it("reproduces the float64 autoAlign bit for bit", async () => {
		const { ref, got, st } = await compare();
		expect(same(ref, got)).toBe(true);
		expect(st.submits).toBeGreaterThan(0);
	});
	it("a flush-to-zero machine with perturbed division stays identical", async () => {
		setFlushSubnormals(true);
		setDivSqrtPerturbation(3, () => 0.9);
		const { ref, got } = await compare();
		expect(same(ref, got)).toBe(true);
	});
	it("a broken bound is caught or flips no decision", async () => {
		let caught = false;
		let r: Awaited<ReturnType<typeof compare>> | undefined;
		try {
			r = await compare({ fault: 0.05 }, true);
		} catch (e) {
			if (!(e instanceof RefineBoundViolation)) throw e;
			caught = true;
		}
		expect(caught || (r !== undefined && same(r.ref, r.got))).toBe(true);
	});
});

describe("certified refine helpers", () => {
	const v = (failures: Record<string, number>, error?: string) => ({
		ok: Object.keys(failures).length === 0,
		n: 1,
		failures,
		worst: {},
		ms: 0,
		error,
	});
	it("alignProbeOk tolerates only sqrt failures", () => {
		expect(alignProbeOk(v({}))).toBe(true);
		expect(alignProbeOk(v({ sqrt: 3, ddSqrt: 1 }))).toBe(true);
		expect(alignProbeOk(v({ fma: 1 }))).toBe(false);
		expect(alignProbeOk(v({ sqrt: 1, ddDiv: 1 }))).toBe(false);
		expect(alignProbeOk(v({}, "lost"))).toBe(false);
	});
	it("latticeSlack is tiny for ordinary poses", () => {
		const sl = latticeSlack(
			[{ yaw: 300, pitch: -2, roll: 2, vfov: 50 }],
			{ yaw: 299, pitch: -2.1, roll: 2.4, vfov: 50 },
			50,
		);
		expect(Math.max(sl.dB, sl.relT, sl.relV, sl.pen)).toBeLessThan(1e-9);
	});
	it("f32Down / f32Up bracket their double and stay normal", () => {
		for (const x of [
			0,
			1,
			-1,
			0.1,
			1 / 3,
			1e-40,
			-1e-40,
			123456.789,
			Math.PI,
			-(2 ** -127),
		]) {
			const lo = f32Down(x);
			const hi = f32Up(x);
			expect(lo).toBeLessThanOrEqual(x);
			expect(hi).toBeGreaterThanOrEqual(x);
			expect(Math.fround(lo)).toBe(lo);
			expect(Math.fround(hi)).toBe(hi);
			expect(Math.abs(lo) >= 2 ** -126 || lo === 0).toBe(true);
		}
		expect(f32Down(1)).toBe(1);
		expect(f32Up(2 ** -20)).toBe(2 ** -20);
	});
});
