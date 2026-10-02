// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// defineBlock: one field table → both uniform bindings of a shared GLSL chunk. The shared function
// bodies only use the accessor macros (`atm_eye`), which each binding #defines:
//  - glslDecl: plain `uniform vec3 uAtmEye;` + `#define atm_eye uAtmEye` (raw-WebGL test harnesses);
//  - luma (deck): a std140 block `atmosphereUniforms { vec4 eye; ... } atmosphere;` + `#define atm_eye
//    atmosphere.eye.xyz`, the ShaderModule, and a props packer. vec3 is stored as vec4 (std140's vec3
//    alignment trap) and swizzled back in the macro.
import type { ShaderModule } from "@luma.gl/shadertools";

export type FieldType = "float" | "vec2" | "vec3" | "vec4" | "mat4";
export type BlockValues<F extends Record<string, FieldType>> = {
	[K in keyof F]: F[K] extends "float" ? number : readonly number[];
};

const LUMA_TYPE = {
	float: "f32",
	vec2: "vec2<f32>",
	vec3: "vec4<f32>",
	vec4: "vec4<f32>",
	mat4: "mat4x4<f32>",
} as const;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/**
 * `prefix` names the accessors (`${prefix}_${field}`) and plain GLSL uniforms (`u${Prefix}${Field}`);
 * `name` is the luma module / block instance name (the deck props key).
 */
export function defineBlock<F extends Record<string, FieldType>>(
	prefix: string,
	name: string,
	fields: F,
) {
	type V = Partial<BlockValues<F>>;
	const keys = Object.keys(fields);
	const uniformName = (k: string) => `u${cap(prefix)}${cap(k)}`;
	const defines = (target: (k: string) => string) =>
		keys.map((k) => `#define ${prefix}_${k} ${target(k)}`).join("\n");

	const glslDecl = `${keys.map((k) => `uniform ${fields[k]} ${uniformName(k)};`).join("\n")}\n${defines(uniformName)}\n`;
	const lumaDecl = `layout(std140) uniform ${name}Uniforms {\n${keys
		.map((k) => `  ${fields[k] === "vec3" ? "vec4" : fields[k]} ${k};`)
		.join(
			"\n",
		)}\n} ${name};\n${defines((k) => `${name}.${k}${fields[k] === "vec3" ? ".xyz" : ""}`)}\n`;

	return {
		name,
		fields,
		uniformName,
		glslDecl,
		lumaModule: {
			name,
			vs: lumaDecl,
			fs: lumaDecl,
			uniformTypes: Object.fromEntries(
				keys.map((k) => [k, LUMA_TYPE[fields[k]]]),
			),
		} as ShaderModule,
		/** Values → luma props for `model.shaderInputs.setProps({ [name]: pack(v) })` (vec3 padded to vec4). */
		pack(v: V): Record<string, number | number[]> {
			const out: Record<string, number | number[]> = {};
			for (const [k, x] of Object.entries(v) as [
				string,
				number | readonly number[] | undefined,
			][]) {
				if (x !== undefined)
					out[k] =
						typeof x === "number"
							? x
							: fields[k] === "vec3"
								? [x[0], x[1], x[2], 0]
								: [...x];
			}
			return out;
		},
	};
}

export type Block = ReturnType<typeof defineBlock>;
