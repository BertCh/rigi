// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The live trace path of viewpointTerrain (tile fetch -> worker -> terrain) with a fake Worker and
// mocked dem / mosaic / region modules.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	fetched: [] as string[],
	fetchBytes: undefined as unknown as (
		k: { z: number; x: number; y: number },
		o: unknown,
	) => Promise<unknown>,
	regions: {} as Record<string, unknown>,
}));

vi.mock("#/lib/cache", () => ({
	tilePriority: (near: number, z: number) => near / 1000 + z,
}));
vi.mock("#/lib/dem", () => ({
	MAPTERHORN: { tileSize: 512 },
	tileId: (k: { z: number; x: number; y: number }) => `${k.z}/${k.x}/${k.y}`,
	fetchDemBytes: (k: { z: number; x: number; y: number }, o: unknown) => {
		m.fetched.push(`${k.z}/${k.x}/${k.y}`);
		return m.fetchBytes(k, o);
	},
}));
vi.mock("#/lib/gpu/core/realm", () => ({
	realmGpuOptions: () => ({ realm: true }),
}));
vi.mock("#/lib/horizon-fast/mosaic", () => ({
	LITE_RINGS: ["r"],
	resolveRings: async () => [{ minDistance: 0 }, { minDistance: 5000 }],
	// both spans cover the shared tile 10/1/1; the second also needs 10/2/2
	mosaicTileKeys: (
		_la: number,
		_lo: number,
		spans: { minDistance: number }[],
	) =>
		spans[0].minDistance === 0
			? [{ z: 10, x: 1, y: 1 }]
			: [
					{ z: 10, x: 1, y: 1 },
					{ z: 10, x: 2, y: 2 },
				],
}));
vi.mock("#/lib/photos", () => ({
	loadRegion: async (id: string) => {
		const r = m.regions[id];
		if (r instanceof Error) throw r;
		return r ?? null;
	},
}));

type Posted = { msg: Record<string, unknown>; transfer: unknown[] };
class FakeWorker {
	static instances: FakeWorker[] = [];
	static reply: (w: FakeWorker, msg: Record<string, unknown>) => void = (w) =>
		w.onmessage?.({ data: { type: "done", terrain: { id: "T" } } } as never);
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onerror: ((e: { message: string }) => void) | null = null;
	terminated = false;
	posted: Posted[] = [];
	constructor() {
		FakeWorker.instances.push(this);
	}
	postMessage(msg: Record<string, unknown>, transfer: unknown[]) {
		this.posted.push({ msg, transfer });
		queueMicrotask(() => FakeWorker.reply(this, msg));
	}
	terminate() {
		this.terminated = true;
	}
}

async function load() {
	vi.resetModules();
	return import("../viewpointTerrain");
}
const req = (o: object = {}) => ({
	lat: 46.5,
	lon: 7.5,
	eyeAlt: 1500,
	regions: [] as string[],
	...o,
});

beforeEach(() => {
	m.fetched.length = 0;
	m.regions = {};
	m.fetchBytes = async () => ({ source: "net", buf: new ArrayBuffer(8) });
	FakeWorker.instances = [];
	FakeWorker.reply = (w) =>
		w.onmessage?.({ data: { type: "done", terrain: { id: "T" } } });
	vi.stubGlobal("Worker", FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());

describe("viewpointTerrain live trace", () => {
	it("fetches each shared tile once, transfers the buffers, runs the GPU by default and terminates the worker", async () => {
		const { viewpointTerrain } = await load();
		const t = await viewpointTerrain(req());
		expect(t).toEqual({ id: "T" });
		expect(m.fetched.sort()).toEqual(["10/1/1", "10/2/2"]);
		const w = FakeWorker.instances[0];
		expect(w.terminated).toBe(true);
		const { msg, transfer } = w.posted[0];
		expect((msg.tiles as unknown[]).length).toBe(2);
		expect(transfer).toHaveLength(2);
		expect(msg.gpu).toBe(true);
		expect(msg.gpuOpts).toEqual({ realm: true });
		expect(msg).toMatchObject({ lat: 46.5, lon: 7.5, eyeAlt: 1500 });
	});

	it("gpu:false forces the CPU and sends no GPU options", async () => {
		const { viewpointTerrain } = await load();
		await viewpointTerrain(req({ gpu: false }));
		const { msg } = FakeWorker.instances[0].posted[0];
		expect(msg.gpu).toBe(false);
		expect(msg.gpuOpts).toBeUndefined();
	});

	it("tiles that failed to load are passed through as null and not transferred", async () => {
		m.fetchBytes = async (k) =>
			k.x === 2 ? null : { source: "net", buf: new ArrayBuffer(4) };
		const { viewpointTerrain } = await load();
		await viewpointTerrain(req());
		const { msg, transfer } = FakeWorker.instances[0].posted[0];
		const tiles = msg.tiles as { source: unknown; buf: unknown }[];
		expect(tiles.filter((t) => t.buf === null)).toHaveLength(1);
		expect(tiles.find((t) => t.buf === null)?.source).toBeNull();
		expect(transfer).toHaveLength(1);
	});

	it("a worker that reports gpuFailed sends later viewpoints to the CPU", async () => {
		FakeWorker.reply = (w) =>
			w.onmessage?.({
				data: { type: "done", terrain: { id: "A" }, gpuFailed: true },
			});
		const { viewpointTerrain } = await load();
		await viewpointTerrain(req());
		FakeWorker.reply = (w) =>
			w.onmessage?.({ data: { type: "done", terrain: { id: "B" } } });
		await viewpointTerrain(req({ lat: 47 }));
		expect(FakeWorker.instances[0].posted[0].msg.gpu).toBe(true);
		expect(FakeWorker.instances[1].posted[0].msg.gpu).toBe(false);
	});

	it("rejects with the worker's error, terminates it, and does not memoise the failure", async () => {
		FakeWorker.reply = (w) =>
			w.onmessage?.({ data: { type: "error", error: "kernel exploded" } });
		const { viewpointTerrain } = await load();
		await expect(viewpointTerrain(req())).rejects.toThrow("kernel exploded");
		expect(FakeWorker.instances[0].terminated).toBe(true);
		FakeWorker.reply = (w) =>
			w.onmessage?.({ data: { type: "done", terrain: { id: "ok" } } });
		await expect(viewpointTerrain(req())).resolves.toEqual({ id: "ok" });
		expect(FakeWorker.instances).toHaveLength(2);
	});

	it("rejects on a worker crash with its message", async () => {
		FakeWorker.reply = (w) => w.onerror?.({ message: "oom" });
		const { viewpointTerrain } = await load();
		await expect(viewpointTerrain(req())).rejects.toThrow(
			"ridgelines worker: oom",
		);
	});

	it("runs one trace at a time and memoises the same eye", async () => {
		let active = 0;
		let maxActive = 0;
		FakeWorker.reply = (w) => {
			active++;
			maxActive = Math.max(maxActive, active);
			setTimeout(() => {
				active--;
				w.onmessage?.({ data: { type: "done", terrain: { id: "x" } } });
			}, 5);
		};
		const { viewpointTerrain } = await load();
		const a = viewpointTerrain(req({ lat: 46.1 }));
		const b = viewpointTerrain(req({ lat: 46.2 }));
		const a2 = viewpointTerrain(req({ lat: 46.1 }));
		expect(a2).toBe(a);
		await Promise.all([a, b]);
		expect(maxActive).toBe(1);
		expect(FakeWorker.instances).toHaveLength(2);
	});

	it("a baked terrain skips the worker; a missing or throwing bake traces live", async () => {
		const { viewpointTerrain, setBakedTerrain } = await load();
		setBakedTerrain(async (k) =>
			k.length ? ({ id: "baked" } as never) : null,
		);
		expect(await viewpointTerrain(req())).toEqual({ id: "baked" });
		expect(FakeWorker.instances).toHaveLength(0);
		setBakedTerrain(async () => null);
		expect(await viewpointTerrain(req({ lat: 40 }))).toEqual({ id: "T" });
		setBakedTerrain(async () => {
			throw new Error("bad bake");
		});
		expect(await viewpointTerrain(req({ lat: 41 }))).toEqual({ id: "T" });
		expect(FakeWorker.instances).toHaveLength(2);
	});

	it("sends region peaks de-duplicated by name and rounded latitude, dropping unnamed or elevation-less ones and failed regions", async () => {
		m.regions = {
			a: {
				peaks: [
					{ name: "Eiger", lat: 46.5774, lon: 8.0053, ele: 3967 },
					{ name: "Nameless", lat: 1, lon: 1, ele: Number.NaN },
					{ name: "", lat: 1, lon: 1, ele: 100 },
				],
			},
			b: {
				peaks: [
					{ name: "Eiger", lat: 46.5773, lon: 8.0053, ele: 3967 }, // same name, same 3-decimal lat
					{ name: "Eiger", lat: 46.9, lon: 8, ele: 1000 }, // different place, same name
				],
			},
			c: new Error("404"),
		};
		const { viewpointTerrain } = await load();
		await viewpointTerrain(req({ regions: ["a", "b", "c", "missing"] }));
		const peaks = FakeWorker.instances[0].posted[0].msg.peaks as {
			name: string;
			lat: number;
		}[];
		expect(peaks).toHaveLength(2);
		expect(peaks.map((p) => p.name)).toEqual(["Eiger", "Eiger"]);
		// the later duplicate wins
		expect(peaks.map((p) => p.lat).sort()).toEqual([46.5773, 46.9]);
	});

	describe("cancellation", () => {
		const isAbort = (e: unknown) => (e as DOMException).name === "AbortError";
		// holds the queue head so later traces wait their turn
		const gate = () => {
			let release!: () => void;
			const held = new Promise<void>((r) => {
				release = r;
			});
			FakeWorker.reply = (w) => {
				void held.then(() =>
					w.onmessage?.({ data: { type: "done", terrain: { id: "T" } } }),
				);
			};
			return release;
		};

		it("a queued trace whose only caller aborted never fetches or spawns, and the key retraces later", async () => {
			const release = gate();
			const { viewpointTerrain } = await load();
			const first = viewpointTerrain(req({ lat: 10 }));
			const ac = new AbortController();
			const queued = viewpointTerrain(req({ lat: 11 }), ac.signal);
			ac.abort();
			await expect(queued).rejects.toSatisfy(isAbort);
			release();
			await first;
			expect(FakeWorker.instances).toHaveLength(1);
			expect(m.fetched).toHaveLength(2); // only the first trace's tiles
			FakeWorker.reply = (w) =>
				w.onmessage?.({ data: { type: "done", terrain: { id: "again" } } });
			await expect(viewpointTerrain(req({ lat: 11 }))).resolves.toEqual({
				id: "again",
			});
			expect(FakeWorker.instances).toHaveLength(2);
		});

		it("an already-aborted signal rejects at once and starts nothing", async () => {
			const { viewpointTerrain } = await load();
			await expect(
				viewpointTerrain(req(), AbortSignal.abort()),
			).rejects.toSatisfy(isAbort);
			await new Promise((r) => setTimeout(r, 5));
			expect(FakeWorker.instances).toHaveLength(0);
		});

		it("with two callers, one aborting leaves the trace running for the other", async () => {
			const release = gate();
			const { viewpointTerrain } = await load();
			const first = viewpointTerrain(req({ lat: 10 }));
			const ac = new AbortController();
			const a = viewpointTerrain(req({ lat: 12 }), ac.signal);
			const b = viewpointTerrain(
				req({ lat: 12 }),
				new AbortController().signal,
			);
			ac.abort();
			await expect(a).rejects.toSatisfy(isAbort);
			release();
			await first;
			await expect(b).resolves.toEqual({ id: "T" });
			expect(FakeWorker.instances).toHaveLength(2);
		});

		it("aborting after the run started rejects the caller but the result is memoised", async () => {
			const release = gate();
			const { viewpointTerrain } = await load();
			const ac = new AbortController();
			const p = viewpointTerrain(req(), ac.signal);
			while (FakeWorker.instances.length === 0)
				await new Promise((r) => setTimeout(r, 1));
			ac.abort();
			await expect(p).rejects.toSatisfy(isAbort);
			release();
			await new Promise((r) => setTimeout(r, 5));
			expect(FakeWorker.instances[0].terminated).toBe(true);
			await expect(viewpointTerrain(req())).resolves.toEqual({ id: "T" });
			expect(FakeWorker.instances).toHaveLength(1);
		});

		it("a caller without a signal keeps the trace alive and shares the promise", async () => {
			const release = gate();
			const { viewpointTerrain } = await load();
			const first = viewpointTerrain(req({ lat: 10 }));
			const plain = viewpointTerrain(req({ lat: 13 }));
			const ac = new AbortController();
			const sig = viewpointTerrain(req({ lat: 13 }), ac.signal);
			ac.abort();
			await expect(sig).rejects.toSatisfy(isAbort);
			expect(viewpointTerrain(req({ lat: 13 }))).toBe(plain);
			release();
			await first;
			await expect(plain).resolves.toEqual({ id: "T" });
			expect(FakeWorker.instances).toHaveLength(2);
		});
	});
});
