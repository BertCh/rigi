// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The GPU haze fit's gathers and airlight band (src/lib/gpu/look/haze-graph.ts, haze-band.ts: luma
// GPUGather for every gather, GPUCompaction for the band) on a real luma WebGPU device in node
// (Dawn), on synthetic scenes (haze-emulate.ts makeHazeScene):
//  (a) the GPU band's pixel indices and K equal the CPU airlightBand exactly (integer work);
//  (b) the gathered words equal CPU indexing of the GPU's own lin / range planes exactly: the band's
//      lin (band path, read back from the prep's lin buffer), the lists' range bits at the lists'
//      pixel indices, and the prep graph's / gather graph's sky lin against the CPU lin (tolerance:
//      the GPU's lin is f32 box-filter arithmetic);
//  (c) the three GPU fit paths (fitHazeGpu, fitHazeFromPrep with the GPU band, with the CPU band) vs
//      the CPU fitHaze: max relative difference of the HazeFit, NaN count.
// Then medians of the wall-clock of each path on a larger scene (same device, so old and new code
// can be compared by running the script on both commits).
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/haze-band-dawn.ts [scenes] [reps]
//
// SKIP (exit 0) without DAWN_DIR or an adapter; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import { airlightBand, fitHazeGpu } from "../../src/lib/gpu/look/haze";
import {
	makeHazeScene,
	sceneOptions,
} from "../../src/lib/gpu/look/haze-emulate";
import {
	fitHazeFromPrep,
	hazeGraphProbe,
	hazeGraphStats,
} from "../../src/lib/gpu/look/haze-graph";
import { hazePrepArrays } from "../../src/lib/gpu/look/textures";
import {
	fitHaze,
	type HazeFit,
	type HazeFitInput,
} from "../../src/lib/look/haze-fit";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP haze-band-dawn: DAWN_DIR not set");
	process.exit(0);
}
const SCENES = Number(process.argv[2] ?? 6);
const REPS = Number(process.argv[3] ?? 7);
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
// keep the instance referenced: Dawn drops pipelines of a collected instance
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log("SKIP haze-band-dawn: no adapter");
	process.exit(0);
}
const device = (await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "haze-band-dawn" },
	true,
)) as Device;
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

/** fitHazeGpu's CPU-built prep arrays (xyzr geometry, row 0 = top). */
function prepArrays(h: HazeFitInput) {
	const { geoW: W, geoH: H, sky, foreground: fg } = h;
	const N = W * H;
	const g = h.geo.data;
	const range = new Float32Array(N);
	const pSky = new Float32Array(N);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			range[y * W + x] = g[((H - 1 - y) * W + x) * 4 + 3];
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			if (sky) {
				const mx = Math.min(
					sky.width - 1,
					Math.floor(((x + 0.5) * sky.width) / W),
				);
				const my = Math.min(
					sky.height - 1,
					Math.floor(((y + 0.5) * sky.height) / H),
				);
				pSky[i] = sky.data[my * sky.width + mx] / 255;
			} else pSky[i] = range[i] > 0 ? 0 : 1;
		}
	const fgBits = new Uint32Array(Math.ceil(N / 32));
	if (fg)
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const mx = Math.min(
					fg.width - 1,
					Math.floor(((x + 0.5) * fg.width) / W),
				);
				const my = Math.min(
					fg.height - 1,
					Math.floor(((y + 0.5) * fg.height) / H),
				);
				if (fg.data[my * fg.width + mx] > 64) {
					const i = y * W + x;
					fgBits[i >> 5] |= 1 << (i & 31);
				}
			}
	return { W, H, photo: h.photo, range, pSky, fgBits, hasFg: !!fg };
}

const readLin = async (
	prep: Awaited<ReturnType<typeof hazePrepArrays>>,
	N: number,
) =>
	new Float32Array(
		(await prep.buffers.lin.readAsync(0, N * 12)).slice().buffer,
	);

/** Largest relative difference over the fit's scalar and vector fields, and NaNs. */
function compareFits(c: HazeFit, g: HazeFit) {
	let max = 0;
	let nan = 0;
	const rel = (a: number, b: number) => {
		if (!Number.isFinite(b)) nan++;
		return Math.abs(a - b) / Math.max(1e-12, Math.abs(a));
	};
	for (const k of ["visibility", "quality", "rms", "betaM", "hM"] as const)
		max = Math.max(max, rel(c[k], g[k]));
	for (const k of ["airlight", "betaR", "j0", "beta"] as const)
		for (let i = 0; i < 3; i++) max = Math.max(max, rel(c[k][i], g[k][i]));
	return { max, nan };
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>, n = a.length) => {
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
	return a.length >= n && b.length >= n;
};

let worstFit = 0;
let worstLin = 0;
for (let seed = 0; seed < SCENES; seed++) {
	const o = { ...sceneOptions(seed), rangeOnly: false };
	const input = makeHazeScene(o);
	const label = `scene ${seed} ${o.width}x${o.height}`;
	const arrays = prepArrays(input);
	const { W, H, range, pSky } = arrays;
	const cpuBand = airlightBand(range, pSky, W, H);
	const cpuFit = fitHaze(input);
	const geoIn = { geo: input.geo, eyeAlt: input.eyeAlt, sunDir: input.sunDir };

	// path 1: fitHazeGpu (prep graph, K from the CPU band)
	const f1 = await fitHazeGpu(device, input);
	const sky1 = hazeGraphProbe.sky as Float32Array;
	if (!same(hazeGraphProbe.skyIdx as Uint32Array, cpuBand))
		fail(`${label}: prep graph band indices`);
	if (sky1.length !== 3 * cpuBand.length) fail(`${label}: prep sky length`);

	// path 2: the GPU band
	const prep = await hazePrepArrays(device, arrays);
	const linBits = await readLin(prep, W * H);
	const f2 = await fitHazeFromPrep(device, prep, geoIn, { bandGpu: true });
	const band = hazeGraphStats.band;
	const idx2 = hazeGraphProbe.skyIdx as Uint32Array;
	if (band === "gpu") {
		if (!same(idx2, cpuBand) || idx2.length !== cpuBand.length)
			fail(
				`${label}: GPU band indices differ from airlightBand (K ${idx2.length} vs ${cpuBand.length})`,
			);
		const sky2 = hazeGraphProbe.sky as Float32Array;
		for (let k = 0; k < idx2.length; k++)
			for (let c = 0; c < 3; c++)
				if (sky2[3 * k + c] !== linBits[3 * idx2[k] + c]) {
					fail(`${label}: band lin word ${k}.${c}`);
					k = idx2.length;
					break;
				}
		const li = hazeGraphProbe.listIdx as Uint32Array;
		const lr = hazeGraphProbe.listRange as Float32Array;
		const total = hazeGraphStats.total;
		for (let k = 0; k < total; k++)
			if (lr[k] !== range[li[k]]) {
				fail(`${label}: list range word ${k}`);
				break;
			}
	} else
		console.log(`  ${label}: band path "${band}" (short band, CPU band ran)`);

	// path 3: the CPU band (the gather graph)
	const prep3 = await hazePrepArrays(device, arrays);
	const lin3 = await readLin(prep3, W * H);
	const f3 = await fitHazeFromPrep(device, prep3, geoIn, { bandGpu: false });
	const idx3 = hazeGraphProbe.skyIdx as Uint32Array;
	const sky3 = hazeGraphProbe.sky as Float32Array;
	if (!same(idx3, cpuBand)) fail(`${label}: gather graph band indices`);
	for (let k = 0; k < idx3.length; k++)
		for (let c = 0; c < 3; c++)
			if (sky3[3 * k + c] !== lin3[3 * idx3[k] + c]) {
				fail(`${label}: gather graph lin word ${k}.${c}`);
				k = idx3.length;
				break;
			}
	// the prep graph's sky (its lin is a transient): against the other paths' gathered lin
	let linDiff = 0;
	for (let k = 0; k < cpuBand.length; k++)
		for (let c = 0; c < 3; c++)
			linDiff = Math.max(
				linDiff,
				Math.abs(sky1[3 * k + c] - lin3[3 * cpuBand[k] + c]),
			);
	worstLin = Math.max(worstLin, linDiff);
	if (linDiff > 1e-6) fail(`${label}: prep graph sky vs lin ${linDiff}`);

	const r1 = compareFits(cpuFit, f1);
	const r2 = compareFits(cpuFit, f2);
	const r3 = compareFits(cpuFit, f3);
	worstFit = Math.max(worstFit, r1.max, r2.max, r3.max);
	console.log(
		`${label}: K ${cpuBand.length} band ${band}; fit vs CPU max rel gpu ${r1.max.toExponential(2)} band ${r2.max.toExponential(2)} cpu-band ${r3.max.toExponential(2)}; NaN ${r1.nan + r2.nan + r3.nan}`,
	);
	for (const r of [r1, r2, r3])
		if (r.nan || r.max > 1e-3) fail(`${label}: fit`);
}
console.log(
	`worst fit rel diff vs CPU ${worstFit.toExponential(2)}, worst sky lin abs diff ${worstLin.toExponential(2)}`,
);

// the fallback band (under 20 band pixels: every sky pixel, K far above the band's kMax): the
// gathers' power-of-two capacity buckets, on a mostly-sky scene
{
	const o = { ...sceneOptions(1), rangeOnly: false };
	const input = makeHazeScene(o);
	const arrays = prepArrays(input);
	// all sky: no terrain row, so no band, and airlightBand falls back to every range-0 pixel
	arrays.range.fill(0);
	arrays.pSky.fill(1);
	const { W, H, range, pSky } = arrays;
	const cpuBand = airlightBand(range, pSky, W, H);
	const geoIn = { geo: input.geo, eyeAlt: input.eyeAlt, sunDir: input.sunDir };
	console.log(`fallback scene ${W}x${H}: CPU band K ${cpuBand.length}`);
	for (const bandGpu of [true, false]) {
		const prep = await hazePrepArrays(device, arrays);
		const lin = await readLin(prep, W * H);
		try {
			await fitHazeFromPrep(device, prep, geoIn, { bandGpu });
		} catch (e) {
			console.log(
				`  fit threw (degenerate scene, gathers still checked): ${e}`,
			);
		}
		const idx = hazeGraphProbe.skyIdx as Uint32Array;
		const sky = hazeGraphProbe.sky as Float32Array;
		if (!same(idx, cpuBand) || idx.length !== cpuBand.length)
			fail(`fallback bandGpu=${bandGpu}: indices`);
		for (let k = 0; k < idx.length; k++)
			for (let c = 0; c < 3; c++)
				if (sky[3 * k + c] !== lin[3 * idx[k] + c]) {
					fail(`fallback bandGpu=${bandGpu}: lin word ${k}.${c}`);
					k = idx.length;
					break;
				}
	}
}

// random planes (a ragged skyline, odd and even widths, NaN / ±0 / threshold values laced in): band
// indices, K and the gathered words against the CPU, whatever the fit then makes of them
{
	const special = [0, -0, 0.5, 0.7, Math.fround(0.7), 1, -1, Number.NaN, 150];
	let lcgState = 12345;
	const rnd = () => {
		lcgState = (Math.imul(lcgState, 1664525) + 1013904223) >>> 0;
		return lcgState / 4294967296;
	};
	let cases = 0;
	{
		// the fallback scene above left the device in "short band" mode: one CPU-band fit on a normal
		// scene (a long band) switches the GPU band back on
		const input = makeHazeScene({ ...sceneOptions(0), rangeOnly: false });
		await fitHazeFromPrep(
			device,
			await hazePrepArrays(device, prepArrays(input)),
			{ geo: input.geo, eyeAlt: input.eyeAlt, sunDir: input.sunDir },
			{ bandGpu: false },
		);
	}
	for (let t = 0; t < 10; t++) {
		const width = 40 + Math.floor(rnd() * 200);
		const height = 30 + Math.floor(rnd() * 120);
		const input = makeHazeScene({
			...sceneOptions(t),
			rangeOnly: false,
			width,
			height,
		});
		const arrays = prepArrays(input);
		const { W, H, range, pSky } = arrays;
		const skyline = rnd() * H;
		const lace = rnd() * 0.15;
		for (let y = 0; y < H; y++)
			for (let x = 0; x < W; x++) {
				const i = y * W + x;
				const sky = y < skyline + 5 * Math.sin(x * 0.2 + t);
				range[i] = sky ? 0 : 100 + rnd() * 1e5;
				pSky[i] = sky ? 0.6 + rnd() * 0.4 : rnd() * 0.6;
				if (rnd() < lace)
					range[i] = special[Math.floor(rnd() * special.length)];
				if (rnd() < lace) pSky[i] = special[Math.floor(rnd() * special.length)];
			}
		const cpuBand = airlightBand(range, pSky, W, H);
		const geoIn = {
			geo: input.geo,
			eyeAlt: input.eyeAlt,
			sunDir: input.sunDir,
		};
		const prep = await hazePrepArrays(device, arrays);
		const lin = await readLin(prep, W * H);
		try {
			await fitHazeFromPrep(device, prep, geoIn, { bandGpu: true });
		} catch {
			// a degenerate fit is fine here, the gathers are what is checked
		}
		const label = `random ${t} ${W}x${H}`;
		cases++;
		const idx = hazeGraphProbe.skyIdx as Uint32Array;
		const sky = hazeGraphProbe.sky as Float32Array;
		if (hazeGraphStats.band === "gpu") {
			if (idx.length !== cpuBand.length || !same(idx, cpuBand))
				fail(`${label}: band indices (K ${idx.length} vs ${cpuBand.length})`);
			for (let k = 0; k < idx.length; k++)
				for (let c = 0; c < 3; c++)
					if (sky[3 * k + c] !== lin[3 * idx[k] + c]) {
						fail(`${label}: lin word ${k}.${c}`);
						k = idx.length;
						break;
					}
		}
		console.log(
			`  ${label}: CPU K ${cpuBand.length}, band path ${hazeGraphStats.band}`,
		);
	}
	console.log(`random planes: ${cases} cases`);
}

// timings on a larger scene
{
	const o = {
		...sceneOptions(2),
		rangeOnly: false,
		width: 1024,
		height: 768,
		skyRows: 160,
	};
	const input = makeHazeScene(o);
	const arrays = prepArrays(input);
	const geoIn = { geo: input.geo, eyeAlt: input.eyeAlt, sunDir: input.sunDir };
	const paths: Record<string, () => Promise<unknown>> = {
		"fitHazeGpu (prep graph)": () => fitHazeGpu(device, input),
		"fromPrep gpu band": async () =>
			fitHazeFromPrep(device, await hazePrepArrays(device, arrays), geoIn, {
				bandGpu: true,
			}),
		"fromPrep cpu band": async () =>
			fitHazeFromPrep(device, await hazePrepArrays(device, arrays), geoIn, {
				bandGpu: false,
			}),
	};
	console.log(`timings ${o.width}x${o.height}, median of ${REPS} (ms):`);
	for (const [name, run] of Object.entries(paths)) {
		await run();
		await run();
		const ts: number[] = [];
		const gpuTs: number[] = [];
		for (let i = 0; i < REPS; i++) {
			const t = performance.now();
			await run();
			ts.push(performance.now() - t);
			gpuTs.push(hazeGraphStats.gpuMs ?? 0);
		}
		console.log(
			`  ${name.padEnd(26)} ${median(ts).toFixed(1)}  gpu part ${median(gpuTs).toFixed(1)} (min ${Math.min(...gpuTs).toFixed(1)})  band=${hazeGraphStats.band}`,
		);
	}
}

console.log(failed ? `FAIL ${failed}` : "PASS haze-band-dawn");
process.exit(failed ? 1 : 0);
