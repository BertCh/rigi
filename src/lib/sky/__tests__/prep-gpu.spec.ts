// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// prepareGpu's decision logic against a mocked GPU prep (no device): eligibility, the verify-the-
// first-N-photos gate, disable-on-mismatch, error budget, and the idle release timer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { modelSize, normalise, resamplePlanes, rgbPlanes } from "../core";
import { createIdleRelease } from "../graph-idle";

const mocks = vi.hoisted(() => ({
	prepSkyGpu: vi.fn(),
	releasePrepGraphs: vi.fn(async () => {}),
}));
vi.mock("#/lib/gpu/sky/prep", () => mocks);

import type { SkyModel } from "../model";
import { NeedPixels, PREP_VERIFY, prepareGpu, prepStatus } from "../prep";

const W = 64;
const H = 48;
const LONG = 32;
const rgba = (() => {
	const a = new Uint8Array(W * H * 4);
	for (let i = 0; i < a.length; i++) a[i] = (i * 37) & 255;
	for (let i = 3; i < a.length; i += 4) a[i] = 255;
	return a;
})();
const { width: LW, height: LH } = modelSize(W, H, LONG);

/** What a correct GPU prep would read back for `rgba`. */
function goodReadback(tamper = false) {
	const lo = resamplePlanes(
		rgbPlanes({ width: W, height: H, data: rgba }),
		W,
		H,
		3,
		LW,
		LH,
	);
	const inp = normalise(lo, LW * LH);
	const bits = (f: Float32Array) =>
		new Uint32Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.byteLength));
	const out = {
		rgba: Uint8Array.from(rgba),
		rgbLo: bits(lo),
		input: bits(inp),
	};
	if (tamper) out.rgbLo[5] ^= 1;
	return out;
}

function fakePrep(opts: { opaque?: boolean; tamper?: boolean } = {}) {
	return {
		W,
		H,
		lw: LW,
		lh: LH,
		isOpaque: vi.fn(async () => opts.opaque ?? true),
		readAll: vi.fn(async () => goodReadback(opts.tamper)),
		dispose: vi.fn(),
	};
}

const mkDevice = () => ({ handle: {} }) as never;
const modelFor = (device: unknown, backend = "webgpu") =>
	({ backend, device }) as unknown as SkyModel;
const bitmap = {} as ImageBitmap;

afterEach(() => {
	mocks.prepSkyGpu.mockReset();
	mocks.releasePrepGraphs.mockClear();
});

describe("prepareGpu", () => {
	it("is undefined for a cpu model or a model on a different device", async () => {
		const d = mkDevice();
		expect(
			await prepareGpu(d, modelFor(d, "cpu"), bitmap, W, H, LONG, rgba),
		).toBeUndefined();
		expect(
			await prepareGpu(d, modelFor(mkDevice()), bitmap, W, H, LONG, rgba),
		).toBeUndefined();
		expect(mocks.prepSkyGpu).not.toHaveBeenCalled();
	});
	it("throws NeedPixels while verification is due and no CPU pixels were sent", async () => {
		const d = mkDevice();
		await expect(
			prepareGpu(d, modelFor(d), bitmap, W, H, LONG, undefined),
		).rejects.toBeInstanceOf(NeedPixels);
	});
	it("verifies the first PREP_VERIFY photos, then trusts the GPU without pixels", async () => {
		const d = mkDevice();
		const model = modelFor(d);
		for (let i = 0; i < PREP_VERIFY; i++) {
			const prep = fakePrep();
			mocks.prepSkyGpu.mockResolvedValueOnce(prep);
			expect(await prepareGpu(d, model, bitmap, W, H, LONG, rgba)).toBe(prep);
			expect(prep.readAll).toHaveBeenCalledTimes(1);
			expect(prepStatus(d, "gpu").verified).toBe(i + 1);
		}
		const trusted = fakePrep();
		mocks.prepSkyGpu.mockResolvedValueOnce(trusted);
		expect(await prepareGpu(d, model, bitmap, W, H, LONG, undefined)).toBe(
			trusted,
		);
		expect(trusted.readAll).not.toHaveBeenCalled();
	});
	it("a translucent photo takes the CPU path and the prep is disposed", async () => {
		const d = mkDevice();
		const prep = fakePrep({ opaque: false });
		mocks.prepSkyGpu.mockResolvedValueOnce(prep);
		expect(
			await prepareGpu(d, modelFor(d), bitmap, W, H, LONG, rgba),
		).toBeUndefined();
		expect(prep.dispose).toHaveBeenCalled();
		expect(prepStatus(d, "gpu").disabled).toBeUndefined();
	});
	it("a verification mismatch disables the GPU prep for the device and releases its graphs", async () => {
		const d = mkDevice();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const prep = fakePrep({ tamper: true });
		mocks.prepSkyGpu.mockResolvedValueOnce(prep);
		expect(
			await prepareGpu(d, modelFor(d), bitmap, W, H, LONG, rgba),
		).toBeUndefined();
		expect(prep.dispose).toHaveBeenCalled();
		expect(prepStatus(d, "gpu").disabled).toMatch(/rgbLo\[5\]/);
		expect(mocks.releasePrepGraphs).toHaveBeenCalledTimes(1);
		// later photos skip the GPU entirely
		expect(
			await prepareGpu(d, modelFor(d), bitmap, W, H, LONG, rgba),
		).toBeUndefined();
		expect(mocks.prepSkyGpu).toHaveBeenCalledTimes(1);
	});
	it("unsupported shapes fall back without counting as errors; repeated GPU errors disable", async () => {
		const d = mkDevice();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		mocks.prepSkyGpu.mockRejectedValue(new Error("sky prep: upscaling"));
		for (let i = 0; i < 5; i++)
			await prepareGpu(d, modelFor(d), bitmap, W, H, LONG, rgba);
		expect(prepStatus(d, "cpu").disabled).toBeUndefined();
		mocks.prepSkyGpu.mockRejectedValue(new Error("device lost"));
		for (let i = 0; i < 3; i++)
			expect(
				await prepareGpu(d, modelFor(d), bitmap, W, H, LONG, rgba),
			).toBeUndefined();
		expect(prepStatus(d, "cpu").disabled).toMatch(/failed 3 times/);
	});
	it("an alpha-check failure is treated as not opaque (CPU path)", async () => {
		const d = mkDevice();
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const prep = fakePrep();
		prep.isOpaque.mockRejectedValueOnce(new Error("readback"));
		mocks.prepSkyGpu.mockResolvedValueOnce(prep);
		expect(
			await prepareGpu(d, modelFor(d), bitmap, W, H, LONG, rgba),
		).toBeUndefined();
		expect(prep.dispose).toHaveBeenCalled();
	});
});

describe("createIdleRelease", () => {
	afterEach(() => {
		vi.useRealTimers();
	});
	it("fires once after the idle window, a begin() postpones it, nothing fires while in flight", async () => {
		vi.useFakeTimers();
		const release = vi.fn(async () => {});
		const idle = createIdleRelease(1000, release);
		idle.begin();
		idle.end();
		vi.advanceTimersByTime(999);
		expect(release).not.toHaveBeenCalled();
		idle.begin(); // touches inside the window
		vi.advanceTimersByTime(5000);
		expect(release).not.toHaveBeenCalled(); // in flight
		idle.end();
		vi.advanceTimersByTime(1000);
		expect(release).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(10000);
		expect(release).toHaveBeenCalledTimes(1);
	});
	it("overlapping requests release after the last ends; cancel drops it; a failing release is swallowed", async () => {
		vi.useFakeTimers();
		const release = vi.fn(async () => {
			throw new Error("boom");
		});
		const idle = createIdleRelease(100, release);
		idle.begin();
		idle.begin();
		idle.end();
		vi.advanceTimersByTime(500);
		expect(release).not.toHaveBeenCalled();
		idle.end();
		idle.cancel();
		vi.advanceTimersByTime(500);
		expect(release).not.toHaveBeenCalled();
		idle.begin();
		idle.end();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		expect(release).toHaveBeenCalledTimes(1);
		idle.end(); // an extra end never goes negative
	});
});
