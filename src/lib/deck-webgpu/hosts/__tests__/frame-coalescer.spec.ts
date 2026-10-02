// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { createFrameCoalescer, type FrameTimers } from "../frame-coalescer";

/** Fake rAF + timeout queues, advanced by hand. */
function fakeTimers() {
	let id = 0;
	const rafs = new Map<number, () => void>();
	const timeouts = new Map<number, { fn: () => void; ms: number }>();
	const timers: FrameTimers = {
		requestAnimationFrame: (fn) => {
			rafs.set(++id, fn);
			return id;
		},
		cancelAnimationFrame: (h) => void rafs.delete(h),
		setTimeout: (fn, ms) => {
			timeouts.set(++id, { fn, ms });
			return id;
		},
		clearTimeout: (h) => void timeouts.delete(h),
	};
	return {
		timers,
		rafs,
		timeouts,
		frame() {
			for (const [h, fn] of [...rafs]) {
				rafs.delete(h);
				fn();
			}
		},
		fireTimeouts() {
			for (const [h, t] of [...timeouts]) {
				timeouts.delete(h);
				t.fn();
			}
		},
	};
}

describe("createFrameCoalescer", () => {
	it("many requests before a frame draw once", () => {
		const f = fakeTimers();
		const draw = vi.fn();
		const c = createFrameCoalescer(draw, 100, f.timers);
		for (let i = 0; i < 50; i++) c.request();
		expect(draw).not.toHaveBeenCalled();
		expect(f.rafs.size).toBe(1);
		f.frame();
		expect(draw).toHaveBeenCalledTimes(1);
		expect(c.pending).toBe(false);
		expect(f.timeouts.size).toBe(0); // the fallback timer was cancelled
	});

	it("a request after a frame schedules a new draw", () => {
		const f = fakeTimers();
		const draw = vi.fn();
		const c = createFrameCoalescer(draw, 100, f.timers);
		c.request();
		f.frame();
		c.request();
		f.frame();
		expect(draw).toHaveBeenCalledTimes(2);
	});

	it("the fallback timer draws when rAF never fires, and only once", () => {
		const f = fakeTimers();
		const draw = vi.fn();
		const c = createFrameCoalescer(draw, 250, f.timers);
		c.request();
		expect([...f.timeouts.values()][0].ms).toBe(250);
		f.fireTimeouts();
		expect(draw).toHaveBeenCalledTimes(1);
		expect(f.rafs.size).toBe(0);
		f.frame();
		expect(draw).toHaveBeenCalledTimes(1);
	});

	it("flush draws synchronously when pending and then leaves nothing scheduled", () => {
		const f = fakeTimers();
		const draw = vi.fn();
		const c = createFrameCoalescer(draw, 100, f.timers);
		expect(c.flush()).toBe(false);
		c.request();
		expect(c.flush()).toBe(true);
		expect(draw).toHaveBeenCalledTimes(1);
		expect(f.rafs.size + f.timeouts.size).toBe(0);
		expect(c.flush()).toBe(false);
	});

	it("cancel drops the pending draw", () => {
		const f = fakeTimers();
		const draw = vi.fn();
		const c = createFrameCoalescer(draw, 100, f.timers);
		c.request();
		c.cancel();
		f.frame();
		f.fireTimeouts();
		expect(draw).not.toHaveBeenCalled();
		expect(c.pending).toBe(false);
	});

	it("a request made from inside draw schedules the next frame", () => {
		const f = fakeTimers();
		let n = 0;
		const c: ReturnType<typeof createFrameCoalescer> = createFrameCoalescer(
			() => {
				if (++n < 2) c.request();
			},
			100,
			f.timers,
		);
		c.request();
		f.frame();
		expect(n).toBe(1);
		f.frame();
		expect(n).toBe(2);
	});
});
