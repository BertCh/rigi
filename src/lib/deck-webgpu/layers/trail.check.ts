// In-browser isolation check for layers/trail.ts (no lab, no region data). Renders synthetic
// segments through the real colour pass (hosts/passes.ts runColorPass: 4× MSAA rgba16float,
// reversed-Z, resolve) next to an opaque occluder wall, reads the resolve back and checks:
//   position   the trail lands on the CPU projection (camera.ts projectToPixel)
//   colour     premultiplied (rgb·a, a) = (colour·opacity, opacity)
//   width      Σ alpha / opacity across the line ≈ style.width target pixels
//   occlusion  a trail behind the wall is hidden; a trail lying ON the wall shows (depth nudge)
//   near       a segment crossing the near plane draws no NaN / screen-filling garbage
// Run from a page served by vite (any route), e.g. with playwright:
//   await page.evaluate(async () => (await import("/src/lib/deck-webgpu/layers/trail.check.ts")).runTrailCheck())
import { type Device, luma, type Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import { webgpuAdapter } from "@luma.gl/webgpu";
import { cameraModule, projectToPixel } from "../camera";
import { camerasFor, runColorPass } from "../hosts/passes";
import {
	type GpuLayerCore,
	type PassContext,
	type PassKind,
	passModelProps,
} from "../pass";
import { ColorTargets, GeometryTargets } from "../targets";
import { TrailCore, type TrailSegments } from "./trail";

type V3 = [number, number, number];

/** Opaque wall in the plane y = WALL_Y, x ∈ [-1000, 0], z ∈ [-200, 300], blue. */
const WALL_Y = 500;
class WallCore implements GpuLayerCore {
	readonly id = "wall";
	readonly passes: readonly PassKind[] = ["color"];
	readonly order = 0;
	private model: Model;
	constructor(device: Device) {
		this.model = new Model(device, {
			id: "trail-check-wall",
			source: /* wgsl */ `\
var<private> P = array<vec2<f32>, 6>(
  vec2<f32>(-1000.0, -200.0), vec2<f32>(0.0, -200.0), vec2<f32>(0.0, 300.0),
  vec2<f32>(-1000.0, -200.0), vec2<f32>(0.0, 300.0), vec2<f32>(-1000.0, 300.0),
);
@vertex fn vertexMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  let q = P[i];
  return camera_clip(vec3<f32>(q.x, ${WALL_Y.toFixed(1)}, q.y));
}
@fragment fn fragmentMain() -> @location(0) vec4<f32> {
  return vec4<f32>(0.0, 0.0, 1.0, 1.0);
}
`,
			modules: [cameraModule] as never,
			...passModelProps("color", { depth: "write" }),
			topology: "triangle-list",
			vertexCount: 6,
		} as never);
	}
	draw(ctx: PassContext) {
		this.model.shaderInputs.setProps({ camera: ctx.camera } as never);
		this.model.draw(ctx.renderPass);
	}
	destroy() {
		this.model.destroy();
	}
}

function segments(list: { a: V3; b: V3; c: V3 }[]): TrailSegments {
	const positions = new Float32Array(list.length * 6);
	const colors = new Float32Array(list.length * 3);
	list.forEach((s, i) => {
		positions.set([...s.a, ...s.b], i * 6);
		colors.set(s.c, i * 3);
	});
	return {
		positions,
		colors,
		classes: new Uint8Array(list.length),
		count: list.length,
	};
}

function half(h: number) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (f / 1024);
	if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** rgba16float texture → Float32Array rgba, top-first rows. */
async function readRgba16f(device: Device, tex: Texture) {
	const layout = tex.computeMemoryLayout();
	const buf = device.createBuffer({
		byteLength: layout.byteLength,
		usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
	});
	tex.readBuffer({}, buf);
	const bytes = await buf.readAsync(0, layout.byteLength);
	buf.destroy();
	const u16 = new Uint16Array(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength / 2,
	);
	const out = new Float32Array(tex.width * tex.height * 4);
	const stride = layout.bytesPerRow / 2;
	for (let y = 0; y < tex.height; y++)
		for (let x = 0; x < tex.width * 4; x++)
			out[y * tex.width * 4 + x] = half(u16[y * stride + x]);
	return out;
}

export type TrailCheck = {
	ok: boolean;
	checks: Record<string, { ok: boolean; [k: string]: unknown }>;
	stats: TrailCore["stats"];
};

export async function runTrailCheck(
	opts: { width?: number; height?: number; lineWidth?: number } = {},
): Promise<TrailCheck> {
	const W = opts.width ?? 320;
	const H = opts.height ?? 200;
	const lineWidth = opts.lineWidth ?? 6;
	const opacity = 0.95;
	const device = await luma.createDevice({
		id: "trail-check",
		type: "webgpu",
		adapters: [webgpuAdapter],
	} as never);
	const color = new ColorTargets(device, W, H, "trail-check-color");
	const geometry = new GeometryTargets(device, 16, 16, "trail-check-geometry");
	const wall = new WallCore(device);
	const trails = new TrailCore(device, "trail-check");
	trails.setStyle({ width: lineWidth, opacity });
	const RED: V3 = [1, 0, 0];
	const GREEN: V3 = [0, 1, 0];
	const WHITE: V3 = [1, 1, 1];
	trails.setSegments(
		segments([
			// east-west at 1 km north, 20 m up: left half behind the wall, right half in the open
			{ a: [-400, 1000, 20], b: [400, 1000, 20], c: RED },
			// lying ON the wall face (same depth as the wall): must show through the nudge
			{ a: [-300, WALL_Y, 150], b: [-100, WALL_Y, 150], c: GREEN },
			// crossing the near plane (starts behind the camera), low right
			{ a: [30, -50, -30], b: [60, 300, -30], c: WHITE },
		]),
	);
	const view = {
		eye: [0, 0, 0] as V3,
		forward: [0, 1, 0] as V3,
		up: [0, 0, 1] as V3,
		vfov: 40,
		near: 1,
	};
	runColorPass({
		device,
		cores: [wall, trails],
		geometry,
		color,
		view,
		frame: { frame: 0, time: performance.now(), view: "photo" },
	});
	device.submit();
	const px = await readRgba16f(device, color.color);
	const cam = camerasFor(view, W, H);
	const at = (x: number, y: number) => {
		const i = (Math.round(y) * W + Math.round(x)) * 4;
		return [px[i], px[i + 1], px[i + 2], px[i + 3]];
	};
	/** Σ alpha down the column through (x, y) within ±r rows. */
	const columnAlpha = (x: number, y: number, r = 12) => {
		let s = 0;
		for (let dy = -r; dy <= r; dy++) {
			const yy = Math.round(y) + dy;
			if (yy >= 0 && yy < H) s += px[(yy * W + Math.round(x)) * 4 + 3];
		}
		return s;
	};
	/** The pixel within ±r rows of (x, y) with the largest channel `ch` (thin lines: the row the
	 * line fully covers; partial MSAA coverage scales a premultiplied pixel as a whole). */
	const peak = (x: number, y: number, ch: number, r = 3) => {
		let best = at(x, y);
		for (let dy = -r; dy <= r; dy++) {
			const yy = Math.round(y) + dy;
			if (yy < 0 || yy >= H) continue;
			const c = at(x, yy);
			if (c[ch] > best[ch]) best = c;
		}
		return best;
	};
	const checks: TrailCheck["checks"] = {};

	// position + premultiplied colour, open part of the red trail
	const pOpen = projectToPixel(cam, [200, 1000, 20]);
	if (!pOpen) throw new Error("projection failed");
	const cOpen = peak(pOpen.x, pOpen.y, 3);
	checks.colour = {
		ok:
			Math.abs(cOpen[3] - opacity) < 0.02 &&
			Math.abs(cOpen[0] - opacity) < 0.02 &&
			cOpen[1] < 0.01 &&
			cOpen[2] < 0.01,
		pixel: [pOpen.x, pOpen.y],
		rgba: cOpen,
	};
	// width: Σ alpha / opacity across the line = its width in target pixels (MSAA coverage)
	const w = columnAlpha(pOpen.x, pOpen.y) / opacity;
	checks.width = {
		ok: Math.abs(w - lineWidth) < 0.6,
		measured: w,
		want: lineWidth,
	};
	// occlusion: the red trail behind the wall is not visible (wall blue, alpha 1)
	const pHid = projectToPixel(cam, [-200, 1000, 20]);
	const cHid = pHid ? at(pHid.x, pHid.y) : [Number.NaN];
	checks.occluded = {
		ok: !!pHid && cHid[0] < 0.01 && cHid[2] > 0.99,
		rgba: cHid,
	};
	// on-surface: green trail on the wall face shows (premultiplied over opaque blue)
	const pOn = projectToPixel(cam, [-200, WALL_Y, 150]);
	const cOn = pOn ? peak(pOn.x, pOn.y, 1) : [Number.NaN];
	checks.onSurface = {
		ok:
			!!pOn &&
			Math.abs(cOn[1] - opacity) < 0.03 &&
			Math.abs(cOn[2] - (1 - opacity)) < 0.03,
		rgba: cOn,
	};
	// near-plane crossing: finite everywhere, bounded coverage, and the far end is drawn
	let nan = 0;
	let covered = 0;
	for (let i = 0; i < W * H; i++) {
		const a = px[i * 4 + 3];
		if (!Number.isFinite(a) || !Number.isFinite(px[i * 4])) nan++;
		if (a > 0.01) covered++;
	}
	const pFar = projectToPixel(cam, [55, 250, -30]);
	const cFar = pFar ? at(pFar.x, pFar.y) : [Number.NaN];
	checks.nearPlane = {
		ok: nan === 0 && covered < W * H * 0.6 && cFar[3] > 0.5,
		nan,
		coveredFrac: covered / (W * H),
		farEnd: cFar,
	};
	// sky (nothing drawn) stays (0,0,0,0)
	const sky = at(W - 3, 3);
	checks.sky = { ok: sky.every((v) => v === 0), rgba: sky };

	const stats = { ...trails.stats };
	trails.destroy();
	wall.destroy();
	color.destroy();
	geometry.destroy();
	device.destroy();
	return {
		ok: Object.values(checks).every((c) => c.ok),
		checks,
		stats,
	};
}
