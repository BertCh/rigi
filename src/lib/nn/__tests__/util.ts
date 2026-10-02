// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Shared helpers for the CpuNn op specs.

import { expect } from "vitest";
import { expectArrayClose } from "#/test/helpers";
import { CpuNn, type CpuTensor } from "../cpu";
import type { Tensor } from "../types";

export const nn = new CpuNn();

/** Builds a tensor from literal values. */
export const tensor = (data: readonly number[], shape: readonly number[]) =>
	nn.fromArray(data, shape);

/** Asserts a tensor's shape and (to `tolerance`) its values. */
export function expectTensor(
	actual: Tensor,
	shape: readonly number[],
	values: readonly number[],
	tolerance = 1e-6,
) {
	expect([...actual.shape]).toEqual([...shape]);
	expectArrayClose((actual as CpuTensor).data, values, tolerance);
}

/** Raw values of a tensor (synchronous on the CPU backend). */
export const values = (t: Tensor) => Array.from((t as CpuTensor).data);

/** Seeded tensor with entries in [-1, 1). */
export function randomTensor(
	rand: () => number,
	shape: readonly number[],
): Tensor {
	const n = shape.reduce((a, b) => a * b, 1);
	return nn.fromArray(
		Array.from({ length: n }, () => rand() * 2 - 1),
		shape,
	);
}

export const dot = (a: Tensor, b: Tensor) => {
	const x = (a as CpuTensor).data;
	const y = (b as CpuTensor).data;
	let s = 0;
	for (let i = 0; i < x.length; i++) s += x[i] * y[i];
	return s;
};
