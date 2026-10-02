// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WebGPU render device for the deck-webgpu renderer: availability check, device creation (with a
// canvas context), and the hand-off to the compute sidecar (src/lib/gpu, owned by the GPU compute
// workstream) so look kernels read our render targets on the SAME device (no copies).
import { Deck } from "@deck.gl/core";
import { type Device, luma } from "@luma.gl/core";
import { webgpuAdapter } from "@luma.gl/webgpu";
import { getFlag } from "#/lib/flags";
import { RAISED_LIMITS, resetComputeDevice } from "#/lib/gpu/core/device";
import { adoptRenderDevice } from "#/lib/gpu/device";
import { applyColorTargetFormat } from "./targets";

/** Features the renderer cannot run without: rgba32float geometry targets and r32float height
 * arrays are bound as filterable `texture_2d<f32>` (README rule 14). */
export const REQUIRED_FEATURES = ["float32-filterable"] as const;

/** Features requested when present. float32-filterable lets passes sample the rgba32float geometry
 * target with a linear sampler; timestamp-query feeds pass timings. */
export const OPTIONAL_FEATURES = [
	"timestamp-query",
	"float32-filterable",
	"float32-blendable",
	"rg11b10ufloat-renderable",
	"shader-f16",
	"subgroups",
] as const;

/**
 * Features luma's featureLevel "max" used to request implicitly (every adapter feature) that the
 * renderer, deck.gl or luma's loaders may rely on: block-compressed textures (tiles3d / KTX2),
 * depth32float-stencil8, depth-clip-control, indirect-first-instance, bgra8unorm-storage,
 * clip-distances, dual-source-blending. Requested when the adapter has them, so dropping "max"
 * for 'core' + requiredLimits changes limits only, not features. Audit 2026-10-01: src/ itself
 * branches only on float32-filterable, timestamp-query, subgroups, shader-f16 (in OPTIONAL_FEATURES);
 * the rest is for deck/luma internals.
 */
export const IMPLICIT_MAX_FEATURES = [
	"texture-compression-bc",
	"texture-compression-bc-sliced-3d",
	"texture-compression-etc2",
	"texture-compression-astc",
	"texture-compression-astc-sliced-3d",
	"depth32float-stencil8",
	"depth-clip-control",
	"indirect-first-instance",
	"bgra8unorm-storage",
	"clip-distances",
	"dual-source-blending",
] as const;

/**
 * Render-device limits that 'max' raised: maxTextureArrayLayers (2048 on Apple vs 256 in 'core',
 * the height arrays) plus the compute RAISED_LIMITS, read from an adapter requested with the
 * options luma uses for 'core'. Empty when no adapter is available (luma then fails on its own).
 */
export async function renderRequiredLimits(): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	try {
		const a = await (navigator as { gpu?: GPU }).gpu?.requestAdapter({
			powerPreference: "high-performance",
			featureLevel: "core",
		} as GPURequestAdapterOptions);
		if (!a) return out;
		const lim = a.limits as unknown as Record<string, unknown>;
		for (const k of ["maxTextureArrayLayers", ...RAISED_LIMITS]) {
			const v = lim[k];
			if (typeof v === "number") out[k] = v;
		}
	} catch {}
	return out;
}

export type Availability =
	| { ok: true; adapter: string }
	| { ok: false; reason: string };

/** Can this browser give us a WebGPU adapter? Never throws. */
export async function webgpuAvailable(): Promise<Availability> {
	const gpu = (navigator as { gpu?: GPU }).gpu;
	if (!gpu)
		return {
			ok: false,
			reason:
				"This browser has no WebGPU (navigator.gpu). Use Chrome/Edge 113+, or Safari/Firefox with WebGPU enabled.",
		};
	try {
		const a = await gpu.requestAdapter({ powerPreference: "high-performance" });
		if (!a)
			return {
				ok: false,
				reason:
					"WebGPU is present but no adapter was granted (blocklisted GPU or disabled).",
			};
		const missing = REQUIRED_FEATURES.filter((f) => !a.features.has(f));
		if (missing.length)
			return {
				ok: false,
				reason: `This WebGPU adapter lacks required feature(s): ${missing.join(", ")}.`,
			};
		const i = a.info;
		return {
			ok: true,
			adapter:
				`${i?.vendor ?? "?"} ${i?.architecture ?? ""} ${i?.description ?? ""}`.trim(),
		};
	} catch (e) {
		return {
			ok: false,
			reason: `requestAdapter failed: ${(e as Error).message}`,
		};
	}
}

/** A standalone luma WebGPU device drawing into `canvas` (no deck.gl). */
export async function createRenderDevice(
	canvas: HTMLCanvasElement,
	opts: { useDevicePixels?: number } = {},
): Promise<Device> {
	const device = await luma.createDevice({
		id: "rigi-render-webgpu",
		type: "webgpu",
		adapters: [webgpuAdapter],
		powerPreference: "high-performance",
		// 'core' + explicit limits (maxTextureArrayLayers 2048 on Apple vs 256 in 'core'; luma #3312)
		featureLevel: "core",
		requiredLimits: await renderRequiredLimits(),
		optionalFeatures: [...OPTIONAL_FEATURES, ...IMPLICIT_MAX_FEATURES],
		createCanvasContext: {
			canvas,
			useDevicePixels:
				opts.useDevicePixels ?? Math.min(window.devicePixelRatio || 1, 2),
			autoResize: true,
			alphaMode: "premultiplied",
		},
	} as never);
	try {
		assertRequiredFeatures(device);
	} catch (e) {
		device.destroy();
		throw e;
	}
	adoptForCompute(device);
	return device;
}

/** Throws when `device` was not granted a REQUIRED_FEATURES entry. */
export function assertRequiredFeatures(device: Device) {
	const missing = REQUIRED_FEATURES.filter(
		(f) => !device.features.has(f as never),
	);
	if (missing.length)
		throw new Error(
			`WebGPU device lacks required feature(s): ${missing.join(", ")}`,
		);
}

/** How long deck may take to create its device before createWebgpuDeck gives up. */
const DECK_DEVICE_TIMEOUT_MS = 15_000;

/** A Deck on WebGPU. Resolves once deck has created its device. */
export async function createWebgpuDeck(
	props: Record<string, unknown> & { canvas: HTMLCanvasElement },
): Promise<{ deck: Deck; device: Device }> {
	const requiredLimits = await renderRequiredLimits();
	let settled = false;
	let resolve!: (d: Device) => void;
	let reject!: (e: Error) => void;
	const ready = new Promise<Device>((res, rej) => {
		resolve = (d) => {
			settled = true;
			res(d);
		};
		reject = (e) => {
			if (settled) return;
			settled = true;
			rej(e);
		};
	});
	// deck/luma report a failed device creation only through onError (AnimationLoop.start catches
	// it), never onDeviceInitialized: reject while pending, and time out as a last resort
	const timer = setTimeout(
		() =>
			reject(
				new Error(
					`deck did not create a WebGPU device within ${DECK_DEVICE_TIMEOUT_MS} ms`,
				),
			),
		DECK_DEVICE_TIMEOUT_MS,
	);
	const userOnError = props.onError as ((e: Error) => void) | undefined;
	const deck = new Deck({
		width: null,
		height: null,
		controller: false,
		...props,
		deviceProps: {
			type: "webgpu",
			adapters: [webgpuAdapter],
			powerPreference: "high-performance",
			featureLevel: "core",
			requiredLimits,
			optionalFeatures: [...OPTIONAL_FEATURES, ...IMPLICIT_MAX_FEATURES],
			...(props.deviceProps as object | undefined),
		},
		onError: (e: Error) => {
			if (!settled) reject(e instanceof Error ? e : new Error(String(e)));
			userOnError?.(e);
		},
		onDeviceInitialized: (d: Device) => {
			if (settled) return;
			try {
				assertRequiredFeatures(d);
			} catch (e) {
				reject(e as Error);
				return;
			}
			adoptForCompute(d);
			resolve(d);
			(props.onDeviceInitialized as ((d: Device) => void) | undefined)?.(d);
		},
	} as never);
	try {
		return { deck, device: await ready };
	} catch (e) {
		// finalize the half-built deck; destroy its device if one exists (feature check failed)
		const d = (deck as unknown as { device?: Device }).device;
		try {
			deck.finalize();
		} catch {}
		d?.destroy();
		throw e;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Hand the render device to the compute layer (src/lib/gpu/device adoptRenderDevice, mt-image-03):
 * getComputeDevice() then resolves to this device, so look kernels bind our targets directly (one
 * queue, no copies). Losing the device falls back to the compute sidecar there. THE ONLY PLACE
 * that couples the renderer and src/lib/gpu.
 */
export function adoptForCompute(device: Device) {
	// opt-in ?colorTarget=rg11b10 (targets.ts): chosen once per device, before any target exists
	applyColorTargetFormat(device, getFlag("colorTarget"), (reason) =>
		console.warn(
			reason === "alpha-unsafe"
				? "[webgpu] ?colorTarget=rg11b10 ignored: rg11b10ufloat has no alpha, which breaks the photo overlay and the world sky. Use ?colorTarget=rg11b10-unsafe to force it for experiments."
				: "[webgpu] ?colorTarget=rg11b10 ignored: device lacks rg11b10ufloat-renderable",
		),
	);
	adoptRenderDevice(device);
}

/**
 * Undo adoptForCompute after a render device was destroyed on a failed boot: compute forgets the
 * adopted device (the sidecar is created on the next use) instead of keeping a dead one.
 */
export function releaseForCompute() {
	resetComputeDevice();
}
