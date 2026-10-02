// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// DEM-only sensitivity of the skyline to the Mapterhorn distance bands.
// Arms per demo viewpoint: base (MAPTERHORN.levels), fine (every band one zoom
// finer, capped at z17) and Terrarium (its own levels, 256 px, eye from its own
// ground). Reports |delta elevation| of fine-base and terrarium-base. This is
// not an accuracy result: no photo or ground truth is involved.
//
//   npx tsx scripts/dem/band-sensitivity.ts
import fs from "node:fs";
import path from "node:path";
import type { DemSource, TerrainLevel } from "../../src/lib/dem/sources";
import { MAPTERHORN, TERRARIUM_AWS } from "../../src/lib/dem/sources";
import { computeHorizon } from "../../src/lib/geo/horizon";
import { loadTerrain } from "../../src/lib/geo/terrain";
import { demTileLoaderNode, ROOT } from "../lib/node-io";

const EYE_ABOVE_GROUND = 1.7;
const DEDUPE_M = 200;
const MAX_POSITIONS = 6;
const CONCURRENCY = 8;
const MAX_ZOOM = 17;

interface Position {
	label: string;
	lat: number;
	lon: number;
	ids: string[];
}

function haversineMetres(a: Position, b: Position) {
	const r = 6_371_000;
	const rad = Math.PI / 180;
	const dLat = (b.lat - a.lat) * rad;
	const dLon = (b.lon - a.lon) * rad;
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
	return 2 * r * Math.asin(Math.sqrt(h));
}

function readDemoPositions(): Position[] {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(ROOT, "public/demo/manifest.json"), "utf8"),
	) as { photos: { id: string; lat?: number; lon?: number }[] };
	const positions: Position[] = [];
	for (const p of manifest.photos) {
		if (p.lat === undefined || p.lon === undefined) continue;
		const cand: Position = { label: p.id, lat: p.lat, lon: p.lon, ids: [p.id] };
		const near = positions.find((q) => haversineMetres(q, cand) < DEDUPE_M);
		if (near) near.ids.push(p.id);
		else if (positions.length < MAX_POSITIONS) positions.push(cand);
	}
	return positions;
}

function finer(levels: TerrainLevel[]): TerrainLevel[] {
	return levels.map((l) => ({ ...l, z: Math.min(MAX_ZOOM, l.z + 1) }));
}

async function horizonFor(
	source: DemSource,
	levels: TerrainLevel[],
	pos: Position,
	eyeOverride?: number,
) {
	const terrain = await loadTerrain(
		pos.lat,
		pos.lon,
		demTileLoaderNode(source),
		levels,
		new Map(),
		CONCURRENCY,
		source.tileSize,
	);
	const ground = terrain.ground(pos.lon, pos.lat);
	const horizon = computeHorizon(
		terrain,
		pos.lat,
		pos.lon,
		eyeOverride ?? ground + EYE_ABOVE_GROUND,
	);
	return { horizon, ground };
}

function quantile(sorted: number[], q: number) {
	if (!sorted.length) return Number.NaN;
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

interface Stat {
	n: number;
	median: number;
	p95: number;
	max: number;
}

function summarize(values: number[]): Stat {
	const sorted = values.slice().sort((a, b) => a - b);
	return {
		n: sorted.length,
		median: quantile(sorted, 0.5),
		p95: quantile(sorted, 0.95),
		max: sorted.length ? sorted[sorted.length - 1] : Number.NaN,
	};
}

const BANDS = [
	{ name: "all", test: (_d: number) => true },
	{ name: "<2km", test: (d: number) => d < 2_000 },
	{ name: "2-15km", test: (d: number) => d >= 2_000 && d <= 15_000 },
	{ name: ">15km", test: (d: number) => d > 15_000 },
];

interface Samples {
	// arm -> band -> |delta| values
	[arm: string]: Record<string, number[]>;
}

function newSamples(): Samples {
	const s: Samples = {};
	for (const arm of ["fine-base", "terrarium-base", "terr-baseEye-base"])
		s[arm] = Object.fromEntries(BANDS.map((b) => [b.name, [] as number[]]));
	return s;
}

function accumulate(
	into: Samples,
	arm: string,
	other: Float32Array,
	base: Float32Array,
	baseDistance: Float32Array,
) {
	for (let i = 0; i < base.length; i++) {
		const delta = Math.abs(other[i] - base[i]);
		if (Number.isNaN(delta)) continue;
		for (const b of BANDS)
			if (b.test(baseDistance[i])) into[arm][b.name].push(delta);
	}
}

function formatTable(title: string, samples: Samples) {
	const lines = [title];
	lines.push(
		`${"arm".padEnd(20)}${"band".padEnd(8)}${"n".padStart(7)}${"median".padStart(9)}${"p95".padStart(9)}${"max".padStart(9)}   (deg)`,
	);
	for (const arm of Object.keys(samples))
		for (const b of BANDS) {
			const s = summarize(samples[arm][b.name]);
			lines.push(
				`${arm.padEnd(20)}${b.name.padEnd(8)}${String(s.n).padStart(7)}${s.median.toFixed(3).padStart(9)}${s.p95.toFixed(3).padStart(9)}${s.max.toFixed(3).padStart(9)}`,
			);
		}
	return lines.join("\n");
}

function dirSize(dir: string) {
	let total = 0;
	if (!fs.existsSync(dir)) return 0;
	for (const f of fs.readdirSync(dir, { withFileTypes: true }))
		total += f.isDirectory()
			? dirSize(path.join(dir, f.name))
			: fs.statSync(path.join(dir, f.name)).size;
	return total;
}

async function main() {
	const cacheDirs = [
		path.join(ROOT, ".cache/dem-mapterhorn"),
		path.join(ROOT, ".cache/terrarium"),
	];
	const before = cacheDirs.map(dirSize);
	const positions = readDemoPositions();
	const out: string[] = [];
	out.push("DEM band sensitivity (DEM-only; not an accuracy result)");
	out.push("command: npx tsx scripts/dem/band-sensitivity.ts");
	out.push(`date: ${new Date().toISOString().slice(0, 10)}`);
	out.push(
		`eye: ground + ${EYE_ABOVE_GROUND} m from each arm's own DEM; computeHorizon step 0.05 deg, default options`,
	);
	out.push(
		`base levels: ${MAPTERHORN.levels.map((l) => `z${l.z}<=${l.maxDistance / 1000}km`).join(" ")}`,
	);
	out.push(
		`fine levels: ${finer(MAPTERHORN.levels)
			.map((l) => `z${l.z}<=${l.maxDistance / 1000}km`)
			.join(" ")}`,
	);
	out.push(
		`terrarium levels: ${TERRARIUM_AWS.levels.map((l) => `z${l.z}<=${l.maxDistance / 1000}km`).join(" ")} (${TERRARIUM_AWS.tileSize} px)`,
	);
	out.push(
		"arms: fine = z+1 bands; terrarium = own DEM and own eye; terr-baseEye = Terrarium DEM with the Mapterhorn eye",
	);
	out.push("positions (demo manifest, deduped within 200 m):");
	for (const p of positions)
		out.push(
			`  ${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}  (${p.ids.length} photos: ${p.ids.join(",")})`,
		);

	const pooled = newSamples();
	for (const pos of positions) {
		const base = await horizonFor(MAPTERHORN, MAPTERHORN.levels, pos);
		const fine = await horizonFor(MAPTERHORN, finer(MAPTERHORN.levels), pos);
		const terr = await horizonFor(TERRARIUM_AWS, TERRARIUM_AWS.levels, pos);
		// Terrarium DEM with the Mapterhorn eye: isolates the skyline shape from the eye offset.
		const terrSameEye = await horizonFor(
			TERRARIUM_AWS,
			TERRARIUM_AWS.levels,
			pos,
			base.ground + EYE_ABOVE_GROUND,
		);
		const own = newSamples();
		for (const target of [own, pooled]) {
			accumulate(
				target,
				"fine-base",
				fine.horizon.elevation,
				base.horizon.elevation,
				base.horizon.distance,
			);
			accumulate(
				target,
				"terrarium-base",
				terr.horizon.elevation,
				base.horizon.elevation,
				base.horizon.distance,
			);
			accumulate(
				target,
				"terr-baseEye-base",
				terrSameEye.horizon.elevation,
				base.horizon.elevation,
				base.horizon.distance,
			);
		}
		out.push("");
		out.push(
			`ground at camera: mapterhorn ${base.ground.toFixed(1)} m, fine ${fine.ground.toFixed(1)} m, terrarium ${terr.ground.toFixed(1)} m (terrarium - mapterhorn ${(terr.ground - base.ground).toFixed(1)} m)`,
		);
		out.push(
			formatTable(
				`viewpoint ${pos.lat.toFixed(5)}, ${pos.lon.toFixed(5)}: |delta elevation| over ${base.horizon.elevation.length} azimuths`,
				own,
			),
		);
	}
	out.push("");
	out.push(formatTable("POOLED over viewpoints", pooled));
	const after = cacheDirs.map(dirSize);
	const mb = (n: number) => (n / 1e6).toFixed(0);
	out.push("");
	out.push(
		`cache growth: mapterhorn +${mb(after[0] - before[0])} MB, terrarium +${mb(after[1] - before[1])} MB`,
	);
	const text = out.join("\n");
	console.log(text);
	const dir = path.join(ROOT, "tools/research/dem-bands");
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "RESULT.txt"), `${text}\n`);
}

main();
