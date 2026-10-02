// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Cancellation helpers shared by the core modules (no luma runtime imports).

/** True for a cancel (an AbortSignal's reason, a DOMException "AbortError"), false for a real failure. */
export function isAbortError(e: unknown): boolean {
	return (
		typeof e === "object" &&
		e !== null &&
		(e as { name?: unknown }).name === "AbortError"
	);
}

/**
 * `p`, but rejecting with `signal.reason` as soon as `signal` aborts (at once if it already has).
 * `p` itself keeps running and its eventual outcome is swallowed, so the work behind it must clean
 * up by itself (readback slots are given back when their map settles).
 */
export function abortable<T>(
	p: Promise<T>,
	signal: AbortSignal | undefined,
): Promise<T> {
	if (!signal) return p;
	if (signal.aborted) {
		p.catch(() => {});
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		p.then(resolve, reject).finally(() =>
			signal.removeEventListener("abort", onAbort),
		);
	});
}
