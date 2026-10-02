// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for layers/pins.ts (the roll map's selection pins).
//   CPU     the instance packing, and the WGSL assembles with the camera + pins bindings and the
//           four instance attributes (no GPU).
//   Dawn    with DAWN_DIR (npm i webgpu@0.3.0 in a scratch dir): renders pins through the real
//           colour pass (hosts/passes.ts runColorPass, 1x rgba16float (reduced mode), reversed-Z) on a Dawn
//           device in node, reads the resolve back and checks the disc / stroke / outline colours
//           (premultiplied linear), the radius, the straddling stroke, and that a pin behind the
//           camera draws nothing. Without DAWN_DIR it prints SKIP for this half and exits 0.
//   DAWN_DIR=/tmp/dawn npx tsx src/lib/deck-webgpu/layers/pins.check.ts
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ShaderAssembler } from "@luma.gl/shadertools";
import type { RollPin } from "#/lib/roll/map/backend";
import { cameraModule } from "../camera";
import { PIN_STRIDE_BYTES, PINS_WGSL, packPins, packRGBA8 } from "./pins";

type Check = { name: string; ok: boolean; detail?: unknown };
const checks: Check[] = [];
const add = (name: string, ok: boolean, detail?: unknown) =>
	checks.push({ name, ok, detail });

const pin = (over: Partial<RollPin>): RollPin => ({
	id: "p",
	position: [0, 100, 0],
	radiusPx: 10,
	fill: [255, 0, 0, 255],
	line: [0, 0, 255, 255],
	lineWidthPx: 4,
	...over,
});

// ---------------------------------------------------------------- CPU
{
	const buf = packPins([pin({}), pin({ radiusPx: 5 })]);
	const f = new Float32Array(buf);
	const u = new Uint32Array(buf);
	add(
		"pack: 2 records of 28 bytes",
		buf.byteLength === 2 * PIN_STRIDE_BYTES &&
			f[3] === 10 &&
			f[4] === 4 &&
			f[10] === 5 &&
			u[5] === packRGBA8([255, 0, 0, 255]) &&
			u[6] === packRGBA8([0, 0, 255, 255]),
	);
}
{
	const { getShaderLayoutFromWGSL } = await import("@luma.gl/webgpu");
	const asm = ShaderAssembler.getDefaultShaderAssembler(
		"wgsl" as never,
	) as unknown as { assembleWGSLShader(p: unknown): { source: string } };
	const pinsModule = {
		name: "pins",
		source:
			"struct PinsUniforms { params: vec4<f32> };\n@group(0) @binding(auto) var<uniform> pins: PinsUniforms;\n",
		uniformTypes: { params: "vec4<f32>" },
		bindingLayout: [{ name: "pins", group: 0 }],
	};
	const r = asm.assembleWGSLShader({
		platformInfo: {
			type: "webgpu",
			shaderLanguage: "wgsl",
			shaderLanguageVersion: 100,
			gpu: "apple",
			features: new Set(),
		},
		source: PINS_WGSL,
		modules: [cameraModule, pinsModule],
	});
	const layout = getShaderLayoutFromWGSL(r.source) as unknown as {
		bindings: { name: string }[];
		attributes: { name: string; location: number }[];
	};
	const names = layout.bindings.map((b) => b.name).sort();
	add("wgsl: bindings camera + pins", names.join() === "camera,pins", names);
	add(
		"wgsl: attributes position/size/fill/line at 0..3",
		["position", "size", "fill", "line"].every(
			(n, i) => layout.attributes.find((a) => a.name === n)?.location === i,
		),
		layout.attributes,
	);
}

// ---------------------------------------------------------------- Dawn
async function gpuPart(dawnDir: string) {
	const { create, globals } = await import(
		pathToFileURL(path.join(dawnDir, "node_modules/webgpu/index.js")).href
	);
	Object.assign(globalThis, globals);
	const gpu = create([]);
	if (!(await gpu.requestAdapter())) throw new Error("no WebGPU adapter");
	Object.defineProperty(globalThis, "navigator", {
		value: { gpu, userAgent: "node" },
		configurable: true,
	});
	const { luma } = await import("@luma.gl/core");
	const { webgpuAdapter } = await import("@luma.gl/webgpu");
	const { cameraUniforms, projectToPixel, worldCamera } = await import(
		"../camera"
	);
	const { runColorPass } = await import("../hosts/passes");
	const { ColorTargets, GeometryTargets } = await import("../targets");
	const { createPins } = await import("./pins");

	const device = await luma.createDevice({
		id: "pins-check",
		type: "webgpu",
		adapters: [webgpuAdapter],
		createCanvasContext: false,
	} as never);
	const errors: string[] = [];
	(device as unknown as { handle: GPUDevice }).handle.addEventListener(
		"uncapturederror",
		(e) => errors.push(String((e as GPUUncapturedErrorEvent).error.message)),
	);
	const W = 320;
	const H = 240;
	const geometry = new GeometryTargets(device, 64, 48);
	const color = new ColorTargets(device, W, H);
	// 1x direct (ColorTargets.setReduced): Dawn-node rejects luma's MSAA resolveTargets texture
	color.setReduced(true);
	const pins = createPins(device);
	pins.setPixelRatio(1);
	const view = worldCamera({
		eye: [0, 0, 0],
		forward: [0, 1, 0],
		up: [0, 0, 1],
		camFov: 50,
		width: W,
		height: H,
	});
	const u = cameraUniforms(view);

	const half = (h: number) => {
		const s = h & 0x8000 ? -1 : 1;
		const e = (h >> 10) & 0x1f;
		const f = h & 0x3ff;
		if (e === 0) return s * 2 ** -14 * (f / 1024);
		if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
		return s * 2 ** (e - 15) * (1 + f / 1024);
	};
	let frame = 0;
	const render = async () => {
		runColorPass({
			device,
			cores: [pins],
			geometry,
			color,
			view,
			frame: { frame: frame++, time: 0, view: "world" },
		});
		device.submit();
		const tex = color.color;
		const layout = tex.computeMemoryLayout();
		const buf = device.createBuffer({
			byteLength: layout.byteLength,
			usage: 0x0001 | 0x0008,
		});
		tex.readBuffer({}, buf);
		const bytes = await buf.readAsync(0, layout.byteLength);
		buf.destroy();
		const u16 = new Uint16Array(
			bytes.buffer,
			bytes.byteOffset,
			layout.byteLength / 2,
		);
		const out = new Float32Array(W * H * 4);
		const stride = layout.bytesPerRow / 2;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W * 4; x++)
				out[y * W * 4 + x] = half(u16[y * stride + x]);
		return out;
	};
	const at = (img: Float32Array, x: number, y: number) =>
		[0, 1, 2, 3].map((k) => Math.round(img[(y * W + x) * 4 + k] * 100) / 100);
	const near = (a: number[], b: number[], tol = 0.05) =>
		a.every((v, i) => Math.abs(v - b[i]) <= tol);

	// pin 1 at screen centre: r 10, lw 4 → outer 12, inner 8; pin 2 behind the camera
	const set1 = [pin({}), pin({ id: "behind", position: [0, -100, 0] })];
	pins.setPins(set1);
	let img = await render();
	const c = projectToPixel(u, [0, 100, 0]);
	if (!c) throw new Error("centre pin not projected");
	const cx = Math.floor(c.x);
	const cy = Math.floor(c.y);
	const centre = at(img, cx, cy);
	add("fill at centre = red", near(centre, [1, 0, 0, 1]), centre);
	const ring = at(img, cx + 10, cy);
	add("stroke at radius = blue (r 8..12)", near(ring, [0, 0, 1, 1]), ring);
	const inFill = at(img, cx + 5, cy);
	add("fill inside the stroke", near(inFill, [1, 0, 0, 1]), inFill);
	const out = at(img, cx + 15, cy);
	add("nothing outside radius + lw/2 + 1", near(out, [0, 0, 0, 0]), out);
	let lit = 0;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			if (img[(y * W + x) * 4 + 3] > 0.01 && Math.hypot(x - cx, y - cy) > 14)
				lit++;
	add("pin behind the camera draws nothing", lit === 0, { lit });

	// translucent fill: premultiplied output, linear decode of sRGB bytes
	pins.setPins([pin({ fill: [128, 128, 128, 128], lineWidthPx: 0 })]);
	img = await render();
	const lin = ((128 / 255 + 0.055) / 1.055) ** 2.4;
	const a = 128 / 255;
	const tr = at(img, cx, cy);
	add(
		"translucent fill premultiplied linear",
		near(tr, [lin * a, lin * a, lin * a, a], 0.03),
		tr,
	);

	// hidden when empty
	pins.setPins([]);
	add("visible() false with no pins", pins.visible() === false);

	await new Promise((r) => setTimeout(r, 50));
	pins.destroy();
	color.destroy();
	geometry.destroy();
	device.destroy();
	add("no GPU errors", errors.length === 0, errors);
}

const dawnDir = process.env.DAWN_DIR;
if (dawnDir) await gpuPart(dawnDir);
else console.log("SKIP pins GPU part: DAWN_DIR is not set");

const ok = checks.every((c) => c.ok);
for (const c of checks)
	console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}`, c.ok ? "" : c.detail);
console.log(
	ok ? `PASS layer-pins${dawnDir ? "" : " (CPU only)"}` : "FAIL layer-pins",
);
// Dawn keeps the event loop alive after device.destroy()
process.exit(ok ? 0 : 1);
