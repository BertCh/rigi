// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// TEST-ONLY helpers (core/selftest.ts and scripts/gpu/*-page.ts): record one kernel per compute
// pass straight into an encoder. The app runs every kernel as a ComputeGraph node; do not import
// this from app code.
import type { Bindings, CommandEncoder } from "@luma.gl/core";
import { encodeDispatch, type Kernel } from "./kernel";

/** One compute pass: `k` with `bindings`, `x × y × z` workgroups. */
export function dispatch(
	enc: CommandEncoder,
	k: Kernel,
	bindings: Bindings,
	x: number,
	y = 1,
	z = 1,
	label = k.spec.label,
) {
	const pass = enc.beginComputePass({ id: label });
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

/** Several dispatches in ONE compute pass, in order. */
export function dispatchAll(
	enc: CommandEncoder,
	calls: DispatchCall[],
	label = calls[0]?.k.spec.label ?? "dispatch",
) {
	const pass = enc.beginComputePass({ id: label });
	for (const c of calls) encodeDispatch(pass, c.k, c.bindings, c.x, c.y, c.z);
	pass.end();
}
