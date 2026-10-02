// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// solveUnknownPose accept/ambiguity/candidate rules and computeUnknownScene's GPU->CPU fallbacks,
// with the geo pipeline and GPU modules mocked (the real cascade has its own checks).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { poseToCamera, vfovFromFocal } from "#/lib/camera";

type Run = {
	yaw: number;
	vfov?: number;
	confidence: number;
	accepted: boolean;
	stage?: "solve" | "refine";
	extra?: {
		yaw: number;
		pitch?: number;
		confidence: number;
		accepted: boolean;
		stage: "solve" | "refine";
	}[];
};
const H = 300;
const W = 400;

const h = vi.hoisted(() => ({
	script: (() => ({})) as (vfov: number, opts: unknown) => unknown,
	cascadeCalls: [] as {
		vfov: number;
		opts: Record<string, unknown>;
		coarse: unknown;
	}[],
	loadScene: vi.fn(),
	sceneHorizon: vi.fn(),
	fused: vi.fn(),
	sceneGpu: vi.fn(),
	solveCoarse: vi.fn(),
}));

vi.mock("#/lib/geo/pipeline", () => ({
	cascadeAsync: async (
		prior: { f: number; height: number },
		_h: unknown,
		_s: unknown,
		opts: Record<string, unknown>,
		coarse: unknown,
	) => {
		const vfov = (await import("#/lib/camera")).vfovFromFocal(
			prior.f,
			prior.height,
		);
		h.cascadeCalls.push({ vfov, opts, coarse });
		return h.script(vfov, opts);
	},
	loadScene: (...a: unknown[]) => h.loadScene(...a),
	sceneHorizon: (...a: unknown[]) => h.sceneHorizon(...a),
}));
vi.mock("#/lib/geo/skyline", () => ({
	detectSkylineAsync: async () => ({ sky: true }),
}));
vi.mock("#/lib/gpu/solve", () => ({
	solveCoarse: (...a: unknown[]) => h.solveCoarse(...a),
}));
vi.mock("#/lib/gpu/solve/fused", () => ({
	fusedSceneHorizon: (...a: unknown[]) => h.fused(...a),
}));
vi.mock("#/lib/gpu/horizon/scene-profile", () => ({
	sceneHorizonGpu: (...a: unknown[]) => h.sceneGpu(...a),
}));

import { computeUnknownScene, solveUnknownPose } from "../unknown-pose-core";

function mkResult(r: Run, vfov: number) {
	const cam = (yaw: number, pitch = 0) =>
		poseToCamera({ yaw, pitch, roll: 0, vfov: r.vfov ?? vfov }, W, H);
	const main = {
		stage: r.stage ?? "solve",
		camera: cam(r.yaw),
		confidence: r.confidence,
		accepted: r.accepted,
	};
	return {
		...main,
		candidates: [
			main,
			...(r.extra ?? []).map((e) => ({
				stage: e.stage,
				camera: cam(e.yaw, e.pitch),
				confidence: e.confidence,
				accepted: e.accepted,
			})),
		],
	};
}

const scene = async () => ({
	horizon: { h: 1 } as never,
	eye: 1500,
	horizonOn: "cpu" as const,
});
const req = (
	unknown: { yaw?: boolean; gravity?: boolean; focal?: boolean } = {},
	extra: object = {},
) =>
	({
		type: "solve",
		id: 1,
		lat: 46.5,
		lon: 8,
		alt: null,
		gpsAccuracy: 12,
		width: W,
		height: H,
		prior: { yaw: 100, pitch: 3, roll: 1, vfov: 45 },
		unknown: { yaw: false, gravity: false, focal: false, ...unknown },
		image: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
		...extra,
	}) as never;

beforeEach(() => {
	h.cascadeCalls.length = 0;
	h.loadScene.mockReset();
	h.sceneHorizon.mockReset();
	h.fused.mockReset();
	h.sceneGpu.mockReset();
	h.solveCoarse.mockReset();
});

describe("solveUnknownPose", () => {
	it("everything known: one cascade at the prior vfov with default solve options and the GPS accuracy", async () => {
		h.script = (v) =>
			mkResult({ yaw: 101, confidence: 0.9, accepted: true }, v);
		const r = await solveUnknownPose(req(), scene);
		expect(h.cascadeCalls).toHaveLength(1);
		expect(h.cascadeCalls[0].vfov).toBeCloseTo(45, 6);
		expect(h.cascadeCalls[0].opts).toEqual({ solve: {}, gpsAccuracy: 12 });
		expect(r.accepted).toBe(true);
		expect(r.pose.yaw).toBeCloseTo(101, 6);
		expect(r.seeds).toHaveLength(1);
		expect(r.horizonOn).toBe("cpu");
		expect(r.solveOn).toBe("cpu");
	});

	it("unknown focal: three focal seeds, a single clear winner is accepted", async () => {
		h.script = (v) =>
			mkResult(
				Math.abs(v - 66) < 15
					? { yaw: 100, confidence: 0.9, accepted: true }
					: { yaw: 40, confidence: 0.2, accepted: false },
				v,
			);
		const r = await solveUnknownPose(req({ focal: true }), scene);
		expect(h.cascadeCalls).toHaveLength(3);
		expect(r.seeds).toHaveLength(3);
		expect(r.accepted).toBe(true);
		expect(r.pose.yaw).toBeCloseTo(100, 6);
	});

	it("unknown focal: two seeds accepting at different yaws is ambiguous, so not accepted", async () => {
		let i = 0;
		h.script = (v) =>
			mkResult(
				++i === 2
					? { yaw: 103, confidence: 0.8, accepted: true }
					: { yaw: 100, confidence: 0.9, accepted: true },
				v,
			);
		const r = await solveUnknownPose(req({ focal: true }), scene);
		expect(r.accepted).toBe(false);
	});

	it("unknown focal: a best confidence under 0.75 is rejected even when the solver accepted", async () => {
		h.script = (v) =>
			mkResult({ yaw: 100, confidence: 0.68, accepted: true }, v);
		const r = await solveUnknownPose(req({ focal: true }), scene);
		expect(r.accepted).toBe(false);
	});

	it("unknown yaw: needs 0.75, frees the yaw search and uses the full-circle options", async () => {
		h.script = (v) =>
			mkResult({ yaw: 200, confidence: 0.66, accepted: true }, v);
		const weak = await solveUnknownPose(req({ yaw: true }), scene);
		expect(weak.accepted).toBe(false);
		expect(
			(h.cascadeCalls[0].opts.solve as { yawRange: number }).yawRange,
		).toBe(180);
		h.script = (v) =>
			mkResult({ yaw: 200, confidence: 0.8, accepted: true }, v);
		expect((await solveUnknownPose(req({ yaw: true }), scene)).accepted).toBe(
			true,
		);
	});

	it("unknown gravity widens the pitch search in the solve options", async () => {
		h.script = (v) =>
			mkResult({ yaw: 100, confidence: 0.9, accepted: true }, v);
		await solveUnknownPose(req({ gravity: true }), scene);
		expect(
			(h.cascadeCalls[0].opts.solve as { pitchRange: number }).pitchRange,
		).toBe(15);
	});

	it("prefers an accepted focal seed over a more confident rejected one", async () => {
		const byV = new Map<number, Run>();
		h.script = (v) => {
			byV.set(Math.round(v), { yaw: 0, confidence: 0, accepted: false });
			return mkResult(
				Math.abs(v - 66) < 15
					? { yaw: 150, confidence: 0.8, accepted: true }
					: { yaw: 10, confidence: 0.99, accepted: false },
				v,
			);
		};
		const r = await solveUnknownPose(req({ focal: true }), scene);
		expect(r.pose.yaw).toBeCloseTo(150, 6);
	});

	it("drops near-duplicate candidates and caps them at 4, chosen seed first", async () => {
		h.script = (v) =>
			mkResult(
				{
					yaw: 100,
					confidence: 0.9,
					accepted: true,
					extra: [
						{ yaw: 100.4, confidence: 0.5, accepted: false, stage: "refine" }, // duplicate of main
						{ yaw: 130, confidence: 0.4, accepted: false, stage: "refine" },
						{ yaw: 160, confidence: 0.4, accepted: false, stage: "refine" },
						{ yaw: 190, confidence: 0.4, accepted: false, stage: "refine" },
						{ yaw: 220, confidence: 0.4, accepted: false, stage: "refine" },
					],
				},
				v,
			);
		const r = await solveUnknownPose(req(), scene);
		expect(r.candidates).toHaveLength(4);
		expect(r.candidates[0].pose.yaw).toBeCloseTo(100, 6);
		expect(r.candidates.map((c) => Math.round(c.pose.yaw))).toEqual([
			100, 130, 160, 190,
		]);
	});

	it("yaw dedup wraps across 0/360", async () => {
		h.script = (v) =>
			mkResult(
				{
					yaw: 359.8,
					confidence: 0.9,
					accepted: true,
					extra: [
						{ yaw: 0.2, confidence: 0.5, accepted: false, stage: "refine" },
					],
				},
				v,
			);
		expect((await solveUnknownPose(req(), scene)).candidates).toHaveLength(1);
	});

	it("reports where the coarse grid ran: gpu, cpu or mixed (and falls back to cpu with no GPU result)", async () => {
		const runWith = async (ons: ("gpu" | "cpu" | null)[]) => {
			h.cascadeCalls.length = 0;
			for (const o of ons)
				h.solveCoarse.mockResolvedValueOnce(o ? { on: o } : null);
			h.script = async (v) => {
				const coarse = h.cascadeCalls[h.cascadeCalls.length - 1].coarse as (
					...a: unknown[]
				) => Promise<unknown>;
				for (let i = 0; i < ons.length; i++) await coarse({}, {}, {}, {});
				return mkResult({ yaw: 100, confidence: 0.9, accepted: true }, v);
			};
			return (await solveUnknownPose(req({}, { solveGpu: true }), scene))
				.solveOn;
		};
		expect(await runWith(["gpu"])).toBe("gpu");
		expect(await runWith(["cpu"])).toBe("cpu");
		expect(await runWith(["gpu", "cpu"])).toBe("mixed");
		expect(await runWith([null])).toBe("cpu");
	});

	it("passes no coarse provider without solveGpu", async () => {
		h.script = (v) =>
			mkResult({ yaw: 100, confidence: 0.9, accepted: true }, v);
		await solveUnknownPose(req(), scene);
		expect(h.cascadeCalls[0].coarse).toBeUndefined();
	});

	it("round-trips the solved vfov into the seed record", async () => {
		h.script = (v) =>
			mkResult({ yaw: 100, vfov: 52, confidence: 0.9, accepted: true }, v);
		const r = await solveUnknownPose(req(), scene);
		expect(r.seeds[0].solvedVfov).toBeCloseTo(52, 6);
		expect(
			vfovFromFocal(
				poseToCamera({ yaw: 0, pitch: 0, roll: 0, vfov: 52 }, W, H).f,
				H,
			),
		).toBeCloseTo(52, 6);
	});
});

describe("computeUnknownScene", () => {
	const terrain = { t: 1 };
	beforeEach(() => {
		h.loadScene.mockResolvedValue({ terrain, eye: 1234 });
		h.sceneHorizon.mockResolvedValue({ cpu: true });
	});

	it("marches on the CPU by default", async () => {
		const s = await computeUnknownScene(
			46,
			8,
			null,
			(async () => null) as never,
		);
		expect(s).toEqual({ horizon: { cpu: true }, eye: 1234, horizonOn: "cpu" });
		expect(h.fused).not.toHaveBeenCalled();
		expect(h.sceneGpu).not.toHaveBeenCalled();
	});

	it("uses the fused GPU march when asked and available", async () => {
		h.fused.mockResolvedValue({ horizon: { gpu: "fused" } });
		const s = await computeUnknownScene(
			46,
			8,
			500,
			(async () => null) as never,
			true,
			true,
		);
		expect(s.horizonOn).toBe("gpu");
		expect(s.horizon).toEqual({ gpu: "fused" });
		expect(h.fused).toHaveBeenCalledWith(terrain, 46, 8, 1234);
		expect(h.sceneGpu).not.toHaveBeenCalled();
	});

	it("a failed fused march goes straight to the CPU (not the same march again on the GPU)", async () => {
		h.fused.mockResolvedValue(null);
		const s = await computeUnknownScene(
			46,
			8,
			null,
			(async () => null) as never,
			true,
			true,
		);
		expect(s.horizonOn).toBe("cpu");
		expect(h.sceneGpu).not.toHaveBeenCalled();
	});

	it("the unfused GPU march serves when it can and falls back to the CPU on null", async () => {
		h.sceneGpu.mockResolvedValueOnce({ gpu: "plain" });
		const a = await computeUnknownScene(
			46,
			8,
			null,
			(async () => null) as never,
			true,
			false,
		);
		expect(a.horizonOn).toBe("gpu");
		expect(h.fused).not.toHaveBeenCalled();
		h.sceneGpu.mockResolvedValueOnce(null);
		const b = await computeUnknownScene(
			46,
			8,
			null,
			(async () => null) as never,
			true,
			false,
		);
		expect(b.horizonOn).toBe("cpu");
	});
});
