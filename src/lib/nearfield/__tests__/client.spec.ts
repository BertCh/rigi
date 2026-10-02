// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	decodeDepthWire,
	f16ToF32,
	halfToFloat,
	NearFieldClient,
} from "../client";
import { encodeSplatV1 } from "../splat-io";
import type { GaussianCloud } from "../types";

/** float32 -> float16 bits for the finite, normal-range values the tests use. */
function floatToHalf(v: number): number {
	if (v === 0) return Object.is(v, -0) ? 0x8000 : 0;
	const s = v < 0 ? 0x8000 : 0;
	const a = Math.abs(v);
	let e = Math.floor(Math.log2(a));
	let f = a / 2 ** e - 1;
	if (e < -14) return s | Math.round(a / 2 ** -24);
	f = Math.round(f * 1024);
	if (f === 1024) {
		f = 0;
		e++;
	}
	return s | ((e + 15) << 10) | f;
}
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function halfB64(values: number[]) {
	const out = new Uint8Array(2 * values.length);
	values.forEach((v, i) => {
		const h = floatToHalf(v);
		out[2 * i] = h & 0xff;
		out[2 * i + 1] = h >> 8;
	});
	return b64(out);
}
const wire = (w = 2, h = 2, extra: Record<string, unknown> = {}) => ({
	width: w,
	height: h,
	depthF16: halfB64(Array.from({ length: w * h }, (_, i) => 1 + i)),
	validU8: b64(Uint8Array.from({ length: w * h }, (_, i) => (i % 2 ? 0 : 1))),
	...extra,
});

describe("half floats", () => {
	it("decodes the special values", () => {
		expect(halfToFloat(0x3c00)).toBe(1);
		expect(halfToFloat(0xbc00)).toBe(-1);
		expect(halfToFloat(0x0000)).toBe(0);
		expect(halfToFloat(0x7c00)).toBe(Number.POSITIVE_INFINITY);
		expect(halfToFloat(0xfc00)).toBe(Number.NEGATIVE_INFINITY);
		expect(halfToFloat(0x7e00)).toBeNaN();
		expect(halfToFloat(0x0001)).toBeCloseTo(2 ** -24, 30); // smallest subnormal
		expect(halfToFloat(0x7bff)).toBe(65504); // max
		expect(halfToFloat(0x3555)).toBeCloseTo(1 / 3, 3);
	});
	it("f16ToF32 round-trips representable values via the LUT", () => {
		const vals = [0.5, 1, 2, 10, 100, -3, 1024, 0.25];
		const bytes = Uint8Array.from(atob(halfB64(vals)), (c) => c.charCodeAt(0));
		expect(Array.from(f16ToF32(bytes))).toEqual(vals);
		expect(f16ToF32(new Uint8Array(0))).toHaveLength(0);
	});
});

describe("decodeDepthWire", () => {
	it("decodes depth, validity and defaults", () => {
		const d = decodeDepthWire(wire());
		expect([d.width, d.height]).toEqual([2, 2]);
		expect(Array.from(d.depth)).toEqual([1, 2, 3, 4]);
		expect(Array.from(d.valid)).toEqual([1, 0, 1, 0]);
		expect(d.model).toBe("unknown");
		expect(d.seconds).toBe(0);
		expect(d.intrinsicsNorm).toBeUndefined();
		expect(d.normal).toBeUndefined();
	});
	it("carries model, seconds, intrinsics and normals (only when sized right)", () => {
		const K = { fx: 1, fy: 1.5, cx: 0.5, cy: 0.5 };
		const d = decodeDepthWire(
			wire(2, 2, {
				model: "m",
				seconds: 1.5,
				intrinsicsNorm: K,
				normalF16: halfB64(new Array(12).fill(0.5)),
			}),
		);
		expect(d.model).toBe("m");
		expect(d.seconds).toBe(1.5);
		expect(d.intrinsicsNorm).toEqual(K);
		expect(d.normal).toHaveLength(12);
		const bad = decodeDepthWire(wire(2, 2, { normalF16: halfB64([1, 2, 3]) }));
		expect(bad.normal).toBeUndefined();
	});
	it("throws on a size mismatch", () => {
		expect(() => decodeDepthWire({ ...wire(), width: 3 })).toThrow(
			/size mismatch/,
		);
	});
});

const jsonResponse = (
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

function cloud(): GaussianCloud {
	return {
		count: 1,
		frame: "camera",
		positions: Float32Array.from([1, 2, 3]),
		scales: Float32Array.from([0.1, 0.1, 0.1]),
		rotations: Float32Array.from([1, 0, 0, 0]),
		colors: Uint8Array.from([1, 2, 3, 4]),
		provenance: Uint8Array.from([1]),
	};
}

describe("NearFieldClient", () => {
	let fetchMock: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
	});
	const healthy = { ok: true, models: ["moge2"], device: "cpu" };

	it("strips trailing slashes from the base", () => {
		expect(new NearFieldClient("http://x:1///").base).toBe("http://x:1");
	});
	it("health: parses the reply and caches it", async () => {
		fetchMock.mockImplementation(async () => jsonResponse(healthy));
		const c = new NearFieldClient("http://svc");
		expect(await c.health()).toEqual(healthy);
		expect(await c.available()).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("http://svc/health");
		await c.health(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
	it("health: down on network error, non-ok body or bad status; sloppy fields are normalised", async () => {
		const c = new NearFieldClient("http://svc");
		fetchMock.mockRejectedValue(new Error("refused"));
		expect(await c.health()).toBeNull();
		expect(await c.available()).toBe(false);
		fetchMock.mockImplementation(async () => jsonResponse({ ok: false }));
		expect(await c.health(true)).toBeNull();
		fetchMock.mockImplementation(async () => jsonResponse({}, 500));
		expect(await c.health(true)).toBeNull();
		fetchMock.mockImplementation(async () =>
			jsonResponse({ ok: true, models: "x", device: 3 }),
		);
		expect(await c.health(true)).toEqual({ ok: true, models: [], device: "3" });
	});
	it("available: needs moge2 when the service lists models, else trusts ok", async () => {
		const c = new NearFieldClient("http://svc");
		fetchMock.mockImplementation(async () =>
			jsonResponse({ ok: true, models: ["da3", "lama"], device: "cpu" }),
		);
		expect(await c.available(true)).toBe(false);
		fetchMock.mockImplementation(async () =>
			jsonResponse({ ok: true, models: ["moge2", "lift"], device: "cpu" }),
		);
		expect(await c.available(true)).toBe(true);
		fetchMock.mockImplementation(async () =>
			jsonResponse({ ok: true, device: "cpu", version: "v1" }),
		);
		expect(await c.available(true)).toBe(true);
		expect((await c.health())?.version).toBe("v1");
	});
	it("health: shares one in-flight request and a down cache expires sooner than an ok one", async () => {
		vi.useFakeTimers();
		fetchMock.mockImplementation(async () => jsonResponse(healthy));
		const c = new NearFieldClient("http://svc");
		const [a, b] = await Promise.all([c.health(), c.health()]);
		expect(a).toBe(b);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(30_000);
		await c.health();
		expect(fetchMock).toHaveBeenCalledTimes(1); // ok: 60 s TTL
		vi.advanceTimersByTime(31_000);
		await c.health();
		expect(fetchMock).toHaveBeenCalledTimes(2);
		fetchMock.mockRejectedValue(new Error("x"));
		const d = new NearFieldClient("http://svc2");
		await d.health();
		fetchMock.mockClear();
		vi.advanceTimersByTime(16_000);
		await d.health();
		expect(fetchMock).toHaveBeenCalledTimes(1); // down: 15 s TTL
	});
	it("depth: posts multipart and decodes the reply; null when the service is down", async () => {
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/health")) return jsonResponse(healthy);
			expect(init?.method).toBe("POST");
			const fd = init?.body as FormData;
			expect(fd.get("model")).toBe("da3");
			expect(fd.get("maxSide")).toBe("512");
			expect(fd.get("image")).toBeInstanceOf(Blob);
			return jsonResponse({ ...wire(), model: "da3", seconds: 2 });
		});
		const c = new NearFieldClient("http://svc");
		const d = await c.depth(new Blob(["x"]), { model: "da3", maxSide: 512 });
		expect(d?.model).toBe("da3");
		expect(Array.from(d?.depth ?? [])).toEqual([1, 2, 3, 4]);
		const down = new NearFieldClient("http://svc");
		fetchMock.mockReset();
		fetchMock.mockRejectedValue(new Error("refused"));
		expect(await down.depth(new Blob(["x"]))).toBeNull();
	});
	it("returns null for an aborted signal, an HTTP error and a malformed body", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			url.endsWith("/health")
				? jsonResponse(healthy)
				: jsonResponse({ error: "boom" }, 500),
		);
		const c = new NearFieldClient("http://svc");
		expect(await c.depth(new Blob(["x"]))).toBeNull();
		expect(console.warn).toHaveBeenCalled();
		const ac = new AbortController();
		ac.abort();
		fetchMock.mockClear();
		expect(await c.depth(new Blob(["x"]), { signal: ac.signal })).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
		fetchMock.mockImplementation(async (url: string) =>
			url.endsWith("/health")
				? jsonResponse(healthy)
				: jsonResponse({ width: 2, height: 2, depthF16: "", validU8: "" }),
		);
		expect(await c.depth(new Blob(["x"]))).toBeNull();
	});
	it("gaussians: decodes a splat-v1 body and the meta header (tolerating a bad header)", async () => {
		const body = encodeSplatV1(cloud());
		const meta = {
			width: 8,
			height: 6,
			intrinsicsNorm: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
		};
		let header: string | null = JSON.stringify(meta);
		fetchMock.mockImplementation(async (url: string) =>
			url.endsWith("/health")
				? jsonResponse(healthy)
				: new Response(body, {
						status: 200,
						headers: header ? { "X-NearField-Meta": header } : {},
					}),
		);
		const c = new NearFieldClient("http://svc");
		const r = await c.gaussiansWithMeta(new Blob(["x"]), { model: "lift" });
		expect(r?.cloud.count).toBe(1);
		expect(Array.from(r?.cloud.positions ?? [])).toEqual([1, 2, 3]);
		expect(r?.meta).toEqual(meta);
		expect((await c.gaussians(new Blob(["x"])))?.count).toBe(1);
		header = "{not json";
		expect((await c.gaussiansWithMeta(new Blob(["x"])))?.meta).toEqual({});
		header = null;
		expect((await c.gaussiansWithMeta(new Blob(["x"])))?.meta).toEqual({});
	});
	it("gaussians: null for an unrecognised body", async () => {
		fetchMock.mockImplementation(async (url: string) =>
			url.endsWith("/health")
				? jsonResponse(healthy)
				: new Response(new Uint8Array(100)),
		);
		const c = new NearFieldClient("http://svc");
		expect(await c.gaussians(new Blob(["x"]))).toBeNull();
	});
	it("multiview: posts images and poses.json, decodes every depth with the model name", async () => {
		const cams = [
			{
				c2w: new Array(16).fill(0),
				intrinsicsNorm: { fx: 1, fy: 1, cx: 0.5, cy: 0.5 },
			},
		];
		let sent: FormData | null = null;
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/health")) return jsonResponse(healthy);
			sent = init?.body as FormData;
			return jsonResponse({
				model: "da3-multi",
				cameras: cams,
				depths: [wire(), wire(1, 2)],
				seconds: 3,
			});
		});
		const c = new NearFieldClient("http://svc");
		const r = await c.multiview([new Blob(["a"]), new Blob(["b"])], {
			poses: { c2w: [] },
		});
		expect(r?.model).toBe("da3-multi");
		expect(r?.depths).toHaveLength(2);
		expect(r?.depths[0].model).toBe("da3-multi");
		expect(r?.depths[1].height).toBe(2);
		expect(r?.cameras).toEqual(cams);
		expect((sent as unknown as FormData).getAll("images")).toHaveLength(2);
		expect((sent as unknown as FormData).get("poses")).toBeInstanceOf(Blob);
	});
	it("a timeout aborts the request and marks the service down", async () => {
		vi.useFakeTimers();
		fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
			if (url.endsWith("/health")) return jsonResponse(healthy);
			return new Promise((_res, rej) => {
				init?.signal?.addEventListener("abort", () =>
					rej(new DOMException("aborted", "AbortError")),
				);
			});
		});
		const c = new NearFieldClient("http://svc");
		const p = c.depth(new Blob(["x"]), { timeoutMs: 50 });
		await vi.advanceTimersByTimeAsync(100);
		expect(await p).toBeNull();
	});
});
