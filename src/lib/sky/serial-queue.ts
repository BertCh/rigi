// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Strict FIFO of async tasks: one runs at a time, a failing task never stalls the ones behind it.
// The sky worker runs requests AND its idle graph release on one of these, so a release can never
// destroy graphs under a request that arrived while it was awaiting its imports.

export type SerialQueue = {
	/** Run `task` after everything queued so far; resolves/rejects with the task's own result. */
	run<T>(task: () => Promise<T> | T): Promise<T>;
	/** Tasks queued or running. */
	readonly size: number;
};

export function createSerialQueue(): SerialQueue {
	let tail: Promise<unknown> = Promise.resolve();
	let size = 0;
	return {
		run(task) {
			size++;
			const result = tail.then(task);
			tail = result.then(
				() => {
					size--;
				},
				() => {
					size--;
				},
			);
			return result;
		},
		get size() {
			return size;
		},
	};
}
