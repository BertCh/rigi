#!/usr/bin/env node
// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WAG W1.5 gate: the batched terrain's GPU cull + indirect draws (flag terrainGpuCull,
// layers/terrain-cull.ts) against the CPU cull (BatchedTerrainCore.visibleRows), in the real app
// (/photo/<id>?renderer=webgpu, WebGpuEngine, terrain=batched).
//   pixels   the same poses rendered with the CPU cull and with the GPU cull: the raw bytes of the
//            geometry targets (xyz+range, normal+class) and of the resolved colour target must be
//            EQUAL. A CPU-vs-CPU repeat of every pose is the control (proves the frame is
//            deterministic, so a GPU-vs-CPU difference is the cull's)
//   cpu ms   per-frame CPU ms of the terrain core (prepass + draw, geometry + colour passes;
//            stats.cpuMs) over N panned frames per path, median; plus the host's encode ms
// The GPU path must really run: every GPU capture requires stats.cullPath = gpu for both passes.
// Run (own dev server, render lock):
//   npx vite dev --port 3127 --strictPort &
//   node scripts/gpu/with-render-lock.mjs -- node scripts/deck-webgpu/terrain-indirect-check.mjs \
//     --url http://localhost:3127 --photos IMG_7086,IMG_6958 --frames 60
// Exit 1 on any byte difference, a non-deterministic control, or a GPU path that did not run.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { GPU_ARGS } from "./gpu-args.mjs";

const arg = (k, d) => {
	const i = process.argv.indexOf(`--${k}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg("url", process.env.APP_URL ?? "http://localhost:3127");
const IDS = arg("photos", "IMG_7086,IMG_6958").split(",");
const FRAMES = Number(arg("frames", "60"));
const OUT = resolve(arg("out", "out/deck-webgpu/terrain-indirect"));
mkdirSync(OUT, { recursive: true });

/** In-page helpers (installed once per page). */
const INSTALL = () => {
	const w = window;
	const e = w.__engine;
	const setCull = (on) => {
		w.__RIGI_FLAGS__ = {
			...(w.__RIGI_FLAGS__ ?? {}),
			terrainGpuCull: on ? "on" : "off",
		};
	};
	const terrain = () => e.gpu?.terrain;
	const readTex = async (tex) => {
		const device = tex.device;
		const layout = tex.computeMemoryLayout();
		const buf = device.createBuffer({
			byteLength: layout.byteLength,
			usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
		});
		tex.readBuffer({}, buf);
		const bytes = await buf.readAsync(0, layout.byteLength);
		buf.destroy();
		return new Uint8Array(bytes);
	};
	/** render until the wanted cull path ran in both passes (the GPU graph compiles async) */
	const settle = async (gpu) => {
		const t = terrain();
		for (let i = 0; i < 30; i++) {
			await e.nextFrame("all");
			const p = t.stats.cullPath;
			const want = gpu ? "gpu" : "cpu";
			if (p.geometry === want && p.color === want) return true;
			await new Promise((r) => setTimeout(r, 30));
		}
		return false;
	};
	/** wait until the streamed tile set stops changing (no pending tiles, same set for 1 s) */
	const quiet = async () => {
		let last = null;
		let since = performance.now();
		const t0 = performance.now();
		while (performance.now() - t0 < 60_000) {
			await e.nextFrame("all");
			const set = e.renderSet;
			const key = `${set?.tiles?.length}|${set?.stats?.pending ?? 0}|${terrain().stats.tiles}`;
			if (key !== last || (set?.stats?.pending ?? 0) > 0) {
				last = key;
				since = performance.now();
			} else if (performance.now() - since > 1000) return true;
			await new Promise((r) => setTimeout(r, 100));
		}
		return false;
	};
	const capture = async () => {
		const host = e.hostInstance;
		return {
			geo: await readTex(host.geometry.geometry),
			nrm: await readTex(host.geometry.normal),
			col: await readTex(host.color.color),
		};
	};
	const diff = (a, b) => {
		const out = {};
		for (const k of Object.keys(a)) {
			let n = 0;
			const x = a[k];
			const y = b[k];
			if (x.length !== y.length) {
				out[k] = -1;
				continue;
			}
			for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) n++;
			out[k] = n;
		}
		return out;
	};
	w.__tic = { setCull, terrain, settle, quiet, capture, diff };
};

const POSES = [
	["base", {}],
	["yaw+15", { yaw: 15 }],
	["yaw-45", { yaw: -45 }],
	["yaw+90", { yaw: 90 }],
	["yaw+180", { yaw: 180 }],
	["pitch+8", { pitch: 8 }],
	["pitch-12", { pitch: -12 }],
	["zoom-in", { vfovScale: 0.4 }],
	["zoom-out", { vfovScale: 1.6 }],
];

const POSE_CHECK = async ({ name, d }) => {
	const w = window;
	const e = w.__engine;
	const { setCull, settle, quiet, capture, diff, terrain } = w.__tic;
	const p0 = w.__p0;
	const pose = {
		...p0,
		yaw: p0.yaw + (d.yaw ?? 0),
		pitch: p0.pitch + (d.pitch ?? 0),
		vfov: p0.vfov * (d.vfovScale ?? 1),
	};
	if (d.yaw != null || d.pitch != null || d.vfovScale != null) e.setPose(pose);
	let r = null;
	// CPU A, GPU, CPU B: the control A = B brackets the GPU capture (retried while the scene moves)
	for (let attempt = 0; attempt < 4; attempt++) {
		setCull(false);
		const isQuiet = await quiet();
		const okCpu = await settle(false);
		const cpuA = await capture();
		const statsCpu = JSON.parse(JSON.stringify(terrain().stats));
		setCull(true);
		const okGpu = await settle(true);
		const gpu = await capture();
		const statsGpu = JSON.parse(JSON.stringify(terrain().stats));
		setCull(false);
		await settle(false);
		const cpuB = await capture();
		r = {
			name,
			attempt,
			isQuiet,
			okCpu,
			okGpu,
			control: diff(cpuA, cpuB),
			gpuVsCpu: diff(cpuA, gpu),
			bytes: {
				geo: cpuA.geo.length,
				nrm: cpuA.nrm.length,
				col: cpuA.col.length,
			},
			cpu: {
				drawn: statsCpu.drawn,
				culled: statsCpu.culled,
				draws: statsCpu.draws,
			},
			gpu: { draws: statsGpu.draws, cullPath: statsGpu.cullPath },
		};
		if (Object.values(r.control).every((v) => v === 0)) break;
	}
	return r;
};

/** N panned frames per path: terrain-core CPU ms (prepass + draw, both passes) and host encode ms. */
const CPU_MS = async ({ n }) => {
	const w = window;
	const e = w.__engine;
	const { setCull, settle, terrain } = w.__tic;
	const p0 = w.__p0;
	const med = (a) => {
		const s = [...a].sort((x, y) => x - y);
		return s.length ? s[Math.floor(s.length / 2)] : null;
	};
	const out = {};
	for (const gpu of [false, true, false, true]) {
		setCull(gpu);
		e.setPose(p0);
		const ok = await settle(gpu);
		const core = [];
		const enc = [];
		let wrongPath = 0;
		for (let i = 0; i < n; i++) {
			e.setPose({ ...p0, yaw: p0.yaw + 0.25 * (i + 1) });
			await e.nextFrame("all");
			const s = terrain().stats;
			if (
				s.cullPath.geometry !== (gpu ? "gpu" : "cpu") ||
				s.cullPath.color !== (gpu ? "gpu" : "cpu")
			)
				wrongPath++;
			core.push(s.cpuMs.geometry + s.cpuMs.color);
			const h = e.hostInstance.stats;
			enc.push((h.geometryMs ?? 0) + (h.colorMs ?? 0));
		}
		const key = gpu ? "gpu" : "cpu";
		const prev = out[key];
		const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
		const r = {
			ok,
			wrongPath,
			coreMs: med(core),
			coreMeanMs: mean(core),
			encodeMs: med(enc),
			encodeMeanMs: mean(enc),
			n,
		};
		// two rounds per path (interleaved); keep both
		out[key] = prev ? [...[prev].flat(), r] : [r];
	}
	setCull(false);
	e.setPose(p0);
	return out;
};

/**
 * Microbench of the per-pass CPU work each path adds, at the current pose (the frame figures above
 * sit at the timer's resolution): the CPU cull (visibleRows) vs the GPU path's prepare (pack the
 * camera, queue-write the uniform, record the two-node graph). The GPU arm records into two scratch
 * encoders that are never submitted (alternating, so the encoder ring reuses one entry).
 */
const MICRO = async ({ n }) => {
	const w = window;
	const { setCull, settle, terrain } = w.__tic;
	const t = terrain();
	let camera = null;
	const orig = t.prepass;
	t.prepass = function (ctx) {
		if (ctx.kind === "color") camera = ctx.camera;
		return orig.call(this, ctx);
	};
	setCull(true);
	await settle(true);
	t.prepass = orig;
	if (!camera || !t.gpuCull) return null;
	const ctx = { camera };
	let t0 = performance.now();
	for (let i = 0; i < n; i++) t.visibleRows(ctx, "color");
	const cpuUs = ((performance.now() - t0) / n) * 1000;
	const device = t.device;
	const encs = [device.createCommandEncoder(), device.createCommandEncoder()];
	const m = Math.max(1, Math.floor(n / 4));
	t0 = performance.now();
	for (let i = 0; i < m; i++) t.gpuCull.prepare(encs[i & 1], camera);
	const gpuUs = ((performance.now() - t0) / m) * 1000;
	for (const c of encs) c.destroy?.();
	setCull(false);
	await settle(false);
	return {
		tiles: t.stats.tiles,
		cpuCullUsPerPass: cpuUs,
		gpuPrepareUsPerPass: gpuUs,
		n,
		m,
	};
};

async function runPhoto(browser, id) {
	const errors = [];
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
	page.on("console", (m) => {
		if (m.type() === "error" && !/Failed to load resource/.test(m.text()))
			errors.push(`error: ${m.text().slice(0, 300)}`);
	});
	await page.addInitScript(() => {
		try {
			localStorage.clear();
		} catch {}
	});
	const url = `${BASE}/photo/${id}?renderer=webgpu`;
	await page.goto(url);
	await page.waitForSelector("[data-ready]", {
		timeout: 240_000,
		state: "attached",
	});
	const engine = await page.evaluate(() => ({
		renderer: document
			.querySelector("[data-renderer]")
			?.getAttribute("data-renderer"),
		backend: window.__engine?.backend,
		terrain: window.__engine?.gpu?.terrain?.constructor?.name,
	}));
	const r = { id, url, engine, errors, poses: [] };
	if (engine.backend !== "webgpu" || !/Batched/.test(engine.terrain ?? "")) {
		r.fatal = `not the WebGPU engine with the batched terrain: ${JSON.stringify(engine)}`;
		await page.close();
		return r;
	}
	await page.evaluate(INSTALL);
	await page.evaluate(() => {
		window.__p0 = { ...window.__engine.pose };
	});
	for (const [name, d] of POSES)
		r.poses.push(await page.evaluate(POSE_CHECK, { name, d }));
	// world view: geometry pass through the photo camera, colour pass through the orbit camera
	await page.evaluate(() => window.__engine.setSettings({ mode: "world" }));
	await page.waitForTimeout(500);
	r.poses.push(await page.evaluate(POSE_CHECK, { name: "world", d: {} }));
	await page.evaluate(() => window.__engine.setSettings({ mode: "overlay" }));
	await page.waitForTimeout(300);
	r.cpuMs = await page.evaluate(CPU_MS, { n: FRAMES });
	r.micro = await page.evaluate(MICRO, { n: 4000 });
	await page.close();
	return r;
}

const browser = await chromium.launch({ headless: true, args: GPU_ARGS });
const results = [];
let failed = 0;
try {
	for (const id of IDS) {
		const r = await runPhoto(browser, id);
		results.push(r);
		console.log(`\n${id}: engine ${JSON.stringify(r.engine)}`);
		if (r.fatal) {
			console.log(`  FAIL ${r.fatal}`);
			failed++;
			continue;
		}
		for (const p of r.poses) {
			const ctl = Object.values(p.control).every((v) => v === 0);
			const eq = Object.values(p.gpuVsCpu).every((v) => v === 0);
			const ok = p.okCpu && p.okGpu && ctl && eq;
			if (!p.isQuiet)
				console.log(`  note ${p.name}: tile set never went quiet (60 s)`);
			if (!ok) failed++;
			console.log(
				`  ${ok ? "PASS" : "FAIL"} ${p.name.padEnd(9)} (try ${p.attempt}) gpu-vs-cpu differing bytes ${JSON.stringify(p.gpuVsCpu)} control ${JSON.stringify(p.control)} paths cpu=${p.okCpu} gpu=${p.okGpu} cpu drawn/culled ${JSON.stringify(p.cpu.drawn)}/${JSON.stringify(p.cpu.culled)} draws cpu ${JSON.stringify(p.cpu.draws)} gpu ${JSON.stringify(p.gpu.draws)}`,
			);
		}
		const c = r.cpuMs;
		const m = (rs, k) => rs.map((x) => x[k]?.toFixed(3)).join(" / ");
		console.log(
			`  cpu ms over ${FRAMES} panned frames, two interleaved rounds (median | mean; performance.now() is coarsened to ~0.1 ms, so the mean is the finer figure):`,
		);
		console.log(
			`    terrain core (prepass + draw, both passes): cpu ${m(c.cpu, "coreMs")} | ${m(c.cpu, "coreMeanMs")}  gpu ${m(c.gpu, "coreMs")} | ${m(c.gpu, "coreMeanMs")}`,
		);
		console.log(
			`    host encode (geometry + colour passes):     cpu ${m(c.cpu, "encodeMs")} | ${m(c.cpu, "encodeMeanMs")}  gpu ${m(c.gpu, "encodeMs")} | ${m(c.gpu, "encodeMeanMs")}`,
		);
		if (r.micro)
			console.log(
				`    microbench at the base pose, ${r.micro.tiles} resident tiles: CPU cull (visibleRows) ${r.micro.cpuCullUsPerPass.toFixed(1)} µs/pass vs GPU prepare (pack + uniform write + graph encode) ${r.micro.gpuPrepareUsPerPass.toFixed(1)} µs/pass`,
			);
		console.log(
			`    wrong-path frames gpu ${c.gpu.map((x) => x.wrongPath).join("/")}`,
		);
		if (c.gpu.some((x) => !x.ok || x.wrongPath)) failed++;
		if (r.errors.length)
			console.log(`  page errors: ${r.errors.slice(0, 5).join(" | ")}`);
	}
} finally {
	await browser.close();
}
writeFileSync(resolve(OUT, "result.json"), JSON.stringify(results, null, 2));
console.log(
	`\n${failed ? `FAIL (${failed})` : "PASS"}; ${resolve(OUT, "result.json")}`,
);
process.exit(failed ? 1 : 0);
