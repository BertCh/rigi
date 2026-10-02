// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Render-bundle helper (wave 5, B2). Wired into batched-terrain's GPU-culled draws behind
// ?renderBundles=on (default off); see
// research_notes/wave5/render-bundles.md for the wiring plan and the traps found.
//
// A bundle records luma Model draws once (pipeline, bind groups, vertex/index buffers, draw calls)
// and replays them with RenderPass.executeBundles(). What a bundle freezes, and so what must
// invalidate it:
//   - the attachment signature: colour formats, depth format, sampleCount, depth/stencil read-only
//     (a bundle only executes in a pass with the identical signature; MSAA 4x and 1x drag mode
//     therefore need two bundles, kept by RenderBundleSet under different signature keys)
//   - every bind group (a GPUBindGroup is baked in): a texture/view swap, an atlas that grew into a
//     new texture, a relief field swap, a uniform buffer that was reallocated
//   - every vertex/index buffer identity, the pipeline, and the draw arguments
// What a bundle does NOT freeze: buffer CONTENTS. Uniform, storage and vertex data written with
// queue.writeBuffer (luma Buffer.write) before the submit that executes the bundle is seen by it.
// So per-frame camera uniforms need no invalidation, only an identity change does.
//
// Caller contract: invalidation keys are compared by identity (Object.is), element by element. Put
// in `keys` every object whose identity the recorded commands depend on; `modelBundleKeys(model)`
// gives the keys a luma Model contributes.
import type {
	Device,
	RenderBundle,
	RenderBundleEncoder,
	RenderPass,
	TextureFormatColor,
	TextureFormatDepthStencil,
} from "@luma.gl/core";
import type { Model } from "@luma.gl/engine";

/** The attachment signature a bundle is recorded for and can execute in. */
export type RenderBundleTarget = {
	colorFormats: (TextureFormatColor | null)[];
	/** `false` when the pass has no depth/stencil attachment. */
	depthFormat: TextureFormatDepthStencil | false;
	/** 1, or 4 for the MSAA path (luma RenderBundleEncoder sampleCount, rigi.4). */
	sampleCount: number;
	depthReadOnly?: boolean;
	stencilReadOnly?: boolean;
};

/** Stable string for a target, used as the RenderBundleSet variant key and in invalidation. */
export function getRenderBundleTargetKey(target: RenderBundleTarget): string {
	return [
		target.colorFormats.map((format) => format ?? "null").join(","),
		target.depthFormat === false ? "nodepth" : target.depthFormat,
		`s${target.sampleCount}`,
		target.depthReadOnly ? "dro" : "",
		target.stencilReadOnly ? "sro" : "",
	].join("|");
}

/**
 * Records draws into the given encoder. Return false when any draw was skipped (a pipeline still
 * compiling, a binding still loading): the bundle is then incomplete and is not cached.
 */
export type RecordBundle = (encoder: RenderBundleEncoder) => boolean;

export type RenderBundleStats = {
	records: number;
	hits: number;
	incomplete: number;
};

/** One recorded command list for one target. Rebuilds itself when `keys` change. */
export class DrawBundle {
	readonly stats: RenderBundleStats = { records: 0, hits: 0, incomplete: 0 };
	private bundle: RenderBundle | null = null;
	private recordedKeys: readonly unknown[] | null = null;

	constructor(
		readonly device: Device,
		readonly id: string,
		readonly target: RenderBundleTarget,
		private readonly record: RecordBundle,
	) {}

	/** The current bundle for `keys`, re-recorded if they changed; null when recording was incomplete. */
	get(keys: readonly unknown[]): RenderBundle | null {
		if (this.bundle && keysEqual(keys, this.recordedKeys)) {
			this.stats.hits++;
			return this.bundle;
		}
		this.discard();
		const encoder = createEncoder(this.device, this.id, this.target);
		let complete = false;
		try {
			complete = this.record(encoder);
		} catch (error) {
			encoder.destroy();
			throw error;
		}
		const bundle = encoder.finish();
		if (!complete) {
			// Draws were skipped, so replaying this would be wrong too: drop it.
			this.stats.incomplete++;
			bundle.destroy();
			return null;
		}
		this.stats.records++;
		this.bundle = bundle;
		this.recordedKeys = keys.slice();
		return bundle;
	}

	/** Replays the bundle in `renderPass`. Returns false when no complete bundle was available. */
	execute(renderPass: RenderPass, keys: readonly unknown[]): boolean {
		const bundle = this.get(keys);
		if (!bundle) return false;
		renderPass.executeBundles([bundle]);
		return true;
	}

	/** Forget the recording (next get() re-records). */
	discard(): void {
		this.bundle?.destroy();
		this.bundle = null;
		this.recordedKeys = null;
	}

	destroy(): void {
		this.discard();
	}
}

/**
 * Bundles for the same draw list under several targets, e.g. "msaa4x" for rest frames and "drag1x"
 * for drag mode. Variants are created lazily and kept until destroy().
 */
export class RenderBundleSet {
	private readonly variants = new Map<string, DrawBundle>();

	constructor(
		readonly device: Device,
		readonly id: string,
		private readonly record: RecordBundle,
	) {}

	variant(target: RenderBundleTarget): DrawBundle {
		const key = getRenderBundleTargetKey(target);
		let drawBundle = this.variants.get(key);
		if (!drawBundle) {
			drawBundle = new DrawBundle(
				this.device,
				`${this.id}[${key}]`,
				target,
				this.record,
			);
			this.variants.set(key, drawBundle);
		}
		return drawBundle;
	}

	execute(
		renderPass: RenderPass,
		target: RenderBundleTarget,
		keys: readonly unknown[],
	): boolean {
		return this.variant(target).execute(renderPass, keys);
	}

	/** Drop every variant's recording (e.g. on device loss or a global resource swap). */
	invalidateAll(): void {
		for (const drawBundle of this.variants.values()) drawBundle.discard();
	}

	get size(): number {
		return this.variants.size;
	}

	/** Counters summed over the variants (diagnostics: hits vs re-records). */
	get stats(): RenderBundleStats {
		const total: RenderBundleStats = { records: 0, hits: 0, incomplete: 0 };
		for (const drawBundle of this.variants.values()) {
			total.records += drawBundle.stats.records;
			total.hits += drawBundle.stats.hits;
			total.incomplete += drawBundle.stats.incomplete;
		}
		return total;
	}

	destroy(): void {
		for (const drawBundle of this.variants.values()) drawBundle.destroy();
		this.variants.clear();
	}
}

/**
 * Records every model's draw, in order. `models` must already be ready to draw (pipeline built;
 * draw once beforehand for async pipelines). Returns false if any draw was skipped.
 */
export function recordModels(
	encoder: RenderBundleEncoder,
	models: readonly Model[],
): boolean {
	let complete = true;
	for (const model of models) {
		if (!model.draw(encoder)) complete = false;
	}
	return complete;
}

/**
 * The identity keys one Model contributes: the model itself, its pipeline (rebuilt on format or
 * parameter changes), its vertex array and its bindings (textures, texture views, buffers).
 * Uniform CONTENT changes are not keys; a replaced uniform buffer (new identity) is, via bindings.
 */
export function modelBundleKeys(model: Model): unknown[] {
	const keys: unknown[] = [model, model.pipeline, model.vertexArray];
	const bindings = model.bindings as Record<string, unknown>;
	for (const name of Object.keys(bindings).sort()) keys.push(bindings[name]);
	return keys;
}

function keysEqual(
	a: readonly unknown[],
	b: readonly unknown[] | null,
): boolean {
	if (!b || a.length !== b.length) return false;
	for (let index = 0; index < a.length; index++) {
		if (!Object.is(a[index], b[index])) return false;
	}
	return true;
}

/**
 * luma's RenderBundleEncoder takes sampleCount > 1 since rigi.4 (luma patch render-bundle-msaa), so
 * MSAA bundles use the public API; the pipeline's multisample count still comes from the Model's
 * `parameters.sampleCount` and must match the bundle's.
 */
function createEncoder(
	device: Device,
	id: string,
	target: RenderBundleTarget,
): RenderBundleEncoder {
	return device.createRenderBundleEncoder({
		id,
		colorAttachmentFormats: target.colorFormats,
		depthStencilAttachmentFormat: target.depthFormat,
		sampleCount: target.sampleCount,
		depthReadOnly: target.depthReadOnly ?? false,
		stencilReadOnly: target.stencilReadOnly ?? false,
	});
}
