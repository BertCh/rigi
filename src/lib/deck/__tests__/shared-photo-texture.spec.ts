// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it, vi } from "vitest";
import { SharedPhotoTexture } from "../terrain-layer";

function fakeDevice() {
	const textures: { destroy: ReturnType<typeof vi.fn> }[] = [];
	const device = {
		type: "webgpu",
		getMipLevelCount: () => 3,
		createTexture: vi.fn(() => {
			const t = { destroy: vi.fn() };
			textures.push(t);
			return t;
		}),
	};
	return { device: device as unknown as Device, textures };
}

const image = (w = 8, h = 8) =>
	({ width: w, height: h }) as unknown as ImageBitmap;

describe("SharedPhotoTexture", () => {
	it("uploads once for repeated gets and returns the same texture", () => {
		const { device, textures } = fakeDevice();
		const shared = new SharedPhotoTexture();
		shared.setSource(image());
		expect(shared.get(device)).toBe(shared.get(device));
		expect(textures).toHaveLength(1);
	});

	it("has no texture without a source", () => {
		const { device, textures } = fakeDevice();
		expect(new SharedPhotoTexture().get(device)).toBeUndefined();
		expect(textures).toHaveLength(0);
	});

	it("frees the texture when the source changes, not when it is set again", () => {
		const { device, textures } = fakeDevice();
		const shared = new SharedPhotoTexture();
		const a = image();
		shared.setSource(a);
		shared.get(device);
		shared.setSource(a);
		expect(textures[0].destroy).not.toHaveBeenCalled();
		shared.setSource(image());
		expect(textures[0].destroy).toHaveBeenCalledTimes(1);
		shared.get(device);
		expect(textures).toHaveLength(2);
	});

	it("re-uploads on another device and frees the old texture", () => {
		const one = fakeDevice();
		const two = fakeDevice();
		const shared = new SharedPhotoTexture();
		shared.setSource(image());
		shared.get(one.device);
		shared.get(two.device);
		expect(one.textures[0].destroy).toHaveBeenCalledTimes(1);
		expect(two.textures).toHaveLength(1);
	});

	it("release frees once and keeps the source for the next get", () => {
		const { device, textures } = fakeDevice();
		const shared = new SharedPhotoTexture();
		shared.setSource(image());
		shared.get(device);
		shared.release();
		shared.release();
		expect(textures[0].destroy).toHaveBeenCalledTimes(1);
		expect(shared.get(device)).toBe(textures[1]);
	});
});
