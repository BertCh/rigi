// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * T6 blinded verification pack (DEV ids only): candidate poses from tools/matcher/stage1 that fall outside
 * every existing dev cluster (0.5° yaw/pitch + eye within 2 m) are drawn with tools/bench/harness/overlay.ts
 * (Mapterhorn DEM skyline + occlusion-tested OSM peak labels) at the eye the method used, and labelled
 * A/B/C… in a seeded random order. No method, source or confidence appears on the image or in index.json.
 *
 *   npx tsx tools/bench/t6/verify_pack.ts <pending.json> [--out tools/bench/t6/verify]
 *   pending.json: [{id, pose:{yaw,pitch,roll,vfov}, eye:{lat,lon,h}, meta:{…scoring-only…}}]
 *   → <out>/<id>_<L>.jpg, index.json (verifiers), key.json (scoring only: label → pose, eye, meta)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Pose } from "../../../src/lib/camera";
import { prefetchPeaksBBox, ROOT } from "../harness/lib/geo";
import { renderOverlay } from "../harness/overlay";

const BENCH = path.join(ROOT, "tools", "bench");
const argv = process.argv.slice(2);
const arg = (k: string, d: string) =>
	argv.includes(k) ? argv[argv.indexOf(k) + 1] : d;
const out = path.resolve(arg("--out", path.join(BENCH, "t6", "verify")));

function rng(seed: string) {
	let h = crypto.createHash("sha256").update(seed).digest().readUInt32LE(0);
	return () => {
		h = (h + 0x6d2b79f5) >>> 0;
		let t = h;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

type Cand = {
	id: string;
	pose: Pose;
	eye: { lat: number; lon: number; h: number };
	meta?: Record<string, unknown>;
};

async function main() {
	const pendingFile = argv.find(
		(a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1] !== "--out",
	);
	if (!pendingFile)
		throw new Error("usage: verify_pack.ts <pending.json> [--out DIR]");
	const split = JSON.parse(
		fs.readFileSync(path.join(BENCH, "split.json"), "utf8"),
	) as { dev: string[]; test: string[] };
	const dev = new Set(split.dev);
	const test = new Set(split.test);
	const cands = JSON.parse(fs.readFileSync(pendingFile, "utf8")) as Cand[];
	for (const c of cands)
		if (test.has(c.id) || !dev.has(c.id))
			throw new Error(`refusing non-dev id ${c.id}`);
	const manifest = JSON.parse(
		fs.readFileSync(path.join(BENCH, "data", "manifest.json"), "utf8"),
	) as {
		id: string;
		file: string;
		lat: number;
		lon: number;
		altitudeM?: number | null;
	}[];
	const byId = new Map(manifest.map((e) => [e.id, e]));
	const devEntries = manifest.filter((e) => dev.has(e.id));
	const lats = devEntries.map((e) => e.lat);
	const lons = devEntries.map((e) => e.lon);
	const mLon =
		0.8 / Math.cos((Math.max(...lats.map(Math.abs)) * Math.PI) / 180);
	await prefetchPeaksBBox(
		+(Math.min(...lats) - 0.8).toFixed(2),
		+(Math.min(...lons) - mLon).toFixed(2),
		+(Math.max(...lats) + 0.8).toFixed(2),
		+(Math.max(...lons) + mLon).toFixed(2),
	);
	fs.mkdirSync(out, { recursive: true });
	const byPhoto = new Map<string, Cand[]>();
	for (const c of cands) byPhoto.set(c.id, [...(byPhoto.get(c.id) ?? []), c]);
	const key: Record<string, unknown> = {};
	const index: Record<string, unknown> = {};
	for (const [id, list] of [...byPhoto.entries()].sort()) {
		const e = byId.get(id);
		if (!e) throw new Error(`${id} not in manifest`);
		const photoFile = path.resolve(BENCH, "data", e.file);
		const rand = rng(`summit-lens-t6-verify:${id}`);
		const order = list.map((c) => ({ c, r: rand() })).sort((a, b) => a.r - b.r);
		const files: Record<string, string> = {};
		const kc: Record<string, unknown> = {};
		for (let i = 0; i < order.length; i++) {
			const L = "ABCDEFGHIJ"[i];
			const c = order[i].c;
			const file = `${id}_${L}.jpg`;
			const ov = await renderOverlay({
				photoFile,
				lat: e.lat,
				lon: e.lon,
				alt: e.altitudeM ?? null,
				eyeLat: c.eye.lat,
				eyeLon: c.eye.lon,
				eyeH: c.eye.h,
				pose: c.pose,
				title: id,
				method: `candidate ${L}`,
				width: 1400,
				out: path.join(out, file),
			});
			files[L] = file;
			kc[L] = {
				pose: c.pose,
				eye: { ...c.eye, dem: ov.dem, ground: ov.ground },
				...(c.meta ?? {}),
			};
		}
		key[id] = { candidates: kc };
		index[id] = { photo: path.relative(out, photoFile), candidates: files };
		console.error(`[t6-verify] ${id}: ${list.length} candidate(s)`);
	}
	fs.writeFileSync(path.join(out, "key.json"), JSON.stringify(key, null, 1));
	fs.writeFileSync(
		path.join(out, "index.json"),
		JSON.stringify(
			{
				about:
					"Blinded candidates (T6, dev photos only). Each overlay draws the Mapterhorn DEM skyline (yellow) and occlusion-tested OSM peak labels for one candidate camera (pose + eye). Judge each candidate on its own: does its line lie on the photo's real skyline (checklist C1 coverage ≥ 70 %, C2 vertical fit within 1.5 % of height, C3 feature alignment, C4 tilt)? Verdict correct / wrong / unsure, near-miss tag allowed.",
				photos: index,
			},
			null,
			1,
		),
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
