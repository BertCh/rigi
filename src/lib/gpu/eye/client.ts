// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Main-thread side of the photo page's eye-position suggestion (suggest.ts, in suggest.worker.ts).
 * Light on purpose: the photo chunk only gets this file; pose6dof / horizon-fast load in the worker.
 *
 * Opt-in (matching-v2: a moved eye is a LOW-confidence suggestion, never auto-applied), src/lib/flags:
 *   ?eyesearch=on      shows the "Check camera position" button
 *   ?eyesearch=auto    also runs it once in the background
 * ?gpu=off marches the horizons on the CPU (slower, same search).
 */
import type { Pose } from "#/lib/camera";
import type { PhotoMeta } from "#/lib/photos";
import {
	type GpuProfile,
	mergeGpuProfile,
	type RealmGpuOptions,
	realmGpuOptions,
} from "../core/realm";
import { gpuEnabled } from "../device";
import type {
	EyeSearchInput,
	EyeSearchProgress,
	EyeSearchResult,
} from "./suggest";

export type { EyeSearchInput, EyeSearchProgress, EyeSearchResult };

export interface EyeSearchInWorker {
	input: EyeSearchInput;
	gpu: "on" | "off";
	/** The page's GPU profiling / error-check switches (core/realm.ts); undefined when off. */
	gpuOpts?: RealmGpuOptions;
}

export type EyeSearchOutWorker =
	| { type: "progress"; progress: EyeSearchProgress }
	| ((
			| { type: "done"; result: EyeSearchResult }
			| { type: "error"; error: string }
	  ) & {
			/** the worker's GPU pass times, when the page profiles (merged as "eye-worker:…") */
			gpuProfile?: GpuProfile;
	  });

/** The eye-search input for a photo at its current pose. */
export function eyeSearchInput(photo: PhotoMeta, pose: Pose): EyeSearchInput {
	return {
		photoUrl: new URL(photo.src, globalThis.location?.href).href,
		lat: photo.lat,
		lon: photo.lon,
		alt: photo.alt,
		sigmaH: photo.hAccuracy ?? 20,
		pose: {
			yaw: pose.yaw,
			pitch: pose.pitch,
			roll: pose.roll,
			vfov: pose.vfov,
		},
	};
}

/** Runs the search in a worker (on this thread if workers are unavailable). Abort terminates it. */
export function startEyeSearch(
	input: EyeSearchInput,
	onProgress: (p: EyeSearchProgress) => void,
	signal?: AbortSignal,
): Promise<EyeSearchResult> {
	const abortErr = () => new DOMException("eye search cancelled", "AbortError");
	if (signal?.aborted) return Promise.reject(abortErr());
	let worker: Worker;
	try {
		worker = new Worker(new URL("./suggest.worker.ts", import.meta.url), {
			type: "module",
		});
	} catch {
		return import("./suggest").then((m) => m.runEyeSearch(input, onProgress));
	}
	return new Promise<EyeSearchResult>((resolve, reject) => {
		const done = () => {
			worker.terminate();
			signal?.removeEventListener("abort", onAbort);
		};
		const onAbort = () => {
			done();
			reject(abortErr());
		};
		signal?.addEventListener("abort", onAbort);
		worker.onmessage = (ev: MessageEvent<EyeSearchOutWorker>) => {
			const m = ev.data;
			if (m.type === "progress") onProgress(m.progress);
			else {
				mergeGpuProfile("eye-worker", m.gpuProfile);
				done();
				if (m.type === "done") resolve(m.result);
				else reject(new Error(m.error));
			}
		};
		worker.onerror = (e) => {
			done();
			reject(new Error(e.message || "eye search worker failed"));
		};
		const msg: EyeSearchInWorker = {
			input,
			gpu: gpuEnabled() ? "on" : "off",
			gpuOpts: realmGpuOptions(),
		};
		worker.postMessage(msg);
	});
}

/**
 * The photo meta with the camera at the suggested eye (lat / lon / altitude; the engine's
 * eyeAltitude(alt, DEM) then puts the eye there). Marked positionSource "pin" like a user-placed
 * position, so the matcher never treats it as a trusted GPS fix (matching-v2 safety fix).
 */
export function photoAtEye(photo: PhotoMeta, r: EyeSearchResult): PhotoMeta {
	const local = (photo as { local?: Record<string, unknown> }).local;
	return {
		...photo,
		lat: r.eye.lat,
		lon: r.eye.lon,
		alt: r.eye.h,
		local: { ...local, positionSource: "pin" },
	} as PhotoMeta;
}

/**
 * Persists a photo's position through the upload store (the same record the upload page's map pin
 * writes). Only uploads have one: returns false for bundled photos (the move then lasts this session).
 */
export async function persistPosition(photo: PhotoMeta): Promise<boolean> {
	if (!photo.id.startsWith("local-")) return false;
	const [{ getPhotoRecord, putPhoto }, { registerLocalPhoto }] =
		await Promise.all([import("#/lib/upload/store"), import("#/lib/photos")]);
	const rec = await getPhotoRecord(photo.id).catch(() => null);
	if (!rec) return false;
	const local = (photo as { local?: { positionSource?: "exif" | "pin" } })
		.local;
	await putPhoto({
		...rec,
		meta: {
			...rec.meta,
			lat: photo.lat,
			lon: photo.lon,
			alt: photo.alt,
			local: {
				...rec.meta.local,
				positionSource: local?.positionSource ?? rec.meta.local.positionSource,
			},
		},
	});
	registerLocalPhoto(photo, null);
	return true;
}
