// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// In-browser A/B check for layers/batched-terrain.ts against the per-tile TerrainCore (CPU
// buildMesh meshes) on the SAME tiles, imagery, look and pose, inside the running lab
// (/lab/deck-webgpu, any host). The lab streams full meshes (terrain=tiles); this adds each tile's
// batch grid (buildBatchGrid on its own heights, as the streamer does under __RIGI_TERRAIN_BOTH__),
// swaps the batched core in, renders, and compares:
//   geometry  per-pixel coverage agreement, ENU / range error on common pixels (rgba32float target)
//   normal    angle between the two normal targets on common pixels
//   color     share of identical pixels after 8-bit sRGB encoding of the resolved colour
//             (target ≥ 99.8 %), and the share within 2/255
//   reproj    the lab's checkGeometry() with the batched core (target maxErrPx ≤ 0.1)
// Run with playwright after the lab is ready:
//   await page.evaluate(async () => (await import("/src/lib/deck-webgpu/layers/batched-terrain.check.ts")).runBatchedTerrainCheck())
import type { Texture } from "@luma.gl/core";
import { buildBatchGrid } from "#/lib/deck/batched-terrain-grid";
import type { TileMesh } from "#/lib/deck/terrain-data";
import { getCpuHeights } from "#/lib/dem/cpu-heights";
import { EnuFrame } from "#/lib/geodesy";
import { getPhoto } from "#/lib/photos";
import type { Host } from "../hosts/direct";
import type { ImageryArray } from "../imagery";
import type { GpuLayerCore } from "../pass";
import { TextureReader } from "../readback";
import type { TerrainCore } from "../terrain";
import { BatchedTerrainCore } from "./batched-terrain";

type LabDebug = {
	host: Host;
	terrain: TerrainCore;
	imagery: ImageryArray | null;
	present: GpuLayerCore;
};

function halfToFloat(h: number) {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >> 10) & 0x1f;
	const f = h & 0x3ff;
	if (e === 0) return s * 2 ** -14 * (f / 1024);
	if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY;
	return s * 2 ** (e - 15) * (1 + f / 1024);
}

/** rgba16float texture → Float32Array rgba, top-first rows. */
async function readHalf(tex: Texture) {
	const device = tex.device;
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
		layout.byteLength / 2,
	);
	const stride = layout.bytesPerRow / 2;
	const out = new Float32Array(tex.width * tex.height * 4);
	for (let y = 0; y < tex.height; y++)
		for (let x = 0; x < tex.width * 4; x++)
			out[y * tex.width * 4 + x] = halfToFloat(u16[y * stride + x]);
	return out;
}

const enc8 = (c: number) => {
	const v = Math.max(0, Math.min(1, c));
	const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
	return Math.round(s * 255);
};

async function capture(host: Host, reader: TextureReader) {
	await host.nextFrame();
	await host.nextFrame();
	const geo = await reader.read(host.geometry.geometry);
	const nrm = await readHalf(host.geometry.normal);
	const col = await readHalf(host.color.color);
	return { geo, nrm, col };
}

export async function runBatchedTerrainCheck() {
	const hook = window.__deckWebgpuLab as unknown as {
		ready: boolean;
		stats(): { photo: string };
		checkGeometry(): Promise<{ maxErrPx: number; meanErrPx: number } | null>;
		_debug: LabDebug;
	};
	if (!hook?.ready) throw new Error("lab not ready");
	const { host, terrain, imagery, present } = hook._debug;
	const photo = getPhoto(hook.stats().photo);
	if (!photo) throw new Error("no photo");
	const frame = new EnuFrame(photo.lat, photo.lon, 0);
	// the lab's current tile set, with batch grids added (same heights → same surface)
	const cpuTiles = [
		...(
			terrain as unknown as { tiles: Map<string, { mesh: TileMesh }> }
		).tiles.values(),
	].map((t) => t.mesh);
	const t0 = performance.now();
	const meshes: TileMesh[] = cpuTiles
		.map((m) => ({
			...m,
			grid: m.grid ?? buildBatchGrid(frame, m.key, getCpuHeights(m)),
		}))
		.sort((a, b) => a.distance - b.distance);
	const gridMs = performance.now() - t0;

	const batched = new BatchedTerrainCore(host.device, imagery);
	batched.look = terrain.look;
	batched.setTiles(meshes);
	batched.syncImageryLayers();

	const reader = new TextureReader(host.device);
	const saved = host.cores;
	try {
		host.cores = [terrain, present];
		const a = await capture(host, reader);
		host.cores = [batched, present];
		const b = await capture(host, reader);
		const reproj = await hook.checkGeometry();
		const timing: number[] = [];
		for (let i = 0; i < 10; i++) {
			const t = performance.now();
			await host.nextFrame();
			timing.push(performance.now() - t);
		}
		const bStats = JSON.parse(JSON.stringify(batched.stats));
		host.cores = [terrain, present];
		const aTiming: number[] = [];
		for (let i = 0; i < 10; i++) {
			const t = performance.now();
			await host.nextFrame();
			aTiming.push(performance.now() - t);
		}
		if (!a.geo || !b.geo) throw new Error("geometry readback failed");

		// geometry / normal
		const n = a.geo.length / 4;
		let both = 0;
		let onlyA = 0;
		let onlyB = 0;
		let maxDxyz = 0;
		let sumDxyz = 0;
		let maxRelRange = 0;
		let over1pct = 0;
		let maxNormDeg = 0;
		// by range: < 1 km, 1–5, 5–20, > 20 km → [pixels, Σ normal deg, Σ |Δxyz|, pixels > 1°]
		const bins = [0, 1, 2, 3].map(() => [0, 0, 0, 0]);
		let sumNormDeg = 0;
		for (let i = 0; i < n; i++) {
			const ra = a.geo[i * 4 + 3];
			const rb = b.geo[i * 4 + 3];
			if (ra > 0 && rb > 0) {
				both++;
				const d = Math.hypot(
					a.geo[i * 4] - b.geo[i * 4],
					a.geo[i * 4 + 1] - b.geo[i * 4 + 1],
					a.geo[i * 4 + 2] - b.geo[i * 4 + 2],
				);
				sumDxyz += d;
				maxDxyz = Math.max(maxDxyz, d);
				const rel = Math.abs(ra - rb) / ra;
				maxRelRange = Math.max(maxRelRange, rel);
				if (rel > 0.01) over1pct++;
				// rgba16float normals are not unit length after quantisation: normalise both
				const na = a.nrm.subarray(i * 4, i * 4 + 3);
				const nb = b.nrm.subarray(i * 4, i * 4 + 3);
				const dot =
					(na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]) /
					(Math.hypot(na[0], na[1], na[2]) * Math.hypot(nb[0], nb[1], nb[2]) ||
						1);
				const deg = (Math.acos(Math.min(1, Math.max(-1, dot))) * 180) / Math.PI;
				sumNormDeg += deg;
				const bin = bins[ra < 1000 ? 0 : ra < 5000 ? 1 : ra < 20000 ? 2 : 3];
				bin[0]++;
				bin[1] += deg;
				bin[2] += d;
				if (deg > 1) bin[3]++;
				maxNormDeg = Math.max(maxNormDeg, deg);
			} else if (ra > 0) onlyA++;
			else if (rb > 0) onlyB++;
		}

		// colour (8-bit sRGB of the premultiplied resolve)
		const m = a.col.length / 4;
		let same = 0;
		let near2 = 0;
		let covered = 0;
		let maxDiff = 0;
		for (let i = 0; i < m; i++) {
			let dmax = 0;
			for (let c = 0; c < 4; c++) {
				const va =
					c === 3 ? Math.round(a.col[i * 4 + 3] * 255) : enc8(a.col[i * 4 + c]);
				const vb =
					c === 3 ? Math.round(b.col[i * 4 + 3] * 255) : enc8(b.col[i * 4 + c]);
				dmax = Math.max(dmax, Math.abs(va - vb));
			}
			if (a.col[i * 4 + 3] > 0 || b.col[i * 4 + 3] > 0) covered++;
			if (dmax === 0) same++;
			if (dmax <= 2) near2++;
			maxDiff = Math.max(maxDiff, dmax);
		}
		const med = (x: number[]) => [...x].sort((p, q) => p - q)[x.length >> 1];
		const result = {
			tiles: meshes.length,
			gridBuildMs: Math.round(gridMs),
			geometry: {
				size: [host.geometry.width, host.geometry.height],
				bothPx: both,
				onlyTilesPx: onlyA,
				onlyBatchedPx: onlyB,
				coverageAgreement: 1 - (onlyA + onlyB) / n,
				meanDxyzM: both ? sumDxyz / both : null,
				maxDxyzM: maxDxyz,
				maxRelRange,
				over1pctRange: over1pct / Math.max(1, both),
				meanNormalDeg: both ? sumNormDeg / both : null,
				maxNormalDeg: maxNormDeg,
				byRange: ["<1km", "1-5km", "5-20km", ">20km"].map((k, i) => ({
					range: k,
					px: bins[i][0],
					meanNormalDeg: bins[i][0] ? bins[i][1] / bins[i][0] : null,
					meanDxyzM: bins[i][0] ? bins[i][2] / bins[i][0] : null,
					over1deg: bins[i][0] ? bins[i][3] / bins[i][0] : null,
				})),
			},
			color: {
				size: [host.color.width, host.color.height],
				identical: same / m,
				within2: near2 / m,
				coveredPx: covered,
				maxDiff8: maxDiff,
			},
			reproj,
			frameMs: { tiles: med(aTiming), batched: med(timing) },
			batchedStats: bStats,
			// (page errors / WebGPU validation messages: the playwright driver collects the console)
			pass: same / m >= 0.998 && (reproj?.maxErrPx ?? 1) <= 0.1,
		};
		return result;
	} finally {
		host.cores = saved;
		reader.destroy();
		batched.destroy();
		await host.nextFrame();
	}
}
