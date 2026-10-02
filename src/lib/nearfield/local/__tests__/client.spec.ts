// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
	device: null as object | null,
	nnOk: true,
	fetchModel: null as null | ((file: string) => Promise<ArrayBuffer>),
}));
vi.mock("#/lib/models", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/models")>()),
	fetchModel: (file: string) =>
		env.fetchModel ? env.fetchModel(file) : Promise.reject(new Error("off")),
}));
vi.mock("#/lib/gpu/device", () => ({
	getComputeDevice: async () => env.device,
}));
vi.mock("#/lib/nn/registry", () => ({
	getNn: async () => (env.nnOk ? { backend: { kind: "gpu" } } : null),
	releaseNn: async () => {},
}));

import { GpuDeviceLostError } from "#/lib/gpu/core/lifecycle";
import { GpuValidationError } from "#/lib/gpu/core/queue";
import { NearFieldError } from "../../client";
import {
	type LocalDeps,
	LocalNearFieldClient,
	NEARFIELD_IDLE_UNLOAD_MS,
	toNearFieldError,
} from "../client";
import { MOGE2_WEIGHTS } from "../depth-net";

beforeEach(() => {
	env.device = null;
	env.nnOk = true;
	env.fetchModel = null;
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(null, { status: 200 })),
	);
});

describe("LocalNearFieldClient availability (= models loadable on WebGPU)", () => {
	it("is unavailable without a WebGPU compute device", async () => {
		const c = new LocalNearFieldClient();
		expect(await c.available()).toBe(false);
		expect((await c.health()).device).toBe("");
		expect(await c.availability()).toEqual({ ok: false, reason: "no-webgpu" });
	});

	it("is available with a device, the nn GPU backend and reachable weights", async () => {
		env.device = {};
		const c = new LocalNearFieldClient();
		expect(await c.available()).toBe(true);
		expect(fetch).toHaveBeenCalledWith(
			expect.stringMatching(/models\/moge2-vits-q8\.[0-9a-f]{8}\.safetensors$/),
			{ method: "HEAD" },
		);
	});

	it("picks the weights file from the constructor, else the nearfieldWeights flag (q8)", () => {
		expect(new LocalNearFieldClient().weightsFile).toBe(MOGE2_WEIGHTS.q8);
		expect(new LocalNearFieldClient({ weights: "fp16" }).weightsFile).toBe(
			MOGE2_WEIGHTS.fp16,
		);
	});

	it("is unavailable when the weights are not served or the GPU backend is missing", async () => {
		env.device = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		);
		expect(await new LocalNearFieldClient().availability()).toEqual({
			ok: false,
			reason: "weights-unreachable",
		});
		env.device = {};
		env.nnOk = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 200 })),
		);
		expect(await new LocalNearFieldClient().available()).toBe(false);
	});
});

describe("LocalNearFieldClient prefetch", () => {
	it("fetches the chosen weights and marks them reachable without a HEAD", async () => {
		env.device = {};
		const files: string[] = [];
		env.fetchModel = async (file) => {
			files.push(file);
			return new ArrayBuffer(8);
		};
		const c = new LocalNearFieldClient({ weights: "q8lite" });
		expect(await c.prefetch()).toBe(true);
		expect(files).toEqual([MOGE2_WEIGHTS.q8lite]);
		expect(await c.available()).toBe(true);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("resolves false when the download fails", async () => {
		env.fetchModel = async () => {
			throw new Error("offline");
		};
		expect(await new LocalNearFieldClient().prefetch()).toBe(false);
	});
});

// ---- jobs: abort, timeout, single-flight, errors, idle unload (fake deps, no GPU) ----------------

function fakeDepth(tag: number) {
	return {
		width: 2,
		height: 2,
		depth: new Float32Array(4).fill(tag),
		valid: new Uint8Array(4).fill(1),
		model: "fake",
		intrinsicsNorm: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
	} as never;
}

/** Deps whose estimate() the test releases by hand; records the order of starts and ends. */
function harness(over: Partial<LocalDeps> = {}, idleMs?: number) {
	const log: string[] = [];
	const gates: Array<{ blob: Blob; signal: AbortSignal; release: () => void }> =
		[];
	const nn = { backend: { kind: "gpu" } };
	const device = { id: "dev" };
	let loads = 0;
	const deps: Partial<LocalDeps> = {
		getDevice: async () => device as never,
		getNn: async () => nn as never,
		loadNet: async () => {
			loads++;
			return { id: loads } as never;
		},
		disposeNet: (net) =>
			void log.push(`dispose ${(net as { id?: number }).id}`),
		releaseNn: async () => void log.push("release"),
		decode: async (blob) =>
			({ blob, rgba: new Uint8ClampedArray(16) }) as never,
		estimate: (_net, dec, signal) =>
			new Promise((resolve, reject) => {
				const blob = (dec as unknown as { blob: Blob }).blob;
				log.push(`start ${blob.size}`);
				const gate = {
					blob,
					signal,
					release: () => {
						log.push(`end ${blob.size}`);
						resolve(fakeDepth(blob.size));
					},
				};
				signal.addEventListener("abort", () => {
					log.push(`abort ${blob.size}`);
					reject(signal.reason);
				});
				gates.push(gate);
			}),
		lift: async () => ({ count: 1 }) as never,
		...over,
	};
	const client = new LocalNearFieldClient({ deps, idleMs });
	return { client, log, gates, loads: () => loads };
}

const photoBlob = (n: number) => new Blob([new Uint8Array(n)]);
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("LocalNearFieldClient jobs", () => {
	it("shares one job per photo and returns its depth to every caller", async () => {
		const h = harness();
		const b = photoBlob(1);
		const a1 = h.client.depth(b);
		const a2 = h.client.depth(b);
		await tick();
		expect(h.gates).toHaveLength(1);
		h.gates[0].release();
		expect((await a1)?.model).toBe("fake");
		expect(await a2).toBe(await a1);
	});

	it("an abort rejects only that caller; the job survives while another waits", async () => {
		const h = harness();
		const b = photoBlob(1);
		const ctrl = new AbortController();
		const a1 = h.client.depth(b, { signal: ctrl.signal });
		const a2 = h.client.depth(b);
		await tick();
		ctrl.abort();
		await expect(a1).rejects.toMatchObject({ name: "AbortError" });
		expect(h.gates[0].signal.aborted).toBe(false);
		h.gates[0].release();
		expect((await a2)?.model).toBe("fake");
	});

	it("cancels the job when every caller aborted, and the next call starts a new one", async () => {
		const h = harness();
		const b = photoBlob(1);
		const c1 = new AbortController();
		const c2 = new AbortController();
		const a1 = h.client.depth(b, { signal: c1.signal });
		const a2 = h.client.depth(b, { signal: c2.signal });
		await tick();
		c1.abort();
		c2.abort();
		await expect(a1).rejects.toMatchObject({ name: "AbortError" });
		await expect(a2).rejects.toMatchObject({ name: "AbortError" });
		expect(h.gates[0].signal.aborted).toBe(true);
		const again = h.client.depth(b);
		await tick();
		expect(h.gates).toHaveLength(2);
		h.gates[1].release();
		expect((await again)?.model).toBe("fake");
	});

	it("an already-aborted signal rejects without starting inference", async () => {
		const h = harness();
		await expect(
			h.client.depth(photoBlob(1), { signal: AbortSignal.abort() }),
		).rejects.toMatchObject({ name: "AbortError" });
		await tick();
		expect(h.gates).toHaveLength(0);
	});

	it("timeoutMs rejects with NearFieldError(timeout) and cancels the job", async () => {
		vi.useFakeTimers();
		try {
			const h = harness();
			const p = h.client.depth(photoBlob(1), { timeoutMs: 1000 });
			const seen = p.catch((e) => e);
			await vi.advanceTimersByTimeAsync(1001);
			const e = await seen;
			expect(e).toBeInstanceOf(NearFieldError);
			expect((e as NearFieldError).code).toBe("timeout");
			expect(h.gates[0].signal.aborted).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("runs different photos one after the other (single flight)", async () => {
		const h = harness();
		const p1 = h.client.depth(photoBlob(1));
		const p2 = h.client.depth(photoBlob(2));
		await tick();
		expect(h.log).toEqual(["start 1"]);
		h.gates[0].release();
		await p1;
		await tick();
		expect(h.log).toEqual(["start 1", "end 1", "start 2"]);
		h.gates[1].release();
		await p2;
	});

	it("an aborted waiter does not block the photo behind it", async () => {
		const h = harness();
		const c = new AbortController();
		const p1 = h.client.depth(photoBlob(1), { signal: c.signal });
		const p2 = h.client.depth(photoBlob(2));
		await tick();
		c.abort();
		await expect(p1).rejects.toMatchObject({ name: "AbortError" });
		await tick();
		expect(h.gates.map((g) => g.blob.size)).toEqual([1, 2]);
		h.gates[1].release();
		expect((await p2)?.model).toBe("fake");
	});

	it("maps failures to codes and retries a failed photo", async () => {
		let fail: unknown = new Error("boom");
		const h = harness({
			estimate: async () => {
				if (fail) throw fail;
				return fakeDepth(1);
			},
		});
		const b = photoBlob(1);
		await expect(h.client.depth(b)).rejects.toMatchObject({
			code: "inference-failed",
		});
		fail = new GpuDeviceLostError();
		await expect(h.client.depth(b)).rejects.toMatchObject({
			code: "device-lost",
		});
		fail = new GpuValidationError("out-of-memory", "oom");
		await expect(h.client.depth(b)).rejects.toMatchObject({
			code: "out-of-memory",
		});
		fail = null;
		expect((await h.client.depth(b))?.model).toBe("fake");
	});

	it("maps weight, device and lift failures", async () => {
		const bad = harness({
			loadNet: async () => {
				throw new Error("corrupt");
			},
		});
		await expect(bad.client.depth(photoBlob(1))).rejects.toMatchObject({
			code: "weights-failed",
		});
		const none = harness({ getDevice: async () => null });
		await expect(none.client.depth(photoBlob(1))).rejects.toMatchObject({
			code: "no-webgpu",
		});
		const lifting = harness({
			lift: async () => {
				throw new Error("kernel");
			},
		});
		const p = lifting.client.gaussiansWithMeta(photoBlob(1));
		await tick();
		lifting.gates[0].release();
		await expect(p).rejects.toMatchObject({ code: "lift-failed" });
		expect(toNearFieldError(new Error("x"), "lift-failed")).toBeInstanceOf(
			NearFieldError,
		);
	});

	it("lifts on the GPU only (no CPU fallback) and passes the signal", async () => {
		let sawSignal: AbortSignal | undefined;
		const h = harness({
			lift: async (_d, _i, signal) => {
				sawSignal = signal;
				return { count: 7 } as never;
			},
		});
		const p = h.client.gaussiansWithMeta(photoBlob(1));
		await tick();
		h.gates[0].release();
		const r = await p;
		expect(r?.cloud).toEqual({ count: 7 });
		expect(sawSignal).toBeDefined();
	});
});

describe("LocalNearFieldClient idle unload", () => {
	beforeEach(() => vi.useFakeTimers());

	it("exports 5 minutes", () => {
		expect(NEARFIELD_IDLE_UNLOAD_MS).toBe(300_000);
	});

	it("disposes the weights and releases the runtime after the idle time, then reloads", async () => {
		const h = harness({}, 1000);
		const b = photoBlob(1);
		const p = h.client.depth(b);
		await vi.advanceTimersByTimeAsync(0);
		h.gates[0].release();
		await p;
		await vi.advanceTimersByTimeAsync(999);
		expect(h.log).not.toContain("release");
		await vi.advanceTimersByTimeAsync(2);
		expect(h.log.slice(-2)).toEqual(["dispose 1", "release"]);
		expect(h.loads()).toBe(1);
		const p2 = h.client.depth(photoBlob(2));
		await vi.advanceTimersByTimeAsync(0);
		h.gates[1].release();
		await p2;
		expect(h.loads()).toBe(2);
	});

	it("never unloads while a job is in flight, and a new call restarts the clock", async () => {
		const h = harness({}, 1000);
		const p = h.client.depth(photoBlob(1));
		await vi.advanceTimersByTimeAsync(5000);
		expect(h.log).not.toContain("release");
		h.gates[0].release();
		await p;
		await vi.advanceTimersByTimeAsync(600);
		const p2 = h.client.depth(photoBlob(2));
		await vi.advanceTimersByTimeAsync(600);
		expect(h.log).not.toContain("release");
		h.gates[1].release();
		await p2;
		await vi.advanceTimersByTimeAsync(1001);
		expect(h.log).toContain("release");
	});
});
