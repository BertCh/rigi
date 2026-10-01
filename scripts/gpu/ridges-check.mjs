#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node-side parity check of the GPU ridge-tops kernel (src/lib/gpu/horizon/ridges.wgsl.ts) with no GPU:
// builds synthetic ring mosaics, runs the CPU twin (ridgelines.ts ridgeTopsCpu, the reference), packs the
// kernel's real params / uniform with packRidgeMarch and evaluates the WGSL's arithmetic in JS with every
// operation rounded to f32 (Math.fround; no fma, no fast-math, so it bounds the rounding but is not the
// device), then compares top / topD the way the app would see them.
//
//   node scripts/gpu/ridges-check.mjs [--lat 46.5] [--lon 8] [--step 0.1] [--hole 0]
//
// --hole 0 leaves out the no-data patch. With it, a sample whose bilinear cell touches a NO_DATA corner
// lands within ~1 m of the validity threshold (the sentinel is -32768, so one pixel of position moves the
// height by ~30 km), and a last-bit position difference there is not meaningful; those cells give the
// few ~1e-3 degree outliers.
//
// Exit 1 when the max angular difference exceeds 5e-3 degrees (the ridge stroke tolerance is 0.012).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "tsx/esm/api";

const ROOT = path.resolve(import.meta.dirname, "../..");
register({ tsconfig: path.join(ROOT, "tsconfig.json") });
const imp = (p) => import(pathToFileURL(path.join(ROOT, "src/lib", p)).href);
const { ridgeSchedule, ridgeTopsCpu } = await imp("roll/mosaic/ridgelines.ts");
const { mosaicHeight, mosaicFor } = await imp("horizon-fast/mosaic.ts");
const { packRidgeMarch, ridgeTopsFromTD } = await imp("gpu/horizon/ridges.ts");

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? Number(process.argv[i + 1]) : d;
};
const lat0 = arg("lat", 46.5);
const lon0 = arg("lon", 8);
const step = arg("step", 0.1);
const hole = arg("hole", 1) !== 0;
const DEG = Math.PI / 180;
const f = Math.fround;

// ---- synthetic terrain and rings (consistent across rings at the pixel centres) ----
const terrain = (lat, lon) => {
	let h = 1800;
	for (let k = 0; k < 6; k++)
		h +=
			(700 / 1.7 ** k) *
			Math.sin((40 * 1.9 ** k * lon + k) * 1) *
			Math.cos(40 * 1.9 ** k * lat * 0.8 + 2 * k);
	// a no-data hole and a sea-level plain
	if (
		hole &&
		lon > lon0 + 0.35 &&
		lon < lon0 + 0.45 &&
		lat > lat0 - 0.1 &&
		lat < lat0 + 0.1
	)
		return -32768;
	return h;
};
const ring = (z, half, minDistance, maxDistance) => {
	const tileSize = 512;
	const worldPx = 2 ** z * tileSize;
	const bx = (lon0 + 180) / 360;
	const by = 0.5 - Math.atanh(Math.sin(lat0 * DEG)) / (2 * Math.PI);
	const x0 = Math.floor(bx * worldPx) - half;
	const y0 = Math.floor(by * worldPx) - half;
	const width = 2 * half;
	const data = new Float32Array(width * width);
	for (let j = 0; j < width; j++) {
		const y = (y0 + j + 0.5) / worldPx;
		const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
		for (let i = 0; i < width; i++) {
			const lon = ((x0 + i + 0.5) / worldPx) * 360 - 180;
			data[j * width + i] = terrain(lat, lon);
		}
	}
	return {
		z,
		tileSize,
		worldPx,
		x0,
		y0,
		width,
		height: width,
		data,
		minDistance,
		maxDistance,
		cellMeters: 0,
	};
};
const t0 = performance.now();
const mosaics = [
	ring(14, 750, 0, 2400),
	ring(11, 750, 2300, 18000),
	ring(9, 1200, 17000, 120000),
];
console.log(`mosaics built (${((performance.now() - t0) / 1e3).toFixed(1)} s)`);

const eyeGround = mosaicHeight(mosaics[0], lon0, lat0);
const eye = { lat: lat0, lon: lon0, h: eyeGround + 1.8 };
const o = { step, dMax: 120000 };
const sch = ridgeSchedule(o);
const heightAt = (lat, lon, d) => mosaicHeight(mosaicFor(mosaics, d), lon, lat);

const tc = performance.now();
const cpu = ridgeTopsCpu(heightAt, eye, o);
console.log(
	`CPU: ${sch.cols} cols x ${sch.dists.length} distances, ${((performance.now() - tc) / 1e3).toFixed(1)} s`,
);

// ---- the kernel in f32 ----
const pageOf = mosaics.map((_, i) => ({ page: i, dataOff: 0 }));
const { params, uniform } = packRidgeMarch(mosaics, pageOf, {
	eye,
	cols: sch.cols,
	step: sch.step,
	inv2R: sch.inv2R,
	slabs: sch.S,
	dists: sch.dists,
	slabOf: sch.slabOf,
});
const pu = new Uint32Array(params);
const pf = new Float32Array(params);
const pi = new Int32Array(params);
const uu = new Uint32Array(uniform);
const uf = new Float32Array(uniform);
const U = {
	nCols: uu[0],
	nSlabs: uu[1],
	azOff: uu[4],
	distOff: uu[5],
	ringOff: uu[6],
	slabOff: uu[7],
	inv2R: uf[8],
	h0: uf[10],
	h0lo: uf[11],
	sinP1: uf[12],
	cosP1: uf[13],
};
const INV_2PI = f(0.15915494309189535);
const atanS = (y, x) => {
	if (x > 0 && Math.abs(y) < f(0.2 * x)) {
		const z = f(y / x);
		const z2 = f(z * z);
		let a = f(1 / 13);
		for (const c of [-1 / 11, 1 / 9, -1 / 7, 1 / 5, -1 / 3, 1])
			a = f(f(z2 * a) + f(c));
		// Horner: 1 + z2(-1/3 + z2(1/5 + ...)) written inside-out as the shader does
		return f(z * a);
	}
	return f(Math.atan2(y, x));
};
const atanhS = (z) => {
	if (Math.abs(z) < 0.2) {
		const z2 = f(z * z);
		let a = f(1 / 13);
		for (const c of [1 / 11, 1 / 9, 1 / 7, 1 / 5, 1 / 3, 1])
			a = f(f(z2 * a) + f(c));
		return f(z * a);
	}
	return f(0.5 * Math.log(f(f(1 + z) / f(1 - z))));
};
const bp = (sinD, omc, sinA, cosA, sinP1, cosP1, c2) => {
	const ds = f(f(f(cosP1 * sinD) * cosA) - f(sinP1 * omc));
	const den = f(c2 - f(sinP1 * ds));
	const dl = atanS(f(f(sinA * sinD) * cosP1), f(den - omc));
	const dy = atanhS(f(ds / den));
	return [f(dl * INV_2PI), f(f(-dy) * INV_2PI)];
};
const td = new Float32Array(2 * U.nCols * U.nSlabs);
const te = performance.now();
const c2 = f(U.cosP1 * U.cosP1);
for (let s = 0; s < U.nSlabs; s++) {
	const lo = pu[U.slabOff + 2 * s];
	const hi = pu[U.slabOff + 2 * s + 1];
	for (let ic = 0; ic < U.nCols; ic++) {
		const sinA = pf[U.azOff + 2 * ic];
		const cosA = pf[U.azOff + 2 * ic + 1];
		let has = false;
		let tBest = 0;
		let dBest = 0;
		for (let i = lo; i < hi; i++) {
			const rec = U.distOff + 4 * i;
			const dd = pf[rec];
			const b = bp(pf[rec + 1], pf[rec + 2], sinA, cosA, U.sinP1, U.cosP1, c2);
			const rb = U.ringOff + pu[rec + 3] * 12;
			const W = pu[rb + 2];
			const H = pu[rb + 3];
			const sx = pf[rb + 4];
			const ufp = f(pf[rb + 6] + f(b[0] * sx));
			const vfp = f(pf[rb + 8] + f(b[1] * sx));
			const flu = Math.floor(ufp);
			const flv = Math.floor(vfp);
			const xi = pi[rb + 5] + flu;
			const yi = pi[rb + 7] + flv;
			if (xi < 0 || yi < 0 || xi >= W - 1 || yi >= H - 1) continue;
			const fx = f(ufp - flu);
			const fy = f(vfp - flv);
			const data = mosaics[pu[rb]].data;
			const k = pu[rb + 1] + yi * W + xi;
			const rel = (v) => f(f(v - U.h0) - U.h0lo);
			const a0 = rel(data[k]);
			const a1 = rel(data[k + 1]);
			const c0 = rel(data[k + W]);
			const c1 = rel(data[k + W + 1]);
			const m1 = f(f(a1 - a0) * fx);
			const m2 = f(f(f(c0 - a0) + f(f(f(a0 - a1) - c0 + c1) * fx)) * fy);
			const hr = f(f(a0 + m1) + m2);
			if (f(hr + U.h0) > -1000) {
				const t = f(f(hr / dd) - f(dd * U.inv2R));
				if (!has || t > tBest) {
					has = true;
					tBest = t;
					dBest = dd;
				}
			}
		}
		const o2 = 2 * (s * U.nCols + ic);
		td[o2] = has ? tBest : -3.0e38;
		td[o2 + 1] = dBest;
	}
}
console.log(
	`kernel emulation: ${((performance.now() - te) / 1e3).toFixed(1)} s`,
);
const gpu = ridgeTopsFromTD(td, U.nSlabs * U.nCols);

// ---- compare ----
const n = U.nSlabs * U.nCols;
let finiteMismatch = 0;
let both = 0;
let maxSame = 0;
let maxAny = 0;
let diffArg = 0;
let maxArgDist = 0;
const diffs = [];
for (let k = 0; k < n; k++) {
	const a = cpu.top[k];
	const b = gpu.top[k];
	if (Number.isFinite(a) !== Number.isFinite(b)) {
		finiteMismatch++;
		continue;
	}
	if (!Number.isFinite(a)) continue;
	both++;
	const d = Math.abs(a - b);
	diffs.push(d);
	maxAny = Math.max(maxAny, d);
	if (
		cpu.topD[k] === gpu.topD[k] ||
		Math.abs(cpu.topD[k] - gpu.topD[k]) < 1e-3 * cpu.topD[k]
	)
		maxSame = Math.max(maxSame, d);
	else {
		diffArg++;
		maxArgDist = Math.max(maxArgDist, Math.abs(cpu.topD[k] - gpu.topD[k]));
	}
}
const worst = [];
for (let k = 0; k < n; k++) {
	const a = cpu.top[k];
	if (Number.isFinite(a) && Number.isFinite(gpu.top[k]))
		worst.push([Math.abs(a - gpu.top[k]), k]);
}
worst.sort((x, y) => y[0] - x[0]);
for (const [d, k] of worst.slice(0, 5))
	console.log(
		`  worst: slab ${Math.floor(k / U.nCols)} col ${k % U.nCols} d=${d.toExponential(2)} deg, cpu ${cpu.top[k].toFixed(4)}@${cpu.topD[k].toFixed(0)} m, gpu ${gpu.top[k].toFixed(4)}@${gpu.topD[k].toFixed(0)} m`,
	);
diffs.sort((x, y) => x - y);
const q = (p) =>
	diffs[Math.min(diffs.length - 1, Math.floor(p * diffs.length))];
console.log(
	`entries ${n}, with data on both ${both}, data on one side only ${finiteMismatch}`,
);
console.log(
	`|d angle| deg: max ${maxAny.toExponential(2)}, p99.9 ${q(0.999).toExponential(2)}, p99 ${q(0.99).toExponential(2)}, median ${q(0.5).toExponential(2)}`,
);
console.log(
	`same argmax distance: max ${maxSame.toExponential(2)} deg; different argmax (near-ties): ${diffArg} entries, max distance gap ${maxArgDist.toFixed(1)} m`,
);
const ok = maxAny < 5e-3 && finiteMismatch < n * 1e-4;
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
