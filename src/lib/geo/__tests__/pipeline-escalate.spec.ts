// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The cascade's escalation rule with both solvers stubbed: which stage answers, what refine is given.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	computeHorizonFastCompat,
	type FastHorizonProfile,
} from "../../horizon-fast/march";
import { refinePose } from "../../refine/index";
import { cameraFromAngles } from "../camera";
import { computeHorizon, type HorizonProfile } from "../horizon";
import { cascade, cascadeAsync, sceneHorizon } from "../pipeline";
import { type SkylineSolveResult, solvePose, solvePoseAsync } from "../solve";
import type { TerrainSampler } from "../terrain";

vi.mock("../solve", async (importOriginal) => ({
	...(await importOriginal<typeof import("../solve")>()),
	solvePose: vi.fn(),
	solvePoseAsync: vi.fn(),
}));
vi.mock("../../refine/index", () => ({ refinePose: vi.fn() }));
vi.mock("../horizon", () => ({ computeHorizon: vi.fn() }));
vi.mock("../../horizon-fast/march", () => ({
	computeHorizonFastCompat: vi.fn(),
}));

const cam = (yaw: number) =>
	cameraFromAngles({ width: 400, height: 300, f: 420, yaw, pitch: 0, roll: 0 });
const prior = cam(10);
const horizon = { step: 0.05 } as unknown as HorizonProfile;
const sky = {
	width: 400,
	height: 300,
	rows: new Float32Array(400),
	weight: new Float32Array(400),
};
const solved = (accepted: boolean, yaw = 12): SkylineSolveResult =>
	({
		camera: cam(yaw),
		confidence: accepted ? 0.8 : 0.3,
		accepted,
		rejectReason: accepted ? undefined : "low-confidence",
		residualPx: 2.5,
	}) as SkylineSolveResult;
const refined = (accept: boolean, yaw = 13) =>
	({
		camera: cam(yaw),
		confidence: { accept, score: accept ? 0.7 : 0.2 },
	}) as ReturnType<typeof refinePose>;

beforeEach(() => vi.clearAllMocks());

describe("cascade escalation", () => {
	it("an accepted solve never runs refine", () => {
		vi.mocked(solvePose).mockReturnValue(solved(true));
		const r = cascade(prior, horizon, sky);
		expect(refinePose).not.toHaveBeenCalled();
		expect(r).toMatchObject({
			stage: "solve",
			accepted: true,
			confidence: 0.8,
		});
		expect(r.residualPx).toBe(2.5);
		expect(r.candidates).toHaveLength(1);
	});

	it("a rejected solve escalates to refine from the PRIOR, with the caller's refine options and GPS accuracy", () => {
		vi.mocked(solvePose).mockReturnValue(solved(false));
		vi.mocked(refinePose).mockReturnValue(refined(true));
		const refineOpts = { localOnly: true };
		const solveOpts = { yawRange: 10 };
		const r = cascade(prior, horizon, sky, {
			solve: solveOpts,
			refine: refineOpts,
			gpsAccuracy: 7,
		});
		expect(solvePose).toHaveBeenCalledWith(prior, horizon, sky, solveOpts);
		expect(refinePose).toHaveBeenCalledWith({
			camera: prior,
			horizon,
			skyline: sky,
			gpsAccuracy: 7,
			options: refineOpts,
		});
		expect(r).toMatchObject({
			stage: "refine",
			accepted: true,
			confidence: 0.7,
			rejectReason: undefined,
		});
		expect(r.camera.yaw).toBeCloseTo(13, 9);
		expect(r.residualPx).toBeNaN();
		expect(r.candidates.map((c) => c.stage)).toEqual(["solve", "refine"]);
	});

	it("both reject: the solve's pose and reason stand, both stages listed", () => {
		vi.mocked(solvePose).mockReturnValue(solved(false, 40));
		vi.mocked(refinePose).mockReturnValue(refined(false, 200));
		const r = cascade(prior, horizon, sky);
		expect(r).toMatchObject({
			stage: "solve",
			accepted: false,
			rejectReason: "low-confidence",
		});
		expect(r.camera.yaw).toBeCloseTo(40, 9);
		expect(r.candidates.map((c) => [c.stage, c.accepted])).toEqual([
			["solve", false],
			["refine", false],
		]);
	});

	it("cascadeAsync hands the coarse provider and solve options to solvePoseAsync", async () => {
		vi.mocked(solvePoseAsync).mockResolvedValue(solved(true));
		const coarse = vi.fn();
		const solveOpts = { headingKnown: false };
		const r = await cascadeAsync(
			prior,
			horizon,
			sky,
			{ solve: solveOpts },
			coarse,
		);
		expect(solvePoseAsync).toHaveBeenCalledWith(
			prior,
			horizon,
			sky,
			solveOpts,
			coarse,
		);
		expect(solvePose).not.toHaveBeenCalled();
		expect(r.stage).toBe("solve");
	});
});

describe("sceneHorizon", () => {
	const terrain = {} as TerrainSampler;
	const fast = { step: 0.05, tag: "fast" } as unknown as FastHorizonProfile;
	const classic = { step: 0.05, tag: "classic" } as unknown as HorizonProfile;

	it("uses horizon-fast when it works", async () => {
		vi.mocked(computeHorizonFastCompat).mockReturnValue(fast);
		expect(await sceneHorizon(terrain, 46, 7, 1500)).toBe(fast);
		expect(computeHorizon).not.toHaveBeenCalled();
	});

	it.each([
		[
			"throws",
			() =>
				vi.mocked(computeHorizonFastCompat).mockImplementation(() => {
					throw new Error("boom");
				}),
		],
		[
			"rejects",
			() =>
				vi
					.mocked(computeHorizonFastCompat)
					.mockRejectedValue(new Error("boom")),
		],
	])("falls back to the classic ray-march with the same arguments when horizon-fast %s", async (_, fail) => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		fail();
		vi.mocked(computeHorizon).mockReturnValue(classic);
		expect(await sceneHorizon(terrain, 46, 7, 1500)).toBe(classic);
		expect(computeHorizon).toHaveBeenCalledWith(terrain, 46, 7, 1500);
		expect(warn).toHaveBeenCalled();
		warn.mockRestore();
	});
});
