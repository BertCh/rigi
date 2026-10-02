// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Forwards a worker realm's model-download status to the page's progress store (one store per realm,
// see progress.ts). In the worker: forwardModelDownloads(post) subscribes to the worker's store and
// posts the changed entries, at most one "downloading" update per file every `intervalMs` (a trailing
// update is always sent) and every state transition at once. On the page: receiveModelDownloads on
// each message.

import {
	type ModelDownload,
	modelDownloads,
	reportModelDownload,
	subscribeModelDownloads,
} from "./progress";

export type ForwardOptions = {
	/** Minimum gap between two "downloading" updates of one file. */
	intervalMs?: number;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
};

/** Calls `post` with the entries that changed; returns the unsubscribe function. */
export function forwardModelDownloads(
	post: (entries: ModelDownload[]) => void,
	options: ForwardOptions = {},
): () => void {
	const intervalMs = options.intervalMs ?? 100;
	const now = options.now ?? (() => performance.now());
	const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer =
		options.clearTimer ??
		((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
	const sent = new Map<string, { entry: ModelDownload; at: number }>();
	const held = new Map<string, ModelDownload>();
	let timer: unknown;

	const flushHeld = () => {
		timer = undefined;
		if (held.size === 0) return;
		const batch = [...held.values()];
		held.clear();
		const at = now();
		for (const e of batch) sent.set(e.file, { entry: e, at });
		post(batch);
	};

	const onChange = () => {
		const at = now();
		const batch: ModelDownload[] = [];
		let wait = Number.POSITIVE_INFINITY;
		for (const entry of modelDownloads()) {
			const last = sent.get(entry.file);
			if (last?.entry === entry) continue;
			if (
				!last ||
				last.entry.state !== entry.state ||
				at - last.at >= intervalMs
			) {
				held.delete(entry.file);
				sent.set(entry.file, { entry, at });
				batch.push(entry);
			} else {
				held.set(entry.file, entry);
				wait = Math.min(wait, intervalMs - (at - last.at));
			}
		}
		if (batch.length) post(batch);
		if (held.size > 0 && timer === undefined && wait < Number.POSITIVE_INFINITY)
			timer = setTimer(flushHeld, wait);
	};

	const unsubscribe = subscribeModelDownloads(onChange);
	onChange();
	return () => {
		unsubscribe();
		if (timer !== undefined) clearTimer(timer);
		timer = undefined;
		held.clear();
	};
}

/** Page side: records entries a worker forwarded. */
export function receiveModelDownloads(entries: readonly ModelDownload[]): void {
	for (const e of entries) reportModelDownload(e);
}
