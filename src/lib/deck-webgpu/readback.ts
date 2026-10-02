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

/**
 * Mip 0 of `tex` through the MAP_READ staging buffer `buf` (at least computeMemoryLayout().byteLength,
 * COPY_DST): the rows' 256-byte alignment padding dropped, tightly packed, top-first. The one place
 * the three readers (TextureReader, readTextureBytes: engine.ts readTexture, compute-bridge.ts
 * readRgba8) do the copy, the map and the row strip. The render that fills `tex` must be submitted
 * first (the copy is its own submit).
 */
async function copyTextureRows(
	tex: Texture,
	buf: Buffer,
	bytesPerPixel: number,
): Promise<Uint8Array> {
	const layout = tex.computeMemoryLayout();
	tex.readBuffer({}, buf);
	const data = await buf.readAsync(0, layout.byteLength);
	const row = tex.width * bytesPerPixel;
	const out = new Uint8Array(row * tex.height);
	for (let y = 0; y < tex.height; y++)
		out.set(
			data.subarray(y * layout.bytesPerRow, y * layout.bytesPerRow + row),
			y * row,
		);
	return out;
}

const createStaging = (device: Device, id: string, bytes: number) =>
	device.createBuffer({ id, byteLength: bytes, usage: MAP_READ | COPY_DST });

/** Idle staging buffers per device for readTextureBytes (kept warm, at most IDLE_STAGING). */
const IDLE_STAGING = 2;
const idleStaging = new WeakMap<Device, Buffer[]>();

/**
 * A whole mip-0 texture as tightly packed bytes (top-first), for the one-off readers (offscreen
 * renders, look bridge). Concurrent calls are fine (each takes its own staging buffer from a small
 * per-device idle list, or creates one). Rejects when the copy or the map fails.
 */
export async function readTextureBytes(
	device: Device,
	tex: Texture,
	bytesPerPixel: number,
): Promise<Uint8Array> {
	const bytes = tex.computeMemoryLayout().byteLength;
	const idle = idleStaging.get(device) ?? [];
	idleStaging.set(device, idle);
	const k = idle.findIndex((b) => b.byteLength >= bytes);
	const buf =
		k >= 0
			? idle.splice(k, 1)[0]
			: createStaging(device, "rigi-readback-once", bytes);
	let ok = false;
	try {
		const out = await copyTextureRows(tex, buf, bytesPerPixel);
		ok = true;
		return out;
	} finally {
		if (ok && idle.length < IDLE_STAGING) idle.push(buf);
		else buf.destroy();
	}
}

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
			const bytes = tex.computeMemoryLayout().byteLength;
			if (!this.buf || this.buf.byteLength < bytes) {
				this.buf?.destroy();
				this.buf = createStaging(this.device, "rigi-readback", bytes);
			}
			const comps =
				tex.format === "rgba32float" ? 4 : tex.format === "r32float" ? 1 : 0;
			if (!comps)
				throw new Error(`TextureReader: unsupported format ${tex.format}`);
			const out = await copyTextureRows(tex, this.buf, comps * 4);
			return new Float32Array(out.buffer, 0, out.byteLength / 4);
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
