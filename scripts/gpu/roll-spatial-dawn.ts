// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Roll building at camera-roll scale on a real luma WebGPU device in node (Dawn): the GPU
// neighbour pairs (GPUGridIndex + pair kernel) against the CPU twin and the brute force on 100 /
// 2 000 / 20 000 points (clustered hikes plus a global scatter), clusterPhotosAsync and
// uploadRollsAsync against the sync roll.ts results, and the GPUSegmentedSort / GPUSort capture
// order against the CPU comparator. Exact equality is required; timings are informational.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx vite-node -c vitest.config.ts scripts/gpu/roll-spatial-dawn.ts [maxPoints]
// (vite-node, not tsx: roll.ts reads the virtual:photos module)
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { destination } from "../../src/lib/geodesy";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import type { PhotoMeta } from "../../src/lib/photos";
import {
	clusterPhotos,
	ROLL_LINK_M,
	uploadRolls,
	VIEWPOINT_RADIUS_M,
} from "../../src/lib/roll/roll";
import {
	clusterPhotosAsync,
	clusterPhotosHashed,
	uploadRollsAsync,
} from "../../src/lib/roll/spatial/cluster";
import {
	neighbourPairsBrute,
	neighbourPairsCpu,
	neighbourPairsGpu,
} from "../../src/lib/roll/spatial/neighbours";
import {
	sortGroupsByTime,
	sortGroupsByTimeCpu,
	sortOrdersGpu,
} from "../../src/lib/roll/spatial/sort";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP roll-spatial-dawn: DAWN_DIR not set");
	process.exit(0);
}
const MAX_POINTS = Number(process.argv[2] ?? 20000);
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log("SKIP roll-spatial-dawn: no adapter");
	process.exit(0);
}
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);
const features = COMPUTE_FEATURES.filter((f) => adapter.features.has(f));
const handle = await adapter.requestDevice({
	requiredFeatures: features,
	requiredLimits: Object.fromEntries(
		(["maxStorageBufferBindingSize", "maxBufferSize"] as const).map((k) => [
			k,
			adapter.limits[k],
		]),
	),
});
const device = (await attachWebGPUDevice(
	handle,
	{ id: "roll-spatial-dawn" },
	true,
)) as Device;

let failed = 0;
const check = (ok: boolean, message: string) => {
	console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
	if (!ok) failed++;
};
const time = async <T>(f: () => Promise<T> | T) => {
	const t = performance.now();
	const value = await f();
	return { value, ms: performance.now() - t };
};

function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const T0 = Date.parse("2025-08-01T10:00:00Z");
function scene(seed: number, total: number): PhotoMeta[] {
	const r = rng(seed);
	const out: PhotoMeta[] = [];
	const add = (lat: number, lon: number) => {
		out.push({
			id: `p${out.length}`,
			src: "",
			width: 4000,
			height: 3000,
			takenAt: new Date(T0 + Math.floor(r() * 400) * 60_000).toISOString(),
			lat,
			lon,
			alt: 1500,
			hAccuracy: null,
			heading: 120,
			f35: 26,
			vfov: 55,
			gravity: null,
			pitch: 3,
			roll: -1,
			holding: null,
			region: "x",
		} as PhotoMeta);
	};
	// 85 % in hikes (a few km across, spread over the world), 15 % global scatter incl. antimeridian
	const hikes = Math.max(3, Math.round(total / 400));
	const centres = Array.from({ length: hikes }, () => ({
		lat: (r() - 0.5) * 150,
		lon: r() < 0.1 ? 179.9 + r() * 0.2 : (r() - 0.5) * 360,
	}));
	while (out.length < total * 0.85) {
		const c = centres[Math.floor(r() * centres.length)];
		const d = destination(c.lat, c.lon, r() * 360, r() * r() * 6000);
		add(d.lat, ((d.lon + 540) % 360) - 180);
	}
	while (out.length < total) add((r() - 0.5) * 180, (r() - 0.5) * 360);
	return out;
}
const sameGroups = (a: PhotoMeta[][], b: PhotoMeta[][]) =>
	JSON.stringify(a.map((g) => g.map((m) => m.id))) ===
	JSON.stringify(b.map((g) => g.map((m) => m.id)));
const samePairs = (a: Uint32Array, b: Uint32Array) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

for (const n of [100, 2000, 20000].filter((x) => x <= MAX_POINTS)) {
	const ms = scene(n, n);
	for (const radius of [VIEWPOINT_RADIUS_M, ROLL_LINK_M]) {
		const label = `n=${n} r=${radius}`;
		const cpu = await time(() => neighbourPairsCpu(ms, radius));
		const hashed = await time(() => neighbourPairsCpu(ms, radius));
		const brute =
			n <= 2000 ? await time(() => neighbourPairsBrute(ms, radius)) : null;
		const warm = await neighbourPairsGpu(device, ms, radius); // pipeline compile
		const g = await time(() => neighbourPairsGpu(device, ms, radius));
		void warm;
		if (!g.value) {
			console.log(
				`INFO ${label}: GPU pair list over budget (CPU streams), ${cpu.value.length / 2} pairs`,
			);
			continue;
		}
		check(
			samePairs(g.value, cpu.value),
			`${label}: GPU pairs == CPU hashed (${g.value.length / 2} pairs)`,
		);
		if (brute)
			check(
				samePairs(g.value, brute.value),
				`${label}: GPU pairs == brute force`,
			);
		console.log(
			`INFO ${label}: brute ${brute ? brute.ms.toFixed(1) : "n/a"} ms, hashed ${hashed.ms.toFixed(1)} ms, gpu ${g.ms.toFixed(1)} ms (warm, incl. exact confirm)`,
		);
	}
	const ref = clusterPhotos(ms);
	const hashedClusters = await time(() => clusterPhotosHashed(ms));
	const gpuClusters = await time(() =>
		clusterPhotosAsync(ms, ROLL_LINK_M, device),
	);
	check(
		sameGroups(ref, hashedClusters.value),
		`n=${n}: clusterPhotosHashed == clusterPhotos (${ref.length} rolls)`,
	);
	check(
		sameGroups(ref, gpuClusters.value),
		`n=${n}: clusterPhotosAsync(GPU) == clusterPhotos`,
	);
	console.log(
		`INFO n=${n}: cluster hashed ${hashedClusters.ms.toFixed(1)} ms, gpu ${gpuClusters.ms.toFixed(1)} ms`,
	);

	const t = await time(() => sortGroupsByTimeCpu(ref));
	const orders = await sortOrdersGpu(device, ref);
	const sortedGpu = await time(() => sortGroupsByTime(ref, device));
	check(
		sameGroups(t.value, sortedGpu.value),
		`n=${n}: GPU capture order == CPU order`,
	);
	const onGpu = orders.filter((o) => o).length;
	const multi = ref.filter((x) => x.length > 1).length;
	check(
		onGpu === multi,
		`n=${n}: ${onGpu}/${multi} multi-photo rolls ordered on the GPU (biggest roll ${Math.max(...ref.map((x) => x.length))})`,
	);
	console.log(
		`INFO n=${n}: sort cpu ${t.ms.toFixed(1)} ms, gpu ${sortedGpu.ms.toFixed(1)} ms`,
	);

	const rollsRef = await time(() => uploadRolls(ms));
	const rollsGpu = await time(() => uploadRollsAsync(ms, device));
	check(
		JSON.stringify(rollsRef.value) === JSON.stringify(rollsGpu.value),
		`n=${n}: uploadRollsAsync(GPU) == uploadRolls (${rollsRef.value.length} rolls)`,
	);
	console.log(
		`INFO n=${n}: uploadRolls ${rollsRef.ms.toFixed(1)} ms, uploadRollsAsync(gpu) ${rollsGpu.ms.toFixed(1)} ms`,
	);
}

device.destroy();
console.log(failed ? `\n${failed} FAILED` : "\nall PASS");
process.exit(failed ? 1 : 0);
