// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import type { EdgeMap } from "#/lib/align";
import {
	MAX_RESIDENT,
	PhotoPrep,
	pinResidentPlanes,
	prepOf,
	type ResidentPlanes,
	residentCount,
	retireResident,
} from "../resident";

class Buf {
	destroyed = false;
	byteLength = 16;
	destroy() {
		this.destroyed = true;
	}
}
type Dev = { isLost?: boolean };
const planes = (): ResidentPlanes<Buf> => ({
	coarse: new Buf(),
	fine: new Buf(),
	fg: new Buf(),
	sky: new Buf(),
	skyCum: new Buf(),
});
const mapFor = (rgb: Uint8ClampedArray, fg: Float32Array): EdgeMap => ({
	w: 2,
	h: 2,
	coarse: new Float32Array(4),
	fine: new Float32Array(4),
	sky: new Float32Array(4),
	skyCum: new Float32Array(6),
	rgb,
	fg,
});
function make(device: Dev, opts: { fail?: boolean } = {}) {
	const rgb = new Uint8ClampedArray(16);
	const fg = new Float32Array(4);
	const p = planes();
	const compute = vi.fn(() => mapFor(rgb, fg));
	const onReadFailure = vi.fn();
	const read = vi.fn(async () => {
		if (opts.fail) throw new Error("guard");
		return mapFor(rgb, fg);
	});
	const prep = new PhotoPrep<Dev, Buf>({
		w: 2,
		h: 2,
		rgb,
		fg,
		compute,
		gpu: { device, planes: p, read, onReadFailure },
	});
	return { prep, p, compute, read, onReadFailure };
}
const destroyed = (p: ResidentPlanes<Buf>) =>
	Object.values(p).every((b) => b.destroyed);

describe("PhotoPrep residency", () => {
	it("reads through the GPU once and registers the map", async () => {
		const dev = {};
		const { prep, read, compute, p } = make(dev);
		expect(prep.resident).toBe(true);
		expect(prep.device).toBe(dev);
		const [a, b] = await Promise.all([prep.cpu(), prep.cpu()]);
		expect(a).toBe(b);
		expect(read).toHaveBeenCalledTimes(1);
		expect(compute).not.toHaveBeenCalled();
		expect(prep.source).toBe("gpu-read");
		expect(prepOf(a)).toBe(prep);
		const pin = pinResidentPlanes(dev, a);
		expect(pin?.coarse).toBe(p.coarse);
		expect(pinResidentPlanes({}, a)).toBeNull(); // other device
		pin?.release();
	});
	it("a failed read falls back to the CPU reference and retires the planes", async () => {
		const dev = {};
		const { prep, onReadFailure, compute, p } = make(dev, { fail: true });
		const m = await prep.cpu();
		expect(compute).toHaveBeenCalledTimes(1);
		expect(onReadFailure).toHaveBeenCalledTimes(1);
		expect(prep.readFailures).toBe(1);
		expect(prep.source).toBe("cpu");
		expect(prep.resident).toBe(false);
		expect(destroyed(p)).toBe(true);
		expect(pinResidentPlanes(dev, m)).toBeNull();
	});
	it("a pin keeps buffers alive past retirement; release is idempotent", async () => {
		const dev = {};
		const { prep, p } = make(dev);
		const pin = prep.pin(dev);
		expect(pin).not.toBeNull();
		prep.retire();
		expect(prep.resident).toBe(false);
		expect(prep.pin(dev)).toBeNull();
		expect(destroyed(p)).toBe(false);
		pin?.release();
		pin?.release();
		expect(destroyed(p)).toBe(true);
		expect(prep.released).toBe(true);
	});
	it("evicts the oldest beyond MAX_RESIDENT and retires per device", () => {
		const dev = {};
		const all = Array.from({ length: MAX_RESIDENT + 1 }, () => make(dev));
		expect(residentCount(dev)).toBe(MAX_RESIDENT);
		expect(all[0].prep.resident).toBe(false);
		expect(destroyed(all[0].p)).toBe(true);
		retireResident(dev);
		expect(residentCount(dev)).toBe(0);
		expect(all.every((a) => !a.prep.resident)).toBe(true);
	});
	it("a lost device is not resident; cpuSync computes once", () => {
		const dev: Dev = {};
		const { prep, compute } = make(dev);
		dev.isLost = true;
		expect(prep.resident).toBe(false);
		expect(prep.pin(dev)).toBeNull();
		expect(prep.cpuSync()).toBe(prep.cpuSync());
		expect(compute).toHaveBeenCalledTimes(1);
		expect(prep.materialized).toBeDefined();
	});
	it("a CPU-only prep never touches a device", async () => {
		const rgb = new Uint8ClampedArray(16);
		const fg = new Float32Array(4);
		const m = mapFor(rgb, fg);
		const prep = new PhotoPrep({
			w: 2,
			h: 2,
			rgb,
			fg,
			compute: () => m,
			map: m,
		});
		expect(prep.device).toBeNull();
		expect(await prep.cpu()).toBe(m);
		expect(pinResidentPlanes({}, m)).toBeNull();
		prep.retire();
	});
});
