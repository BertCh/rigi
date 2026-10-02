// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolveRings: vi.fn(),
	mosaicTileKeys: vi.fn(),
	fetchDemBytes: vi.fn(),
}));
vi.mock("#/lib/horizon-fast/mosaic", async (orig) => ({
	...(await orig<typeof import("#/lib/horizon-fast/mosaic")>()),
	resolveRings: mocks.resolveRings,
	mosaicTileKeys: mocks.mosaicTileKeys,
}));
vi.mock("#/lib/dem", async (orig) => ({
	...(await orig<typeof import("#/lib/dem")>()),
	fetchDemBytes: mocks.fetchDemBytes,
}));

import {
	type HorizonStats,
	type HorizonWorkerIn,
	type HorizonWorkerOut,
	startFastHorizon,
} from "../horizon-fast-app";

class FakeWorker {
	static all: FakeWorker[] = [];
	posted: { msg: HorizonWorkerIn; transfer?: Transferable[] }[] = [];
	terminated = false;
	onmessage: ((e: MessageEvent<HorizonWorkerOut>) => void) | null = null;
	onerror: ((e: ErrorEvent) => void) | null = null;
	constructor() {
		FakeWorker.all.push(this);
	}
	postMessage(msg: HorizonWorkerIn, transfer?: Transferable[]) {
		this.posted.push({ msg, transfer });
	}
	terminate() {
		this.terminated = true;
	}
	emit(m: HorizonWorkerOut) {
		this.onmessage?.({ data: m } as MessageEvent<HorizonWorkerOut>);
	}
	types() {
		return this.posted.map((p) => p.msg.type);
	}
}
const stats: HorizonStats = {
	decodeMs: 1,
	mosaicMs: 2,
	marchMs: 3,
	tiles: 2,
	mosaicMB: 4,
};
const dirsMsg = (eyeH: number): HorizonWorkerOut => ({
	type: "dirs",
	eyeH,
	dirs: new Float32Array([0, 1, 0]),
	stats,
});
const worker = () => FakeWorker.all[FakeWorker.all.length - 1];
const flush = () => new Promise((r) => setTimeout(r, 0));

const ringNear = { minDistance: 0, maxDistance: 2000 };
const ringFar = { minDistance: 2000, maxDistance: 120000 };

beforeEach(() => {
	FakeWorker.all = [];
	vi.stubGlobal("Worker", FakeWorker);
	mocks.resolveRings.mockReset().mockResolvedValue([ringNear, ringFar]);
	mocks.mosaicTileKeys.mockReset().mockImplementation((_la, _lo, [span]) =>
		span === ringNear
			? [{ z: 14, x: 1, y: 1 }]
			: [
					{ z: 10, x: 5, y: 5 },
					{ z: 10, x: 5, y: 6 },
				],
	);
	mocks.fetchDemBytes.mockReset().mockImplementation(async (key) => ({
		source: key,
		buf: new ArrayBuffer(8),
	}));
});
afterEach(() => vi.unstubAllGlobals());

describe("startFastHorizon", () => {
	it("posts spans, every distinct tile, then build, and a march once the eye is set", async () => {
		const h = startFastHorizon({ lat: 46.7, lon: 7.8, az0: 10, az1: 70 });
		h.setEye(1500);
		await flush();
		const w = worker();
		expect(w.types()).toEqual([
			"spans",
			"tile",
			"tile",
			"tile",
			"build",
			"march",
		]);
		const spans = w.posted[0].msg as Extract<
			HorizonWorkerIn,
			{ type: "spans" }
		>;
		// the near ring covers the full circle, the far ring only the requested sector
		expect(spans.spans.map((s) => [s.az0, s.az1])).toEqual([
			[0, 360],
			[10, 70],
		]);
		expect(w.posted[1].transfer).toHaveLength(1);
		expect(w.posted[4].msg).toMatchObject({
			type: "build",
			lat: 46.7,
			lon: 7.8,
			step: 0.05,
			k: 0.13,
			maxDistance: 120000,
			minDistance: 2,
		});
		expect(w.posted[5].msg).toEqual({ type: "march", eyeH: 1500 });
		h.dispose();
	});

	it("a full-circle request spans every ring over 360 degrees", async () => {
		const h = startFastHorizon({ lat: 1, lon: 2 });
		await flush();
		const spans = worker().posted[0].msg as Extract<
			HorizonWorkerIn,
			{ type: "spans" }
		>;
		expect(spans.spans.every((s) => s.az0 === 0 && s.az1 === 360)).toBe(true);
		h.dispose();
	});

	it("de-duplicates tiles shared between rings", async () => {
		mocks.mosaicTileKeys.mockImplementation(() => [{ z: 9, x: 1, y: 1 }]);
		const h = startFastHorizon({ lat: 1, lon: 2 });
		await flush();
		expect(
			worker()
				.types()
				.filter((t) => t === "tile"),
		).toHaveLength(1);
		h.dispose();
	});

	it("forwards a missing tile (null buffer) without a transfer", async () => {
		mocks.fetchDemBytes.mockResolvedValue(null);
		const h = startFastHorizon({ lat: 1, lon: 2 });
		await flush();
		const t = worker().posted.find((p) => p.msg.type === "tile");
		expect(t?.msg).toMatchObject({ source: null, buf: null });
		expect(t?.transfer).toEqual([]);
		h.dispose();
	});

	it("requests each eye height once", async () => {
		const h = startFastHorizon({ lat: 1, lon: 2 });
		h.setEye(10);
		h.setEye(10);
		h.setEye(20);
		await flush();
		expect(
			worker()
				.types()
				.filter((t) => t === "march"),
		).toHaveLength(2);
		h.dispose();
	});

	it("take() is null until the worker delivers, then returns the result and terminates", async () => {
		const h = startFastHorizon({ lat: 1, lon: 2 });
		h.setEye(1500);
		await flush();
		expect(h.take(1500)).toBeNull();
		worker().emit(dirsMsg(1500));
		const r = h.take(1500);
		expect(Array.from(r?.dirs ?? [])).toEqual([0, 1, 0]);
		expect(r?.stats.marchMs).toBe(3);
		expect(r?.stats.totalMs).toBeGreaterThanOrEqual(0);
		expect(worker().terminated).toBe(true);
		expect(h.take(999)).toBeNull();
	});

	it("dirs() resolves when the worker answers and requests the march itself", async () => {
		const h = startFastHorizon({ lat: 1, lon: 2 });
		const p = h.dirs(2000);
		await flush();
		expect(worker().types()).toContain("march");
		worker().emit(dirsMsg(2000));
		await expect(p).resolves.toMatchObject({ stats: { tiles: 2 } });
		expect(worker().terminated).toBe(true);
	});

	it("dirs() returns an already delivered result", async () => {
		const h = startFastHorizon({ lat: 1, lon: 2 });
		h.setEye(5);
		await flush();
		worker().emit(dirsMsg(5));
		await expect(h.dirs(5)).resolves.toBeTruthy();
	});

	it("rejects dirs() on a worker error message and refuses later eyes", async () => {
		const h = startFastHorizon({ lat: 1, lon: 2 });
		const p = h.dirs(7);
		await flush();
		worker().emit({ type: "error", error: "no tiles" });
		await expect(p).rejects.toThrow("no tiles");
		await expect(h.dirs(8)).rejects.toThrow("no tiles");
	});

	it("rejects waiting callers when the worker itself errors", async () => {
		const h = startFastHorizon({ lat: 1, lon: 2 });
		const p = h.dirs(7);
		await flush();
		worker().onerror?.({ message: "oom" } as ErrorEvent);
		await expect(p).rejects.toThrow(/horizon worker: oom/);
	});

	it("rejects when ring resolution fails", async () => {
		mocks.resolveRings.mockRejectedValue(new Error("rings down"));
		const h = startFastHorizon({ lat: 1, lon: 2 });
		await expect(h.dirs(1)).rejects.toThrow("rings down");
	});

	it("dispose() and the abort signal terminate the worker and fail waiters with AbortError", async () => {
		const ac = new AbortController();
		const h = startFastHorizon({ lat: 1, lon: 2, signal: ac.signal });
		const p = h.dirs(3);
		await flush();
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
		expect(worker().terminated).toBe(true);
	});

	it("an abort during tile fetching stops the build message", async () => {
		const ac = new AbortController();
		mocks.fetchDemBytes.mockImplementation(async (key) => {
			ac.abort();
			return { source: key, buf: new ArrayBuffer(1) };
		});
		const h = startFastHorizon({ lat: 1, lon: 2, signal: ac.signal });
		await flush();
		expect(worker().types()).not.toContain("build");
		h.dispose();
	});
});
