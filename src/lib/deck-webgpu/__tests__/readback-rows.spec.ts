// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Buffer, Device, Texture } from "@luma.gl/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	packRows,
	rangeOf,
	readGeometry,
	readTextureBytes,
	TextureReader,
} from "../readback";

/** A texture whose rows are padded to `bytesPerRow` (WebGPU's 256-byte copy alignment). */
function fakeTexture(
	width: number,
	height: number,
	bytesPerPixel: number,
	bytesPerRow: number,
	format = "rgba32float",
) {
	const staging = new Uint8Array(bytesPerRow * height);
	// every pixel byte = (y * 31 + x * 7 + b) & 0xff; padding = 0xee
	staging.fill(0xee);
	const expected = new Uint8Array(width * bytesPerPixel * height);
	for (let y = 0; y < height; y++)
		for (let i = 0; i < width * bytesPerPixel; i++) {
			const v = (y * 31 + i * 7) & 0xff;
			staging[y * bytesPerRow + i] = v;
			expected[y * width * bytesPerPixel + i] = v;
		}
	const tex = {
		width,
		height,
		format,
		computeMemoryLayout: () => ({
			byteLength: staging.length,
			bytesPerRow,
		}),
		readBuffer: vi.fn((_opts: unknown, buf: { __fill: Uint8Array }) => {
			buf.__fill = staging;
		}),
	};
	return { tex: tex as unknown as Texture, expected };
}

function fakeDevice() {
	const created: FakeBuffer[] = [];
	const device = {
		createBuffer: vi.fn(
			(p: { id: string; byteLength: number; usage: number }) => {
				const b = new FakeBuffer(p.byteLength, p.usage);
				created.push(b);
				return b as unknown as Buffer;
			},
		),
	};
	return { device: device as unknown as Device, created };
}

class FakeBuffer {
	destroyed = false;
	__fill: Uint8Array = new Uint8Array(0);
	constructor(
		readonly byteLength: number,
		readonly usage: number,
	) {}
	async readAsync(offset: number, length: number) {
		return this.__fill.subarray(offset, offset + length);
	}
	mapAndReadAsync<T>(
		cb: (mapped: ArrayBuffer) => T,
		offset: number,
		length: number,
		options?: { waitForSubmittedWork?: boolean },
	) {
		this.mapOptions = options;
		const bytes = this.__fill.slice(offset, offset + length);
		return Promise.resolve(cb(bytes.buffer));
	}
	mapOptions?: { waitForSubmittedWork?: boolean };
	destroy() {
		this.destroyed = true;
	}
}

afterEach(() => vi.restoreAllMocks());

describe("readTextureBytes", () => {
	it("drops the 256-byte row padding and keeps top-first row order", async () => {
		// 4 px * 4 B = 16 B rows padded to 256
		const { tex, expected } = fakeTexture(4, 3, 4, 256, "rgba8unorm");
		const { device } = fakeDevice();
		const out = await readTextureBytes(device, tex, 4);
		expect(out).toEqual(expected);
	});

	it("returns the data untouched when rows are already aligned", async () => {
		const { tex, expected } = fakeTexture(16, 2, 16, 256);
		const { device } = fakeDevice();
		expect(await readTextureBytes(device, tex, 16)).toEqual(expected);
	});

	it("creates a MAP_READ|COPY_DST staging buffer sized to the layout", async () => {
		const { tex } = fakeTexture(4, 3, 4, 256);
		const { device, created } = fakeDevice();
		await readTextureBytes(device, tex, 4);
		expect(created).toHaveLength(1);
		expect(created[0].byteLength).toBe(256 * 3);
		expect(created[0].usage).toBe(0x0001 | 0x0008);
	});

	it("reuses an idle staging buffer, keeps at most two warm, destroys the rest", async () => {
		const { device, created } = fakeDevice();
		const { tex } = fakeTexture(4, 3, 4, 256);
		await readTextureBytes(device, tex, 4);
		await readTextureBytes(device, tex, 4);
		expect(created).toHaveLength(1);
		// three concurrent reads: one reused, two created; only two go back idle
		await Promise.all([
			readTextureBytes(device, tex, 4),
			readTextureBytes(device, tex, 4),
			readTextureBytes(device, tex, 4),
		]);
		expect(created).toHaveLength(3);
		expect(created.filter((b) => b.destroyed)).toHaveLength(1);
	});

	it("destroys the staging buffer and rejects when the map fails", async () => {
		const { device, created } = fakeDevice();
		const { tex } = fakeTexture(4, 3, 4, 256);
		const boom = new Error("map failed");
		(tex.readBuffer as unknown as ReturnType<typeof vi.fn>).mockImplementation(
			() => {
				throw boom;
			},
		);
		await expect(readTextureBytes(device, tex, 4)).rejects.toBe(boom);
		expect(created[0].destroyed).toBe(true);
	});

	it("does not reuse an idle buffer that is too small", async () => {
		const { device, created } = fakeDevice();
		await readTextureBytes(device, fakeTexture(4, 1, 4, 256).tex, 4);
		await readTextureBytes(device, fakeTexture(4, 4, 4, 256).tex, 4);
		expect(created.map((b) => b.byteLength)).toEqual([256, 1024]);
	});
});

describe("TextureReader", () => {
	it("reads rgba32float as a tight Float32Array", async () => {
		const { device } = fakeDevice();
		const { tex, expected } = fakeTexture(16, 2, 16, 256);
		const out = await new TextureReader(device).read(tex);
		expect(out).toBeInstanceOf(Float32Array);
		expect(out?.length).toBe(16 * 2 * 4);
		if (!out) throw new Error("no readback");
		expect(new Uint8Array(out.buffer, out.byteOffset, out.byteLength)).toEqual(
			expected,
		);
	});

	it("reads r32float as one float per pixel", async () => {
		const { device } = fakeDevice();
		const { tex } = fakeTexture(8, 2, 4, 256, "r32float");
		expect((await new TextureReader(device).read(tex))?.length).toBe(16);
	});

	it("drops a read while one is in flight and recovers afterwards", async () => {
		const { device } = fakeDevice();
		const { tex } = fakeTexture(16, 1, 16, 256);
		const reader = new TextureReader(device);
		const first = reader.read(tex);
		expect(await reader.read(tex)).toBeNull();
		expect(await first).not.toBeNull();
		expect(await reader.read(tex)).not.toBeNull();
	});

	it("returns null (and warns) for an unsupported format, and is usable after", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { device } = fakeDevice();
		const reader = new TextureReader(device);
		expect(
			await reader.read(fakeTexture(4, 1, 4, 256, "rgba8unorm").tex),
		).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
		expect(
			await reader.read(fakeTexture(4, 1, 4, 256, "r32float").tex),
		).not.toBeNull();
	});

	it("grows its staging buffer only when a bigger texture arrives; destroy releases it", async () => {
		const { device, created } = fakeDevice();
		const reader = new TextureReader(device);
		await reader.read(fakeTexture(4, 4, 4, 256, "r32float").tex);
		await reader.read(fakeTexture(4, 2, 4, 256, "r32float").tex);
		expect(created).toHaveLength(1);
		await reader.read(fakeTexture(4, 8, 4, 256, "r32float").tex);
		expect(created).toHaveLength(2);
		expect(created[0].destroyed).toBe(true);
		reader.destroy();
		expect(created[1].destroyed).toBe(true);
	});
});

describe("rangeOf / readGeometry", () => {
	it("extracts the w channel", () => {
		const xyzr = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(Array.from(rangeOf(xyzr))).toEqual([4, 8]);
	});

	it("readGeometry wraps the read with the target size, null when the read drops", async () => {
		const { device } = fakeDevice();
		const { tex } = fakeTexture(16, 1, 16, 256);
		const g = { geometry: tex, width: 16, height: 1 } as never;
		const reader = new TextureReader(device);
		const r = await readGeometry(reader, g);
		expect(r?.width).toBe(16);
		expect(r?.xyzr.length).toBe(64);
		const pending = reader.read(tex);
		expect(await readGeometry(reader, g)).toBeNull();
		await pending;
	});
});

describe("packRows", () => {
	it("copies tight rows as one independent slice", () => {
		const src = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
		const out = packRows(src, 4, 4, 2);
		expect(out).toEqual(src);
		out[0] = 99;
		expect(src[0]).toBe(1);
	});

	it("drops row padding", () => {
		const src = Uint8Array.from([1, 2, 0, 0, 3, 4, 0, 0, 5, 6, 0, 0]);
		expect(packRows(src, 4, 2, 3)).toEqual(Uint8Array.from([1, 2, 3, 4, 5, 6]));
	});

	it("ignores trailing bytes past the last row", () => {
		const src = Uint8Array.from([1, 2, 9, 9, 3, 4, 9, 9, 7, 7, 7, 7]);
		expect(packRows(src, 4, 2, 2)).toEqual(Uint8Array.from([1, 2, 3, 4]));
	});
});

describe("copyTextureRows map options", () => {
	it("maps without waiting for later submitted work", async () => {
		const { tex } = fakeTexture(4, 3, 4, 256);
		const { device, created } = fakeDevice();
		await readTextureBytes(device, tex, 4);
		expect(created[0].mapOptions).toEqual({ waitForSubmittedWork: false });
	});
});
