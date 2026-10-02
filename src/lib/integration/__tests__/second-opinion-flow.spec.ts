// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pose } from "#/lib/camera";
import type { MatchResult } from "#/lib/matcher-client";
import type { PhotoMeta } from "#/lib/photos";

const matcher = vi.hoisted(() => ({
	available: vi.fn(),
	defer: vi.fn(),
	request: vi.fn(),
}));
vi.mock("#/lib/matcher-client", async (orig) => ({
	...(await orig<typeof import("#/lib/matcher-client")>()),
	matcherAvailable: matcher.available,
	requestMatchOrDefer: matcher.defer,
	requestMatch: matcher.request,
}));

import { AGREE_DEG, type AppAlign, secondOpinion } from "../second-opinion";
import type { UnknownPoseResult, UnknownPoseSolver } from "../unknown-pose";

const pose = (yaw: number, pitch = 0): Pose => ({
	yaw,
	pitch,
	roll: 0,
	vfov: 50,
});
const prior = pose(100);
const photo = (id: string) =>
	({
		id,
		src: "blob:x",
		lat: 46.7,
		lon: 7.8,
		alt: 1500,
		hAccuracy: 5,
		width: 4000,
		height: 3000,
	}) as unknown as PhotoMeta;
const img = {} as HTMLImageElement;
const appAuto = (yaw: number, confidence = 0.9): AppAlign => ({
	pose: pose(yaw),
	confidence,
	state: "auto",
});
const appPrior: AppAlign = { pose: prior, confidence: null, state: "prior" };

const cascadeResult = (
	yaw: number,
	accepted: boolean,
	confidence = 0.8,
): UnknownPoseResult => ({
	pose: pose(yaw),
	confidence,
	accepted,
	stage: "solve",
	candidates: [{ pose: pose(yaw), confidence, stage: "solve", accepted }],
	seeds: [],
	ms: { horizon: 1, total: 2 },
});

const solverOf = (impl: (...a: unknown[]) => Promise<UnknownPoseResult>) => {
	const solver = { solve: vi.fn(impl), dispose: vi.fn() };
	return { solver, as: solver as unknown as UnknownPoseSolver };
};

const high = (yaw = 101): MatchResult =>
	({
		pose: pose(yaw),
		confidence: 0.9,
		confidenceLevel: "high",
		confidenceChecks: { positionTrusted: true },
	}) as unknown as MatchResult;
const low = (): MatchResult =>
	({ ...high(), confidence: 0.2, confidenceLevel: "low" }) as MatchResult;

beforeEach(() => {
	matcher.available.mockReset().mockResolvedValue(true);
	matcher.defer.mockReset();
	matcher.request.mockReset();
	vi.spyOn(console, "warn").mockImplementation(() => {});
});

const run = (
	s: ReturnType<typeof solverOf>,
	app: AppAlign,
	p = photo("IMG_1"),
	extra: {
		timeoutMs?: number;
		signal?: AbortSignal;
		onUnverified?: (n: string) => void;
	} = {},
) =>
	secondOpinion(p, img, prior, app, {
		signal: extra.signal ?? new AbortController().signal,
		solver: s.as,
		timeoutMs: extra.timeoutMs,
		onUnverified: extra.onUnverified,
	});

describe("secondOpinion verdicts", () => {
	it("verified: both accept within AGREE_DEG, the app pose stands", async () => {
		const s = solverOf(async () => cascadeResult(90 + AGREE_DEG - 0.1, true));
		const r = await run(s, appAuto(90));
		expect(r.verdict).toBe("verified");
		expect(r.pose.yaw).toBe(90);
		expect(r.disagreeDeg).toBeCloseTo(AGREE_DEG - 0.1, 9);
		expect(r.matcher).toBeNull();
		expect(s.solver.dispose).toHaveBeenCalledTimes(1);
	});

	it("refined: the accepting cascade overrules a disagreeing app pose", async () => {
		const r = await run(
			solverOf(async () => cascadeResult(93, true)),
			appAuto(90),
		);
		expect(r.verdict).toBe("refined");
		expect(r.pose.yaw).toBe(93);
		expect(r.note).toMatch(/overruled/);
		expect(r.cascade?.accepted).toBe(true);
	});

	it("refined: takes the cascade pose when the app did not accept", async () => {
		const r = await run(
			solverOf(async () => cascadeResult(120, true)),
			appPrior,
		);
		expect(r.verdict).toBe("refined");
		expect(r.pose.yaw).toBe(120);
		expect(r.note).not.toMatch(/overruled/);
	});

	it("measures disagreement across the 0/360 seam", async () => {
		const r = await run(
			solverOf(async () => cascadeResult(359.5, true)),
			appAuto(0.2),
		);
		expect(r.verdict).toBe("verified");
		expect(r.disagreeDeg).toBeCloseTo(0.7, 9);
	});

	it("kept: a rejected cascade that agrees with a confident app pose does not escalate", async () => {
		const r = await run(
			solverOf(async () => cascadeResult(90.3, false)),
			appAuto(90, 0.9),
		);
		expect(r.verdict).toBe("kept");
		expect(r.pose.yaw).toBe(90);
		expect(matcher.available).not.toHaveBeenCalled();
	});

	it("unverified/unavailable: weak app and rejected cascade with no match service", async () => {
		matcher.available.mockResolvedValue(false);
		const r = await run(
			solverOf(async () => cascadeResult(40, false, 0.1)),
			appPrior,
		);
		expect(r.verdict).toBe("unverified");
		expect(r.matcher).toBe("unavailable");
		expect(r.pose).toBe(prior);
		expect(matcher.defer).not.toHaveBeenCalled();
	});

	it("matched: escalates a bundled photo by id and takes an accepted match", async () => {
		matcher.defer.mockResolvedValue({ result: high(101) });
		const seen: string[] = [];
		const r = await run(
			solverOf(async () => cascadeResult(40, false, 0.1)),
			appPrior,
			photo("IMG_9"),
			{
				onUnverified: (n) => seen.push(n),
			},
		);
		expect(r.verdict).toBe("matched");
		expect(r.matcher).toBe("high");
		expect(r.pose.yaw).toBe(101);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatch(/checking with render-and-match/);
		expect(matcher.defer.mock.calls[0][0]).toMatchObject({
			photoId: "IMG_9",
			fused: true,
		});
	});

	it("escalates an upload through the ad-hoc matcher with its photo bytes", async () => {
		vi.stubGlobal("fetch", async () => new Response(new Blob(["jpeg"])));
		matcher.defer.mockResolvedValue({ result: high(101) });
		const r = await run(
			solverOf(async () => cascadeResult(40, false, 0.1)),
			appPrior,
			photo("local-abc"),
		);
		expect(r.verdict).toBe("matched");
		const req = matcher.defer.mock.calls[0][0];
		expect(req.photo).toBeInstanceOf(Blob);
		expect(req.photoId).toBeUndefined();
		expect(req.meta).toMatchObject({ lat: 46.7, positionSource: "exif-gps" });
	});

	it("unverified/low and /no-result when the match is not accepted", async () => {
		matcher.defer.mockResolvedValue({ result: low() });
		const lowR = await run(
			solverOf(async () => cascadeResult(40, false, 0.1)),
			appPrior,
		);
		expect(lowR).toMatchObject({ verdict: "unverified", matcher: "low" });
		matcher.defer.mockResolvedValue({ result: null });
		const none = await run(
			solverOf(async () => cascadeResult(40, false, 0.1)),
			appPrior,
		);
		expect(none).toMatchObject({ verdict: "unverified", matcher: "no-result" });
		expect(none.pose).toBe(prior);
	});

	it("an untrusted-position match needs the cascade to agree within 0.5 degrees", async () => {
		const m = {
			...high(101),
			confidenceChecks: { positionTrusted: false },
		} as unknown as MatchResult;
		matcher.defer.mockResolvedValue({ result: m });
		const far = await run(
			solverOf(async () => cascadeResult(40, false, 0.1)),
			appPrior,
		);
		expect(far.matcher).toBe("low");
		const near = await run(
			solverOf(async () => cascadeResult(100.8, false, 0.1)),
			appPrior,
		);
		expect(near.verdict).toBe("matched");
	});

	it("busy: returns unverified at once and upgrades when the deferred match is confident", async () => {
		matcher.defer.mockResolvedValue({ deferred: Promise.resolve(high(102)) });
		const r = await run(
			solverOf(async () => cascadeResult(40, false, 0.1)),
			appPrior,
		);
		expect(r).toMatchObject({ verdict: "unverified", matcher: "busy" });
		const up = await r.upgrade;
		expect(up?.verdict).toBe("matched");
		expect(up?.pose.yaw).toBe(102);
	});

	it("busy: the upgrade resolves to null for a low-confidence or missing match", async () => {
		matcher.defer.mockResolvedValue({ deferred: Promise.resolve(low()) });
		expect(
			await (
				await run(
					solverOf(async () => cascadeResult(40, false, 0.1)),
					appPrior,
				)
			).upgrade,
		).toBeNull();
		matcher.defer.mockResolvedValue({ deferred: Promise.resolve(null) });
		expect(
			await (
				await run(
					solverOf(async () => cascadeResult(40, false, 0.1)),
					appPrior,
				)
			).upgrade,
		).toBeNull();
	});
});

describe("secondOpinion failure modes", () => {
	it("timeout: keeps the app pose when the cascade misses the deadline, and disposes the solver", async () => {
		const s = solverOf(
			(_i, _p, _u, signal) =>
				new Promise((_res, rej) => {
					(signal as AbortSignal).addEventListener("abort", () =>
						rej(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const r = await run(s, appAuto(90), photo("IMG_1"), { timeoutMs: 15 });
		expect(r.verdict).toBe("timeout");
		expect(r.pose.yaw).toBe(90);
		expect(r.cascade).toBeNull();
		expect(s.solver.dispose).toHaveBeenCalledTimes(1);
	});

	it("kept: any other cascade failure keeps the app pose", async () => {
		const s = solverOf(async () => {
			throw new Error("worker crashed");
		});
		const r = await run(s, appAuto(90));
		expect(r.verdict).toBe("kept");
		expect(s.solver.dispose).toHaveBeenCalledTimes(1);
	});

	it("rethrows when the caller's signal aborts", async () => {
		const ac = new AbortController();
		const s = solverOf(
			(_i, _p, _u, signal) =>
				new Promise((_res, rej) => {
					(signal as AbortSignal).addEventListener("abort", () =>
						rej(new DOMException("aborted", "AbortError")),
					);
				}),
		);
		const p = run(s, appAuto(90), photo("IMG_1"), { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
		expect(s.solver.dispose).toHaveBeenCalledTimes(1);
	});

	it("an abort while the match runs throws instead of returning a verdict", async () => {
		const ac = new AbortController();
		matcher.defer.mockImplementation(async () => {
			ac.abort();
			return { result: high() };
		});
		await expect(
			run(
				solverOf(async () => cascadeResult(40, false, 0.1)),
				appPrior,
				photo("IMG_1"),
				{
					signal: ac.signal,
				},
			),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("the cascade is asked for a solve with nothing unknown", async () => {
		const s = solverOf(async () => cascadeResult(90, true));
		await run(s, appAuto(90));
		expect(s.solver.solve.mock.calls[0][1]).toBe(prior);
		expect(s.solver.solve.mock.calls[0][2]).toEqual({
			yaw: false,
			gravity: false,
			focal: false,
			any: false,
		});
	});
});
