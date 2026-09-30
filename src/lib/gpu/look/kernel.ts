// The look kernels' helpers, now thin re-exports of the shared compute layer (core/kernel.ts,
// core/pool.ts, core/readback.ts): one pipeline per WGSL entry point (explicit shader layout, cached
// per device), bindings set per pass, fresh or pooled storage / uniform buffers, readback through
// reusable ring slots. The API is the one skyglobal and the look modules always used; the look
// modules themselves now run on pooled buffers inside withLease (see core/README.md).
import type { Device } from "@luma.gl/core";
import * as core from "#/lib/gpu/core/kernel";

export type { BindKind, Kernel } from "#/lib/gpu/core/kernel";
export {
	dispatch,
	dispatchAll,
	release,
	stage,
	storage,
	submit,
	uniform,
} from "#/lib/gpu/core/kernel";
export {
	clear,
	pooledStorage,
	pooledUniform,
	range,
	withLease,
} from "#/lib/gpu/core/pool";
export {
	type ReadRange,
	readBack,
	stageReads,
} from "#/lib/gpu/core/readback";

/** The look kernels' warm-up group. */
export const LOOK_GROUP = "look";

/**
 * A kernel's WGSL and binding layout. core's KernelSpec with its extra fields optional, so plain
 * `{ id, source, layout }` objects (skyglobal builds those) still work: they run `main`, labelled
 * `look-<id>`, and are not in any warm-up group.
 */
export type KernelSpec = Pick<core.KernelSpec, "id" | "source" | "layout"> &
	Partial<core.KernelSpec>;

/**
 * Declare a look kernel at module level: `source`'s `main`, binding `layout` (name → kind) at group
 * 0, locations in order, registered for warmKernels. `opts` may override the group (a kernel that
 * needs an optional feature goes in its own group, warmed only where the device has it).
 */
export const defineKernel = (
	id: string,
	source: string,
	layout: [string, core.BindKind][],
	opts: core.KernelOptions = {},
): core.KernelSpec =>
	core.defineKernel(id, source, layout, {
		group: LOOK_GROUP,
		label: `look-${id}`,
		...opts,
	});

const completed = new WeakMap<KernelSpec, core.KernelSpec>();

function full(spec: KernelSpec): core.KernelSpec {
	if (spec.entryPoint && spec.group && spec.label)
		return spec as core.KernelSpec;
	let s = completed.get(spec);
	if (!s) {
		s = {
			entryPoint: "main",
			group: "",
			label: `look-${spec.id}`,
			...spec,
		} as core.KernelSpec;
		completed.set(spec, s);
	}
	return s;
}

/** The pipeline of a kernel, created on first use and cached per device (and spec object). */
export const kernel = (device: Device, spec: KernelSpec): core.Kernel =>
	core.kernel(device, full(spec));

/**
 * Create the pipeline of every look kernel defined so far (import the kernel modules first), so the
 * first look pass does not pay the WGSL compile. `group` defaults to the look group. Returns how
 * many failed; never throws.
 */
export const warmKernels = (device: Device, group = LOOK_GROUP): number =>
	core.warmKernels(device, group);

/** warmKernels with async pipeline creation (the thread is not blocked). Resolves the failures. */
export const warmKernelsAsync = (
	device: Device,
	group = LOOK_GROUP,
): Promise<number> => core.warmKernelsAsync(device, group);
