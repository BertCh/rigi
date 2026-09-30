/// <reference lib="webworker" />
// Terrarium decode off the main thread (load.ts decodeHeights): the same blobHeights (image.ts:
// createImageBitmap + OffscreenCanvas + decodeTerrarium) the page ran, so the heights are the same bits.
import { blobHeights } from "./image";

export type DecodeIn = { id: number; buf: ArrayBuffer };
export type DecodeOut =
	| { id: number; heights: Float32Array }
	| { id: number; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = async (e: MessageEvent<DecodeIn>) => {
	const { id, buf } = e.data;
	try {
		const heights = await blobHeights(new Blob([buf]));
		scope.postMessage({ id, heights } satisfies DecodeOut, [heights.buffer]);
	} catch (err) {
		scope.postMessage({ id, error: String(err) } satisfies DecodeOut);
	}
};
