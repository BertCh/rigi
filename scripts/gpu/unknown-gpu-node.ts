// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// One arm of the ?unknownGpu gate (scripts/gpu/unknown-gpu-gate.mjs) in node, without a browser: the
// unknown-pose worker's own scene + solve code (src/lib/integration/unknown-pose-core.ts) on a native
// WebGPU device (Dawn, the `webgpu` npm package) adopted as the compute device. Same photos, conditions
// and row format as the gate's browser `run`, so its `compare` scores either.
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/unknown-gpu-node.ts --set gt12|wild --unknown-gpu on|off
//       --out out/gpu/unknown-gate/<set>-node-<arm>.json [--ids a,b] [--solve-gpu on|off] [--fused on|off]
//       [--horizon-jitter <deg>:<seed>] [--skyline-gpu on|off]
//
// --horizon-jitter adds seeded uniform noise of ±deg to every horizon elevation (after the march, either
// arm): a noise arm for the precision question. Node runs are deterministic (base vs base is identical),
// so "is the GPU's change bigger than noise?" is asked against the CPU horizon jittered by about the GPU's
// own elevation error (CPU vs GPU march on the GT-12 scenes: median 2e-6–1e-5°, RMS 2e-5–2.4e-4°, max 0.02°).
//
// Arms as the app runs them on WebGPU: the coarse grid on the GPU (solveGpu, gpuEnabled()) in both,
// the 360° horizon on the CPU (off) or the GPU march fused with the solve's resident profile (on).
// Differences from the browser run: the photo is decoded and downscaled to the worker's 800 px by
// @napi-rs/canvas (not Chrome's drawImage), DEM tiles come from .cache/dem-mapterhorn through
// demTileLoaderNode (not the page's tile cache), and the GPU is Dawn on the host (Metal on macOS)
// through node, not Chrome's. Both arms share all three, so on vs off isolates the horizon.
// Exit 2 when no adapter / package is available.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { MAPTERHORN } from "../../src/lib/dem";
import { setFlagOverride } from "../../src/lib/flags";
import { adoptRenderDevice, gpuEnabled } from "../../src/lib/gpu/device";
import type { UnknownPoseRequest } from "../../src/lib/integration/unknown-pose";
import {
	computeUnknownScene,
	fusedFor,
	solveUnknownPose,
	type UnknownScene,
} from "../../src/lib/integration/unknown-pose-core";
import { demTileLoaderNode, loadRGBA } from "../lib/node-io";
// photos() reads --set / --ids from this process's argv, exactly as the browser gate does
import { photos } from "./unknown-gpu-gate.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const argv = process.argv.slice(2);
const opt = (k: string, d: string | null = null) => {
	const i = argv.indexOf(`--${k}`);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const set = opt("set", "gt12") as string;
const gpu = opt("unknown-gpu", "off") === "on";
const solveGpuWanted = opt("solve-gpu", "on") === "on";
const fusedWanted = opt("fused", "on") === "on";
// --skyline-gpu on|off: the ?skylineGpu arm (detectSkylineAsync: GPU cost images vs the CPU detector)
setFlagOverride("skylineGpu", opt("skyline-gpu", "off") as string);
// --mosaic-gpu on|off: the ?mosaicGpu arm (the march's max-mip pyramid built on the GPU or the CPU)
setFlagOverride("mosaicGpu", opt("mosaic-gpu", "on") as string);
// --mosaic-gpu on|off: the ?mosaicGpu arm (the march's max-mip pyramid built on the GPU vs the CPU)
setFlagOverride("mosaicGpu", opt("mosaic-gpu", "on") as string);
const jitter = opt("horizon-jitter")?.split(":").map(Number) ?? null;

/** The scene with its elevations jittered by ±amp (seeded LCG), a copy: the cached scene stays exact. */
function jittered(s: UnknownScene, amp: number, seed: number): UnknownScene {
	let x = seed >>> 0 || 1;
	const rnd = () => {
		x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
		return x / 4294967296;
	};
	const elevation = Float32Array.from(
		s.horizon.elevation,
		(e) => e + (2 * rnd() - 1) * amp,
	);
	return { ...s, horizon: { ...s.horizon, elevation } };
}
const out = path.resolve(
	ROOT,
	opt(
		"out",
		`out/gpu/unknown-gate/${set}-node-${gpu ? "on" : "off"}.json`,
	) as string,
);
/** the worker's WORK_WIDTH (src/lib/integration/unknown-pose.ts) */
const WORK_WIDTH = 800;

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
	const { luma } = await import("@luma.gl/core");
	const { webgpuAdapter } = await import("@luma.gl/webgpu");
	return luma.createDevice({
		type: "webgpu",
		adapters: [webgpuAdapter],
		createCanvasContext: false,
	} as never);
}

type Prior = { yaw: number; pitch: number; roll: number; vfov: number };
type Photo = {
	id: string;
	lat: number;
	lon: number;
	alt: number | null;
	hAccuracy: number | null;
	conds: [string, { yaw: boolean; gravity: boolean; focal: boolean }, Prior][];
};

function photoFile(id: string) {
	for (const f of [
		path.join(ROOT, "public/photos", `${id}.jpg`),
		path.join(ROOT, "tools/bench/data/photos", `${id}.jpg`),
	])
		if (fs.existsSync(f)) return f;
	return null;
}

async function main() {
	const device = await dawnDevice();
	if (!device) {
		console.error(
			"no WebGPU device: set DAWN_DIR to a directory with `npm i webgpu@0.3.0`",
		);
		process.exit(2);
	}
	adoptRenderDevice(device);
	if (!gpuEnabled()) {
		console.error("gpuEnabled() is false after adopting the Dawn device");
		process.exit(2);
	}
	const loadTile = demTileLoaderNode(MAPTERHORN);
	const list = photos() as Photo[];
	const rows: Record<string, unknown>[] = [];
	let seq = 0;
	for (const e of list) {
		const t0 = Date.now();
		const file = photoFile(e.id);
		if (!file) {
			console.error(`${e.id}: no photo file, skipped`);
			continue;
		}
		const full = await loadRGBA(file);
		const image = await loadRGBA(file, WORK_WIDTH);
		// one scene per photo, as the worker's horizonAt cache (computed on the first solve)
		let scene: Promise<UnknownScene> | null = null;
		const res: Record<string, unknown>[] = [];
		for (const [cond, u, prior] of e.conds) {
			const req: UnknownPoseRequest = {
				type: "solve",
				id: ++seq,
				lat: e.lat,
				lon: e.lon,
				alt: e.alt,
				gpsAccuracy: e.hAccuracy,
				width: full.width,
				height: full.height,
				prior,
				unknown: { ...u },
				image: {
					width: image.width,
					height: image.height,
					data: new Uint8ClampedArray(image.data),
				},
				gpu,
				solveGpu: solveGpuWanted,
				gpuFused: fusedWanted,
			};
			try {
				const r = await solveUnknownPose(req, () => {
					scene ??= computeUnknownScene(
						e.lat,
						e.lon,
						e.alt,
						loadTile,
						gpu,
						fusedFor(req),
					).then((s) => (jitter ? jittered(s, jitter[0], jitter[1]) : s));
					return scene;
				});
				res.push({
					cond,
					pose: r.pose,
					confidence: r.confidence,
					accepted: r.accepted,
					stage: r.stage,
					ms: r.ms,
					horizonOn: r.horizonOn,
					solveOn: r.solveOn,
					candidates: r.candidates.map((c) => ({
						pose: c.pose,
						confidence: c.confidence,
						accepted: c.accepted,
					})),
				});
			} catch (err) {
				res.push({ cond, error: String(err) });
			}
		}
		for (const r of res)
			rows.push({ id: e.id, unknownGpu: gpu ? "on" : "off", ...r });
		console.error(
			`${gpu ? "on" : "off"} ${e.id} [${((Date.now() - t0) / 1000).toFixed(0)} s]: ${res
				.map((r) => {
					if (r.error) return `${r.cond} ERR ${String(r.error).slice(0, 80)}`;
					const p = r.pose as Prior;
					const ms = r.ms as { horizon: number; total: number };
					return `${r.cond} ${p.yaw.toFixed(2)} ${(r.confidence as number).toFixed(2)}${r.accepted ? "A" : "r"} (${r.horizonOn}/${r.solveOn} h${ms.horizon}/${ms.total} ms)`;
				})
				.join(" | ")}`,
		);
	}
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(
		out,
		JSON.stringify(
			{
				set,
				unknownGpu: gpu ? "on" : "off",
				runner: "node-dawn",
				horizonJitter: jitter,
				rows,
			},
			null,
			1,
		),
	);
	console.error(`wrote ${out}`);
	device.destroy();
	// Dawn keeps the event loop alive
	process.exit(0);
}

await main();
