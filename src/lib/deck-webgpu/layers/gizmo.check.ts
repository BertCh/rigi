// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// In-browser check for layers/gizmo.ts on a bare luma WebGPU device (no canvas, no deck, no
// terrain): renders the colour pass with the gizmo (and an invisible depth-only "wall") through a
// world camera, reads the resolved colour target back and compares pixels with the CPU
// projection (camera.ts projectToPixel).
//   const {runGizmoCheck} = await import("/src/lib/deck-webgpu/layers/gizmo.check.ts");
//   await runGizmoCheck()   // → {ok, checks: [...], errors: [...]}
// Run it in any page of the dev server under real-GPU Chromium (render lock).
import { type Device, luma } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { webgpuAdapter } from "@luma.gl/webgpu";
import type { Pose } from "#/lib/camera";
import { poseBasis } from "#/lib/camera";
import { cameraUniforms, projectToPixel, worldCamera } from "../camera";
import { runColorPass } from "../hosts/passes";
import {
	type GpuLayerCore,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";
import { ColorTargets, GeometryTargets } from "../targets";
import { createGizmoCore, linearRGBA } from "./gizmo";

type V3 = [number, number, number];

/** A full-screen, colourless quad at a fixed view depth that only writes depth (an occluder). */
class WallCore implements GpuLayerCore {
	readonly id = "wall";
	readonly passes: readonly PassKind[] = ["color"];
	readonly order = 0;
	viewDepth = 0;
	private model?: Model;
	visible() {
		return this.viewDepth > 0;
	}
	draw(ctx: PassContext) {
		this.model ??= new Model(ctx.device, {
			id: "wall",
			source: /* wgsl */ `\
struct WallUniforms { depth: f32, pad0: f32, pad1: f32, pad2: f32 };
@group(0) @binding(auto) var<uniform> wall: WallUniforms;
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  return vec4<f32>(p, wall.depth, 1.0);
}
@fragment fn fragmentMain() -> @location(0) vec4<f32> { return vec4<f32>(0.0); }
`,
			vertexEntryPoint: "vertexMain",
			fragmentEntryPoint: "fragmentMain",
			modules: [
				{
					name: "wall",
					uniformTypes: {
						depth: "f32",
						pad0: "f32",
						pad1: "f32",
						pad2: "f32",
					},
					bindingLayout: [{ name: "wall", group: 0 }],
				},
			] as never,
			vertexCount: 3,
			bufferLayout: [],
			...passModelProps("color", { depth: "write", blend: true }),
		} as never);
		this.model.shaderInputs.setProps({
			wall: {
				depth: Math.min(1, ctx.camera.near / this.viewDepth),
				pad0: 0,
				pad1: 0,
				pad2: 0,
			},
		} as never);
		this.model.draw(ctx.renderPass);
	}
	destroy() {
		this.model?.destroy();
	}
}

function halfToFloat(h: number) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (f / 1024);
	if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** rgba16float texture → Float32Array rgba, top-first rows. */
async function readRGBA16F(device: Device, tex: ColorTargets["color"]) {
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		id: "gizmo-check-read",
		byteLength: layout.byteLength,
		usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
	});
	tex.readBuffer({}, buf);
	const bytes = await buf.readAsync(0, layout.byteLength);
	buf.destroy();
	const u16 = new Uint16Array(
		bytes.buffer,
		bytes.byteOffset,
		layout.byteLength / 2,
	);
	const out = new Float32Array(tex.width * tex.height * 4);
	const stride = layout.bytesPerRow / 2;
	for (let y = 0; y < tex.height; y++)
		for (let x = 0; x < tex.width * 4; x++)
			out[y * tex.width * 4 + x] = halfToFloat(u16[y * stride + x]);
	return out;
}

/** A 64×48 photo: top half red, bottom half blue (checks the plane's orientation). */
function testPhoto() {
	const c = new OffscreenCanvas(64, 48);
	const g = c.getContext("2d") as OffscreenCanvasRenderingContext2D;
	g.fillStyle = "#ff0000";
	g.fillRect(0, 0, 64, 24);
	g.fillStyle = "#0000ff";
	g.fillRect(0, 24, 64, 24);
	return c;
}

type Check = { name: string; ok: boolean; detail: unknown };

export async function runGizmoCheck(
	opts: { width?: number; height?: number } = {},
) {
	const W = opts.width ?? 640;
	const H = opts.height ?? 400;
	const device = await luma.createDevice({
		id: "gizmo-check",
		type: "webgpu",
		adapters: [webgpuAdapter],
	} as never);
	const errors: string[] = [];
	const gpu = (device as unknown as { handle: GPUDevice }).handle;
	gpu.addEventListener("uncapturederror", (e) =>
		errors.push(String((e as GPUUncapturedErrorEvent).error.message)),
	);
	const geometry = new GeometryTargets(device, 64, 48);
	const color = new ColorTargets(device, W, H);
	const pose: Pose = { yaw: 30, pitch: -2, roll: 3, vfov: 40 };
	const eye: V3 = [100, 200, 1500];
	const pinColor: [number, number, number, number] = [255, 85, 51, 255];
	const lineColor: [number, number, number, number] = [255, 255, 255, 230];
	const gizmo = createGizmoCore(device, {
		view: "world",
		pose,
		eye,
		aspect: 4 / 3,
		image: testPhoto(),
		planeOpacity: 0.95,
		pinColor,
		lineColor,
		pinRadiusM: 18,
		lineWidthPx: 3,
		pixelRatio: 1,
	});
	const wall = new WallCore();
	const cores = [wall, gizmo];
	const { forward } = poseBasis(pose);
	const f: V3 = [forward[0], forward[1], 0];
	const fl = Math.hypot(f[0], f[1]);
	f[0] /= fl;
	f[1] /= fl;
	const camEye: V3 = [eye[0] - f[0] * 400, eye[1] - f[1] * 400, eye[2] + 150];
	const look: V3 = [eye[0] + f[0] * 75, eye[1] + f[1] * 75, eye[2]];
	const fwd: V3 = [
		look[0] - camEye[0],
		look[1] - camEye[1],
		look[2] - camEye[2],
	];
	const view = worldCamera({
		eye: camEye,
		forward: fwd,
		up: [0, 0, 1],
		camFov: 55,
		width: W,
		height: H,
	});
	const u = cameraUniforms(view);
	let frame = 0;
	const render = async () => {
		runColorPass({
			device,
			cores,
			geometry,
			color,
			view,
			frame: { frame: frame++, time: performance.now(), view: "world" },
		});
		device.submit();
		return readRGBA16F(device, color.color);
	};
	const px = (img: Float32Array, p: V3) => {
		const q = projectToPixel(u, p);
		if (!q) return null;
		const x = Math.floor(q.x);
		const y = Math.floor(q.y);
		const i = (y * W + x) * 4;
		return {
			x,
			y,
			rgba: [img[i], img[i + 1], img[i + 2], img[i + 3]].map(
				(v) => Math.round(v * 1000) / 1000,
			),
		};
	};
	const near = (a: number[], b: number[], tol = 0.03) =>
		a.every((v, i) => Math.abs(v - b[i]) <= tol);
	const checks: Check[] = [];
	const c = gizmo.corners() as [V3, V3, V3, V3];
	const lerp = (a: V3, b: V3, t: number): V3 => [
		a[0] + (b[0] - a[0]) * t,
		a[1] + (b[1] - a[1]) * t,
		a[2] + (b[2] - a[2]) * t,
	];
	const topMid = lerp(c[0], c[1], 0.5);
	const botMid = lerp(c[3], c[2], 0.5);

	// 1. no wall: pin, plane (orientation), edge
	let img = await render();
	const pin = linearRGBA(pinColor);
	const pinPx = px(img, eye);
	checks.push({
		name: "pin centre = pin colour (opaque)",
		ok: !!pinPx && near(pinPx.rgba, [pin[0], pin[1], pin[2], 1]),
		detail: { pinPx, want: pin },
	});
	const up = px(img, lerp(topMid, botMid, 0.25));
	checks.push({
		name: "plane upper quarter = red × 0.95 (premultiplied)",
		ok: !!up && near(up.rgba, [0.95, 0, 0, 0.95]),
		detail: up,
	});
	const lo = px(img, lerp(topMid, botMid, 0.6));
	checks.push({
		name: "plane lower half (clear of the pin) = blue × 0.95",
		ok: !!lo && near(lo.rgba, [0, 0, 0.95, 0.95]),
		detail: lo,
	});
	// edges and the pin alone (no plane under them)
	gizmo.setProps({ image: null });
	img = await render();
	const edge = px(img, lerp(eye, c[1], 0.5));
	const la = lineColor[3] / 255;
	checks.push({
		name: "frustum edge eye→tr midpoint = line colour",
		ok: !!edge && near(edge.rgba, [la, la, la, la], 0.05),
		detail: edge,
	});
	// the pin's size: radius px = 18 · fy · H/2 / distance
	const dist = Math.hypot(
		eye[0] - camEye[0],
		eye[1] - camEye[1],
		eye[2] - camEye[2],
	);
	const rPx = (18 * (H / 2)) / Math.tan((55 * Math.PI) / 360) / dist;
	if (pinPx) {
		const inside = (dx: number) =>
			img[(pinPx.y * W + pinPx.x + dx) * 4 + 3] ?? 0;
		const edgeIn = inside(Math.floor(rPx) - 2);
		const edgeOut = inside(Math.ceil(rPx) + 2);
		checks.push({
			name: "pin radius from the camera distance",
			ok: edgeIn > 0.99 && edgeOut < 0.5,
			detail: { rPx, edgeIn, edgeOut },
		});
	}

	gizmo.setProps({ image: testPhoto() });

	// 2. a wall in front of everything (half-way to the pin) hides the gizmo
	wall.viewDepth =
		(u.forward[0] * (eye[0] - camEye[0]) +
			u.forward[1] * (eye[1] - camEye[1]) +
			u.forward[2] * (eye[2] - camEye[2])) *
		0.5;
	img = await render();
	let maxA = 0;
	for (let i = 3; i < img.length; i += 4) maxA = Math.max(maxA, img[i]);
	checks.push({
		name: "occluded by nearer depth (reversed-Z test)",
		ok: maxA < 0.01,
		detail: { maxAlpha: maxA },
	});

	// 3. a wall far behind changes nothing
	wall.viewDepth = 50_000;
	img = await render();
	const pinFar = px(img, eye);
	checks.push({
		name: "far wall: pin still drawn",
		ok: !!pinFar && near(pinFar.rgba, [pin[0], pin[1], pin[2], 1]),
		detail: pinFar,
	});
	wall.viewDepth = 0;

	// 4. photo view: hidden
	gizmo.setProps({ view: "photo" });
	checks.push({
		name: "visible() false in the photo view",
		ok: gizmo.visible() === false,
		detail: null,
	});
	gizmo.setProps({ view: "world", planeOpacity: 0.01 });
	checks.push({
		name: "visible() false once the plane faded (≤ 0.02)",
		ok: gizmo.visible() === false,
		detail: null,
	});
	gizmo.setProps({ planeOpacity: 0.95 });

	// 5. camera inside the frustum (eye edges start behind the camera): near clipping must keep
	// the edges sane: no NaN / no pixel outside the frame's convex region lit by full-screen quads
	const inside = worldCamera({
		eye: [eye[0] + f[0] * 20, eye[1] + f[1] * 20, eye[2]],
		forward: [forward[0], forward[1], forward[2]],
		up: [0, 0, 1],
		camFov: 55,
		width: W,
		height: H,
	});
	runColorPass({
		device,
		cores,
		geometry,
		color,
		view: inside,
		frame: { frame: frame++, time: performance.now(), view: "world" },
	});
	device.submit();
	img = await readRGBA16F(device, color.color);
	let nan = 0;
	let lit = 0;
	for (let i = 0; i < img.length; i += 4) {
		if (!Number.isFinite(img[i + 3])) nan++;
		if (img[i + 3] > 0.01) lit++;
	}
	const plane = lit / (W * H);
	checks.push({
		name: "camera inside the frustum: finite, plane fills most of the frame",
		ok: nan === 0 && plane > 0.3,
		detail: { nan, litFraction: Math.round(plane * 1000) / 1000 },
	});

	await new Promise((r) => setTimeout(r, 50));
	gizmo.destroy();
	wall.destroy();
	color.destroy();
	geometry.destroy();
	device.destroy();
	return {
		ok: errors.length === 0 && checks.every((k) => k.ok),
		checks,
		errors,
	};
}
