// T-junction factor (GA3): a core Factor of family "junction".
//
// The photo evidence is fixed at measurement time: for each junction, an observed point on the near
// contour and one on the far contour (JunctionObs.near / .far, photo uv) with the predicted normals. A
// residual is the signed normal distance from the observed point to the PREDICTED contour polyline
// (point-to-curve, px @1600), so sliding along the contour costs nothing.
//
// The eye enters through the prediction (a new layeredHorizon: the silhouette rims slide over rounded
// ridges), so the factor is linearised at an anchor eye e0 (relinearize): the predicted polyline at e0
// gives the foot point W0 on it, and central differences of the full prediction at e0 ± `fdM` along E, N,
// U give g = ∂offset/∂eye. Between relinearisations
//     offset(x) = [projectX(cam(rot(x), f(x), e0), W0) − p_obs]·n + g·(eye(x) − e0),
// exact in rotation and focal, linear in the eye (joint.ts' HzLin pattern). Rows whose junction is not
// re-found at the anchor eye are NaN (dropped).
//
// mode "pair": two rows per junction (near, far), whitened by sigmaNear / sigmaFar.
// mode "diff": one row r = o_far − o_near/(n_near·n_far), whitened by sigmaR (measure.ts).
import { type CameraX, projectX, type Vec3 } from "../../concord/core";
import {
	cameraXFromState,
	type Factor,
	type GeoState,
	IDX,
	type Loss,
} from "../core";
import type { Junction } from "./junctions";
import type { ContourObs, JunctionObs } from "./measure";

export type JunctionFactorOpts = {
	mode?: "pair" | "diff";
	loss?: Loss;
	/** Eye finite-difference step (m). Default 5. */
	fdM?: number;
	/** Re-find a junction within this image distance (px @1600) and depth ratio. Defaults 40 px, 0.25. */
	matchPx?: number;
	matchLogD?: number;
	nEff?: number;
};

const px1600 = (cam: CameraX): [number, number] =>
	cam.aspect >= 1 ? [1600, 1600 / cam.aspect] : [1600 * cam.aspect, 1600];

/** Signed normal offset (px @1600) of observed point `ob` from the polyline `line` projected at cam; with the foot point. */
export function offsetToLine(
	cam: CameraX,
	line: Vec3[],
	ob: ContourObs,
): { off: number; foot: Vec3; n: [number, number] } | null {
	const [W, H] = px1600(cam);
	const px = ob.u * W;
	const py = ob.v * H;
	let best: {
		off: number;
		foot: Vec3;
		n: [number, number];
		dist: number;
	} | null = null;
	let prev: { x: number; y: number; w: Vec3 } | null = null;
	for (const w of line) {
		const p = projectX(cam, w);
		if (!p) {
			prev = null;
			continue;
		}
		const cur = { x: p.u * W, y: p.v * H, w };
		if (prev) {
			const dx = cur.x - prev.x;
			const dy = cur.y - prev.y;
			const L2 = dx * dx + dy * dy;
			if (L2 > 1e-12) {
				// clamp the foot to the segment, but extrapolate at the polyline ends
				let s = ((px - prev.x) * dx + (py - prev.y) * dy) / L2;
				s = Math.max(-1, Math.min(2, s));
				const fx = prev.x + s * dx;
				const fy = prev.y + s * dy;
				const L = Math.sqrt(L2);
				let n: [number, number] = [-dy / L, dx / L];
				if (n[0] * ob.nx + n[1] * ob.ny < 0) n = [-n[0], -n[1]];
				const inSeg = s >= 0 && s <= 1;
				const dist = Math.hypot(px - fx, py - fy) + (inSeg ? 0 : 1e3);
				if (!best || dist < best.dist) {
					const foot: Vec3 = [
						prev.w[0] + s * (w[0] - prev.w[0]),
						prev.w[1] + s * (w[1] - prev.w[1]),
						prev.w[2] + s * (w[2] - prev.w[2]),
					];
					// predicted − observed along n
					best = { off: (fx - px) * n[0] + (fy - py) * n[1], foot, n, dist };
				}
			}
		}
		prev = cur;
	}
	return best ? { off: best.off, foot: best.foot, n: best.n } : null;
}

/** The junction in `js` that best matches `ref` (image position at cam + depths), or null. */
export function matchJunction(
	ref: Junction,
	js: Junction[],
	cam: CameraX,
	maxPx = 40,
	maxLogD = 0.25,
): Junction | null {
	const [W, H] = px1600(cam);
	const p0 = projectX(cam, ref.worldNear);
	if (!p0) return null;
	let best: Junction | null = null;
	let bd = Infinity;
	for (const j of js) {
		if (Math.abs(Math.log(j.nearD / ref.nearD)) > maxLogD) continue;
		if (
			Number.isFinite(ref.farD) &&
			Number.isFinite(j.farD) &&
			Math.abs(Math.log(j.farD / ref.farD)) > 2 * maxLogD
		)
			continue;
		const p = projectX(cam, j.worldNear);
		if (!p) continue;
		const d = Math.hypot((p.u - p0.u) * W, (p.v - p0.v) * H);
		if (d < bd && d <= maxPx) {
			bd = d;
			best = j;
		}
	}
	return best;
}

type Lin = {
	/** Foot points and normals at the anchor eye; g = ∂offset/∂(E,N,U). */
	near: { W: Vec3; g: [number, number, number] } | null;
	far: { W: Vec3; g: [number, number, number] } | null;
};

/**
 * Junction factor. `predictAt(eye)` must return the junctions predicted from `eye` (e.g.
 * predictJunctions(layeredHorizon(h, eye, sector), camAt(eye))); `base` is the MapProblem base camera.
 * Call relinearize(x0) before the first residual (the constructor linearises at the measured
 * junctions with g = 0).
 */
export function junctionFactor(
	obs: JunctionObs[],
	predictAt: (eye: Vec3) => Promise<Junction[]>,
	base: CameraX,
	o: JunctionFactorOpts = {},
): Factor & { anchor: () => Vec3 | null; active: () => number } {
	const mode = o.mode ?? "diff";
	const fd = o.fdM ?? 5;
	const used = obs.filter(
		(b) =>
			b.near &&
			b.far &&
			(mode === "pair" || Number.isFinite(b.r)) &&
			Number.isFinite(b.sigmaNear),
	);
	const dim = mode === "pair" ? 2 * used.length : used.length;
	let e0: Vec3 | null = null;
	let key = "";
	let lins: Lin[] = used.map((b) => {
		const cam = base;
		const a = offsetToLine(cam, b.j.nearLine, b.near as ContourObs);
		const c = offsetToLine(cam, b.j.farLine, b.far as ContourObs);
		return {
			near: a ? { W: a.foot, g: [0, 0, 0] } : null,
			far: c ? { W: c.foot, g: [0, 0, 0] } : null,
		};
	});

	const offsetAt = (
		cam: CameraX,
		W: Vec3,
		ob: ContourObs,
		g: [number, number, number],
		de: Vec3,
	) => {
		const [Wp, Hp] = px1600(cam);
		const p = projectX(cam, W);
		if (!p) return Number.NaN;
		const off = (p.u * Wp - ob.u * Wp) * ob.nx + (p.v * Hp - ob.v * Hp) * ob.ny;
		return off + g[0] * de[0] + g[1] * de[1] + g[2] * de[2];
	};

	const residual = (x: GeoState): Float64Array => {
		const r = new Float64Array(dim).fill(Number.NaN);
		const anchor = e0 ?? base.eye;
		const cam = cameraXFromState(base, x);
		const camA: CameraX = { ...cam, eye: [anchor[0], anchor[1], anchor[2]] };
		const de: Vec3 = [
			x[IDX.E] - anchor[0],
			x[IDX.N] - anchor[1],
			x[IDX.U] - anchor[2],
		];
		used.forEach((b, i) => {
			const L = lins[i];
			const oN = L.near
				? offsetAt(camA, L.near.W, b.near as ContourObs, L.near.g, de)
				: Number.NaN;
			const oF = L.far
				? offsetAt(camA, L.far.W, b.far as ContourObs, L.far.g, de)
				: Number.NaN;
			if (mode === "pair") {
				r[2 * i] = oN / b.sigmaNear;
				r[2 * i + 1] = oF / b.sigmaFar;
			} else {
				const c = b.j.nNear[0] * b.j.nFar[0] + b.j.nNear[1] * b.j.nFar[1];
				r[i] = (oF - oN / c) / b.sigmaR;
			}
		});
		return r;
	};

	const relinearize = async (x: GeoState): Promise<void> => {
		const eye: Vec3 = [x[IDX.E], x[IDX.N], x[IDX.U]];
		const k = eye.map((v) => v.toFixed(3)).join(",");
		if (k === key) return;
		const cam = cameraXFromState(base, x);
		const at = (e: Vec3): CameraX => ({ ...cam, eye: e });
		const js0 = await predictAt(eye);
		const fdJs: Junction[][] = [];
		for (let a = 0; a < 3; a++)
			for (const s of [1, -1]) {
				const e: Vec3 = [eye[0], eye[1], eye[2]];
				e[a] += s * fd;
				fdJs.push(await predictAt(e));
			}
		lins = used.map((b) => {
			const j = matchJunction(b.j, js0, at(eye), o.matchPx, o.matchLogD);
			if (!j) return { near: null, far: null };
			const one = (which: "near" | "far") => {
				const ob = (which === "near" ? b.near : b.far) as ContourObs;
				const line = (jj: Junction) =>
					which === "near" ? jj.nearLine : jj.farLine;
				const a0 = offsetToLine(at(eye), line(j), ob);
				if (!a0) return null;
				const g: [number, number, number] = [0, 0, 0];
				for (let a = 0; a < 3; a++) {
					const ep: Vec3 = [eye[0], eye[1], eye[2]];
					const em: Vec3 = [eye[0], eye[1], eye[2]];
					ep[a] += fd;
					em[a] -= fd;
					const jp = matchJunction(
						j,
						fdJs[2 * a],
						at(ep),
						o.matchPx,
						o.matchLogD,
					);
					const jm = matchJunction(
						j,
						fdJs[2 * a + 1],
						at(em),
						o.matchPx,
						o.matchLogD,
					);
					const op = jp ? offsetToLine(at(ep), line(jp), ob) : null;
					const om = jm ? offsetToLine(at(em), line(jm), ob) : null;
					if (op && om) g[a] = (op.off - om.off) / (2 * fd);
					else if (op) g[a] = (op.off - a0.off) / fd;
					else if (om) g[a] = (a0.off - om.off) / fd;
				}
				return { W: a0.foot, g };
			};
			return { near: one("near"), far: one("far") };
		});
		e0 = eye;
		key = k;
	};

	return {
		family: "junction",
		name: `junction:${mode}:${used.length}`,
		dim,
		loss: o.loss ?? { kind: "cauchy", c: 2 },
		residual,
		nEff: o.nEff,
		relinearize,
		anchor: () => e0,
		active: () => lins.filter((l) => l.near && l.far).length,
	};
}
