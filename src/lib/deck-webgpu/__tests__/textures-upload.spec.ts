// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it, vi } from "vitest";
import {
	floatTexture,
	imageTexture,
	maskTexture,
	placeholderTextures,
} from "../textures";

function fakeDevice() {
	const made: Record<string, unknown>[] = [];
	const writes: { id: unknown; data: unknown; opts: unknown }[] = [];
	const copies: unknown[] = [];
	const device = {
		createTexture: vi.fn((p: Record<string, unknown>) => {
			made.push(p);
			return {
				...p,
				writeData: (data: unknown, opts: unknown) =>
					writes.push({ id: p.id, data, opts }),
				copyExternalImage: (o: unknown) => copies.push(o),
			};
		}),
		generateMipmapsWebGPU: vi.fn(),
		getMipLevelCount: (w: number, h: number) =>
			1 + Math.floor(Math.log2(Math.max(w, h))),
	};
	return {
		device: device as unknown as Device & typeof device,
		made,
		writes,
		copies,
	};
}

describe("imageTexture", () => {
	it("allocates a full mip chain (floor(log2(max side)) + 1) and fills the mips", () => {
		const { device, made, copies } = fakeDevice();
		const img = { width: 1000, height: 600 } as ImageBitmap;
		const t = imageTexture(device, img);
		expect(made[0]).toMatchObject({
			format: "rgba8unorm-srgb",
			width: 1000,
			height: 600,
			mipLevels: 10,
		});
		expect((made[0].sampler as { maxAnisotropy: number }).maxAnisotropy).toBe(
			8,
		);
		expect(copies).toEqual([{ image: img, width: 1000, height: 600 }]);
		expect(device.generateMipmapsWebGPU).toHaveBeenCalledWith(t);
	});

	it("mips: false is one level, anisotropy 1 and no mip generation", () => {
		const { device, made } = fakeDevice();
		imageTexture(device, { width: 512, height: 512 } as ImageBitmap, {
			mips: false,
			id: "x",
		});
		expect(made[0]).toMatchObject({ id: "x", mipLevels: 1 });
		expect((made[0].sampler as { maxAnisotropy: number }).maxAnisotropy).toBe(
			1,
		);
		expect(device.generateMipmapsWebGPU).not.toHaveBeenCalled();
	});

	it("uses an HTMLImageElement's natural size, not its layout size", () => {
		const { device, made } = fakeDevice();
		imageTexture(
			device,
			{
				width: 100,
				height: 50,
				naturalWidth: 2048,
				naturalHeight: 1024,
			} as HTMLImageElement,
			{ mips: false },
		);
		expect(made[0]).toMatchObject({ width: 2048, height: 1024 });
	});

	it("a power of two has log2 + 1 levels", () => {
		const { device, made } = fakeDevice();
		imageTexture(device, { width: 256, height: 1 } as ImageBitmap, {
			mips: true,
		});
		expect(made[0].mipLevels).toBe(9);
	});
});

describe("maskTexture / floatTexture", () => {
	it("mask: r8unorm, one byte per pixel rows, linear filtered", () => {
		const { device, made, writes } = fakeDevice();
		const data = new Uint8Array(12);
		maskTexture(device, data, 4, 3);
		expect(made[0]).toMatchObject({
			format: "r8unorm",
			width: 4,
			height: 3,
			id: "mask",
		});
		expect(writes[0].opts).toEqual({ width: 4, height: 3, bytesPerRow: 4 });
		expect(writes[0].data).toBe(data);
		expect((made[0].sampler as { minFilter: string }).minFilter).toBe("linear");
	});

	it("float: r32float, four bytes per pixel rows, nearest filtered (float32 is unfilterable)", () => {
		const { device, made, writes } = fakeDevice();
		floatTexture(device, new Float32Array(10), 5, 2, "relief");
		expect(made[0]).toMatchObject({ format: "r32float", id: "relief" });
		expect(writes[0].opts).toEqual({ width: 5, height: 2, bytesPerRow: 20 });
		const s = made[0].sampler as Record<string, string>;
		expect([s.minFilter, s.magFilter, s.mipmapFilter]).toEqual([
			"nearest",
			"nearest",
			"nearest",
		]);
	});
});

describe("placeholderTextures", () => {
	it("makes a white 1x1 srgb and a zero 1x1 mask", () => {
		const { device, writes } = fakeDevice();
		const { white, zeroMask } = placeholderTextures(device);
		expect((white as unknown as { id: string }).id).toBe("white");
		expect((zeroMask as unknown as { id: string }).id).toBe("mask0");
		expect(Array.from(writes[0].data as Uint8Array)).toEqual([
			255, 255, 255, 255,
		]);
		expect(Array.from(writes[1].data as Uint8Array)).toEqual([0, 0, 0, 0]);
	});
});
