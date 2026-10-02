// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pose } from "../camera";

type Mod = typeof import("../matcher-client");
let M: Mod;

const BASE = "http://localhost:8765";
const pose = (yaw: number, pitch = 0): Pose => ({
	yaw,
	pitch,
	roll: 0,
	vfov: 50,
});
const json = (body: unknown, init: ResponseInit = {}) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
		...init,
	});

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
	it("is true for { ok: true } and calls /health", async () => {
		const f = vi.fn(async () => json({ ok: true }));
		vi.stubGlobal("fetch", f);
		expect(await M.matcherAvailable()).toBe(true);
		expect(f).toHaveBeenCalledWith(
			`${BASE}/health`,
			expect.objectContaining({ signal: expect.anything() }),
		);
	});
	it.each([
		["HTTP error", () => new Response("no", { status: 500 })],
		["ok:false", () => json({ ok: false })],
		["ok as a truthy string", () => json({ ok: "yes" })],
	])("is false for %s", async (_n, make) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => make()),
		);
		expect(await M.matcherAvailable()).toBe(false);
	});
	it("is false when the service is down", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new TypeError("refused");
			}),
		);
		expect(await M.matcherAvailable()).toBe(false);
	});
	it("caches for 60 s when up, 15 s when down, and force bypasses", async () => {
		vi.useFakeTimers();
		const f = vi.fn(async () => json({ ok: true }));
		vi.stubGlobal("fetch", f);
		await M.matcherAvailable();
		vi.advanceTimersByTime(59_000);
		await M.matcherAvailable();
		expect(f).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(2000);
		await M.matcherAvailable();
		expect(f).toHaveBeenCalledTimes(2);
		await M.matcherAvailable(true);
		expect(f).toHaveBeenCalledTimes(3);
		f.mockImplementation(async () => new Response("", { status: 500 }));
		await M.matcherAvailable(true);
		vi.advanceTimersByTime(14_000);
		expect(await M.matcherAvailable()).toBe(false);
		expect(f).toHaveBeenCalledTimes(4);
		vi.advanceTimersByTime(2000);
		f.mockImplementation(async () => json({ ok: true }));
		expect(await M.matcherAvailable()).toBe(true);
	});
	it("shares one in-flight probe between concurrent callers", async () => {
		const f = vi.fn(async () => json({ ok: true }));
		vi.stubGlobal("fetch", f);
		await Promise.all([M.matcherAvailable(), M.matcherAvailable(true)]);
		expect(f).toHaveBeenCalledTimes(1);
	});
	it("times out a hung health probe after 800 ms", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_u: unknown, init?: RequestInit) =>
					new Promise((_r, rej) => {
						init?.signal?.addEventListener("abort", () =>
							rej(new DOMException("x", "AbortError")),
						);
					}),
			),
		);
		const p = M.matcherAvailable();
		await vi.advanceTimersByTimeAsync(801);
		expect(await p).toBe(false);
	});
});

describe("matcherLoad", () => {
	const load = async (body: unknown, status = 200) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json(body, { status })),
		);
		return M.matcherLoad();
	};
	it("reports an idle service", async () => {
		expect(await load({ ok: true })).toEqual({
			busy: false,
			waiting: 0,
			etaS: null,
		});
	});
	it("honours the legacy busy flag", async () => {
		expect(await load({ ok: true, busy: true })).toEqual({
			busy: true,
			waiting: 0,
			etaS: null,
		});
	});
	it("reads a numeric queue", async () => {
		expect(await load({ ok: true, queue: 3 })).toEqual({
			busy: true,
			waiting: 3,
			etaS: null,
		});
		expect(await load({ ok: true, queue: 0 })).toMatchObject({
			busy: false,
			waiting: 0,
		});
	});
	it("reads waiting/depth and eta aliases in priority order", async () => {
		expect(await load({ ok: true, queue: { waiting: 2, etaS: 12 } })).toEqual({
			busy: true,
			waiting: 2,
			etaS: 12,
		});
		expect(
			await load({ ok: true, queue: { depth: 4, remainingS: 9 } }),
		).toEqual({ busy: true, waiting: 4, etaS: 9 });
		expect(
			await load({ ok: true, queue: { waiting: 0, retryAfterS: 5 } }),
		).toEqual({ busy: false, waiting: 0, etaS: 5 });
	});
	it("a running job counts as busy even with nobody waiting", async () => {
		expect(await load({ ok: true, queue: { running: 1 } })).toMatchObject({
			busy: true,
			waiting: 0,
		});
	});
	it("ignores non-numeric fields", async () => {
		expect(
			await load({
				ok: true,
				queue: { waiting: "2", etaS: Number.POSITIVE_INFINITY },
			}),
		).toEqual({ busy: false, waiting: 0, etaS: null });
	});
	it("is null when down, not ok or unreachable", async () => {
		expect(await load({ ok: false })).toBeNull();
		expect(await load({}, 500)).toBeNull();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("x");
			}),
		);
		expect(await M.matcherLoad()).toBeNull();
	});
	it("does not use the availability cache", async () => {
		const f = vi.fn(async () => json({ ok: true }));
		vi.stubGlobal("fetch", f);
		await M.matcherLoad();
		await M.matcherLoad();
		expect(f).toHaveBeenCalledTimes(2);
	});
});

describe("requestMatch", () => {
	/** health OK for /health, and the given handler for /match. */
	const serve = (
		match: (init: RequestInit, n: number) => Response | Promise<Response>,
	) => {
		let n = 0;
		const f = vi.fn(async (u: RequestInfo | URL, init?: RequestInit) => {
			if (String(u).endsWith("/health")) return json({ ok: true });
			return match(init ?? {}, n++);
		});
		vi.stubGlobal("fetch", f);
		return f;
	};
	const matchCalls = (f: ReturnType<typeof vi.fn>) =>
		f.mock.calls.filter((c) => String(c[0]).endsWith("/match"));

	it("returns null without fetching when already aborted", async () => {
		const f = serve(() => json(result()));
		const ac = new AbortController();
		ac.abort();
		expect(
			await M.requestMatch(
				{ photoId: "p", prior: pose(0) },
				{ signal: ac.signal },
			),
		).toBeNull();
		expect(f).not.toHaveBeenCalled();
	});
	it("returns null when the service is down", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("down");
			}),
		);
		expect(await M.requestMatch({ photoId: "p", prior: pose(0) })).toBeNull();
	});
	it("sends a JSON body for a photoId request and returns the result", async () => {
		const f = serve(() => json(result()));
		const r = await M.requestMatch({
			photoId: "IMG_1",
			prior: pose(10),
			offsets: [0, 5],
		});
		expect(r?.pose).toEqual(pose(10, 1));
		const [url, init] = matchCalls(f)[0] as [string, RequestInit];
		expect(url).toBe(`${BASE}/match`);
		expect(init.method).toBe("POST");
		expect(new Headers(init.headers).get("content-type")).toBe(
			"application/json",
		);
		const body = JSON.parse(init.body as string);
		expect(body).toMatchObject({
			photoId: "IMG_1",
			prior: pose(10),
			offsets: [0, 5],
		});
		expect(body.timeoutMs).toBeGreaterThanOrEqual(1000);
		expect(body.timeoutMs).toBeLessThanOrEqual(60_000);
	});
	it("sends multipart for an ad-hoc photo with the request JSON and the photo", async () => {
		const f = serve(() => json(result()));
		await M.requestMatch({
			photo: new Blob(["jpg"]),
			meta: { lat: 47, lon: 8, altitudeM: null, positionSource: "manual" },
			prior: { pitch: 0 },
			yawSeeds: [10, 20],
		});
		const fd = (matchCalls(f)[0][1] as RequestInit).body as FormData;
		expect(fd).toBeInstanceOf(FormData);
		const req = JSON.parse(fd.get("request") as string);
		expect(req).toMatchObject({
			meta: { lat: 47, positionSource: "manual" },
			prior: { pitch: 0 },
			yawSeeds: [10, 20],
		});
		expect("yaw" in req.prior).toBe(false);
		expect((fd.get("photo") as File).name).toBe("photo.jpg");
	});
	it("sends views and skyline arrays as float32 blobs for a pre-rendered request", async () => {
		const f = serve(() => json(result()));
		const xyz = Float32Array.from([1, 2, 3, 4]);
		await M.requestMatch({
			photo: new Blob(["jpg"]),
			eye: [0, 0, 1],
			prior: pose(0),
			views: [
				{ tag: "v0", pose: pose(1), W: 2, H: 1, rgb: new Blob(["rgb"]), xyz },
			],
			skyline: {
				w: 2,
				h: 1,
				pose: pose(2),
				horizon: new Float32Array(2),
				fine: new Float32Array(2),
				fg: new Float32Array(2),
				sky: new Float32Array(2),
			},
		});
		const fd = (matchCalls(f)[0][1] as RequestInit).body as FormData;
		const req = JSON.parse(fd.get("request") as string);
		expect(req.views).toEqual([{ tag: "v0", pose: pose(1), W: 2, H: 1 }]);
		expect(req.skyline).toMatchObject({ w: 2, h: 1, pose: pose(2) });
		expect((fd.get("xyz:v0") as File).size).toBe(16);
		expect((fd.get("rgb:v0") as File).name).toBe("v0.jpg");
		for (const k of ["horizon", "fine", "fg", "sky"])
			expect((fd.get(`skyline:${k}`) as File).size).toBe(8);
	});
	it("returns null for ok:false, missing pose, HTTP errors and non-JSON", async () => {
		for (const make of [
			() => json({ ok: false, error: { code: "E", message: "m" } }),
			() => json({ ok: true }),
			() => json(result(), { status: 500 }),
			() => new Response("<html>", { status: 200 }),
		]) {
			vi.resetModules();
			M = await import("../matcher-client");
			serve(() => make());
			expect(await M.requestMatch({ photoId: "p", prior: pose(0) })).toBeNull();
		}
	});
	it("logs the service's error code and message", async () => {
		const w = vi.spyOn(console, "warn").mockImplementation(() => {});
		serve(() =>
			json({ ok: false, error: { code: "NO_POSE", message: "nothing" } }),
		);
		await M.requestMatch({ photoId: "p", prior: pose(0) });
		expect(w).toHaveBeenCalledWith("[matcher]", "NO_POSE", "nothing");
	});
	it("a network failure marks the service down for the health cache", async () => {
		const f = serve(() => {
			throw new TypeError("reset");
		});
		expect(await M.requestMatch({ photoId: "p", prior: pose(0) })).toBeNull();
		const before = f.mock.calls.length;
		expect(await M.matcherAvailable()).toBe(false);
		expect(f.mock.calls.length).toBe(before); // answered from the cache
	});
	it("an abort does not poison the health cache", async () => {
		const ac = new AbortController();
		serve(
			(init) =>
				new Promise((_r, rej) => {
					init.signal?.addEventListener("abort", () =>
						rej(new DOMException("a", "AbortError")),
					);
					queueMicrotask(() => ac.abort());
				}),
		);
		expect(
			await M.requestMatch(
				{ photoId: "p", prior: pose(0) },
				{ signal: ac.signal },
			),
		).toBeNull();
		expect(await M.matcherAvailable()).toBe(true);
	});
	it("retries a 503 after Retry-After, carrying the queue ticket, and reports onBusy", async () => {
		vi.useFakeTimers();
		const f = serve((_init, n) =>
			n === 0
				? new Response("", {
						status: 503,
						headers: { "Retry-After": "2", "X-Queue-Ticket": "t-7" },
					})
				: json(result()),
		);
		const onBusy = vi.fn();
		const p = M.requestMatch(
			{ photoId: "p", prior: pose(0) },
			{ onBusy, timeoutMs: 120_000 },
		);
		await vi.advanceTimersByTimeAsync(2100);
		const r = await p;
		expect(r?.confidence).toBe(0.9);
		expect(onBusy).toHaveBeenCalledWith(2);
		const calls = matchCalls(f);
		expect(calls).toHaveLength(2);
		expect(
			new Headers((calls[0][1] as RequestInit).headers).get("X-Queue-Ticket"),
		).toBeNull();
		expect(
			new Headers((calls[1][1] as RequestInit).headers).get("X-Queue-Ticket"),
		).toBe("t-7");
	});
	it("defaults Retry-After to 5 s", async () => {
		vi.useFakeTimers();
		const f = serve((_i, n) =>
			n === 0 ? new Response("", { status: 503 }) : json(result()),
		);
		const onBusy = vi.fn();
		const p = M.requestMatch(
			{ photoId: "p", prior: pose(0) },
			{ onBusy, timeoutMs: 120_000 },
		);
		await vi.advanceTimersByTimeAsync(4900);
		expect(matchCalls(f)).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(200);
		await p;
		expect(onBusy).toHaveBeenCalledWith(5);
		expect(matchCalls(f)).toHaveLength(2);
	});
	it("does not retry when a job would no longer fit before the deadline", async () => {
		const f = serve(
			() => new Response("", { status: 503, headers: { "Retry-After": "10" } }),
		);
		const onBusy = vi.fn();
		const r = await M.requestMatch(
			{ photoId: "p", prior: pose(0) },
			{ onBusy, timeoutMs: 20_000 },
		);
		expect(r).toBeNull();
		expect(onBusy).toHaveBeenCalledTimes(1);
		expect(matchCalls(f)).toHaveLength(1);
	});
});

describe("requestMatchOrDefer", () => {
	const setup = (health: unknown, match: () => Response | Promise<Response>) =>
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: RequestInfo | URL) =>
				String(u).endsWith("/health") ? json(health) : match(),
			),
		);
	it("returns the result directly on an idle service", async () => {
		setup({ ok: true }, () => json(result()));
		const r = await M.requestMatchOrDefer({ photoId: "p", prior: pose(0) });
		expect("result" in r && r.result?.confidence).toBe(0.9);
	});
	it("defers immediately when /health shows contention", async () => {
		setup({ ok: true, queue: 2 }, () => json(result()));
		const r = await M.requestMatchOrDefer({ photoId: "p", prior: pose(0) });
		expect("deferred" in r).toBe(true);
		if ("deferred" in r) expect((await r.deferred)?.confidence).toBe(0.9);
	});
	it("defers on the first 503 and still resolves the match later", async () => {
		vi.useFakeTimers();
		let n = 0;
		setup({ ok: true }, () =>
			n++ === 0
				? new Response("", { status: 503, headers: { "Retry-After": "1" } })
				: json(result()),
		);
		const p = M.requestMatchOrDefer(
			{ photoId: "p", prior: pose(0) },
			{ timeoutMs: 120_000 },
		);
		await vi.advanceTimersByTimeAsync(1500);
		const r = await p;
		expect("deferred" in r).toBe(true);
		await vi.advanceTimersByTimeAsync(1500);
		if ("deferred" in r) expect((await r.deferred)?.confidence).toBe(0.9);
	});
});
