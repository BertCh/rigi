// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The async look passes the look/** controllers call when opt-in.ts lookGpuOn() is set (they load
// this module with a dynamic import, so the default path never loads luma.gl's WebGPU adapter).
// Each runs the GPU twin and falls back to the CPU function on any failure.
import type { EnuFrame } from "../../geodesy";
import type { Vec3 } from "../../look/atmosphere";
import {
	bandInputs,
	type ColorStats,
	reduceBands,
} from "../../look/color-stats";
import { guidedFilter } from "../../look/guided-filter";
import { fitHaze, type HazeFit, type HazeFitInput } from "../../look/haze-fit";
import { buildReliefField, type ReliefField } from "../../look/relief/field";
import type { HeightTile } from "../../look/relief/heights";
import { getComputeDevice, hasFeature } from "../device";
import {
	type BandStatsInput,
	bandStatsGpu,
	LOOK_SUBGROUP_GROUP,
} from "./color-stats";
import { selectLook } from "./flag";
import { type GuidedJob, guidedFiltersGpu } from "./guided-filter";
import { fitHazeGpu } from "./haze";
import { warmKernelsAsync } from "./kernel";
import { buildReliefFieldGpu } from "./relief";

const run = <T>(
	name: string,
	cpu: () => T,
	gpu: Parameters<typeof selectLook<T>>[2],
) => selectLook(name, cpu, gpu) ?? Promise.resolve().then(cpu);

export const reliefFieldAsync = (
	tiles: readonly HeightTile[],
	frame: EnuFrame,
	sunDir: Vec3,
	yawDeg: number | null,
): Promise<ReliefField> =>
	run(
		"relief",
		() => buildReliefField(tiles, frame, sunDir, yawDeg),
		(d) => buildReliefFieldGpu(d, tiles, frame, sunDir, yawDeg),
	);

export const hazeFitAsync = (input: HazeFitInput): Promise<HazeFit> =>
	run(
		"haze",
		() => fitHaze(input),
		(d) => fitHazeGpu(d, input),
	);

export const guidedFiltersAsync = (
	I: Float32Array,
	w: number,
	h: number,
	jobs: readonly GuidedJob[],
): Promise<Float32Array[]> =>
	run(
		"guided",
		() => jobs.map((j) => guidedFilter(I, j.p, w, h, j.r, j.eps)),
		(d) => guidedFiltersGpu(d, I, w, h, jobs),
	);

export const bandStatsAsync = (o: BandStatsInput): Promise<ColorStats> =>
	run(
		"band-stats",
		() => {
			const { a, b } = bandInputs(
				o.photo as Uint8ClampedArray,
				o.layer,
				o.w,
				o.h,
				(x, y) => o.range[y * o.w + x],
				o.fg ? (x, y) => (o.fg as Float32Array)[y * o.w + x] : undefined,
				o.minRange ?? 0,
			);
			return reduceBands(a, b, o.w * o.h, o.minCount);
		},
		(d) => bandStatsGpu(d, o),
	);

/**
 * Get the compute device and compile every look kernel now (the modules above define them all;
 * the subgroup variants only where the device has subgroups), so the first relief / haze / mask
 * pass does not pay the WGSL compile. Pipelines are created asynchronously (the thread is not
 * blocked). Resolves the ms it took, or null without a device.
 */
export async function warmLook(): Promise<number | null> {
	const device = await getComputeDevice();
	if (!device) return null;
	const t0 = performance.now();
	await Promise.all([
		warmKernelsAsync(device),
		hasFeature(device, "subgroups")
			? warmKernelsAsync(device, LOOK_SUBGROUP_GROUP)
			: 0,
	]);
	return performance.now() - t0;
}
