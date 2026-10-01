// Compute kernels over luma 10's engine Kernel, generalised from look/kernel.ts:
// - defineKernel() at module level (WGSL + explicit binding layout, optional entry point and
//   override constants, a warm-up group); the pipeline is created once per device and cached;
// - the pipeline is built by the engine `Kernel` (sync constructor) / `Kernel.createAsync` (luma
//   10.0.0-alpha.2, #3281), which compile through Device.createComputePipeline[Async] so warm-up
//   does not block the thread. Each spec gets its OWN PipelineFactory per device: luma's compute
//   pipeline cache key is shader source + shaderLayout only (entryPoint and constants are not
//   hashed), so the shared default factory could alias two specs that differ only in those;
// - dispatch() sets the bindings on the PASS, never on the shared pipeline object, so concurrent
//   callers of one kernel cannot see each other's bindings, and labels the pass for core/profile;
// - storage()/uniform()/stage()/release() keep look/kernel.ts's API; the pooled variants are in
//   core/pool.ts and the ring readback in core/readback.ts.
// look/kernel.ts maps 1:1 onto this: see core/README.md.
import {
	type BindingDeclaration,
	type Bindings,
	Buffer,
	type CommandEncoder,
	type ComputePass,
	type ComputePipeline,
	type Device,
	PipelineFactory,
} from "@luma.gl/core";
import { Kernel as EngineKernel } from "@luma.gl/engine";
import { onLost, untilLost } from "./lifecycle";
import { isPooled } from "./pool";
import { passProps } from "./profile";
import { stageReads } from "./readback";

export { submit } from "./queue";

/**
 * "texture" is a 2-D unfilterable-float sampled texture (textureLoad only; the render device's
 * rgba32float targets): dispatch() binds a luma Texture for it. Not usable in a core graph.
 */
export type BindKind = "uniform" | "storage" | "read-only-storage" | "texture";

/** A kernel's WGSL and binding layout; defineKernel registers it for warmKernels. */
export type KernelSpec = {
	id: string;
	source: string;
	/** name → kind at `@group(0) @binding(i)`, i in order */
	layout: [string, BindKind][];
	entryPoint: string;
	/** WGSL `override` values */
	constants?: Record<string, number>;
	/** warm-up group (warmKernels(device, group)) */
	group: string;
	/** luma resource id of the shader and pipeline */
	label: string;
};

export type Kernel = {
	pipeline: ComputePipeline;
	/** The device the pipeline lives on (absent on hand-built look/textures kernels). */
	device?: Device;
	/** The engine Kernel (absent on hand-built look/textures kernels). */
	engine?: EngineKernel;
	names: string[];
	spec: KernelSpec;
};

export type KernelOptions = {
	entryPoint?: string;
	constants?: Record<string, number>;
	/** Default "default". */
	group?: string;
	/** Default the id. */
	label?: string;
};

const specs: KernelSpec[] = [];
const cache = new WeakMap<Device, Map<KernelSpec, Kernel>>();
const building = new WeakMap<Device, Map<KernelSpec, Promise<Kernel>>>();

/**
 * Declare a kernel at module level: `source`'s entry point (default `main`) with binding `layout`
 * (name → kind) at group 0, locations in order. `source` must declare exactly those bindings,
 * `@group(0) @binding(i)`, in the same order.
 */
export function defineKernel(
	id: string,
	source: string,
	layout: [string, BindKind][],
	opts: KernelOptions = {},
): KernelSpec {
	const spec: KernelSpec = {
		id,
		source,
		layout,
		entryPoint: opts.entryPoint ?? "main",
		constants: opts.constants,
		group: opts.group ?? "default",
		label: opts.label ?? id,
	};
	specs.push(spec);
	return spec;
}

/** Every spec defined so far (optionally one group's). */
export const definedKernels = (group?: string) =>
	group === undefined ? [...specs] : specs.filter((s) => s.group === group);

const shaderLayout = (spec: KernelSpec) => ({
	bindings: spec.layout.map(
		([name, type], location): BindingDeclaration =>
			// the ternaries narrow `type` for BindingDeclaration's union
			type === "texture"
				? {
						name,
						type,
						group: 0,
						location,
						viewDimension: "2d",
						sampleType: "unfilterable-float",
					}
				: type === "uniform"
					? { name, type, group: 0, location }
					: { name, type, group: 0, location },
	),
});

function cacheOf(device: Device) {
	let m = cache.get(device);
	if (!m) {
		m = new Map();
		cache.set(device, m);
		// pipelines of a lost device are dead: drop them now (the next device compiles afresh)
		onLost(device, () => {
			cache.delete(device);
			building.delete(device);
			factories.delete(device);
		});
	}
	return m;
}

const factories = new WeakMap<Device, Map<KernelSpec, PipelineFactory>>();

/** One PipelineFactory per (device, spec): luma's compute cache key ignores entryPoint/constants. */
function factoryOf(device: Device, spec: KernelSpec): PipelineFactory {
	let m = factories.get(device);
	if (!m) {
		m = new Map();
		factories.set(device, m);
	}
	let f = m.get(spec);
	if (!f) {
		f = new PipelineFactory(device);
		m.set(spec, f);
	}
	return f;
}

// the engine Kernel creates its own shader (default ShaderFactory, keyed by stage + source)
const kernelProps = (device: Device, spec: KernelSpec) => ({
	id: spec.label,
	source: spec.source,
	pipelineFactory: factoryOf(device, spec),
	entryPoint: spec.entryPoint,
	...(spec.constants ? { constants: spec.constants } : {}),
	shaderLayout: shaderLayout(spec),
});

// luma 9.4 shared one module-level bindings object across every WebGPUComputePipeline (we reset
// `_bindingsByGroup` here); luma 10 gives each pipeline its own, so no workaround is needed.
const wrap = (spec: KernelSpec, engine: EngineKernel): Kernel => ({
	pipeline: engine.pipeline,
	device: engine.device,
	engine,
	names: spec.layout.map(([n]) => n),
	spec,
});

/** The pipeline of a defined kernel, created (synchronously) on first use and cached per device. */
export function kernel(device: Device, spec: KernelSpec): Kernel {
	const m = cacheOf(device);
	let k = m.get(spec);
	if (!k) {
		k = wrap(spec, new EngineKernel(device, kernelProps(device, spec)));
		m.set(spec, k);
	}
	return k;
}

/**
 * Like kernel(), but compiles with Kernel.createAsync (Device.createComputePipelineAsync, GPUDevice.
 * createComputePipelineAsync on WebGPU; the sync path elsewhere), so the thread is not blocked.
 * Same WGSL, same module, same descriptor: identical results to kernel().
 */
export function kernelAsync(device: Device, spec: KernelSpec): Promise<Kernel> {
	const ready = cache.get(device)?.get(spec);
	if (ready) return Promise.resolve(ready);
	cacheOf(device);
	let b = building.get(device);
	if (!b) {
		b = new Map();
		building.set(device, b);
	}
	let p = b.get(spec);
	if (!p) {
		const inflight = b;
		p = (async () => {
			const k = wrap(
				spec,
				await untilLost(
					device,
					EngineKernel.createAsync(device, kernelProps(device, spec)),
				),
			);
			const m = cacheOf(device);
			// a sync kernel() may have won meanwhile: keep the first
			const won = m.get(spec);
			if (won) return won;
			m.set(spec, k);
			return k;
		})().finally(() => inflight.delete(spec));
		b.set(spec, p);
	}
	return p;
}

/**
 * Create the pipeline of every kernel defined so far in `group` (all groups when omitted; import
 * the kernel modules first) so the first call does not pay the WGSL compile. Returns how many
 * failed; never throws.
 */
export function warmKernels(device: Device, group?: string): number {
	let failed = 0;
	for (const spec of definedKernels(group))
		try {
			kernel(device, spec);
		} catch (e) {
			failed++;
			console.warn(`[gpu] ${spec.label} compile failed`, e);
		}
	return failed;
}

/** warmKernels with async pipeline creation (in parallel). Resolves the failure count. */
export async function warmKernelsAsync(
	device: Device,
	group?: string,
): Promise<number> {
	const list = definedKernels(group);
	const r = await Promise.allSettled(list.map((s) => kernelAsync(device, s)));
	let failed = 0;
	r.forEach((x, i) => {
		if (x.status === "rejected") {
			failed++;
			console.warn(`[gpu] ${list[i].label} compile failed`, x.reason);
		}
	});
	return failed;
}

/**
 * A dispatch over the device's maxComputeWorkgroupsPerDimension is a validation error that fails the
 * whole submit silently (the reads then return stale slot bytes unless __RIGI_GPU_CHECKS__ is on), so
 * refuse it while encoding: the caller's catch takes its CPU path. Kernels that can exceed it (e.g.
 * the sky refine above ~16.7 Mpx) need a 2-D dispatch to run on the GPU.
 */
function checkWorkgroups(k: Kernel, x: number, y: number, z: number) {
	const max =
		(k.device ?? (k.pipeline as unknown as { device?: Device }).device)?.limits
			.maxComputeWorkgroupsPerDimension ?? 65535;
	if (x > max || y > max || z > max)
		throw new Error(
			`[gpu] ${k.spec.label}: dispatch ${x}×${y}×${z} exceeds maxComputeWorkgroupsPerDimension ${max}`,
		);
}

/** Record `k` with `bindings` into an open pass (sets pipeline + bindings, then dispatches). */
export function encodeDispatch(
	pass: ComputePass,
	k: Kernel,
	bindings: Bindings,
	x: number,
	y = 1,
	z = 1,
) {
	checkWorkgroups(k, x, y, z);
	// per-pass bindings (ComputePass.setBindings is abstract in luma 10; 9.4 had it on WebGPU only)
	pass.setPipeline(k.pipeline);
	pass.setBindings(bindings);
	pass.dispatch(x, y, z);
}

/**
 * Record one compute pass: `k` with `bindings`, dispatching `x × y × z` workgroups. The pass is
 * labelled `label` (default the kernel's) for core/profile.
 */
export function dispatch(
	enc: CommandEncoder,
	k: Kernel,
	bindings: Bindings,
	x: number,
	y = 1,
	z = 1,
	label = k.spec.label,
) {
	const pass = enc.beginComputePass(passProps(enc.device, label));
	encodeDispatch(pass, k, bindings, x, y, z);
	pass.end();
}

/** One dispatch in dispatchAll(). */
export type DispatchCall = {
	k: Kernel;
	bindings: Bindings;
	x: number;
	y?: number;
	z?: number;
};

/**
 * Record several dispatches in ONE compute pass, in order (WebGPU orders storage writes between
 * dispatches of a pass, so this computes the same as one pass each, with less pass overhead).
 */
export function dispatchAll(
	enc: CommandEncoder,
	calls: DispatchCall[],
	label = calls[0]?.k.spec.label ?? "dispatch",
) {
	const pass = enc.beginComputePass(passProps(enc.device, label));
	for (const c of calls) encodeDispatch(pass, c.k, c.bindings, c.x, c.y, c.z);
	pass.end();
}

/** A fresh storage buffer (COPY_SRC | COPY_DST too), initialised from `data` or zeroed to `bytes`. */
export function storage(
	device: Device,
	data: ArrayBufferView | number,
): Buffer {
	const usage = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;
	if (typeof data === "number")
		return device.createBuffer({
			usage,
			byteLength: Math.max(16, Math.ceil(data / 4) * 4),
		});
	// WebGPU wants 4-byte multiples: pad byte arrays
	if (data.byteLength % 4) {
		const p = new Uint8Array(Math.ceil(data.byteLength / 4) * 4);
		p.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		return device.createBuffer({ usage, data: p });
	}
	return device.createBuffer({ usage, data });
}

/** A fresh uniform buffer from 32-bit words (f32 / i32 / u32 views over one ArrayBuffer), padded to 16 bytes. */
export function uniform(device: Device, words: ArrayBuffer): Buffer {
	const n = Math.max(16, Math.ceil(words.byteLength / 16) * 16);
	const d = new Uint8Array(n);
	d.set(new Uint8Array(words));
	return device.createBuffer({
		usage: Buffer.UNIFORM | Buffer.COPY_DST,
		data: d,
	});
}

/**
 * Record a copy of the first `bytes` of `src` into a readback slot; call `.read()` after submitting
 * (resolves exactly `bytes` bytes). look/kernel.ts's stage(), minus the per-call MAP_READ buffer.
 */
export function stage(
	device: Device,
	enc: CommandEncoder,
	src: Buffer,
	bytes: number,
) {
	const s = stageReads(device, enc, [{ buffer: src, size: bytes }]);
	return {
		read: async () => (await s.read())[0],
		cancel: s.cancel,
	};
}

/** Destroy buffers (after the reads resolved). Pooled buffers are skipped: the pool owns them. */
export function release(...bufs: (Buffer | null | undefined)[]) {
	for (const b of bufs) if (b && !isPooled(b)) b.destroy();
}
