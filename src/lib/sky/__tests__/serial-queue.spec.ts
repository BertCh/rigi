// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { createIdleRelease, type IdleTimers } from "../graph-idle";
import { createSerialQueue } from "../serial-queue";

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

describe("createSerialQueue", () => {
	it("runs tasks strictly in order, one at a time", async () => {
		const q = createSerialQueue();
		const log: string[] = [];
		const gate = deferred();
		const a = q.run(async () => {
			log.push("a-start");
			await gate.promise;
			log.push("a-end");
		});
		const b = q.run(() => {
			log.push("b");
		});
		await Promise.resolve();
		expect(log).toEqual(["a-start"]);
		expect(q.size).toBe(2);
		gate.resolve();
		await Promise.all([a, b]);
		expect(log).toEqual(["a-start", "a-end", "b"]);
		expect(q.size).toBe(0);
	});

	it("a failing task rejects its own promise but not the queue", async () => {
		const q = createSerialQueue();
		const bad = q.run(() => Promise.reject(new Error("boom")));
		const good = q.run(() => 42);
		await expect(bad).rejects.toThrow("boom");
		await expect(good).resolves.toBe(42);
		expect(q.size).toBe(0);
	});
});

describe("idle release on the request queue (CR-70)", () => {
	it("a request arriving mid-release runs after the release finished", async () => {
		const q = createSerialQueue();
		let fire: (() => void) | undefined;
		const timers: IdleTimers = {
			setTimeout: (fn) => {
				fire = fn;
				return 1;
			},
			clearTimeout: () => {
				fire = undefined;
			},
		};
		const log: string[] = [];
		const importGate = deferred();
		const idle = createIdleRelease(
			1,
			() =>
				q.run(async () => {
					if (q.size > 1) return;
					log.push("release-start");
					await importGate.promise; // the dynamic import in the worker
					log.push("release-end");
				}),
			timers,
		);
		const request = (name: string) =>
			q.run(async () => {
				idle.begin();
				try {
					log.push(name);
				} finally {
					idle.end();
				}
			});
		await request("r1");
		fire?.(); // idle window elapsed
		await Promise.resolve();
		const r2 = request("r2"); // arrives while the release awaits its import
		await Promise.resolve();
		expect(log).toEqual(["r1", "release-start"]);
		importGate.resolve();
		await r2;
		expect(log).toEqual(["r1", "release-start", "release-end", "r2"]);
	});

	it("skips the release when a request is already queued behind it", async () => {
		const q = createSerialQueue();
		const log: string[] = [];
		const gate = deferred();
		const running = q.run(() => gate.promise);
		const queued = q.run(() => {
			log.push("request");
		});
		const release = q.run(async () => {
			if (q.size > 1) return;
			log.push("release");
		});
		gate.resolve();
		await Promise.all([running, queued, release]);
		expect(log).toEqual(["request", "release"]);
	});
});
