// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pose } from "#/lib/camera";
import type { MatchResult } from "#/lib/matcher-client";
import type { PhotoMeta } from "#/lib/photos";

const matcher = vi.hoisted(() => ({ request: vi.fn(), defer: vi.fn() }));
vi.mock("#/lib/matcher-client", async (orig) => ({
	...(await orig<typeof import("#/lib/matcher-client")>()),
	requestMatch: matcher.request,
	requestMatchOrDefer: matcher.defer,
}));

import {
	matchUnknownPose,
	resolveUnknownPose,
	type UnknownPoseRequest,
	type UnknownPoseResponse,
	type UnknownPoseResult,
	UnknownPoseSolver,
	type Unknowns,
} from "../unknown-pose";

const pose = (yaw: number, pitch = 0): Pose => ({
	yaw,
	pitch,
	roll: 0,
	vfov: 50,
});
const prior = pose(10);
const fallback = pose(77);
const photo = (over: Record<string, unknown> = {}) =>
	({
		id: "local-1",
		src: "blob:p",
		lat: 46.7,
		lon: 7.8,
		alt: 1500,
		hAccuracy: 8,
		width: 4000,
		height: 3000,
		gravity: null,
		...over,
	}) as unknown as PhotoMeta;
const unk = (o: Partial<Unknowns> = {}): Unknowns => ({
	yaw: true,
	gravity: true,
	focal: false,
	any: true,
	...o,
});
const img = { naturalWidth: 4000, naturalHeight: 3000 } as HTMLImageElement;

const cascade = (
	accepted: boolean,
	yaw = 120,
	confidence = 0.8,
): UnknownPoseResult => ({
	pose: pose(yaw),
	confidence,
	accepted,
	stage: "solve",
	candidates: [
		{ pose: pose(yaw), confidence, stage: "solve", accepted },
		{ pose: pose(yaw + 90), confidence: 0.1, stage: "refine", accepted: false },
	],
	seeds: [],
	ms: { horizon: 1, total: 2 },
});
const high = (yaw = 121, trusted = true): MatchResult =>
	({
		pose: pose(yaw),
		confidence: 0.9,
		confidenceLevel: "high",
		confidenceChecks: { positionTrusted: trusted },
	}) as unknown as MatchResult;

const solverStub = (impl: () => Promise<UnknownPoseResult>) =>
	({ solve: vi.fn(impl), dispose: vi.fn() }) as unknown as UnknownPoseSolver & {
		solve: ReturnType<typeof vi.fn>;
	};

beforeEach(() => {
	matcher.request.mockReset();
	matcher.defer.mockReset();
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "debug").mockImplementation(() => {});
});

describe("resolveUnknownPose", () => {
	it("accepts the cascade pose without touching the matcher", async () => {
		const stages: string[] = [];
		const out = await resolveUnknownPose(
			photo(),
			solverStub(async () => cascade(true)),
			img,
			prior,
			unk(),
			fallback,
			{
				onStage: (m) => stages.push(m),
			},
		);
		expect(out).toMatchObject({
			state: "accepted",
			source: "cascade",
			confidence: 0.8,
		});
		expect(out.pose.yaw).toBe(120);
		expect(out.note).toContain("compass + gravity");
		expect(stages).toHaveLength(1);
		expect(stages[0]).toContain("360");
		expect(matcher.defer).not.toHaveBeenCalled();
	});

	it("names the unknowns in the note and a free-tilt search without yaw", async () => {
		const stages: string[] = [];
		await resolveUnknownPose(
			photo(),
			solverStub(async () => cascade(true)),
			img,
			prior,
			unk({ yaw: false, gravity: true, focal: true }),
			fallback,
			{ onStage: (m) => stages.push(m) },
		);
		expect(stages[0]).toContain("gravity + lens");
		expect(stages[0]).toContain("free tilt");
	});

	it("seeds the matcher with the cascade candidates and accepts a trusted-position match", async () => {
		matcher.defer.mockImplementation(async () => ({ result: high(121) }));
		vi.stubGlobal("fetch", async () => new Response(new Blob(["x"])));
		const out = await resolveUnknownPose(
			photo({ hAccuracy: 8 }),
			solverStub(async () => cascade(false)),
			img,
			prior,
			unk(),
			fallback,
		);
		expect(out).toMatchObject({ state: "accepted", source: "matcher" });
		const req = matcher.defer.mock.calls[0][0];
		expect(req.poseSeeds).toHaveLength(2);
		expect(req.positionUncertainM).toBe(8);
		// both yaw and gravity unknown: the prior carries only the focal
		expect(req.prior).toEqual({ vfov: 50 });
		expect(req.fused).toBe(true);
	});

	it("omits the position uncertainty when unknown and keeps known angles in the prior", async () => {
		matcher.defer.mockResolvedValue({ result: null });
		vi.stubGlobal("fetch", async () => new Response(new Blob(["x"])));
		await resolveUnknownPose(
			photo({ hAccuracy: null }),
			solverStub(async () => cascade(false)),
			img,
			prior,
			unk({ yaw: false, gravity: false, focal: true }),
			fallback,
		);
		const req = matcher.defer.mock.calls[0][0];
		expect("positionUncertainM" in req).toBe(false);
		expect(req.prior).toEqual({ yaw: 10, pitch: 0, roll: 0 });
	});

	it("marks a pinned position as manual and does not trust it", async () => {
		matcher.defer.mockResolvedValue({ result: high(121, true) });
		vi.stubGlobal("fetch", async () => new Response(new Blob(["x"])));
		const pinned = photo({ local: { positionSource: "pin" } });
		const out = await resolveUnknownPose(
			pinned,
			solverStub(async () => cascade(false, 200)),
			img,
			prior,
			unk(),
			fallback,
		);
		expect(matcher.defer.mock.calls[0][0].meta.positionSource).toBe("manual");
		// the match's own check says trusted, so the rule still passes; make it untrusted to see the veto
		expect(out.state).toBe("accepted");
		matcher.defer.mockResolvedValue({
			result: high(121, false) as MatchResult,
		});
		const vetoed = await resolveUnknownPose(
			pinned,
			solverStub(async () => cascade(false, 200)),
			img,
			prior,
			unk(),
			fallback,
		);
		expect(vetoed.state).toBe("unverified");
		expect(vetoed.source).toBe("matcher");
		expect(vetoed.pose.yaw).toBe(121); // the matcher's LOW/unaccepted pose beats a rejected cascade guess
	});

	it("falls back to the cascade guess, then to `fallback`, when the match gives nothing", async () => {
		matcher.defer.mockResolvedValue({ result: null });
		vi.stubGlobal("fetch", async () => new Response(new Blob(["x"])));
		const a = await resolveUnknownPose(
			photo(),
			solverStub(async () => cascade(false, 33)),
			img,
			prior,
			unk(),
			fallback,
		);
		expect(a).toMatchObject({ state: "unverified", source: "cascade" });
		expect(a.pose.yaw).toBe(33);
		const failing = solverStub(async () => {
			throw new Error("worker died");
		});
		const b = await resolveUnknownPose(
			photo(),
			failing,
			img,
			prior,
			unk(),
			fallback,
		);
		expect(b).toMatchObject({
			state: "unverified",
			source: "none",
			confidence: null,
		});
		expect(b.pose).toBe(fallback);
	});

	it("without a fetchable photo no match is attempted", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("offline");
		});
		const out = await resolveUnknownPose(
			photo(),
			solverStub(async () => cascade(false, 33)),
			img,
			prior,
			unk(),
			fallback,
		);
		expect(matcher.defer).not.toHaveBeenCalled();
		expect(out.state).toBe("unverified");
		expect(out.source).toBe("cascade");
	});

	it("returns unverified at once for a contended service and upgrades later", async () => {
		vi.stubGlobal("fetch", async () => new Response(new Blob(["x"])));
		matcher.defer.mockResolvedValue({ deferred: Promise.resolve(high(121)) });
		const out = await resolveUnknownPose(
			photo(),
			solverStub(async () => cascade(false, 33)),
			img,
			prior,
			unk(),
			fallback,
		);
		expect(out).toMatchObject({ state: "unverified", source: "cascade" });
		expect(out.note).toMatch(/busy/);
		const up = await out.upgrade;
		expect(up).toMatchObject({ state: "accepted", source: "matcher" });
		matcher.defer.mockResolvedValue({ deferred: Promise.resolve(null) });
		const none = await resolveUnknownPose(
			photo(),
			solverStub(async () => cascade(false, 33)),
			img,
			prior,
			unk(),
			fallback,
		);
		expect(await none.upgrade).toBeNull();
	});

	it("rethrows an AbortError from the cascade", async () => {
		const s = solverStub(async () => {
			throw new DOMException("aborted", "AbortError");
		});
		await expect(
			resolveUnknownPose(photo(), s, img, prior, unk(), fallback),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("matchUnknownPose", () => {
	it("posts the unknown-aware request through requestMatch with the timeout", async () => {
		vi.stubGlobal("fetch", async () => new Response(new Blob(["x"])));
		matcher.request.mockResolvedValue("R");
		const r = await matchUnknownPose(
			photo(),
			prior,
			unk({ yaw: true, gravity: false }),
			undefined,
			5000,
			[pose(1)],
		);
		expect(r).toBe("R");
		const [req, opts] = matcher.request.mock.calls[0];
		expect(opts.timeoutMs).toBe(5000);
		expect(req.prior).toEqual({ pitch: 0, roll: 0, vfov: 50 });
		expect(req.poseSeeds).toEqual([{ yaw: 1, pitch: 0, roll: 0, vfov: 50 }]);
	});

	it("resolves to null when the photo cannot be fetched", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("x");
		});
		expect(await matchUnknownPose(photo(), prior, unk())).toBeNull();
		expect(matcher.request).not.toHaveBeenCalled();
	});
});

describe("UnknownPoseSolver (stub Worker)", () => {
	class FakeWorker {
		static last: FakeWorker;
		posted: { msg: unknown; transfer?: Transferable[] }[] = [];
		terminated = false;
		onmessage: ((e: MessageEvent<UnknownPoseResponse>) => void) | null = null;
		onerror: ((e: ErrorEvent) => void) | null = null;
		constructor() {
			FakeWorker.last = this;
		}
		postMessage(msg: unknown, transfer?: Transferable[]) {
			this.posted.push({ msg, transfer });
		}
		terminate() {
			this.terminated = true;
		}
		reply(r: UnknownPoseResponse) {
			this.onmessage?.({ data: r } as MessageEvent<UnknownPoseResponse>);
		}
	}
	beforeEach(() => {
		vi.stubGlobal("Worker", FakeWorker);
		vi.stubGlobal("document", {
			createElement: () => ({
				width: 0,
				height: 0,
				getContext: () => ({
					drawImage: vi.fn(),
					getImageData: (_x: number, _y: number, w: number, h: number) => ({
						data: new Uint8ClampedArray(w * h * 4),
					}),
				}),
			}),
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	const solveMsg = () =>
		FakeWorker.last.posted.find(
			(p) => (p.msg as { type: string }).type === "solve",
		);

	it("posts a prepare message with the photo position at construction", () => {
		new UnknownPoseSolver(photo(), { fused: false });
		const m = FakeWorker.last.posted[0].msg as Record<string, unknown>;
		expect(m).toMatchObject({
			type: "prepare",
			lat: 46.7,
			lon: 7.8,
			alt: 1500,
			gpuFused: false,
		});
	});

	it("posts an 800 px wide request transferring the pixel buffer and resolves from the reply", async () => {
		const solver = new UnknownPoseSolver(photo());
		const p = solver.solve(
			img,
			prior,
			unk({ yaw: true, gravity: false, focal: true }),
		);
		const sent = solveMsg();
		const req = sent?.msg as UnknownPoseRequest;
		expect(req.image.width).toBe(800);
		expect(req.image.height).toBe(600);
		expect(req.gpsAccuracy).toBe(8);
		expect(req.width).toBe(4000);
		expect(req.unknown).toEqual({ yaw: true, gravity: false, focal: true });
		expect(sent?.transfer).toHaveLength(1);
		FakeWorker.last.reply({ id: req.id, ok: true, result: cascade(true) });
		await expect(p).resolves.toMatchObject({ accepted: true });
	});

	it("rejects with the worker's error and routes replies by id", async () => {
		const solver = new UnknownPoseSolver(photo());
		const a = solver.solve(img, prior, unk());
		const b = solver.solve(img, prior, unk());
		const ids = FakeWorker.last.posted
			.filter((p) => (p.msg as { type: string }).type === "solve")
			.map((p) => (p.msg as UnknownPoseRequest).id);
		expect(new Set(ids).size).toBe(2);
		FakeWorker.last.reply({ id: ids[1], ok: false, error: "bad horizon" });
		FakeWorker.last.reply({ id: ids[0], ok: true, result: cascade(false) });
		await expect(b).rejects.toThrow("bad horizon");
		await expect(a).resolves.toMatchObject({ accepted: false });
		FakeWorker.last.reply({ id: 9999, ok: true, result: cascade(true) }); // unknown id is ignored
	});

	it("aborts a pending solve and a pre-aborted signal", async () => {
		const solver = new UnknownPoseSolver(photo());
		const ac = new AbortController();
		const p = solver.solve(img, prior, unk(), ac.signal);
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
		await expect(
			solver.solve(img, prior, unk(), ac.signal),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("fails every pending solve on a worker error and on dispose, and terminates", async () => {
		const solver = new UnknownPoseSolver(photo());
		const p = solver.solve(img, prior, unk());
		FakeWorker.last.onerror?.({ message: "boom" } as ErrorEvent);
		await expect(p).rejects.toThrow("boom");
		const q = solver.solve(img, prior, unk());
		solver.dispose();
		await expect(q).rejects.toMatchObject({ name: "AbortError" });
		expect(FakeWorker.last.terminated).toBe(true);
	});

	it("rejects when no 2D canvas is available", async () => {
		vi.stubGlobal("document", {
			createElement: () => ({ getContext: () => null }),
		});
		const solver = new UnknownPoseSolver(photo());
		await expect(solver.solve(img, prior, unk())).rejects.toThrow(/canvas/);
	});
});
