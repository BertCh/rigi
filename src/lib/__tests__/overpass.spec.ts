// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { OVERPASS, OverpassError, overpass, overpassMemo } from "../overpass";

const json = (body: unknown, status = 200) => ({
	ok: status >= 200 && status < 300,
	status,
	json: async () => body,
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("overpass", () => {
	it("POSTs the query as form data and returns the elements", async () => {
		const f = vi.fn(async () =>
			json({ elements: [{ type: "node", lat: 1, lon: 2 }] }),
		);
		vi.stubGlobal("fetch", f);
		const r = await overpass("[out:json];node(1);out;");
		expect(r.elements).toHaveLength(1);
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(OVERPASS.main);
		expect(init.method).toBe("POST");
		expect((init.body as URLSearchParams).get("data")).toBe(
			"[out:json];node(1);out;",
		);
	});
	it("sends a User-Agent only when asked", async () => {
		const f = vi.fn(async () => json({ elements: [] }));
		vi.stubGlobal("fetch", f);
		await overpass("q");
		expect(
			(f.mock.calls[0] as unknown as [string, RequestInit])[1].headers,
		).toBeUndefined();
		await overpass("q", { userAgent: "rigi-test" });
		expect(
			(f.mock.calls[1] as unknown as [string, RequestInit])[1].headers,
		).toEqual({
			"User-Agent": "rigi-test",
		});
	});
	it("falls through to the next endpoint on HTTP errors", async () => {
		const urls: string[] = [];
		vi.stubGlobal("fetch", async (u: string) => {
			urls.push(u);
			return u === "a" ? json({}, 500) : json({ elements: [] });
		});
		const r = await overpass("q", { endpoints: ["a", "b"] });
		expect(r.elements).toEqual([]);
		expect(urls).toEqual(["a", "b"]);
	});
	it("treats a body without an elements array as a failure", async () => {
		vi.stubGlobal("fetch", async (u: string) =>
			u === "a" ? json({ remark: "runtime error" }) : json({ elements: [1] }),
		);
		const r = await overpass("q", { endpoints: ["a", "b"] });
		expect(r.elements).toHaveLength(1);
	});
	it("throws OverpassError naming the last failure when all endpoints fail", async () => {
		vi.stubGlobal("fetch", async () => json({}, 429));
		const p = overpass("q", { endpoints: ["a", "b"] });
		await expect(p).rejects.toBeInstanceOf(OverpassError);
		await expect(p).rejects.toThrow(/b: HTTP 429/);
	});
	it("a network exception moves on to the next endpoint", async () => {
		vi.stubGlobal("fetch", async (u: string) => {
			if (u === "a") throw new Error("ECONNRESET");
			return json({ elements: [] });
		});
		await expect(
			overpass("q", { endpoints: ["a", "b"] }),
		).resolves.toBeTruthy();
	});
	it("reports the network message when it is the last failure", async () => {
		vi.stubGlobal("fetch", async () => {
			throw new Error("ECONNRESET");
		});
		await expect(overpass("q", { endpoints: ["a"] })).rejects.toThrow(
			/a: ECONNRESET/,
		);
	});
	it("an external abort rethrows instead of trying the next endpoint", async () => {
		const ctl = new AbortController();
		const f = vi.fn(async () => {
			ctl.abort(new Error("stop"));
			throw new Error("aborted");
		});
		vi.stubGlobal("fetch", f);
		await expect(
			overpass("q", { endpoints: ["a", "b"], signal: ctl.signal }),
		).rejects.toThrow("aborted");
		expect(f).toHaveBeenCalledTimes(1);
	});
	it("times out a hung request and moves on", async () => {
		vi.stubGlobal("fetch", (u: string, init: RequestInit) =>
			u === "a"
				? new Promise((_, rej) =>
						init.signal?.addEventListener("abort", () =>
							rej(Object.assign(new Error("x"), { name: "TimeoutError" })),
						),
					)
				: Promise.resolve(json({ elements: [] })),
		);
		await expect(
			overpass("q", { endpoints: ["a", "b"], timeoutMs: 20 }),
		).resolves.toEqual({ elements: [] });
	});
	it("states the timeout in the error when every endpoint times out", async () => {
		vi.stubGlobal(
			"fetch",
			(_u: string, init: RequestInit) =>
				new Promise((_, rej) =>
					init.signal?.addEventListener("abort", () =>
						rej(Object.assign(new Error("x"), { name: "TimeoutError" })),
					),
				),
		);
		await expect(
			overpass("q", { endpoints: ["a"], timeoutMs: 10 }),
		).rejects.toThrow(/timed out after 0.01s/);
	});
	it("backs off between endpoints", async () => {
		vi.useFakeTimers();
		const f = vi.fn(async (u: string) =>
			u === "a" ? json({}, 500) : json({ elements: [] }),
		);
		vi.stubGlobal("fetch", f);
		const p = overpass("q", { endpoints: ["a", "b"], backoffMs: 1000 });
		await vi.advanceTimersByTimeAsync(500);
		expect(f).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(600);
		await expect(p).resolves.toEqual({ elements: [] });
	});
	it("retryQuickFail retries the first endpoint after 3 s when it sheds load fast", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const f = vi.fn(async () =>
			++calls === 1 ? json({}, 429) : json({ elements: [] }),
		);
		vi.stubGlobal("fetch", f);
		const p = overpass("q", { endpoints: ["a"], retryQuickFail: true });
		await vi.advanceTimersByTimeAsync(2000);
		expect(f).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1500);
		await expect(p).resolves.toEqual({ elements: [] });
		expect(f).toHaveBeenCalledTimes(2);
	});
	it("retryQuickFail does not retry after a non-load-shedding error", async () => {
		const f = vi.fn(async () => json({}, 500));
		vi.stubGlobal("fetch", f);
		await expect(
			overpass("q", { endpoints: ["a"], retryQuickFail: true }),
		).rejects.toThrow();
		expect(f).toHaveBeenCalledTimes(1);
	});
});

describe("overpassMemo", () => {
	it("shares one request per query", async () => {
		const f = vi.fn(async () => json({ elements: [] }));
		vi.stubGlobal("fetch", f);
		const a = overpassMemo("memo-q1");
		const b = overpassMemo("memo-q1");
		expect(a).toBe(b);
		await a;
		expect(f).toHaveBeenCalledTimes(1);
	});
	it("does not keep failed requests", async () => {
		vi.stubGlobal("fetch", async () => json({}, 500));
		await expect(
			overpassMemo("memo-q2", { endpoints: ["a"] }),
		).rejects.toThrow();
		await Promise.resolve();
		const f = vi.fn(async () => json({ elements: [] }));
		vi.stubGlobal("fetch", f);
		await expect(
			overpassMemo("memo-q2", { endpoints: ["a"] }),
		).resolves.toBeTruthy();
		expect(f).toHaveBeenCalledTimes(1);
	});
});
