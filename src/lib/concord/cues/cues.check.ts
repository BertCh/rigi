// Synthetic checks for WP-C cue extraction.
//   npx tsx src/lib/concord/cues/cues.check.ts
import { type CameraX, IDENTITY_INTRINSICS, projectX } from "../core";
import {
	buildGeomBuffer,
	chamferAt,
	extractCues,
	lakesFromOverpass,
	maskEdges,
	matchEdgeCues,
	mirrorAxis,
	occludingContourCues,
	orientedDT,
	photoEdgesFromRGBA,
	shoreDistance,
	stitchRings,
	thinEdges,
	waterCuesX,
} from "./index";

let fails = 0;
const check = (name: string, ok: boolean, info: string) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${info}`);
	if (!ok) fails++;
};
const DEG = Math.PI / 180;

const W = 800;
const H = 600;
const cam: CameraX = {
	pose: { yaw: 0, pitch: 0, roll: 0, vfov: 45 },
	eye: [0, 0, 0],
	aspect: W / H,
	intr: { ...IDENTITY_INTRINSICS },
};
const f1600 = 1200 / 2 / Math.tan(22.5 * DEG);
const vOfTan = (t: number) => 0.5 - t / Math.tan(22.5 * DEG) / 2;

// ---- 1. ray cast: plane 10 m below, a 60 m block at n ∈ [1000, 1050], plateau 400 m beyond 3 km
const height = (_e: number, n: number) =>
	n >= 1000 && n <= 1050 ? 60 : n > 3000 ? 400 : -10;
const g = buildGeomBuffer(cam, W, H, height, {
	frame: { alt0: 0, rEff: Infinity },
});
{
	let maxRel = 0;
	let maxPx = 0;
	for (let y = 400; y < H; y += 7)
		for (let x = 3; x < W; x += 11) {
			const k = y * W + x;
			const pz = g.xyz[3 * k + 2];
			if (Math.abs(pz + 10) > 1e-3) continue; // plane hits only
			const u = (x + 0.5) / W;
			const v = (y + 0.5) / H;
			const t = (0.5 - v) * 2 * Math.tan(22.5 * DEG);
			const dTrue = 10 / -t; // along the forward axis
			maxRel = Math.max(maxRel, Math.abs(g.xyz[3 * k + 1] - dTrue) / dTrue);
			const p = projectX(cam, [g.xyz[3 * k], g.xyz[3 * k + 1], pz]);
			if (p)
				maxPx = Math.max(maxPx, Math.hypot((p.u - u) * 1600, (p.v - v) * 1200));
		}
	check(
		"raycast plane distance",
		maxRel < 2e-3 && maxPx < 0.05,
		`max rel err ${maxRel.toExponential(2)}, reprojection ${maxPx.toFixed(4)} px @1600 (${g.stats.bins} bins, ${g.stats.ms} ms)`,
	);
}

// ---- 2. occluding contour of the block against the plateau
const cues = occludingContourCues(g, cam, { stepPx: 16 });
{
	const vTrue = vOfTan(60 / 1000);
	const errs = cues.map((c) => Math.abs(c.v - vTrue) * 1200);
	const nOk = cues.every((c) => c.kind === "edge" && c.nv < -0.95);
	const med = errs.sort((a, b) => a - b)[errs.length >> 1] ?? Number.NaN;
	check(
		"contour position + normal",
		cues.length > 50 && med < 0.5 && nOk,
		`${cues.length} cues, median |Δv| ${med.toFixed(3)} px @1600 (DEM step sampling ≤ 3.5 m), normals up: ${nOk}`,
	);
}

// ---- 3. edge matching: synthetic photo with the contour 3 px lower than predicted
const synth = (
	rowOf: (x: number) => number,
	Wp: number,
	Hp: number,
	top: number,
	bottom: number,
) => {
	const d = new Uint8ClampedArray(Wp * Hp * 4);
	for (let y = 0; y < Hp; y++)
		for (let x = 0; x < Wp; x++) {
			const r = rowOf(x);
			const a = Math.max(0, Math.min(1, y + 0.5 - r + 0.5)); // box-filtered step
			const val = top * (1 - a) + bottom * a;
			const i = (y * Wp + x) * 4;
			d[i] = d[i + 1] = d[i + 2] = val;
			d[i + 3] = 255;
		}
	return d;
};
{
	const Wp = 1600;
	const Hp = 1200;
	const rowTrue = vOfTan(60 / 1000) * Hp + 3;
	const img = synth(() => rowTrue, Wp, Hp, 200, 90);
	const edges = photoEdgesFromRGBA(img, Wp, Hp);
	const m = matchEdgeCues(cues, edges, { searchPx: 12 });
	const res = m.map((c) => c.residualPx).sort((a, b) => a - b);
	const med = res[res.length >> 1];
	check(
		"edge match residual (+3 px expected)",
		m.length > 0.8 * cues.length && Math.abs(med - 3) < 0.3,
		`${m.length}/${cues.length} matched, median residual ${med?.toFixed(3)} px, conf≈${m[0]?.conf.toFixed(2)}`,
	);
	const r = extractCues({ geom: g, cam, edges }, { contour: { stepPx: 16 } });
	check(
		"extractCues end-to-end",
		r.stats.kept > 0.8 * r.stats.predicted,
		JSON.stringify(r.stats),
	);
}

// ---- 4. EDT exactness vs brute force + chamfer orientation gating
{
	const Wp = 120;
	const Hp = 90;
	const mag = new Float32Array(Wp * Hp);
	const ori = new Float32Array(Wp * Hp);
	const pts: [number, number, number][] = [];
	let s = 7;
	const rnd = () => {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
	for (let i = 0; i < 40; i++) {
		const x = 3 + Math.floor(rnd() * (Wp - 6));
		const y = 3 + Math.floor(rnd() * (Hp - 6));
		const o = rnd() < 0.5 ? 0 : Math.PI / 2;
		pts.push([x, y, o]);
		mag[y * Wp + x] = 1;
		ori[y * Wp + x] = o;
	}
	const te = thinEdges({ w: Wp, h: Hp, mag, ori }, { thresh: 0.5 });
	const dt = orientedDT(te, { bins: 12, truncPx: 40 });
	let maxErr = 0;
	for (let y = 0; y < Hp; y += 3)
		for (let x = 0; x < Wp; x += 3)
			for (const o of [0, Math.PI / 2]) {
				let best = Infinity;
				for (let i = 0; i < te.x.length; i++) {
					let d = Math.abs(((te.ori[i] - o) % Math.PI) + 0);
					if (d > Math.PI / 2) d = Math.PI - d;
					if (d > 0.1) continue;
					best = Math.min(
						best,
						Math.hypot(Math.floor(te.x[i]) - x, Math.floor(te.y[i]) - y),
					);
				}
				const c = chamferAt(dt, x, y, o, 5);
				maxErr = Math.max(maxErr, Math.abs(Math.min(best, 40) - c));
			}
	check(
		"oriented EDT exact (quantised 254/40 per px)",
		maxErr <= 0.1,
		`max |Δ| ${maxErr.toFixed(3)} px over ${te.x.length} edge pts`,
	);
}

// ---- 5. water: lake plane 10 m below the eye up to n = 2000, shore rising beyond
{
	const hW = (_e: number, n: number) =>
		n <= 2000 ? -10 : -10 + (n - 2000) * 0.2;
	const gW = buildGeomBuffer(cam, W, H, hW, {
		frame: { alt0: 0, rEff: Infinity },
	});
	const lake = {
		polygon: [
			[-5000, -100],
			[5000, -100],
			[5000, 2000],
			[-5000, 2000],
		] as [number, number][],
		levelM: -10,
	};
	const vTrue = vOfTan(-10 / 2000);
	const Wp = 1600;
	const Hp = 1200;
	const img = synth(() => vTrue * Hp + 2, Wp, Hp, 80, 190); // darker land above, brighter water below
	const edges = photoEdgesFromRGBA(img, Wp, Hp);
	const r = waterCuesX(gW, cam, [lake], null, { edges });
	const lv = r.cues.filter((c) => c.kind === "level");
	const sh = r.cues.filter((c) => c.kind === "shore");
	const predErr = Math.max(
		...r.predicted.map((p) => Math.abs(p.v - vTrue) * 1200),
	);
	const res = lv.map((c) => c.residualPx).sort((a, b) => a - b);
	const elErr = Math.max(
		...lv.map((c) =>
			c.kind === "level"
				? Math.abs(c.el - Math.atan2(-10, Math.hypot(c.world[0], 2000)) / DEG)
				: 0,
		),
	);
	const sd = sh.map((c) =>
		c.kind === "shore" ? Math.abs(c.shoreDist(c.world[0], c.world[1])) : 0,
	);
	check(
		"waterline predicted + level residual (−2 px expected)",
		predErr < 0.3 &&
			Math.abs(res[res.length >> 1] + 2) < 0.3 &&
			elErr < 0.005 &&
			r.polarity === 1,
		`pred max |Δv| ${predErr.toFixed(3)} px; ${lv.length} level cues, median residual ${res[res.length >> 1]?.toFixed(3)} px; el err ${elErr.toFixed(4)}°; polarity ${r.polarity}`,
	);
	check(
		"shore cues + shoreDist",
		sh.length > 0 && Math.max(...sd) < 3,
		`${sh.length} shore cues, max |shoreDist| at predicted shore ${Math.max(...sd).toFixed(2)} m`,
	);
	const sdf = shoreDistance(lake);
	check(
		"shoreDistance sign",
		sdf(0, 1000) < -900 && sdf(0, 2100) > 99,
		`inside ${sdf(0, 1000).toFixed(1)}, outside ${sdf(0, 2100).toFixed(1)}`,
	);
	void f1600;
}

// ---- 6. ring stitching from split OSM ways
{
	const a = { lat: 0, lon: 0 };
	const b = { lat: 0, lon: 0.01 };
	const c = { lat: 0.01, lon: 0.01 };
	const d = { lat: 0.01, lon: 0 };
	const rings = stitchRings([
		[a, b],
		[c, b],
		[c, d, a],
	]);
	const lakes = lakesFromOverpass(
		[
			{
				type: "relation",
				id: 1,
				tags: { natural: "water", name: "X" },
				members: [
					{ role: "outer", geometry: [a, b] },
					{ role: "outer", geometry: [c, b] },
					{ role: "outer", geometry: [c, d, a] },
				],
			},
		],
		(lat, lon) => [lon * 111000, lat * 111000],
	);
	check(
		"stitchRings",
		rings.length === 1 && rings[0].length === 5 && lakes.length === 1,
		`${rings.length} ring(s), ${rings[0]?.length} pts, lakes ${lakes.length}`,
	);
}

// ---- 7. mirror axis of a reflected column profile; foreground mask removes matches
{
	const Wp = 20;
	const Hp = 120;
	const lum = new Float32Array(Wp * Hp);
	const axis = 60.25;
	for (let y = 0; y < Hp; y++)
		for (let x = 0; x < Wp; x++) {
			const d = Math.abs(y + 0.5 - axis); // symmetric texture about the axis
			lum[y * Wp + x] = 0.5 + 0.3 * Math.sin(d * 0.9) * Math.exp(-d / 30);
		}
	const m = mirrorAxis(lum, Wp, Hp, 10, 50, 70, 10);
	check(
		"mirrorAxis",
		!!m && Math.abs(m.y + 0.5 - axis) <= 0.5 && m.ncc > 0.85,
		`axis ${m ? (m.y + 0.5).toFixed(2) : "none"} (true ${axis}), ncc ${m?.ncc.toFixed(3)}`,
	);
	const Wq = 1600;
	const Hq = 1200;
	const rowTrue = vOfTan(60 / 1000) * Hq + 3;
	const img = synth(() => rowTrue, Wq, Hq, 200, 90);
	const edges = maskEdges(
		photoEdgesFromRGBA(img, Wq, Hq),
		{ width: 2, height: 1, data: [255, 0] },
		255,
	);
	const mm = matchEdgeCues(cues, edges);
	check(
		"maskEdges",
		mm.every((c) => c.u > 0.5) && mm.length > 0,
		`${mm.length} matches, all in the unmasked half: ${mm.every((c) => c.u > 0.5)}`,
	);
}

console.log(fails ? `${fails} FAILED` : "all PASS");
process.exit(fails ? 1 : 0);
