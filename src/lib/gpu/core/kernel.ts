// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Compute kernels over luma 10's engine Kernel, generalised from look/kernel.ts:
// - defineKernel() at module level (WGSL + explicit binding layout, optional entry point and
//   override constants, a warm-up group); the pipeline is created once per device and cached;
// - the pipeline is built by the engine `Kernel` (sync constructor) / `Kernel.createAsync` (luma
//   10.0.0-alpha.2, #3281), which compile through Device.createComputePipeline[Async] so warm-up
//   does not block the thread. The device's shared PipelineFactory is used (vendored luma rigi.3
//   hashes entryPoint and override constants into the compute pipeline key);
// - encodeDispatch() goes through the engine Kernel.dispatch(pass, {bindings, x, y, z}): the bindings
//   are set on the PASS, never on the shared pipeline object, so concurrent callers of one kernel
//   cannot see each other's bindings. Kernels without an engine (hand-built look/textures kernels)
//   keep the manual setPipeline/setBindings/dispatch;
// - the binding layout can be derived from the WGSL (deriveLayout, luma's getShaderLayoutFromWGSL):
//   defineKernel(id, source, opts) needs no hand-written layout array; a given array is still accepted
//   and, in dev builds and tests, must equal the derived one;
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
} from "@luma.gl/core";
import { Kernel as EngineKernel } from "@luma.gl/engine";
import { checkStorageBindings } from "./binding-guard";
import { onLost, untilLost } from "./lifecycle";
import { getShaderLayoutFromWGSL } from "./luma";
import { isPooled } from "./pool";
import { stageReads } from "./readback";

/**
 * "texture" is a 2-D unfilterable-float sampled texture (textureLoad only; the render device's
 * rgba32float targets): a kernel dispatch binds a luma Texture for it; a ComputeGraph kernel node binds a
 * graph texture or texture view (declared "sampled"). "texture-array" is the same over a 2-D array
 * (WGSL texture_2d_array<f32>; e.g. the batched terrain's r32float height arrays).
 */
export type BindKind =
	| "uniform"
	| "storage"
	| "read-only-storage"
	| "texture"
	| "texture-array";

/** True for the sampled-texture binding kinds. */
export const isTextureKind = (kind: BindKind) =>
	kind === "texture" || kind === "texture-array";

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
 * The binding layout of a WGSL compute source, from luma's getShaderLayoutFromWGSL: every binding at
 * `@group(0) @binding(i)`, i = 0..n-1 in order, as name → kind. A `texture_2d` is "texture", a
 * `texture_2d_array` "texture-array". Throws on reflection failure, another group, a gap, or a
 * binding kind a core kernel does not bind (samplers, storage textures, other texture dimensions).
 */
export function deriveLayout(source: string): [string, BindKind][] {
	const reflected = getShaderLayoutFromWGSL(source);
	if (!reflected)
		throw new Error(
			"WGSL reflection failed (ambiguous or unsupported syntax); pass the layout explicitly",
		);
	const byLocation = new Map<number, [string, BindKind]>();
	for (const b of reflected.bindings) {
		if (b.group !== 0)
			throw new Error(`binding "${b.name}" is in @group(${b.group}), not 0`);
		if (byLocation.has(b.location))
			throw new Error(`@binding(${b.location}) is declared twice`);
		let kind: BindKind;
		if (b.type === "texture") {
			const dimension = (b as { viewDimension?: string }).viewDimension;
			if (dimension !== "2d" && dimension !== "2d-array")
				throw new Error(`"${b.name}": unsupported texture view ${dimension}`);
			kind = dimension === "2d" ? "texture" : "texture-array";
		} else if (
			b.type === "uniform" ||
			b.type === "storage" ||
			b.type === "read-only-storage"
		)
			kind = b.type;
		else throw new Error(`"${b.name}": unsupported binding type ${b.type}`);
		byLocation.set(b.location, [b.name, kind]);
	}
	return Array.from({ length: byLocation.size }, (_, i) => {
		const entry = byLocation.get(i);
		if (!entry)
			throw new Error(`no @group(0) @binding(${i}) (bindings must be 0..n-1)`);
		return entry;
	});
}

const sameLayout = (a: [string, BindKind][], b: [string, BindKind][]) =>
	a.length === b.length &&
	a.every(([name, kind], i) => name === b[i][0] && kind === b[i][1]);

// dev builds (vite dev) and tests: validate hand-written layouts against the WGSL
const checkLayouts = () =>
	(import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/**
 * Declare a kernel at module level: `source`'s entry point (default `main`) with its binding layout at
 * group 0, locations in order. Two forms:
 * - `defineKernel(id, source, opts?)`: the layout is derived from the WGSL (deriveLayout);
 * - `defineKernel(id, source, layout, opts?)`: the classic hand-written `[name, kind][]`, which must
 *   equal the derived layout (checked in dev builds and tests, not in production).
 */
export function defineKernel(
	id: string,
	source: string,
	opts?: KernelOptions,
): KernelSpec;
export function defineKernel(
	id: string,
	source: string,
	layout: [string, BindKind][] | undefined,
	opts?: KernelOptions,
): KernelSpec;
export function defineKernel(
	id: string,
	source: string,
	third?: [string, BindKind][] | KernelOptions,
	fourth?: KernelOptions,
): KernelSpec {
	const explicit = Array.isArray(third) ? third : undefined;
	const opts: KernelOptions =
		(Array.isArray(third) ? fourth : third) ?? fourth ?? {};
	let layout = explicit;
	if (!layout || checkLayouts()) {
		let derived: [string, BindKind][] | undefined;
		try {
			derived = deriveLayout(source);
		} catch (e) {
			if (!layout)
				throw new Error(`defineKernel ${id}: ${(e as Error).message}`);
			// hand-written layouts stay valid where reflection cannot read the WGSL
		}
		if (derived && layout && !sameLayout(layout, derived))
			throw new Error(
				`defineKernel ${id}: layout ${JSON.stringify(layout)} does not match the WGSL ${JSON.stringify(derived)}`,
			);
		layout ??= derived;
	}
	if (!layout) throw new Error(`defineKernel ${id}: no layout`);
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
			isTextureKind(type)
				? {
						name,
						type: "texture",
						group: 0,
						location,
						viewDimension: type === "texture-array" ? "2d-array" : "2d",
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
		});
	}
	return m;
}

// the engine Kernel creates its own shader (default ShaderFactory, keyed by stage + source)
const kernelProps = (spec: KernelSpec) => ({
	id: spec.label,
	source: spec.source,
	entryPoint: spec.entryPoint,
	...(spec.constants ? { constants: spec.constants } : {}),
	shaderLayout: shaderLayout(spec),
});

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
		k = wrap(spec, new EngineKernel(device, kernelProps(spec)));
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
			const created = EngineKernel.createAsync(device, kernelProps(spec));
			// untilLost may throw before it awaits `created`: never leave its rejection unhandled
			created.catch(() => {});
			const k = wrap(spec, await untilLost(device, created));
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
	const max = k.device?.limits.maxComputeWorkgroupsPerDimension ?? 65535;
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
	checkStorageBindings(
		k.spec,
		bindings,
		k.device?.limits.minStorageBufferOffsetAlignment ?? 256,
	);
	// per-pass bindings: the engine Kernel sets pipeline and bindings on the PASS
	if (k.engine) k.engine.dispatch(pass, { bindings, x, y, z });
	else {
		pass.setPipeline(k.pipeline);
		pass.setBindings(bindings);
		pass.dispatch(x, y, z);
	}
}

/**
 * encodeDispatch with the workgroup counts read by the GPU: `indirectBuffer` holds 3 × u32 at
 * `indirectOffset` (x = 0 skips the dispatch). The storage-binding guards still run; the direct
 * workgroup limit cannot (the GPU decides the counts).
 */
export function encodeDispatchIndirect(
	pass: ComputePass,
	k: Kernel,
	bindings: Bindings,
	indirectBuffer: Buffer,
	indirectOffset = 0,
) {
	checkStorageBindings(
		k.spec,
		bindings,
		k.device?.limits.minStorageBufferOffsetAlignment ?? 256,
	);
	if (k.engine)
		k.engine.dispatchIndirect(pass, {
			bindings,
			indirectBuffer,
			indirectOffset,
		});
	else {
		pass.setPipeline(k.pipeline);
		pass.setBindings(bindings);
		pass.dispatchIndirect(indirectBuffer, indirectOffset);
	}
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
