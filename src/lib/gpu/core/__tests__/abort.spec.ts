// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { abortable, isAbortError } from "../abort";
import { withLease } from "../pool";

const defer = <T = void>() => {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("isAbortError", () => {
	it("tells a cancel from a failure", () => {
		const c = new AbortController();
		c.abort();
		expect(isAbortError(c.signal.reason)).toBe(true);
		expect(isAbortError(new Error("boom"))).toBe(false);
		expect(isAbortError(null)).toBe(false);
	});
});

describe("abortable", () => {
	it("passes through without a signal or an abort", async () => {
		expect(await abortable(Promise.resolve(3), undefined)).toBe(3);
		expect(
			await abortable(Promise.resolve(4), new AbortController().signal),
		).toBe(4);
	});
	it("rejects at once with the reason, ignoring the late outcome", async () => {
		const c = new AbortController();
		const d = defer<number>();
		const p = abortable(d.promise, c.signal);
		c.abort(new Error("why"));
		await expect(p).rejects.toThrow("why");
		d.resolve(1);
		await tick();
	});
	it("rejects an already aborted signal", async () => {
		const c = new AbortController();
		c.abort();
		await expect(abortable(Promise.resolve(1), c.signal)).rejects.toSatisfy(
			isAbortError,
		);
	});
});

describe("withLease signal", () => {
	it("unaborted leases are unchanged", async () => {
		const c = new AbortController();
		expect(await withLease("ab-a", () => 7, { signal: c.signal })).toBe(7);
	});
	it("aborted before the grant: fn is skipped, FIFO order of the rest kept", async () => {
		const order: string[] = [];
		const gate = defer();
		const c = new AbortController();
		const first = withLease("ab-b", async () => {
			order.push("first");
			await gate.promise;
		});
		let ran = false;
		const second = withLease(
			"ab-b",
			() => {
				ran = true;
			},
			{ signal: c.signal },
		);
		const third = withLease("ab-b", () => {
			order.push("third");
		});
		c.abort();
		// the waiter hears about it at once, while the first lease is still held
		await expect(second).rejects.toSatisfy(isAbortError);
		expect(order).toEqual(["first"]);
		gate.resolve();
		await first;
		await third;
		expect(ran).toBe(false);
		expect(order).toEqual(["first", "third"]);
	});
	it("already aborted: rejects with the reason and never runs fn", async () => {
		const c = new AbortController();
		const reason = new Error("stale photo");
		c.abort(reason);
		let ran = false;
		await expect(
			withLease(
				"ab-c",
				() => {
					ran = true;
				},
				{ signal: c.signal },
			),
		).rejects.toBe(reason);
		expect(ran).toBe(false);
		// the lease was passed on
		expect(await withLease("ab-c", () => "next")).toBe("next");
	});
});
