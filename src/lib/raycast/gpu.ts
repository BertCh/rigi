// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * GPU host of the ray-cast oracle (FUND E5): the WGSL twin of ./cpu.ts on a core ComputeGraph. Not
 * wired into the app. Heights and max mips are the horizon GPU's resident mosaic pages
 * (gpu/horizon uploadMosaics), so a scene costs one params upload on top.
 *
 *   const rc = await createGpuRayScene(device, mosaics, makeRayScene(mosaics, eye));
 *   const frame = await rc.frame(cam);          // Float32Array, 4 per pixel: E, N, U, range (-1 = sky)
 *   const ms = await rc.timeFrame(cam);         // submit -> onSubmittedWorkDone, no readback
 *   const el = await rc.columns(0.1);           // horizon elevations (deg), -90 = no terrain
 */
import { Buffer, type Device } from "@luma.gl/core";
import { poseBasis } from "../camera";
import { DEG } from "../geodesy";
import { ComputeGraph } from "../gpu/core/graph";
import {
	defineKernel,
	kernelAsync,
	release,
	stage,
	storage,
	submit,
	uniform,
} from "../gpu/core/kernel";
import { uploadMosaics } from "../gpu/horizon";
import type { Mosaic } from "../horizon-fast/mosaic";
import type { RayCamera, RayScene } from "./cpu";
import { RAYCAST_WGSL } from "./raycast.wgsl";

export const RAYCAST = defineKernel(
	"raycast",
	RAYCAST_WGSL,
	[
		["u", "uniform"],
		["params", "read-only-storage"],
		["pg0", "read-only-storage"],
		["pg1", "read-only-storage"],
		["pg2", "read-only-storage"],
		["pg3", "read-only-storage"],
		["outBuf", "storage"],
	],
	{ group: "raycast", label: "raycast" },
);

const OFF_SEG = 96;
const OFF_RING = 1696;
const RING_STRIDE = 48;
const MAX_OCT = 32;
const MAX_SEG = 400;
const U_WORDS = 36;

type MosaicSet = Awaited<ReturnType<typeof uploadMosaics>>;

/** Params words (see raycast.wgsl.ts): octave table, segments, rings, azimuth sin/cos pairs. */
export function packScene(
	S: RayScene,
	set: MosaicSet,
	azimuths: number[] = [],
) {
	const nOct = S.octBase.length;
	const nb = S.segD.length;
	if (nOct > MAX_OCT) throw new Error("too many distance octaves");
	if (nb > MAX_SEG) throw new Error("too many path segments");
	const azOff = OFF_RING + S.rings.length * RING_STRIDE;
	const words = new Uint32Array(azOff + 2 * azimuths.length + 4);
	const f = new Float32Array(words.buffer);
	const i32 = new Int32Array(words.buffer);
	for (let o = 0; o < nOct; o++) {
		f[3 * o] = S.octBase[o];
		words[3 * o + 1] = S.octN[o];
		f[3 * o + 2] = S.octSp[o];
	}
	for (let i = 0; i < nb; i++) {
		const b = OFF_SEG + 4 * i;
		f[b] = S.segD[i];
		f[b + 1] = S.segSin[i];
		f[b + 2] = S.segOmc[i];
		words[b + 3] = i < nb - 1 ? S.segRing[i] : S.segRing[nb - 2];
	}
	S.rings.forEach((r, i) => {
		const L = set.rings[i];
		const b = OFF_RING + RING_STRIDE * i;
		words[b] = L.page;
		words[b + 1] = L.dataOff;
		words[b + 2] = r.W;
		words[b + 3] = L.mipOff.length;
		words[b + 4] = r.H;
		const ui = Math.floor(r.ue);
		const vi = Math.floor(r.ve);
		i32[b + 5] = ui;
		f[b + 6] = r.ue - ui;
		i32[b + 7] = vi;
		f[b + 8] = r.ve - vi;
		f[b + 9] = r.sx;
		words[b + 10] = 1 << L.minLevel;
		for (let l = 0; l < L.mipOff.length; l++) {
			words[b + 16 + l] = L.mipOff[l];
			words[b + 24 + l] = L.mipWidths[l];
			words[b + 32 + l] = L.mipHeights[l];
		}
	});
	azimuths.forEach((az, i) => {
		f[azOff + 2 * i] = Math.sin(az * DEG);
		f[azOff + 2 * i + 1] = Math.cos(az * DEG);
	});
	return { words, azOff };
}

interface UInput {
	mode: 0 | 1;
	W: number;
	H: number;
	stride: number;
	cam?: RayCamera;
	nAz?: number;
	azOff: number;
	S: RayScene;
}

function packUniform(x: UInput) {
	const buf = new ArrayBuffer(U_WORDS * 4);
	const u = new Uint32Array(buf);
	const f = new Float32Array(buf);
	const { S } = x;
	u[0] = x.mode;
	u[1] = x.W;
	u[2] = x.H;
	u[3] = x.stride;
	if (x.cam) {
		const { forward, right, up } = poseBasis(x.cam.pose);
		f.set(forward, 4);
		f.set(right, 8);
		f.set(up, 12);
		const t = Math.tan((x.cam.pose.vfov * DEG) / 2);
		f[16] = t * (x.cam.width / x.cam.height);
		f[17] = t;
	}
	u[19] = x.nAz ?? 0;
	u[20] = 0; // zero
	u[21] = S.mipSkip ? 1 : 0;
	u[22] = S.refineIterations;
	u[23] = S.columnIterations;
	f[24] = S.maxD;
	f[25] = S.minD;
	f[26] = S.c;
	const h0 = Math.fround(S.h0);
	f[27] = h0;
	f[28] = S.h0 - h0;
	f[29] = S.sinP1;
	f[30] = S.cosP1;
	u[31] = S.segRing.length;
	u[32] = S.octBase.length;
	u[33] = S.rings.length;
	u[34] = S.k0;
	u[35] = x.azOff;
	return buf;
}

export interface GpuRayScene {
	/** Hit frame at the camera's resolution divided by `stride`: 4 f32 per pixel (E, N, U, range; -1 = sky). */
	frame(cam: RayCamera, stride?: number): Promise<Float32Array>;
	/** Wall ms from submit to onSubmittedWorkDone of one frame dispatch (no readback, no upload). */
	timeFrame(cam: RayCamera, stride?: number): Promise<number>;
	/** The dispatch's GPU timestamp (ms) when the device has timestamp-query, else null. */
	timestampFrame(cam: RayCamera, stride?: number): Promise<number | null>;
	/** Horizon elevations in degrees at azimuths i * step; -90 = no terrain. */
	columns(step?: number): Promise<Float64Array>;
	destroy(): void;
}

interface Run {
	wx: number;
	wy: number;
}

/** Uploads the scene's params; one graph per output size (destroy() releases everything). */
export async function createGpuRayScene(
	device: Device,
	mosaics: Mosaic[],
	S: RayScene,
	columnStep = 0.1,
): Promise<GpuRayScene> {
	const set = await uploadMosaics(device, mosaics);
	const nAz = Math.round(360 / columnStep);
	const azimuths = Array.from({ length: nAz }, (_, i) => i * columnStep);
	const { words, azOff } = packScene(S, set, azimuths);
	const params = storage(device, words);
	const dummy = storage(device, 16);
	const pages = [0, 1, 2, 3].map((i) => set.pages[i] ?? dummy);
	await kernelAsync(device, RAYCAST);
	const graphs = new Map<number, { g: ComputeGraph<Run>; out: Buffer }>();
	const graphFor = async (outBytes: number) => {
		let e = graphs.get(outBytes);
		if (e) return e;
		const g = new ComputeGraph<Run>(device, `raycast-${outBytes}`);
		const u = g.importBuffer(
			"u",
			U_WORDS * 4,
			undefined,
			Buffer.UNIFORM | Buffer.COPY_DST,
		);
		const hParams = g.importBuffer(
			"params",
			params.byteLength,
			undefined,
			Buffer.STORAGE | Buffer.COPY_DST,
		);
		const hPg = pages.map((p, i) =>
			g.importBuffer(`pg${i}`, p.byteLength, undefined, Buffer.STORAGE),
		);
		const hOut = g.importBuffer(
			"out",
			outBytes,
			undefined,
			Buffer.STORAGE | Buffer.COPY_SRC,
		);
		g.addKernel({
			id: "raycast",
			spec: RAYCAST,
			bindings: {
				u,
				params: hParams,
				pg0: hPg[0],
				pg1: hPg[1],
				pg2: hPg[2],
				pg3: hPg[3],
				outBuf: hOut,
			},
			workgroups: (p) => [p.wx, p.wy, 1],
			writes: { outBuf: "full" },
		});
		await g.compileAsync();
		e = { g, out: storage(device, outBytes) };
		graphs.set(outBytes, e);
		return e;
	};
	const bindings = (u: Buffer, out: Buffer) => ({
		u,
		params,
		pg0: pages[0],
		pg1: pages[1],
		pg2: pages[2],
		pg3: pages[3],
		out,
	});
	const dims = (cam: RayCamera, stride: number) => ({
		W: Math.floor(cam.width / stride),
		H: Math.floor(cam.height / stride),
	});
	const frameU = (cam: RayCamera, stride: number) => {
		const { W, H } = dims(cam, stride);
		return uniform(
			device,
			packUniform({ mode: 0, W, H, stride, cam, azOff, S }),
		);
	};
	return {
		async frame(cam, stride = 1) {
			const { W, H } = dims(cam, stride);
			const bytes = W * H * 16;
			const { g, out } = await graphFor(bytes);
			const u = frameU(cam, stride);
			const enc = device.createCommandEncoder({ id: "raycast-frame" });
			g.encode(
				enc,
				{ wx: Math.ceil(W / 8), wy: Math.ceil(H / 8) },
				bindings(u, out),
			);
			const rd = stage(device, enc, out, bytes);
			submit(device, enc);
			const ab = await rd.read();
			release(u);
			return new Float32Array(ab);
		},
		async timeFrame(cam, stride = 1) {
			const { W, H } = dims(cam, stride);
			const { g, out } = await graphFor(W * H * 16);
			const u = frameU(cam, stride);
			const enc = device.createCommandEncoder({ id: "raycast-time" });
			g.encode(
				enc,
				{ wx: Math.ceil(W / 8), wy: Math.ceil(H / 8) },
				bindings(u, out),
			);
			const t0 = performance.now();
			submit(device, enc);
			const fence = device.createFence();
			await fence.signaled;
			const ms = performance.now() - t0;
			fence.destroy();
			release(u);
			return ms;
		},
		async timestampFrame(cam, stride = 1) {
			if (!device.features.has("timestamp-query")) return null;
			const { W, H } = dims(cam, stride);
			const { g, out } = await graphFor(W * H * 16);
			const u = frameU(cam, stride);
			const res = await g.run(
				{ wx: Math.ceil(W / 8), wy: Math.ceil(H / 8) },
				{ buffers: bindings(u, out), timings: true },
			);
			release(u);
			return res.timings?.gpuTimeMilliseconds ?? null;
		},
		async columns(step = columnStep) {
			if (step !== columnStep)
				throw new Error("columns: step fixed at creation");
			const bytes = nAz * 4;
			const { g, out } = await graphFor(bytes);
			const rowW = 512;
			const rows = Math.ceil(nAz / rowW);
			const u = uniform(
				device,
				packUniform({ mode: 1, W: rowW, H: rows, stride: 1, nAz, azOff, S }),
			);
			const enc = device.createCommandEncoder({ id: "raycast-columns" });
			g.encode(
				enc,
				{ wx: rowW / 8, wy: Math.ceil(rows / 8) },
				bindings(u, out),
			);
			const rd = stage(device, enc, out, bytes);
			submit(device, enc);
			const slopes = new Float32Array(await rd.read());
			release(u);
			return Float64Array.from(slopes, (s) =>
				s < -1e29 ? -90 : Math.atan(s) / DEG,
			);
		},
		destroy() {
			for (const e of graphs.values()) {
				e.g.destroy();
				e.out.destroy();
			}
			graphs.clear();
			params.destroy();
			dummy.destroy();
		},
	};
}
