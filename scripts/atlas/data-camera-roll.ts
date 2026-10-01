// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Real roll numbers for the atlas page /atlas/camera-roll, from the bundled Niederhorn demo roll.
 *   npx tsx scripts/atlas/data-camera-roll.ts
 * Writes public/demo/atlas/camera-roll/roll.json: clusterPhotos (15 km), viewpoint grouping (250 m, first match wins,
 * same rule as src/lib/roll/roll.ts groupViewpoints), local-metre positions, and for each photo the compass bias
 * a leave-one-out viewpointBias (src/lib/roll/align/viewpoint.ts) would give from the other solved photos.
 */
import fs from "node:fs";
import { distanceM } from "../../src/lib/geodesy";
import { angDiff, viewpointBias } from "../../src/lib/roll/align/viewpoint";

type M = {
	id: string;
	takenAt: string;
	lat: number;
	lon: number;
	alt: number;
	hAccuracy: number;
	heading: number;
};
const man = JSON.parse(fs.readFileSync("public/demo/manifest.json", "utf8"));
const photos: M[] = [...man.photos].sort((a: M, b: M) =>
	a.takenAt.localeCompare(b.takenAt),
);
// roll.ts pulls in vite virtual modules, so its two constants and clusterPhotos' single-linkage are mirrored here
const VIEWPOINT_RADIUS_M = 250;
const ROLL_LINK_M = 15_000;
const parent = photos.map((_, i) => i);
const find = (i: number): number => (parent[i] === i ? i : find(parent[i]));
for (let i = 0; i < photos.length; i++)
	for (let j = i + 1; j < photos.length; j++)
		if (distanceM(photos[i], photos[j]) < ROLL_LINK_M)
			parent[find(i)] = find(j);
const cl = new Map<number, number>();
for (let i = 0; i < photos.length; i++)
	cl.set(find(i), (cl.get(find(i)) ?? 0) + 1);
const clusters = [...cl.values()].map((n) => ({ length: n }));
const vps: { lat: number; lon: number; ids: string[] }[] = [];
const vpOf = new Map<string, number>();
for (const m of photos) {
	let vi = vps.findIndex((v) => distanceM(v, m) < VIEWPOINT_RADIUS_M);
	if (vi < 0) {
		vi = vps.length;
		vps.push({ lat: m.lat, lon: m.lon, ids: [] });
	}
	vps[vi].ids.push(m.id);
	vpOf.set(m.id, vi);
}
for (const v of vps) {
	const mem = photos.filter((m) => v.ids.includes(m.id));
	v.lat = mem.reduce((s, m) => s + m.lat, 0) / mem.length;
	v.lon = mem.reduce((s, m) => s + m.lon, 0) / mem.length;
}
const c = {
	lat: photos.reduce((s, m) => s + m.lat, 0) / photos.length,
	lon: photos.reduce((s, m) => s + m.lon, 0) / photos.length,
};
const t0 = Date.parse(photos[0].takenAt);
const solved = new Map(
	photos.map((m) => [
		m.id,
		JSON.parse(fs.readFileSync(`public/demo/atlas/${m.id}.json`, "utf8")),
	]),
);
const tOf = (m: M) => (Date.parse(m.takenAt) - t0) / 1000;
// alignRoll walks the roll in capture order and only the cascade-accepted poses become anchors, so the bias a photo
// sees comes from the accepted photos before it (seq); loo uses every other accepted photo (an upper bound).
const anchorsOf = (ms: M[]) =>
	ms
		.filter((m) => solved.get(m.id).solved.accepted)
		.map((m) => ({
			id: m.id,
			viewpoint: vpOf.get(m.id) as number,
			t: tOf(m),
			yawOffset: angDiff(solved.get(m.id).solved.yaw, m.heading),
		}));
const rows = photos.map((m, i) => {
	const t = tOf(m);
	const a = solved.get(m.id);
	const loo = viewpointBias(
		anchorsOf(photos),
		vpOf.get(m.id) as number,
		t,
		m.id,
	);
	const seq = viewpointBias(
		anchorsOf(photos.slice(0, i)),
		vpOf.get(m.id) as number,
		t,
		m.id,
	);
	return {
		id: m.id,
		t,
		viewpoint: vpOf.get(m.id),
		east:
			(m.lon - c.lon) *
			(Math.PI / 180) *
			6371000 *
			Math.cos((c.lat * Math.PI) / 180),
		north: (m.lat - c.lat) * (Math.PI / 180) * 6371000,
		hAccuracy: m.hAccuracy,
		heading: m.heading,
		yawOffset: angDiff(a.solved.yaw, m.heading),
		looBias: loo?.biasDeg ?? null,
		seqBias: seq?.biasDeg ?? null,
		seqN: seq?.n ?? 0,
		accepted: a.solved.accepted,
		solvedYaw: a.solved.yaw,
		solvedHfov: a.solved.hfov,
	};
});
const out = {
	generated: "2026-10-01",
	script: "scripts/atlas/data-camera-roll.ts",
	clusters: clusters.map((g) => g.length),
	viewpointRadiusM: VIEWPOINT_RADIUS_M,
	viewpoints: vps.map((v) => ({ n: v.ids.length, ids: v.ids })),
	spanS: (Date.parse(photos[photos.length - 1].takenAt) - t0) / 1000,
	rows,
};
fs.mkdirSync("public/demo/atlas/camera-roll", { recursive: true });
fs.writeFileSync(
	"public/demo/atlas/camera-roll/roll.json",
	JSON.stringify(out),
);
console.log(
	JSON.stringify(out.clusters),
	out.viewpoints.map((v) => v.ids.join(",")),
);
for (const r of rows)
	console.log(
		r.id,
		r.t,
		r.viewpoint,
		r.east.toFixed(0),
		r.north.toFixed(0),
		r.hAccuracy.toFixed(0),
		"off",
		r.yawOffset.toFixed(1),
		"loo",
		r.looBias?.toFixed(1),
		"seq",
		r.seqBias?.toFixed(1),
		r.seqN,
		r.accepted,
	);
