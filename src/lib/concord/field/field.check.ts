// WP-E unit checks: npx tsx src/lib/concord/field/field.check.ts
// Synthetic only (no DEM, no photos). Exits non-zero on any failure.
import {
	type CameraX,
	IDENTITY_INTRINSICS,
	invertField,
	sampleField,
} from "../core";
import {
	basisPx,
	boundPx,
	displayField,
	FIELD_DEFAULTS,
	type FieldCue,
	fitField,
	fitStats,
	focalPx,
	type GeomBuffer,
	isLowConfidence,
} from "./fit";
import { WARP_GLSL, warpAtCPU } from "./glsl";
import {
	packWarpTexture,
	photoToRenderUV,
	renderToPhotoUV,
	WarpState,
	warpFlag,
} from "./readback";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
	console.log(
		`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
	);
	if (!ok) failed++;
}

// deterministic RNG
let seed = 12345;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};

const cam: CameraX = {
	pose: { yaw: 0, pitch: 0, roll: 0, vfov: 45 },
	eye: [0, 0, 0],
	aspect: 4 / 3,
	intr: { ...IDENTITY_INTRINSICS },
};
const { W, H } = basisPx(cam.aspect);
const fPx = focalPx(cam);

/** Terrain below v = 0.3 (sky above), range falling from 20 km at the skyline to 800 m at the bottom. */
function geom(
	w = 64,
	h = 48,
	people?: (u: number, v: number) => boolean,
): GeomBuffer {
	const rangeM = new Float32Array(w * h);
	const ppl = new Uint8Array(w * h);
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			const u = (i + 0.5) / w;
			const v = (j + 0.5) / h;
			rangeM[j * w + i] = v < 0.3 ? 0 : 800 * (20000 / 800) ** ((1 - v) / 0.7);
			ppl[j * w + i] = people?.(u, v) ? 255 : 0;
		}
	return { w, h, rangeM, people: people ? ppl : undefined };
}
const rangeAt = (v: number) => 800 * (20000 / 800) ** ((1 - v) / 0.7);

// a smooth "true" residual field in px, small enough to stay inside the bounds near the camera
const truth = (u: number, v: number): [number, number] => [
	3 * Math.sin(u * 3) + 1,
	2 * Math.cos(v * 4 + u),
];
const pointCue = (
	u: number,
	v: number,
	r: [number, number],
	sigmaPx = 0.5,
): FieldCue => ({
	kind: "point",
	u,
	v,
	world: [0, 0, 0],
	depthM: rangeAt(v),
	sigmaPx,
	source: "synthetic",
	residualPx: r,
	conf: 1,
});

// ---- 1. LOW confidence refusal (the warp is never computed) ----
{
	const g = geom();
	const cues = [pointCue(0.5, 0.8, [3, 1]), pointCue(0.3, 0.9, [2, 2])];
	const before = fitStats.fits;
	const low = [
		undefined,
		null,
		{},
		{ confidence: 0.3 },
		{ accepted: false, confidence: 0.9 },
		{ level: "low" as const, confidence: 0.9 },
		{ accepted: true },
		{ confidence: Number.NaN },
	];
	const nulls = low.map((c) => displayField(c, cues, g, cam));
	check(
		"LOW / missing confidence ⇒ displayField returns null",
		nulls.every((x) => x === null),
		`${low.length} cases`,
	);
	check(
		"LOW ⇒ isLowConfidence true for every case",
		low.every((c) => isLowConfidence(c)),
	);
	const z = fitField(cues, g, cam, { confidence: { confidence: 0.2 } });
	check(
		"fitField(opts.confidence LOW) ⇒ zero field, provenance refused",
		z.maxAbsPx === 0 &&
			z.du.every((x) => x === 0) &&
			z.dv.every((x) => x === 0) &&
			z.provenance.sources[0] === "refused:low-confidence",
	);
	check(
		"LOW ⇒ the fit never ran",
		fitStats.fits === before,
		`fits ${fitStats.fits - before}`,
	);
	const ok = displayField({ accepted: true, confidence: 0.8 }, cues, g, cam);
	check(
		"accepted, confidence 0.8 ⇒ a field is fitted",
		!!ok && ok.maxAbsPx > 0 && fitStats.fits === before + 1,
	);
	check(
		"isLowConfidence: high tier / accepted 0.5 are not LOW",
		!isLowConfidence({ level: "high" }) &&
			!isLowConfidence({ accepted: true, confidence: 0.5 }),
	);
}

// ---- 2. GP recovers a smooth field from dense cues (supported terrain cells) ----
{
	const g = geom();
	const cues: FieldCue[] = [];
	for (let k = 0; k < 150; k++) {
		const u = 0.05 + 0.9 * rnd();
		const v = 0.35 + 0.6 * rnd();
		const t = truth(u, v);
		cues.push(
			pointCue(u, v, [t[0] + (rnd() - 0.5) * 0.5, t[1] + (rnd() - 0.5) * 0.5]),
		);
	}
	const f = fitField(cues, g, cam, { maxMetres: 1e9, fade: [2, 3] });
	let se = 0;
	let n = 0;
	for (let j = 0; j < f.h; j++)
		for (let i = 0; i < f.w; i++) {
			const u = (i + 0.5) / f.w;
			const v = (j + 0.5) / f.h;
			if (v < 0.4 || v > 0.9 || u < 0.1 || u > 0.9) continue;
			const [tx, ty] = truth(u, v);
			se +=
				(f.du[j * f.w + i] * W - tx) ** 2 + (f.dv[j * f.w + i] * H - ty) ** 2;
			n++;
		}
	const rms = Math.sqrt(se / n);
	check(
		"GP recovery RMS < 0.5 px (dense cues, bounds relaxed)",
		rms < 0.5,
		`${rms.toFixed(3)} px`,
	);
	check(
		"provenance: n, sources, bound, LOO gain",
		f.provenance.n === 150 &&
			f.provenance.sources.includes("synthetic") &&
			f.provenance.sources[0] === "method:gp" &&
			f.provenance.bound.px === 12 &&
			f.provenance.looGainPx === null, // > 60 cues: not computed
	);
	const small = fitField(cues.slice(0, 20), g, cam, {
		maxMetres: 1e9,
		fade: [2, 3],
	});
	check(
		"provenance LOO gain computed (20 cues) and > 0 on a smooth field",
		small.provenance.looGainPx !== null && small.provenance.looGainPx > 0,
		`${small.provenance.looGainPx?.toFixed(2)} px`,
	);
	// TPS baseline on an affine field is exact
	const aff = (u: number, v: number): [number, number] => [
		2 + 3 * u - 2 * v,
		-1 + u + v,
	];
	const ac = Array.from({ length: 12 }, () => {
		const u = 0.1 + 0.8 * rnd();
		const v = 0.4 + 0.5 * rnd();
		return pointCue(u, v, aff(u, v), 0.05);
	});
	const ft = fitField(ac, g, cam, {
		method: "tps",
		maxMetres: 1e9,
		fade: [50, 60],
		tpsLambda: 1e-6,
	});
	const [du, dv] = sampleField(ft, 0.5, 0.65);
	const [ax, ay] = aff(0.5, 0.65);
	const e = Math.hypot(du * W - ax, dv * H - ay);
	check(
		"TPS baseline reproduces an affine field",
		e < 0.05,
		`${e.toFixed(4)} px`,
	);
}

// ---- 3. bounds, sky, people, support ----
{
	const g = geom(64, 48, (u, v) => u > 0.8 && v > 0.7);
	const big: FieldCue[] = [];
	for (let k = 0; k < 40; k++) {
		const u = 0.1 + 0.8 * rnd();
		const v = 0.32 + 0.66 * rnd();
		big.push(pointCue(u, v, [40, -30]));
	}
	const f = fitField(big, g, cam);
	let worst = 0;
	let skyMax = 0;
	let pplMax = 0;
	for (let j = 0; j < f.h; j++)
		for (let i = 0; i < f.w; i++) {
			const u = (i + 0.5) / f.w;
			const v = (j + 0.5) / f.h;
			const k = j * f.w + i;
			const m = Math.hypot(f.du[k] * W, f.dv[k] * H);
			const gi = Math.min(g.w - 1, Math.floor(u * g.w));
			const gj = Math.min(g.h - 1, Math.floor(v * g.h));
			const r = g.rangeM[gj * g.w + gi];
			// sky beyond the skyline margin (18 px @1600 = 0.015 of H) must be exactly 0
			if (!(r > 0) && v < 0.3 - 18 / H - 1.5 / g.h)
				skyMax = Math.max(skyMax, m);
			else if (!(r > 0)) continue;
			else if (g.people?.[gj * g.w + gi]) pplMax = Math.max(pplMax, m);
			else worst = Math.max(worst, m / boundPx(r, fPx, FIELD_DEFAULTS));
		}
	check(
		"|W| ≤ min(12 px, 15 m at range, 1°) everywhere",
		worst <= 1 + 1e-5,
		`max ratio ${worst.toFixed(4)}`,
	);
	check(
		"maxAbsPx ≤ 12",
		f.maxAbsPx <= 12 + 1e-6,
		`${f.maxAbsPx.toFixed(2)} px`,
	);
	check("W = 0 on sky (beyond the skyline margin)", skyMax === 0);
	check("W = 0 on people", pplMax === 0);
	const far = boundPx(20000, fPx, FIELD_DEFAULTS);
	check(
		"15 m at 20 km bound < 1°, < 12 px",
		far < 12 && far < fPx * (Math.PI / 180),
		`${far.toFixed(2)} px`,
	);

	// one cue: zero beyond 2 correlation lengths
	const one = fitField([pointCue(0.2, 0.9, [3, 0])], g, cam);
	const ell = FIELD_DEFAULTS.lengthPx;
	let outside = 0;
	for (let j = 0; j < one.h; j++)
		for (let i = 0; i < one.w; i++) {
			const d = Math.hypot(
				((i + 0.5) / one.w - 0.2) * W,
				((j + 0.5) / one.h - 0.9) * H,
			);
			if (d > 2 * ell)
				outside = Math.max(outside, Math.abs(one.du[j * one.w + i]) * W);
		}
	check("W = 0 beyond 2 correlation lengths of support", outside === 0);
	const [cu] = sampleField(one, 0.2, 0.9);
	check(
		"single cue: W at the cue has the residual's sign",
		cu > 0,
		`${(cu * W).toFixed(2)} px`,
	);
}

// ---- 4. level and edge cues ----
{
	const g = geom();
	const lv: FieldCue = {
		kind: "level",
		u: 0.5,
		v: 0.85,
		el: 0,
		depthM: rangeAt(0.85),
		sigmaPx: 0.5,
		source: "lake",
		residualPx: 3,
		conf: 1,
	};
	const f = fitField([lv], g, cam);
	const [du, dv] = sampleField(f, 0.5, 0.85);
	check(
		"level cue: du = 0, dv > 0",
		du === 0 && dv > 0,
		`dv ${(dv * H).toFixed(2)} px`,
	);
	const ed: FieldCue = {
		kind: "edge",
		u: 0.5,
		v: 0.85,
		nu: 3,
		nv: 4,
		world: [0, 0, 0],
		depthM: rangeAt(0.85),
		sigmaPx: 0.5,
		source: "edge",
		residualPx: 2,
		conf: 1,
	};
	const fe = fitField([ed], g, cam);
	const [eu, ev] = sampleField(fe, 0.5, 0.85);
	const cross = eu * W * 4 - ev * H * 3;
	check(
		"edge cue: W along its normal only",
		Math.abs(cross) < 1e-4 && eu > 0 && ev > 0,
		`W=(${(eu * W).toFixed(2)}, ${(ev * H).toFixed(2)})`,
	);
	const pt: FieldCue = { ...pointCue(0.5, 0.85, [1, 1]), residualPx: 3 };
	check(
		"point cue with a scalar residual is rejected",
		fitField([pt], g, cam).provenance.sources[0] === "refused:no-cues",
	);
}

// ---- 5. RGBA8 texture, GLSL mirror, readback round trip ----
{
	const g = geom();
	const cues: FieldCue[] = [];
	for (let k = 0; k < 60; k++) {
		const u = 0.05 + 0.9 * rnd();
		const v = 0.35 + 0.6 * rnd();
		cues.push(pointCue(u, v, [8 * Math.sin(u * 5), 6 * Math.cos(v * 5)]));
	}
	const f = fitField(cues, g, cam, { maxMetres: 1e9, fade: [2, 3] });
	const tex = packWarpTexture(f);
	let e = 0;
	for (let k = 0; k < 5000; k++) {
		const u = rnd();
		const v = rnd();
		const [a, b] = sampleField(f, u, v);
		const [c, d] = warpAtCPU(tex.data, tex.width, tex.height, tex.scale, u, v);
		e = Math.max(e, Math.hypot((a - c) * W, (b - d) * H));
	}
	check(
		"GLSL mirror (RGBA8 16-bit decode + manual bilinear) ≡ sampleField",
		e < 1e-3,
		`max ${e.toExponential(2)} px`,
	);
	const st = new WarpState(f);
	let rt = 0;
	let rt2 = 0;
	for (let k = 0; k < 5000; k++) {
		const u = 0.02 + 0.96 * rnd();
		const v = 0.02 + 0.96 * rnd();
		const [ru, rv] = photoToRenderUV(f, u, v);
		const [pu, pv] = renderToPhotoUV(st.inverse, ru, rv);
		rt = Math.max(rt, Math.hypot((pu - u) * W, (pv - v) * H));
		const [qu, qv] = st.photoOf(ru, rv);
		rt2 = Math.max(rt2, Math.hypot((qu - u) * W, (qv - v) * H));
	}
	console.log(`      grid-inverse only round trip: max ${rt.toFixed(4)} px`);
	check(
		"readback round trip photo→render→photo (WarpState.photoOf) < 0.05 px",
		rt2 < 0.05,
		`max ${rt2.toFixed(4)} px, |W| ≤ ${f.maxAbsPx.toFixed(1)} px`,
	);
	check(
		"WarpState.inverse ≡ invertField",
		st.inverse.du[100] === invertField(f).du[100],
	);
	check(
		"WARP_GLSL defines warpDecode / warpAt / warpUV, no uniforms",
		/vec2 warpAt\(sampler2D tWarp, float scale, vec2 uv\)/.test(WARP_GLSL) &&
			/vec2 warpUV\(/.test(WARP_GLSL) &&
			!/\buniform\b/.test(WARP_GLSL),
	);
	check(
		"warpFlag",
		warpFlag("?concord=eye,warp") && !warpFlag("?concord=eye") && !warpFlag(""),
	);
}

console.log(failed ? `\n${failed} FAILED` : "\nall PASS");
process.exit(failed ? 1 : 0);
