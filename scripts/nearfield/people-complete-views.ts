// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// People completion experiment (src/lib/nearfield/complete/people.ts) on the landing's baked Step Inside scene
// (public/demo/step, IMG_7086): renders the near splats before and after completion from orbit cameras around
// the person with a small CPU Gaussian rasteriser (EWA projection, front-to-back alpha), no browser or GPU.
//
//   npx tsx scripts/nearfield/people-complete-views.ts [--out=out/people-complete] [--depthRatio=0.7]
//
// Writes <out>/{before,after}-<azimuth>.ppm and a contact sheet <out>/sheet.ppm (rows before / after,
// columns azimuth 0 = photo eye, 35, 70, 110, 180); convert with `sips -s format png`.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { completePeople } from "#/lib/nearfield/complete/people";
import { intrinsicsFromPose } from "#/lib/nearfield/geom";
import { camToEnuMatrix } from "#/lib/nearfield/lift";
import { selectSplats } from "#/lib/nearfield/provenance";
import { decodeSplatV1 } from "#/lib/nearfield/splat-io";
import type { GaussianCloud } from "#/lib/nearfield/types";

const ROOT = resolve(import.meta.dirname, "../..");
const arg = (k: string, d: string) =>
	process.argv.find((a) => a.startsWith(`--${k}=`))?.split("=")[1] ?? d;
const OUT = resolve(ROOT, arg("out", "out/people-complete"));
const depthRatio = Number(arg("depthRatio", "0.7"));
const PERSON_MAX_Z = Number(arg("personMaxZ", "7"));

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

// no baked people mask for this photo: the person is the near object (median object range 3.5 m)
const t0 = performance.now();
const res = completePeople(
	{
		cloud,
		pose,
		eye,
		K,
		aspect,
		// near, and not grass (green-dominant): a stand-in for the live people mask
		select: (i, _u, _v, z) => {
			if (!(z < PERSON_MAX_Z)) return false;
			const r = cloud.colors[4 * i];
			const g = cloud.colors[4 * i + 1];
			const b = cloud.colors[4 * i + 2];
			return !(g > 1.05 * r && g > 1.05 * b);
		},
	},
	{ depthRatio },
);
const ms = performance.now() - t0;
console.log(
	`observed ${cloud.count}, added ${res.added.count} in ${ms.toFixed(0)} ms; grid ${res.gridWidth}x${res.gridHeight}`,
);
for (const p of res.instances)
	console.log(
		`  instance cells ${p.cells} bbox ${p.bbox.join(",")} medianZ ${p.medianZ.toFixed(2)} m, max half-thickness ${p.maxHalfThicknessM.toFixed(3)} m`,
	);
if (!res.instances.length) process.exit(1);

// orbit target: the largest instance's centroid in ENU (from the added back sheet's mean and the photo ray)
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
// push the centre back by the mean half-thickness so the orbit pivots inside the body
const fwd = [m[2], m[5], m[8]];
for (let c = 0; c < 3; c++) centre[c] += fwd[c] * 0.12;

const dropped = new Set(res.strays);
const kept = selectSplats(
	cloud,
	Array.from({ length: cloud.count }, (_, i) => i).filter(
		(i) => !dropped.has(i),
	),
);
console.log(`  dropped ${res.strays.length} stray observed splats`);
const merged = concat(kept, res.added);
const W = 360;
const H = 480;
const AZ = [0, 35, 70, 110, 180];
mkdirSync(OUT, { recursive: true });
const tiles: Uint8Array[][] = [[], []];
for (const [row, c] of [cloud, merged].entries())
	for (const az of AZ) {
		const img = render(c, centre, eye, az, W, H);
		tiles[row].push(img);
		writePpm(join(OUT, `${row ? "after" : "before"}-${az}.ppm`), img, W, H);
	}
const SW = W * AZ.length;
const SH = H * 2;
const sheet = new Uint8Array(SW * SH * 3);
for (let r = 0; r < 2; r++)
	for (let t = 0; t < AZ.length; t++)
		for (let y = 0; y < H; y++)
			sheet.set(
				tiles[r][t].subarray(y * W * 3, (y + 1) * W * 3),
				((r * H + y) * SW + t * W) * 3,
			);
writePpm(join(OUT, "sheet.ppm"), sheet, SW, SH);
console.log(`wrote ${OUT}/sheet.ppm`);

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

/**
 * Orbit camera around `target` (ENU) at the eye's horizontal distance and height, azimuth `azDeg` from the
 * photo eye direction; EWA splatting, sorted front to back. Sky-blue background.
 */
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
	// basis: forward to the target, right = forward x up, down = forward x right (OpenCV-like)
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
		// world covariance R S^2 R^T
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
		// to camera: V rows rt, dn, f
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
