// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Page side of the solve worker: the in-thread fallback (node has no Worker) and the message protocol
// against a scripted fake Worker (module state is reset per test: the shared worker and its "broken" flag).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pose } from "#/lib/camera";
import type { Correspondences } from "../core";

const prior: Pose = { yaw: 10, pitch: 0, roll: 0, vfov: 30 };
const views = [{ pose: prior, extra: "dropped" }];
const corr = (): Correspondences => ({
	x2d: new Float64Array(0),
	X: new Float64Array(0),
	W: 320,
	H: 240,
	perView: [],
	matchMs: 0,
});

class FakeWorker {
	static instances: FakeWorker[] = [];
	onmessage: ((ev: MessageEvent) => void) | null = null;
	onerror: ((e: { message: string }) => void) | null = null;
	posted: Record<string, unknown>[] = [];
	terminated = false;
	constructor() {
		FakeWorker.instances.push(this);
	}
	postMessage(m: Record<string, unknown>) {
		this.posted.push(m);
	}
	terminate() {
		this.terminated = true;
	}
	reply(data: unknown) {
		this.onmessage?.({ data } as MessageEvent);
	}
}

async function load() {
	vi.resetModules();
	return await import("../solve-offthread");
}

describe("solve-offthread without a Worker (node)", () => {
	it("legacySolveOffThread runs the in-thread solve", async () => {
		const m = await load();
		const r = await m.legacySolveOffThread(corr(), views, [0, 0, 0], prior);
		expect(r.pose).toBeNull();
		expect(r.reason).toBe("too few lifted matches");
	});

	it("assembleOffThread runs the in-thread assemble", async () => {
		const m = await load();
		const r = await m.assembleOffThread(corr(), views, [0, 0, 0], prior, null, {
			fused: false,
			freeFocal: false,
		});
		expect(r.method).toBe("render-match");
	});
});

describe("solve-offthread with a worker", () => {
	beforeEach(() => {
		FakeWorker.instances = [];
		vi.stubGlobal("Worker", FakeWorker);
		vi.stubGlobal("window", {});
	});
	afterEach(() => vi.unstubAllGlobals());

	it("posts a job with only the view poses, a numeric eye and a fresh id", async () => {
		const m = await load();
		const p = m.legacySolveOffThread(
			corr(),
			views,
			new Float64Array([1, 2, 3]),
			prior,
			{
				freeFocal: true,
			},
		);
		const w = FakeWorker.instances[0];
		expect(w.posted).toHaveLength(1);
		const job = w.posted[0];
		expect(job.kind).toBe("legacy");
		expect(job.eye).toEqual([1, 2, 3]);
		expect(job.views).toEqual([{ pose: prior }]);
		expect(job.opts).toEqual({ freeFocal: true });
		w.reply({ id: job.id, ok: true, result: { pose: null, inliers: 7 } });
		await expect(p).resolves.toMatchObject({ inliers: 7 });
	});

	it("shares one worker and routes replies by id, out of order", async () => {
		const m = await load();
		const a = m.legacySolveOffThread(corr(), views, [0, 0, 0], prior);
		const b = m.legacySolveOffThread(corr(), views, [0, 0, 0], prior);
		expect(FakeWorker.instances).toHaveLength(1);
		const [ja, jb] = FakeWorker.instances[0].posted;
		expect(ja.id).not.toBe(jb.id);
		FakeWorker.instances[0].reply({
			id: jb.id,
			ok: true,
			result: { inliers: 2 },
		});
		FakeWorker.instances[0].reply({
			id: ja.id,
			ok: true,
			result: { inliers: 1 },
		});
		expect((await a).inliers).toBe(1);
		expect((await b).inliers).toBe(2);
	});

	it("maps a worker Deadline error back to the Deadline class", async () => {
		const m = await load();
		const p = m.assembleOffThread(corr(), views, [0, 0, 0], prior, null, {
			fused: true,
			freeFocal: false,
		});
		const w = FakeWorker.instances[0];
		w.reply({ id: w.posted[0].id, ok: false, error: "late", name: "Deadline" });
		// same module graph as the freshly loaded solve-offthread (resetModules gives a new class)
		const { Deadline } = await import("../assemble");
		await expect(p).rejects.toBeInstanceOf(Deadline);
	});

	it("keeps the error name and message of other worker failures", async () => {
		const m = await load();
		const p = m.legacySolveOffThread(corr(), views, [0, 0, 0], prior);
		const w = FakeWorker.instances[0];
		w.reply({
			id: w.posted[0].id,
			ok: false,
			error: "boom",
			name: "RangeError",
		});
		await expect(p).rejects.toMatchObject({
			name: "RangeError",
			message: "boom",
		});
	});

	it("ignores replies with an unknown id", async () => {
		const m = await load();
		const p = m.legacySolveOffThread(corr(), views, [0, 0, 0], prior);
		const w = FakeWorker.instances[0];
		w.reply({ id: 9999, ok: true, result: {} });
		w.reply({ id: w.posted[0].id, ok: true, result: { inliers: 3 } });
		expect((await p).inliers).toBe(3);
	});

	it("a worker error rejects pending jobs, terminates it, and later calls fall back in-thread", async () => {
		const m = await load();
		const p = m.legacySolveOffThread(corr(), views, [0, 0, 0], prior);
		const w = FakeWorker.instances[0];
		w.onerror?.({ message: "script failed" });
		await expect(p).rejects.toThrow("script failed");
		expect(w.terminated).toBe(true);
		const r = await m.legacySolveOffThread(corr(), views, [0, 0, 0], prior);
		expect(r.reason).toBe("too few lifted matches");
		expect(FakeWorker.instances).toHaveLength(1);
	});

	it("falls back in-thread when the Worker constructor throws", async () => {
		vi.stubGlobal(
			"Worker",
			class {
				constructor() {
					throw new Error("no module workers");
				}
			},
		);
		const m = await load();
		const r = await m.legacySolveOffThread(corr(), views, [0, 0, 0], prior);
		expect(r.pose).toBeNull();
	});
});
