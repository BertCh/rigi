// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Weight bytes for nn.loadWeights. Until src/lib/models (unit L5: Cache Storage, manifest, progress)
// lands, this is a minimal stand-in with the same signature: node reads public/models/<file>, the
// browser fetches `${BASE_URL}models/<file>`. Swap the body for `export { fetchModel } from
// "#/lib/models"` when it exists.

export type FetchModelOptions = {
	signal?: AbortSignal;
	onProgress?: (loaded: number, total: number) => void;
};

let override:
	| ((file: string, o?: FetchModelOptions) => Promise<ArrayBuffer>)
	| null = null;

/** Tests / harnesses: replace the byte source (null restores the default). */
export function setModelFetcher(
	f: ((file: string, o?: FetchModelOptions) => Promise<ArrayBuffer>) | null,
) {
	override = f;
}

const isNode = () =>
	typeof process !== "undefined" &&
	!!(process as { versions?: { node?: string } }).versions?.node &&
	typeof (globalThis as { window?: unknown }).window === "undefined";

export async function fetchModel(
	file: string,
	o: FetchModelOptions = {},
): Promise<ArrayBuffer> {
	if (override) return override(file, o);
	if (isNode()) {
		const fs = await import(/* @vite-ignore */ "node:fs/promises");
		const path = await import(/* @vite-ignore */ "node:path");
		const b = await fs.readFile(path.resolve("public/models", file));
		return b.buffer.slice(
			b.byteOffset,
			b.byteOffset + b.byteLength,
		) as ArrayBuffer;
	}
	const base =
		(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
	const res = await fetch(`${base}models/${file}`, { signal: o.signal });
	if (!res.ok) throw new Error(`nn: ${file}: HTTP ${res.status}`);
	const total = Number(res.headers.get("content-length")) || 0;
	if (!o.onProgress || !res.body) return res.arrayBuffer();
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let loaded = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		loaded += value.byteLength;
		o.onProgress(loaded, total);
	}
	const out = new Uint8Array(loaded);
	let p = 0;
	for (const c of chunks) {
		out.set(c, p);
		p += c.byteLength;
	}
	return out.buffer;
}
