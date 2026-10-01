// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Camera } from "#/lib/geo/camera";
import type { PeakView } from "#/lib/geo/peaks";
import type { ExifPhotoMeta } from "#/lib/geo/photo-meta";
import type { SkylineObservation } from "#/lib/geo/skyline";
import type { RealmGpuOptions } from "#/lib/gpu/core/realm";

export type { PeakView, SkylineObservation };

export interface SampleEntry {
	name: string;
	file: string;
	meta: ExifPhotoMeta;
}

/** Horizon as shipped to the main thread (ridges flattened into typed arrays). */
export interface HorizonLite {
	step: number;
	elevation: Float32Array;
	distance: Float32Array;
	ridgeAz: Float32Array;
	ridgeEl: Float32Array;
	ridgeDist: Float32Array;
}

/** A placed label in working-image pixels. */
export interface BaselinePeakLabel {
	key: string;
	name: string;
	ele?: number;
	/** Anchor = projected peak. */
	x: number;
	y: number;
	/** Label text position. */
	lx: number;
	ly: number;
	azimuth: number;
	elevation: number;
}

export interface AlignResult {
	camera: Camera;
	confidence: number;
	residualPx: number;
	/** From solve.ts: false = low confidence, keep the prior / manual pose. */
	accepted: boolean;
	rejectReason?: string;
	/** Which tier produced the pose: solvePose, or refinePose after a reject. */
	method?: "solve" | "refine";
	/** Where the coarse grid ran (diagnostic; the pose is identical either way). */
	solveOn?: "gpu" | "cpu" | "mixed";
}

export interface ControlPoint {
	id: number;
	label: string;
	x: number;
	y: number;
	azimuth: number;
	elevation: number;
}

export type ToWorker =
	| {
			type: "run";
			id: number;
			lat: number;
			lon: number;
			altitude?: number;
	  }
	| {
			type: "skyline";
			id: number;
			image: { width: number; height: number; data: Uint8ClampedArray };
	  }
	| {
			type: "align";
			id: number;
			prior: Camera;
			/**
			 * solvePose's coarse grid on the GPU (identical result by construction; the page sends
			 * gpuEnabled()). Falsy or absent: the synchronous CPU cascade.
			 */
			solveGpu?: boolean;
			/** The page's GPU profiling / error-check switches (core/realm.ts). */
			gpuOpts?: RealmGpuOptions;
	  };

export type Stage = "tiles" | "horizon" | "peaks" | "skyline" | "align";

export type FromWorker =
	| {
			type: "progress";
			id: number;
			stage: Stage;
			done?: number;
			total?: number;
			message: string;
	  }
	| {
			type: "horizon";
			id: number;
			horizon: HorizonLite;
			eye: number;
			ground: number;
			ms: number;
	  }
	| {
			type: "peaks";
			id: number;
			views: PeakView[];
	  }
	| { type: "skyline"; id: number; sky: SkylineObservation }
	| { type: "align"; id: number; result: AlignResult }
	| { type: "error"; id: number; stage: Stage; message: string };
