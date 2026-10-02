// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Render bundles on a luma.gl WebGPU device over Dawn in node (wave 5 B2 spike; see
// research_notes/wave5/render-bundles.md). Renders luma Models directly into an offscreen target
// and through a DrawBundle / RenderBundleSet (src/lib/deck-webgpu/render-bundle.ts) and compares the
// pixels EXACTLY (the same pipeline, same draw order, same device: no tolerance).
//
// Cases:
//   direct-vs-bundle   two overlapping depth-tested Models, 1x
//   uniform-rule       uniform contents rewritten with Buffer.write between replays: the bundle sees
//                      the new value with no re-record (stats.records stays 1)
//   invalidation       the uniform buffer is replaced by a new buffer: a stale key replays the OLD
//                      buffer (the trap, asserted), the correct key re-records and matches direct
//   msaa4x             same draws into a 4x MSAA target + resolve, bundle via the native-handle path
//   variants           1x and 4x variants live side by side in one RenderBundleSet and both stay valid
//   incomplete         a draw that returns false is not cached
//
// `webgpu` is not a dependency of the app; point DAWN_DIR at a dir with `npm i webgpu@0.3.0`:
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/render-bundle-dawn.ts
// Exit 1 on any failure, 2 when there is no adapter / package.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device, Buffer as LumaBuffer, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import {
	DrawBundle,
	modelBundleKeys,
	RenderBundleSet,
	type RenderBundleTarget,
	recordModels,
} from "../../src/lib/deck-webgpu/render-bundle";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.error("set DAWN_DIR to a directory with `npm i webgpu@0.3.0`");
	process.exit(2);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]);
if (!(await gpu.requestAdapter())) {
	console.error("no WebGPU adapter");
	process.exit(2);
}
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const { luma } = await import("@luma.gl/core");
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const device: Device = await luma.createDevice({
	type: "webgpu",
	adapters: [webgpuAdapter],
	createCanvasContext: false,
} as never);

const SIZE = 32;
const COLOR_FORMAT = "rgba8unorm" as const;
const DEPTH_FORMAT = "depth24plus" as const;

const SOURCE = /* wgsl */ `
struct Params { color: vec4f, rect: vec4f, depth: vec4f };
@group(0) @binding(0) var<uniform> params: Params;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
	var corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
	let corner = corners[index];
	return vec4f(mix(params.rect.x, params.rect.z, corner.x), mix(params.rect.y, params.rect.w, corner.y), params.depth.x, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4f { return params.color; }
`;

const writeParams = (
	buffer: LumaBuffer,
	color: number[],
	rect: number[],
	depth: number,
) => buffer.write(new Float32Array([...color, ...rect, depth, 0, 0, 0]));
const makeParams = (color: number[], rect: number[], depth: number) => {
	const buffer = device.createBuffer({
		usage: 0x40 | 0x08, // UNIFORM | COPY_DST
		byteLength: 48,
	});
	writeParams(buffer, color, rect, depth);
	return buffer;
};

const makeModel = (id: string, params: LumaBuffer, sampleCount: number) =>
	new Model(device, {
		id,
		source: SOURCE,
		vertexEntryPoint: "vertexMain",
		fragmentEntryPoint: "fragmentMain",
		shaderLayout: {
			attributes: [],
			bindings: [{ name: "params", type: "uniform", group: 0, location: 0 }],
		},
		bindings: { params },
		topology: "triangle-list",
		vertexCount: 6,
		colorAttachmentFormats: [COLOR_FORMAT],
		depthStencilAttachmentFormat: DEPTH_FORMAT,
		parameters: {
			depthWriteEnabled: true,
			depthCompare: "less",
			sampleCount,
		},
	} as never);

type Target = {
	pixels: () => Promise<Uint8Array>;
	beginPass: () => ReturnType<Device["beginRenderPass"]>;
	target: RenderBundleTarget;
	submit: (pass: ReturnType<Device["beginRenderPass"]>) => void;
};

const tex = (
	label: string,
	format: string,
	usage: number,
	samples: number,
): Texture =>
	device.createTexture({
		id: label,
		format,
		usage,
		samples,
		width: SIZE,
		height: SIZE,
	} as never);

function makeTarget(sampleCount: number): Target {
	const RENDER = 0x10;
	const COPY_SRC = 0x01;
	const color = tex(
		`color-${sampleCount}`,
		COLOR_FORMAT,
		RENDER | (sampleCount === 1 ? COPY_SRC : 0),
		sampleCount,
	);
	const depth = tex(`depth-${sampleCount}`, DEPTH_FORMAT, RENDER, sampleCount);
	const resolve =
		sampleCount === 1
			? null
			: tex(`resolve-${sampleCount}`, COLOR_FORMAT, RENDER | COPY_SRC, 1);
	const framebuffer = device.createFramebuffer({
		id: `fbo-${sampleCount}`,
		width: SIZE,
		height: SIZE,
		colorAttachments: [color],
		depthStencilAttachment: depth,
	});
	const readable = resolve ?? color;
	return {
		target: {
			colorFormats: [COLOR_FORMAT],
			depthFormat: DEPTH_FORMAT,
			sampleCount,
		},
		beginPass: () =>
			device.beginRenderPass({
				framebuffer,
				clearColors: [[0.1, 0.2, 0.3, 1]],
				clearDepth: 1,
				...(resolve ? { resolveTargets: [resolve.view] } : {}),
			} as never),
		submit: (pass) => {
			pass.end();
			device.submit();
		},
		pixels: async () => {
			const layout = readable.computeMemoryLayout({});
			const buffer = device.createBuffer({
				usage: 0x08 | 0x01, // COPY_DST | MAP_READ
				byteLength: layout.byteLength,
			});
			readable.readBuffer({}, buffer);
			const data = await buffer.readAsync(0, layout.byteLength);
			buffer.destroy();
			return Uint8Array.from(data);
		},
	};
}

async function renderDirect(target: Target, models: Model[]) {
	const pass = target.beginPass();
	for (const model of models) model.draw(pass);
	target.submit(pass);
	return target.pixels();
}

async function renderBundled(
	target: Target,
	bundle: DrawBundle,
	keys: readonly unknown[],
) {
	const pass = target.beginPass();
	const ok = bundle.execute(pass, keys);
	target.submit(pass);
	if (!ok) throw new Error("bundle was not available");
	return target.pixels();
}

const failures: string[] = [];
const pixelDiff = (a: Uint8Array, b: Uint8Array) => {
	let differing = 0;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
	return differing;
};
const nonBackground = (pixels: Uint8Array) => {
	const background = [26, 51, 77, 255];
	let count = 0;
	for (let i = 0; i < pixels.length; i += 4) {
		if (background.some((value, c) => Math.abs(pixels[i + c] - value) > 1))
			count++;
	}
	return count;
};
const check = (name: string, ok: boolean, detail = "") => {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`);
	if (!ok) failures.push(name);
};

// the draw list: a far red quad and a near green quad overlapping it
const paramsA = makeParams([1, 0, 0, 1], [-0.8, -0.8, 0.4, 0.4], 0.7);
const paramsB = makeParams([0, 1, 0, 1], [-0.3, -0.3, 0.9, 0.9], 0.3);

for (const sampleCount of [1, 4]) {
	const label = `${sampleCount}x`;
	const target = makeTarget(sampleCount);
	const models = [
		makeModel(`A-${label}`, paramsA, sampleCount),
		makeModel(`B-${label}`, paramsB, sampleCount),
	];
	// pipelines compile async on some paths: draw once so draw() never skips inside the encoder
	await renderDirect(target, models);
	const bundle = new DrawBundle(device, `draws-${label}`, target.target, (e) =>
		recordModels(e, models),
	);
	const keys = () => models.flatMap(modelBundleKeys);

	writeParams(paramsA, [1, 0, 0, 1], [-0.8, -0.8, 0.4, 0.4], 0.7);
	writeParams(paramsB, [0, 1, 0, 1], [-0.3, -0.3, 0.9, 0.9], 0.3);
	const direct = await renderDirect(target, models);
	const bundled = await renderBundled(target, bundle, keys());
	check(
		`direct-vs-bundle ${label}`,
		pixelDiff(direct, bundled) === 0 && nonBackground(direct) > 100,
		`${nonBackground(direct)} drawn px, ${pixelDiff(direct, bundled)} differing bytes`,
	);

	// uniform rule: rewrite contents, replay the SAME bundle
	writeParams(paramsB, [1, 1, 0, 1], [-0.5, -0.9, 0.2, 0.9], 0.2);
	const directB = await renderDirect(target, models);
	const bundledB = await renderBundled(target, bundle, keys());
	check(
		`uniform-rule ${label}`,
		pixelDiff(directB, bundledB) === 0 &&
			pixelDiff(direct, bundledB) > 0 &&
			bundle.stats.records === 1,
		`records=${bundle.stats.records} hits=${bundle.stats.hits}`,
	);

	// invalidation: swap model B's uniform buffer for a new one
	const paramsB2 = makeParams([0, 0, 1, 1], [-0.9, 0.0, 0.9, 0.8], 0.1);
	models[1].setBindings({ params: paramsB2 });
	const directC = await renderDirect(target, models);
	bundle.discard();
	models[1].setBindings({ params: paramsB });
	const keysOld = keys();
	await renderBundled(target, bundle, keysOld); // re-record against the old buffer
	models[1].setBindings({ params: paramsB2 });
	const staleOut = await renderBundled(target, bundle, keysOld); // old keys: no re-record
	check(
		`stale-keys-trap ${label}`,
		pixelDiff(staleOut, directC) > 0,
		"identity change without a key change replays the old bind group",
	);
	const fresh = await renderBundled(target, bundle, keys());
	check(
		`invalidation ${label}`,
		pixelDiff(fresh, directC) === 0,
		`records=${bundle.stats.records}`,
	);
	bundle.destroy();
	models[1].setBindings({ params: paramsB });
}

// variants: 1x and 4x in one set, both valid after interleaved use
{
	const target1 = makeTarget(1);
	const target4 = makeTarget(4);
	const models1 = [
		makeModel("sA-1", paramsA, 1),
		makeModel("sB-1", paramsB, 1),
	];
	const models4 = [
		makeModel("sA-4", paramsA, 4),
		makeModel("sB-4", paramsB, 4),
	];
	await renderDirect(target1, models1);
	await renderDirect(target4, models4);
	// the record callback cannot see the target, so a set holds variants of ONE draw list: one set per
	// sample count here (the models' pipelines bake their sample count)
	const set1 = new RenderBundleSet(device, "set1", (e) =>
		recordModels(e, models1),
	);
	const set4 = new RenderBundleSet(device, "set4", (e) =>
		recordModels(e, models4),
	);
	const keys1 = models1.flatMap(modelBundleKeys);
	const keys4 = models4.flatMap(modelBundleKeys);
	const out: Uint8Array[] = [];
	for (let frame = 0; frame < 3; frame++) {
		for (const [s, t, k] of [
			[set1, target1, keys1],
			[set4, target4, keys4],
		] as const) {
			const pass = t.beginPass();
			s.execute(pass, t.target, k);
			t.submit(pass);
			out.push(await t.pixels());
		}
	}
	const d1 = await renderDirect(target1, models1);
	const d4 = await renderDirect(target4, models4);
	check(
		"variants (1x + 4x sets interleaved, 3 frames)",
		pixelDiff(out[4], d1) === 0 &&
			pixelDiff(out[5], d4) === 0 &&
			set1.variant(target1.target).stats.records === 1 &&
			set4.variant(target4.target).stats.records === 1,
		`set1 keys ${set1.size}, set4 keys ${set4.size}`,
	);
	// distinct targets in one set make distinct variants
	const mixed = new RenderBundleSet(device, "mixed", (e) =>
		recordModels(e, models1),
	);
	mixed.variant(target1.target);
	mixed.variant({ ...target1.target, depthReadOnly: true });
	check(
		"variant keys differ by signature",
		mixed.size === 2,
		`size ${mixed.size}`,
	);
}

// incomplete: a recorder that reports a skipped draw is not cached
{
	const target = makeTarget(1);
	let calls = 0;
	const bundle = new DrawBundle(device, "incomplete", target.target, () => {
		calls++;
		return false;
	});
	const first = bundle.get([]);
	const second = bundle.get([]);
	check(
		"incomplete not cached",
		first === null &&
			second === null &&
			calls === 2 &&
			bundle.stats.records === 0,
	);
}

console.log(failures.length ? `FAILED: ${failures.join(", ")}` : "ALL PASS");
process.exit(failures.length ? 1 : 0);
