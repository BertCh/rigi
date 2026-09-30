// Fenced asynchronous GPU→CPU readback for the three.js engine (workstream "three-readback",
// 2026-09-30). WebGLRenderer.readRenderTargetPixels is a bare gl.readPixels into client memory: the
// main thread blocks until every queued GPU command has drained (12.6 MB RGBA32F for the geometry
// buffer). three r186's readRenderTargetPixelsAsync issues the same readPixels into a STREAM_READ
// PIXEL_PACK_BUFFER, fenceSync + flush, polls the fence (clientWaitSync timeout 0, every 4 ms) and
// only then getBufferSubData's the bytes — the pattern src/lib/deck/geometry-pass.ts hand-rolls for
// luma. It accepts FloatType targets (capabilities.textureTypeReadable: UnsignedByte and Float always
// pass), and readPixels takes the target's own format/type either way, so the bytes are the ones the
// sync call returns (engine.readbackParity() checks this at runtime).
//
// Ordering: three's function is `async`, so everything up to its first await — binding the target
// and the readPixels into the pack buffer — runs synchronously inside the call. The copy is queued
// in GL command order: re-rendering the same target right after the call does not change what that
// read returns. The silhouette re-rank relies on this to pipeline its renders.
import type * as THREE from "three";

type Pixels = Float32Array | Uint8Array | Uint16Array;

type AsyncReader = (
	rt: THREE.WebGLRenderTarget,
	x: number,
	y: number,
	w: number,
	h: number,
	buf: Pixels,
) => Promise<Pixels | undefined>;

/** Whether this renderer has three's fenced async readback (r163+). */
export function hasAsyncReadback(renderer: THREE.WebGLRenderer) {
	return (
		typeof (renderer as { readRenderTargetPixelsAsync?: unknown })
			.readRenderTargetPixelsAsync === "function"
	);
}

/**
 * Read `rt` (default: all of it) into `buf` without stalling the main thread. The readPixels is
 * queued before this returns; the promise resolves with `buf` filled once the GPU fence signals.
 * Falls back to the synchronous read (resolved) when the renderer lacks the async path.
 */
export async function readTargetAsync<T extends Pixels>(
	renderer: THREE.WebGLRenderer,
	rt: THREE.WebGLRenderTarget,
	buf: T,
	x = 0,
	y = 0,
	w = rt.width,
	h = rt.height,
): Promise<T> {
	if (!hasAsyncReadback(renderer)) {
		renderer.readRenderTargetPixels(rt, x, y, w, h, buf);
		return buf;
	}
	const read = (
		renderer as unknown as { readRenderTargetPixelsAsync: AsyncReader }
	).readRenderTargetPixelsAsync.bind(renderer);
	await read(rt, x, y, w, h, buf);
	return buf;
}

/** The synchronous read (export paths, tests, the parity check). */
export function readTargetSync<T extends Pixels>(
	renderer: THREE.WebGLRenderer,
	rt: THREE.WebGLRenderTarget,
	buf: T,
	x = 0,
	y = 0,
	w = rt.width,
	h = rt.height,
): T {
	renderer.readRenderTargetPixels(rt, x, y, w, h, buf);
	return buf;
}

/** Byte equality of two pixel buffers (NaN payloads and -0 included), and the first differing byte. */
export function sameBytes(a: Pixels, b: Pixels) {
	const A = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
	const B = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
	if (A.length !== B.length) return { equal: false, firstDiff: -1 };
	for (let i = 0; i < A.length; i++)
		if (A[i] !== B[i]) return { equal: false, firstDiff: i };
	return { equal: true, firstDiff: -1 };
}
