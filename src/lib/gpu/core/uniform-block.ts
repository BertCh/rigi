// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Typed uniform packing for compute kernels, built on luma's ShaderBlockWriter with the
// "wgsl-uniform" layout (WGSL uniform address-space rules: vec3 aligned to 16, a following f32/u32
// fills its 4th word, mat4x4 = 4 columns of 16 B). Declare the block once next to the WGSL struct:
//
//   const PRM = defineUniformBlock({ n: "u32", nonce: "u32", w: "i32", h: "i32" });
//   buffer.write(PRM.pack({ n, nonce, w, h }));
//
// Field order and types must match the WGSL `struct`; `uniform-block.check.ts` proves byte
// equality with the former hand-packed words for the migrated kernels.

import {
	type CompositeShaderType,
	makeShaderBlockLayout,
	ShaderBlockWriter,
} from "@luma.gl/core";

type Scalar = number;
/** The JS value for one declared field type: a number, or a flat array of numbers for vec / mat. */
export type UniformFieldValue = Scalar | readonly number[] | ArrayLike<number>;

export type UniformBlock<K extends string> = {
	/** Packed size in bytes, rounded up to 16 (a uniform binding is a multiple of 16 B). */
	readonly byteLength: number;
	/** Word offset of a field in the block (32-bit words). */
	offsetOf(name: K): number;
	/** The block as a fresh ArrayBuffer of `byteLength`; unlisted fields are zero. */
	pack(values: Readonly<Partial<Record<K, UniformFieldValue>>>): ArrayBuffer;
};

/**
 * A uniform block layout from luma shader types ("f32", "u32", "i32", "vec2<f32>", "vec4<u32>",
 * "mat4x4<f32>", …), in WGSL struct order.
 */
export function defineUniformBlock<const L extends Record<string, string>>(
	layout: L,
): UniformBlock<Extract<keyof L, string>> {
	const shaderBlock = makeShaderBlockLayout(
		layout as Record<string, CompositeShaderType>,
		{ layout: "wgsl-uniform" },
	);
	const writer = new ShaderBlockWriter(shaderBlock);
	const byteLength = Math.max(16, Math.ceil(shaderBlock.byteLength / 16) * 16);
	return {
		byteLength,
		offsetOf(name) {
			const f = writer.get(name);
			if (!f) throw new Error(`uniform block has no field ${name}`);
			return f.offset;
		},
		pack(values) {
			const out = new ArrayBuffer(byteLength);
			// the writer returns a view of exactly shaderBlock.byteLength bytes
			new Uint8Array(out).set(
				writer.getData(
					values as Record<
						string,
						Parameters<typeof writer.getData>[0][string]
					>,
				),
			);
			return out;
		},
	};
}
