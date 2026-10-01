// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/// <reference lib="webworker" />
// Terrarium decode off the main thread (load.ts decodeHeights): the same blobHeights (image.ts:
// createImageBitmap + OffscreenCanvas + decodeTerrarium) the page ran, so the heights are the same bits.
import { serveWorker } from "../worker-pool";
import { blobHeights } from "./image";

serveWorker(async (buf: ArrayBuffer) => {
	const heights = await blobHeights(new Blob([buf]));
	return { out: heights, transfer: [heights.buffer] };
});
