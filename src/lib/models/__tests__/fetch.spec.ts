// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// fetchModel: naming, hash verification, Cache Storage first then a streamed download, node disk path.
import { createHash, webcrypto } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MANIFEST from "../../../../scripts/models/manifest.json";
import {
	createModelFetcher,
	type DownloadDeps,
	downloadModel,
	fetchModel,
	filenameHash,
	MODEL_CACHE,
	modelEntry,
	modelFileName,
	modelUrl,
	verifyModel,
} from "../fetch";
import { clearModelDownloads, modelDownloads } from "../progress";

const subtle = webcrypto.subtle as unknown as SubtleCrypto;

/** Bytes whose sha256 starts with the 8-hex prefix of the returned filename. */
function hashedFile(base: string, size = 1000) {
	const bytes = new Uint8Array(size);
	for (let i = 0; i < size; i++) bytes[i] = (i * 31 + 7) & 255;
	const sha = createHash("sha256").update(bytes).digest("hex");
	return { bytes, file: `${base}.${sha.slice(0, 8)}.bin`, sha };
}

class FakeCache {
	store = new Map<string, Response>();
	async match(url: string) {
		return this.store.get(url)?.clone();
	}
	async put(url: string, res: Response) {
		this.store.set(url, res);
	}
}

function fakeCaches(cache = new FakeCache()) {
	const opened: string[] = [];
	return {
		cache,
		opened,
		caches: {
			open: async (name: string) => {
				opened.push(name);
				return cache;
			},
		} as unknown as CacheStorage,
	};
}

/** A Response streaming `bytes` in `chunks` pieces. */
function streamed(bytes: Uint8Array, chunks = 4, length = true) {
	const step = Math.ceil(bytes.length / chunks);
	const body = new ReadableStream<Uint8Array>({
		start(c) {
			for (let o = 0; o < bytes.length; o += step)
				c.enqueue(bytes.slice(o, o + step));
			c.close();
		},
	});
	return new Response(body, {
		headers: length ? { "content-length": String(bytes.length) } : {},
	});
}

beforeEach(() => clearModelDownloads());

describe("names and URLs", () => {
	it("accepts bare, models/ and /models/ names", () => {
		for (const f of ["a.onnx", "models/a.onnx", "/models/a.onnx"])
			expect(modelFileName(f)).toBe("a.onnx");
		expect(modelUrl("models/a.onnx")).toBe("/models/a.onnx");
	});

	it("reads the 8-hex hash from a content-hashed name", () => {
		expect(filenameHash("skyseg-u2netp.873ea284.onnx")).toBe("873ea284");
		expect(filenameHash("plain.onnx")).toBeUndefined();
	});

	it("manifest rows are well formed and name their hash", () => {
		const files = new Set<string>();
		for (const row of MANIFEST as Record<string, unknown>[]) {
			for (const k of ["file", "sha256", "licence", "source", "producer"])
				expect(typeof row[k], `${row.file}.${k}`).toBe("string");
			expect(Number.isInteger(row.bytes) && (row.bytes as number) > 0).toBe(
				true,
			);
			const file = row.file as string;
			expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect((row.sha256 as string).startsWith(filenameHash(file) ?? "?")).toBe(
				true,
			);
			expect(files.has(file)).toBe(false);
			files.add(file);
		}
		expect(modelEntry("models/skyseg-u2netp.873ea284.onnx")?.licence).toBe(
			"MIT",
		);
	});
});

describe("verifyModel", () => {
	it("passes matching bytes and rejects others", async () => {
		const { bytes, file } = hashedFile("m");
		await verifyModel(file, bytes.buffer, subtle);
		await expect(
			verifyModel(file, new Uint8Array(3).buffer, subtle),
		).rejects.toThrow(/does not match/);
	});

	it("skips names without a hash or a manifest row", async () => {
		await verifyModel("plain.bin", new Uint8Array(3).buffer, subtle);
	});
});

describe("downloadModel", () => {
	const deps = (over: Partial<DownloadDeps>): DownloadDeps => ({
		fetch: vi.fn(),
		subtle,
		origin: "https://rigi.test/app/page",
		...over,
	});

	it("streams with progress, verifies, caches, then serves from the cache", async () => {
		const { bytes, file } = hashedFile("net", 5000);
		const { caches, cache, opened } = fakeCaches();
		const fetch = vi.fn(async () => streamed(bytes));
		const progress: [number, number][] = [];
		const buf = await downloadModel(
			file,
			deps({ fetch: fetch as unknown as typeof globalThis.fetch, caches }),
			{ onProgress: (l, t) => progress.push([l, t]) },
		);
		expect(new Uint8Array(buf)).toEqual(bytes);
		expect(fetch).toHaveBeenCalledWith(
			`https://rigi.test/models/${file}`,
			expect.anything(),
		);
		expect(opened[0]).toBe(MODEL_CACHE);
		expect(progress[0]).toEqual([0, 5000]);
		expect(progress.at(-1)).toEqual([5000, 5000]);
		expect(progress.length).toBeGreaterThan(2);
		expect(cache.store.has(`https://rigi.test/models/${file}`)).toBe(true);
		expect(modelDownloads().find((d) => d.file === file)?.state).toBe("done");

		const again = await downloadModel(
			file,
			deps({ fetch: fetch as unknown as typeof globalThis.fetch, caches }),
		);
		expect(new Uint8Array(again)).toEqual(bytes);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(modelDownloads().find((d) => d.file === file)?.state).toBe("cached");
	});

	it("does not cache bytes that fail verification", async () => {
		const { file } = hashedFile("bad");
		const { caches, cache } = fakeCaches();
		const fetch = async () => streamed(new Uint8Array(10));
		await expect(
			downloadModel(
				file,
				deps({ fetch: fetch as unknown as typeof globalThis.fetch, caches }),
			),
		).rejects.toThrow(/does not match/);
		expect(cache.store.size).toBe(0);
		expect(modelDownloads().find((d) => d.file === file)?.state).toBe("error");
	});

	it("works without Cache Storage and without Content-Length, and reports HTTP errors", async () => {
		const { bytes, file } = hashedFile("nocache", 333);
		const progress: [number, number][] = [];
		const buf = await downloadModel(
			file,
			deps({
				fetch: (async () =>
					streamed(bytes, 3, false)) as unknown as typeof globalThis.fetch,
			}),
			{ onProgress: (l, t) => progress.push([l, t]) },
		);
		expect(new Uint8Array(buf)).toEqual(bytes);
		expect(progress.at(-1)).toEqual([333, 0]);
		await expect(
			downloadModel(
				file,
				deps({
					fetch: (async () =>
						new Response("", {
							status: 404,
						})) as unknown as typeof globalThis.fetch,
				}),
			),
		).rejects.toThrow(/HTTP 404/);
	});

	it("grows its buffer for a large body of unknown size", async () => {
		const { bytes, file } = hashedFile("big", 3_100_000);
		const buf = await downloadModel(
			file,
			deps({
				fetch: (async () =>
					streamed(bytes, 50, false)) as unknown as typeof globalThis.fetch,
			}),
		);
		expect(buf.byteLength).toBe(bytes.length);
		expect(new Uint8Array(buf)).toEqual(bytes);
	});

	it("survives a cache that cannot be opened", async () => {
		const { bytes, file } = hashedFile("brokencache", 64);
		const caches = {
			open: async () => {
				throw new Error("SecurityError");
			},
		} as unknown as CacheStorage;
		const buf = await downloadModel(
			file,
			deps({
				fetch: (async () =>
					streamed(bytes)) as unknown as typeof globalThis.fetch,
				caches,
			}),
		);
		expect(buf.byteLength).toBe(64);
	});
});

describe("fetchModel in node", () => {
	it("reads public/models from $RIGI_MODELS_DIR", async () => {
		const dir = mkdtempSync(join(tmpdir(), "rigi-models-"));
		writeFileSync(join(dir, "x.bin"), new Uint8Array([1, 2, 3]));
		vi.stubEnv("RIGI_MODELS_DIR", dir);
		const buf = await fetchModel("models/x.bin");
		expect([...new Uint8Array(buf)]).toEqual([1, 2, 3]);
		await expect(fetchModel("missing.bin")).rejects.toThrow();
	});
});

describe("createModelFetcher abort refcount", () => {
	/** A body that never finishes: the test pushes chunks and watches for cancel. */
	function controllable() {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				controller = c;
			},
			cancel() {
				cancelled = true;
			},
		});
		return {
			response: () =>
				new Response(body, { headers: { "content-length": "1000" } }),
			push: (n: number) => controller.enqueue(new Uint8Array(n)),
			get cancelled() {
				return cancelled;
			},
		};
	}
	const tick = () => new Promise((r) => setTimeout(r, 5));

	function setup() {
		const { file } = hashedFile("abortable");
		const { caches, cache } = fakeCaches();
		const bodies: ReturnType<typeof controllable>[] = [];
		const fetch = vi.fn(async () => {
			const b = controllable();
			bodies.push(b);
			return b.response();
		});
		const fetcher = createModelFetcher({
			fetch: fetch as unknown as typeof globalThis.fetch,
			caches,
			subtle,
			origin: "https://rigi.test/",
		});
		return { file, cache, bodies, fetch, fetcher };
	}

	it("keeps downloading while one waiter without a signal remains", async () => {
		const { file, bodies, fetch, fetcher } = setup();
		const a = new AbortController();
		const withSignal = fetcher(file, { signal: a.signal });
		const without = fetcher(file);
		withSignal.catch(() => {});
		await tick();
		a.abort(new Error("gone"));
		await expect(withSignal).rejects.toThrow("gone");
		await tick();
		expect(bodies[0].cancelled).toBe(false);
		expect(fetch).toHaveBeenCalledTimes(1);
		void without.catch(() => {});
	});

	it("aborts the shared fetch when every waiter aborted, caches nothing and starts fresh next time", async () => {
		const { file, cache, bodies, fetch, fetcher } = setup();
		const a = new AbortController();
		const b = new AbortController();
		const p1 = fetcher(file, { signal: a.signal });
		const p2 = fetcher(file, { signal: b.signal });
		p1.catch(() => {});
		p2.catch(() => {});
		await tick();
		bodies[0].push(100);
		await tick();
		expect(modelDownloads().find((d) => d.file === file)?.state).toBe(
			"downloading",
		);
		a.abort();
		await tick();
		expect(bodies[0].cancelled).toBe(false);
		b.abort();
		await expect(p1).rejects.toBeDefined();
		await expect(p2).rejects.toBeDefined();
		await tick();
		expect(bodies[0].cancelled).toBe(true);
		expect(cache.store.size).toBe(0);
		expect(modelDownloads().find((d) => d.file === file)).toBeUndefined();

		const p3 = fetcher(file);
		p3.catch(() => {});
		await tick();
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("a pre-aborted signal never starts a download", async () => {
		const { file, fetch, fetcher } = setup();
		const a = new AbortController();
		a.abort();
		await expect(fetcher(file, { signal: a.signal })).rejects.toBeDefined();
		expect(fetch).not.toHaveBeenCalled();
	});
});
