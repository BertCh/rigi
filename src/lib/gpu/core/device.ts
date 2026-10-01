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
// Device loss: work in flight on a lost device rejects (core/lifecycle.ts untilLost, core/queue.ts
// submit), and the per-device pools, readback slots, kernel and profiler caches drop themselves. The
// next getComputeDevice() creates a new sidecar (the registry never hands out a lost device), at
// most MAX_LOSSES times per realm; after that the realm stays on the CPU.
// Idle release: releaseWhenIdle(ms) lets a long-lived worker destroy its sidecar after `ms` without
// GPU use (no lease held, no readback in flight); the next getComputeDevice() recreates it.
//
// Devices per realm on a typical /photo load (2026-09-30, out/gpu/followups/core/devices-*.json):
// the page's sidecar, one in the horizon-fast-app worker (terminated after its march) and one in
// the unknown-pose worker (the second-opinion solve; terminated after it). The eye worker
// (?eyesearch) adds one while a search runs; ONNX Runtime's webgpu EP in the sky worker creates its
// own (outside this registry) when sky segmentation runs.
//
// Every caller keeps its CPU twin: null means take the CPU path.

import type { Device } from "@luma.gl/core";
import { getFlag } from "#/lib/flags";
import { idleFor, touch } from "./lifecycle";
import { attachWebGPUDevice } from "./luma";

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

/** Sidecar losses (not resets / idle releases) after which the realm stays on the CPU. */
const MAX_LOSSES = 3;

let pending: Promise<Device | null> | null = null;
/** The sidecar `pending` resolved to (null while creating). */
let current: Device | null = null;
let adopted: Device | null = null;
let losses = 0;

/**
 * The realm's WebGPU compute device, or null (use the CPU path). Never throws. Returns the adopted
 * render device while it is alive, else the lazily created sidecar; never a lost device.
 */
export function getComputeDevice(): Promise<Device | null> {
	if (!gpuEnabled()) return Promise.resolve(null);
	touch();
	if (adopted && !adopted.isLost) return Promise.resolve(adopted);
	// lost, and its lost promise not handled yet (luma marks isLost first)
	if (current?.isLost) lostSidecar(current);
	if (!pending) {
		if (losses >= MAX_LOSSES) return Promise.resolve(null);
		const p = create();
		pending = p;
		p.then((device) => {
			if (pending !== p) return;
			current = device;
			device?.lost.then((info) => lostSidecar(device, info));
			if (device && idleMs !== null) scheduleIdle();
		});
	}
	return pending;
}

/** Forget the current sidecar after a loss (a reset or idle release forgot it first: not a loss). */
function lostSidecar(device: Device, info?: unknown) {
	if (current !== device) return;
	current = null;
	pending = null;
	losses++;
	console.warn(
		`[gpu] compute device lost (${losses}/${MAX_LOSSES})`,
		info ?? "",
	);
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
	current = null;
	adopted = null;
	if (opts.destroy && p) p.then((d) => d?.destroy());
}

let idleMs: number | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Destroy this realm's sidecar after `ms` without GPU use (getComputeDevice, submit), never while a
 * lease is held or a readback is in flight; the next getComputeDevice() creates a new one. For
 * long-lived workers that use the GPU in bursts. The adopted render device is never touched.
 * null turns it off.
 */
export function releaseWhenIdle(ms: number | null): void {
	idleMs = ms;
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = null;
	if (ms !== null && current) scheduleIdle();
}

function scheduleIdle() {
	if (idleTimer || idleMs === null) return;
	const wait = Math.max(idleMs - idleFor(), 50);
	idleTimer = setTimeout(() => {
		idleTimer = null;
		if (idleMs === null || !current || current.isLost) return;
		if (idleFor() < idleMs) return scheduleIdle();
		// forget only the sidecar: an adopted render device stays adopted
		const d = current;
		pending = null;
		current = null;
		d.destroy();
		if (import.meta.env?.DEV)
			console.info(`[gpu] compute device released after ${idleMs} ms idle`);
	}, wait);
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

type RawAdapter = {
	features: Set<string>;
	limits: Record<string, unknown>;
	requestDevice: (d?: {
		requiredFeatures?: string[];
		requiredLimits?: Record<string, number>;
	}) => Promise<GPUDevice>;
};
type RawGpu = { requestAdapter: (o?: unknown) => Promise<RawAdapter | null> };

/**
 * The sidecar: a raw requestDevice with COMPUTE_FEATURES (those the adapter has) and, with
 * `maxLimits`, RAISED_LIMITS at the adapter's maximum, wrapped by WebGPUAdapter.attach. luma's own
 * creation raises limits only for featureLevel "max", which would also request every feature.
 * `ownsHandle`: destroying the luma Device (idle release, reset) destroys the GPUDevice.
 */
async function createSidecar(maxLimits: boolean): Promise<Device> {
	const gpu = (navigator as unknown as { gpu: RawGpu }).gpu;
	const adapter = await gpu.requestAdapter({
		powerPreference: "high-performance",
		featureLevel: "core",
	});
	if (!adapter) throw new Error("Failed to request WebGPU adapter");
	const requiredLimits: Record<string, number> = {};
	if (maxLimits)
		for (const k of RAISED_LIMITS) {
			const v = adapter.limits[k];
			if (typeof v === "number") requiredLimits[k] = v;
		}
	const handle = await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
		requiredLimits,
	});
	try {
		return await attachWebGPUDevice(handle, { id: "rigi-compute" }, true);
	} catch (e) {
		handle.destroy();
		throw e;
	}
}
