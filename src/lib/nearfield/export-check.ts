// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Checks for the georeferenced splat export (src/lib/export/splat.ts).
// Run: npx tsx src/lib/nearfield/export-check.ts   (exits 1 on any failure)
// Asserts: no `generated` splat ever reaches a .ply / .splat-v1 export; the .ply round-trips through
// decodeGaussianPly (positions, scales, rotations, colours, opacity); the header carries the origin,
// frame, EPSG:4979, pose, anchor, model, licence and provenance counts; SHARP → research-only.
import {
	buildSplatExport,
	encodeGaussianPly,
	engineNearFieldScene,
	exportableCloud,
	splatLicence,
} from "../export/splat";
import {
	decodeGaussianPly,
	decodeSplatV1,
	readSplatV1Origin,
} from "./splat-io";
import {
	type GaussianCloud,
	type NearFieldScene,
	PROVENANCE_CODE,
} from "./types";

let failed = 0;
function ok(cond: boolean, msg: string) {
	console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
	if (!cond) failed++;
}

let seed = 777;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};

function makeCloud(n: number): GaussianCloud {
	const codes = [
		PROVENANCE_CODE.observed,
		PROVENANCE_CODE.reconstructed,
		PROVENANCE_CODE.dem,
		PROVENANCE_CODE.generated,
		9, // unknown code: must also be dropped
	];
	const c: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: new Float32Array(3 * n),
		scales: new Float32Array(3 * n),
		rotations: new Float32Array(4 * n),
		colors: new Uint8Array(4 * n),
		provenance: new Uint8Array(n),
	};
	for (let i = 0; i < n; i++) {
		for (let k = 0; k < 3; k++) {
			c.positions[3 * i + k] = (rnd() - 0.5) * 400;
			c.scales[3 * i + k] = 0.01 + rnd() * 2;
		}
		const q = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
		const L = Math.hypot(...q);
		for (let k = 0; k < 4; k++) c.rotations[4 * i + k] = q[k] / L;
		for (let k = 0; k < 4; k++) c.colors[4 * i + k] = Math.floor(rnd() * 256);
		c.provenance[i] = codes[i % codes.length];
	}
	c.colors[3] = 0; // alpha extremes
	c.colors[7] = 255;
	return c;
}

const scene = (splats: GaussianCloud, quality = 0.8): NearFieldScene => ({
	photoId: "wc_test",
	anchor: {
		scale: 1.7,
		shift: 0,
		residualLog: 0.12,
		inlierFrac: 0.8,
		n: 5000,
		quality,
		maxRange: 1500,
	},
	split: {
		width: 1,
		height: 1,
		cls: new Uint8Array(1),
		counts: [0, 0, 0, 0, 0],
	},
	splats,
	confidenceRadius: 35,
});

const N = 1000;
const cloud = makeCloud(N);
const sc = scene(cloud);
const origin = { lat: 46.5577, lon: 7.9807, h: 2970.4 };
const meta = {
	origin,
	pose: { yaw: 123.4, pitch: -3.2, roll: 0.4, vfov: 42 },
	eye: [0, 0, 1.6] as const,
	model: "lift/moge-2-vitl-normal",
	createdAt: "2026-09-28T00:00:00Z",
};

// ---- filtering ----
{
	const { cloud: kept, stats } = exportableCloud(sc);
	ok(stats.total === N, "stats.total");
	ok(
		stats.droppedGenerated === N / 5 && stats.droppedUnknown === N / 5,
		`dropped generated ${stats.droppedGenerated}, unknown ${stats.droppedUnknown}`,
	);
	ok(
		kept.count === (3 * N) / 5 &&
			stats.counts.generated === 0 &&
			stats.counts.observed === N / 5,
		"kept = observed + reconstructed + dem",
	);
	ok(sc.splats.count === N, "source scene not mutated");
}

// ---- .ply ----
{
	const r = buildSplatExport(sc, "splat-ply", meta);
	const text = new TextDecoder("latin1").decode(
		new Uint8Array(r.bytes, 0, 8192),
	);
	const head = text.slice(0, text.indexOf("end_header"));
	for (const want of [
		"comment origin_crs EPSG:4979",
		"comment origin_lat 46.557700000",
		"comment origin_lon 7.980700000",
		"comment origin_h_msl 2970.400",
		"comment frame ENU",
		"comment pose_deg yaw 123.4000",
		"comment anchor_quality 0.800 (ok)",
		"comment model lift/moge-2-vitl-normal",
		"comment licence MoGe-2",
		"comment provenance_counts observed 200 reconstructed 200 dem 200 generated 0",
		"comment provenance_dropped generated 200 unknown 200",
		"comment lv95 not provided",
		"element vertex 600",
	])
		ok(head.includes(want), `ply header has "${want}"`);
	ok(
		Array.from(head).every((ch) => {
			const c = ch.charCodeAt(0);
			return c === 10 || (c >= 32 && c < 127);
		}),
		"ply header is ASCII",
	);

	const d = decodeGaussianPly(r.bytes, { frame: "enu" });
	const { cloud: kept } = exportableCloud(sc);
	ok(d.count === kept.count, "ply round trip count");
	let ep = 0;
	let es = 0;
	let er = 0;
	let ec = 0;
	for (let i = 0; i < d.count; i++) {
		for (let k = 0; k < 3; k++) {
			ep = Math.max(
				ep,
				Math.abs(d.positions[3 * i + k] - kept.positions[3 * i + k]),
			);
			es = Math.max(
				es,
				Math.abs(d.scales[3 * i + k] / kept.scales[3 * i + k] - 1),
			);
		}
		// q and -q are the same rotation
		let dot = 0;
		for (let k = 0; k < 4; k++)
			dot += d.rotations[4 * i + k] * kept.rotations[4 * i + k];
		er = Math.max(er, 1 - Math.abs(dot));
		for (let k = 0; k < 4; k++)
			ec = Math.max(ec, Math.abs(d.colors[4 * i + k] - kept.colors[4 * i + k]));
	}
	ok(ep === 0, `positions exact (max err ${ep})`);
	ok(es < 1e-5, `scales (max rel err ${es.toExponential(2)})`);
	ok(er < 1e-6, `rotations (max 1-|dot| ${er.toExponential(2)})`);
	ok(ec === 0, `colours + opacity exact incl. alpha 0/255 (max err ${ec})`);

	// the provenance property survives (read it back by hand)
	const bytes = new Uint8Array(r.bytes);
	const body = text.indexOf("end_header\n") + "end_header\n".length;
	const stride = 17 * 4 + 1;
	let provOk = true;
	for (let i = 0; i < d.count; i++)
		if (bytes[body + i * stride + 68] !== kept.provenance[i]) provOk = false;
	ok(
		provOk && body + d.count * stride === bytes.length,
		"provenance column + size",
	);
	const codes = new Set<number>();
	for (let i = 0; i < d.count; i++) codes.add(bytes[body + i * stride + 68]);
	ok(!codes.has(PROVENANCE_CODE.generated), "no generated code in .ply");
}

// ---- .splat-v1 ----
{
	const r = buildSplatExport(sc, "splat-v1", meta);
	const d = decodeSplatV1(r.bytes);
	const o = readSplatV1Origin(r.bytes);
	ok(d.frame === "enu" && d.count === 600, ".splat-v1 frame + count");
	ok(
		!!o && o.lat === origin.lat && o.lon === origin.lon && o.h === origin.h,
		".splat-v1 origin",
	);
	ok(
		!Array.from(d.provenance).includes(PROVENANCE_CODE.generated),
		"no generated splat in .splat-v1",
	);
}

// ---- all-generated scene → empty export; camera frame refused ----
{
	const g = makeCloud(10);
	g.provenance.fill(PROVENANCE_CODE.generated);
	const r = buildSplatExport(scene(g), "splat-ply", meta);
	ok(
		decodeGaussianPly(r.bytes).count === 0,
		"all-generated scene exports 0 splats",
	);
	const cam = { ...makeCloud(5), frame: "camera" as const };
	let threw = false;
	try {
		buildSplatExport(scene(cam), "splat-v1", meta);
	} catch {
		threw = true;
	}
	ok(threw, "camera-frame scene refused");
}

// ---- licence + anchor + LV95 hook ----
{
	ok(
		splatLicence("sharp-2572gikvuh").commercial === false,
		"SHARP research-only",
	);
	ok(
		splatLicence("lift/moge-2-vitb-normal").commercial === true,
		"MoGe-2 commercial",
	);
	ok(splatLicence("lift/da3-base").commercial === true, "DA3-Base commercial");
	ok(splatLicence("mystery").commercial === null, "unknown model unverified");
	const r = buildSplatExport(scene(makeCloud(20), 0.2), "splat-ply", {
		...meta,
		model: "sharp-2572gikvuh",
		toLv95: () => ({ E: 2600000, N: 1200000, H: 500 }),
	});
	const h = r.header.join("\n");
	ok(h.includes("RESEARCH-ONLY") && h.includes("NOT ALLOWED"), "SHARP header");
	ok(
		r.notes.some((n) => n.includes("research-only")),
		"SHARP note",
	);
	ok(h.includes("low trust (below 0.35)"), "low-trust anchor quality flagged");
	const bad = buildSplatExport(scene(makeCloud(20), 0.1), "splat-ply", meta);
	ok(
		bad.header.join("\n").includes("BELOW 0.15: placement untrusted") &&
			bad.notes.some((n) => n.includes("placement untrusted")),
		"below-gate anchor quality flagged",
	);
	ok(
		h.includes("origin_lv95_E 2600000.000") && !h.includes("lv95 not provided"),
		"LV95 hook",
	);
	const outside = buildSplatExport(sc, "splat-ply", {
		...meta,
		origin: { lat: 47.42, lon: 10.98, h: 2962 }, // Zugspitze (outside the CH box)
	});
	ok(
		!outside.header.join("\n").includes("lv95"),
		"no LV95 line outside the CH box",
	);
}

// ---- engine accessor + the bare encoder ----
{
	ok(engineNearFieldScene(null) === null, "accessor: null engine");
	ok(engineNearFieldScene({} as never) === null, "accessor: no scene");
	ok(
		engineNearFieldScene({ nearFieldScene: sc } as never) === sc,
		"accessor: property",
	);
	ok(
		engineNearFieldScene({ nearFieldScene: () => sc } as never) === sc,
		"accessor: fn",
	);
	ok(
		engineNearFieldScene({ getNearFieldScene: () => sc } as never) === sc,
		"accessor: getter",
	);
	const bare = encodeGaussianPly(makeCloud(3));
	ok(decodeGaussianPly(bare).count === 3, "bare encoder");
}

if (failed) {
	console.error(`\n${failed} check(s) failed`);
	process.exit(1);
}
console.log("\nall splat export checks passed");
