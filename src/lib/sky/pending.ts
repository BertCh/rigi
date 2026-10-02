// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The page's table of sky-worker requests awaiting a reply, with a stall watchdog. The worker runs
 * requests one at a time (serial-queue.ts), so a deep queue is normal and a per-request deadline
 * would fire on healthy work. Instead the watchdog measures time since the worker last made
 * progress: while any request is pending and no reply (for any id) arrives for `stallMs(heard)`,
 * `onStall` runs. `heard` is false until the worker's first reply, so the cold start (worker
 * module, the 28 MB ORT wasm, the model download) gets a longer allowance. A timer that fires long
 * after its allowance (the page was suspended) re-arms instead of stalling. Timers and the clock
 * are injectable for the spec, as in graph-idle.ts.
 */
import type { IdleTimers } from "./graph-idle";

export type PendingRequests<T> = {
	/** Register a request; arms the watchdog if it is the only one. */
	add(
		id: number,
		resolve: (value: T) => void,
		reject: (error: unknown) => void,
	): void;
	/** A reply arrived: resolves the request and restarts the watchdog (an unknown id is ignored). */
	resolve(id: number, value: T): void;
	/** Forget a request without settling it (its post failed and the caller settles it). */
	remove(id: number): void;
	/** Reject every pending request and stop the watchdog (the worker is being replaced). */
	rejectAll(error: unknown): void;
	readonly size: number;
};

export function createPendingRequests<T>(
	stallMs: (heard: boolean) => number,
	onStall: () => void,
	timers: IdleTimers = {
		setTimeout: (fn, ms) => setTimeout(fn, ms),
		clearTimeout: (h) => clearTimeout(h as number),
	},
	now: () => number = () => Date.now(),
): PendingRequests<T> {
	const pending = new Map<
		number,
		{ resolve: (value: T) => void; reject: (error: unknown) => void }
	>();
	let heard = false;
	let handle: unknown;
	const stop = () => {
		if (handle !== undefined) timers.clearTimeout(handle);
		handle = undefined;
	};
	const arm = () => {
		stop();
		if (!pending.size) return;
		const ms = stallMs(heard);
		const armedAt = now();
		handle = timers.setTimeout(() => {
			handle = undefined;
			if (!pending.size) return;
			// far more wall time than the allowance: the page was suspended (sleep, frozen tab) and the
			// worker's reply may be queued right behind this timer, so give it one more allowance
			if (now() - armedAt > 2 * ms) arm();
			else onStall();
		}, ms);
	};
	return {
		add(id, resolve, reject) {
			pending.set(id, { resolve, reject });
			if (handle === undefined) arm();
		},
		resolve(id, value) {
			const p = pending.get(id);
			if (!p) return;
			heard = true;
			pending.delete(id);
			arm();
			p.resolve(value);
		},
		remove(id) {
			pending.delete(id);
			if (!pending.size) stop();
		},
		rejectAll(error) {
			stop();
			// the worker is gone: its replacement starts cold again
			heard = false;
			const all = [...pending.values()];
			pending.clear();
			for (const p of all) p.reject(error);
		},
		get size() {
			return pending.size;
		},
	};
}
