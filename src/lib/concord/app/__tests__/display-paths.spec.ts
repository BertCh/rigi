// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

// a plain function holder (not vi.fn): vitest's spy tracks a rejected promise as unhandled
const dsm = vi.hoisted(() => ({
	calls: [] as unknown[][],
	impl: (async () => null) as (...a: unknown[]) => Promise<unknown>,
}));
vi.mock("../../occl/ndsm", () => ({
	loadNearDsm: (...a: unknown[]) => {
		dsm.calls.push(a);
		return dsm.impl(...a);
	},
}));

import { runConcordDisplay } from "../display";

function makeHost(readback = true) {
	return {
		photo: { lat: 46.5, lon: 7.9 },
		aspect: 1.5,
		pose: { yaw: 120, pitch: 0, roll: 0, vfov: 40 },
		eye: { x: 0, y: 0, z: 1.6 },
		sampleAt: vi.fn(() => null),
		readback: vi.fn(async () => readback),
		setOccluder: vi.fn(),
	};
}
const OK = { level: "high", confidence: 0.9, accepted: true } as const;

beforeEach(() => {
	dsm.calls.length = 0;
	dsm.impl = async () => null;
});

describe("runConcordDisplay", () => {
	it("does nothing when the occl flag is off", async () => {
		const h = makeHost();
		const r = await runConcordDisplay(h as never, OK, { occl: false });
		expect(r).toEqual({ occl: null });
		expect(h.readback).not.toHaveBeenCalled();
		expect(h.setOccluder).not.toHaveBeenCalled();
	});

	it("clears the occluder and computes nothing at LOW confidence (fail closed)", async () => {
		for (const c of [null, { level: "low" } as const, { confidence: 0.1 }]) {
			const h = makeHost();
			const r = await runConcordDisplay(h as never, c, { occl: true });
			expect(r.refused).toBe("pose confidence LOW");
			expect(r.occl).toBeNull();
			expect(h.setOccluder).toHaveBeenCalledWith(null);
			expect(h.readback).not.toHaveBeenCalled();
			expect(dsm.calls).toHaveLength(0);
		}
	});

	it("returns an empty report when the geometry readback fails or the signal is aborted", async () => {
		const h = makeHost(false);
		expect(await runConcordDisplay(h as never, OK, { occl: true })).toEqual({
			occl: null,
		});
		expect(dsm.calls).toHaveLength(0);
		const ac = new AbortController();
		ac.abort();
		const h2 = makeHost();
		expect(
			await runConcordDisplay(h2 as never, OK, { occl: true }, ac.signal),
		).toEqual({ occl: null });
		expect(dsm.calls).toHaveLength(0);
	});

	it("requests a wedge around the camera yaw and reports 'no surface model' outside Switzerland", async () => {
		dsm.impl = async () => null;
		const h = makeHost();
		const r = await runConcordDisplay(h as never, OK, { occl: true });
		const [lat, lon, radius, res, opts] = dsm.calls[0] as [
			number,
			number,
			number,
			number,
			{ wedge: { yawDeg: number; halfDeg: number } },
		];
		expect([lat, lon, radius, res]).toEqual([46.5, 7.9, 2000, 2]);
		expect(opts.wedge.yawDeg).toBe(120);
		expect(opts.wedge.halfDeg).toBeGreaterThan(10 + 20 / 2); // hfov/2 + 10
		expect(r.occl?.applied).toBe(false);
		expect(r.occl?.dimmedFrac).toBe(0);
		expect(r.occl?.reason).toContain("no surface model");
		expect(h.setOccluder).toHaveBeenCalledWith(null);
	});

	it("reports a load failure's message instead of throwing", async () => {
		dsm.impl = async () => {
			throw new Error("network down");
		};
		const h = makeHost();
		const r = await runConcordDisplay(h as never, OK, { occl: true });
		expect(r.occl?.applied).toBe(false);
		expect(r.occl?.reason).toBe("surface model load failed: network down");
		expect(h.setOccluder).toHaveBeenCalledWith(null);
	});

	it("an abort during the load discards the result without touching the occluder", async () => {
		const ac = new AbortController();
		dsm.impl = async () => {
			ac.abort();
			return null;
		};
		const h = makeHost();
		const r = await runConcordDisplay(
			h as never,
			OK,
			{ occl: true },
			ac.signal,
		);
		expect(r).toEqual({ occl: null });
		expect(h.setOccluder).not.toHaveBeenCalled();
	});
});
