// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pose } from "../camera";

type Mod = typeof import("../matcher-client");
let M: Mod;

const pose = (yaw: number, pitch = 0): Pose => ({
	yaw,
	pitch,
	roll: 0,
	vfov: 50,
});
// the in-browser matcher (src/lib/matcher/service.ts), stubbed: the client is its thin facade
const svc = {
	modelsAvailable: vi.fn(async () => true),
	queueState: vi.fn(() => ({ running: false, waiting: 0 })),
	runMatch: vi.fn(
		async (_req: unknown, _o?: { onBusy?: () => void }): Promise<unknown> =>
			result(),
	),
};

const result = (over: Record<string, unknown> = {}) => ({
	ok: true,
	pose: pose(10, 1),
	inliers: 80,
	inlierFrac: 0.8,
	nLifted: 100,
	residualPx: 2,
	coverage: 0.9,
	confidence: 0.9,
	deltaYawFromPrior: 1,
	timingMs: {},
	version: "v0.3",
	...over,
});

beforeEach(async () => {
	vi.resetModules();
	svc.modelsAvailable.mockReset().mockImplementation(async () => true);
	svc.queueState
		.mockReset()
		.mockImplementation(() => ({ running: false, waiting: 0 }));
	svc.runMatch.mockReset().mockImplementation(async () => result());
	vi.doMock("../matcher/service", () => svc);
	vi.spyOn(console, "debug").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	M = await import("../matcher-client");
});
afterEach(() => vi.useRealTimers());

describe("matchIsConfident", () => {
	const base = result() as unknown as import("../matcher-client").MatchResult;
	it("trusts confidenceLevel when present", () => {
		expect(
			M.matchIsConfident({ ...base, confidenceLevel: "high", confidence: 0.1 }),
		).toBe(true);
		expect(
			M.matchIsConfident({ ...base, confidenceLevel: "low", confidence: 0.99 }),
		).toBe(false);
	});
	it("falls back to the v0.1 heuristic at 0.5", () => {
		expect(M.matchIsConfident({ ...base, confidence: 0.5 })).toBe(true);
		expect(M.matchIsConfident({ ...base, confidence: 0.49 })).toBe(false);
	});
});

describe("matchAccepted", () => {
	const hi = {
		...result(),
		pose: pose(100, 5),
		confidenceLevel: "high",
	} as unknown as import("../matcher-client").MatchResult;
	const lo = {
		...hi,
		confidenceLevel: "low",
	} as import("../matcher-client").MatchResult;
	it("rejects anything not HIGH, even with a trusted position", () => {
		expect(M.matchAccepted(lo, { positionTrusted: true })).toBe(false);
	});
	it("accepts HIGH with a trusted position without a cascade", () => {
		expect(M.matchAccepted(hi, { positionTrusted: true })).toBe(true);
	});
	it("the server's positionTrusted verdict beats the caller's", () => {
		const untrusted = {
			...hi,
			confidenceChecks: {
				cueAgreeDeg: 0,
				skylineMedPx: 1,
				matchSupport: 1,
				positionTrusted: false,
			},
		} as import("../matcher-client").MatchResult;
		expect(M.matchAccepted(untrusted, { positionTrusted: true })).toBe(false);
		const trusted = {
			...hi,
			confidenceChecks: {
				cueAgreeDeg: 0,
				skylineMedPx: 1,
				matchSupport: 1,
				positionTrusted: true,
			},
		} as import("../matcher-client").MatchResult;
		expect(M.matchAccepted(trusted, { positionTrusted: false })).toBe(true);
	});
	it("an untrusted position needs the cascade within 0.5 deg in yaw and pitch", () => {
		expect(M.matchAccepted(hi, { positionTrusted: false })).toBe(false);
		expect(
			M.matchAccepted(hi, { positionTrusted: false, cascadePose: null }),
		).toBe(false);
		expect(
			M.matchAccepted(hi, {
				positionTrusted: false,
				cascadePose: pose(100.4, 5.4),
			}),
		).toBe(true);
		expect(
			M.matchAccepted(hi, {
				positionTrusted: false,
				cascadePose: pose(100.6, 5),
			}),
		).toBe(false);
		expect(
			M.matchAccepted(hi, {
				positionTrusted: false,
				cascadePose: pose(100, 5.6),
			}),
		).toBe(false);
		expect(M.MATCH_AGREE_DEG).toBe(0.5);
	});
	it("compares yaw across the 0/360 wrap", () => {
		const h = { ...hi, pose: pose(359.8, 0) };
		expect(
			M.matchAccepted(h, { positionTrusted: false, cascadePose: pose(0.2, 0) }),
		).toBe(true);
	});
});

describe("shouldEscalate", () => {
	it("escalates without a skyline result or with non-finite confidence", () => {
		expect(
			M.shouldEscalate({ skylineConfidence: null, skylinePose: pose(0) }),
		).toBe(true);
		expect(
			M.shouldEscalate({ skylineConfidence: undefined, skylinePose: pose(0) }),
		).toBe(true);
		expect(
			M.shouldEscalate({ skylineConfidence: 0.9, skylinePose: null }),
		).toBe(true);
		expect(
			M.shouldEscalate({ skylineConfidence: Number.NaN, skylinePose: pose(0) }),
		).toBe(true);
	});
	it("escalates below the confidence floor, not at it", () => {
		expect(
			M.shouldEscalate({ skylineConfidence: 0.49, skylinePose: pose(0) }),
		).toBe(true);
		expect(
			M.shouldEscalate({ skylineConfidence: 0.5, skylinePose: pose(0) }),
		).toBe(false);
		expect(
			M.shouldEscalate({
				skylineConfidence: 0.3,
				skylinePose: pose(0),
				minConfidence: 0.2,
			}),
		).toBe(false);
	});
	it("escalates when two skyline solvers disagree by more than 1 deg", () => {
		const base = { skylineConfidence: 0.9, skylinePose: pose(10, 0) };
		expect(M.shouldEscalate({ ...base, altSkylinePose: pose(10.9, 0) })).toBe(
			false,
		);
		expect(M.shouldEscalate({ ...base, altSkylinePose: pose(11.1, 0) })).toBe(
			true,
		);
		expect(M.shouldEscalate({ ...base, altSkylinePose: pose(10, -1.1) })).toBe(
			true,
		);
		expect(
			M.shouldEscalate({
				...base,
				altSkylinePose: pose(10.9, 0),
				maxSolverDisagreeDeg: 0.5,
			}),
		).toBe(true);
	});
	it("does not escalate on a compass-prior difference alone", () => {
		expect(
			M.shouldEscalate({ skylineConfidence: 0.9, skylinePose: pose(10) }),
		).toBe(false);
	});
	it("wraps yaw disagreement at 360", () => {
		expect(
			M.shouldEscalate({
				skylineConfidence: 0.9,
				skylinePose: pose(359.8),
				altSkylinePose: pose(0.3),
			}),
		).toBe(false);
	});
});

describe("matcherAvailable", () => {
	it("is the models' availability, cached 60 s when up and 15 s when down", async () => {
		vi.useFakeTimers();
		expect(await M.matcherAvailable()).toBe(true);
		svc.modelsAvailable.mockImplementation(async () => false);
		expect(await M.matcherAvailable()).toBe(true); // cached
		vi.advanceTimersByTime(60_001);
		expect(await M.matcherAvailable()).toBe(false);
		svc.modelsAvailable.mockImplementation(async () => true);
		vi.advanceTimersByTime(10_000);
		expect(await M.matcherAvailable()).toBe(false);
		expect(await M.matcherAvailable(true)).toBe(true); // force bypasses
	});

	it("shares one in-flight probe and never throws", async () => {
		svc.modelsAvailable.mockImplementation(async () => {
			throw new Error("no weights");
		});
		const [a, b] = await Promise.all([
			M.matcherAvailable(),
			M.matcherAvailable(),
		]);
		expect([a, b]).toEqual([false, false]);
		expect(svc.modelsAvailable).toHaveBeenCalledTimes(1);
	});
});

describe("matcherLoad", () => {
	it("reports the page's match queue", async () => {
		expect(await M.matcherLoad()).toEqual({
			busy: false,
			waiting: 0,
			etaS: null,
		});
		svc.queueState.mockImplementation(() => ({ running: true, waiting: 0 }));
		expect((await M.matcherLoad())?.busy).toBe(true);
		svc.queueState.mockImplementation(() => ({ running: false, waiting: 2 }));
		expect(await M.matcherLoad()).toEqual({
			busy: true,
			waiting: 2,
			etaS: null,
		});
	});
});

describe("requestMatch", () => {
	const req = { photoId: "IMG_1", prior: pose(0) };

	it("returns null without running when aborted or unavailable", async () => {
		const ctl = new AbortController();
		ctl.abort();
		expect(await M.requestMatch(req, { signal: ctl.signal })).toBeNull();
		svc.modelsAvailable.mockImplementation(async () => false);
		expect(await M.requestMatch(req)).toBeNull();
		expect(svc.runMatch).not.toHaveBeenCalled();
	});

	it("runs the in-browser match with the caller's signal and timeout", async () => {
		const ctl = new AbortController();
		const r = await M.requestMatch(req, {
			signal: ctl.signal,
			timeoutMs: 1234,
		});
		expect(r?.pose).toEqual(pose(10, 1));
		const [sent, o] = svc.runMatch.mock.calls[0] as unknown as [
			unknown,
			{ signal: AbortSignal; timeoutMs: number },
		];
		expect(sent).toBe(req);
		expect(o.signal).toBe(ctl.signal);
		expect(o.timeoutMs).toBe(1234);
	});

	it("forwards a wait for another job as onBusy", async () => {
		svc.runMatch.mockImplementation(async (_r, o) => {
			o?.onBusy?.();
			return result();
		});
		const onBusy = vi.fn();
		await M.requestMatch(req, { onBusy });
		expect(onBusy).toHaveBeenCalledTimes(1);
	});
});

describe("requestMatchOrDefer", () => {
	const req = { photoId: "IMG_1", prior: pose(0) };

	it("awaits the result when the queue is idle", async () => {
		const r = await M.requestMatchOrDefer(req);
		expect("result" in r && r.result?.pose).toEqual(pose(10, 1));
	});

	it("defers at once while another job runs or waits", async () => {
		svc.queueState.mockImplementation(() => ({ running: true, waiting: 0 }));
		let finish: (v: unknown) => void = () => {};
		svc.runMatch.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const r = await M.requestMatchOrDefer(req);
		expect("deferred" in r).toBe(true);
		if (!("deferred" in r)) return;
		await vi.waitFor(() => expect(svc.runMatch).toHaveBeenCalled());
		finish(result());
		expect((await r.deferred)?.pose).toEqual(pose(10, 1));
	});
});
