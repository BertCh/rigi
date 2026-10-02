// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { poseBasis } from "#/lib/camera";
import type { TileKey } from "#/lib/dem";
import { seededRandom } from "#/test/helpers";

const mocks = vi.hoisted(() => ({
	fetchDemBytes: vi.fn(),
	demRasterFromBytes: vi.fn(),
	downsampleSteps: vi.fn(() => 0),
	statsGpu: vi.fn(),
}));

vi.mock("#/lib/dem", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/dem")>()),
	fetchDemBytes: mocks.fetchDemBytes,
	demRasterFromBytes: mocks.demRasterFromBytes,
	downsampleSteps: mocks.downsampleSteps,
}));
vi.mock("#/lib/gpu/ingest/terrarium-tile", async (importOriginal) => ({
	...(await importOriginal<typeof import("#/lib/gpu/ingest/terrarium-tile")>()),
	terrariumTileStatsGpu: mocks.statsGpu,
}));

import { poseFromBasis } from "../hosts/deck";
import { camerasFor } from "../hosts/passes";
import {
	gpuDecodeTileLoader,
	terrainGpuDecodeCounters,
} from "../terrain-gpu-decode";

describe("poseFromBasis", () => {
	it("inverts poseBasis (forward + up -> yaw / pitch / roll)", () => {
		const rnd = seededRandom(21);
		for (let i = 0; i < 200; i++) {
			const pose = {
				yaw: rnd() * 360 - 180,
				pitch: (rnd() - 0.5) * 140,
				roll: (rnd() - 0.5) * 120,
				vfov: 20 + rnd() * 50,
			};
			const b = poseBasis(pose);
			const q = poseFromBasis(b.forward, b.up, pose.vfov);
			const back = poseBasis(q);
			for (let k = 0; k < 3; k++) {
				expect(back.forward[k]).toBeCloseTo(b.forward[k], 6);
				expect(back.up[k]).toBeCloseTo(b.up[k], 6);
			}
			expect(q.vfov).toBe(pose.vfov);
		}
	});

	it("keeps the pose when it is already canonical", () => {
		const pose = { yaw: 30, pitch: 10, roll: -5, vfov: 40 };
		const b = poseBasis(pose);
		const q = poseFromBasis(b.forward, b.up, 40);
		expect(q.yaw).toBeCloseTo(30, 6);
		expect(q.pitch).toBeCloseTo(10, 6);
		expect(q.roll).toBeCloseTo(-5, 6);
	});
});

describe("camerasFor", () => {
	it("sizes the camera to the target", () => {
		const c = camerasFor(
			{ eye: [0, 0, 0], forward: [0, 1, 0], up: [0, 0, 1], vfov: 40 } as never,
			800,
			400,
		);
		expect(c.aspect).toBe(2);
		expect(c.viewport).toEqual([800, 400]);
	});
});

describe("gpuDecodeTileLoader routes each tile to the right path", () => {
	const key: TileKey = { z: 12, x: 100, y: 200 };
	const cpuRaster = {
		key,
		size: 256,
		heights: new Float32Array(4),
		source: key,
	};
	const device = {} as Device;
	const counts = () => ({ ...terrainGpuDecodeCounters });

	beforeEach(() => {
		mocks.fetchDemBytes.mockReset();
		mocks.demRasterFromBytes.mockReset().mockResolvedValue(cpuRaster);
		mocks.downsampleSteps.mockReset().mockReturnValue(0);
		mocks.statsGpu.mockReset();
		vi.stubGlobal("createImageBitmap", vi.fn());
		for (const k of Object.keys(
			terrainGpuDecodeCounters,
		) as (keyof typeof terrainGpuDecodeCounters)[])
			terrainGpuDecodeCounters[k] = 0;
	});

	it("a missing tile is null", async () => {
		mocks.fetchDemBytes.mockResolvedValue(null);
		const load = gpuDecodeTileLoader(async () => device);
		expect(await load(key, 128, {})).toBeNull();
		expect(counts().gpu).toBe(0);
	});

	it("an ancestor stand-in takes the CPU path", async () => {
		mocks.fetchDemBytes.mockResolvedValue({
			buf: new ArrayBuffer(4),
			source: { ...key, z: 10 },
		});
		const load = gpuDecodeTileLoader(async () => device);
		const r = await load(key, 128, {});
		expect(r?.heights).toBe(cpuRaster.heights);
		expect(counts().cpuAncestor).toBe(1);
		expect(mocks.demRasterFromBytes).toHaveBeenCalledTimes(1);
	});

	it("no device: CPU, unless the load was aborted, then null", async () => {
		mocks.fetchDemBytes.mockResolvedValue({
			buf: new ArrayBuffer(4),
			source: key,
		});
		expect(
			await gpuDecodeTileLoader(async () => null)(key, 128, {}),
		).toBeTruthy();
		expect(counts().cpuError).toBe(1);
		const ac = new AbortController();
		ac.abort();
		expect(
			await gpuDecodeTileLoader(async () => device)(key, 128, {
				signal: ac.signal,
			}),
		).toBeNull();
		expect(mocks.demRasterFromBytes).toHaveBeenCalledTimes(1);
	});

	it("an undecodable image falls back to the CPU path's own answer", async () => {
		mocks.fetchDemBytes.mockResolvedValue({
			buf: new ArrayBuffer(4),
			source: key,
		});
		(
			globalThis.createImageBitmap as ReturnType<typeof vi.fn>
		).mockRejectedValue(new Error("bad"));
		mocks.demRasterFromBytes.mockResolvedValue(null);
		expect(
			await gpuDecodeTileLoader(async () => device)(key, 128, {}),
		).toBeNull();
		expect(counts().cpuError).toBe(1);
	});

	it("odd sizes and extra downsample steps use the CPU path and close the bitmap", async () => {
		mocks.fetchDemBytes.mockResolvedValue({
			buf: new ArrayBuffer(4),
			source: key,
		});
		const close = vi.fn();
		(
			globalThis.createImageBitmap as ReturnType<typeof vi.fn>
		).mockResolvedValue({ width: 300, height: 300, close });
		await gpuDecodeTileLoader(async () => device)(key, 128, {});
		expect(counts().cpuSize).toBe(1);
		expect(close).toHaveBeenCalled();
		(
			globalThis.createImageBitmap as ReturnType<typeof vi.fn>
		).mockResolvedValue({ width: 512, height: 512, close });
		mocks.downsampleSteps.mockReturnValue(2);
		await gpuDecodeTileLoader(async () => device)(key, 64, {});
		expect(counts().cpuSize).toBe(2);
	});

	it("a clean tile becomes a lazy raster with exact stats (stats-only without an atlas)", async () => {
		mocks.fetchDemBytes.mockResolvedValue({
			buf: new ArrayBuffer(4),
			source: key,
		});
		const bitmap = { width: 512, height: 512, close: vi.fn() };
		(
			globalThis.createImageBitmap as ReturnType<typeof vi.fn>
		).mockResolvedValue(bitmap);
		mocks.downsampleSteps.mockReturnValue(1);
		mocks.statsGpu.mockResolvedValue({
			invalid: 0,
			lo: 400,
			hi: 2500,
			lo7: 410,
			hi7: 2400,
		});
		const r = await gpuDecodeTileLoader(async () => device)(key, 256, {});
		expect(r?.size).toBe(256); // halved
		expect(r?.heightStats).toEqual({ lo: 400, hi: 2500, lo7: 410, hi7: 2400 });
		expect(r?.heights).toBeUndefined();
		expect(r?.lazyHeights).toBeDefined();
		expect(r?.gpuLayer).toBeUndefined();
		expect(mocks.statsGpu).toHaveBeenCalledWith(device, bitmap, 2);
		expect(counts()).toMatchObject({
			gpu: 1,
			resident: 0,
			statsOnlyBytes: 512 * 512 * 4,
		});
	});

	it("a resident decode keeps its lease; invalid samples release it and go to the CPU", async () => {
		mocks.fetchDemBytes.mockResolvedValue({
			buf: new ArrayBuffer(4),
			source: key,
		});
		const bitmap = { width: 256, height: 256, close: vi.fn() };
		(
			globalThis.createImageBitmap as ReturnType<typeof vi.fn>
		).mockResolvedValue(bitmap);
		const lease = { release: vi.fn(), live: true };
		const atlas = {
			size: 512,
			device,
			writeTerrariumLeased: vi.fn(async () => ({
				lease,
				stats: { invalid: 0, lo: 1, hi: 2, lo7: 1, hi7: 2 },
			})),
		};
		const atlases = () =>
			({ small: { ...atlas, size: 256 }, big: atlas }) as never;
		const r = await gpuDecodeTileLoader(async () => device, atlases)(
			key,
			256,
			{},
		);
		expect(r?.gpuLayer).toBeDefined();
		expect(counts()).toMatchObject({ gpu: 1, resident: 1 });
		expect(mocks.statsGpu).not.toHaveBeenCalled();
		// a tile with samples to fill
		atlas.writeTerrariumLeased.mockResolvedValue({
			lease,
			stats: { invalid: 3, lo: 1, hi: 2, lo7: 1, hi7: 2 },
		});
		const bad = await gpuDecodeTileLoader(async () => device, atlases)(
			key,
			256,
			{},
		);
		expect(bad?.heights).toBe(cpuRaster.heights);
		expect(lease.release).toHaveBeenCalledTimes(1);
		expect(counts().cpuInvalid).toBe(1);
	});

	it("a GPU error mid-decode falls back to the CPU and closes the bitmap", async () => {
		mocks.fetchDemBytes.mockResolvedValue({
			buf: new ArrayBuffer(4),
			source: key,
		});
		const bitmap = { width: 256, height: 256, close: vi.fn() };
		(
			globalThis.createImageBitmap as ReturnType<typeof vi.fn>
		).mockResolvedValue(bitmap);
		mocks.statsGpu.mockRejectedValue(new Error("device lost"));
		const r = await gpuDecodeTileLoader(async () => device)(key, 256, {});
		expect(r?.heights).toBe(cpuRaster.heights);
		expect(bitmap.close).toHaveBeenCalled();
		expect(counts().cpuError).toBe(1);
	});
});
