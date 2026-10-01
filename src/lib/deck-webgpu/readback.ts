// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// CPU readback of the geometry targets (queries, align, harnesses). WebGPU copies need 256-byte
// row alignment; rgba32float rows (16 B/px) are aligned whenever width % 16 == 0 (1024, 384 are).
// Rows come back TOP-first (image order) — the WebGL path's GeometryTarget.read is bottom-first.
import type { Buffer, Device, Texture } from "@luma.gl/core";
import type { GeometryTargets } from "./targets";

const MAP_READ = 0x0001;
const COPY_DST = 0x0008;

/** Reusable staging buffer per texture size. */
export class TextureReader {
	private buf: Buffer | null = null;
	private busy = false;

	constructor(readonly device: Device) {}

	/**
	 * Read `tex` (rgba32float or r32float, full mip 0) into a tightly packed Float32Array.
	 * Returns null if a previous read is still in flight (callers drop the frame, as the WebGL
	 * geometry source does) or the device was lost.
	 */
	async read(tex: Texture): Promise<Float32Array | null> {
		if (this.busy) return null;
		this.busy = true;
		try {
			const layout = tex.computeMemoryLayout();
			const bytes = layout.byteLength;
			if (!this.buf || this.buf.byteLength < bytes) {
				this.buf?.destroy();
				this.buf = this.device.createBuffer({
					id: "rigi-readback",
					byteLength: bytes,
					usage: MAP_READ | COPY_DST,
				});
			}
			tex.readBuffer({}, this.buf);
			const data = await this.buf.readAsync(0, bytes);
			const comps =
				tex.format === "rgba32float" ? 4 : tex.format === "r32float" ? 1 : 0;
			if (!comps)
				throw new Error(`TextureReader: unsupported format ${tex.format}`);
			const rowFloats = tex.width * comps;
			const out = new Float32Array(rowFloats * tex.height);
			const src = new Float32Array(data.buffer, data.byteOffset, bytes / 4);
			const stride = layout.bytesPerRow / 4;
			for (let y = 0; y < tex.height; y++)
				out.set(
					src.subarray(y * stride, y * stride + rowFloats),
					y * rowFloats,
				);
			return out;
		} catch (e) {
			console.warn("[deck-webgpu] readback failed", e);
			return null;
		} finally {
			this.busy = false;
		}
	}

	destroy() {
		this.buf?.destroy();
		this.buf = null;
	}
}

/** Range channel (w) of a geometry read, top-first: range[y * width + x], 0 = sky. */
export function rangeOf(xyzr: Float32Array) {
	const n = xyzr.length / 4;
	const r = new Float32Array(n);
	for (let i = 0; i < n; i++) r[i] = xyzr[i * 4 + 3];
	return r;
}

export async function readGeometry(reader: TextureReader, g: GeometryTargets) {
	const data = await reader.read(g.geometry);
	return data && { width: g.width, height: g.height, xyzr: data };
}
