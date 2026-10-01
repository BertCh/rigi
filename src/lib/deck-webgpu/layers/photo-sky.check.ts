// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Checks for layers/photo-sky.ts.
//
// cpuCheck (node): the direction-only projection equals the WebGL layer's photoPos + dir·20 km
// through the absolute photo camera (deck-step.ts PSKY_FS), for random poses, far-off eyes and
// rays.
//   npx tsx src/lib/deck-webgpu/layers/photo-sky.check.ts
//
// gpuCheck (browser, WebGPU): renders PhotoSkyCore alone through the real colour pass
// (runOffscreenPasses, view 'world') into a small ColorTargets, reads the resolved rgba16float
// back and compares with a CPU model of the shader: photo on the Sky pixels, premultiplied,
// transparent elsewhere; an opaque occluder drawn earlier (depth 0.5) must stay untouched (the
// depth-0 sky trick); nothing is drawn in the photo view. Drive it from a page on the dev server:
//   await (await import('/src/lib/deck-webgpu/layers/photo-sky.check.ts')).gpuCheck()
import type { Device, Texture } from "@luma.gl/core";
import { Model } from "@luma.gl/engine";
import type { Vec3 } from "#/lib/ontology/core/geometry";
import {
	type CameraUniforms,
	cameraUniforms,
	photoCamera,
	projectToPixel,
} from "../camera";
import type { FrameState, GpuLayerCore, PassContext } from "../pass";
import { passModelProps } from "../pass";
import { PhotoSkyCore, photoSkyUv } from "./photo-sky";

export function cpuCheck() {
	let seed = 7;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	let maxErr = 0;
	let compared = 0;
	let behindAgree = 0;
	for (let k = 0; k < 4000; k++) {
		const pose = {
			yaw: rnd() * 360,
			pitch: (rnd() - 0.5) * 60,
			roll: (rnd() - 0.5) * 20,
			vfov: 20 + rnd() * 60,
		};
		const eye: Vec3 = [
			(rnd() - 0.5) * 2e5,
			(rnd() - 0.5) * 2e5,
			500 + rnd() * 4000,
		];
		const W = 1024;
		const H = Math.round(1024 / (0.5 + rnd() * 1.5));
		const u = cameraUniforms(photoCamera({ pose, eye, width: W, height: H }));
		const d: Vec3 = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
		const l = Math.hypot(...d);
		const dir: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
		const a = photoSkyUv(u, dir);
		const b = projectToPixel(u, [
			eye[0] + dir[0] * 20000,
			eye[1] + dir[1] * 20000,
			eye[2] + dir[2] * 20000,
		]);
		if (!a || !b) {
			if (!a && !b) behindAgree++;
			else throw new Error(`front/behind disagree at ${k}`);
			continue;
		}
		// compare in uv near the frame (far outside is feathered away anyway)
		if (a.u < -0.1 || a.u > 1.1 || a.v < -0.1 || a.v > 1.1) continue;
		const err = Math.max(Math.abs(a.u - b.x / W), Math.abs(a.v - b.y / H));
		maxErr = Math.max(maxErr, err);
		compared++;
	}
	const ok = maxErr < 1e-9 && compared > 100;
	return { ok, compared, behindAgree, maxErrUv: maxErr };
}

// ---------------------------------------------------------------- GPU

/** Opaque green triangle over the lower-left quadrant at reversed-Z depth 0.5 (an "earlier"
 * surface the sky passes must not overwrite). */
class OccluderCore implements GpuLayerCore {
	readonly id = "psky-check-occluder";
	readonly passes = ["color"] as const;
	readonly order = 10;
	private model: Model | null = null;
	draw(ctx: PassContext) {
		this.model ??= new Model(ctx.device, {
			id: this.id,
			source: /* wgsl */ `\
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  // (-1,-1), (1,-1), (-1,1) scaled into the lower-left quadrant: (-1,-1), (0,-1), (-1,0) ×2 → covers it
  let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u)) - 1.0;
  return vec4<f32>(p, 0.5, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(0.0, 1.0, 0.0, 1.0); }
`,
			vertexEntryPoint: "vs",
			fragmentEntryPoint: "fs",
			topology: "triangle-list",
			vertexCount: 3,
			bufferLayout: [],
			...passModelProps("color"),
		} as never);
		this.model.draw(ctx.renderPass);
	}
	destroy() {
		this.model?.destroy();
	}
}

function f16(h: number) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (m / 1024);
	if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + m / 1024);
}

async function readRgba16f(device: Device, tex: Texture) {
	const gd = (device as unknown as { handle: GPUDevice }).handle;
	const gt = (tex as unknown as { handle: GPUTexture }).handle;
	const bpr = Math.ceil((tex.width * 8) / 256) * 256;
	const buf = gd.createBuffer({
		size: bpr * tex.height,
		usage: 0x0008 | 0x0001, // COPY_DST | MAP_READ
	});
	const enc = gd.createCommandEncoder();
	enc.copyTextureToBuffer(
		{ texture: gt },
		{ buffer: buf, bytesPerRow: bpr },
		{ width: tex.width, height: tex.height },
	);
	gd.queue.submit([enc.finish()]);
	await buf.mapAsync(0x0001); // GPUMapMode.READ
	const raw = new Uint16Array(buf.getMappedRange().slice(0));
	buf.destroy();
	const out = new Float32Array(tex.width * tex.height * 4);
	for (let y = 0; y < tex.height; y++)
		for (let x = 0; x < tex.width * 4; x++)
			out[y * tex.width * 4 + x] = f16(raw[(y * bpr) / 2 + x]);
	return out;
}

const srgbToLinear = (c: number) =>
	c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** CPU camera_ray for pixel centre (x, y) of the view target (row 0 = top). */
function viewRay(u: CameraUniforms, x: number, y: number): Vec3 {
	const nx = ((x + 0.5) / u.viewport[0]) * 2 - 1 - u.offset[0];
	const ny = 1 - ((y + 0.5) / u.viewport[1]) * 2 - u.offset[1];
	const d: Vec3 = [0, 0, 0];
	for (let i = 0; i < 3; i++)
		d[i] =
			u.forward[i] + nx * u.tanHalfX * u.right[i] + ny * u.tanHalfY * u.up[i];
	const l = Math.hypot(...d);
	return [d[0] / l, d[1] / l, d[2] / l];
}

export async function gpuCheck() {
	const [{ createRenderDevice }, { ColorTargets, GeometryTargets }, passes] =
		await Promise.all([
			import("../device"),
			import("../targets"),
			import("../hosts/passes"),
		]);
	const canvas = document.createElement("canvas");
	canvas.width = canvas.height = 4;
	document.body.appendChild(canvas);
	const device = await createRenderDevice(canvas, { useDevicePixels: 1 });
	const errors: string[] = [];
	const gd = (device as unknown as { handle: GPUDevice }).handle;
	gd.addEventListener("uncapturederror", (e) =>
		errors.push(String((e as GPUUncapturedErrorEvent).error.message)),
	);

	// photo 64×48: left half red, right half blue (sRGB 255); sky mask: top half
	const PW = 64;
	const PH = 48;
	const photo = document.createElement("canvas");
	photo.width = PW;
	photo.height = PH;
	const g2 = photo.getContext("2d") as CanvasRenderingContext2D;
	g2.fillStyle = "#ff0000";
	g2.fillRect(0, 0, PW / 2, PH);
	g2.fillStyle = "#0000ff";
	g2.fillRect(PW / 2, 0, PW / 2, PH);
	const maskData = new Uint8Array(PW * PH);
	for (let y = 0; y < PH / 2; y++) maskData.fill(255, y * PW, (y + 1) * PW);

	const pose = { yaw: 30, pitch: 5, roll: 0, vfov: 40 };
	const eye: Vec3 = [1000, -2000, 800];
	const photoCam = cameraUniforms(
		photoCamera({ pose, eye, width: 1024, height: 768 }),
	);
	const psky = new PhotoSkyCore("psky-check");
	psky.setPhoto(photo);
	psky.setSkyMask({ width: PW, height: PH, data: maskData });
	psky.setPhotoCamera(photoCam);
	const occ = new OccluderCore();

	const W = 160;
	const H = 120;
	const color = new ColorTargets(device, W, H, "psky-check");
	const geometry = new GeometryTargets(device, 64, 48);
	// view: a world camera turned a little right and up from the photo camera with a wider FOV,
	// so frame edges and feather are in shot; a different eye (direction-only: must not matter)
	const viewPose = { yaw: 36, pitch: 8, roll: 0, vfov: 60 };
	const viewEye: Vec3 = [1500, -1500, 900];
	const view = {
		...photoCamera({ pose: viewPose, eye: viewEye, width: W, height: H }),
		near: 5,
	};
	const viewU = cameraUniforms(view);
	const timing = { geometryMs: 0, colorMs: 0, screenMs: 0 };
	const run = (v: FrameState["view"]) => {
		passes.runOffscreenPasses({
			device,
			cores: [occ, psky],
			geometry,
			color,
			photo: photoCamera({ pose, eye, width: 1, height: 1 }),
			view,
			frame: { frame: 0, time: performance.now(), view: v },
			timing,
		});
		device.submit();
	};

	run("world");
	const img = await readRgba16f(device, color.color);
	run("photo");
	const imgPhoto = await readRgba16f(device, color.color);

	// CPU model, skipping pixels near texel boundaries (mask edge, colour edge, frame feather)
	// and the occluder's diagonal edge
	const red = [srgbToLinear(1), 0, 0];
	const blue = [0, 0, srgbToLinear(1)];
	const inOcc = (x: number, y: number) => {
		// lower-left triangle (-1,-1),(1,-1),(-1,1) in NDC: nx + ny <= 0
		const nx = ((x + 0.5) / W) * 2 - 1;
		const ny = 1 - ((y + 0.5) / H) * 2;
		return nx + ny;
	};
	let checked = 0;
	let maxErr = 0;
	let skyIn = 0;
	let occluded = 0;
	const bad: unknown[] = [];
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const k = (y * W + x) * 4;
			const got = [img[k], img[k + 1], img[k + 2], img[k + 3]];
			const o = inOcc(x, y);
			if (Math.abs(o) < 0.05) continue;
			let want: number[] | null;
			if (o < 0) {
				want = [0, 1, 0, 1];
				occluded++;
			} else {
				const p = photoSkyUv(photoCam, viewRay(viewU, x, y));
				if (!p) want = [0, 0, 0, 0];
				else {
					const e = Math.min(p.u, 1 - p.u, p.v, 1 - p.v);
					const px = p.u * PW;
					const py = p.v * PH;
					const nearEdge =
						(e > -0.03 && e < 0.01) ||
						(e >= 0 && Math.abs(py - PH / 2) < 1.5) ||
						(e >= 0 && Math.abs(px - PW / 2) < 1.5);
					if (nearEdge) want = null;
					else if (e < 0 || py > PH / 2) want = [0, 0, 0, 0];
					else {
						want = [...(px < PW / 2 ? red : blue), 1];
						skyIn++;
					}
				}
			}
			if (!want) continue;
			const err = Math.max(...want.map((w, i) => Math.abs(w - got[i])));
			maxErr = Math.max(maxErr, err);
			checked++;
			if (err > 0.01 && bad.length < 8)
				bad.push({ x, y, want, got: got.map((v) => +v.toFixed(3)) });
		}
	// photo view: the core must draw nothing (only the occluder)
	let photoViewMaxAlpha = 0;
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			if (inOcc(x, y) > 0.05)
				photoViewMaxAlpha = Math.max(
					photoViewMaxAlpha,
					Math.abs(imgPhoto[(y * W + x) * 4 + 3]),
				);
	psky.destroy();
	occ.destroy();
	color.destroy();
	geometry.destroy();
	device.destroy();
	canvas.remove();
	const ok =
		!errors.length &&
		maxErr <= 0.01 &&
		skyIn > 500 &&
		occluded > 0 &&
		photoViewMaxAlpha === 0;
	return {
		ok,
		checked,
		skyIn,
		occluded,
		maxErr,
		photoViewMaxAlpha,
		bad,
		errors,
	};
}

if (typeof window === "undefined") {
	const r = cpuCheck();
	console.log(JSON.stringify(r));
	if (!r.ok) process.exit(1);
}
