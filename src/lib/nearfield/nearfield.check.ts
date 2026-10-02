// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Self-contained checks for the near-field core. Run: npx tsx src/lib/nearfield/nearfield.check.ts
// Exits 1 on the first failed group (prints every failure).
import type { Pose } from "../camera";
import type { Renderer } from "../renderer";
import {
	ANCHOR_LOW_TRUST,
	anchoredRange,
	anchorQuality,
	curveRange,
	fitAnchor,
} from "./anchor";
import { intrinsicsFromPose, rayFactor } from "./geom";
import { groundObjects, isFarComponent, promoteFarObjects } from "./ground";
import { camToEnuMatrix, liftToGaussians, toEnu } from "./lift";
import { filterForExport, PROVENANCE_COLORS_BY_CODE } from "./provenance";
import { buildNearFieldScene, type NearFieldRendererLike } from "./scene";
import {
	decodeGaussianPly,
	decodeSplatV1,
	encodeSplatV1,
	readSplatV1Origin,
} from "./splat-io";
import { splitPixels } from "./split";
import {
	ANCHOR_MIN_QUALITY,
	DEFAULT_SPLIT,
	type GaussianCloud,
	type NearFieldDepth,
	PixelClass,
	PROVENANCE_CODE,
} from "./types";

// type-only: both engines can be passed to buildNearFieldScene as-is
export const _rendererIsLike: NearFieldRendererLike =
	null as unknown as Renderer;

let failed = 0;
function ok(cond: boolean, msg: string) {
	console.log(`${cond ? "ok  " : "FAIL"} ${msg}`);
	if (!cond) failed++;
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

// deterministic PRNG
let seed = 12345;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};

// ---- splat-v1 round trip ----
{
	const n = 5;
	const c: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: Float32Array.from({ length: 3 * n }, () => rnd() * 100 - 50),
		scales: Float32Array.from({ length: 3 * n }, () => rnd()),
		rotations: Float32Array.from({ length: 4 * n }, () => rnd()),
		colors: Uint8Array.from({ length: 4 * n }, () => (rnd() * 256) | 0),
		provenance: Uint8Array.from({ length: n }, (_, i) => i % 4),
		source: Uint16Array.from({ length: n }, (_, i) => 1000 + i),
	};
	const origin = { lat: 46.5, lon: 7.9, h: 1234.5 };
	const buf = encodeSplatV1(c, origin);
	const d = decodeSplatV1(buf);
	const same = (a: ArrayLike<number>, b: ArrayLike<number> | undefined) =>
		!!b && a.length === b.length && Array.from(a).every((x, i) => x === b[i]);
	ok(
		d.count === n &&
			d.frame === "enu" &&
			same(c.positions, d.positions) &&
			same(c.scales, d.scales) &&
			same(c.rotations, d.rotations) &&
			same(c.colors, d.colors) &&
			same(c.provenance, d.provenance) &&
			same(c.source as Uint16Array, d.source),
		"splat-v1 round trip (enu, with source)",
	);
	const o = readSplatV1Origin(buf);
	ok(
		!!o && o.lat === 46.5 && o.lon === 7.9 && o.h === 1234.5,
		"splat-v1 origin",
	);
	// header layout: 40 B header, body 5*45 = 225 → pad to 268, + 10 B source
	ok(buf.byteLength === 278, `splat-v1 size ${buf.byteLength} === 278`);
	const cam = decodeSplatV1(
		encodeSplatV1({ ...c, frame: "camera", source: undefined }),
	);
	ok(
		cam.frame === "camera" &&
			!cam.source &&
			readSplatV1Origin(encodeSplatV1(cam)) === null,
		"splat-v1 camera frame, no source",
	);
	let threw = false;
	try {
		decodeSplatV1(new Uint8Array(buf).slice(0, 100));
	} catch {
		threw = true;
	}
	ok(threw, "splat-v1 truncated buffer throws");
}

// ---- 3DGS ply ----
{
	const props = [
		"x",
		"y",
		"z",
		"nx",
		"ny",
		"nz",
		"f_dc_0",
		"f_dc_1",
		"f_dc_2",
		"opacity",
		"scale_0",
		"scale_1",
		"scale_2",
		"rot_0",
		"rot_1",
		"rot_2",
		"rot_3",
	];
	const hdr = `ply\nformat binary_little_endian 1.0\nelement vertex 2\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`;
	const hb = new TextEncoder().encode(hdr);
	const body = new DataView(new ArrayBuffer(2 * props.length * 4));
	const rows = [
		[
			1,
			2,
			3,
			0,
			0,
			0,
			0,
			1,
			-1,
			0,
			Math.log(0.5),
			Math.log(0.25),
			0,
			2,
			0,
			0,
			0,
		],
		[4, 5, 6, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0, 1, 0],
	];
	rows.flat().forEach((v, i) => {
		body.setFloat32(4 * i, v, true);
	});
	const all = new Uint8Array(hb.length + body.byteLength);
	all.set(hb);
	all.set(new Uint8Array(body.buffer), hb.length);
	const g = decodeGaussianPly(all.buffer);
	ok(
		g.count === 2 &&
			g.positions[3] === 4 &&
			near(g.scales[0], 0.5, 1e-6) &&
			near(g.scales[1], 0.25, 1e-6) &&
			g.colors[0] === 128 &&
			g.colors[1] === Math.round((0.5 + 0.28209479) * 255) &&
			g.colors[2] === Math.round((0.5 - 0.28209479) * 255) &&
			g.colors[3] === 128 &&
			g.colors[7] === 255 &&
			g.rotations[0] === 1 &&
			g.rotations[6] === 1 &&
			g.provenance[0] === PROVENANCE_CODE.reconstructed,
		"3DGS ply decode (SH0 colour, sigmoid opacity, exp scale, normalised quat)",
	);
}

// ---- synthetic scene: a fronto-parallel wall at 100 m (DEM), a box at 20 m, 30% outliers ----
const W = 160;
const H = 120;
const pose: Pose = { yaw: 0, pitch: 0, roll: 0, vfov: 60 };
const aspect = W / H;
const K = intrinsicsFromPose(pose, aspect);
const WALL = 100;
const BOX = 20;
const TRUE_SCALE = 2.5; // metres = TRUE_SCALE · model units
const inBox = (i: number, j: number) => i >= 60 && i < 100 && j >= 50 && j < 90;
const demRangeAt = (u: number, v: number) => WALL * rayFactor(K, u, v);

function makeDepth(outlierFrac: number, withBox: boolean): NearFieldDepth {
	const depth = new Float32Array(W * H);
	const valid = new Uint8Array(W * H).fill(1);
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const k = j * W + i;
			let z = withBox && inBox(i, j) ? BOX : WALL; // true z-depth (fronto-parallel)
			z *= 1 + (rnd() - 0.5) * 0.04; // ±2% noise
			if (!(withBox && inBox(i, j)) && rnd() < outlierFrac)
				z *= 0.1 + 0.6 * rnd(); // things in front of the terrain (one-sided)
			depth[k] = z / TRUE_SCALE;
		}
	return { width: W, height: H, depth, valid, model: "synthetic", seconds: 0 };
}

{
	const d = makeDepth(0.3, false);
	const fit = fitAnchor(d, demRangeAt, K);
	const fitS = fitAnchor(d, demRangeAt, K, { mode: "scale" });
	ok(
		near(fitS.scale, TRUE_SCALE, 0.01 * TRUE_SCALE) && !fitS.curve,
		`scale-only anchor ${fitS.scale.toFixed(4)} ≈ ${TRUE_SCALE} (±1%) with 30% outliers`,
	);
	ok(
		!!fit.curve && near(fit.scale, TRUE_SCALE, 0.02 * TRUE_SCALE),
		`curve anchor ratio at the median ${fit.scale.toFixed(4)} ≈ ${TRUE_SCALE} (±2%: ±2 % model noise inside one cluster) with 30% outliers`,
	);
	ok(
		near(fit.inlierFrac, 0.7, 0.05) &&
			fit.residualLog < 0.02 &&
			fit.quality > 0.6,
		`anchor stats inlierFrac=${fit.inlierFrac.toFixed(3)} residualLog=${fit.residualLog.toFixed(4)} quality=${fit.quality.toFixed(3)}`,
	);
	const aff = fitAnchor(d, demRangeAt, K, { mode: "affine" });
	ok(
		near(aff.scale * 40 + aff.shift, TRUE_SCALE * 40, 0.02 * TRUE_SCALE * 40),
		`affine anchor consistent (scale ${aff.scale.toFixed(3)}, shift ${aff.shift.toFixed(2)})`,
	);
	// z-depth vs ray length: a scale-only fit on a wall must not depend on the pixel's off-axis angle
	const wide = intrinsicsFromPose({ ...pose, vfov: 90 }, aspect);
	const dw = makeDepth(0, false);
	const fw = fitAnchor(dw, (u, v) => WALL * rayFactor(wide, u, v), wide);
	ok(
		near(fw.scale, TRUE_SCALE, 0.005 * TRUE_SCALE) && fw.residualLog < 0.015,
		`z-depth → ray length at 90° vfov (scale ${fw.scale.toFixed(4)}, res ${fw.residualLog.toFixed(4)})`,
	);
	const wrongPose = fitAnchor(
		d,
		(u, v) => (u < 0.5 ? 30 : 300) * rayFactor(K, u, v),
		K,
	);
	ok(
		wrongPose.quality < fit.quality,
		`wrong DEM lowers quality (${wrongPose.quality.toFixed(3)} < ${fit.quality.toFixed(3)})`,
	);
	const q10 = anchorQuality({
		residualLog: 0.07,
		residualLogAll: 0.1,
		inlierFrac: 0.8,
		n: 1000,
	});
	ok(
		near(q10, 0.8 * Math.exp(-0.25), 1e-9) &&
			anchorQuality({ residualLog: 0.25, inlierFrac: 0.5, n: 1000 }) <
				ANCHOR_MIN_QUALITY &&
			anchorQuality({ residualLog: 0.01, inlierFrac: 0.8, n: 10 }) === 0,
		`anchorQuality (spike): inlierFrac·exp(−(errAll/0.2)²) = ${q10.toFixed(3)}; 25 % error at half inliers < ANCHOR_MIN_QUALITY; too few samples = 0`,
	);
	ok(
		ANCHOR_MIN_QUALITY === 0.15 &&
			ANCHOR_LOW_TRUST === 0.35 &&
			DEFAULT_SPLIT.objectMargin === 0.5 &&
			DEFAULT_SPLIT.nearRadius === 150,
		"spike calibration: ANCHOR_MIN_QUALITY 0.15, low trust 0.35, split margin 0.5 / near 150 m",
	);
	const none = fitAnchor(d, () => null, K);
	ok(
		none.quality === 0 && none.n === 0 && none.scale === 1,
		"no DEM → quality 0",
	);
}

{
	const d = makeDepth(0, true);
	const fit = fitAnchor(d, demRangeAt, K);
	const s = splitPixels(d, fit, demRangeAt, null, null, undefined, K);
	let boxObj = 0;
	let boxN = 0;
	let outTer = 0;
	let outN = 0;
	for (let j = 0; j < H; j++)
		for (let i = 0; i < W; i++) {
			const c = s.cls[j * W + i];
			if (inBox(i, j)) {
				boxN++;
				if (c === PixelClass.Object) boxObj++;
			} else {
				outN++;
				if (c === PixelClass.Terrain) outTer++;
			}
		}
	ok(
		boxObj === boxN && outTer === outN,
		`split: box ${boxObj}/${boxN} Object, rest ${outTer}/${outN} Terrain`,
	);
	// sky mask + people mask + far + no depth
	const skyM = { width: W, height: H, data: new Uint8Array(W * H) };
	const pplM = { width: W, height: H, data: new Uint8Array(W * H) };
	for (let i = 0; i < W; i++) skyM.data[i] = 255; // top row = sky
	pplM.data[5 * W + 5] = 1; // a wall pixel marked person
	d.valid[10 * W + 10] = 0; // no depth, DEM hit → Far
	const s2 = splitPixels(
		d,
		fit,
		demRangeAt,
		skyM,
		pplM,
		{ ...{ objectMargin: 0.25, minGapM: 3 }, nearRadius: 50 },
		K,
	);
	ok(
		s2.cls[3] === PixelClass.Sky &&
			s2.cls[5 * W + 5] === PixelClass.Object &&
			s2.cls[10 * W + 10] === PixelClass.Far &&
			s2.cls[40 * W + 20] === PixelClass.Far && // wall at 100 m > nearRadius 50
			s2.cls[70 * W + 80] === PixelClass.Object &&
			s2.counts.reduce((a, b) => a + b, 0) === W * H,
		"split: sky mask, forced person Object, no-depth Far, beyond nearRadius Far",
	);
	d.valid[10 * W + 10] = 1;

	// lift + scene
	const photo = {
		width: W * 2,
		height: H * 2,
		data: new Uint8ClampedArray(W * H * 16).fill(200),
	};
	const cloud = liftToGaussians(d, photo, K, s, { stride: 2, anchor: fit });
	const zs = Array.from(
		{ length: cloud.count },
		(_, k) => cloud.positions[3 * k + 2],
	);
	ok(
		cloud.count > 300 &&
			cloud.count <= 400 &&
			zs.every((z) => near(z, BOX, 0.05 * BOX)) &&
			cloud.colors[0] === 200 &&
			cloud.provenance.every((p) => p === PROVENANCE_CODE.observed),
		`lift: ${cloud.count} Object splats at z≈${BOX} m (edges dropped)`,
	);
	const renderer = {
		pose: { yaw: 90, pitch: 0, roll: 0, vfov: 60 },
		aspect,
		eye: { x: 0, y: 0, z: 1500 },
		sampleAt: (u: number, v: number) => ({ range: demRangeAt(u, v) }),
	};
	const scene = buildNearFieldScene({
		photoId: "syn",
		depth: d,
		renderer,
		photo,
	});
	const cx = scene.splats.positions;
	let mx = 0;
	for (let k = 0; k < scene.splats.count; k++)
		mx += cx[3 * k] / scene.splats.count;
	ok(
		scene.splats.frame === "enu" &&
			scene.splats.count === cloud.count &&
			near(mx, BOX, 1) &&
			near(scene.anchor.scale, TRUE_SCALE, 0.02 * TRUE_SCALE) &&
			near(scene.confidenceRadius, Math.min(60, 0.5 * BOX) + 10, 1),
		`scene: ${scene.splats.count} ENU splats mean east ${mx.toFixed(2)} m, radius ${scene.confidenceRadius.toFixed(1)} m`,
	);
	// service-cloud path: the lifted camera cloud un-anchored (model units) must come back to the same splats
	const raw = liftToGaussians(d, photo, K, s, { stride: 2 });
	const scene2 = buildNearFieldScene({
		photoId: "syn",
		depth: d,
		renderer,
		cloud: raw,
	});
	ok(
		scene2.splats.count === raw.count &&
			near(scene2.splats.positions[0], BOX, 1),
		`scene from service cloud: ${scene2.splats.count} kept, anchored to ${scene2.splats.positions[0].toFixed(2)} m east`,
	);
	// SHARP-like cloud: built with its own intrinsics (15% longer focal) and its own units (×0.5). With
	// cloudIntrinsics it must land on the same ENU splats as the depth-lift (same pixel rays, same scale).
	const Kc = { ...K, fx: K.fx * 1.15, fy: K.fy * 1.15 };
	const sharp = liftToGaussians(d, photo, Kc, s, { stride: 2 });
	for (let k = 0; k < sharp.positions.length; k++) sharp.positions[k] *= 0.5;
	const scene3 = buildNearFieldScene({
		photoId: "syn",
		depth: d,
		renderer,
		cloud: sharp,
		cloudIntrinsics: Kc,
	});
	let maxd = 0;
	for (let k = 0; k < scene3.splats.positions.length; k++)
		maxd = Math.max(
			maxd,
			Math.abs(scene3.splats.positions[k] - scene2.splats.positions[k]),
		);
	ok(
		scene3.splats.count === scene2.splats.count && maxd < 1e-3,
		`scene from foreign-K, ×0.5-unit cloud re-projected + rescaled (max |Δ| ${maxd.toExponential(2)} m)`,
	);
	// disc splats: camera-facing normals give a disc whose local z maps to ±normal
	const dn: NearFieldDepth = {
		...d,
		normal: new Float32Array(3 * W * H).map((_, k) => (k % 3 === 2 ? -1 : 0)),
	};
	const disc = liftToGaussians(dn, photo, K, s, { stride: 2, anchor: fit });
	let discOk = disc.count === cloud.count;
	for (let k = 0; k < disc.count && discOk; k++) {
		const [w, x, y, z] = disc.rotations.subarray(4 * k, 4 * k + 4);
		// third column of R(q) = image of local z
		const zz = 1 - 2 * (x * x + y * y);
		discOk =
			Math.abs(Math.abs(zz) - 1) < 1e-6 &&
			Number.isFinite(w + z) &&
			disc.scales[3 * k + 2] < disc.scales[3 * k];
	}
	ok(discOk, "lift: camera-facing normals → thin discs facing the camera");
}

// ---- range-dependent curve + object grounding: a person on a sloped plane at 30 m ----
// Camera 2 m above a plane rising 10 % away from it (pitch 0, 30° vfov, 320×240). The "model" compresses range
// like MoGe-2: model z = z^0.8 (ratio 1.97 at 30 m, 3.1 at 300 m). A 0.6 × 1.8 m person-box stands at z = 30 m;
// its model depth is a further ×0.5 too near, and the model ground under its feet is pulled in ×0.7 (depth models
// blend an object into its contact). The curve alone cannot know about the person's local error; grounding can.
{
	const W2 = 320;
	const H2 = 240;
	const pose2: Pose = { yaw: 0, pitch: 0, roll: 0, vfov: 30 };
	const K2 = intrinsicsFromPose(pose2, W2 / H2);
	const EYE_H = 2;
	const SLOPE = 0.1;
	const ZP = 30;
	const groundZ = (yn: number) => {
		const den = yn + SLOPE;
		return den > 0 ? EYE_H / den : Number.POSITIVE_INFINITY;
	};
	const isPerson = (xn: number, yn: number) => {
		const up = -ZP * yn;
		const feet = -EYE_H + SLOPE * ZP;
		return Math.abs(ZP * xn) <= 0.3 && up >= feet && up <= feet + 1.8;
	};
	const comp = (z: number) => z ** 0.8;
	const feetRow = K2.cy + K2.fy * ((EYE_H - SLOPE * ZP) / ZP); // normalised v of the feet
	const depth2 = new Float32Array(W2 * H2);
	const valid2 = new Uint8Array(W2 * H2);
	const ppl = { width: W2, height: H2, data: new Uint8Array(W2 * H2) };
	const demZ = new Float32Array(W2 * H2).fill(Number.NaN);
	for (let j = 0; j < H2; j++)
		for (let i = 0; i < W2; i++) {
			const k = j * W2 + i;
			const u = (i + 0.5) / W2;
			const v = (j + 0.5) / H2;
			const xn = (u - K2.cx) / K2.fx;
			const yn = (v - K2.cy) / K2.fy;
			const zg = groundZ(yn);
			if (zg <= 5000) demZ[k] = zg;
			if (isPerson(xn, yn)) {
				depth2[k] = 0.5 * comp(ZP);
				valid2[k] = 1;
				ppl.data[k] = 1;
			} else if (zg <= 5000) {
				const di = (u - 0.5) * W2;
				const dj = (v - feetRow) * H2;
				const bump = 1 - 0.3 * Math.exp(-(di * di) / 50 - (dj * dj) / 18);
				depth2[k] = bump * comp(zg);
				valid2[k] = 1;
			}
		}
	const d2: NearFieldDepth = {
		width: W2,
		height: H2,
		depth: depth2,
		valid: valid2,
		model: "synthetic-compressed",
		seconds: 0,
	};
	const dem2 = (u: number, v: number) => {
		const k =
			Math.min(H2 - 1, Math.floor(v * H2)) * W2 +
			Math.min(W2 - 1, Math.floor(u * W2));
		return demZ[k] > 0 ? demZ[k] * rayFactor(K2, u, v) : null;
	};
	const fit2 = fitAnchor(d2, dem2, K2, { peopleMask: ppl });
	const errAt = (z: number) =>
		Math.abs(Math.log(anchoredRange(fit2, comp(z)) / z));
	const curveErr = Math.max(...[20, 50, 150, 400].map(errAt));
	const sc2 = fitAnchor(d2, dem2, K2, { peopleMask: ppl, mode: "scale" });
	const scaleErr = Math.max(
		...[20, 50, 150, 400].map((z) =>
			Math.abs(Math.log((sc2.scale * comp(z)) / z)),
		),
	);
	ok(
		!!fit2.curve &&
			curveErr < 0.05 &&
			scaleErr > 0.4 &&
			fit2.quality > 0.5 &&
			near(fit2.scale, anchoredRange(fit2, 1) / 1, 10) &&
			near(
				curveRange(fit2.curve, comp(100)),
				anchoredRange(fit2, comp(100)),
				1e-9,
			),
		`curve recovers a compressed model at 20-400 m (max |log err| ${curveErr.toFixed(3)}; one scale ${scaleErr.toFixed(2)}; quality ${fit2.quality.toFixed(2)})`,
	);
	// same terrain with 30 % one-sided outliers (things in front of the terrain): the curve must not bend to them
	const dOut = { ...d2, depth: Float32Array.from(depth2) };
	for (let k = 0; k < dOut.depth.length; k++)
		if (!ppl.data[k] && valid2[k] && rnd() < 0.3)
			dOut.depth[k] *= 0.1 + 0.5 * rnd();
	const fitOut = fitAnchor(dOut, dem2, K2, { peopleMask: ppl });
	const outErr = Math.max(
		...[20, 50, 150, 400].map((z) =>
			Math.abs(Math.log(anchoredRange(fitOut, comp(z)) / z)),
		),
	);
	ok(
		outErr < 0.08,
		`curve robust to 30 % one-sided outliers (max |log err| ${outErr.toFixed(3)})`,
	);

	const split2 = splitPixels(d2, fit2, dem2, null, ppl, DEFAULT_SPLIT, K2);
	const g2 = groundObjects(d2, split2, fit2, dem2, K2);
	const person = g2.components.filter((c) => c.cells >= 20);
	const pc = person[0];
	ok(
		person.length === 1 &&
			pc.factor != null &&
			pc.contacts >= 2 &&
			pc.recede != null &&
			near(pc.recede, 1, 0.05),
		`grounding: one upright person component, ${pc?.contacts} contacts, factor ${pc?.factor?.toFixed(3)}`,
	);
	const renderer2 = {
		pose: pose2,
		aspect: W2 / H2,
		eye: { x: 0, y: 0, z: 100 },
		sampleAt: (u: number, v: number) => {
			const r = dem2(u, v);
			return r == null ? null : { range: r };
		},
	};
	const photo2 = {
		width: W2,
		height: H2,
		data: new Uint8ClampedArray(W2 * H2 * 4).fill(128),
	};
	const horiz = (sc: ReturnType<typeof buildNearFieldScene>) => {
		const h: number[] = [];
		for (let k = 0; k < sc.splats.count; k++)
			h.push(
				Math.hypot(sc.splats.positions[3 * k], sc.splats.positions[3 * k + 1]),
			);
		h.sort((a, b) => a - b);
		return h.length ? h[h.length >> 1] : Number.NaN;
	};
	const sGround = buildNearFieldScene({
		photoId: "person",
		depth: d2,
		renderer: renderer2,
		photo: photo2,
		peopleMask: ppl,
		lift: { stride: 1, edgeLog: Number.POSITIVE_INFINITY },
	});
	const sCurve = buildNearFieldScene({
		photoId: "person",
		depth: d2,
		renderer: renderer2,
		photo: photo2,
		peopleMask: ppl,
		lift: { stride: 1, edgeLog: Number.POSITIVE_INFINITY },
		ground: false,
	});
	const hG = horiz(sGround);
	const hC = horiz(sCurve);
	ok(
		sGround.splats.count > 50 && near(hG, ZP, 0.08 * ZP) && hC < 0.6 * ZP,
		`person placed at ${hG.toFixed(1)} m grounded (truth ${ZP} m) vs ${hC.toFixed(1)} m by the curve alone (${sGround.splats.count} splats)`,
	);
	// a floating copy (no ground below it: the cells under it are sky) stays on the curve
	const dFloat = {
		...d2,
		depth: Float32Array.from(depth2),
		valid: Uint8Array.from(valid2),
	};
	const bottomRow = Math.max(
		...Array.from(ppl.data.keys())
			.filter((k) => ppl.data[k])
			.map((k) => Math.floor(k / W2)),
	);
	for (let j = bottomRow + 1; j < Math.min(H2, bottomRow + 4); j++)
		for (let i = 0; i < W2; i++) dFloat.valid[j * W2 + i] = 0;
	const gF = groundObjects(
		dFloat,
		splitPixels(dFloat, fit2, dem2, null, ppl, DEFAULT_SPLIT, K2),
		fit2,
		dem2,
		K2,
	);
	ok(
		gF.components.every((c) => c.factor == null),
		"grounding: no contact (gap below) → curve placement",
	);
	// a receding strip (model depth grows ×3 upward) is not an object: dropped to Terrain
	const dRec: NearFieldDepth = {
		width: 20,
		height: 20,
		depth: new Float32Array(400),
		valid: new Uint8Array(400).fill(1),
		model: "rec",
		seconds: 0,
	};
	const splitRec = {
		width: 20,
		height: 20,
		cls: new Uint8Array(400).fill(PixelClass.Terrain),
		counts: [0, 400, 0, 0, 0],
	};
	for (let j = 0; j < 20; j++)
		for (let i = 0; i < 20; i++) {
			dRec.depth[j * 20 + i] = 10 * 20 ** ((19 - j) / 19);
			if (j >= 4 && j < 16) splitRec.cls[j * 20 + i] = PixelClass.Object;
		}
	const gR = groundObjects(
		dRec,
		splitRec,
		{ scale: 1, shift: 0 },
		() => 10,
		intrinsicsFromPose(pose, 1),
	);
	ok(
		gR.components[0]?.dropped === "notUpright" &&
			gR.split.counts[PixelClass.Object] === 0 &&
			splitRec.cls[100] === PixelClass.Object,
		`grounding: receding strip (recede ${gR.components[0]?.recede?.toFixed(2)}) → Terrain, input split untouched`,
	);
	// no fit → the split uses the DEM only (no Object)
	const nf = splitPixels(
		d2,
		{ scale: 1, shift: 0, n: 5 },
		dem2,
		null,
		ppl,
		DEFAULT_SPLIT,
		K2,
	);
	ok(
		nf.counts[PixelClass.Object] === 0 && nf.counts[PixelClass.Terrain] > 0,
		"no anchor fit → DEM-only split, no Object",
	);
}

// ---- toEnu ----
{
	const one = (x: number, y: number, z: number): GaussianCloud => ({
		count: 1,
		frame: "camera",
		positions: Float32Array.of(x, y, z),
		scales: Float32Array.of(1, 2, 3),
		rotations: Float32Array.of(1, 0, 0, 0),
		colors: Uint8Array.of(1, 2, 3, 4),
		provenance: Uint8Array.of(0),
	});
	const eye = { x: 1, y: 2, z: 3 };
	const p90: Pose = { yaw: 90, pitch: 0, roll: 0, vfov: 50 };
	const e = toEnu(one(0, 0, 10), p90, eye).positions;
	ok(
		near(e[0], 11, 1e-5) && near(e[1], 2, 1e-5) && near(e[2], 3, 1e-5),
		`toEnu: straight ahead at yaw 90° → east (${Array.from(e).map((v) => v.toFixed(3))})`,
	);
	const up = toEnu(one(0, -1, 10), p90, eye).positions; // image up = −y camera
	const right = toEnu(one(1, 0, 10), p90, eye).positions;
	ok(
		near(up[2], 4, 1e-5) && near(right[1], 1, 1e-5),
		"toEnu: camera −y → up (+z), camera +x at yaw 90° → south (−y)",
	);
	// quaternion: rotating the local axes by q_enu must equal M times the axes
	const pose: Pose = { yaw: 37, pitch: -12, roll: 8, vfov: 50 };
	const m = camToEnuMatrix(pose);
	const q = toEnu(one(0, 0, 1), pose, eye).rotations;
	const rot = (v: number[]) => {
		const [w, x, y, z] = q;
		// v' = q v q*
		const tx = 2 * (y * v[2] - z * v[1]);
		const ty = 2 * (z * v[0] - x * v[2]);
		const tz = 2 * (x * v[1] - y * v[0]);
		return [
			v[0] + w * tx + (y * tz - z * ty),
			v[1] + w * ty + (z * tx - x * tz),
			v[2] + w * tz + (x * ty - y * tx),
		];
	};
	let err = 0;
	for (let a = 0; a < 3; a++) {
		const ax = [0, 0, 0];
		ax[a] = 1;
		const r = rot(ax);
		for (let b = 0; b < 3; b++)
			err = Math.max(err, Math.abs(r[b] - m[3 * b + a]));
	}
	ok(err < 1e-6, `toEnu rotates quaternions (max err ${err.toExponential(2)})`);
}

// ---- provenance ----
{
	const n = 4;
	const c: GaussianCloud = {
		count: n,
		frame: "enu",
		positions: Float32Array.from({ length: 3 * n }, (_, i) => i),
		scales: new Float32Array(3 * n).fill(1),
		rotations: new Float32Array(4 * n),
		colors: new Uint8Array(4 * n),
		provenance: Uint8Array.of(
			PROVENANCE_CODE.observed,
			PROVENANCE_CODE.generated,
			PROVENANCE_CODE.dem,
			PROVENANCE_CODE.generated,
		),
		source: Uint16Array.of(0, 1, 2, 3),
	};
	const f = filterForExport(c);
	ok(
		f.count === 2 &&
			!Array.from(f.provenance).includes(PROVENANCE_CODE.generated) &&
			f.positions[3] === 6 &&
			f.source?.[1] === 2,
		"filterForExport drops generated",
	);
	ok(PROVENANCE_COLORS_BY_CODE.length === 4, "PROVENANCE_COLORS_BY_CODE");
}

// ---- far objects (ground.ts promoteFarObjects): a tree at ~300 m on the skyline becomes a grounded Object;
// a wide terrain band in front of the DEM at the same range does not ----
{
	const W = 60;
	const H = 40;
	const K = { fx: 1e6, fy: 1e6, cx: 0.5, cy: 0.5 }; // ray factor ≈ 1: depth = ray length
	const terrainDem = (j: number) =>
		j < 20 ? Number.NaN : 300 * Math.exp((34 - j) * 0.35);
	const make = (inObj: (i: number, j: number) => boolean) => {
		const depth = new Float32Array(W * H).fill(Number.NaN);
		const valid = new Uint8Array(W * H);
		const dem = new Float32Array(W * H).fill(Number.NaN);
		for (let j = 0; j < H; j++)
			for (let i = 0; i < W; i++) {
				const k = j * W + i;
				dem[k] = terrainDem(j);
				if (inObj(i, j)) depth[k] = 300;
				else if (j >= 20) depth[k] = dem[k];
				valid[k] = Number.isNaN(depth[k]) ? 0 : 1;
			}
		const d: NearFieldDepth = {
			width: W,
			height: H,
			depth,
			valid,
			model: "synthetic",
			seconds: 0,
		};
		const demAt = (u: number, v: number) => {
			const x =
				dem[
					Math.min(H - 1, Math.floor(v * H)) * W +
						Math.min(W - 1, Math.floor(u * W))
				];
			return Number.isNaN(x) ? null : x;
		};
		const anchor = { scale: 1, shift: 0 };
		const s0 = splitPixels(d, anchor, demAt, null, null, DEFAULT_SPLIT, K);
		const g0 = groundObjects(d, s0, anchor, demAt, K);
		return {
			g0,
			g1: promoteFarObjects(d, g0, anchor, demAt, K, DEFAULT_SPLIT),
		};
	};
	const tree = make((i, j) => i >= 28 && i <= 33 && j >= 16 && j <= 33);
	const far = tree.g1.components.filter((c) => isFarComponent(c));
	ok(
		tree.g0.split.counts[PixelClass.Object] === 0 &&
			far.length === 1 &&
			tree.g1.split.counts[PixelClass.Object] > 60,
		`far skyline tree promoted to Object (${tree.g1.split.counts[PixelClass.Object]} cells, ${far.length} comp)`,
	);
	const placed = (far[0]?.factor ?? 0) * 300;
	ok(
		placed >= 280 && placed <= 460,
		`far tree placed by its contact (${placed.toFixed(0)} m)`,
	);
	const band = make((i, j) => i >= 3 && i <= 56 && j >= 28 && j <= 31);
	ok(
		band.g1 === band.g0,
		"a wide terrain band in front of the DEM is not a far object",
	);
	const off = promoteFarObjects(
		{
			width: 1,
			height: 1,
			depth: new Float32Array(1),
			valid: new Uint8Array(1),
			model: "x",
			seconds: 0,
		},
		tree.g0,
		{ scale: 1, shift: 0 },
		() => null,
		K,
		DEFAULT_SPLIT,
		{ farRadius: 0 },
	);
	ok(off === tree.g0, "farRadius 0 disables far objects");
}

if (failed) {
	console.error(`\n${failed} check(s) failed`);
	process.exit(1);
}
console.log("\nall nearfield checks passed");
