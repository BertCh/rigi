// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../occl/ndsm", () => ({
	loadNearDsm: vi.fn(async () => ({ stats: { bytes: 1 } })),
}));
const occluderRange = vi.hoisted(() => vi.fn());
vi.mock("../../occl/occluder", async (orig) => ({
	...(await orig<typeof import("../../occl/occluder")>()),
	occluderRange,
}));

import { runConcordDisplay } from "../display";

const HIGH = { accepted: true, level: "high" } as const;
const TERRAIN = 1000;

const makeHost = (withHooks: boolean) => {
	const host = {
		photo: { lat: 46.7, lon: 7.8 },
		aspect: 1,
		pose: { yaw: 0, vfov: 40 },
		eye: { x: 0, y: 0, z: 0 },
		sampleAt: () => ({ world: [0, TERRAIN, 0], range: TERRAIN }),
		readback: async () => true,
		setOccluder: vi.fn(),
		setOccludedLabels: vi.fn(),
		setDrapeMask: vi.fn(),
	};
	if (!withHooks) {
		const { setOccludedLabels: _a, setDrapeMask: _b, ...bare } = host;
		return bare as never;
	}
	// biome-ignore lint/suspicious/noExplicitAny: structural fake of the Renderer subset
	return host as any;
};

/** Object 100 m away in the left half of the 160×160 grid, nothing on the right. */
const leftObject = () => {
	const o = new Float32Array(160 * 160).fill(Number.POSITIVE_INFINITY);
	for (let j = 0; j < 160; j++)
		for (let i = 0; i < 80; i++) o[j * 160 + i] = 100;
	return o;
};
const labels = [
	{ id: "hidden", u: 0.25, v: 0.5, rangeM: 5000 },
	{ id: "shown", u: 0.75, v: 0.5, rangeM: 5000 },
];

beforeEach(() => occluderRange.mockReset().mockImplementation(leftObject));

describe("runConcordDisplay C4 hooks", () => {
	it("flags off: report unchanged and the optional setters never called", async () => {
		const host = makeHost(true);
		const r = await runConcordDisplay(
			host,
			HIGH,
			{ occl: true },
			undefined,
			labels,
		);
		expect(r.occl?.applied).toBe(true);
		expect(r.occl).not.toHaveProperty("labelsHidden");
		expect(r.occl).not.toHaveProperty("drapeMask");
		expect(host.setOccludedLabels).not.toHaveBeenCalled();
		expect(host.setDrapeMask).not.toHaveBeenCalled();
		expect(host.setOccluder).toHaveBeenCalledTimes(1);
	});

	it("labels and drape without occl do nothing at all", async () => {
		const host = makeHost(true);
		const r = await runConcordDisplay(
			host,
			HIGH,
			{ occl: false, labels: true, drape: true },
			undefined,
			labels,
		);
		expect(r).toEqual({ occl: null });
		expect(host.setOccluder).not.toHaveBeenCalled();
		expect(host.setOccludedLabels).not.toHaveBeenCalled();
		expect(host.setDrapeMask).not.toHaveBeenCalled();
	});

	it("labels: reports and applies the hidden ids", async () => {
		const host = makeHost(true);
		const r = await runConcordDisplay(
			host,
			HIGH,
			{ occl: true, labels: true },
			undefined,
			labels,
		);
		expect(r.occl?.labelsHidden).toEqual(["hidden"]);
		expect(host.setOccludedLabels).toHaveBeenCalledWith(["hidden"]);
		expect(host.setDrapeMask).not.toHaveBeenCalled();
	});

	it("labels flag without supplied anchors skips the label hook", async () => {
		const host = makeHost(true);
		const r = await runConcordDisplay(host, HIGH, { occl: true, labels: true });
		expect(r.occl?.labelsHidden).toBeUndefined();
		expect(host.setOccludedLabels).not.toHaveBeenCalled();
	});

	it("drape: reports and applies the mask from the same pass", async () => {
		const host = makeHost(true);
		const r = await runConcordDisplay(host, HIGH, { occl: true, drape: true });
		expect(r.occl?.drapeMask?.width).toBe(160);
		expect(r.occl?.drapeMask?.data[80 * 160 + 10]).toBe(255);
		expect(r.occl?.drapeMask?.data[80 * 160 + 150]).toBe(0);
		expect(host.setDrapeMask).toHaveBeenCalledWith(r.occl?.drapeMask);
		expect(occluderRange).toHaveBeenCalledTimes(1);
	});

	it("no object found: drape setter gets null and no mask is reported", async () => {
		occluderRange.mockImplementation(() =>
			new Float32Array(160 * 160).fill(Number.POSITIVE_INFINITY),
		);
		const host = makeHost(true);
		const r = await runConcordDisplay(
			host,
			HIGH,
			{ occl: true, labels: true, drape: true },
			undefined,
			labels,
		);
		expect(r.occl?.drapeMask).toBeUndefined();
		expect(r.occl?.labelsHidden).toEqual([]);
		expect(host.setDrapeMask).toHaveBeenCalledWith(null);
		expect(host.setOccludedLabels).toHaveBeenCalledWith(null);
	});

	it("a host without the optional setters still gets the report", async () => {
		const host = makeHost(false);
		const r = await runConcordDisplay(
			host,
			HIGH,
			{ occl: true, labels: true, drape: true },
			undefined,
			labels,
		);
		expect(r.occl?.labelsHidden).toEqual(["hidden"]);
		expect(r.occl?.drapeMask).toBeDefined();
	});

	it("LOW confidence clears everything and computes nothing", async () => {
		const host = makeHost(true);
		const r = await runConcordDisplay(
			host,
			null,
			{ occl: true, labels: true, drape: true },
			undefined,
			labels,
		);
		expect(r.refused).toBe("pose confidence LOW");
		expect(r.occl).toBeNull();
		expect(host.setOccluder).toHaveBeenCalledWith(null);
		expect(host.setOccludedLabels).toHaveBeenCalledWith(null);
		expect(host.setDrapeMask).toHaveBeenCalledWith(null);
		expect(occluderRange).not.toHaveBeenCalled();
	});
});
