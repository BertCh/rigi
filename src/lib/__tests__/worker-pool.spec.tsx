// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerPool } from "../worker-pool";

type Msg = { id: number; msg: number };

class FakeWorker {
	static all: FakeWorker[] = [];
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessageerror: (() => void) | null = null;
	terminated = false;
	posted: Msg[] = [];
	constructor() {
		FakeWorker.all.push(this);
	}
	postMessage(m: Msg) {
		this.posted.push(m);
	}
	terminate() {
		this.terminated = true;
	}
	reply(data: unknown) {
		this.onmessage?.({ data });
	}
}

const local = vi.fn(async (n: number) => n * 10);

beforeEach(() => {
	FakeWorker.all = [];
	local.mockClear();
	vi.stubGlobal("Worker", FakeWorker);
	vi.stubGlobal("OffscreenCanvas", class {});
});

const make = () => new FakeWorker() as unknown as Worker;

describe("WorkerPool without worker support", () => {
	it("runs locally with no OffscreenCanvas", async () => {
		vi.stubGlobal("OffscreenCanvas", undefined);
		const p = new WorkerPool<number, number>(make, local, 2);
		expect(await p.run(3)).toBe(30);
		expect(FakeWorker.all).toHaveLength(0);
	});
	it("runs locally with no Worker", async () => {
		vi.stubGlobal("Worker", undefined);
		expect(await new WorkerPool<number, number>(make, local, 2).run(4)).toBe(
			40,
		);
	});
	it("falls back for good when a worker cannot be constructed", async () => {
		const p = new WorkerPool<number, number>(
			() => {
				throw new Error("blocked");
			},
			local,
			2,
		);
		expect(await p.run(1)).toBe(10);
		expect(await p.run(2)).toBe(20);
		expect(local).toHaveBeenCalledTimes(2);
	});
});

describe("WorkerPool with workers", () => {
	it("starts size workers lazily and posts { id, msg } round-robin", () => {
		const p = new WorkerPool<number, number>(make, local, 2);
		expect(FakeWorker.all).toHaveLength(0);
		void p.run(5);
		void p.run(6);
		void p.run(7);
		expect(FakeWorker.all).toHaveLength(2);
		expect(FakeWorker.all[0].posted).toEqual([
			{ id: 0, msg: 5 },
			{ id: 2, msg: 7 },
		]);
		expect(FakeWorker.all[1].posted).toEqual([{ id: 1, msg: 6 }]);
	});
	it("resolves with the reply that matches the job id, in any order", async () => {
		const p = new WorkerPool<number, number>(make, local, 2);
		const a = p.run(1);
		const b = p.run(2);
		FakeWorker.all[1].reply({ id: 1, out: 200 });
		FakeWorker.all[0].reply({ id: 0, out: 100 });
		expect(await a).toBe(100);
		expect(await b).toBe(200);
		expect(local).not.toHaveBeenCalled();
	});
	it("rejects a job whose worker answered with an error", async () => {
		const p = new WorkerPool<number, number>(make, local, 1);
		const a = p.run(1);
		FakeWorker.all[0].reply({ id: 0, error: "boom" });
		await expect(a).rejects.toThrow("boom");
	});
	it("ignores replies for unknown ids", async () => {
		const p = new WorkerPool<number, number>(make, local, 1);
		const a = p.run(1);
		FakeWorker.all[0].reply({ id: 99, out: 1 });
		FakeWorker.all[0].reply({ id: 0, out: 2 });
		expect(await a).toBe(2);
	});
	it("a dying worker terminates the pool and re-runs pending jobs locally", async () => {
		const p = new WorkerPool<number, number>(make, local, 2);
		const a = p.run(1);
		const b = p.run(2);
		FakeWorker.all[0].onerror?.();
		expect(await a).toBe(10);
		expect(await b).toBe(20);
		expect(FakeWorker.all.every((w) => w.terminated)).toBe(true);
		// later jobs stay local, no new workers
		expect(await p.run(3)).toBe(30);
		expect(FakeWorker.all).toHaveLength(2);
	});
	it("an undeserialisable reply triggers the same fallback", async () => {
		const p = new WorkerPool<number, number>(make, local, 1);
		const a = p.run(8);
		FakeWorker.all[0].onmessageerror?.();
		expect(await a).toBe(80);
	});
	it("fallback propagates a local rejection to the pending caller", async () => {
		const p = new WorkerPool<number, number>(
			make,
			async () => {
				throw new Error("local fail");
			},
			1,
		);
		const a = p.run(1);
		FakeWorker.all[0].onerror?.();
		await expect(a).rejects.toThrow("local fail");
	});
	it("defaults to between 1 and 4 workers", () => {
		const p = new WorkerPool<number, number>(make, local);
		void p.run(1);
		expect(FakeWorker.all.length).toBeGreaterThanOrEqual(1);
		expect(FakeWorker.all.length).toBeLessThanOrEqual(4);
	});
});
