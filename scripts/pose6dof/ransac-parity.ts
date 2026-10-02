// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Parity of the browser RANSAC solvers (src/lib/pose6dof/ransac) against the Python references
// dumped by scripts/pose6dof/ransac-parity.py (poselib estimate_absolute_pose, match.solve_rotation,
// run_propagate.rot_ransac incl. recorded ALIKED+LightGlue matches).
//
//   npx tsx scripts/pose6dof/ransac-parity.ts OUT.json [--json]
//
// Per case: rotation difference TS vs Python (deg), translation difference (m), inlier-mask agreement
// (fraction of correspondences with the same label) and inlier counts; plus errors vs ground truth.
import { readFileSync } from "node:fs";
import {
	absolutePoseRansac,
	cameraRotationRansac,
	rotationDistanceDeg,
	rotationRansac,
} from "../../src/lib/pose6dof";

type Abs = {
	kind: string;
	n: number;
	outFrac: number;
	W: number;
	H: number;
	f: number;
	gt: { R: number[]; t: number[]; eye: number[] };
	x2d: number[];
	X: number[];
	poselib: {
		R: number[];
		t: number[];
		inliers: number[];
		iterations: number;
		ms: number;
	};
	camrotFixed: { R: number[]; f: number; inliers: number[]; ms: number } | null;
	camrotFree: {
		R: number[];
		f: number;
		f0: number;
		inliers: number[];
		ms: number;
	} | null;
};
type Rot = {
	kind: string;
	pair?: string;
	n: number;
	outFrac?: number;
	KA: number[];
	KB: number[];
	ka: number[];
	kb: number[];
	gtR?: number[];
	cacheRot?: { relR: number[][]; inliers: number; rmsPx: number } | null;
	py: {
		R: number[];
		inliers: number;
		rmsPx: number;
		mask: number[];
		ms: number;
	} | null;
};

const file = process.argv[2];
if (!file) {
	console.log("usage: npx tsx scripts/pose6dof/ransac-parity.ts OUT.json");
	process.exit(2);
}
const data = JSON.parse(readFileSync(file, "utf8")) as {
	absolute: Abs[];
	rot: Rot[];
	poselib: string;
};
const agree = (a: ArrayLike<number>, b: ArrayLike<number>) => {
	let s = 0;
	for (let i = 0; i < a.length; i++) if (!!a[i] === !!b[i]) s++;
	return s / a.length;
};
const sum = (m: ArrayLike<number>) => {
	let s = 0;
	for (let i = 0; i < m.length; i++) s += m[i] ? 1 : 0;
	return s;
};
const f = (x: number | null | undefined, d = 3) =>
	x == null ? "  -  " : x.toFixed(d);
const rows: Record<string, unknown>[] = [];

console.log(`poselib ${data.poselib}`);
console.log(
	"\nabsolute pose (TS absolutePoseRansac vs poselib.estimate_absolute_pose, thr 6 px)",
);
console.log(
	"   n  out | dR(deg) dt(m)  agree | inl ts/py | errR ts/py (deg) | ms ts/py",
);
for (const c of data.absolute) {
	const x2 = Float64Array.from(c.x2d);
	const X = Float64Array.from(c.X);
	const cam = { fx: c.f, fy: c.f, cx: c.W / 2, cy: c.H / 2 };
	let t0 = performance.now();
	const r = absolutePoseRansac(x2, X, cam, { maxReprojErrorPx: 6 });
	const ms = performance.now() - t0;
	const py = c.poselib;
	const dR = r ? rotationDistanceDeg(r.R, py.R) : null;
	const dt = r
		? Math.hypot(r.t[0] - py.t[0], r.t[1] - py.t[1], r.t[2] - py.t[2])
		: null;
	const ag = r ? agree(r.inliers, py.inliers) : null;
	console.log(
		`${String(c.n).padStart(4)} ${c.outFrac.toFixed(1)} | ${f(dR, 4)} ${f(dt, 3)} ${f(ag, 4)} | ${r?.inlierCount}/${sum(py.inliers)} | ${f(r ? rotationDistanceDeg(r.R, c.gt.R) : null, 4)}/${f(rotationDistanceDeg(py.R, c.gt.R), 4)} | ${ms.toFixed(0)}/${py.ms.toFixed(0)}`,
	);
	rows.push({
		solver: "absolute",
		n: c.n,
		outFrac: c.outFrac,
		dR,
		dt,
		agree: ag,
		ms,
		pyMs: py.ms,
	});

	const dirs = new Float64Array(X.length);
	for (let i = 0; i < X.length; i++) dirs[i] = X[i] - c.gt.eye[i % 3];
	for (const [name, ref, f0, free] of [
		["camrot fixed", c.camrotFixed, c.f, false],
		["camrot free", c.camrotFree, c.camrotFree?.f0 ?? c.f, true],
	] as const) {
		t0 = performance.now();
		const s = cameraRotationRansac(
			x2,
			dirs,
			{ fx: f0, fy: f0, cx: c.W / 2, cy: c.H / 2 },
			{ focal: free ? "free" : "fixed" },
		);
		const ms2 = performance.now() - t0;
		if (!ref || !s) {
			console.log(
				`     ${name}: ts ${s ? "ok" : "null"} py ${ref ? "ok" : "null"}`,
			);
			rows.push({
				solver: name,
				n: c.n,
				outFrac: c.outFrac,
				tsNull: !s,
				pyNull: !ref,
			});
			continue;
		}
		const d = rotationDistanceDeg(s.R, ref.R);
		const a = agree(s.inliers, ref.inliers);
		console.log(
			`     ${name.padEnd(12)} dR ${f(d, 4)}° df ${f(s.focal - ref.f, 2)} px agree ${f(a, 4)} inl ${s.inlierCount}/${sum(ref.inliers)} ms ${ms2.toFixed(0)}/${ref.ms.toFixed(0)}`,
		);
		rows.push({
			solver: name,
			n: c.n,
			outFrac: c.outFrac,
			dR: d,
			df: s.focal - ref.f,
			agree: a,
			ms: ms2,
			pyMs: ref.ms,
		});
	}
}

console.log(
	"\nrelative rotation (TS rotationRansac vs run_propagate.rot_ransac, 4 px chord, 2000 iters)",
);
console.log(
	"case                   n  | dR(deg)  agree  | inl ts/py | rms ts/py | errGT ts/py",
);
for (const c of data.rot) {
	const n = c.n;
	const bear = (k: number[], K: number[]) => {
		const out = new Float64Array(n * 3);
		for (let i = 0; i < n; i++) {
			const x = (k[i * 2] + 0.5 - K[2]) / K[0];
			const y = (k[i * 2 + 1] + 0.5 - K[5]) / K[4];
			const l = Math.hypot(x, y, 1);
			out.set([x / l, y / l, 1 / l], i * 3);
		}
		return out;
	};
	const b0 = bear(c.ka, c.KA);
	const b1 = bear(c.kb, c.KB);
	const t0 = performance.now();
	const r = rotationRansac(b0, b1, {
		maxChord: 4 / c.KB[0],
		maxIterations: 2000,
	});
	const ms = performance.now() - t0;
	const label = c.pair ?? `synth ${c.outFrac}`;
	if (!r || !c.py) {
		console.log(
			`${label.padEnd(22)} ${String(n).padStart(4)} | ts ${r ? "ok" : "null"} py ${c.py ? "ok" : "null"}`,
		);
		continue;
	}
	const d = rotationDistanceDeg(r.R, c.py.R);
	const a = agree(r.inliers, c.py.mask);
	const rms = r.rmsChord == null ? null : r.rmsChord * c.KB[0];
	const gtR = c.gtR ?? (c.cacheRot ? c.cacheRot.relR.flat() : null);
	console.log(
		`${label.padEnd(22)} ${String(n).padStart(4)} | ${f(d, 4)} ${f(a, 4)} | ${r.inlierCount}/${c.py.inliers} | ${f(rms, 2)}/${f(c.py.rmsPx, 2)} | ${gtR ? `${f(rotationDistanceDeg(r.R, gtR), 4)}/${f(rotationDistanceDeg(c.py.R, gtR), 4)}${c.gtR ? "" : " (vs study cache)"}` : "-"}`,
	);
	rows.push({
		solver: "rot",
		kind:
			c.kind === "recorded" && c.py.inliers >= 40
				? "recorded, gate-relevant (py ≥ 40 inliers)"
				: c.kind,
		case: label,
		n,
		dR: d,
		agree: a,
		inl: r.inlierCount,
		pyInl: c.py.inliers,
		ms,
		pyMs: c.py.ms,
	});
}

const summary = (solver: string, kind?: string) => {
	const rs = rows.filter(
		(r) =>
			r.solver === solver &&
			(!kind ||
				r.kind === kind ||
				(kind === "recorded" && String(r.kind).startsWith("recorded"))) &&
			typeof r.dR === "number",
	) as {
		dR: number;
		agree: number;
		dt?: number;
	}[];
	if (!rs.length) return;
	const med = (xs: number[]) =>
		xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
	console.log(
		`${(solver + (kind ? ` (${kind})` : "")).padEnd(24)} cases ${rs.length}  dR median ${med(rs.map((r) => r.dR)).toFixed(4)}° max ${Math.max(...rs.map((r) => r.dR)).toFixed(4)}°  agree median ${med(rs.map((r) => r.agree)).toFixed(4)} min ${Math.min(...rs.map((r) => r.agree)).toFixed(4)}${rs[0].dt !== undefined ? `  dt max ${Math.max(...rs.map((r) => r.dt ?? 0)).toFixed(3)} m` : ""}`,
	);
};
console.log("\nsummary");
summary("absolute");
summary("camrot fixed");
summary("camrot free");
summary("rot", "synthetic");
summary("rot", "recorded");
summary("rot", "recorded, gate-relevant (py ≥ 40 inliers)");
if (process.argv.includes("--json")) console.log(JSON.stringify(rows));
