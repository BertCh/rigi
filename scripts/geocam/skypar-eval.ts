// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Skyline-parallax evaluation (tools/research/geo/skypar/PROTOCOL.txt, frozen before any score).
 *
 *   npx tsx scripts/geocam/skypar-eval.ts [wc_0002 ...]
 *
 * Reads the main tree's out/geocam/decoys/*.json and out/geocam/ga5/hyps.json (read-only, MAIN_TREE env),
 * photos from tools/bench/data/photos, runs the app's sky model in node for the photo skyline, the DEM horizon
 * at each hypothesis eye (Mapterhorn), and scripts nothing else. Writes tools/research/geo/skypar/results.json.
 */
import fs from "node:fs";
import path from "node:path";
import { MAPTERHORN, type TerrainLevel } from "../../src/lib/dem";
import { loadTerrain } from "../../src/lib/geo/terrain";
import {
	predictSkylineColumns,
	SKYPAR,
	skylineParallax,
} from "../../src/lib/geocam/integrity/skyline-parallax";
import {
	computeHorizonFast,
	mosaicsFromSampler,
} from "../../src/lib/horizon-fast/march";
import { demTileLoaderNode, loadRGBA, ROOT } from "../lib/node-io";
import { assertWildDev } from "./lib";

const MAIN_TREE =
	process.env.MAIN_TREE ?? "/Users/robertchristie/Documents/GitHub/mt-image";
const DECOYS = path.join(MAIN_TREE, "out", "geocam", "decoys");
const HYPS = path.join(MAIN_TREE, "out", "geocam", "ga5", "hyps.json");
const PHOTOS = path.join(MAIN_TREE, "tools", "bench", "data", "photos");
const OUT = path.join(ROOT, "tools", "research", "geo", "skypar");
const DROP = new Set(["UNL", "AMB"]);

type Pose = { yaw: number; pitch: number; roll: number; vfov: number };
type Hyp = {
	id: string;
	label: string;
	secondary: boolean;
	eye: { lat: number; lon: number; h: number };
	dispDistM: number | null;
	pose: Pose;
};
type DecoyFile = {
	pid: string;
	stated: { lat: number; lon: number; h: number };
	W: number;
	H: number;
	hyps: Hyp[];
};

const only = process.argv.slice(2).filter((a) => a.startsWith("wc_"));
const flags = new Map<string, { e1CUR: boolean; e1AC1: boolean }>();
for (const h of JSON.parse(fs.readFileSync(HYPS, "utf8")))
	flags.set(h.id, { e1CUR: !!h.e1CUR, e1AC1: !!h.e1AC1 });

const tiles = new Map<string, Float32Array>();
const loadMH = demTileLoaderNode(MAPTERHORN);

async function loadSkyline(pid: string, W: number, H: number) {
	const core = await import("../../src/lib/sky/core");
	const model = await import("../../src/lib/sky/model");
	const { skylineFromSky } = await import("../../src/lib/sky/skyline");
	const file = path.join(ROOT, "public", model.MODEL_FILE);
	skyModel ??= await model.createSkyModel(
		new Uint8Array(fs.readFileSync(file)),
		["wasm"],
	);
	const loaded = await loadRGBA(path.join(PHOTOS, `${pid}.jpg`), W);
	// the decoy grid is W x H; a 1-px rounding difference in the decoded height is cropped / edge-padded
	if (Math.abs(loaded.height - H) > 2)
		throw new Error(`${pid}: ${loaded.height} rows, expected ${H}`);
	const img = {
		width: W,
		height: H,
		data: new Uint8ClampedArray(W * H * 4),
	};
	for (let y = 0; y < H; y++) {
		const sy = Math.min(loaded.height - 1, y);
		img.data.set(loaded.data.subarray(sy * W * 4, (sy + 1) * W * 4), y * W * 4);
	}
	const rgb = core.rgbPlanes(img);
	const ls = model.MODEL_LONG_SIDE as unknown as { wasm: number };
	const low = await model.runSkyModel(skyModel, rgb, W, H, ls.wasm);
	const mask = core.toBytes(core.refineToWorking(rgb, W, H, low, true));
	return skylineFromSky({ width: W, height: H, data: mask }).rows;
}
// biome-ignore lint/suspicious/noExplicitAny: lazily created ONNX session
let skyModel: any;

const results: Record<string, unknown>[] = [];
const files = fs
	.readdirSync(DECOYS)
	.filter((f) => f.endsWith(".json"))
	.filter((f) => only.length === 0 || only.includes(f.replace(".json", "")))
	.sort();
const t0 = Date.now();
for (const file of files) {
	const doc: DecoyFile = JSON.parse(
		fs.readFileSync(path.join(DECOYS, file), "utf8"),
	);
	assertWildDev(doc.pid);
	const hyps = doc.hyps.filter((h) => !h.secondary && !DROP.has(h.label));
	if (hyps.length === 0) continue;
	const levels: TerrainLevel[] = [
		{ z: 17, maxDistance: 300 },
		...MAPTERHORN.levels,
	];
	const terrain = await loadTerrain(
		doc.stated.lat,
		doc.stated.lon,
		loadMH,
		levels,
		tiles,
		8,
		MAPTERHORN.tileSize,
	);
	const photoRows = await loadSkyline(doc.pid, doc.W, doc.H);
	const horizons = new Map<string, ReturnType<typeof computeHorizonFast>>();
	for (const h of hyps) {
		const key = `${h.eye.lat.toFixed(7)}_${h.eye.lon.toFixed(7)}_${h.eye.h.toFixed(2)}`;
		let hz = horizons.get(key);
		if (!hz) {
			const mosaics = mosaicsFromSampler(
				terrain,
				h.eye.lat,
				h.eye.lon,
				150_000,
			);
			hz = computeHorizonFast(mosaics, h.eye, {
				step: 0.05,
				maxDistance: 150_000,
				noRidges: true,
			});
			horizons.set(key, hz);
		}
		const pred = predictSkylineColumns(hz, h.pose, doc.W, doc.H);
		const r = skylineParallax(photoRows, pred, h.pose);
		const f = flags.get(h.id) ?? { e1CUR: false, e1AC1: false };
		results.push({
			pid: doc.pid,
			id: h.id,
			label: h.label,
			dispDistM: h.dispDistM,
			e1CUR: f.e1CUR,
			e1AC1: f.e1AC1,
			...r,
		});
	}
	console.log(
		`${doc.pid}: ${hyps.length} hyps, ${horizons.size} horizons, ${((Date.now() - t0) / 1000).toFixed(0)} s`,
	);
}
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(
	path.join(OUT, only.length ? "results.partial.json" : "results.json"),
	JSON.stringify(
		{ protocol: "PROTOCOL.txt", constants: SKYPAR, results },
		null,
		1,
	),
);
console.log(`wrote ${results.length} hypotheses`);
