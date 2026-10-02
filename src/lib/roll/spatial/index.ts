// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roll building at camera-roll scale (grid-indexed clustering and viewpoints, capture-time sort):
// the GPU path with a CPU twin. See neighbours.ts, cluster.ts and sort.ts.
import type { PhotoMeta } from "../../photos";
import type { Roll } from "../types";
import { clusterPhotosAsync, uploadRollsAsync } from "./cluster";

export {
	clusterPhotosAsync,
	clusterPhotosHashed,
	groupViewpointsFast,
	uploadRollsAsync,
} from "./cluster";
export {
	forEachNeighbourPairCpu,
	type NeighbourPairs,
	neighbourPairs,
	neighbourPairsBrute,
	neighbourPairsCpu,
	neighbourPairsGpu,
} from "./neighbours";
export {
	sortGroupsByTime,
	sortGroupsByTimeCpu,
	sortRollsByTime,
} from "./sort";

/** The compute device when there is one (null: CPU twins; `?gpu=off` and WebGL give null). */
async function computeDeviceOrNull() {
	const { getComputeDevice } = await import("#/lib/gpu/device");
	return getComputeDevice().catch(() => null);
}

/** uploadRolls for async callers with many photos: GPU when available, same Roll[] either way. */
export async function uploadRollsAuto(ms: PhotoMeta[]): Promise<Roll[]> {
	return uploadRollsAsync(ms, await computeDeviceOrNull());
}

/** clusterPhotos for async callers with many photos. */
export async function clusterPhotosAuto(
	ms: PhotoMeta[],
	linkM?: number,
): Promise<PhotoMeta[][]> {
	return clusterPhotosAsync(ms, linkM, await computeDeviceOrNull());
}
