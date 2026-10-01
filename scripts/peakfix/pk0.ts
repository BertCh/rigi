/**
 * PEAKFIX PK0 observability (tools/research/peakfix/PROTOCOL.txt): CRLB of the eye (E, N) jointly with rotation +
 * focal at the GT pose, from (a) the dense skyline, (b) skyline peaks, (c) ORACLE layered peaks (top crest per
 * azimuth in distance layers <1, 1–3, 3–10, 10–30, >30 km). σ 1.5 px. Derivatives by central differences
 * (eye ±5 m re-marched; rotation/focal analytic-free small steps). DEV GT photos only.
 *
 *   npx tsx scripts/peakfix/pk0.ts [IMG_xxxx ...]
 */
import path from "node:path";
import { camOf, type Obs, type Params, projectAzEl } from "../../src/lib/peakfix/fit";
import { layeredHorizon } from "../../src/lib/peakfix/layered";
import { horizonPeaks, profilePeaks, type WorldPeak } from "../../src/lib/peakfix/peaks";
import type { EyeHorizon } from "../../src/lib/pose6dof/eye";
import {
	devGTPhotos,
	FastSampler,
	halfDiagFovDeg,
	heightFnOf,
	photoSetup,
	writeJson,
} from "../geocam/lib";
import { D_MIN, sectorHorizonFrom } from "./lib-pk";

const SIGMA = 1.5;
const DE = 5;
const LAYERS = [0, 1000, 3000, 10000, 30000, Infinity];
const PROM_PX = 6;

function inv(M: number[][]): number[][] | null {
	const n = M.length;
	const A = M.map((r, i) => [...r, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
		if (Math.abs(A[p][c]) < 1e-14) return null;
		[A[c], A[p]] = [A[p], A[c]];
		const d = A[c][c];
		for (let k = 0; k < 2 * n; k++) A[c][k] /= d;
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const f = A[r][c];
			if (f) for (let k = 0; k < 2 * n; k++) A[r][k] -= f * A[c][k];
		}
	}
	return A.map((r) => r.slice(n));
}

/** CRLB σ (m) of E, N and horizontal, from Jacobian rows (px per unit of [yaw,pitch,roll,lnf,E,N]). */
function crlb(rows: number[][]) {
	const F = Array.from({ length: 6 }, () => new Array(6).fill(0));
	for (const r of rows)
		for (let a = 0; a < 6; a++) for (let b = 0; b < 6; b++) F[a][b] += (r[a] * r[b]) / (SIGMA * SIGMA);
	const C = inv(F);
	if (!C || C[4][4] < 0 || C[5][5] < 0) return { sE: Infinity, sN: Infinity, sH: Infinity, n: rows.length };
	// rotation-known variant: eye block of F alone
	const Fe = [
		[F[4][4], F[4][5]],
		[F[5][4], F[5][5]],
	];
	const Ce = inv(Fe);
	return {
		sE: Math.sqrt(C[4][4]),
		sN: Math.sqrt(C[5][5]),
		sH: Math.sqrt(C[4][4] + C[5][5]),
		sHrotKnown: Ce ? Math.sqrt(Ce[0][0] + Ce[1][1]) : Infinity,
		n: rows.length,
	};
}

const photos = devGTPhotos(process.argv.slice(2));
const out: Record<string, unknown> = {};
for (const photo of photos) {
	const P = await photoSetup(photo, { start: "gt" });
	const fs_ = new FastSampler(P.t);
	const hf = heightFnOf(P.s, P.t);
	const aspect = P.gt.aspect;
	const W = aspect >= 1 ? 1600 : 1600 * aspect;
	const H = aspect >= 1 ? 1600 / aspect : 1600;
	const obs: Obs = { W, H, vfov: P.gt.pose.vfov, samples: [], peaks: [] };
	const p0: Params = [P.gt.pose.yaw, P.gt.pose.pitch, P.gt.pose.roll, Math.log(P.gt.intr.fScale)];
	const ppd = camOf(p0, obs).f * (Math.PI / 180);
	const halfAz = halfDiagFovDeg(P.gt) + 3;
	const A0 = (((P.gt.pose.yaw - halfAz) % 360) + 360) % 360;
	const A1 = A0 + 2 * halfAz;
	const h0 = -P.ground(0, 0);
	const eyeAt = (e: number, n: number): [number, number, number] => [e, n, P.ground(e, n) + h0];
	const hz = (e: number, n: number) => sectorHorizonFrom(P.s, fs_, eyeAt(e, n), A0, A1);
	const pk = (h: EyeHorizon) =>
		horizonPeaks(h, A0, A1, { minPromDeg: PROM_PX / ppd, windowDeg: 60 / ppd });
	const PSTEP: Params = [0.01, 0.01, 0.01, 1e-4];
	const inFrame = (q: [number, number] | null) => !!q && q[0] >= 0 && q[0] <= W && q[1] >= 0 && q[1] <= H;

	// --- (a) dense: skyline y at fixed x columns
	const yAtX = (h: EyeHorizon, p: Params) => {
		const c = camOf(p, obs);
		const pts: [number, number][] = [];
		const n = h.elevation.length;
		for (let k = Math.ceil(A0 / h.step); k <= Math.floor(A1 / h.step); k++) {
			const el = h.elevation[((k % n) + n) % n];
			if (el <= -89) continue;
			const q = projectAzEl(c, k * h.step, el);
			if (q) pts.push(q);
		}
		pts.sort((a, b) => a[0] - b[0]);
		const ys: number[] = [];
		let j = 0;
		for (let x = 1; x < W; x += 2) {
			while (j < pts.length - 2 && pts[j + 1][0] < x) j++;
			const [xa, ya] = pts[j];
			const [xb, yb] = pts[j + 1];
			ys.push(xa <= x && x <= xb ? ya + ((yb - ya) * (x - xa)) / Math.max(1e-9, xb - xa) : Number.NaN);
		}
		return ys;
	};
	const H00 = hz(0, 0);
	const hE = [hz(DE, 0), hz(-DE, 0)];
	const hN = [hz(0, DE), hz(0, -DE)];
	const y0 = yAtX(H00, p0);
	const dCols: number[][] = [];
	for (let k = 0; k < 4; k++) {
		const pp = [...p0] as Params;
		const pm = [...p0] as Params;
		pp[k] += PSTEP[k];
		pm[k] -= PSTEP[k];
		const a = yAtX(H00, pp);
		const b = yAtX(H00, pm);
		dCols.push(a.map((v, i) => (v - b[i]) / (2 * PSTEP[k])));
	}
	for (const [hp, hm] of [hE, hN]) {
		const a = yAtX(hp, p0);
		const b = yAtX(hm, p0);
		dCols.push(a.map((v, i) => (v - b[i]) / (2 * DE)));
	}
	const denseRows: number[][] = [];
	let denseJumps = 0;
	for (let i = 0; i < y0.length; i++) {
		if (!Number.isFinite(y0[i]) || y0[i] < 0 || y0[i] > H) continue;
		const r = dCols.map((c) => c[i]);
		if (r.some((v) => !Number.isFinite(v))) continue;
		// discontinuity (skyline switches ridge between ±5 m): not a smooth measurement
		if (Math.abs(r[4]) * DE > 10 || Math.abs(r[5]) * DE > 10) {
			denseJumps++;
			continue;
		}
		denseRows.push(r);
	}

	// --- peaks: (x, y) rows with matching by azimuth across perturbed eyes
	const peakRows = (base: WorldPeak[], perturbed: WorldPeak[][]) => {
		const c0 = camOf(p0, obs);
		const rows: number[][] = [];
		const used: WorldPeak[] = [];
		for (const m of base) {
			const q0 = projectAzEl(c0, m.az, m.el);
			if (!inFrame(q0) || m.prom * ppd < PROM_PX) continue;
			const twins = perturbed.map((ps) => {
				let best: WorldPeak | null = null;
				for (const t of ps)
					if (Math.abs(t.az - m.az) < 0.3 && Math.abs(t.el - m.el) < 0.3 && (!best || Math.abs(t.az - m.az) < Math.abs(best.az - m.az)))
						best = t;
				return best;
			});
			if (twins.some((t) => !t)) continue;
			const rx: number[] = [];
			const ry: number[] = [];
			for (let k = 0; k < 4; k++) {
				const pp = [...p0] as Params;
				const pm = [...p0] as Params;
				pp[k] += PSTEP[k];
				pm[k] -= PSTEP[k];
				const a = projectAzEl(camOf(pp, obs), m.az, m.el)!;
				const b = projectAzEl(camOf(pm, obs), m.az, m.el)!;
				rx.push((a[0] - b[0]) / (2 * PSTEP[k]));
				ry.push((a[1] - b[1]) / (2 * PSTEP[k]));
			}
			for (let j = 0; j < 2; j++) {
				const a = projectAzEl(c0, twins[2 * j]!.az, twins[2 * j]!.el)!;
				const b = projectAzEl(c0, twins[2 * j + 1]!.az, twins[2 * j + 1]!.el)!;
				rx.push((a[0] - b[0]) / (2 * DE));
				ry.push((a[1] - b[1]) / (2 * DE));
			}
			rows.push(rx, ry);
			used.push(m);
		}
		return { rows, used };
	};
	const sky = peakRows(pk(H00), [...hE, ...hN].map(pk));

	// --- (c) oracle layered peaks
	const layered = (e: number, n: number) => {
		const L = layeredHorizon(hf, eyeAt(e, n), [A0, A1], { minD: D_MIN });
		// per layer: highest crest per azimuth whose distance is in the band
		return LAYERS.slice(0, -1).map((lo, li) => {
			const hi = LAYERS[li + 1];
			const el = new Float64Array(L.crests.length).fill(Number.NaN);
			const d = new Float64Array(L.crests.length);
			L.crests.forEach((cs, i) => {
				for (const c of cs)
					if (c.d >= lo && c.d < hi && !(c.el <= el[i])) {
						el[i] = c.el;
						d[i] = c.d;
					}
			});
			const win = Math.max(3, Math.round(60 / ppd / L.step));
			return profilePeaks(el, { minProm: (PROM_PX * 0.6) / ppd, window: win }).map((p) => ({
				az: L.az0 + p.i * L.step,
				el: p.value,
				d: d[Math.round(p.i)],
				prom: p.prom,
				layer: li,
			}));
		});
	};
	const lay0 = layered(0, 0);
	const layP = [layered(DE, 0), layered(-DE, 0), layered(0, DE), layered(0, -DE)];
	const layRows: number[][] = [];
	const layUsed: (WorldPeak & { layer: number })[] = [];
	for (let li = 0; li < LAYERS.length - 1; li++) {
		const r = peakRows(lay0[li], layP.map((l) => l[li]));
		layRows.push(...r.rows);
		layUsed.push(...r.used.map((u) => ({ ...u, layer: li })));
	}
	const band = (d: number) => LAYERS.findIndex((lo, i) => d >= lo && d < LAYERS[i + 1]);
	const hist = (ps: WorldPeak[]) => {
		const h = [0, 0, 0, 0, 0];
		for (const p of ps) h[band(p.d)]++;
		return h;
	};
	const res = {
		hAcc: P.meta.hAcc,
		dense: { ...crlb(denseRows), jumps: denseJumps },
		skyPeaks: { ...crlb(sky.rows), nPeaks: sky.used.length, hist: hist(sky.used), d: sky.used.map((u) => Math.round(u.d)) },
		densePlusSkyPeaks: crlb([...denseRows, ...sky.rows]),
		layeredPeaks: { ...crlb(layRows), nPeaks: layUsed.length, hist: hist(layUsed) },
		layeredPlusSky: crlb([...denseRows, ...sky.rows, ...layRows]),
	};
	out[photo] = res;
	const f = (x: number) => (Number.isFinite(x) ? x.toFixed(1).padStart(7) : "    inf");
	console.log(
		photo,
		`dense σH ${f(res.dense.sH)}`,
		`| skyPk σH ${f(res.skyPeaks.sH)} n${res.skyPeaks.nPeaks} [${res.skyPeaks.hist}]`,
		`| d+pk ${f(res.densePlusSkyPeaks.sH)}`,
		`| layPk σH ${f(res.layeredPeaks.sH)} n${res.layeredPeaks.nPeaks} [${res.layeredPeaks.hist}]`,
		`| all ${f(res.layeredPlusSky.sH)}`,
	);
}
writeJson(path.join("out", "peakfix", "pk0.json"), out);
