// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Worker side of the fused sky path (gpu/sky/fused-graph.ts): prep → U²-Net → refine as ONE
 * ComputeGraph, one submission and one byte-mask readback, in the steady state. It is the first
 * production user of the nn composition API (`fromView` / `forwardInto` / `toView`).
 *
 * Used only when the GPU prep is already verified on this device and nothing needs the intermediate
 * results (`canFuse`); every other request (the verification photos, CPU fallbacks, a translucent
 * photo, overrides) takes the three-step path in sky.worker.ts unchanged. Any fused error is counted
 * (`noteFusedFailure`) and that request falls back to the three-step path; after MAX_FUSED_ERRORS the
 * device stops trying.
 */
import type { Device } from "@luma.gl/core";
import type { ComputeGraph } from "#/lib/gpu/core/graph";
import type { GraphDataView } from "#/lib/gpu/core/luma";
import {
	type FusedModelHooks,
	fusedUnsupported,
	runFusedSky,
} from "#/lib/gpu/sky/fused-graph";
import { uploadBitmapRows } from "#/lib/gpu/sky/prep";
import type { GpuNn } from "#/lib/nn/gpu/gpu-nn";
import { modelSize } from "./core";
import { MODEL_LONG_SIDE, type SkyModel } from "./model";
import { runU2netp } from "./u2netp";

/** Fused-graph errors per device before the device stays on the three-step path. */
export const MAX_FUSED_ERRORS = 3;

export interface FusedEligibility {
	/** The request wants the refined mask and brings a bitmap, with no overrides the fused graph lacks. */
	refine: boolean | undefined;
	forceFallback: boolean | undefined;
	modelLongSide: number | undefined;
	hasBitmap: boolean;
	/** The model's backend and whether it runs on the compute device of this request. */
	modelBackend: string | undefined;
	sameDevice: boolean;
	/** GPU prep state of the device: verified photos, disabled, and the fused error count. */
	prepVerified: boolean;
	fusedErrors: number;
}

/** Whether this request may take the fused path (pure; the steady state only). */
export function canFuse(e: FusedEligibility): boolean {
	return (
		!!e.refine &&
		!e.forceFallback &&
		e.modelLongSide === undefined &&
		e.hasBitmap &&
		e.modelBackend === "webgpu" &&
		e.sameDevice &&
		e.prepVerified &&
		e.fusedErrors < MAX_FUSED_ERRORS
	);
}

const errors = new WeakMap<Device, number>();
export const fusedErrors = (device: Device) => errors.get(device) ?? 0;
/** Count a fused-path failure on `device`. */
export const noteFusedFailure = (device: Device) =>
	errors.set(device, fusedErrors(device) + 1);

let serial = 0;
const serials = new WeakMap<SkyModel, string>();
/** A per-model id for the graph cache key: the graph imports this model's weight buffers. */
export function modelKey(model: SkyModel): string {
	let k = serials.get(model);
	if (!k) {
		k = `m${++serial}`;
		serials.set(model, k);
	}
	return k;
}

/** Records the model's forward into a fused graph (nn.forwardInto). */
export function fusedModelHooks(model: SkyModel): FusedModelHooks {
	const nn = model.nn as unknown as GpuNn;
	return {
		key: modelKey(model),
		forward(graph, input, lw, lh) {
			// the nn composition API takes the parameterless ComputeGraph (its nodes carry no run params)
			const g = graph as unknown as ComputeGraph;
			const x = nn.fromView(g, input as GraphDataView<"float32">, [
				1,
				3,
				lh,
				lw,
			]);
			const { prob } = nn.forwardInto(g, () =>
				runU2netp(model.nn, model.net, x),
			);
			return {
				prob: nn.toView(g, prob) as GraphDataView<"float32">,
				destroy: () => {
					try {
						nn.dispose(prob);
					} catch {}
				},
			};
		},
	};
}

/**
 * The refined sky mask of `bitmap` (exactly W × H) in one submission, or undefined when the shape
 * is unsupported or the photo is translucent (the bitmap bytes then differ from getImageData's: the
 * three-step path decides). Throws on a GPU error.
 */
export async function segmentFused(
	device: Device,
	model: SkyModel,
	bitmap: ImageBitmap,
	W: number,
	H: number,
): Promise<{ bytes: Uint8Array; lw: number; lh: number } | undefined> {
	const { width: lw, height: lh } = modelSize(
		W,
		H,
		MODEL_LONG_SIDE[model.backend],
	);
	if (bitmap.width !== W || bitmap.height !== H) return undefined;
	if (fusedUnsupported(device, W, H, lw, lh)) return undefined;
	const out = await runFusedSky(device, {
		W,
		H,
		lw,
		lh,
		model: fusedModelHooks(model),
		fill: (pad, rowBytes) =>
			uploadBitmapRows(device, bitmap, W, H, pad, rowBytes),
	});
	return out.opaque ? { bytes: out.bytes, lw, lh } : undefined;
}
