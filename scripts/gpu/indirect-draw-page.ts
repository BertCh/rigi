// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Page side of scripts/gpu/indirect-draw-check.mjs: luma.gl 10.0.0-alpha.2-rigi.3 (#3328)
// Model.setIndirectBuffer. A compute pass counts the live flags and writes the draw record, a
// render pass draws from it, and the framebuffer must equal a direct draw of the same count.
import { Buffer, luma, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { webgpuAdapter } from "@luma.gl/webgpu";
import { defineKernel, kernel, storage } from "#/lib/gpu/core/kernel";
import { dispatch } from "#/lib/gpu/core/test-dispatch";

const SIZE = 128;
const CAPACITY = 64;
const VERTICES = 6;

// an 8 x 8 grid of quads, one per instance, each with its own colour
const DRAW_WGSL = /* wgsl */ `
struct V { @builtin(position) position: vec4f, @location(0) color: vec3f };
@vertex fn vertexMain(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> V {
	var corner = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
	let cell = vec2f(f32(i % 8u), f32(i / 8u));
	let p = (cell + 0.1 + corner[v] * 0.8) / 8.0 * 2.0 - 1.0;
	var o: V;
	o.position = vec4f(p, 0.0, 1.0);
	o.color = vec3f(f32(40u + i * 37u % 200u), f32(40u + i * 91u % 200u), f32(40u + i * 151u % 200u)) / 255.0;
	return o;
}
@fragment fn fragmentMain(v: V) -> @location(0) vec4f { return vec4f(v.color, 1.0); }`;

const COUNT_WGSL = /* wgsl */ `
@group(0) @binding(0) var<storage, read> flags: array<u32>;
@group(0) @binding(1) var<storage, read_write> args: array<u32>;
// @workgroup_size(1): one thread counts all 64 flags
@compute @workgroup_size(1) fn main() {
	var n = 0u;
	for (var i = 0u; i < arrayLength(&flags); i++) { n += select(0u, 1u, flags[i] != 0u); }
	args[0] = ${VERTICES}u;
	args[1] = n;
	args[2] = 0u;
	args[3] = 0u;
}`;
const K_COUNT = defineKernel(
	"indirect-draw-count",
	COUNT_WGSL,
	[
		["flags", "read-only-storage"],
		["args", "storage"],
	],
	{ group: "indirect-draw" },
);

export type IndirectDrawCase = {
	live: number;
	counted: number;
	nonBlankPixels: number;
	equal: boolean;
	differingBytes: number;
};

export async function indirectDrawCheck(): Promise<{
	ok: boolean;
	hasApi: boolean;
	cases: IndirectDrawCase[];
}> {
	const hasApi = typeof Model.prototype.setIndirectBuffer === "function";
	const device = await luma.createDevice({
		id: "indirect-draw-check",
		type: "webgpu",
		adapters: [webgpuAdapter],
	});
	const cases: IndirectDrawCase[] = [];
	try {
		const color = device.createTexture({
			width: SIZE,
			height: SIZE,
			format: "rgba8unorm",
			usage: Texture.RENDER | Texture.COPY_SRC,
		} as never);
		const framebuffer = device.createFramebuffer({
			width: SIZE,
			height: SIZE,
			colorAttachments: [color],
		});
		const model = new Model(device, {
			id: "indirect-draw-quads",
			source: DRAW_WGSL,
			vs: null,
			fs: null,
			vertexEntryPoint: "vertexMain",
			fragmentEntryPoint: "fragmentMain",
			vertexCount: VERTICES,
			colorAttachmentFormats: ["rgba8unorm"],
			parameters: {},
		} as never);
		const record = device.createBuffer({
			byteLength: 16,
			usage: Buffer.INDIRECT | Buffer.STORAGE | Buffer.COPY_DST,
		});
		const countKernel = kernel(device, K_COUNT);

		const render = async (): Promise<Uint8Array> => {
			const pass = device.beginRenderPass({
				framebuffer,
				clearColor: [0, 0, 0, 1],
			});
			model.draw(pass);
			pass.end();
			device.submit();
			return readPixels(color);
		};
		const readPixels = async (texture: Texture): Promise<Uint8Array> => {
			const layout = texture.computeMemoryLayout();
			const buffer = device.createBuffer({
				byteLength: layout.byteLength,
				usage: Buffer.MAP_READ | Buffer.COPY_DST,
			});
			texture.readBuffer({}, buffer);
			const data = await buffer.readAsync(0, layout.byteLength);
			const out = new Uint8Array(SIZE * SIZE * 4);
			for (let y = 0; y < SIZE; y++)
				out.set(
					data.subarray(
						y * layout.bytesPerRow,
						y * layout.bytesPerRow + SIZE * 4,
					),
					y * SIZE * 4,
				);
			buffer.destroy();
			return out;
		};

		for (const live of [37, 64, 1, 0, 20]) {
			// scattered live flags, so the GPU count is not a prefix length
			const flags = new Uint32Array(CAPACITY);
			for (let k = 0; k < live; k++) flags[(k * 29) % CAPACITY] = 1;
			const counted = flags.reduce((a, f) => a + (f ? 1 : 0), 0);
			const flagBuffer = storage(device, flags);

			// 1. direct draw of the same count
			model.setIndirectBuffer(null);
			model.setInstanceCount(counted);
			const direct = await render();

			// 2. GPU-written record; the CPU instance count is 0 and must not matter
			dispatch(
				device.commandEncoder,
				countKernel,
				{
					flags: flagBuffer,
					args: record,
				},
				1,
			);
			device.submit();
			model.setInstanceCount(0);
			model.setIndirectBuffer(record);
			const indirect = await render();

			let differingBytes = 0;
			let nonBlankPixels = 0;
			for (let i = 0; i < direct.length; i++)
				if (direct[i] !== indirect[i]) differingBytes++;
			for (let i = 0; i < direct.length; i += 4)
				if (direct[i] || direct[i + 1] || direct[i + 2]) nonBlankPixels++;
			cases.push({
				live,
				counted,
				nonBlankPixels,
				equal: differingBytes === 0,
				differingBytes,
			});
			flagBuffer.destroy();
		}
		const blank = cases.find((c) => c.counted === 0);
		const ok =
			hasApi &&
			cases.every((c) => c.equal) &&
			cases.every((c) => (c.counted === 0) === (c.nonBlankPixels === 0)) &&
			(blank ? blank.nonBlankPixels === 0 : true);
		return { ok, hasApi, cases };
	} finally {
		device.destroy();
	}
}
