// One GPUDevice for three's WebGPURenderer and the compute layer (src/lib/gpu/core).
//
// three 0.186's WebGPUBackend takes an existing device (`new WebGPURenderer({ device })`), and luma
// 9.4's WebGPUDevice wraps one (`new WebGPUDevice(props, gpuDevice, adapter, adapterInfo)`), although
// `webgpuAdapter.attach()` itself still throws "not implemented". So both directions work:
//  - "luma-first": luma creates the device (its feature / limit policy), three renders on
//    `luma.handle` (webgpuAdapter.create defaults: no raised limits).
//  - "three-first": three creates the device (featureLevel "compatibility", default limits, every
//    adapter feature) and luma wraps `renderer.backend.device`. Compute then runs under default
//    limits (maxStorageBufferBindingSize 128 MiB), not the sidecar's raised ones.
//  - "sidecar": three renders on the compute sidecar itself (getComputeDevice(): the adapter's maximum
//    storage / buffer / workgroup limits and the optional compute features). One device, no adopt.
//  - "own": three's own device, no sharing (the baseline).
// "luma-first" and "three-first" end in adoptRenderDevice(luma), after which getComputeDevice() returns it.
import type { Device } from "@luma.gl/core";
import { WebGPUDevice, webgpuAdapter } from "@luma.gl/webgpu";
import { WebGPURenderer } from "three/webgpu";
import { adoptRenderDevice, getComputeDevice } from "#/lib/gpu/core/device";

export type DeviceMode = "luma-first" | "sidecar" | "three-first" | "own";

export type SharedRenderer = {
	renderer: WebGPURenderer;
	gpuDevice: GPUDevice;
	/** The luma wrapper of the same GPUDevice (null in "own" mode). */
	luma: Device | null;
	mode: DeviceMode;
	/** three fell back to compatibility mode (no MSAA): the device lacks core-features-and-limits. */
	compatibility: boolean;
};

type RendererOpts = { antialias?: boolean; logarithmicDepthBuffer?: boolean };

/** three's WebGPUBackend (not in the public types): the device and per-object GPU resources. */
type Backend = {
	device: GPUDevice;
	compatibilityMode: boolean;
	get(o: object): { texture?: GPUTexture };
};
export const backendOf = (r: WebGPURenderer) =>
	(r as unknown as { backend: Backend }).backend;

export async function createSharedRenderer(
	canvas: HTMLCanvasElement,
	mode: DeviceMode,
	opts: RendererOpts = {},
): Promise<SharedRenderer> {
	const params = {
		canvas,
		antialias: opts.antialias ?? true,
		logarithmicDepthBuffer: opts.logarithmicDepthBuffer ?? true,
	};
	let luma: Device | null = null;
	let renderer: WebGPURenderer;
	if (mode === "luma-first" || mode === "sidecar") {
		luma =
			mode === "sidecar"
				? await getComputeDevice()
				: await webgpuAdapter.create({ id: "three-webgpu-render" });
		if (!luma) throw new Error("three-webgpu: no compute device (?gpu=off)");
		renderer = new WebGPURenderer({
			...params,
			device: (luma as WebGPUDevice).handle,
		});
		await renderer.init();
	} else {
		renderer = new WebGPURenderer(params);
		await renderer.init();
		if (mode === "three-first") {
			const gpuDevice = backendOf(renderer).device;
			const info = (gpuDevice as GPUDevice & { adapterInfo?: GPUAdapterInfo })
				.adapterInfo;
			// the adapter is only used for canvas contexts, which this wrapper never creates
			luma = new WebGPUDevice(
				{ id: "three-webgpu-render" },
				gpuDevice,
				null as unknown as GPUAdapter,
				info ?? ({} as GPUAdapterInfo),
			);
		}
	}
	if (luma && mode !== "sidecar") adoptRenderDevice(luma);
	const backend = backendOf(renderer);
	return {
		renderer,
		gpuDevice: backend.device,
		luma,
		mode,
		compatibility: backend.compatibilityMode,
	};
}

/** The GPUTexture behind a three texture (render-target attachment) on this renderer. */
export function gpuTextureOf(
	r: WebGPURenderer,
	tex: object,
): GPUTexture | null {
	return backendOf(r).get(tex).texture ?? null;
}
