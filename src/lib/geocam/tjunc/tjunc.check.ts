// Synthetic checks for the T-junction package (GA3):
//   1. layeredHorizon: a hill in front of a far ridge gives two crests (hill + ridge skyline) through the
//      hill and one elsewhere; curvature "apply" lowers a 50 km crest by d²/2R_eff;
//   2. predictJunctions: the hill's flanks crossing the far ridge give junctions with the right depths,
//      crossing angle > 20° and pxPer10m ≈ f·10·(1/d₁ − 1/d₂); the GeomBuffer variant finds the same J;
//   3. measureJunctions on synthetic edges (ray-cast boundary at the true eye): |e| < 1 px at truth, the
//      differential residual grows under a 30 m eye shift and is insensitive to a pure pitch change;
//   4. junctionFactor: Gauss–Newton on the eye (E, N) with relinearize recovers a 40 m displacement to < 5 m.
//
//   npx tsx src/lib/geocam/tjunc/tjunc.check.ts
import {
	type CameraX,
	IDENTITY_INTRINSICS,
	projectX,
	type Vec3,
} from "../../concord/core";
import { buildGeomBuffer } from "../../concord/cues/raycast";
import { EARTH_R, REFRACTION_K } from "../../geodesy";
import { type GeoState, IDX, NP } from "../core";
import { junctionFactor } from "./factor";
import {
	junctionsFromGeomBuffer,
	predictJunctions,
	sectorOf,
} from "./junctions";
import { layeredHorizon } from "./layered";
import { boundaryMask, edgesFromMask, measureJunctions } from "./measure";

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`);
	if (!ok) failed++;
};

// scene: far ridge (600 m high, 5 km north, along E), two hills in front
const hills = [
	{ e: 250, n: 1000, h: 150, r: 110 },
	{ e: -500, n: 2000, h: 290, r: 170 },
];
const height = (e: number, n: number) => {
	let z = 600 * Math.exp(-(((n - 5000) / 700) ** 2));
	for (const b of hills)
		z += b.h * Math.exp(-((e - b.e) ** 2 + (n - b.n) ** 2) / (2 * b.r * b.r));
	return z;
};
const H = (e: number, n: number) => height(e, n);
const eyeT: Vec3 = [0, 0, 20];
const cam: CameraX = {
	pose: { yaw: -5, pitch: 5, roll: 0, vfov: 30 },
	eye: eyeT,
	aspect: 1.5,
	intr: { ...IDENTITY_INTRINSICS },
};
const camAt = (e: Vec3): CameraX => ({ ...cam, eye: e });
const sector = sectorOf(cam, 2);
const LO = { step: 0.05, maxD: 20_000 };
const predict = (e: Vec3) =>
	predictJunctions(layeredHorizon(H, e, sector, LO), camAt(e));

// 1. layered crests
{
	const lh = layeredHorizon(H, eyeT, sector, LO);
	// a column through the near hill's flank where the far ridge still shows above it
	const iH = lh.crests.findIndex(
		(c) => c.length >= 2 && c[0].d > 900 && c[0].d < 1150 && c.at(-1)?.sky,
	);
	const cH = iH >= 0 ? lh.crests[iH] : [];
	const cC = lh.crests.find((c) => c.length === 1) ?? [];
	check(
		"layered: hill column has near crest + far skyline",
		cH.length >= 2 && (cH.at(-1)?.d ?? 0) > 4000,
		`az=${cH[0]?.az.toFixed(2)} d=${cH.map((c) => c.d.toFixed(0)).join(",")} els=${cH.map((c) => c.el.toFixed(2)).join(",")}`,
	);
	check(
		"layered: clear column has only the skyline",
		cC.length === 1 && cC[0].sky,
		`n=${cC.length} d=${cC.map((c) => c.d.toFixed(0)).join(",")}`,
	);
	// curvature: a flat plateau edge at 50 km
	const plate = (_e: number, n: number) => (n < 50_000 ? 0 : 3000);
	const a = layeredHorizon(plate, [0, 0, 1], [0, 0], { maxD: 60_000 });
	const b = layeredHorizon(plate, [0, 0, 1], [0, 0], {
		maxD: 60_000,
		curvature: "apply",
	});
	const sa = a.crests[0].at(-1);
	const sb = b.crests[0].at(-1);
	const drop = (sa && sb ? sa.world[2] - sb.world[2] : 0) as number;
	const want = (sb ? sb.d ** 2 : 0) / (2 * (EARTH_R / (1 - REFRACTION_K)));
	check(
		"layered: curvature apply = d²/2R_eff",
		Math.abs(drop - want) < 0.5,
		`drop=${drop.toFixed(1)} want=${want.toFixed(1)} m`,
	);
}

// 2. predicted junctions
const js = predict(eyeT);
{
	const near1 = js.filter((j) => j.nearD > 700 && j.nearD < 1400);
	const near2 = js.filter((j) => j.nearD > 1500 && j.nearD < 2600);
	check(
		"predict: junctions at both hills",
		near1.length >= 1 && near2.length >= 1,
		js
			.map(
				(j) =>
					`[${(j.u * 1600).toFixed(0)},${((j.v * 1600) / 1.5).toFixed(0)} d=${j.nearD.toFixed(0)}/${j.farD.toFixed(0)} ang=${j.angleDeg.toFixed(0)} px10=${j.pxPer10m.toFixed(1)}${j.farSky ? " sky" : ""}]`,
			)
			.join(" "),
	);
	const j = js[0];
	const pJ = j ? projectX(cam, j.worldFar) : null;
	check(
		"predict: J of near and far contours coincide in the image",
		!!j &&
			!!pJ &&
			Math.hypot((pJ.u - j.u) * 1600, (pJ.v - j.v) * 1067) < 1.5 &&
			j.angleDeg >= 20,
		j ? `angle=${j.angleDeg.toFixed(1)}` : "none",
	);
	const g = buildGeomBuffer(cam, 900, 600, (e, n) => H(e, n), {
		maxD: 20_000,
		azStepDeg: 0.02,
	});
	const ji = junctionsFromGeomBuffer(g, cam);
	let matched = 0;
	for (const a of js) {
		const b = ji.find(
			(c) => Math.hypot((c.u - a.u) * 1600, (c.v - a.v) * 1067) < 12,
		);
		if (b) matched++;
	}
	check(
		"geom-buffer variant finds the predicted junctions",
		matched >= Math.min(js.length, 2),
		`${matched}/${js.length} (image-space found ${ji.length})`,
	);
}

// 3. measurement on synthetic edges
const g0 = buildGeomBuffer(cam, 1200, 800, (e, n) => H(e, n), {
	maxD: 20_000,
	azStepDeg: 0.01,
});
const edges = edgesFromMask(
	boundaryMask(g0.range, g0.sky, 1200, 800),
	1200,
	800,
);
{
	const ob = measureJunctions(js, edges, cam);
	const found = ob.filter(
		(o) => Number.isFinite(o.eNear) && Number.isFinite(o.eFar),
	);
	const maxE = Math.max(
		...found.map((o) => Math.max(Math.abs(o.eNear), Math.abs(o.eFar))),
	);
	check(
		"measure: truth residuals < 1 px",
		found.length >= 2 && maxE < 1,
		`found ${found.length}/${ob.length} max|e|=${maxE.toFixed(2)} px`,
	);
	const eyeS: Vec3 = [6, 0, 20];
	const obS = measureJunctions(predict(eyeS), edges, camAt(eyeS));
	const rS = obS.filter((o) => Number.isFinite(o.r)).map((o) => Math.abs(o.r));
	check(
		"measure: 6 m eye shift → differential residual > 3 px",
		rS.length > 0 && Math.max(...rS) > 3,
		`|r|=${rS.map((v) => v.toFixed(1)).join(",")}`,
	);
	// pitch-only change (a common image translation along ~n_far): diff residual stays small
	const camP: CameraX = {
		...cam,
		pose: { ...cam.pose, pitch: cam.pose.pitch + 0.15 },
	};
	const obP = measureJunctions(
		predictJunctions(layeredHorizon(H, eyeT, sector, LO), camP),
		edges,
		camP,
	);
	const pairs = obP.filter(
		(o) => Number.isFinite(o.r) && Number.isFinite(o.eNear),
	);
	const medR = pairs.map((o) => Math.abs(o.r)).sort((a, b) => a - b)[
		pairs.length >> 1
	];
	const medE = pairs.map((o) => Math.abs(o.eNear)).sort((a, b) => a - b)[
		pairs.length >> 1
	];
	check(
		"measure: 0.15° pitch — diff residual ≪ contour offset",
		pairs.length > 0 && medR < 0.5 * medE,
		`median |r|=${medR?.toFixed(2)} vs |e_near|=${medE?.toFixed(2)} px`,
	);
}

// 4. factor: eye recovery by Gauss–Newton (rotation fixed at truth)
await (async () => {
	const x = new Float64Array(NP) as GeoState;
	x[IDX.yaw] = cam.pose.yaw;
	x[IDX.pitch] = cam.pose.pitch;
	x[IDX.roll] = cam.pose.roll;
	const start: Vec3 = [40, -20, 20];
	x[IDX.E] = start[0];
	x[IDX.N] = start[1];
	x[IDX.U] = start[2];
	// observations measured at the true eye; the factor starts 45 m away and must re-find them
	const ob = measureJunctions(js, edges, cam);
	const base: CameraX = { ...cam, eye: [0, 0, 0] };
	const fac = junctionFactor(ob, async (e) => predict(e), base, {
		mode: "pair",
		matchPx: 200,
	});
	for (let outer = 0; outer < 6; outer++) {
		await fac.relinearize?.(x);
		for (let it = 0; it < 3; it++) {
			const r0 = fac.residual(x);
			const cols = [IDX.E, IDX.N];
			const J = cols.map((c) => {
				const xp = Float64Array.from(x);
				xp[c] += 0.5;
				const rp = fac.residual(xp);
				return Array.from(rp, (v, k) => (v - r0[k]) / 0.5);
			});
			let a = 0;
			let b = 0;
			let c = 0;
			let g0_ = 0;
			let g1 = 0;
			for (let k = 0; k < r0.length; k++) {
				if (
					!Number.isFinite(r0[k]) ||
					!Number.isFinite(J[0][k]) ||
					!Number.isFinite(J[1][k])
				)
					continue;
				a += J[0][k] ** 2;
				b += J[0][k] * J[1][k];
				c += J[1][k] ** 2;
				g0_ += J[0][k] * r0[k];
				g1 += J[1][k] * r0[k];
			}
			const det = a * c - b * b + 1e-9;
			const dE = -(c * g0_ - b * g1) / det;
			const dN = -(a * g1 - b * g0_) / det;
			const s = Math.min(1, 30 / Math.hypot(dE, dN));
			x[IDX.E] += s * dE;
			x[IDX.N] += s * dN;
			x[IDX.U] = 20;
		}
	}
	const err = Math.hypot(x[IDX.E], x[IDX.N]);
	check(
		"factor: eye recovered from a 45 m displacement",
		err < 2 && fac.active() === ob.length,
		`start ${Math.hypot(start[0], start[1]).toFixed(1)} m → ${err.toFixed(2)} m (E ${x[IDX.E].toFixed(1)}, N ${x[IDX.N].toFixed(1)}); active ${fac.active()}/${ob.length}`,
	);
})();

if (failed) {
	console.log(`${failed} check(s) FAILED`);
	process.exit(1);
}
console.log("all tjunc checks passed");
