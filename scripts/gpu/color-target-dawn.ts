// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// ?colorTarget=rg11b10 on Dawn: a representative colour pass (4x MSAA, premultiplied "over" blend of
// translucent HDR trail / glow triangles over an opaque ground fill, resolve) drawn into rgba16float
// and into rg11b10ufloat, compared per channel. Also shows the alpha loss (rg11b10 has none) and
// prints the analytic VRAM of the colour pass at 1024 / 2048 px long side.
//   DAWN_DIR=/path/with/webgpu@0.3.0 npx tsx scripts/gpu/color-target-dawn.ts
// Exit 0 with SKIP when DAWN_DIR is unset, 2 when no adapter / feature.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { colorPassBytes } from "../../src/lib/deck-webgpu/targets";

const dawnDir = process.env.DAWN_DIR;
if (!dawnDir) {
	console.log("SKIP color-target-dawn: DAWN_DIR is not set");
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dawnDir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const adapter = await create([]).requestAdapter();
if (!adapter?.features.has("rg11b10ufloat-renderable")) {
	console.error("no adapter / rg11b10ufloat-renderable");
	process.exit(2);
}
const device: GPUDevice = await adapter.requestDevice({
	requiredFeatures: ["rg11b10ufloat-renderable"],
});

// GPUTextureUsage / GPUBufferUsage / GPUMapMode bits (not in the node type environment)
const TEX_COPY_SRC = 0x01;
const TEX_SAMPLE = 0x04;
const TEX_RENDER = 0x10;
const BUF_MAP_READ = 0x01;
const BUF_COPY_DST = 0x08;
const MAP_READ = 1;

const W = 256;
const H = 192;
const SCENE = /* wgsl */ `
struct V { @builtin(position) p: vec4f, @location(0) c: vec4f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
	var pos = array<vec2f, 12>(
		vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3),
		vec2f(-0.8, -0.6), vec2f(0.7, -0.2), vec2f(-0.1, 0.8),
		vec2f(-0.5, 0.7), vec2f(0.9, 0.5), vec2f(0.3, -0.9),
		vec2f(0.0, -0.5), vec2f(0.2, 0.9), vec2f(-0.9, 0.1));
	// opaque ground (linear), translucent HDR trail, translucent glow (premultiplied), opaque highlight
	var col = array<vec4f, 4>(
		vec4f(0.18, 0.30, 0.55, 1.0),
		vec4f(2.4, 0.6, 0.1, 0.8) * vec4f(0.8, 0.8, 0.8, 1.0),
		vec4f(0.05, 0.4, 0.45, 0.5) * vec4f(0.5, 0.5, 0.5, 1.0),
		vec4f(1.5, 1.5, 1.5, 1.0));
	var o: V;
	o.p = vec4f(pos[i], 0, 1);
	o.c = col[i / 3u];
	return o;
}
@fragment fn fs(v: V) -> @location(0) vec4f { return v.c; }`;
const BLIT = /* wgsl */ `
@group(0) @binding(0) var t: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
	var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
	return vec4f(p[i], 0, 1);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
	return textureLoad(t, vec2i(p.xy), 0);
}`;
const sceneModule = device.createShaderModule({ code: SCENE });
const blitModule = device.createShaderModule({ code: BLIT });
const over = {
	color: {
		srcFactor: "one",
		dstFactor: "one-minus-src-alpha",
		operation: "add",
	},
	alpha: {
		srcFactor: "one",
		dstFactor: "one-minus-src-alpha",
		operation: "add",
	},
} as const;

async function render(format: GPUTextureFormat): Promise<Float32Array> {
	const ms = device.createTexture({
		size: [W, H],
		format,
		sampleCount: 4,
		usage: TEX_RENDER,
	});
	const resolve = device.createTexture({
		size: [W, H],
		format,
		usage: TEX_RENDER | TEX_SAMPLE,
	});
	const out = device.createTexture({
		size: [W, H],
		format: "rgba32float",
		usage: TEX_RENDER | TEX_COPY_SRC,
	});
	const scenePipeline = device.createRenderPipeline({
		layout: "auto",
		vertex: { module: sceneModule, entryPoint: "vs" },
		fragment: {
			module: sceneModule,
			entryPoint: "fs",
			targets: [{ format, blend: over }],
		},
		multisample: { count: 4 },
	});
	const blitPipeline = device.createRenderPipeline({
		layout: "auto",
		vertex: { module: blitModule, entryPoint: "vs" },
		fragment: {
			module: blitModule,
			entryPoint: "fs",
			targets: [{ format: "rgba32float" }],
		},
	});
	const enc = device.createCommandEncoder();
	const pass = enc.beginRenderPass({
		colorAttachments: [
			{
				view: ms.createView(),
				resolveTarget: resolve.createView(),
				clearValue: [0, 0, 0, 0],
				loadOp: "clear",
				storeOp: "discard",
			},
		],
	});
	pass.setPipeline(scenePipeline);
	pass.draw(12);
	pass.end();
	const blitPass = enc.beginRenderPass({
		colorAttachments: [
			{
				view: out.createView(),
				clearValue: [0, 0, 0, 0],
				loadOp: "clear",
				storeOp: "store",
			},
		],
	});
	blitPass.setPipeline(blitPipeline);
	blitPass.setBindGroup(
		0,
		device.createBindGroup({
			layout: blitPipeline.getBindGroupLayout(0),
			entries: [{ binding: 0, resource: resolve.createView() }],
		}),
	);
	blitPass.draw(3);
	blitPass.end();
	const bytesPerRow = W * 16;
	const buffer = device.createBuffer({
		size: bytesPerRow * H,
		usage: BUF_COPY_DST | BUF_MAP_READ,
	});
	enc.copyTextureToBuffer({ texture: out }, { buffer, bytesPerRow }, [W, H]);
	device.queue.submit([enc.finish()]);
	await buffer.mapAsync(MAP_READ);
	const data = new Float32Array(buffer.getMappedRange().slice(0));
	buffer.unmap();
	return data;
}

const reference = await render("rgba16float");
const packed = await render("rg11b10ufloat");
let maxAbs = 0;
let maxRelative = 0;
let sumAbs = 0;
const perChannel = [0, 0, 0];
let alphaPacked = 1;
let alphaReference = 1;
for (let i = 0; i < W * H; i++) {
	for (let c = 0; c < 3; c++) {
		const d = Math.abs(reference[i * 4 + c] - packed[i * 4 + c]);
		perChannel[c] = Math.max(perChannel[c], d);
		maxAbs = Math.max(maxAbs, d);
		sumAbs += d;
		maxRelative = Math.max(
			maxRelative,
			d / Math.max(Math.abs(reference[i * 4 + c]), 0.05),
		);
	}
	alphaPacked = Math.min(alphaPacked, packed[i * 4 + 3]);
	alphaReference = Math.min(alphaReference, reference[i * 4 + 3]);
}
console.log(
	`rgb rgba16float vs rg11b10ufloat (${W}x${H}, 4x MSAA, premultiplied over, HDR up to 2.4):`,
	`max abs ${maxAbs.toFixed(5)}, per channel [${perChannel.map((v) => v.toFixed(5)).join(", ")}], mean abs ${(sumAbs / (W * H * 3)).toFixed(6)}, max rel (denominator >= 0.05) ${maxRelative.toFixed(4)}`,
);
console.log(
	`alpha min: rgba16float ${alphaReference.toFixed(3)}, rg11b10ufloat ${alphaPacked.toFixed(3)} (no alpha channel, reads 1)`,
);
const mib = (n: number) => (n / 1048576).toFixed(1);
for (const [w, h] of [
	[1024, 683],
	[2048, 1365],
] as const) {
	const full = colorPassBytes(w, h, "rgba16float");
	const small = colorPassBytes(w, h, "rg11b10ufloat");
	console.log(
		`colour pass ${w}x${h} (4x MSAA + resolve): rgba16float ${mib(full)} MiB, rg11b10ufloat ${mib(small)} MiB, saves ${mib(full - small)} MiB`,
	);
}
const ok = maxAbs < 0.05;
console.log(
	ok ? "PASS rgb within tolerance" : "FAIL rgb error above tolerance",
);
process.exit(ok ? 0 : 1);
