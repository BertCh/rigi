// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One draw per animation frame for DeckHost.requestRender (CR-40): any number of requests between two
// frames share one draw. A fallback timer draws anyway when rAF does not fire (hidden tab), so a
// nextFrame() waiter is never stranded. Timers are injectable for the specs.

export type FrameTimers = {
	requestAnimationFrame: (fn: () => void) => number;
	cancelAnimationFrame: (h: number) => void;
	setTimeout: (fn: () => void, ms: number) => number;
	clearTimeout: (h: number) => void;
};

export type FrameCoalescer = {
	/** Ask for a draw at the next frame (no-op when one is already pending). */
	request(): void;
	/** Draw now if one is pending (synchronous path: export, readback); false if nothing was pending. */
	flush(): boolean;
	/** Drop the pending draw (teardown). */
	cancel(): void;
	readonly pending: boolean;
};

const BROWSER_TIMERS: FrameTimers = {
	requestAnimationFrame: (fn) => requestAnimationFrame(fn),
	cancelAnimationFrame: (h) => cancelAnimationFrame(h),
	setTimeout: (fn, ms) => window.setTimeout(fn, ms),
	clearTimeout: (h) => window.clearTimeout(h),
};

export function createFrameCoalescer(
	draw: () => void,
	fallbackMs = 100,
	timers: FrameTimers = BROWSER_TIMERS,
): FrameCoalescer {
	let raf = 0;
	let timer = 0;
	let pending = false;
	const clear = () => {
		if (raf) timers.cancelAnimationFrame(raf);
		if (timer) timers.clearTimeout(timer);
		raf = 0;
		timer = 0;
		pending = false;
	};
	const run = () => {
		if (!pending) return;
		clear();
		draw();
	};
	return {
		request() {
			if (pending) return;
			pending = true;
			raf = timers.requestAnimationFrame(run);
			timer = timers.setTimeout(run, fallbackMs);
		},
		flush() {
			if (!pending) return false;
			run();
			return true;
		},
		cancel: clear,
		get pending() {
			return pending;
		},
	};
}
