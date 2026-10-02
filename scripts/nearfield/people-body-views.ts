// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// People completion with a fitted body (src/lib/body) on the landing's baked Step Inside scene (public/demo/step,
// IMG_7086), next to the inflation-only completion (src/lib/nearfield/complete/people.ts): ViTPose-B on src/lib/nn
// (CPU backend in node; the GPU backend over Dawn when DAWN_DIR is set), an Anny fit per person, the far surface of the
// fitted mesh as people.ts' back depth. CPU Gaussian rasteriser as in scripts/nearfield/people-complete-views.ts.
//
//   [DAWN_DIR=/tmp/dawn] npx tsx scripts/nearfield/people-body-views.ts [--out=out/people-body]
//
// Writes <out>/sheet.ppm (rows: before / inflation / body; columns azimuth 0 = photo eye, 35, 70, 110, 180) and
// <out>/fit.ppm (left: the photo with the keypoints (green used, red ignored), the COCO skeleton, the fitted mesh's
// edges and keypoints (dark blue) projected; right: two top-down slices through the grid at chest, waist and thigh height,
// camera x → right and depth → up, grid 10 cm: observed front z (grey), inflation back (green), fitted mesh near
// (blue) and far (orange) surface). Convert with `sips -s format png`. --no-sheet skips the (slow) contact sheet.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ANNY_FILE, annyFromBytes } from "#/lib/body/anny";
import {
	boxesFromInstances,
	prepareBodyBackDepth,
} from "#/lib/body/back-depth";
import { rasterDepthRange } from "#/lib/body/raster";
import type { RgbaImage } from "#/lib/body/vitpose";
import {
	completePeople,
	type PersonGridInstance,
} from "#/lib/nearfield/complete/people";
import { intrinsicsFromPose } from "#/lib/nearfield/geom";
import { camToEnuMatrix } from "#/lib/nearfield/lift";
import { selectSplats } from "#/lib/nearfield/provenance";
import { decodeSplatV1 } from "#/lib/nearfield/splat-io";
import type { GaussianCloud } from "#/lib/nearfield/types";
import { createNn } from "#/lib/nn";

const ROOT = resolve(import.meta.dirname, "../..");
const arg = (k: string, d: string) =>
	process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const OUT = resolve(ROOT, arg("out", "out/people-body"));
const PERSON_MAX_Z = Number(arg("personMaxZ", "7"));
mkdirSync(OUT, { recursive: true });

const scene = JSON.parse(
	readFileSync(join(ROOT, "public/demo/step/scene.json"), "utf8"),
);
const buf = readFileSync(join(ROOT, "public/demo/step/splats.splat"));
const cloud = decodeSplatV1(
	buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
) as GaussianCloud;
const pose = { ...scene.pose };
const eye = scene.eye as { x: number; y: number; z: number };
const aspect = scene.photo.width / scene.photo.height;
const K = intrinsicsFromPose(pose, aspect);
const select = (i: number, _u: number, _v: number, z: number) => {
	if (!(z < PERSON_MAX_Z)) return false;
	const r = cloud.colors[4 * i];
	const g = cloud.colors[4 * i + 1];
	const b = cloud.colors[4 * i + 2];
	return !(g > 1.05 * r && g > 1.05 * b);
};
const input = { cloud, pose, eye, K, aspect, select };

// 1. inflation only (also gives the person boxes)
let t0 = performance.now();
const inflated = completePeople(input);
console.log(
	`inflation: ${inflated.added.count} splats in ${(performance.now() - t0).toFixed(0)} ms, ${inflated.instances.length} instance(s), grid ${inflated.gridWidth}x${inflated.gridHeight}`,
);
if (!inflated.instances.length) process.exit(1);

// 2. the photo (no image library in the repo: sips → 24-bit BMP)
const photo = decodePhoto(join(ROOT, "public/demo/step/photo.jpg"));
console.log(`photo ${photo.width}x${photo.height}`);

// 3. ViTPose + body fit
let device: import("@luma.gl/core").Device | undefined;
if (process.env.DAWN_DIR) {
	const { create, globals } = await import(
		pathToFileURL(join(process.env.DAWN_DIR, "node_modules/webgpu/index.js"))
			.href
	);
	Object.assign(globalThis, globals);
	const gpu = create([]);
	Object.defineProperty(globalThis, "navigator", {
		value: { gpu, userAgent: "node" },
		configurable: true,
	});
	const adapter = await gpu.requestAdapter();
	if (adapter) {
		const { attachWebGPUDevice } = await import("#/lib/gpu/core/luma");
		const { COMPUTE_FEATURES } = await import("#/lib/gpu/device");
		device = (await attachWebGPUDevice(
			await adapter.requestDevice({
				requiredFeatures: COMPUTE_FEATURES.filter((f) =>
					adapter.features.has(f),
				),
				requiredLimits: {
					maxStorageBufferBindingSize:
						adapter.limits.maxStorageBufferBindingSize,
					maxBufferSize: adapter.limits.maxBufferSize,
				},
			}),
			{ id: "people-body-views" },
			true,
		)) as import("@luma.gl/core").Device;
	}
}
const nn = await createNn(
	device ? { backend: "gpu", device } : { backend: "cpu" },
);
const model = annyFromBytes(
	new Uint8Array(readFileSync(join(ROOT, "public/models", ANNY_FILE))),
);
const boxes = boxesFromInstances(
	inflated.instances,
	inflated.gridWidth,
	inflated.gridHeight,
);
t0 = performance.now();
const fitOptions = JSON.parse(arg("fit", "{}"));
const body = await prepareBodyBackDepth({
	nn,
	image: photo,
	boxes,
	model,
	options: fitOptions,
});
const tPose = performance.now() - t0;
console.log(
	`ViTPose (${nn.backend.kind}): ${tPose.toFixed(0)} ms for ${boxes.length} box(es)`,
);
const names = [
	"nose",
	"lEye",
	"rEye",
	"lEar",
	"rEar",
	"lSho",
	"rSho",
	"lElb",
	"rElb",
	"lWri",
	"rWri",
	"lHip",
	"rHip",
	"lKne",
	"rKne",
	"lAnk",
	"rAnk",
];
for (const p of body.keypoints)
	console.log(
		"  ",
		names
			.map(
				(n, k) =>
					`${n} (${(p.u[k] * photo.width).toFixed(0)},${(p.v[k] * photo.height).toFixed(0)}) ${p.score[k].toFixed(2)}`,
			)
			.join("  "),
	);
t0 = performance.now();
// keep what people.ts hands the provider (front z, inflation back) for the slices below
const seen: { inst: PersonGridInstance | null } = { inst: null };
const withBody = completePeople(input, {
	backDepth: (inst) => {
		// people.ts overwrites inflatedBackZ with the learned back after this call: keep a copy
		seen.inst ??= { ...inst, inflatedBackZ: inst.inflatedBackZ.slice() };
		return body.backDepth(inst);
	},
});
const captured = seen.inst as PersonGridInstance | null;
console.log(
	`body completion: ${withBody.added.count} splats (${withBody.strays.length} observed strays dropped; inflation ${inflated.strays.length}) in ${(performance.now() - t0).toFixed(0)} ms`,
);
for (const r of body.fits) {
	const f = r.fit;
	console.log(
		`  person ${r.person}: fit ${r.ms.toFixed(0)} ms, ${f ? `stature ${f.stature.toFixed(2)} m × scene scale ${f.sceneScale.toFixed(2)}, β [${Array.from(f.beta, (b) => b.toFixed(2)).join(", ")}], t [${f.translation.map((x) => x.toFixed(2)).join(", ")}], from yaw start ${f.yawStart.toFixed(2)} turned ${((Math.acos(Math.max(-1, Math.min(1, f.rotation[7]))) * 180) / Math.PI).toFixed(0)}° from facing the camera, keypoint rms ${(f.keypointRms * 100).toFixed(1)} cm, ${f.iterations} it, used ${f.used.filter(Boolean).length}/17` : "no fit"}, covered ${r.covered} + filled ${r.filled} cells, offset ${(r.offsetM * 100).toFixed(1)} cm`,
	);
}

{
	const f = body.fits.find((r) => r.fit)?.fit;
	const p = body.keypoints[0];
	if (f && p)
		console.log(
			"   fitted − observed (px):",
			names
				.map((n, k) => {
					const Z = f.keypoints[3 * k + 2];
					const du =
						(K.cx + (K.fx * f.keypoints[3 * k]) / Z - p.u[k]) * photo.width;
					const dv =
						(K.cy + (K.fy * f.keypoints[3 * k + 1]) / Z - p.v[k]) *
						photo.height;
					return `${n}${f.used[k] ? "" : "*"} ${du.toFixed(0)},${dv.toFixed(0)}`;
				})
				.join("  "),
		);
}
{
	// silhouette agreement on the grid: mesh coverage vs the instance (cells inside the photo)
	const f = body.fits.find((r) => r.fit)?.fit;
	if (f && captured) {
		const r = rasterDepthRange(
			f.vertices,
			model.faces,
			K,
			withBody.gridWidth,
			withBody.gridHeight,
		);
		const inst = new Set(captured.cells);
		let both = 0;
		let meshOnly = 0;
		for (let k = 0; k < r.near.length; k++)
			if (Number.isFinite(r.near[k])) inst.has(k) ? both++ : meshOnly++;
		const instOnly = inst.size - both;
		console.log(
			`   silhouette IoU ${(both / (both + meshOnly + instOnly)).toFixed(3)} (mesh only ${meshOnly}, instance only ${instOnly}, both ${both})`,
		);
	}
}
const noSheet = process.argv.includes("--no-sheet");

// 4. contact sheet (skipped with --no-sheet)
if (!noSheet) {
	// 4. contact sheet: before / inflation / body
	const m = camToEnuMatrix(pose);
	const near: number[] = [];
	for (let i = 0; i < cloud.count; i++) {
		const dx = cloud.positions[3 * i] - eye.x;
		const dy = cloud.positions[3 * i + 1] - eye.y;
		const dz = cloud.positions[3 * i + 2] - eye.z;
		const z = m[2] * dx + m[5] * dy + m[8] * dz;
		if (z > 0 && z < PERSON_MAX_Z) near.push(i);
	}
	const centre = [0, 0, 0];
	for (const i of near)
		for (let c = 0; c < 3; c++)
			centre[c] += cloud.positions[3 * i + c] / near.length;
	const fwd = [m[2], m[5], m[8]];
	for (let c = 0; c < 3; c++) centre[c] += fwd[c] * 0.12;
	const completed = (res: typeof inflated) => {
		const dropped = new Set(res.strays);
		const kept = selectSplats(
			cloud,
			Array.from({ length: cloud.count }, (_, i) => i).filter(
				(i) => !dropped.has(i),
			),
		);
		return concat(kept, res.added);
	};
	const W = 360;
	const H = 480;
	const AZ = [0, 35, 70, 110, 180];
	const rows = [cloud, completed(inflated), completed(withBody)];
	const SW = W * AZ.length;
	const SH = H * rows.length;
	const sheet = new Uint8Array(SW * SH * 3);
	rows.forEach((c, r) => {
		AZ.forEach((az, t) => {
			const img = render(c, centre, eye, az, W, H);
			for (let y = 0; y < H; y++)
				sheet.set(
					img.subarray(y * W * 3, (y + 1) * W * 3),
					((r * H + y) * SW + t * W) * 3,
				);
		});
	});
	writePpm(join(OUT, "sheet.ppm"), sheet, SW, SH);
	console.log(`wrote ${OUT}/sheet.ppm`);
}

// 5. fit overlay + side view
{
	const scale = 0.5;
	const PW = Math.round(photo.width * scale);
	const PH = Math.round(photo.height * scale);
	const SV = 600; // side view width
	const OW = PW + SV;
	const img = new Uint8Array(OW * PH * 3).fill(255);
	for (let y = 0; y < PH; y++)
		for (let x = 0; x < PW; x++) {
			const sx = Math.min(photo.width - 1, Math.floor(x / scale));
			const sy = Math.min(photo.height - 1, Math.floor(y / scale));
			for (let c = 0; c < 3; c++)
				img[(y * OW + x) * 3 + c] = Math.round(
					0.55 * photo.data[(sy * photo.width + sx) * 4 + c] + 0.45 * 255,
				);
		}
	const px = (u: number, v: number): [number, number] => [u * PW, v * PH];
	const fit = body.fits.find((r) => r.fit)?.fit ?? null;
	if (fit) {
		const v = fit.vertices;
		const proj = (i: number): [number, number] =>
			px(
				K.cx + (K.fx * v[3 * i]) / v[3 * i + 2],
				K.cy + (K.fy * v[3 * i + 1]) / v[3 * i + 2],
			);
		for (let f = 0; f < model.faces.length; f += 3)
			for (let e = 0; e < 3; e++) {
				const a = proj(model.faces[f + e]);
				const b = proj(model.faces[f + ((e + 1) % 3)]);
				line(img, OW, PW, PH, a, b, [40, 90, 220]);
			}
		// fitted keypoints (blue squares)
		for (let k = 0; k < 17; k++) {
			const X = fit.keypoints[3 * k];
			const Y = fit.keypoints[3 * k + 1];
			const Z = fit.keypoints[3 * k + 2];
			dot(
				img,
				OW,
				PW,
				PH,
				px(K.cx + (K.fx * X) / Z, K.cy + (K.fy * Y) / Z),
				4,
				[20, 20, 160],
			);
		}
	}
	const SKEL = [
		[5, 7],
		[7, 9],
		[6, 8],
		[8, 10],
		[5, 6],
		[11, 12],
		[5, 11],
		[6, 12],
		[11, 13],
		[13, 15],
		[12, 14],
		[14, 16],
		[0, 1],
		[0, 2],
		[1, 3],
		[2, 4],
	];
	for (const p of body.keypoints) {
		const used = body.fits.find((r) => r.fit)?.fit?.used ?? [];
		for (const [a, b] of SKEL)
			line(
				img,
				OW,
				PW,
				PH,
				px(p.u[a], p.v[a]),
				px(p.u[b], p.v[b]),
				[250, 200, 0],
			);
		for (let k = 0; k < 17; k++)
			dot(
				img,
				OW,
				PW,
				PH,
				px(p.u[k], p.v[k]),
				6,
				used[k] ? [0, 180, 0] : [220, 0, 0],
			);
	}
	// top-down slices (camera x → right, z → up the panel) through grid rows at 30 % (chest) and 55 % (waist) of the
	// instance height (and 85 %, thigh): observed front (grey), inflation back (green), fitted mesh near (blue) and far (orange) surfaces
	const inst = withBody.instances[0];
	const GW = withBody.gridWidth;
	const GH = withBody.gridHeight;
	const range = fit
		? rasterDepthRange(fit.vertices, model.faces, K, GW, GH)
		: null;
	const sliceScale = 380; // px per metre
	const halfH = Math.floor(PH / 3);
	[0.3, 0.55, 0.85].forEach((frac, s) => {
		const j = Math.round(inst.bbox[1] + frac * (inst.bbox[3] - inst.bbox[1]));
		const oy = s * halfH;
		// frame and a 10 cm tick grid
		for (let y = oy; y < oy + halfH; y++)
			for (let x = PW; x < OW; x++) {
				const tick = (x - PW) % 38 === 0 || (y - oy) % 38 === 0;
				const v = y === oy ? 0 : tick ? 235 : 255;
				for (let c = 0; c < 3; c++) img[(y * OW + x) * 3 + c] = v;
			}
		const at = (x: number, z: number): [number, number] => [
			PW + SV / 2 + x * sliceScale,
			oy + halfH - 20 - (z - inst.medianZ + 0.2) * sliceScale,
		];
		const put = (p: [number, number], col: number[], r = 2) => {
			for (let dy = -r; dy <= r; dy++)
				for (let dx = -r; dx <= r; dx++) {
					const x = Math.round(p[0] + dx);
					const y = Math.round(p[1] + dy);
					if (x < PW || x >= OW || y <= oy || y >= oy + halfH) continue;
					for (let c = 0; c < 3; c++) img[(y * OW + x) * 3 + c] = col[c];
				}
		};
		const cap = captured;
		for (let i = 0; i < GW; i++) {
			const k = j * GW + i;
			const rx = ((i + 0.5) / GW - K.cx) / K.fx;
			const rxc =
				rx - (((inst.bbox[0] + inst.bbox[2]) / 2 + 0.5) / GW - K.cx) / K.fx;
			const plot = (z: number, col: number[], r = 2) => {
				if (Number.isFinite(z)) put(at(rxc * z, z), col, r);
			};
			if (cap) {
				plot(cap.frontZ[k], [120, 120, 120], 2);
				plot(cap.inflatedBackZ[k], [40, 170, 60], 2);
			}
			if (range) {
				plot(range.near[k], [40, 90, 220], 1);
				plot(range.far[k], [230, 120, 20], 1);
			}
		}
		console.log(`   slice ${["chest", "waist", "thigh"][s]}: grid row ${j}`);
	});
	writePpm(join(OUT, "fit.ppm"), img, OW, PH);
	console.log(`wrote ${OUT}/fit.ppm`);
}
// a Dawn device keeps node's event loop alive
process.exit(0);

function decodePhoto(path: string): RgbaImage {
	const tmp = join(OUT, "photo.bmp");
	execFileSync("sips", ["-s", "format", "bmp", path, "--out", tmp], {
		stdio: "ignore",
	});
	const b = readFileSync(tmp);
	const off = b.readUInt32LE(10);
	const w = b.readInt32LE(18);
	const hRaw = b.readInt32LE(22);
	const bpp = b.readUInt16LE(28);
	const h = Math.abs(hRaw);
	const bytes = bpp / 8;
	const stride = Math.ceil((w * bytes) / 4) * 4;
	const data = new Uint8Array(w * h * 4);
	for (let y = 0; y < h; y++) {
		const row = hRaw < 0 ? y : h - 1 - y;
		for (let x = 0; x < w; x++) {
			const s = off + row * stride + x * bytes;
			const d = (y * w + x) * 4;
			data[d] = b[s + 2];
			data[d + 1] = b[s + 1];
			data[d + 2] = b[s];
			data[d + 3] = 255;
		}
	}
	return { width: w, height: h, data };
}

function line(
	img: Uint8Array,
	OW: number,
	PW: number,
	PH: number,
	a: [number, number],
	b: [number, number],
	col: number[],
) {
	const n =
		Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
	if (!(n < 4000)) return;
	for (let s = 0; s <= n; s++) {
		const x = Math.round(a[0] + ((b[0] - a[0]) * s) / n);
		const y = Math.round(a[1] + ((b[1] - a[1]) * s) / n);
		if (x < 0 || y < 0 || x >= PW || y >= PH) continue;
		for (let c = 0; c < 3; c++) img[(y * OW + x) * 3 + c] = col[c];
	}
}

function dot(
	img: Uint8Array,
	OW: number,
	PW: number,
	PH: number,
	p: [number, number],
	r: number,
	col: number[],
) {
	for (let dy = -r; dy <= r; dy++)
		for (let dx = -r; dx <= r; dx++) {
			if (dx * dx + dy * dy > r * r) continue;
			const x = Math.round(p[0] + dx);
			const y = Math.round(p[1] + dy);
			if (x < 0 || y < 0 || x >= PW || y >= PH) continue;
			for (let c = 0; c < 3; c++) img[(y * OW + x) * 3 + c] = col[c];
		}
}

function concat(a: GaussianCloud, b: GaussianCloud): GaussianCloud {
	const cat = <T extends Float32Array | Uint8Array>(x: T, y: T): T => {
		const o = new (x.constructor as { new (n: number): T })(
			x.length + y.length,
		);
		o.set(x);
		o.set(y, x.length);
		return o;
	};
	return {
		count: a.count + b.count,
		frame: "enu",
		positions: cat(a.positions, b.positions),
		scales: cat(a.scales, b.scales),
		rotations: cat(a.rotations, b.rotations),
		colors: cat(a.colors, b.colors),
		provenance: cat(a.provenance, b.provenance),
	};
}

/** Orbit camera around `target` (ENU), EWA splatting front to back (as people-complete-views.ts). */
function render(
	c: GaussianCloud,
	target: number[],
	eye0: { x: number; y: number; z: number },
	azDeg: number,
	w: number,
	h: number,
): Uint8Array {
	const ex = eye0.x - target[0];
	const ey = eye0.y - target[1];
	const r = Math.hypot(ex, ey);
	const a0 = Math.atan2(ey, ex) + (azDeg * Math.PI) / 180;
	const cam = [
		target[0] + r * Math.cos(a0),
		target[1] + r * Math.sin(a0),
		eye0.z,
	];
	const f = norm3([target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]]);
	const rt = norm3([f[1], -f[0], 0]);
	const dn = norm3(cross(f, rt));
	const focal = (0.5 * h) / Math.tan((30 * Math.PI) / 180 / 2);
	type S = {
		d: number;
		u: number;
		v: number;
		a: number;
		b: number;
		cc: number;
		k: number;
	};
	const list: S[] = [];
	for (let i = 0; i < c.count; i++) {
		const px = c.positions[3 * i] - cam[0];
		const py = c.positions[3 * i + 1] - cam[1];
		const pz = c.positions[3 * i + 2] - cam[2];
		const x = rt[0] * px + rt[1] * py + rt[2] * pz;
		const y = dn[0] * px + dn[1] * py + dn[2] * pz;
		const z = f[0] * px + f[1] * py + f[2] * pz;
		if (z < 0.2 || z > 40) continue;
		const u = w / 2 + (focal * x) / z;
		const v = h / 2 + (focal * y) / z;
		if (u < -50 || v < -50 || u > w + 50 || v > h + 50) continue;
		const [qw, qx, qy, qz] = [
			c.rotations[4 * i],
			c.rotations[4 * i + 1],
			c.rotations[4 * i + 2],
			c.rotations[4 * i + 3],
		];
		const R = [
			1 - 2 * (qy * qy + qz * qz),
			2 * (qx * qy - qw * qz),
			2 * (qx * qz + qw * qy),
			2 * (qx * qy + qw * qz),
			1 - 2 * (qx * qx + qz * qz),
			2 * (qy * qz - qw * qx),
			2 * (qx * qz - qw * qy),
			2 * (qy * qz + qw * qx),
			1 - 2 * (qx * qx + qy * qy),
		];
		const s = [c.scales[3 * i], c.scales[3 * i + 1], c.scales[3 * i + 2]];
		const Sw = new Array(9).fill(0);
		for (let a = 0; a < 3; a++)
			for (let b = 0; b < 3; b++)
				for (let k = 0; k < 3; k++)
					Sw[3 * a + b] += R[3 * a + k] * s[k] * s[k] * R[3 * b + k];
		const V = [rt, dn, f];
		const Sc = new Array(9).fill(0);
		for (let a = 0; a < 3; a++)
			for (let b = 0; b < 3; b++) {
				let acc = 0;
				for (let p = 0; p < 3; p++)
					for (let q = 0; q < 3; q++) acc += V[a][p] * Sw[3 * p + q] * V[b][q];
				Sc[3 * a + b] = acc;
			}
		const J = [
			focal / z,
			0,
			(-focal * x) / (z * z),
			0,
			focal / z,
			(-focal * y) / (z * z),
		];
		const c2 = [0, 0, 0, 0];
		for (let a = 0; a < 2; a++)
			for (let b = 0; b < 2; b++) {
				let acc = 0;
				for (let p = 0; p < 3; p++)
					for (let q = 0; q < 3; q++)
						acc += J[3 * a + p] * Sc[3 * p + q] * J[3 * b + q];
				c2[2 * a + b] = acc;
			}
		const A = c2[0] + 0.3;
		const B = c2[1];
		const C = c2[3] + 0.3;
		const det = A * C - B * B;
		if (!(det > 0)) continue;
		list.push({ d: z, u, v, a: C / det, b: -B / det, cc: A / det, k: i });
	}
	list.sort((p, q) => p.d - q.d);
	const accum = new Float32Array(w * h * 3);
	const T = new Float32Array(w * h).fill(1);
	for (const g of list) {
		const rad = 3 * Math.sqrt(Math.max(1 / g.a, 1 / g.cc));
		const x0 = Math.max(0, Math.floor(g.u - rad));
		const x1 = Math.min(w - 1, Math.ceil(g.u + rad));
		const y0 = Math.max(0, Math.floor(g.v - rad));
		const y1 = Math.min(h - 1, Math.ceil(g.v + rad));
		const op = c.colors[4 * g.k + 3] / 255;
		for (let y = y0; y <= y1; y++)
			for (let x = x0; x <= x1; x++) {
				const p = y * w + x;
				if (T[p] < 0.004) continue;
				const dx = x + 0.5 - g.u;
				const dy = y + 0.5 - g.v;
				const e = 0.5 * (g.a * dx * dx + 2 * g.b * dx * dy + g.cc * dy * dy);
				if (e > 4.5) continue;
				const al = Math.min(0.99, op * Math.exp(-e));
				const wgt = al * T[p];
				for (let ch = 0; ch < 3; ch++)
					accum[3 * p + ch] += wgt * c.colors[4 * g.k + ch];
				T[p] *= 1 - al;
			}
	}
	const out = new Uint8Array(w * h * 3);
	const bg = [196, 214, 232];
	for (let p = 0; p < w * h; p++)
		for (let ch = 0; ch < 3; ch++)
			out[3 * p + ch] = Math.min(
				255,
				Math.round(accum[3 * p + ch] + T[p] * bg[ch]),
			);
	return out;
}

function writePpm(path: string, rgb: Uint8Array, w: number, h: number): void {
	const head = Buffer.from(`P6\n${w} ${h}\n255\n`, "ascii");
	writeFileSync(path, Buffer.concat([head, Buffer.from(rgb)]));
}
function norm3(v: number[]): number[] {
	const l = Math.hypot(v[0], v[1], v[2]) || 1;
	return [v[0] / l, v[1] / l, v[2] / l];
}
function cross(a: number[], b: number[]): number[] {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}
