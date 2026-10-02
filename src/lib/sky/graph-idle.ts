// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Idle releaser for the sky worker's cached compute graphs: `release` runs once `ms` after the last
 * request ended, never while one is in flight. begin()/end() bracket a request (begin also cancels a
 * pending release, so a touch inside the window postpones it); a release that fails is ignored (the
 * graphs rebuild on the next use). Timers are injectable for the node check.
 */
export type IdleTimers = {
	setTimeout: (fn: () => void, ms: number) => unknown;
	clearTimeout: (handle: unknown) => void;
};

export type IdleRelease = {
	/** A request started: cancel the pending release and hold it back until end(). */
	begin(): void;
	/** A request finished: once none are in flight, arm the release. */
	end(): void;
	/** Drop the pending release (worker teardown). */
	cancel(): void;
};

export function createIdleRelease(
	ms: number,
	release: () => Promise<void>,
	timers: IdleTimers = {
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (h) => clearTimeout(h as number),
	},
): IdleRelease {
	let inFlight = 0;
	let handle: unknown;
	const cancel = () => {
		if (handle !== undefined) timers.clearTimeout(handle);
		handle = undefined;
	};
	return {
		begin() {
			inFlight++;
			cancel();
		},
		end() {
			inFlight = Math.max(0, inFlight - 1);
			if (inFlight > 0) return;
			cancel();
			handle = timers.setTimeout(() => {
				handle = undefined;
				if (inFlight === 0) release().catch(() => {});
			}, ms);
		},
		cancel,
	};
}
