// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// A forward's result is a tensor, or an array / plain object of them (nested, other values pass
// through): these helpers walk that structure.

import type { Tensor } from "./types";

export const isTensor = (v: unknown): v is Tensor =>
	!!v &&
	typeof v === "object" &&
	"shape" in v &&
	"dtype" in v &&
	Array.isArray((v as Tensor).shape);

const isPlain = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

/** The result's tensors in walk order (arrays by index, objects by key order), each once. */
export function collectTensors(v: unknown, out: Tensor[] = []): Tensor[] {
	if (isTensor(v)) {
		if (!out.includes(v)) out.push(v);
	} else if (Array.isArray(v)) for (const x of v) collectTensors(x, out);
	else if (isPlain(v)) for (const x of Object.values(v)) collectTensors(x, out);
	return out;
}

/** The same structure with every tensor replaced by `f(tensor)`. */
export function mapTensors(v: unknown, f: (t: Tensor) => unknown): unknown {
	if (isTensor(v)) return f(v);
	if (Array.isArray(v)) return v.map((x) => mapTensors(x, f));
	if (isPlain(v))
		return Object.fromEntries(
			Object.entries(v).map(([k, x]) => [k, mapTensors(x, f)]),
		);
	return v;
}

/** mapTensors with an async `f` (all calls start at once, in walk order). */
export async function mapTensorsAsync(
	v: unknown,
	f: (t: Tensor) => Promise<unknown>,
): Promise<unknown> {
	const tensors = collectTensors(v);
	const values = await Promise.all(tensors.map(f));
	return mapTensors(v, (t) => values[tensors.indexOf(t)]);
}
