// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The look kernels' helpers over the shared compute layer (core/kernel.ts, core/pool.ts,
// core/readback.ts): `defineKernel` registers a look kernel (group "look", label "look-<id>"), and
// the pool / readback re-exports are what the look graphs use for their pooled inputs and tail reads.
// Every look kernel runs as a core ComputeGraph node (relief-graph.ts, haze-graph.ts,
// guided-filter-graph.ts, color-stats-graph.ts, textures.ts; see ../README.md).
import type { Device } from "@luma.gl/core";
import * as core from "#/lib/gpu/core/kernel";

export { pooledStorage, pooledUniform, withLease } from "#/lib/gpu/core/pool";
export { type ReadRange, readBack } from "#/lib/gpu/core/readback";

/** The look kernels' warm-up group. */
export const LOOK_GROUP = "look";

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

/**
 * Create the pipeline of every look kernel defined so far (import the kernel modules first), so the
 * first look pass does not pay the WGSL compile, with async pipeline creation (the thread is not
 * blocked). `group` defaults to the look group. Resolves how many failed; never rejects.
 */
export const warmKernelsAsync = (
	device: Device,
	group = LOOK_GROUP,
): Promise<number> => core.warmKernelsAsync(device, group);
