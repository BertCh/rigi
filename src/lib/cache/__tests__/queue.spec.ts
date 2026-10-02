// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { abortError, PriorityQueue } from "../queue";

/** A queue whose jobs stay pending until the test settles them. */
function manual(concurrency = 1) {
	const started: string[] = [];
	const gates = new Map<
		string,
		{
			resolve: (v: string) => void;
			reject: (e: unknown) => void;
			signal: AbortSignal;
		}
	>();
	const q = new PriorityQueue<string>(
		(key, signal) =>
			new Promise<string>((resolve, reject) => {
				started.push(key);
				gates.set(key, { resolve, reject, signal });
			}),
		concurrency,
	);
	return { q, started, gates };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("PriorityQueue ordering", () => {
	it("runs lower priority numbers first and ties FIFO", async () => {
		const { q, started, gates } = manual(1);
		const all = [
			q.request("first", { priority: 5 }), // starts immediately (nothing else queued)
			q.request("low", { priority: 9 }),
			q.request("high", { priority: 1 }),
			q.request("tieA", { priority: 3 }),
			q.request("tieB", { priority: 3 }),
		];
		for (let i = 0; i < 5; i++) {
			const k = started[i];
			gates.get(k)?.resolve(k);
			await tick();
		}
		await Promise.all(all);
		expect(started).toEqual(["first", "high", "tieA", "tieB", "low"]);
	});
	it("respects the concurrency limit and reports maxRunning", async () => {
		const { q, started, gates } = manual(2);
		const ps = ["a", "b", "c", "d"].map((k) => q.request(k));
		expect(started).toEqual(["a", "b"]);
		expect(q.stats()).toMatchObject({ running: 2, queued: 2, concurrency: 2 });
		gates.get("a")?.resolve("a");
		await tick();
		expect(started).toEqual(["a", "b", "c"]);
		for (const k of ["b", "c", "d"]) {
			await tick();
			gates.get(k)?.resolve(k);
		}
		await Promise.all(ps);
		expect(q.stats()).toMatchObject({
			started: 4,
			completed: 4,
			failed: 0,
			maxRunning: 2,
			queued: 0,
			running: 0,
		});
	});
	it("reprioritize can reorder queued jobs and ignores undefined", async () => {
		const { q, started, gates } = manual(1);
		void q.request("run", { priority: 0 });
		void q.request("a", { priority: 1 });
		void q.request("b", { priority: 2 });
		void q.request("c", { priority: 3 });
		q.reprioritize((k) => (k === "c" ? -1 : undefined));
		expect(q.priorityOf("c")).toBe(-1);
		expect(q.priorityOf("a")).toBe(1);
		gates.get("run")?.resolve("");
		await tick();
		expect(started[1]).toBe("c");
	});
	it("setPriority overrides the callers' priority", () => {
		const { q } = manual(1);
		void q.request("x", { priority: 0 });
		void q.request("y", { priority: 4 });
		q.setPriority("y", 0.5);
		expect(q.priorityOf("y")).toBe(0.5);
		expect(q.priorityOf("nope")).toBeUndefined();
	});
});

describe("PriorityQueue dedupe", () => {
	it("joins a request for a key already queued or running and shares the result", async () => {
		const { q, started, gates } = manual(1);
		const a = q.request("k");
		const b = q.request("k");
		expect(started).toEqual(["k"]);
		gates.get("k")?.resolve("v");
		expect(await Promise.all([a, b])).toEqual(["v", "v"]);
		expect(q.stats().deduped).toBe(1);
		expect(q.stats().started).toBe(1);
	});
	it("a joined job takes the minimum priority over its callers", () => {
		const { q } = manual(1);
		void q.request("busy");
		void q.request("k", { priority: 5 });
		void q.request("k", { priority: 2 });
		expect(q.priorityOf("k")).toBe(2);
	});
	it("shares a rejection with every caller and counts one failure", async () => {
		const { q, gates } = manual(1);
		const a = q.request("k");
		const b = q.request("k");
		gates.get("k")?.reject(new Error("boom"));
		await expect(a).rejects.toThrow("boom");
		await expect(b).rejects.toThrow("boom");
		expect(q.stats()).toMatchObject({ failed: 1, completed: 0 });
	});
	it("a thrown (sync) run function becomes a rejection", async () => {
		const q = new PriorityQueue<number>(() => {
			throw new Error("sync");
		});
		await expect(q.request("x")).rejects.toThrow("sync");
		expect(q.stats().failed).toBe(1);
	});
	it("a key can be requested again once it finished", async () => {
		const { q, started, gates } = manual(1);
		const a = q.request("k");
		gates.get("k")?.resolve("1");
		await a;
		const b = q.request("k");
		gates.get("k")?.resolve("2");
		expect(await b).toBe("2");
		expect(started).toEqual(["k", "k"]);
	});
});

describe("PriorityQueue cancellation", () => {
	it("an already-aborted signal rejects with AbortError without queueing", async () => {
		const { q, started } = manual(1);
		const ac = new AbortController();
		ac.abort();
		await expect(q.request("k", { signal: ac.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(started).toEqual([]);
		expect(q.has("k")).toBe(false);
	});
	it("aborting one of two callers rejects only that caller; the job keeps running", async () => {
		const { q, gates } = manual(1);
		const ac = new AbortController();
		const a = q.request("k", { signal: ac.signal });
		const b = q.request("k");
		ac.abort();
		await expect(a).rejects.toMatchObject({ name: "AbortError" });
		expect(gates.get("k")?.signal.aborted).toBe(false);
		gates.get("k")?.resolve("v");
		expect(await b).toBe("v");
		expect(q.stats().cancelled).toBe(0);
	});
	it("aborting the last caller of a running job fires its signal and counts as cancelled, not failed", async () => {
		const { q, gates } = manual(1);
		const ac = new AbortController();
		const a = q.request("k", { signal: ac.signal });
		ac.abort();
		await expect(a).rejects.toMatchObject({ name: "AbortError" });
		expect(gates.get("k")?.signal.aborted).toBe(true);
		gates.get("k")?.reject(abortError());
		await tick();
		expect(q.stats()).toMatchObject({ cancelled: 1, failed: 0, running: 0 });
	});
	it("aborting the last caller of a queued job removes it before it ever runs", async () => {
		const { q, started, gates } = manual(1);
		void q.request("busy");
		const ac = new AbortController();
		const p = q.request("later", { signal: ac.signal });
		ac.abort();
		await expect(p).rejects.toMatchObject({ name: "AbortError" });
		gates.get("busy")?.resolve("");
		await tick();
		expect(started).toEqual(["busy"]);
		expect(q.has("later")).toBe(false);
	});
	it("a new request after cancelling a running key starts a fresh job", async () => {
		const { q, started } = manual(2);
		const ac = new AbortController();
		const a = q.request("k", { signal: ac.signal });
		ac.abort();
		await a.catch(() => {});
		void q.request("k");
		expect(started).toEqual(["k", "k"]);
	});
	it("cancel(key) rejects all callers", async () => {
		const { q } = manual(1);
		void q.request("busy");
		const a = q.request("k");
		const b = q.request("k");
		expect(q.cancel("k")).toBe(true);
		expect(q.cancel("k")).toBe(false);
		await expect(a).rejects.toMatchObject({ name: "AbortError" });
		await expect(b).rejects.toMatchObject({ name: "AbortError" });
	});
	it("cancelQueued drops only matching queued jobs, not running ones", async () => {
		const { q, gates } = manual(1);
		const run = q.request("run:1");
		const x = q.request("t:1");
		const y = q.request("t:2");
		const z = q.request("keep");
		expect(q.cancelQueued((k) => k.startsWith("t:"))).toBe(2);
		await expect(x).rejects.toMatchObject({ name: "AbortError" });
		await expect(y).rejects.toMatchObject({ name: "AbortError" });
		gates.get("run:1")?.resolve("r");
		await run;
		await tick();
		gates.get("keep")?.resolve("k");
		expect(await z).toBe("k");
	});
});

describe("PriorityQueue idle", () => {
	it("resolves immediately when empty", async () => {
		await expect(manual().q.idle()).resolves.toBeUndefined();
	});
	it("resolves after the last job settles", async () => {
		const { q, gates } = manual(1);
		let idle = false;
		const p = q.request("k");
		void q.idle().then(() => {
			idle = true;
		});
		await tick();
		expect(idle).toBe(false);
		gates.get("k")?.resolve("v");
		await p;
		await tick();
		expect(idle).toBe(true);
	});
	it("resolves when the only queued job is cancelled", async () => {
		const { q, gates } = manual(1);
		const busy = q.request("busy");
		const p = q.request("x");
		q.cancel("x");
		await p.catch(() => {});
		gates.get("busy")?.resolve("");
		await busy;
		await expect(q.idle()).resolves.toBeUndefined();
	});
	it("a cancelled running job keeps its slot until the run function settles", async () => {
		const { q, gates } = manual(1);
		const busy = q.request("busy").catch(() => {});
		q.cancel("busy");
		expect(q.stats().running).toBe(1);
		let idle = false;
		void q.idle().then(() => {
			idle = true;
		});
		await tick();
		expect(idle).toBe(false);
		gates.get("busy")?.reject(abortError());
		await busy;
		await tick();
		expect(idle).toBe(true);
	});
});

describe("abortError", () => {
	it("returns an AbortError for any reason, reusing an existing one", () => {
		expect(abortError().name).toBe("AbortError");
		expect(abortError("because").name).toBe("AbortError");
		const e = new Error("x");
		e.name = "AbortError";
		expect(abortError(e)).toBe(e);
		const other = new Error("y");
		expect(abortError(other)).not.toBe(other);
	});
});
