// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { createPendingRequests } from "../pending";

const COLD = 120;
const WARM = 60;

function setup(now?: () => number) {
	vi.useFakeTimers();
	const onStall = vi.fn();
	const p = createPendingRequests<string>(
		(heard) => (heard ? WARM : COLD),
		onStall,
		undefined,
		now,
	);
	const settled: string[] = [];
	const add = (id: number) =>
		p.add(
			id,
			(v) => settled.push(`${id}:${v}`),
			(e) => settled.push(`${id}:rejected:${(e as Error).message}`),
		);
	return { p, onStall, settled, add };
}

describe("createPendingRequests", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("resolves by id and ignores unknown ids", () => {
		const { p, settled, add } = setup();
		add(1);
		add(2);
		p.resolve(2, "b");
		p.resolve(7, "x");
		p.resolve(1, "a");
		expect(settled).toEqual(["2:b", "1:a"]);
		expect(p.size).toBe(0);
	});

	it("stalls after the cold allowance when the worker never replies", () => {
		const { onStall, add } = setup();
		add(1);
		vi.advanceTimersByTime(COLD - 1);
		expect(onStall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("a deep queue that keeps replying never stalls; silence after a reply uses the warm allowance", () => {
		const { p, onStall, add } = setup();
		for (let id = 1; id <= 5; id++) add(id);
		for (let id = 1; id <= 4; id++) {
			vi.advanceTimersByTime(WARM - 1);
			p.resolve(id, "ok");
		}
		expect(onStall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(WARM);
		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("an empty table never stalls", () => {
		const { p, onStall, add } = setup();
		add(1);
		p.resolve(1, "ok");
		vi.advanceTimersByTime(10 * COLD);
		add(2);
		p.remove(2);
		vi.advanceTimersByTime(10 * COLD);
		expect(onStall).not.toHaveBeenCalled();
	});

	it("rejectAll rejects everything, stops the watchdog and restarts cold", () => {
		const { p, onStall, settled, add } = setup();
		add(1);
		p.resolve(1, "ok");
		add(2);
		add(3);
		p.rejectAll(new Error("gone"));
		expect(settled).toEqual(["1:ok", "2:rejected:gone", "3:rejected:gone"]);
		vi.advanceTimersByTime(10 * COLD);
		expect(onStall).not.toHaveBeenCalled();
		// the replacement worker has not replied yet: the cold allowance applies again
		add(4);
		vi.advanceTimersByTime(WARM);
		expect(onStall).not.toHaveBeenCalled();
		vi.advanceTimersByTime(COLD - WARM);
		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("a reply for an unknown id is not progress", () => {
		const { p, onStall, add } = setup();
		add(1);
		vi.advanceTimersByTime(COLD - 1);
		p.resolve(99, "stale");
		vi.advanceTimersByTime(1);
		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("removing one request keeps the watchdog armed for the others", () => {
		const { p, onStall, add } = setup();
		add(1);
		add(2);
		p.remove(1);
		vi.advanceTimersByTime(COLD);
		expect(onStall).toHaveBeenCalledTimes(1);
	});

	it("a timer that fires long after its allowance (suspended page) re-arms instead of stalling", () => {
		let clock = 0;
		const { p, onStall, settled, add } = setup(() => clock);
		add(1);
		clock = 10 * COLD; // the page slept
		vi.advanceTimersByTime(COLD);
		expect(onStall).not.toHaveBeenCalled();
		p.resolve(1, "late");
		expect(settled).toEqual(["1:late"]);
		add(2);
		clock += WARM;
		vi.advanceTimersByTime(WARM);
		expect(onStall).toHaveBeenCalledTimes(1);
	});
});
