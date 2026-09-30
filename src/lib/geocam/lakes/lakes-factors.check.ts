// Synthetic checks for the GA4 lake factors (lakes/factors.ts):
//   1. level rows are 0 at the true camera (no bias) and their U-derivative is f/d (dip geometry);
//   2. eye-Z recovery (pitch + U free, skyline-like pitch anchor) from ±5/10/20 m with a −3 px
//      constant cue bias: with the bias nuisance the error stays small, without it the bias leaks
//      into U by ≈ b·d/f (the nuisance is what makes the factor robust to concord's cue offset);
//   3. shore rows are 0 at truth and move with the eye;
//   4. lakeFloorFactor is one-sided with the analytic Jacobian;
//   5. WaterSource re-extraction in relinearize() (dim follows the cue count; idempotent at same x).
//
//   npx tsx src/lib/geocam/lakes/lakes-factors.check.ts
import { projectX } from "../../concord/core";
import {
	type Lake,
	shoreDistance,
	type WaterCue,
} from "../../concord/cues/water";
import { focalPx1600 } from "../map/joint-residual";
import {
	type CameraX,
	cameraXFromState,
	type Factor,
	type GeoState,
	IDX,
	NP,
	stateFromCameraX,
} from "../core";
import { lakeFloorFactor, waterlineFactors } from "./factors";

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
	if (!ok) failed++;
};

const base: CameraX = {
	pose: { yaw: 0, pitch: -4, roll: 0, vfov: 40 },
	eye: [0, 0, 0],
	aspect: 4 / 3,
	intr: { fScale: 1, k1: 0, cx: 0, cy: 0 },
};
const LZ = -120; // lake plane 120 m below the eye (scene frame)
const f = focalPx1600(base);
// lake: rectangle e ∈ [−3000, 3000], n ∈ [600, 4500]; far shore n = 4500
const lake: Lake = {
	polygon: [
		[-3000, 600],
		[3000, 600],
		[3000, 4500],
		[-3000, 4500],
	],
	levelM: LZ,
};
const sd = shoreDistance(lake);

/** Level cues at the lake's far shore + a near shore, observed from `cam` with a v offset (px). */
function levelCues(cam: CameraX, biasPx: number): WaterCue[] {
	const out: WaterCue[] = [];
	const { H } = { H: 1600 / cam.aspect };
	for (let k = 0; k < 24; k++) {
		// far shore (4.5 km) and a bay at 1.5–2.5 km: several distances so 1/d varies
		const e = -1500 + k * 130;
		const n = k % 3 === 0 ? 1500 + 40 * k : 4500;
		const world: [number, number, number] = [e, n, LZ];
		const q = projectX(cam, world);
		if (!q) continue;
		const d = Math.hypot(e, n);
		out.push({
			kind: "level",
			u: q.u,
			v: q.v - biasPx / H, // residual = pred − obs ⇒ obs above pred by bias
			el: 0,
			depthM: d,
			sigmaPx: Math.hypot(1, (f * 0.5) / d),
			source: "waterline",
			residualPx: 0,
			conf: 1,
			predV: q.v,
			world,
			lake: 0,
		});
	}
	return out;
}

function shoreCues(cam: CameraX): WaterCue[] {
	const out: WaterCue[] = [];
	for (let k = 0; k < 12; k++) {
		// near shore n = 600 seen at e = −800…800: the observed pixel is the true projection
		const world: [number, number, number] = [-800 + k * 140, 600, LZ];
		const q = projectX(cam, world);
		if (!q) continue;
		out.push({
			kind: "shore",
			u: q.u,
			v: q.v,
			lakeM: LZ,
			shoreDist: sd,
			depthM: Math.hypot(world[0], world[1]),
			sigmaPx: 1,
			source: "shore",
			residualPx: 0,
			conf: 1,
			predV: q.v,
			world,
			lake: 0,
		});
	}
	return out;
}

// tiny IRLS Gauss–Newton over a parameter subset (FD Jacobians), for the checks only
function gn(
	factors: Factor[],
	x0: GeoState,
	free: number[],
	iters = 30,
): GeoState {
	const x = Float64Array.from(x0);
	const step = (i: number) => (i < 3 ? 1e-3 : i === 3 ? 1e-4 : 0.05);
	for (let it = 0; it < iters; it++) {
		const m = free.length;
		const A = new Float64Array(m * m);
		const b = new Float64Array(m);
		for (const fa of factors) {
			const r0 = fa.residual(x);
			const J: Float64Array[] = free.map((pi) => {
				const xp = Float64Array.from(x);
				const xm = Float64Array.from(x);
				xp[pi] += step(pi);
				xm[pi] -= step(pi);
				const rp = fa.residual(xp);
				const rm = fa.residual(xm);
				return rp.map((v, k) => (v - rm[k]) / (2 * step(pi)));
			});
			for (let k = 0; k < r0.length; k++) {
				if (!Number.isFinite(r0[k])) continue;
				const w =
					fa.loss.kind === "cauchy" ? 1 / (1 + (r0[k] / fa.loss.c) ** 2) : 1;
				for (let a = 0; a < m; a++) {
					if (!Number.isFinite(J[a][k])) continue;
					b[a] -= w * J[a][k] * r0[k];
					for (let c = 0; c < m; c++) A[a * m + c] += w * J[a][k] * J[c][k];
				}
			}
		}
		// solve (m ≤ 3) by Gaussian elimination
		const M = Array.from({ length: m }, (_, a) => [
			...Array.from(
				{ length: m },
				(_, c) => A[a * m + c] + (a === c ? 1e-9 : 0),
			),
			b[a],
		]);
		for (let p = 0; p < m; p++) {
			for (let r = p + 1; r < m; r++) {
				const t = M[r][p] / M[p][p];
				for (let c = p; c <= m; c++) M[r][c] -= t * M[p][c];
			}
		}
		const dx = new Array(m).fill(0);
		for (let p = m - 1; p >= 0; p--) {
			let s = M[p][m];
			for (let c = p + 1; c < m; c++) s -= M[p][c] * dx[c];
			dx[p] = s / M[p][p];
		}
		let mx = 0;
		free.forEach((pi, a) => {
			x[pi] += dx[a];
			mx = Math.max(mx, Math.abs(dx[a]));
		});
		if (mx < 1e-7) break;
	}
	return x;
}

/** Stand-in for the skyline: pitch anchored to truth at 0.02° (far skyline ≈ eye-insensitive). */
const pitchAnchor = (p0: number, sig = 0.02): Factor => ({
	family: "skyline",
	name: "pitchAnchor",
	dim: 1,
	loss: { kind: "l2" },
	residual: (x) => Float64Array.of((x[IDX.pitch] - p0) / sig),
});

const x0 = stateFromCameraX(base);

// 1. zero at truth, dip derivative
{
	const [lv] = waterlineFactors(levelCues(base, 0), base, {
		families: ["level"],
		biasSigmaPx: 0,
	});
	const r = lv.residual(x0);
	let mx = 0;
	for (let k = 0; k < r.length - 1; k++) mx = Math.max(mx, Math.abs(r[k]));
	check("level zero at truth", mx < 1e-6, `max |z| ${mx.toExponential(2)}`);
	const cues = levelCues(base, 0);
	const xp = Float64Array.from(x0);
	xp[IDX.U] += 1;
	const rp = lv.residual(xp);
	let worst = 0;
	cues.forEach((c, k) => {
		const dPx = (rp[k] - r[k]) * c.sigmaPx; // px per metre of eye height
		const expect = f / c.depthM; // dip: the target sinks by 1/d rad per metre
		worst = Math.max(worst, Math.abs(dPx - expect) / expect);
	});
	check(
		"level dU derivative = f/d",
		worst < 0.02,
		`worst rel err ${worst.toFixed(4)}`,
	);
}

// 2. eye-Z recovery with a −3 px bias
{
	const errs: string[] = [];
	let worstWith = 0;
	let worstWithout = 0;
	for (const dz of [-20, -10, -5, 5, 10, 20]) {
		const cues = levelCues(base, -3);
		const start = Float64Array.from(x0);
		start[IDX.U] += dz;
		const withB = gn(
			[
				...waterlineFactors(cues, base, { families: ["level"] }),
				pitchAnchor(-4),
			],
			start,
			[IDX.pitch, IDX.U],
		);
		const noB = gn(
			[
				...waterlineFactors(cues, base, {
					families: ["level"],
					biasSigmaPx: 0,
				}),
				pitchAnchor(-4),
			],
			start,
			[IDX.pitch, IDX.U],
		);
		worstWith = Math.max(worstWith, Math.abs(withB[IDX.U]));
		worstWithout = Math.max(worstWithout, Math.abs(noB[IDX.U]));
		errs.push(`${dz}:${withB[IDX.U].toFixed(2)}/${noB[IDX.U].toFixed(2)}`);
	}
	check(
		"eye-Z recovery ±5/10/20 m, −3 px bias, nuisance on",
		worstWith < 2.5,
		`worst |U| ${worstWith.toFixed(2)} m (off: ${worstWithout.toFixed(2)} m) [dz:on/off ${errs.join(" ")}]`,
	);
	check(
		"bias nuisance reduces bias leakage",
		worstWith < worstWithout,
		`${worstWith.toFixed(2)} < ${worstWithout.toFixed(2)}`,
	);
	// no bias: both exact
	const start = Float64Array.from(x0);
	start[IDX.U] += 20;
	const clean = gn(
		[
			...waterlineFactors(levelCues(base, 0), base, { families: ["level"] }),
			pitchAnchor(-4),
		],
		start,
		[IDX.pitch, IDX.U],
	);
	check(
		"eye-Z exact without bias",
		Math.abs(clean[IDX.U]) < 0.05,
		`U ${clean[IDX.U].toFixed(4)}`,
	);
}

// 3. shore rows
{
	const [sh] = waterlineFactors(shoreCues(base), base, {
		families: ["shore"],
		biasSigmaPx: 0,
	});
	const r = sh.residual(x0);
	let mx = 0;
	for (let k = 0; k < r.length - 1; k++) mx = Math.max(mx, Math.abs(r[k]));
	check("shore ~0 at truth", mx < 0.05, `max |z| ${mx.toFixed(4)}`);
	const xp = Float64Array.from(x0);
	xp[IDX.N] += 20;
	const rp = sh.residual(xp);
	let mean = 0;
	for (let k = 0; k < rp.length - 1; k++) mean += Math.abs(rp[k]);
	mean /= rp.length - 1;
	check("shore moves with N (+20 m)", mean > 2, `mean |z| ${mean.toFixed(2)}`);
	const start = Float64Array.from(x0);
	start[IDX.N] += 20;
	const sol = gn([sh, pitchAnchor(-4)], start, [IDX.N]);
	check(
		"shore recovers N",
		Math.abs(sol[IDX.N]) < 1,
		`N ${sol[IDX.N].toFixed(3)}`,
	);
}

// 4. lake floor
{
	const fl = lakeFloorFactor(-10, { marginM: 0.5, sigmaM: 0.25 });
	const a = Float64Array.from(x0);
	a[IDX.U] = 0;
	const b = Float64Array.from(x0);
	b[IDX.U] = -12;
	const ra = fl.residual(a)[0];
	const rb = fl.residual(b)[0];
	const jb = fl.jacobian?.(b) ?? new Float64Array(NP);
	check(
		"lakeFloor one-sided",
		ra === 0 &&
			Math.abs(rb - 2.5 / 0.25) < 1e-9 &&
			jb[IDX.U] === -4 &&
			fl.prior === true,
		`above ${ra}, below ${rb}, dU ${jb[IDX.U]}`,
	);
}

// 5. relinearize re-extracts
await (async () => {
	let calls = 0;
	const src = (cam: CameraX) => {
		calls++;
		// cue count depends on the camera (as a real extraction would)
		return levelCues(cam, 0).slice(0, cam.eye[2] > 5 ? 10 : 20);
	};
	const [lv] = waterlineFactors(src, base, { families: ["level"] });
	check("source: empty before relinearize", lv.dim === 1, `dim ${lv.dim}`);
	await lv.relinearize?.(x0);
	const d0 = lv.dim;
	await lv.relinearize?.(x0);
	const xp = Float64Array.from(x0);
	xp[IDX.U] = 10;
	await lv.relinearize?.(xp);
	check(
		"source: re-extraction + idempotence",
		d0 === 21 && lv.dim === 11 && calls === 2,
		`dims ${d0} → ${lv.dim}, calls ${calls}`,
	);
	const cam = cameraXFromState(base, xp);
	check("source: cam from state", cam.eye[2] === 10, `eyeZ ${cam.eye[2]}`);
})();

if (failed) {
	console.log(`${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("all lakes-factors checks passed");
