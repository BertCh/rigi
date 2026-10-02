// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * GPU ridgeline tops: the per-(slab, column) maximum elevation angle and its distance that
 * src/lib/roll/mosaic/ridgelines.ts traceViewpoint computes on the CPU (3600 columns x ~1200 fixed
 * distances, one heightAt each). A sibling of the horizon march (./index.ts), not an extension of it:
 * the march is adaptive and mip-skipping, the ridge trace samples every distance of a fixed schedule.
 *
 *   const tops = await computeRidgeTopsAuto(mosaics, march);   // null → take the CPU path
 *   traceViewpoint(heightAt, eye, peaks, opts, tops ?? undefined);
 *
 * It reuses the horizon's plumbing and does not touch its kernel or outputs: the mosaics go up through
 * index.ts uploadMosaics (same cached pages, same releaseHorizonGpu), the "horizon" lease serialises it
 * with the march, the per-call u / params are pooled slots under "horizon/ridge-…", and the dispatch is a
 * one-kernel core ComputeGraph (march-style graph, cached per shape; no pooled dispatch path). The CPU
 * reads back out = [t, d] per (slab, column) through the graph's read node and applies atan in f64.
 *
 * Agreement with the CPU trace: same distances, same ring per distance (mosaicFor), same bilinear
 * weights, same bounds test and NaN rule, same curvature + refraction term; the sample position is
 * computed with the horizon kernel's f32 scheme, so differences are f32 rounding (see
 * scripts/gpu/ridges-check.mjs, which emulates the kernel in f32 and reports them).
 */
import { Buffer, type Device } from "@luma.gl/core";
import { DEG, EARTH_R } from "#/lib/geodesy";
import { cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import { GpuDeviceLostError } from "#/lib/gpu/core/lifecycle";
import {
	acquire,
	capacityFor,
	pooledUniform,
	withLease,
} from "#/lib/gpu/core/pool";
import type { Mosaic } from "#/lib/horizon-fast/mosaic";
import { getComputeDevice } from "../device";
import { uploadMosaics } from "./index";
import { RIDGES_WGSL } from "./ridges.wgsl";

/** The ridge trace's sampling schedule (ridgelines.ts ridgeSchedule), for one eye. */
export interface RidgeMarch {
	eye: { lat: number; lon: number; h: number };
	/** Columns over 360° and the azimuth step per column, degrees. */
	cols: number;
	step: number;
	/** (1 − k) / (2R): the curvature + refraction drop is d² · inv2R. */
	inv2R: number;
	/** Number of slabs. */
	slabs: number;
	/** Sample distances, metres, ascending. */
	dists: ArrayLike<number>;
	/** Slab of each distance, non-decreasing. */
	slabOf: ArrayLike<number>;
}

/** Per (slab, column): top edge elevation angle (degrees, −∞ = no data) and its distance. */
export interface RidgeTops {
	top: Float32Array;
	topD: Float32Array;
}

const LEASE = "horizon";
const RING_WORDS = 12;

export const RIDGES = defineKernel(
	"horizon-ridges",
	RIDGES_WGSL,
	[
		["u", "uniform"],
		["params", "read-only-storage"],
		["pg0", "read-only-storage"],
		["pg1", "read-only-storage"],
		["pg2", "read-only-storage"],
		["pg3", "read-only-storage"],
		["outTD", "storage"],
	],
	{ group: "horizon", label: "horizon-ridges" },
);

const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const PARAMS = Buffer.STORAGE | Buffer.COPY_DST;
const OUT = Buffer.STORAGE | Buffer.COPY_SRC;

type Params = {
	paramsBytes: number;
	outBytes: number;
	nCols: number;
	nSlabs: number;
};

/** Packs the kernel's params words and uniform for `m` over `mosaics` (pure; exported for the check script). */
export function packRidgeMarch(
	mosaics: Mosaic[],
	pageOf: { page: number; dataOff: number }[],
	m: RidgeMarch,
) {
	const nR = mosaics.length;
	const nD = m.dists.length;
	const ringOff = 0;
	const azOff = ringOff + RING_WORDS * nR;
	const distOff = azOff + 2 * m.cols;
	const slabOff = distOff + 4 * nD;
	const words = slabOff + 2 * m.slabs;
	const buf = new ArrayBuffer(words * 4);
	const pu = new Uint32Array(buf);
	const pF = new Float32Array(buf);
	const pi = new Int32Array(buf);
	// the eye's Mercator pixel position per ring, in f64, as integer + fraction (marchRay's scheme)
	const phi = m.eye.lat * DEG;
	const sinP1 = Math.sin(phi);
	const bx = (m.eye.lon * DEG + Math.PI) / (2 * Math.PI);
	const by = 0.5 - Math.atanh(sinP1) / (2 * Math.PI);
	for (let r = 0; r < nR; r++) {
		const mo = mosaics[r];
		const b = ringOff + r * RING_WORDS;
		pu[b] = pageOf[r].page;
		pu[b + 1] = pageOf[r].dataOff;
		pu[b + 2] = mo.width;
		pu[b + 3] = mo.height;
		pF[b + 4] = mo.worldPx;
		const u = bx * mo.worldPx - (mo.x0 + 0.5);
		const v = by * mo.worldPx - (mo.y0 + 0.5);
		pi[b + 5] = Math.floor(u);
		pF[b + 6] = u - Math.floor(u);
		pi[b + 7] = Math.floor(v);
		pF[b + 8] = v - Math.floor(v);
	}
	for (let c = 0; c < m.cols; c++) {
		const a = c * m.step * DEG;
		pF[azOff + 2 * c] = Math.sin(a);
		pF[azOff + 2 * c + 1] = Math.cos(a);
	}
	// each distance: d, sin D, 1 − cos D (as 2 sin²(D/2)), and its ring (mosaicFor: first with d ≤ maxDistance)
	let ri = 0;
	for (let i = 0; i < nD; i++) {
		const d = m.dists[i];
		while (ri < nR - 1 && d > mosaics[ri].maxDistance) ri++;
		const D = d / EARTH_R;
		const h = Math.sin(D / 2);
		const o = distOff + 4 * i;
		pF[o] = d;
		pF[o + 1] = Math.sin(D);
		pF[o + 2] = 2 * h * h;
		pu[o + 3] = ri;
	}
	for (let s = 0; s < m.slabs; s++) {
		let lo = 0;
		while (lo < nD && m.slabOf[lo] < s) lo++;
		let hi = lo;
		while (hi < nD && m.slabOf[hi] === s) hi++;
		pu[slabOff + 2 * s] = lo;
		pu[slabOff + 2 * s + 1] = hi;
	}
	const ub = new ArrayBuffer(64);
	const uu = new Uint32Array(ub);
	const uf = new Float32Array(ub);
	uu[0] = m.cols;
	uu[1] = m.slabs;
	uu[2] = nD;
	uu[3] = nR;
	uu[4] = azOff;
	uu[5] = distOff;
	uu[6] = ringOff;
	uu[7] = slabOff;
	uf[8] = m.inv2R;
	uu[9] = 0;
	uf[10] = m.eye.h;
	uf[11] = m.eye.h - uf[10];
	uf[12] = sinP1;
	uf[13] = Math.cos(phi);
	return { params: buf, uniform: ub };
}

/** Converts the kernel's (t, d) pairs to the CPU trace's `top` / `topD` (atan in f64, like angle()). */
export function ridgeTopsFromTD(td: Float32Array, n: number): RidgeTops {
	const top = new Float32Array(n);
	const topD = new Float32Array(n);
	for (let k = 0; k < n; k++) {
		const t = td[2 * k];
		top[k] = t <= -3e38 ? Number.NEGATIVE_INFINITY : Math.atan(t) / DEG;
		topD[k] = td[2 * k + 1];
	}
	return { top, topD };
}

/**
 * The ridge tops on the GPU. Throws on any GPU error (callers fall back to the CPU trace). The mosaics
 * stay uploaded (cached per array, shared with the horizon march); releaseHorizonGpu(mosaics) frees them.
 */
export function computeRidgeTopsGpu(
	device: Device,
	mosaics: Mosaic[],
	m: RidgeMarch,
): Promise<RidgeTops> {
	return withLease(LEASE, async () => {
		const set = await uploadMosaics(device, mosaics);
		const { params, uniform } = packRidgeMarch(mosaics, set.rings, m);
		const n = m.slabs * m.cols;
		const dummy = acquire(device, `${LEASE}/dummy`, 16, Buffer.STORAGE);
		const pages = [0, 1, 2, 3].map((i) => set.pages[i] ?? dummy);
		const uBytes = acquire(device, `${LEASE}/ridge-u`, 64, UNIFORM).byteLength;
		const paramsCap = capacityFor(params.byteLength);
		const outBytes = n * 8;
		const outCap = capacityFor(outBytes);
		let key = `u${uBytes},p${paramsCap},o${outCap}`;
		for (let i = 0; i < pages.length; i++)
			key += `,pg${i}:${pages[i].byteLength}`;
		const { graph } = cachedGraph<Params>(
			device,
			"horizon-ridges",
			key,
			(g) => {
				const u = g.importBuffer("u", uBytes, undefined, UNIFORM);
				const p = g.importBuffer("params", paramsCap, undefined, PARAMS);
				const pg = pages.map((b, i) =>
					g.importBuffer(`pg${i}`, b.byteLength, undefined, Buffer.STORAGE),
				);
				const out = g.transientBuffer("out", outCap, OUT);
				g.addKernel({
					id: "ridges",
					spec: RIDGES,
					bindings: {
						u,
						params: { buffer: p, size: (q) => q.paramsBytes },
						pg0: pg[0],
						pg1: pg[1],
						pg2: pg[2],
						pg3: pg[3],
						outTD: { buffer: out, size: (q) => q.outBytes },
					},
					workgroups: (q) => [Math.ceil(q.nCols / 64), q.nSlabs, 1],
				});
				// every in-range invocation writes both words of its pair: no clear needed
				g.readNode("read", [{ buffer: out, size: (q) => q.outBytes }]);
				return undefined;
			},
		);
		const pbuf = acquire(
			device,
			`${LEASE}/ridge-params`,
			params.byteLength,
			PARAMS,
		);
		pbuf.write(new Uint8Array(params));
		const { reads } = await graph.compileAsync().then((g) =>
			g.run(
				{
					paramsBytes: params.byteLength,
					outBytes,
					nCols: m.cols,
					nSlabs: m.slabs,
				},
				{
					buffers: {
						u: pooledUniform(device, `${LEASE}/ridge-u`, uniform),
						params: pbuf,
						pg0: pages[0],
						pg1: pages[1],
						pg2: pages[2],
						pg3: pages[3],
					},
				},
			),
		);
		return ridgeTopsFromTD(new Float32Array(reads.read[0], 0, 2 * n), n);
	});
}

/** A kernel / pipeline failure (WGSL compile, compileAsync rejection, validation) in this realm: the
 * GPU path is not retried (a lost device is not cached: the registry makes a new one). */
let broken = false;

/** True once the ridge kernel failed in this realm for a reason other than device loss. */
export const ridgeGpuFailed = () => broken;

/**
 * The ridge tops on the GPU when a compute device exists, else null (the caller runs the CPU trace). Any
 * GPU failure also gives null, with a console warning; a non-loss failure is remembered per realm.
 */
export async function computeRidgeTopsAuto(
	mosaics: Mosaic[],
	m: RidgeMarch,
): Promise<RidgeTops | null> {
	if (broken) return null;
	const device = await getComputeDevice();
	if (!device) return null;
	try {
		return await computeRidgeTopsGpu(device, mosaics, m);
	} catch (e) {
		if (!(e instanceof GpuDeviceLostError)) broken = true;
		console.warn("[gpu] ridge kernel failed, using the CPU", e);
		return null;
	}
}
