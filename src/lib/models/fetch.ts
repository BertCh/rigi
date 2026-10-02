// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Model bytes: Cache Storage first, then the network (streamed, with progress, sha256-verified before
// it is cached); in node, public/models on disk. The download core takes its globals as arguments so
// specs can drive it without a browser.

import MANIFEST from "../../../scripts/models/manifest.json";
import { forgetModelDownload, reportModelDownload } from "./progress";

export type ModelEntry = {
	file: string;
	sha256: string;
	bytes: number;
	licence: string;
};

export type FetchModelOptions = {
	signal?: AbortSignal;
	onProgress?: (loaded: number, total: number) => void;
};

/** Cache Storage bucket. Filenames are content-hashed, so entries never go stale. */
export const MODEL_CACHE = "rigi-models-v1";

const entries = new Map<string, ModelEntry>(
	(MANIFEST as ModelEntry[]).map((e) => [e.file, e]),
);

/** "models/x.onnx", "/models/x.onnx" and "x.onnx" all name public/models/x.onnx. */
export function modelFileName(file: string): string {
	return file.replace(/^\/?models\//, "");
}

/** The manifest row of `file` (scripts/models/manifest.json), if it has one. */
export function modelEntry(file: string): ModelEntry | undefined {
	return entries.get(modelFileName(file));
}

/** The 8-hex sha256 prefix carried in a content-hashed filename ("name.<hex8>.ext"). */
export function filenameHash(file: string): string | undefined {
	return /\.([0-9a-f]{8})\.[^./]+$/.exec(modelFileName(file))?.[1];
}

function baseUrl(): string {
	const b = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL;
	return b ? (b.endsWith("/") ? b : `${b}/`) : "/";
}

/** The URL public/models/<file> is served at (honours Vite's base). */
export function modelUrl(file: string): string {
	return `${baseUrl()}models/${modelFileName(file)}`;
}

export const isNodeRuntime = (): boolean =>
	typeof process !== "undefined" &&
	!!process.versions?.node &&
	typeof (globalThis as { document?: unknown }).document === "undefined" &&
	typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope ===
		"undefined";

const hex = (buf: ArrayBuffer) =>
	Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join(
		"",
	);

/** Throws when `bytes` does not match the manifest sha256 (or, without a row, the filename hash). */
export async function verifyModel(
	file: string,
	bytes: ArrayBuffer,
	subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle,
): Promise<void> {
	const want = modelEntry(file)?.sha256 ?? filenameHash(file);
	if (!want || !subtle) return;
	const got = hex(await subtle.digest("SHA-256", bytes));
	if (!got.startsWith(want))
		throw new Error(
			`model ${modelFileName(file)}: sha256 ${got.slice(0, 16)}… does not match ${want.slice(0, 16)}…`,
		);
}

export type DownloadDeps = {
	fetch: typeof fetch;
	/** undefined = no Cache Storage (insecure context, private mode, node). */
	caches?: CacheStorage;
	subtle?: SubtleCrypto;
	/** Absolute base to resolve modelUrl against (location.href in a page or worker). */
	origin: string;
};

async function openCache(deps: DownloadDeps): Promise<Cache | undefined> {
	try {
		return await deps.caches?.open(MODEL_CACHE);
	} catch {
		return undefined;
	}
}

/**
 * Reads the body chunk by chunk into one buffer: preallocated at `total` (Content-Length or the
 * manifest size) so a 100+ MB model is not held twice; grows by doubling when the size is unknown or
 * wrong (a compressed Content-Length).
 */
async function readBody(
	res: Response,
	total: number,
	progress: (loaded: number) => void,
	signal?: AbortSignal,
): Promise<ArrayBuffer> {
	if (!res.body) {
		const buf = await res.arrayBuffer();
		progress(buf.byteLength);
		return buf;
	}
	const reader = res.body.getReader();
	let out = new Uint8Array(total > 0 ? total : 1 << 20);
	let loaded = 0;
	// Cancelling the reader also settles a read that is pending (a real fetch errors the body itself).
	const onAbort = () => void reader.cancel(signal?.reason).catch(() => {});
	signal?.addEventListener("abort", onAbort, { once: true });
	for (;;) {
		signal?.throwIfAborted();
		const { done, value } = await reader.read().catch((e) => {
			signal?.throwIfAborted();
			throw e;
		});
		if (done) {
			signal?.throwIfAborted();
			break;
		}
		if (loaded + value.byteLength > out.byteLength) {
			const grown = new Uint8Array(
				Math.max(out.byteLength * 2, loaded + value.byteLength),
			);
			grown.set(out.subarray(0, loaded));
			out = grown;
		}
		out.set(value, loaded);
		loaded += value.byteLength;
		progress(loaded);
	}
	signal?.removeEventListener("abort", onAbort);
	return loaded === out.byteLength ? out.buffer : out.buffer.slice(0, loaded);
}

/** fetchModel's browser path with explicit globals (exported for specs). */
export async function downloadModel(
	file: string,
	deps: DownloadDeps,
	opts: FetchModelOptions = {},
): Promise<ArrayBuffer> {
	const name = modelFileName(file);
	const url = new URL(modelUrl(name), deps.origin).href;
	const known = modelEntry(name)?.bytes ?? 0;
	const cache = await openCache(deps);
	try {
		const hit = await cache?.match(url);
		if (hit?.ok) {
			const buf = await hit.arrayBuffer();
			opts.onProgress?.(buf.byteLength, buf.byteLength);
			reportModelDownload({
				file: name,
				state: "cached",
				loaded: buf.byteLength,
				total: buf.byteLength,
			});
			return buf;
		}
	} catch {
		// a broken cache entry: download again
	}
	try {
		const res = await deps.fetch(url, { signal: opts.signal });
		if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
		const total = Number(res.headers.get("content-length")) || known;
		const progress = (loaded: number) => {
			opts.onProgress?.(loaded, total);
			reportModelDownload({ file: name, state: "downloading", loaded, total });
		};
		progress(0);
		const buf = await readBody(res, total, progress, opts.signal);
		await verifyModel(name, buf, deps.subtle);
		// Response copies the bytes; a failed put (quota) only costs the next visit a download.
		await cache
			?.put(
				url,
				new Response(buf, {
					headers: {
						"content-type": "application/octet-stream",
						"content-length": String(buf.byteLength),
					},
				}),
			)
			.catch(() => {});
		reportModelDownload({
			file: name,
			state: "done",
			loaded: buf.byteLength,
			total: buf.byteLength,
		});
		return buf;
	} catch (e) {
		if (opts.signal?.aborted) {
			// Every waiter gave up: nothing failed, so the file simply has no download status.
			forgetModelDownload(name);
			throw e;
		}
		reportModelDownload({
			file: name,
			state: "error",
			loaded: 0,
			total: known,
			error: e instanceof Error ? e.message : String(e),
		});
		throw e;
	}
}

/** Node: public/models/<file> under the cwd, or under $RIGI_MODELS_DIR. */
async function readModelFromDisk(file: string): Promise<ArrayBuffer> {
	const fsName = "node:fs/promises";
	const pathName = "node:path";
	const fs = (await import(
		/* @vite-ignore */ fsName
	)) as typeof import("node:fs/promises");
	const path = (await import(
		/* @vite-ignore */ pathName
	)) as typeof import("node:path");
	const dir =
		process.env.RIGI_MODELS_DIR ?? path.join(process.cwd(), "public", "models");
	const b = await fs.readFile(path.join(dir, modelFileName(file)));
	return b.buffer.slice(
		b.byteOffset,
		b.byteOffset + b.byteLength,
	) as ArrayBuffer;
}

type Inflight = {
	promise: Promise<ArrayBuffer>;
	listeners: Set<(loaded: number, total: number) => void>;
	/** Callers still waiting: the last one to resume gets the buffer itself, the others a copy. */
	waiters: number;
	/** Callers that have not aborted; a caller without a signal never leaves this count. */
	live: number;
	abort: AbortController;
};

/**
 * The shared-download layer of fetchModel with explicit globals (exported for specs): concurrent
 * calls for one file share one download that has its own AbortController. A caller whose signal
 * aborts stops waiting at once; when every caller has aborted (a caller without a signal never
 * does) the shared fetch is aborted too: the stream read stops, nothing is cached, the in-flight
 * entry goes away so a later call starts fresh, and the file's progress entry is dropped.
 */
export function createModelFetcher(deps: DownloadDeps) {
	const inflight = new Map<string, Inflight>();
	return async function fetchShared(
		name: string,
		opts: FetchModelOptions = {},
	): Promise<ArrayBuffer> {
		opts.signal?.throwIfAborted();
		let job = inflight.get(name);
		if (!job) {
			const listeners = new Set<(loaded: number, total: number) => void>();
			const abort = new AbortController();
			const promise = downloadModel(name, deps, {
				signal: abort.signal,
				onProgress: (l, t) => {
					for (const f of listeners) f(l, t);
				},
			});
			const created: Inflight = {
				promise,
				listeners,
				waiters: 0,
				live: 0,
				abort,
			};
			job = created;
			inflight.set(name, job);
			const clear = () => {
				if (inflight.get(name) === created) inflight.delete(name);
			};
			promise.then(clear, clear);
		}
		const shared = job;
		const { promise, listeners } = shared;
		shared.waiters++;
		shared.live++;
		let counted = true;
		let left = false;
		const leave = () => {
			if (left) return;
			left = true;
			if (--shared.live === 0) {
				if (inflight.get(name) === shared) inflight.delete(name);
				shared.abort.abort(opts.signal?.reason);
			}
		};
		const onProgress = opts.onProgress;
		if (onProgress) listeners.add(onProgress);
		const signal = opts.signal;
		try {
			const bytes = await (signal
				? new Promise<ArrayBuffer>((resolve, reject) => {
						const onAbort = () => {
							reject(signal.reason);
							leave();
						};
						signal.addEventListener("abort", onAbort, { once: true });
						promise
							.then(resolve, reject)
							.finally(() => signal.removeEventListener("abort", onAbort));
					})
				: promise);
			counted = false;
			return --shared.waiters === 0 ? bytes : bytes.slice(0);
		} finally {
			if (counted) shared.waiters--;
			if (onProgress) listeners.delete(onProgress);
		}
	};
}

let browserFetcher: ReturnType<typeof createModelFetcher> | undefined;

/**
 * The bytes of public/models/<file>. Browser: Cache Storage, else a streamed download (progress via
 * `onProgress` and the progress store), verified against its sha256 before it is cached; concurrent
 * calls for one file share the download (each caller gets its own ArrayBuffer; see
 * createModelFetcher for abort semantics). Node: read from disk.
 */
export async function fetchModel(
	file: string,
	opts: FetchModelOptions = {},
): Promise<ArrayBuffer> {
	const name = modelFileName(file);
	if (isNodeRuntime()) return readModelFromDisk(name);
	browserFetcher ??= createModelFetcher({
		fetch: globalThis.fetch.bind(globalThis),
		caches: (globalThis as { caches?: CacheStorage }).caches,
		subtle: globalThis.crypto?.subtle,
		origin: globalThis.location?.href ?? "http://localhost/",
	});
	return browserFetcher(name, opts);
}
