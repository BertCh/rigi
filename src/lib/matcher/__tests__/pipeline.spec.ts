// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// End-to-end matcher pipelines on a synthetic world: a fake engine (ray-cast views + the synthetic
// skyline edge maps) and a fake keypoint backend (geometric matches + 10 % wrong pairs). The pipelines
// must recover the true pose; see fake-world.ts for the conventions.

import { describe, expect, it, vi } from "vitest";
import type { Pose } from "#/lib/camera";
import { angleDiffDeg, withFlags } from "#/test/helpers";
import type { BasinJob } from "../basin-run";
import type { MatchContext } from "../context";
import { matchAdhoc, matchKnownPrior } from "../pipeline";
import {
	bindMatcherEngine,
	modelsAvailable,
	queueState,
	runMatch,
	setFeatureLoader,
} from "../service";
import { matchAdhocT6 } from "../t6";
import { createFakeWorld, type FakeWorld } from "./fake-world";

function makeContext(world: FakeWorld, extra: Partial<MatchContext> = {}) {
	const ctx: MatchContext = {
		engine: world.engine,
		features: world.features,
		photo: world.photo,
		deadline: performance.now() + 60_000,
		timing: {},
		...extra,
	};
	return ctx;
}

const poseError = (a: Pose, b: Pose) => ({
	yaw: angleDiffDeg(a.yaw, b.yaw),
	pitch: Math.abs(a.pitch - b.pitch),
	roll: Math.abs(a.roll - b.roll),
});

describe("matcher pipelines on a synthetic world", () => {
	it("matchKnownPrior recovers the true pose from a 1.5° yaw / -0.5° pitch prior", async () => {
		const world = createFakeWorld();
		const t = world.truePose;
		const prior = { ...t, yaw: t.yaw + 1.5, pitch: t.pitch - 0.5 };
		const res = await matchKnownPrior(makeContext(world), prior);
		const e = poseError(res.pose, t);
		expect(e.yaw).toBeLessThan(0.1);
		expect(e.pitch).toBeLessThan(0.1);
		expect(e.roll).toBeLessThan(0.1);
		expect(res.method).toBe("fused");
		expect(res.confidenceLevel).toBe("high");
		expect(res.confidenceChecks?.matchSupport ?? 0).toBeGreaterThanOrEqual(0.3);
	});

	it("matchAdhoc with only a vfov sweeps 360° and recovers the pose", async () => {
		const world = createFakeWorld();
		const t = world.truePose;
		const res = await matchAdhoc(makeContext(world), {
			prior: { vfov: t.vfov },
		});
		const e = poseError(res.pose, t);
		expect(e.yaw).toBeLessThan(0.2);
		expect(e.pitch).toBeLessThan(0.2);
		expect(e.roll).toBeLessThan(0.2);
		const adhoc = (
			res as unknown as {
				adhoc: {
					stages: { stage: string; used: boolean }[];
					yawKnown: boolean;
				};
			}
		).adhoc;
		expect(adhoc.yawKnown).toBe(false);
		expect(adhoc.stages[0].stage).toBe("match-sweep");
		expect(adhoc.stages[0].used).toBe(true);
		expect(res.confidenceLevel).toBe("high");
	});

	it("a manual position runs the basin gap: a clear gap keeps HIGH, a small one or a failed check is LOW", async () => {
		const world = createFakeWorld();
		const req = {
			prior: { vfov: world.truePose.vfov },
			positionSource: "manual",
		};
		const grid = (gap: number) => ({
			gap,
			grid: {
				step: 250,
				n: 81,
				evaluated: 10,
				best: { E: 0, N: 0, cost: 100 },
				second: { E: 500, N: 0, cost: 100 * (1 + gap) },
			},
			sigma: { sky: 1, match: 1 },
			ms: 1,
			scorer: "test",
		});
		const jobs: BasinJob[] = [];
		const ok = await matchAdhoc(
			makeContext(world, {
				basinGap: async (job) => {
					jobs.push(job);
					return grid(0.5);
				},
			}),
			req,
		);
		expect(poseError(ok.pose, world.truePose).yaw).toBeLessThan(0.2);
		expect(ok.confidenceLevel).toBe("high");
		expect(ok.confidenceChecks?.basinGap).toBe(0.5);
		expect(ok.confidenceChecks?.positionTrusted).toBe(false);
		expect(jobs[0].lat).toBe(46.7);
		expect(jobs[0].sk).not.toBeNull();
		expect(jobs[0].corr?.x2d.length).toBeGreaterThan(0);
		const small = await matchAdhoc(
			makeContext(world, { basinGap: async () => grid(0.1) }),
			req,
		);
		expect(small.confidenceLevel).toBe("low");
		expect(small.lowReason).toBe("basinGap");
		const failed = await matchAdhoc(
			makeContext(world, {
				basinGap: async () => {
					throw new Error("no DEM");
				},
			}),
			req,
		);
		expect(failed.confidenceLevel).toBe("low");
		expect(failed.lowReason).toBe("basinGap unavailable (no DEM)");
	});

	it("a past deadline rejects with Deadline, an aborted signal with AbortError", async () => {
		const world = createFakeWorld();
		const prior = { ...world.truePose, yaw: world.truePose.yaw + 1 };
		await expect(
			matchKnownPrior(
				makeContext(world, { deadline: performance.now() - 1 }),
				prior,
			),
		).rejects.toMatchObject({ name: "Deadline" });
		const controller = new AbortController();
		controller.abort();
		await expect(
			matchKnownPrior(makeContext(world, { signal: controller.signal }), prior),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(world.calls.renderPoseView).toBe(0);
	});

	// getComputeDevice() resolves null under ?gpu=off, so the T6 sky search takes the CPU grid.
	it("matchAdhocT6 verifies a candidate at the true pose (CPU sky grid)", async () => {
		withFlags({ gpu: "off" });
		const world = createFakeWorld();
		const t = world.truePose;
		const res = await matchAdhocT6(makeContext(world), {
			prior: { vfov: t.vfov },
		});
		const e = poseError(res.pose, t);
		expect(e.yaw).toBeLessThan(0.3);
		expect(e.pitch).toBeLessThan(0.3);
		expect(e.roll).toBeLessThan(0.3);
		expect(res.method).toBe("fused");
	}, 60_000);
});

describe("service.runMatch", () => {
	function stubBrowserRaster(world: FakeWorld) {
		vi.stubGlobal("createImageBitmap", async () => ({
			width: world.photo.width,
			height: world.photo.height,
			close() {},
		}));
		vi.stubGlobal(
			"OffscreenCanvas",
			class {
				constructor(
					private readonly W: number,
					private readonly H: number,
				) {}
				getContext() {
					return {
						drawImage() {},
						// real getImageData is synchronous; rasterize() returns it from an async function
						getImageData: () => world.photo.at(this.W, this.H),
					};
				}
			},
		);
	}

	function boundEngine(world: FakeWorld, id = "IMG_TEST") {
		return {
			...world.engine,
			// yield a macrotask per render so the test can observe the running job
			renderPoseView: async (pose: Pose) => {
				await new Promise((r) => setTimeout(r, 0));
				return world.engine.renderPoseView(pose);
			},
			photo: { id } as never,
			photoElement: {} as HTMLImageElement,
		};
	}

	it("returns null without a bound engine, without models and for another photo id", async () => {
		const world = createFakeWorld();
		setFeatureLoader(async () => world.features);
		const prior = { ...world.truePose, yaw: world.truePose.yaw + 1 };
		expect(await modelsAvailable()).toBe(false);
		expect(await runMatch({ photoId: "IMG_TEST", prior })).toBeNull();

		const unbind = bindMatcherEngine(boundEngine(world));
		expect(await modelsAvailable()).toBe(true);
		expect(await runMatch({ photoId: "OTHER", prior })).toBeNull();
		setFeatureLoader(async () => null);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		expect(await modelsAvailable()).toBe(false);
		expect(await runMatch({ photoId: "IMG_TEST", prior })).toBeNull();
		unbind();
	});

	it("matches the bound engine's photo end to end and serialises concurrent jobs", async () => {
		const world = createFakeWorld();
		stubBrowserRaster(world);
		setFeatureLoader(async () => world.features);
		const unbind = bindMatcherEngine(boundEngine(world));
		const t = world.truePose;
		const prior = { ...t, yaw: t.yaw + 1.5, pitch: t.pitch - 0.5 };
		const onBusy = vi.fn();
		const first = runMatch({ photoId: "IMG_TEST", prior }, { onBusy });
		await vi.waitFor(() => expect(queueState().running).toBe(true));
		const second = runMatch({ photoId: "IMG_TEST", prior }, { onBusy });
		await vi.waitFor(() => expect(onBusy).toHaveBeenCalledTimes(1));
		expect(queueState().waiting).toBe(1);
		const [a, b] = await Promise.all([first, second]);
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		const e = poseError((a as NonNullable<typeof a>).pose, t);
		expect(e.yaw).toBeLessThan(0.1);
		expect(e.pitch).toBeLessThan(0.1);
		expect(a?.confidenceLevel).toBe("high");
		expect(a?.version).toContain("rigi-matcher");
		expect(queueState()).toEqual({ running: false, waiting: 0 });
		unbind();
	});

	it("an already aborted request resolves null", async () => {
		const world = createFakeWorld();
		setFeatureLoader(async () => world.features);
		const unbind = bindMatcherEngine(boundEngine(world));
		const controller = new AbortController();
		controller.abort();
		expect(
			await runMatch(
				{ photoId: "IMG_TEST", prior: world.truePose },
				{ signal: controller.signal },
			),
		).toBeNull();
		unbind();
	});
});
