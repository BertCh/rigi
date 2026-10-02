// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Client = typeof import("../client");
let client: Client;

class FakeReader {
	result: string | null = null;
	error: unknown = null;
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	readAsDataURL(b: Blob) {
		void b.text().then((t) => {
			this.result = `data:application/octet-stream;base64,${btoa(t)}`;
			this.onload?.();
		});
	}
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

beforeEach(async () => {
	vi.resetModules();
	vi.stubGlobal("FileReader", FakeReader);
	client = await import("../client");
});
afterEach(() => vi.unstubAllGlobals());

describe("propagateServiceUp", () => {
	it("is true only when /health answers with method rot", async () => {
		const f = vi.fn(async (_url: string) => json({ method: "rot" }));
		vi.stubGlobal("fetch", f);
		expect(await client.propagateServiceUp()).toBe(true);
		expect(String(f.mock.calls[0][0])).toMatch(/\/health$/);
	});
	it("is false for another method, a bad status or a network error", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({ method: "other" })),
		);
		expect(await client.propagateServiceUp(true)).toBe(false);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => json({}, 500)),
		);
		expect(await client.propagateServiceUp(true)).toBe(false);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("down");
			}),
		);
		expect(await client.propagateServiceUp(true)).toBe(false);
	});
	it("caches an up answer for a minute and a down answer for ten seconds, unless forced", async () => {
		vi.useFakeTimers();
		const f = vi.fn(async () => json({ method: "rot" }));
		vi.stubGlobal("fetch", f);
		await client.propagateServiceUp();
		await client.propagateServiceUp();
		expect(f).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(61_000);
		await client.propagateServiceUp();
		expect(f).toHaveBeenCalledTimes(2);
		await client.propagateServiceUp(true);
		expect(f).toHaveBeenCalledTimes(3);

		const g = vi.fn(async () => json({}, 503));
		vi.stubGlobal("fetch", g);
		await client.propagateServiceUp(true);
		vi.advanceTimersByTime(5000);
		await client.propagateServiceUp();
		expect(g).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(6000);
		await client.propagateServiceUp();
		expect(g).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});
	it("exposes the base url without a trailing slash", () => {
		expect(client.propagateServiceUrl()).toMatch(/^https?:\/\/[^/]+(:\d+)?$/);
	});
});

describe("relRot", () => {
	const image = (body: string) => new Response(new Blob([body]));
	function route(relrot: () => Response | Promise<Response>) {
		const f = vi.fn(async (url: string, _init?: RequestInit) =>
			String(url).endsWith("/relrot") ? relrot() : image(`img:${url}`),
		);
		vi.stubGlobal("fetch", f);
		return f;
	}

	it("posts both images as base64 with their fovs and returns the result", async () => {
		const result = {
			method: "rot",
			relR: [1, 0, 0, 0, 1, 0, 0, 0, 1],
			inliers: 80,
		};
		const f = route(() => json(result));
		const r = await client.relRot(
			{ src: "a.jpg", vfov: 50 },
			{ src: "b.jpg", vfov: 60 },
		);
		expect(r).toEqual(result);
		const post = f.mock.calls.find((c) => String(c[0]).endsWith("/relrot"));
		const body = JSON.parse((post?.[1] as RequestInit).body as string);
		expect(atob(body.a)).toBe("img:a.jpg");
		expect(atob(body.b)).toBe("img:b.jpg");
		expect([body.vfovA, body.vfovB]).toEqual([50, 60]);
	});

	it("caches an image's bytes across calls", async () => {
		const f = route(() => json({ method: "rot" }));
		await client.relRot({ src: "a.jpg", vfov: 50 }, { src: "b.jpg", vfov: 60 });
		await client.relRot({ src: "a.jpg", vfov: 50 }, { src: "c.jpg", vfov: 60 });
		expect(f.mock.calls.filter((c) => c[0] === "a.jpg")).toHaveLength(1);
	});

	it("turns a service error into a message", async () => {
		route(() => json({ message: "no matches" }, 422));
		expect(
			await client.relRot(
				{ src: "a.jpg", vfov: 50 },
				{ src: "b.jpg", vfov: 60 },
			),
		).toBe("service 422: no matches");
		route(() => new Response("<html>", { status: 502 }));
		expect(
			await client.relRot(
				{ src: "a.jpg", vfov: 50 },
				{ src: "b.jpg", vfov: 60 },
			),
		).toBe("service 502: error");
	});

	it("reports unreachable on network failure, and marks the service down", async () => {
		route(() => {
			throw new Error("ECONNREFUSED");
		});
		const r = await client.relRot(
			{ src: "a.jpg", vfov: 50 },
			{ src: "b.jpg", vfov: 60 },
		);
		expect(r).toBe("service unreachable (ECONNREFUSED)");
		const g = vi.fn(async () => json({ method: "rot" }));
		vi.stubGlobal("fetch", g);
		await client.propagateServiceUp(); // cached as down: no new request
		expect(g).not.toHaveBeenCalled();
	});

	it("says 'aborted' when the caller aborts, and does not mark the service down", async () => {
		const ac = new AbortController();
		route(() => {
			ac.abort();
			throw new Error("aborted by caller");
		});
		const r = await client.relRot(
			{ src: "a.jpg", vfov: 50 },
			{ src: "b.jpg", vfov: 60 },
			ac.signal,
		);
		expect(r).toBe("aborted");
	});

	it("does not cache a failed image fetch", async () => {
		let n = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (String(url).endsWith("/relrot")) return json({ method: "rot" });
				return ++n === 1 ? new Response("x", { status: 404 }) : image("ok");
			}),
		);
		const first = await client.relRot(
			{ src: "a.jpg", vfov: 50 },
			{ src: "a.jpg", vfov: 50 },
		);
		expect(first).toBe("service unreachable (image 404)");
		const second = await client.relRot(
			{ src: "a.jpg", vfov: 50 },
			{ src: "a.jpg", vfov: 50 },
		);
		expect(second).toEqual({ method: "rot" });
	});
});
