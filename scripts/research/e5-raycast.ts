// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// FUND E5 harness (protocol: tools/research/fund/e5_raycast/PROTOCOL.txt). Dev eyes only.
//
//   npx tsx scripts/research/e5-raycast.ts eyes
//   npx tsx scripts/research/e5-raycast.ts cpu [--shard k/n] [--ids a,b]     # horizon-fast + CPU oracle columns
//   DAWN_DIR=/tmp/dawn npx tsx scripts/research/e5-raycast.ts gpu [--shard k/n] [--ids a,b]
//   npx tsx scripts/research/e5-raycast.ts aggregate                          # pooled metrics -> results.json
//
// Per-eye outputs go to out/e5/ (gitignored), the pooled results to tools/research/fund/e5_raycast/results.json.
// Exit 2 without a WebGPU adapter (gpu stage).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { MAPTERHORN } from "../../src/lib/dem";
import { DEG } from "../../src/lib/geodesy";
import {
	adoptRenderDevice,
	COMPUTE_FEATURES,
	gpuEnabled,
	RAISED_LIMITS,
} from "../../src/lib/gpu/device";
import {
	computeHorizonGpu,
	releaseHorizonGpu,
} from "../../src/lib/gpu/horizon";
import { computeHorizonFast } from "../../src/lib/horizon-fast/march";
import {
	DEFAULT_RINGS,
	loadMosaics,
	type Mosaic,
	TileStore,
} from "../../src/lib/horizon-fast/mosaic";
import {
	columnProfile,
	createGpuRayScene,
	makeRayScene,
	type RayCamera,
	rayCastFrame,
} from "../../src/lib/raycast";
import { demTileLoaderNode } from "../lib/node-io";

const ROOT = path.resolve(import.meta.dirname, "../..");
const MAIN = "/Users/robertchristie/Documents/GitHub/mt-image";
const OUT = path.join(ROOT, "out/e5");
const STUDY = path.join(ROOT, "tools/research/fund/e5_raycast");
const STEP = 0.1;
const MAX_D = 150_000;
const argv = process.argv.slice(2);
const stage = argv[0];
const opt = (k: string, d: string | null = null) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

interface EyeRec {
	id: string;
	set: "gt" | "dev";
	lat: number;
	lon: number;
	h: number;
	hfov: number;
	hfovSource: string;
	/** render pose for the 1024x768 timing frame (GT photos with a pose only) */
	pose: { yaw: number; pitch: number; roll: number; vfov: number } | null;
}

/** 54 eyes: GT-19 + dev wild photos with a stated eye (protocol "EYES"). */
function buildEyes(): EyeRec[] {
	const eyes: EyeRec[] = [];
	const gt = JSON.parse(
		fs.readFileSync(path.join(ROOT, "data/ground-truth.json"), "utf8"),
	);
	for (const [id, v] of Object.entries<Record<string, number>>(gt)) {
		const hfov = v.f ? (2 * Math.atan(v.width / (2 * v.f))) / DEG : 60;
		let pose = null;
		if (v.yaw !== null && v.f) {
			const vfov =
				(2 * Math.atan(Math.tan((hfov * DEG) / 2) * (768 / 1024))) / DEG;
			pose = { yaw: v.yaw, pitch: v.pitch, roll: v.roll, vfov };
		}
		eyes.push({
			id,
			set: "gt",
			lat: v.lat,
			lon: v.lon,
			h: v.eye,
			hfov,
			hfovSource: v.f ? "ground-truth f" : "unknown, 60",
			pose,
		});
	}
	const dev: string[] = JSON.parse(
		fs.readFileSync(path.join(OUT, "dev_ids.json"), "utf8"),
	);
	const manifest: { id: string; width: number; height: number }[] = JSON.parse(
		fs.readFileSync(path.join(MAIN, "tools/bench/data/manifest.json"), "utf8"),
	);
	for (const id of dev) {
		const f = path.join(MAIN, "out/geocam/decoys", `${id}.json`);
		if (!fs.existsSync(f)) continue; // 15 dev ids have no stated eye height: excluded
		const d = JSON.parse(fs.readFileSync(f, "utf8"));
		const m = manifest.find((x) => x.id === id);
		let hfov = 60;
		let src = "unknown, 60";
		if (d.focalKnown && m) {
			hfov =
				(2 * Math.atan(Math.tan((d.vfov0 * DEG) / 2) * (m.width / m.height))) /
				DEG;
			src = "decoy vfov0 + manifest aspect";
		}
		eyes.push({
			id,
			set: "dev",
			lat: d.stated.lat,
			lon: d.stated.lon,
			h: d.stated.h,
			hfov,
			hfovSource: src,
			pose: null,
		});
	}
	return eyes;
}

function selected(eyes: EyeRec[]) {
	const ids = opt("ids")?.split(",");
	const shard = opt("shard")?.split("/").map(Number);
	return eyes.filter(
		(e, i) =>
			(!ids || ids.includes(e.id)) && (!shard || i % shard[1] === shard[0]),
	);
}

const store = new TileStore({
	tileSize: MAPTERHORN.tileSize,
	maxZoom: MAPTERHORN.maxZoom,
	load: demTileLoaderNode(MAPTERHORN),
});

async function mosaicsFor(e: EyeRec): Promise<Mosaic[]> {
	const m = await loadMosaics(e.lat, e.lon, store, {
		rings: DEFAULT_RINGS,
		maxDistance: MAX_D,
		mips: true,
	});
	store.clear();
	return m;
}

const writeJson = (name: string, v: unknown) =>
	fs.writeFileSync(path.join(OUT, name), JSON.stringify(v));
const readJson = (name: string) =>
	JSON.parse(fs.readFileSync(path.join(OUT, name), "utf8"));

const quantile = (xs: ArrayLike<number>, p: number) => {
	const s = Float64Array.from(xs).sort();
	if (!s.length) return Number.NaN;
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
};

/** |Δel| in px of a 1024-px-wide frame of the given hfov; one-sided -90 sentinel = Infinity. */
function dpx(a: ArrayLike<number>, b: ArrayLike<number>, hfov: number) {
	const out = new Float64Array(a.length);
	for (let i = 0; i < a.length; i++) {
		const sa = a[i] <= -89.999999;
		const sb = b[i] <= -89.999999;
		out[i] =
			sa && sb
				? 0
				: sa || sb
					? Number.POSITIVE_INFINITY
					: (Math.abs(a[i] - b[i]) * 1024) / hfov;
	}
	return out;
}

// ---------------------------------------------------------------- cpu stage
async function cpuStage() {
	for (const e of selected(buildEyes())) {
		const file = `cpu-${e.id}.json`;
		if (fs.existsSync(path.join(OUT, file)) && !opt("force")) continue;
		const t0 = Date.now();
		const mosaics = await mosaicsFor(e);
		const tLoad = Date.now() - t0;
		const eye = { lat: e.lat, lon: e.lon, h: e.h };
		const hf = computeHorizonFast(mosaics, eye, {
			step: STEP,
			maxDistance: MAX_D,
			noRidges: true,
		});
		const S = makeRayScene(mosaics, eye, { maxDistance: MAX_D });
		const t1 = performance.now();
		const prof = columnProfile(S, STEP);
		const msOracle = performance.now() - t1;
		writeJson(file, {
			id: e.id,
			zooms: mosaics.map((m) => m.z),
			loadMs: tLoad,
			hfMs: hf.stats.ms,
			oracleMs: msOracle,
			oracleSamples: S.samples,
			oracleSkips: S.skips,
			hf: Array.from(hf.elevation),
			oracle: Array.from(prof.elevation),
		});
		const d = dpx(hf.elevation, prof.elevation, e.hfov);
		console.log(
			`${e.id} z=${mosaics.map((m) => m.z).join("/")} hf ${hf.stats.ms.toFixed(0)} ms, oracle ${(msOracle / 1000).toFixed(1)} s, dpx p95 ${quantile(d, 0.95).toFixed(3)} max ${Math.max(...d).toFixed(2)}`,
		);
	}
}

// 100 km runs of horizon-fast and the CPU oracle (the cap dem.py has), GT eyes only; eyes.json for dempy_horizon.py
async function cap100Stage() {
	const all = buildEyes();
	fs.writeFileSync(
		path.join(OUT, "eyes.json"),
		JSON.stringify(all.filter((e) => e.set === "gt")),
	);
	for (const e of selected(all.filter((x) => x.set === "gt"))) {
		const file = `c100-${e.id}.json`;
		if (fs.existsSync(path.join(OUT, file)) && !opt("force")) continue;
		const mosaics = await mosaicsFor(e);
		const eye = { lat: e.lat, lon: e.lon, h: e.h };
		const hf = computeHorizonFast(mosaics, eye, {
			step: STEP,
			maxDistance: 100_000,
			noRidges: true,
		});
		const S = makeRayScene(mosaics, eye, { maxDistance: 100_000 });
		writeJson(file, {
			id: e.id,
			hf: Array.from(hf.elevation),
			oracle: Array.from(columnProfile(S, STEP).elevation),
		});
		console.log(`${e.id} 100 km done`);
	}
}

// ------------------------------------------- POST HOC dense reference (never changes the verdict)
async function denseStage() {
	for (const e of selected(buildEyes())) {
		const file = `dense-${e.id}.json`;
		if (fs.existsSync(path.join(OUT, file)) && !opt("force")) continue;
		const mosaics = await mosaicsFor(e);
		const eye = { lat: e.lat, lon: e.lon, h: e.h };
		const dense = { cellSteps: 0.05, stepFactor: 3.5e-5, maxDistance: MAX_D };
		const hf = computeHorizonFast(mosaics, eye, {
			...dense,
			step: STEP,
			noRidges: true,
		});
		const S = makeRayScene(mosaics, eye, dense);
		const prof = columnProfile(S, STEP);
		writeJson(file, {
			id: e.id,
			hfDense: Array.from(hf.elevation),
			oracleDense: Array.from(prof.elevation),
		});
		console.log(`${e.id} dense done`);
	}
}

// ---------------------------------------------------------------- gpu stage
async function dawnDevice(): Promise<Device | null> {
	const dir = process.env.DAWN_DIR;
	if (!dir) return null;
	const { create, globals } = await import(
		pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
	);
	Object.assign(globalThis, globals);
	const gpuApi = create([]);
	Object.defineProperty(globalThis, "navigator", {
		value: { gpu: gpuApi, userAgent: "node" },
		configurable: true,
	});
	// the app's sidecar request (gpu/device.ts createSidecar): adapter-maximum limits, optional features
	const peek = await (gpuApi as unknown as GPU).requestAdapter({
		powerPreference: "high-performance",
	} as GPURequestAdapterOptions);
	if (!peek) return null;
	const requiredLimits: Record<string, number> = {};
	for (const k of RAISED_LIMITS) {
		const v = (peek.limits as unknown as Record<string, unknown>)[k];
		if (typeof v === "number") requiredLimits[k] = v;
	}
	const { webgpuAdapter } = await import("@luma.gl/webgpu");
	return await webgpuAdapter.create({
		id: "e5-raycast",
		powerPreference: "high-performance",
		featureLevel: "core",
		optionalFeatures: COMPUTE_FEATURES,
		requiredLimits,
	} as never);
}

const median = (xs: number[]) => quantile(xs, 0.5);

function ringCell(mosaics: Mosaic[], d: number) {
	for (const m of mosaics) if (d <= m.maxDistance) return m.cellMeters;
	return mosaics[mosaics.length - 1].cellMeters;
}

/** frame agreement: both sky, or both hit within max(1 % range, 2 cells of the serving ring). */
function depthAgreement(
	mosaics: Mosaic[],
	a: { range: ArrayLike<number>; ground?: ArrayLike<number> },
	b: { range: ArrayLike<number> },
) {
	let agree = 0;
	let skyMismatch = 0;
	let hitBoth = 0;
	const rel: number[] = [];
	const n = a.range.length;
	for (let i = 0; i < n; i++) {
		const sa = !(a.range[i] >= 0 && Number.isFinite(a.range[i]));
		const sb = !(b.range[i] >= 0 && Number.isFinite(b.range[i]));
		if (sa && sb) agree++;
		else if (sa !== sb) skyMismatch++;
		else {
			hitBoth++;
			const tol = Math.max(
				0.01 * b.range[i],
				2 * ringCell(mosaics, b.range[i]),
			);
			const diff = Math.abs(a.range[i] - b.range[i]);
			if (diff <= tol) agree++;
			rel.push(diff / b.range[i]);
		}
	}
	return {
		n,
		agree: agree / n,
		skyMismatch,
		hitBoth,
		relP50: quantile(rel, 0.5),
		relP95: quantile(rel, 0.95),
		relMax: rel.length ? Math.max(...rel) : 0,
	};
}

/** GPU 4-per-pixel frame sampled on the (stride)-grid of a W x H frame: range per sample (NaN sky). */
function gpuRangeGrid(
	frame: Float32Array,
	W: number,
	H: number,
	stride: number,
) {
	const w = Math.floor(W / stride);
	const h = Math.floor(H / stride);
	const range = new Float64Array(w * h);
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			const x = i * stride + (stride >> 1);
			const y = j * stride + (stride >> 1);
			const r = frame[4 * (y * W + x) + 3];
			range[j * w + i] = r < 0 ? Number.POSITIVE_INFINITY : r;
		}
	return { range, w, h };
}

async function gpuStage() {
	const device = await dawnDevice();
	if (!device) {
		console.error("no WebGPU device: set DAWN_DIR (npm i webgpu@0.3.0 there)");
		process.exit(2);
	}
	adoptRenderDevice(device);
	if (!gpuEnabled()) {
		console.error("gpuEnabled() false after adopting the Dawn device");
		process.exit(2);
	}
	console.log(
		"device features:",
		[...device.features].filter((f) => f.includes("timestamp")).join(",") ||
			"(no timestamp-query)",
	);
	for (const e of selected(buildEyes())) {
		const file = `gpu-${e.id}.json`;
		if (fs.existsSync(path.join(OUT, file)) && !opt("force")) continue;
		const mosaics = await mosaicsFor(e);
		const eye = { lat: e.lat, lon: e.lon, h: e.h };
		const S = makeRayScene(mosaics, eye, { maxDistance: MAX_D });
		const rec: Record<string, unknown> = { id: e.id, loadavg: os.loadavg() };
		// GPU horizon (src/lib/gpu/horizon) on the same mosaics
		const th = performance.now();
		const [gh] = await computeHorizonGpu(device, mosaics, [eye], {
			step: STEP,
			maxDistance: MAX_D,
			noRidges: true,
		});
		rec.gpuHorizonMs = performance.now() - th;
		rec.gpuHorizon = Array.from(gh.elevation);
		releaseHorizonGpu(mosaics);
		const rc = await createGpuRayScene(device, mosaics, S, STEP);
		// GPU oracle columns
		const tc = performance.now();
		const cols = await rc.columns(STEP);
		rec.gpuOracleColumnsMs = performance.now() - tc;
		rec.gpuOracle = Array.from(cols);
		if (e.pose) {
			const cam: RayCamera = { pose: e.pose, width: 1024, height: 768 };
			for (let i = 0; i < 3; i++) await rc.timeFrame(cam);
			const times: number[] = [];
			for (let i = 0; i < 15; i++) times.push(await rc.timeFrame(cam));
			rec.frameMs = times;
			rec.frameMedianMs = median(times);
			const ts: number[] = [];
			for (let i = 0; i < 5; i++) {
				const t = await rc.timestampFrame(cam);
				if (t !== null) ts.push(t);
			}
			if (ts.length) rec.timestampMs = ts;
			// full frame readback: sky fraction, and (depth subset) agreement on the 128 x 96 grid
			const frame = await rc.frame(cam);
			let sky = 0;
			for (let i = 0; i < 1024 * 768; i++) if (frame[4 * i + 3] < 0) sky++;
			rec.skyFraction = sky / (1024 * 768);
			if (argv.includes("--depth") || DEPTH_EYES.includes(e.id)) {
				const grid = gpuRangeGrid(frame, 1024, 768, 8);
				const t0 = performance.now();
				const cpuF = rayCastFrame(S, cam, 8);
				const cpuMs = performance.now() - t0;
				const dense = makeRayScene(mosaics, eye, {
					maxDistance: MAX_D,
					mipSkip: false,
					cellSteps: 0.1,
					stepFactor: 3.5e-5,
				});
				const t1 = performance.now();
				const brute = rayCastFrame(dense, cam, 8);
				const bruteMs = performance.now() - t1;
				const cell = (r: Float64Array) => ({ range: r });
				rec.depth = {
					grid: [grid.w, grid.h],
					cpuOracleMs128x96: cpuMs,
					cpuOracleUsPerRay: (cpuMs * 1000) / (grid.w * grid.h),
					bruteMs128x96: bruteMs,
					gpuVsCpu: depthAgreement(mosaics, cell(grid.range), cell(cpuF.range)),
					gpuVsBrute: depthAgreement(
						mosaics,
						cell(grid.range),
						cell(brute.range),
					),
					cpuVsBrute: depthAgreement(
						mosaics,
						cell(cpuF.range),
						cell(brute.range),
					),
				};
			}
		}
		rc.destroy();
		releaseHorizonGpu(mosaics);
		writeJson(file, rec);
		console.log(
			`${e.id} gpu horizon ${(rec.gpuHorizonMs as number).toFixed(0)} ms, oracle cols ${(rec.gpuOracleColumnsMs as number).toFixed(0)} ms` +
				(rec.frameMedianMs
					? `, frame median ${(rec.frameMedianMs as number).toFixed(1)} ms`
					: ""),
		);
	}
}

/** GT eyes whose frame is also compared against the CPU oracle and the brute-force march (protocol: 3 to 5). */
const DEPTH_EYES = ["IMG_7155", "IMG_7018", "IMG_6958", "IMG_7131", "IMG_5495"];

// ---------------------------------------------------------------- aggregate
function stats(xs: ArrayLike<number>) {
	return {
		n: xs.length,
		p50: quantile(xs, 0.5),
		p95: quantile(xs, 0.95),
		p99: quantile(xs, 0.99),
		max: Array.from(xs).reduce(
			(m, v) => (v > m ? v : m),
			Number.NEGATIVE_INFINITY,
		),
	};
}

function aggregate() {
	const eyes = buildEyes();
	const have = eyes.filter((e) =>
		fs.existsSync(path.join(OUT, `cpu-${e.id}.json`)),
	);
	const missing = eyes.filter((e) => !have.includes(e)).map((e) => e.id);
	const pooled = {
		hfVsOracle: [] as number[],
		gpuHorizonVsHf: [] as number[],
		gpuHorizonVsOracle: [] as number[],
		gpuOracleVsOracle: [] as number[],
		gpuOracleVsHf: [] as number[],
		gpuOracleDeg: [] as number[],
	};
	const posthoc = {
		oracleVsDenseMarch: [] as number[],
		marchVsDenseMarch: [] as number[],
		oracleVsDenseOracle: [] as number[],
		marchVsDenseOracle: [] as number[],
		denseMarchVsDenseOracle: [] as number[],
	};
	const mk = () => ({
		vsMarch100: [] as number[],
		vsOracle100: [] as number[],
		marchVsOracle100: [] as number[],
	});
	const demPy = { dmin20: mk(), dmin5: mk() };
	const perEye: Record<string, unknown>[] = [];
	const frameTimes: number[] = [];
	for (const e of have) {
		const c = readJson(`cpu-${e.id}.json`);
		const dHO = dpx(c.hf, c.oracle, e.hfov);
		for (const v of dHO) pooled.hfVsOracle.push(v);
		const row: Record<string, unknown> = {
			id: e.id,
			set: e.set,
			hfov: e.hfov,
			hfovSource: e.hfovSource,
			zooms: c.zooms,
			hfMs: c.hfMs,
			oracleCpuMs: c.oracleMs,
			hfVsOracle: stats(dHO),
		};
		for (const [tag, prefix] of [
			["dmin20", "dempy"],
			["dmin5", "dempy5"],
		] as const) {
			const dm = path.join(OUT, `${prefix}-${e.id}.json`);
			const c1 = path.join(OUT, `c100-${e.id}.json`);
			if (!fs.existsSync(dm) || !fs.existsSync(c1)) continue;
			const dpy = readJson(`${prefix}-${e.id}.json`);
			const k = readJson(`c100-${e.id}.json`);
			const a = dpx(dpy.el, k.hf, e.hfov);
			const b = dpx(dpy.el, k.oracle, e.hfov);
			for (const v of a) demPy[tag].vsMarch100.push(v);
			for (const v of b) demPy[tag].vsOracle100.push(v);
			if (tag === "dmin20")
				for (const v of dpx(k.hf, k.oracle, e.hfov))
					demPy[tag].marchVsOracle100.push(v);
			if (!row.demPy) row.demPy = {};
			(row.demPy as Record<string, unknown>)[tag] = {
				vsMarch100: stats(a),
				vsOracle100: stats(b),
				marchVsOracle100: stats(dpx(k.hf, k.oracle, e.hfov)),
			};
		}
		const dp = path.join(OUT, `dense-${e.id}.json`);
		if (fs.existsSync(dp)) {
			const d = readJson(`dense-${e.id}.json`);
			const a = dpx(c.oracle, d.hfDense, e.hfov);
			const b = dpx(c.hf, d.hfDense, e.hfov);
			const o = dpx(c.oracle, d.oracleDense, e.hfov);
			const m = dpx(c.hf, d.oracleDense, e.hfov);
			const dd = dpx(d.hfDense, d.oracleDense, e.hfov);
			for (const v of a) posthoc.oracleVsDenseMarch.push(v);
			for (const v of b) posthoc.marchVsDenseMarch.push(v);
			for (const v of o) posthoc.oracleVsDenseOracle.push(v);
			for (const v of m) posthoc.marchVsDenseOracle.push(v);
			for (const v of dd) posthoc.denseMarchVsDenseOracle.push(v);
			row.posthoc = {
				oracleVsDenseOracle: stats(o),
				marchVsDenseOracle: stats(m),
				denseMarchVsDenseOracle: stats(dd),
			};
		}
		const gp = path.join(OUT, `gpu-${e.id}.json`);
		if (fs.existsSync(gp)) {
			const g = readJson(`gpu-${e.id}.json`);
			const a = dpx(g.gpuHorizon, c.hf, e.hfov);
			const b = dpx(g.gpuHorizon, c.oracle, e.hfov);
			const o = dpx(g.gpuOracle, c.oracle, e.hfov);
			const oh = dpx(g.gpuOracle, c.hf, e.hfov);
			for (const v of a) pooled.gpuHorizonVsHf.push(v);
			for (const v of b) pooled.gpuHorizonVsOracle.push(v);
			for (const v of o) pooled.gpuOracleVsOracle.push(v);
			for (const v of oh) pooled.gpuOracleVsHf.push(v);
			for (let i = 0; i < c.oracle.length; i++)
				if (g.gpuOracle[i] > -89.99 && c.oracle[i] > -89.99)
					pooled.gpuOracleDeg.push(Math.abs(g.gpuOracle[i] - c.oracle[i]));
			row.gpuHorizonVsHf = stats(a);
			row.gpuHorizonVsOracle = stats(b);
			row.gpuOracleVsOracle = stats(o);
			row.gpuOracleVsHf = stats(oh);
			row.gpuHorizonMs = g.gpuHorizonMs;
			row.gpuOracleColumnsMs = g.gpuOracleColumnsMs;
			if (g.frameMs) {
				for (const t of g.frameMs) frameTimes.push(t);
				row.frame = {
					medianMs: g.frameMedianMs,
					timestampMedianMs: g.timestampMs ? median(g.timestampMs) : null,
					maxMs: Math.max(...g.frameMs),
					skyFraction: g.skyFraction,
					depth: g.depth,
				};
			}
		}
		perEye.push(row);
	}
	const pooledStats = Object.fromEntries(
		Object.entries(pooled).map(([k, v]) => [k, v.length ? stats(v) : null]),
	);
	const p95a = pooled.hfVsOracle.length
		? quantile(pooled.hfVsOracle, 0.95)
		: Number.NaN;
	const medB = frameTimes.length ? median(frameTimes) : Number.NaN;
	const results = {
		note: "dev, n = eyes below, not a result",
		protocol: "tools/research/fund/e5_raycast/PROTOCOL.txt",
		eyes: have.length,
		eyesMissingCpu: missing,
		criterionA: {
			pooledP95Px: p95a,
			threshold: 0.5,
			pass: p95a <= 0.5,
			samples: pooled.hfVsOracle.length,
		},
		criterionB: {
			medianFrameMs: medB,
			threshold: 50,
			pass: medB <= 50,
			frames: frameTimes.length,
			posedEyes: perEye.filter((r) => r.frame).length,
		},
		verdict:
			p95a <= 0.5 && medB <= 50
				? "PASS"
				: Number.isNaN(p95a) || Number.isNaN(medB)
					? "INCOMPLETE"
					: "KILL",
		pooledPxStats: pooledStats,
		demPy: Object.fromEntries(
			Object.entries(demPy).map(([tag, set]) => [
				tag,
				Object.fromEntries(
					Object.entries(set).map(([k, v]) => [k, v.length ? stats(v) : null]),
				),
			]),
		),
		posthocDense: Object.fromEntries(
			Object.entries(posthoc).map(([k, v]) => [k, v.length ? stats(v) : null]),
		),
		perEye,
	};
	fs.writeFileSync(
		path.join(STUDY, "results.json"),
		`${JSON.stringify(results, null, 1)}\n`,
	);
	console.log(
		`eyes ${have.length}/${eyes.length}; (a) pooled p95 ${p95a.toFixed(4)} px; (b) median frame ${medB.toFixed(2)} ms -> ${results.verdict}`,
	);
}

fs.mkdirSync(OUT, { recursive: true });
if (stage === "eyes") {
	const e = buildEyes();
	console.log(e.length, "eyes");
	for (const x of e)
		console.log(
			x.id,
			x.set,
			x.lat.toFixed(4),
			x.lon.toFixed(4),
			x.h.toFixed(1),
			x.hfov.toFixed(1),
			x.pose ? "pose" : "",
		);
} else if (stage === "cpu") await cpuStage();
else if (stage === "dense") await denseStage();
else if (stage === "cap100") await cap100Stage();
else if (stage === "gpu") await gpuStage();
else if (stage === "aggregate") aggregate();
else {
	console.error("usage: e5-raycast.ts eyes|cpu|gpu|aggregate");
	process.exit(1);
}
