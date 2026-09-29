// Acceptance checks for the concordance core (WP-A):
//   1. projectX with identity intrinsics ≡ camera/index.ts projectPoint, bitwise, on 10k points
//      (and unprojectDirX ≡ unprojectDir);
//   2. distortUV ∘ undistortUV round trip < 1e-6 (uv) over the frame, non-identity intrinsics;
//   3. field inverse round trip < 0.05 px @1600 for |W| ≤ 20 px.
//
//   npx tsx src/lib/concord/core/core.check.ts
import { type Pose, projectPoint, unprojectDir } from "../../camera";
import {
	decodeFieldRGBA8,
	distanceBand,
	distortUV,
	encodeFieldRGBA8,
	IDENTITY_INTRINSICS,
	type Intrinsics,
	invertField,
	projectX,
	type ResidualField,
	radiusBand,
	sampleField,
	undistortUV,
	unprojectDirX,
	ZERO_FIELD,
} from "./index";

let seed = 12345;
const rnd = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 4294967296;
};
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
	if (!ok) failed++;
};

// 1. bitwise identity
{
	let mism = 0;
	let nulls = 0;
	let dirMism = 0;
	for (let k = 0; k < 10000; k++) {
		const pose: Pose = {
			yaw: rnd() * 360,
			pitch: (rnd() - 0.5) * 40,
			roll: (rnd() - 0.5) * 10,
			vfov: 20 + rnd() * 60,
		};
		const aspect = rnd() < 0.5 ? 4 / 3 : 3 / 4;
		const eye: [number, number, number] = [
			(rnd() - 0.5) * 100,
			(rnd() - 0.5) * 100,
			rnd() * 3000,
		];
		// mostly in front of the camera (a few behind to exercise the null path)
		const dir = unprojectDir(
			pose,
			aspect,
			rnd() * 1.4 - 0.2,
			rnd() * 1.4 - 0.2,
		);
		const dist = (rnd() < 0.03 ? -1 : 1) * (20 + rnd() * 40000);
		const pt = [0, 1, 2].map((i) => eye[i] + dir[i] * dist + (rnd() - 0.5) * 5);
		const a = projectPoint(pose, aspect, eye, pt);
		const b = projectX({ pose, eye, aspect, intr: IDENTITY_INTRINSICS }, pt);
		if (a === null || b === null) {
			nulls++;
			if (a !== b) mism++;
		} else if (
			!Object.is(a.u, b.u) ||
			!Object.is(a.v, b.v) ||
			!Object.is(a.depth, b.depth)
		)
			mism++;
		const u = rnd();
		const v = rnd();
		const d0 = unprojectDir(pose, aspect, u, v);
		const d1 = unprojectDirX(
			{ pose, eye, aspect, intr: { ...IDENTITY_INTRINSICS } },
			u,
			v,
		);
		if (d0.some((x, i) => !Object.is(x, d1[i]))) dirMism++;
	}
	check(
		"projectX≡projectPoint (identity, 10k)",
		mism === 0 && dirMism === 0,
		`mismatches=${mism} (behind=${nulls}) unprojectDir mismatches=${dirMism}`,
	);
}

// 2. distort/undistort round trip + projectX/unprojectDirX consistency with intrinsics
{
	let worst = 0;
	let worstRay = 0;
	for (let k = 0; k < 20000; k++) {
		const intr: Intrinsics = {
			fScale: 0.97 + rnd() * 0.06,
			k1: (rnd() - 0.5) * 0.16,
			cx: (rnd() - 0.5) * 0.02,
			cy: (rnd() - 0.5) * 0.02,
		};
		const aspect = rnd() < 0.5 ? 4 / 3 : 3 / 4;
		const vfov = 30 + rnd() * 45;
		const u = rnd();
		const v = rnd();
		const [iu, iv] = undistortUV(u, v, intr, aspect, vfov);
		const [ru, rv] = distortUV(iu, iv, intr, aspect, vfov);
		worst = Math.max(worst, Math.abs(ru - u), Math.abs(rv - v));
		const pose: Pose = { yaw: rnd() * 360, pitch: 5, roll: 1, vfov };
		const cam = {
			pose,
			eye: [0, 0, 0] as [number, number, number],
			aspect,
			intr,
		};
		const d = unprojectDirX(cam, u, v);
		const p = projectX(cam, [d[0] * 5000, d[1] * 5000, d[2] * 5000]);
		if (p) worstRay = Math.max(worstRay, Math.abs(p.u - u), Math.abs(p.v - v));
	}
	check(
		"distort∘undistort round trip < 1e-6",
		worst < 1e-6,
		`max |Δuv|=${worst.toExponential(2)} (|k1|≤0.08, fScale 0.97–1.03)`,
	);
	check(
		"projectX∘unprojectDirX round trip < 1e-6",
		worstRay < 1e-6,
		`max |Δuv|=${worstRay.toExponential(2)}`,
	);
}

// 3. field inverse round trip
{
	const w = 96;
	const h = 72;
	const aspect = 4 / 3;
	const PX = 1600; // u → px at the 1600 basis (landscape: width is the long side)
	const f: ResidualField = ZERO_FIELD(w, h);
	let maxAbs = 0;
	for (let j = 0; j < h; j++)
		for (let i = 0; i < w; i++) {
			const u = (i + 0.5) / w;
			const v = (j + 0.5) / h;
			const ax = 14 * Math.sin(2.1 * u + 0.4) * Math.cos(1.7 * v) + 5 * v * v;
			const ay = 12 * Math.cos(1.3 * u - 0.2) * Math.sin(2.4 * v + 0.3);
			f.du[j * w + i] = ax / PX;
			f.dv[j * w + i] = ay / (PX / aspect);
			maxAbs = Math.max(maxAbs, Math.hypot(ax, ay));
		}
	f.maxAbsPx = maxAbs;
	const inv = invertField(f);
	let worst = 0;
	for (let k = 0; k < 20000; k++) {
		const pu = 0.02 + rnd() * 0.96;
		const pv = 0.02 + rnd() * 0.96;
		const [wu, wv] = sampleField(f, pu, pv);
		const qu = pu + wu;
		const qv = pv + wv;
		const [iu, iv] = sampleField(inv, qu, qv);
		const e = Math.hypot((qu + iu - pu) * PX, (qv + iv - pv) * (PX / aspect));
		worst = Math.max(worst, e);
	}
	check(
		"field inverse round trip < 0.05 px",
		worst < 0.05 && maxAbs <= 20,
		`max err=${worst.toFixed(4)} px, max|W|=${maxAbs.toFixed(1)} px`,
	);
	const { data, scale } = encodeFieldRGBA8(f);
	const dec = decodeFieldRGBA8(data, scale, w, h);
	let encErr = 0;
	for (let k = 0; k < w * h; k++)
		encErr = Math.max(
			encErr,
			Math.abs(dec.du[k] - f.du[k]) * PX,
			Math.abs(dec.dv[k] - f.dv[k]) * PX,
		);
	check(
		"RGBA8 16-bit encode/decode",
		encErr < 0.01,
		`max err=${encErr.toExponential(2)} px`,
	);
}

// 4. bands
check(
	"bands",
	distanceBand(499) === "<0.5km" &&
		distanceBand(500) === "0.5-2km" &&
		distanceBand(4999) === "2-5km" &&
		distanceBand(15000) === ">15km" &&
		radiusBand(0.5, 0.5, 4 / 3) === "centre" &&
		radiusBand(0, 0, 4 / 3) === "corner" &&
		radiusBand(0.5, 0.2, 4 / 3) === "mid",
	"distance/radius band edges",
);

if (failed) {
	console.log(`${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("all core checks passed");
