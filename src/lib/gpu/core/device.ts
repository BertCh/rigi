// Compute device registry, one per realm (window or dedicated worker). getComputeDevice() keeps the
// semantics of src/lib/gpu/device.ts (which will re-export from here): a lazily created luma 9.4
// WebGPU device, null when WebGPU is missing / disabled (?gpu=off) / lost, never throws.
//
// Additions for the "WebGPU everywhere" direction:
// - adoptRenderDevice(device): when the renderer runs on a WebGPU luma Device, compute reuses it
//   (one queue, buffers shareable with the renderer). A WebGL device or null is a no-op; losing
//   the adopted device falls back to the sidecar.
// - The sidecar requests the adapter's maximum storage / buffer / workgroup limits, so large
//   kernels (and ORT-sized buffers) fit. Numerics are unaffected: limits only gate validation.
// - hasFeature(device, name) for the optional features kernels may branch on.
//
// Every caller keeps its CPU twin: null means take the CPU path.

import { type Device, luma } from "@luma.gl/core";
import { webgpuAdapter } from "@luma.gl/webgpu";
import { getFlag } from "#/lib/flags";

/** Optional WebGPU features the sidecar asks for (granted only if the adapter has them). */
export const COMPUTE_FEATURES = [
	"timestamp-query",
	"float32-filterable",
	"subgroups",
	"shader-f16",
] as const;
export type ComputeFeature = (typeof COMPUTE_FEATURES)[number];

/** Adapter limits the sidecar raises to the adapter's maximum. */
export const RAISED_LIMITS = [
	"maxStorageBufferBindingSize",
	"maxBufferSize",
	"maxComputeWorkgroupStorageSize",
	"maxComputeInvocationsPerWorkgroup",
	"maxComputeWorkgroupSizeX",
	"maxComputeWorkgroupSizeY",
	"maxComputeWorkgroupSizeZ",
	"maxStorageBuffersPerShaderStage",
] as const;

export const gpuEnabled = () =>
	getFlag("gpu") === "on" &&
	typeof navigator !== "undefined" &&
	!!(navigator as { gpu?: unknown }).gpu;

let pending: Promise<Device | null> | null = null;
let adopted: Device | null = null;

/**
 * The realm's WebGPU compute device, or null (use the CPU path). Never throws. Returns the adopted
 * render device while it is alive, else the lazily created sidecar.
 */
export function getComputeDevice(): Promise<Device | null> {
	if (!gpuEnabled()) return Promise.resolve(null);
	if (adopted && !adopted.isLost) return Promise.resolve(adopted);
	if (!pending) {
		const p = create();
		pending = p;
		p.then((device) =>
			device?.lost.then((info) => {
				console.warn("[gpu] compute device lost", info);
				// resetComputeDevice may already have replaced it
				if (pending === p) pending = null;
			}),
		);
	}
	return pending;
}

/**
 * Let compute run on the renderer's device. Only a live WebGPU luma Device is adopted; a WebGL
 * device, null or undefined is ignored (compute keeps the sidecar). The sidecar, if created, is
 * kept (callers may still hold its buffers); new getComputeDevice() calls return the adopted one.
 */
export function adoptRenderDevice(device: Device | null | undefined): void {
	if (!device || device.type !== "webgpu" || device.isLost) return;
	adopted = device;
	device.lost.then(() => {
		if (adopted === device) adopted = null;
	});
}

/** The adopted render device, if any (for diagnostics). */
export const adoptedRenderDevice = (): Device | null =>
	adopted && !adopted.isLost ? adopted : null;

/**
 * Forget the adopted device and the sidecar (the next getComputeDevice() creates a fresh one).
 * `destroy: true` also destroys the sidecar (never the adopted render device).
 */
export function resetComputeDevice(opts: { destroy?: boolean } = {}): void {
	const p = pending;
	pending = null;
	adopted = null;
	if (opts.destroy && p) p.then((d) => d?.destroy());
}

/** Whether `device` has an optional feature (false for null). */
export function hasFeature(
	device: Device | null | undefined,
	feature: ComputeFeature,
): boolean {
	return !!device?.features.has(feature);
}

async function create(): Promise<Device | null> {
	try {
		let device: Device;
		try {
			device = await createSidecar(true);
		} catch (e) {
			// an adapter can serve one requestDevice only, so retry from scratch without the limits
			console.warn("[gpu] max-limits device failed, retrying with defaults", e);
			device = await createSidecar(false);
		}
		return device;
	} catch (e) {
		console.warn("[gpu] WebGPU unavailable, using CPU paths", e);
		return null;
	}
}
function createSidecar(maxLimits: boolean): Promise<Device> {
	return luma.createDevice({
		id: "rigi-compute",
		type: "webgpu",
		adapters: [maxLimits ? maxLimitsAdapter() : webgpuAdapter],
		powerPreference: "high-performance",
		optionalFeatures: [...COMPUTE_FEATURES],
	});
}

type RawAdapter = {
	limits: Record<string, unknown>;
	requestDevice: (d?: { requiredLimits?: Record<string, number> }) => unknown;
};
type RawGpu = { requestAdapter: (o?: unknown) => Promise<RawAdapter | null> };

/**
 * webgpuAdapter with requestDevice patched to ask for RAISED_LIMITS at the adapter's maximum.
 * luma 9.4 raises limits only for featureLevel "max", which would also request every feature.
 */
function maxLimitsAdapter(): typeof webgpuAdapter {
	const a = Object.create(webgpuAdapter) as typeof webgpuAdapter;
	(
		a as unknown as {
			requestGPUAdapter: (o: unknown) => Promise<RawAdapter | null>;
		}
	).requestGPUAdapter = async (options) => {
		const gpu = (navigator as unknown as { gpu: RawGpu }).gpu;
		const adapter = await gpu.requestAdapter(options);
		if (!adapter) return null;
		const want: Record<string, number> = {};
		for (const k of RAISED_LIMITS) {
			const v = adapter.limits[k];
			if (typeof v === "number") want[k] = v;
		}
		const request = adapter.requestDevice.bind(adapter);
		adapter.requestDevice = (d) =>
			request({ ...d, requiredLimits: { ...want, ...d?.requiredLimits } });
		return adapter;
	};
	return a;
}
