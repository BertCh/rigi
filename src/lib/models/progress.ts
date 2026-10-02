// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// UI-agnostic status of model downloads (fetchModel reports into it). One store per realm: a worker's
// downloads are visible in that worker only, so a worker that wants the page to show them forwards
// the snapshot in its own messages. React reads it with
// useSyncExternalStore(subscribeModelDownloads, modelDownloads).

export type ModelDownloadState = "downloading" | "cached" | "done" | "error";

export type ModelDownload = {
	file: string;
	state: ModelDownloadState;
	/** Bytes received so far (the full size once cached / done). */
	loaded: number;
	/** Expected bytes (Content-Length or the manifest size); 0 when unknown. */
	total: number;
	error?: string;
};

type Listener = () => void;

const entries = new Map<string, ModelDownload>();
const listeners = new Set<Listener>();
let snapshot: readonly ModelDownload[] = [];

/** The current downloads (a new array after every change; stable between changes). */
export function modelDownloads(): readonly ModelDownload[] {
	return snapshot;
}

/** Calls `listener` after every change; returns the unsubscribe function. */
export function subscribeModelDownloads(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Records a download's status (fetchModel calls this; other loaders may too). */
export function reportModelDownload(entry: ModelDownload): void {
	entries.set(entry.file, entry);
	snapshot = [...entries.values()];
	for (const l of listeners) l();
}

/** Forgets every entry (tests, or a page that dismissed the list). */
export function clearModelDownloads(): void {
	entries.clear();
	snapshot = [];
	for (const l of listeners) l();
}

/** "34 MB", "820 kB", "512 B" (decimal units, like download dialogs). */
export function formatBytes(bytes: number): string {
	if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`;
	if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} kB`;
	return `${bytes} B`;
}

/** A one-line status, e.g. "downloading model 34 MB (12%)". */
export function describeModelDownload(d: ModelDownload): string {
	switch (d.state) {
		case "downloading": {
			const size = formatBytes(d.total || d.loaded);
			const pct = d.total
				? ` (${Math.floor((100 * d.loaded) / d.total)}%)`
				: "";
			return `downloading model ${size}${pct}`;
		}
		case "cached":
			return `model ${formatBytes(d.loaded)} (cached)`;
		case "done":
			return `model ${formatBytes(d.loaded)} ready`;
		case "error":
			return `model download failed${d.error ? `: ${d.error}` : ""}`;
	}
}
