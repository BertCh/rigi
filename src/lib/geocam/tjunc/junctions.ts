// T-junction prediction (GA3): where a far silhouette ends under (is occluded by) a near one.
//
// Crests of a LayeredHorizon are linked column to column into polylines by depth and elevation
// continuity (greedy, cheapest first). A polyline end that is not the sector edge is a T-junction when
// the next column holds a nearer crest (depth ratio ≥ `ratio`) at or above the far line's extrapolated
// elevation: the near ridge has risen over the far contour. The junction J is where the two lines cross
// (linear in azimuth between the two columns). Everything the measurement and the factor need is kept
// in world coordinates (near/far contour sample points), so a junction can be re-projected under any
// rotation or focal without re-marching; only the eye requires a new layeredHorizon.
//
// Image units: isotropic px @1600 (long side 1600), x right, y down; normals point toward increasing
// elevation (from the occluder into what it hides, as concord/cues/contours.ts).
import {
	type CameraX,
	projectX,
	unprojectDirX,
	type Vec3,
} from "../../concord/core";
import { focal1600 } from "../../concord/cues/contours";
import type { GeomBuffer } from "../../concord/cues/types";
import type { Crest, LayeredHorizon } from "./layered";

const DEG = Math.PI / 180;

export type Junction = {
	/** Photo uv (0..1, v down) of J at the camera it was predicted for. */
	u: number;
	v: number;
	/** Azimuth / elevation of J from the eye (deg). */
	az: number;
	el: number;
	/** Horizontal distances of the occluding (near) and occluded (far) contours at J (m). */
	nearD: number;
	farD: number;
	/** Unit image normals (px @1600, x right / y down), pointing toward increasing elevation. */
	nNear: [number, number];
	nFar: [number, number];
	/** Angle between the two contours at J (deg, 0..90). */
	angleDeg: number;
	worldNear: Vec3;
	worldFar: Vec3;
	/** px @1600 by which 10 m of lateral eye motion moves the near contour relative to the far one: f·10·(1/nearD − 1/farD). */
	pxPer10m: number;
	/** Additive: the far contour is the skyline (sky right above it). */
	farSky: boolean;
	/** Additive: which side of J (along the near contour's tangent, +1 / −1) the far contour is visible on. */
	farSide: 1 | -1;
	/** Additive: world points on the near contour at arc offsets ±`sampleOffsetsPx` from J (both sides). */
	nearPts: Vec3[];
	/** Additive: world points on the far contour at arc offsets `sampleOffsetsPx` from J (visible side). */
	farPts: Vec3[];
	/** Additive: longer world polylines of the two contours around J (point-to-curve residuals). */
	nearLine: Vec3[];
	farLine: Vec3[];
};

export type JunctionOpts = {
	/** Minimum depth ratio far/near for an occlusion. Default 1.3 (contours.ts). */
	ratio?: number;
	/** Linking: max |ln(d_b/d_a)| between neighbouring columns. Default 0.12. */
	dLinkTol?: number;
	/** Linking: max elevation change between neighbouring columns (deg). Default 1.5. */
	elLinkTol?: number;
	/** Keep junctions with nearD in [minNearD, maxNearD] (m). Defaults 0 / 3000. */
	minNearD?: number;
	maxNearD?: number;
	/** Keep junctions with crossing angle ≥ this (deg). Default 20. */
	minAngleDeg?: number;
	/** Keep junctions at least this far inside the frame (px @1600). Default 16. */
	marginPx?: number;
	/** Arc offsets (px @1600) of the contour samples. Default [4, 8, 12]. */
	sampleOffsetsPx?: number[];
	/** Half-length of nearLine / farLine (px @1600). Default 30. */
	lineHalfPx?: number;
	/** Merge junctions closer than this (px @1600) with similar near depth, keeping the widest crossing. Default 10. */
	mergePx?: number;
};

type Line = { cols: number[]; cr: Crest[] };

/** Link crests into polylines. Returns lines and, per column, the line index of each crest. */
export function linkCrests(
	lh: LayeredHorizon,
	o: JunctionOpts = {},
): { lines: Line[]; lineOf: Int32Array[] } {
	const dTol = o.dLinkTol ?? 0.12;
	const elTol = o.elLinkTol ?? 1.5;
	const lines: Line[] = [];
	const lineOf = lh.crests.map((c) => new Int32Array(c.length).fill(-1));
	for (let i = 0; i < lh.crests.length; i++) {
		const cur = lh.crests[i];
		if (i > 0) {
			const prev = lh.crests[i - 1];
			const pairs: { a: number; b: number; c: number }[] = [];
			for (let a = 0; a < prev.length; a++)
				for (let b = 0; b < cur.length; b++) {
					const dd = Math.abs(Math.log(cur[b].d / prev[a].d)) / dTol;
					const de = Math.abs(cur[b].el - prev[a].el) / elTol;
					if (dd <= 1 && de <= 1) pairs.push({ a, b, c: dd + de });
				}
			pairs.sort((x, y) => x.c - y.c);
			const usedA = new Uint8Array(prev.length);
			for (const p of pairs) {
				if (usedA[p.a] || lineOf[i][p.b] >= 0) continue;
				const L = lineOf[i - 1][p.a];
				if (L < 0) continue;
				usedA[p.a] = 1;
				lineOf[i][p.b] = L;
				lines[L].cols.push(i);
				lines[L].cr.push(cur[p.b]);
			}
		}
		for (let b = 0; b < cur.length; b++)
			if (lineOf[i][b] < 0) {
				lineOf[i][b] = lines.length;
				lines.push({ cols: [i], cr: [cur[b]] });
			}
	}
	return { lines, lineOf };
}

/** Azimuth sector [a0, a1] (deg, a1 > a0) covering the camera's frame plus `marginDeg`. */
export function sectorOf(cam: CameraX, marginDeg = 2): [number, number] {
	const yaw = cam.pose.yaw;
	let lo = Infinity;
	let hi = -Infinity;
	for (let k = 0; k <= 8; k++)
		for (const [u, v] of [
			[k / 8, 0],
			[k / 8, 1],
			[0, k / 8],
			[1, k / 8],
		]) {
			const d = unprojectDirX(cam, u, v);
			let r = Math.atan2(d[0], d[1]) / DEG - yaw;
			r = ((((r + 180) % 360) + 360) % 360) - 180;
			lo = Math.min(lo, r);
			hi = Math.max(hi, r);
		}
	return [yaw + lo - marginDeg, yaw + hi + marginDeg];
}

/** Isotropic px @1600 of a photo uv. */
const toPx = (cam: CameraX, u: number, v: number): [number, number] => {
	const L = 1600;
	const W = cam.aspect >= 1 ? L : L * cam.aspect;
	const H = cam.aspect >= 1 ? L / cam.aspect : L;
	return [u * W, v * H];
};

const lerp3 = (a: Vec3, b: Vec3, s: number): Vec3 => [
	a[0] + (b[0] - a[0]) * s,
	a[1] + (b[1] - a[1]) * s,
	a[2] + (b[2] - a[2]) * s,
];

/**
 * Walk a polyline (world points, ordered away from J) from J and return the world points at the given
 * image arc lengths (px @1600). Points behind the camera end the walk.
 */
function pointsAtArc(
	cam: CameraX,
	start: Vec3,
	pts: Vec3[],
	arcs: number[],
): Vec3[] {
	const out: Vec3[] = [];
	const p0 = projectX(cam, start);
	if (!p0) return out;
	let prevW = start;
	let prevP = toPx(cam, p0.u, p0.v);
	let acc = 0;
	let k = 0;
	const want = [...arcs].sort((a, b) => a - b);
	for (const w of pts) {
		const p = projectX(cam, w);
		if (!p) break;
		const q = toPx(cam, p.u, p.v);
		const seg = Math.hypot(q[0] - prevP[0], q[1] - prevP[1]);
		while (k < want.length && acc + seg >= want[k]) {
			const s = seg > 0 ? (want[k] - acc) / seg : 0;
			out.push(lerp3(prevW, w, s));
			k++;
		}
		if (k >= want.length) break;
		acc += seg;
		prevW = w;
		prevP = q;
	}
	return out;
}

/** Unit image tangent (px @1600) of a polyline through world points a → b. */
function imgDir(cam: CameraX, a: Vec3, b: Vec3): [number, number] | null {
	const pa = projectX(cam, a);
	const pb = projectX(cam, b);
	if (!pa || !pb) return null;
	const A = toPx(cam, pa.u, pa.v);
	const B = toPx(cam, pb.u, pb.v);
	const dx = B[0] - A[0];
	const dy = B[1] - A[1];
	const n = Math.hypot(dx, dy);
	return n > 1e-9 ? [dx / n, dy / n] : null;
}

/** Image direction (px @1600) of increasing elevation at world point w seen from eye. */
function upDir(cam: CameraX, eye: Vec3, w: Vec3): [number, number] | null {
	const d = Math.hypot(w[0] - eye[0], w[1] - eye[1]);
	return imgDir(cam, w, [w[0], w[1], w[2] + d * 0.002]);
}

/** Normal of a tangent, oriented toward `up`. */
function normalToward(
	t: [number, number],
	up: [number, number],
): [number, number] {
	const n: [number, number] = [-t[1], t[0]];
	return n[0] * up[0] + n[1] * up[1] >= 0 ? n : [-n[0], -n[1]];
}

/**
 * T-junctions of a layered horizon, projected at `cam` (whose eye should be lh.eye). Returned in
 * azimuth order.
 */
export function predictJunctions(
	lh: LayeredHorizon,
	cam: CameraX,
	o: JunctionOpts = {},
): Junction[] {
	const ratio = o.ratio ?? 1.3;
	const minNear = o.minNearD ?? 0;
	const maxNear = o.maxNearD ?? 3000;
	const minAng = o.minAngleDeg ?? 20;
	const margin = o.marginPx ?? 16;
	const offs = o.sampleOffsetsPx ?? [4, 8, 12];
	const lineHalf = o.lineHalfPx ?? 30;
	const f = focal1600(cam);
	const eye = lh.eye;
	const { lines, lineOf } = linkCrests(lh, o);
	const nCol = lh.crests.length;
	const [W, H] = toPx(cam, 1, 1);
	const out: Junction[] = [];

	const crestOf = (L: Line, col: number): Crest | null => {
		const k = L.cols.indexOf(col);
		return k >= 0 ? L.cr[k] : null;
	};
	const dirAt = (az: number, el: number, d: number): Vec3 => [
		eye[0] + d * Math.sin(az * DEG),
		eye[1] + d * Math.cos(az * DEG),
		eye[2] + d * Math.tan(el * DEG),
	];

	for (const far of lines) {
		for (const end of [1, -1] as const) {
			// end = +1: the far line's last column; −1: its first column
			const k = end === 1 ? far.cols.length - 1 : 0;
			const i = far.cols[k];
			const j = i + end;
			if (j < 0 || j >= nCol) continue;
			const fc = far.cr[k];
			// extrapolated far elevation at column j (slope from the previous point on the line)
			const k2 = k - end;
			const slope =
				k2 >= 0 && k2 < far.cr.length
					? (fc.el - far.cr[k2].el) / (far.cols[k] - far.cols[k2])
					: 0;
			const elX = fc.el + slope * end;
			// occluder: the farthest crest in column j nearer than fc.d / ratio (the highest such crest)
			const col = lh.crests[j];
			let oc = -1;
			for (let b = 0; b < col.length; b++) if (col[b].d * ratio <= fc.d) oc = b;
			if (oc < 0 || col[oc].el < elX - 0.02) continue;
			const nc = col[oc];
			if (nc.d < minNear || nc.d > maxNear) continue;
			const near = lines[lineOf[j][oc]];
			// crossing between columns i and j: f(i) = far − near > 0, f(j) = farX − near ≤ 0
			const ni = crestOf(near, i);
			const fi = ni ? fc.el - ni.el : 0;
			const fj = elX - nc.el;
			const s = ni && fi > 0 && fj <= 0 ? fi / (fi - fj) : 0.5;
			const az = lh.az0 + (i + s * end) * lh.step;
			const el = ni ? ni.el + (nc.el - ni.el) * s : nc.el;
			const nearD = ni ? ni.d + (nc.d - ni.d) * s : nc.d;
			const farD = fc.d;
			const worldNear = dirAt(az, el, nearD);
			const worldFar = dirAt(az, el, farD);
			const pJ = projectX(cam, worldNear);
			if (!pJ) continue;
			const [x, y] = toPx(cam, pJ.u, pJ.v);
			if (x < margin || y < margin || x > W - margin || y > H - margin)
				continue;

			// contour polylines ordered away from J: far goes back into its line; near both ways
			const kn = near.cols.indexOf(j);
			const farBack =
				end === 1 ? far.cr.slice(0, k + 1).reverse() : far.cr.slice(k);
			const nearToward =
				end === 1 ? near.cr.slice(kn) : near.cr.slice(0, kn + 1).reverse();
			const nearAwayFull =
				end === 1 ? near.cr.slice(0, kn).reverse() : near.cr.slice(kn + 1);
			const w = (c: Crest) => c.world;
			const nA = pointsAtArc(cam, worldNear, nearToward.map(w), offs);
			const nB = pointsAtArc(cam, worldNear, nearAwayFull.map(w), offs);
			const fA = pointsAtArc(cam, worldFar, farBack.map(w), offs);
			// complete samples only: short line fragments give unstable tangents
			if (
				nA.length < offs.length ||
				nB.length < offs.length ||
				fA.length < offs.length
			)
				continue;
			const tN = imgDir(cam, nB[nB.length - 1], nA[nA.length - 1]);
			const tF = imgDir(cam, worldFar, fA[fA.length - 1]);
			const upN = upDir(cam, eye, worldNear);
			const upF = upDir(cam, eye, worldFar);
			if (!tN || !tF || !upN || !upF) continue;
			const cosA = Math.abs(tN[0] * tF[0] + tN[1] * tF[1]);
			const angleDeg = Math.acos(Math.min(1, cosA)) / DEG;
			if (angleDeg < minAng) continue;
			const nNear = normalToward(tN, upN);
			const nFar = normalToward(tF, upF);
			// which way along tN (nB → nA, i.e. toward column j) the far contour lies
			const farSide = tF[0] * tN[0] + tF[1] * tN[1] >= 0 ? 1 : -1;
			const nlA = pointsAtArc(cam, worldNear, nearToward.map(w), [
				lineHalf / 3,
				(2 * lineHalf) / 3,
				lineHalf,
			]);
			const nlB = pointsAtArc(cam, worldNear, nearAwayFull.map(w), [
				lineHalf / 3,
				(2 * lineHalf) / 3,
				lineHalf,
			]);
			const flA = pointsAtArc(cam, worldFar, farBack.map(w), [
				lineHalf / 3,
				(2 * lineHalf) / 3,
				lineHalf,
			]);
			out.push({
				u: pJ.u,
				v: pJ.v,
				az,
				el,
				nearD,
				farD,
				nNear,
				nFar,
				angleDeg,
				worldNear,
				worldFar,
				pxPer10m: f * 10 * (1 / nearD - (Number.isFinite(farD) ? 1 / farD : 0)),
				farSky: fc.sky,
				farSide: farSide as 1 | -1,
				nearPts: [...nB, ...nA],
				farPts: fA,
				nearLine: [...[...nlB].reverse(), worldNear, ...nlA],
				farLine: [worldFar, ...flA],
			});
		}
	}
	// merge duplicates (fragmented far lines ending under the same near contour)
	const mergePx = o.mergePx ?? 10;
	out.sort((a, b) => b.angleDeg - a.angleDeg);
	const kept: Junction[] = [];
	for (const j of out)
		if (
			!kept.some(
				(k) =>
					Math.hypot((k.u - j.u) * W, (k.v - j.v) * H) < mergePx &&
					Math.abs(Math.log(k.nearD / j.nearD)) < 0.1,
			)
		)
			kept.push(j);
	kept.sort((a, b) => a.az - b.az);
	return kept;
}

/**
 * Image-space variant: T-junctions from a GeomBuffer (buildGeomBuffer). A boundary pixel is a non-sky
 * pixel whose 8-neighbour is farther by more than `ratio` (contours.ts' rule) or is sky; a junction is a
 * cluster of boundary pixels of a farther occluder (range r_far) that touch boundary pixels of a nearer
 * one (r_near ≤ r_far/ratio). Normals come from the local range-jump direction. Returns the cluster
 * centres; `nearPts`/`farPts` are the boundary pixels' hits within 12 px @1600 of J.
 */
export function junctionsFromGeomBuffer(
	g: GeomBuffer,
	cam: CameraX,
	o: JunctionOpts = {},
): Junction[] {
	const { w, h, range, sky, xyz } = g;
	const ratio = o.ratio ?? 1.3;
	const maxNear = o.maxNearD ?? 3000;
	const minNear = o.minNearD ?? 0;
	const minAng = o.minAngleDeg ?? 20;
	const f = focal1600(cam);
	const toB = Math.max(w, h) / 1600;
	const eye = g.eye ?? cam.eye;
	const N = w * h;
	const nb8: [number, number][] = [
		[1, 0],
		[-1, 0],
		[0, 1],
		[0, -1],
		[1, 1],
		[1, -1],
		[-1, 1],
		[-1, -1],
	];
	const bnd = new Uint8Array(N);
	const nx = new Float32Array(N);
	const ny = new Float32Array(N);
	for (let y = 1; y < h - 1; y++)
		for (let x = 1; x < w - 1; x++) {
			const k = y * w + x;
			if (sky[k]) continue;
			let sx = 0;
			let sy = 0;
			for (const [dx, dy] of nb8) {
				const q = k + dy * w + dx;
				if (sky[q] || range[q] > range[k] * ratio) {
					sx += dx;
					sy += dy;
				}
			}
			if (sx !== 0 || sy !== 0) {
				bnd[k] = 1;
				const n = Math.hypot(sx, sy);
				nx[k] = sx / n;
				ny[k] = sy / n;
			}
		}
	// candidate far-contour pixels touching a nearer contour within 2 px
	const cand = new Uint8Array(N);
	const nearOf = new Int32Array(N).fill(-1);
	const R = 2;
	for (let y = R; y < h - R; y++)
		for (let x = R; x < w - R; x++) {
			const k = y * w + x;
			if (!bnd[k]) continue;
			for (let dy = -R; dy <= R; dy++)
				for (let dx = -R; dx <= R; dx++) {
					const q = k + dy * w + dx;
					if (bnd[q] && range[q] * ratio <= range[k] && range[q] <= maxNear) {
						cand[k] = 1;
						if (nearOf[k] < 0 || range[q] < range[nearOf[k]]) nearOf[k] = q;
					}
				}
		}
	// cluster candidates (8-conn) → one junction per cluster
	const seen = new Uint8Array(N);
	const out: Junction[] = [];
	const rad = Math.max(3, Math.round(12 * toB));
	for (let k0 = 0; k0 < N; k0++) {
		if (!cand[k0] || seen[k0]) continue;
		const st = [k0];
		seen[k0] = 1;
		const mem: number[] = [];
		while (st.length) {
			const c = st.pop() as number;
			mem.push(c);
			const cx = c % w;
			const cy = (c - cx) / w;
			for (const [dx, dy] of nb8) {
				const x2 = cx + dx;
				const y2 = cy + dy;
				if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
				const q = y2 * w + x2;
				if (cand[q] && !seen[q]) {
					seen[q] = 1;
					st.push(q);
				}
			}
		}
		let mx = 0;
		let my = 0;
		for (const c of mem) {
			mx += c % w;
			my += Math.floor(c / w);
		}
		mx /= mem.length;
		my /= mem.length;
		const kc = mem.reduce((a, c) =>
			Math.hypot((c % w) - mx, Math.floor(c / w) - my) <
			Math.hypot((a % w) - mx, Math.floor(a / w) - my)
				? c
				: a,
		);
		const kn = nearOf[kc];
		const rFar = range[kc];
		const rNear = range[kn];
		// local contour pixels of each layer around J (by range class)
		const nearPx: number[] = [];
		const farPx: number[] = [];
		const cx0 = kc % w;
		const cy0 = (kc - cx0) / w;
		for (let dy = -rad; dy <= rad; dy++)
			for (let dx = -rad; dx <= rad; dx++) {
				const x2 = cx0 + dx;
				const y2 = cy0 + dy;
				if (x2 < 0 || y2 < 0 || x2 >= w || y2 >= h) continue;
				const q = y2 * w + x2;
				if (!bnd[q]) continue;
				if (Math.abs(Math.log(range[q] / rNear)) < 0.1) nearPx.push(q);
				else if (Math.abs(Math.log(range[q] / rFar)) < 0.1) farPx.push(q);
			}
		if (nearPx.length < 3 || farPx.length < 3) continue;
		const tangent = (px: number[]): [number, number] => {
			let sx = 0;
			let sy = 0;
			for (const q of px) {
				sx += q % w;
				sy += Math.floor(q / w);
			}
			sx /= px.length;
			sy /= px.length;
			let a = 0;
			let b = 0;
			let c = 0;
			for (const q of px) {
				const dx = (q % w) - sx;
				const dy = Math.floor(q / w) - sy;
				a += dx * dx;
				b += dx * dy;
				c += dy * dy;
			}
			const th = 0.5 * Math.atan2(2 * b, a - c);
			return [Math.cos(th), Math.sin(th)];
		};
		const tN = tangent(nearPx);
		const tF = tangent(farPx);
		const angleDeg =
			Math.acos(Math.min(1, Math.abs(tN[0] * tF[0] + tN[1] * tF[1]))) / DEG;
		const hw = (q: number): Vec3 => [
			xyz[3 * q],
			xyz[3 * q + 1],
			xyz[3 * q + 2],
		];
		const dH = (q: number) => {
			const p = hw(q);
			return Math.hypot(p[0] - eye[0], p[1] - eye[1]);
		};
		const nearD = dH(kn);
		const farD = dH(kc);
		if (angleDeg < minAng || nearD < minNear || nearD > maxNear) continue;
		const avgN = (px: number[]): [number, number] => {
			let sx = 0;
			let sy = 0;
			for (const q of px) {
				sx += nx[q];
				sy += ny[q];
			}
			return [sx, sy];
		};
		const orient = (t: [number, number], a: [number, number]) =>
			(-t[1] * a[0] + t[0] * a[1] >= 0 ? [-t[1], t[0]] : [t[1], -t[0]]) as [
				number,
				number,
			];
		const nNear = orient(tN, avgN(nearPx));
		const nFar = orient(tF, avgN(farPx));
		const u = (kc % w) / w + 0.5 / w;
		const v = Math.floor(kc / w) / h + 0.5 / h;
		const fSide = (() => {
			let s = 0;
			for (const q of farPx)
				s += ((q % w) - cx0) * tN[0] + (Math.floor(q / w) - cy0) * tN[1];
			return s >= 0 ? 1 : -1;
		})();
		out.push({
			u,
			v,
			az: Math.atan2(hw(kc)[0] - eye[0], hw(kc)[1] - eye[1]) / DEG,
			el: 0,
			nearD,
			farD,
			nNear,
			nFar,
			angleDeg,
			worldNear: hw(kn),
			worldFar: hw(kc),
			pxPer10m: f * 10 * (1 / nearD - 1 / farD),
			farSky: false,
			farSide: fSide as 1 | -1,
			nearPts: nearPx.map(hw),
			farPts: farPx.map(hw),
			nearLine: nearPx.map(hw),
			farLine: farPx.map(hw),
		});
		void rFar;
	}
	return out;
}
