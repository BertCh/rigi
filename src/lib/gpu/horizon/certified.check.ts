// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check of the certified-f32 horizon stages (README.md "Certified f32"), on the CPU emulation of
// the f32 path (certified-cpu.ts: Math.fround, exact FMA). Exits 1 on any failure.
//
//   npx tsx src/lib/gpu/horizon/certified.check.ts [--many] [--all-real]
//
// 1. skylineDirsF64 (dirs-cpu.ts) is bit-identical to the worker's pre-move code (copied below).
// 2. Stage A (tan → elevation degrees): random t over all magnitudes, tan of random elevations, the
//    no-hit sentinel, ±0, subnormals, |t| > 2^100: 0 false certifications, finished output identical to
//    the f64 path.
// 3. Stages B + C (D8: ENU + 8192-column resample) on synthetic profiles (latitudes −70…75°, any
//    longitude, eye 0–4800 m, near ground, steep and negative elevations, no-hit gaps, ridge steps,
//    rare subnormal elevations / distances):
//    every tracked bound holds against the f64 path's own intermediates, 0 false certifications, the
//    finished dirs identical to the f64 path.
// 4. The same with division / sqrt perturbed by up to ±3 ULP (WGSL: 2.5 ULP division), and (4b) on a
//    machine that flushes subnormals to zero on every buffer load and every arithmetic result.
// 5. Teeth: with a 1e-9 relative error injected into every certified value (its bound unchanged), the
//    check must see false certifications.
// 6. DEM-derived profiles (out/gpu/horizon-cert/real-cases.json from scripts/gpu/horizon-cert-cases.ts)
//    when present; skipped otherwise.
// 7. The per-call spot check (certified.ts spotCheckA / spotCheckC) passes the emulation's outputs and
//    catches corrupted certified outputs.
// Reports the tie-path fractions (the share the CPU recomputes).
import fs from "node:fs";
import path from "node:path";
import {
	DEG,
	destination,
	EARTH_R,
	EnuFrame,
	REFRACTION_K,
	WGS84,
} from "#/lib/geodesy";
import {
	bits32,
	setDivSqrtPerturbation,
	setFlushSubnormals,
} from "../precision/df32";
import { spotCheckA, spotCheckC } from "./certified";
import {
	elevationF64,
	emuSkylineDirs,
	emuStageA,
	emuStageB,
	emuStageC,
	enuLump,
	enuLumpRel,
	FLAG_CERT,
	FLAG_SKIP,
	finishStageA,
	finishStageC,
	packAzimuths,
	packColumns,
	packConsts,
	packProfile,
	resetTieStats,
	SAMP_UNCERTAIN,
	SAMP_VALID,
	setFaultInjection,
	tieStats,
} from "./certified-cpu";
import {
	GPU_COLUMNS,
	SkylineF64,
	type SkylineJob,
	type SkylineProfile,
	skylineDirsF64,
} from "./dirs-cpu";

const MANY = process.argv.includes("--many");
const ALL_REAL = process.argv.includes("--all-real");
const t0 = performance.now();
let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.log(`FAIL ${msg}`);
};

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------- 1. the worker's pre-move code, verbatim ----------

const LEGACY_COLUMNS = (() => {
	const out: number[] = [];
	const t = Math.tan((25 * Math.PI) / 180);
	for (let r = 0; r < 8; r++)
		for (let x = 0; x < 1024; x++)
			out.push(
				(r * 45 +
					(Math.atan((((x + 0.5) / 1024) * 2 - 1) * t) * 180) / Math.PI +
					360) %
					360,
			);
	return out;
})();

function legacyDirs(
	prof: SkylineProfile,
	j: SkylineJob & { step: number },
	eyeH: number,
) {
	const step = j.step;
	const D = Math.PI / 180;
	const n = prof.elevation.length;
	const frame = new EnuFrame(j.lat, j.lon, 0);
	const inv2R = (1 - j.k) / (2 * EARTH_R);
	const az = new Float64Array(n);
	const el = new Float64Array(n);
	const v = [0, 0, 0];
	for (let i = 0; i < n; i++) {
		const a = (prof.i0 + i) * step;
		const d = prof.distance[i];
		const e0 = prof.elevation[i];
		if (!(e0 > -90) || !(d > 0)) {
			az[i] = a;
			el[i] = Number.NaN;
			continue;
		}
		const p = destination(j.lat, j.lon, a, d);
		frame.fromGeo(p.lat, p.lon, eyeH + d * (Math.tan(e0 * D) + d * inv2R), v);
		const z = v[2] - eyeH;
		const b = Math.atan2(v[0], v[1]) / D;
		az[i] = a + ((((b - a) % 360) + 540) % 360) - 180;
		el[i] = Math.atan2(z, Math.hypot(v[0], v[1])) / D;
	}
	const at = (m: number) => az[((m % n) + n) % n] + Math.floor(m / n) * 360;
	const out = new Float32Array(LEGACY_COLUMNS.length * 3);
	let k = 0;
	for (const c of LEGACY_COLUMNS) {
		let i = Math.floor(c / step);
		while (at(i) > c) i--;
		while (at(i + 1) <= c) i++;
		const e0 = el[((i % n) + n) % n];
		const e1 = el[(((i + 1) % n) + n) % n];
		if (Number.isNaN(e0) || Number.isNaN(e1)) continue;
		const t = Math.min(
			Math.max((c - at(i)) / Math.max(at(i + 1) - at(i), 1e-9), 0),
			1,
		);
		const e = (e0 + (e1 - e0) * t) * D;
		out[k++] = Math.sin(c * D) * Math.cos(e);
		out[k++] = Math.cos(c * D) * Math.cos(e);
		out[k++] = Math.sin(e);
	}
	return out.slice(0, k);
}

const sameBits = (a: Float32Array, b: Float32Array) => {
	if (a.length !== b.length) return false;
	const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
	const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
	for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
	return true;
};

// ---------- the f64 path's ENU error vs its lump ----------

/**
 * F's ENU vector (x east, y north, z = up − eyeH with the refraction lift) in plain f64 through the
 * same difference formulas as stage B (error ≈ 1e-16·d): the reference the f64 path's ECEF round trip
 * is measured against.
 */
function enuReference(
	lat: number,
	k: number,
	eyeH: number,
	azDeg: number,
	d: number,
	e0: number,
) {
	const { A, E2 } = WGS84;
	const p1 = lat * DEG;
	const sP = Math.sin(p1);
	const cP = Math.cos(p1);
	const a = azDeg * DEG;
	const sA = Math.sin(a);
	const cA = Math.cos(a);
	const inv2R = (1 - k) / (2 * EARTH_R);
	const hD = d * (Math.tan(e0 * DEG) + d * inv2R);
	const h2 = eyeH + hD;
	const D = d / EARTH_R;
	const sD = Math.sin(D);
	const hs = Math.sin(D / 2);
	const omc = 2 * hs * hs;
	const ds = cP * sD * cA - sP * omc;
	const s2 = sP + ds;
	const Y = sA * sD * cP;
	const X = cP * cP - omc - sP * ds;
	const rhoL = Math.hypot(X, Y);
	const sinDL = Y / rhoL;
	const omcDL = (Y * Y) / (rhoL * (rhoL + X));
	const c2 = Math.sqrt((1 - s2) * (1 + s2));
	const sPs2 = s2 + sP;
	const dc = -(ds * sPs2) / (c2 + cP);
	const rwo = Math.sqrt(1 - E2 * sP * sP);
	const rw2 = Math.sqrt(1 - E2 * s2 * s2);
	const No = A / rwo;
	const dN = (A * E2 * ds * sPs2) / (rw2 * rwo * (rwo + rw2));
	const dNh = dN + h2;
	const Q2c2 = (No + dNh) * c2;
	const P = dNh * c2 + No * dc - Q2c2 * omcDL;
	const ome2 = 1 - E2;
	const Zd = (dN * ome2 + h2) * s2 + No * ome2 * ds;
	const e = Q2c2 * sinDL;
	const n = -sP * P + cP * Zd;
	const u = cP * P + sP * Zd;
	const z = u + (REFRACTION_K * (e * e + n * n)) / (2 * EARTH_R) - eyeH;
	return { e, n, z, hD };
}

/** max over samples of |f64 path − reference| / lump, per ENU component. */
function lumpRatio(c: Case, every = 7) {
	const { prof, job, eyeH } = c;
	const frame = new EnuFrame(job.lat, job.lon, 0);
	const inv2R = (1 - job.k) / (2 * EARTH_R);
	const base = enuLump(job.lat, job.lon);
	const rel = enuLumpRel(job.lat, job.lon);
	const v = [0, 0, 0];
	let worst = 0;
	for (let i = 0; i < prof.elevation.length; i += every) {
		const e0 = prof.elevation[i];
		const d = prof.distance[i];
		if (!(e0 > -90) || !(d > 0)) continue;
		const a = (prof.i0 + i) * prof.step;
		const p = destination(job.lat, job.lon, a, d);
		frame.fromGeo(p.lat, p.lon, eyeH + d * (Math.tan(e0 * DEG) + d * inv2R), v);
		const r = enuReference(job.lat, job.k, eyeH, a, d, e0);
		// (the reference uses the f64 path's own Math.tan(e0·DEG), so the tan-argument term is not measured)
		const lump = base + rel * (Math.abs(eyeH) + Math.abs(r.hD) + d);
		const err = Math.max(
			Math.abs(v[0] - r.e),
			Math.abs(v[1] - r.n),
			Math.abs(v[2] - eyeH - r.z),
		);
		worst = Math.max(worst, err / lump);
	}
	return worst;
}

// ---------- synthetic cases ----------

type Case = {
	name: string;
	prof: SkylineProfile;
	job: SkylineJob;
	eyeH: number;
};

function synthCase(seed: number): Case {
	const r = rng(seed);
	const u = (a: number, b: number) => a + (b - a) * r();
	const step = [0.05, 0.05, 0.05, 0.1, 0.25][Math.floor(r() * 5)];
	const n = Math.round(360 / step);
	const lat = u(-70, 75);
	const lon = u(-180, 180);
	const eyeH = r() < 0.15 ? 0 : u(0, 4800);
	const k = [0.13, 0.13, 0, 0.2][Math.floor(r() * 4)];
	const elevation = new Float32Array(n);
	const distance = new Float32Array(n);
	const waves = Array.from({ length: 6 }, (_, j) => ({
		A: u(0.2, 4) / (j + 1),
		f: j + 1,
		p: u(0, 6.3),
	}));
	let segEl = u(-2, 6);
	let segD = Math.exp(u(Math.log(500), Math.log(150_000)));
	let segLeft = 0;
	const gap0 = r() < 0.5 ? Math.floor(u(0, n)) : -1;
	const gapLen = Math.floor(u(5, n / 20));
	for (let i = 0; i < n; i++) {
		if (segLeft-- <= 0) {
			segLeft = Math.floor(u(2, 120) / step);
			const kind = r();
			if (kind < 0.05) {
				// near ground: steep, a few metres away
				segEl = u(-30, 60);
				segD = u(2, 60);
			} else if (kind < 0.1) {
				segEl = u(-10, 45);
				segD = u(60, 3000);
			} else {
				segEl = u(-3, 8);
				segD = Math.exp(u(Math.log(800), Math.log(150_000)));
			}
		}
		const a = (i * step * Math.PI) / 180;
		let e = segEl;
		for (const w of waves) e += w.A * Math.sin(w.f * a + w.p) * 0.3;
		e += u(-0.02, 0.02);
		let d = segD * (1 + 0.05 * Math.sin(a * 7)) + u(-5, 5);
		d = Math.min(150_000, Math.max(2, d));
		if (gap0 >= 0 && (i - gap0 + n) % n < gapLen) {
			elevation[i] = -90;
			distance[i] = 0;
			continue;
		}
		elevation[i] = Math.max(-89, Math.min(89, e));
		distance[i] = d;
		// rare subnormal inputs: a flushing GPU would see 0 (they must reach the tie path)
		const q = r();
		if (q < 5e-4) elevation[i] = 1e-40;
		else if (q < 7e-4) distance[i] = 1e-42;
	}
	return {
		name: `synth#${seed}`,
		prof: { step, i0: 0, elevation, distance },
		job: { lat, lon, k },
		eyeH,
	};
}

// ---------- 2. stage A ----------

function stageACases(): Float32Array[] {
	const out: Float32Array[] = [];
	const r = rng(7);
	const N = MANY ? 400_000 : 60_000;
	const td = new Float32Array(N * 2);
	for (let i = 0; i < N; i++) {
		const kind = r();
		let t: number;
		if (kind < 0.4) t = Math.tan(((r() - 0.5) * 179.9 * Math.PI) / 180);
		else if (kind < 0.7) t = (r() - 0.5) * 2 * 10 ** (r() * 12 - 9);
		else if (kind < 0.95) t = (r() - 0.5) * 0.4;
		else
			t = [
				-3.0000000054977558e38,
				-3e38,
				0,
				-0,
				1,
				-1,
				1e-30,
				3e5,
				1e-40, // subnormal: the f64 path keeps it, a flushing GPU would see 0
				-(2 ** -149),
				2 ** -126 * (1 - 2 ** -23),
				3e30, // > 2^100: WGSL's 1/t is unspecified past 2^126, so the tie path
				-1e38,
			][i % 13];
		td[2 * i] = t;
		td[2 * i + 1] = 1000;
	}
	out.push(td);
	return out;
}

function checkStageA(label: string) {
	let n = 0;
	let falseCert = 0;
	let ties = 0;
	let mismatch = 0;
	for (const td of stageACases()) {
		const N = td.length / 2;
		const outA = emuStageA(td, N);
		for (let i = 0; i < N; i++) {
			if (!(outA[2 * i + 1] & FLAG_CERT)) continue;
			const ref = bits32(elevationF64(td[2 * i]));
			if (outA[2 * i] !== ref) falseCert++;
		}
		const fin = finishStageA(td, outA, N);
		for (let i = 0; i < N; i++)
			if (bits32(fin.elevation[i]) !== bits32(elevationF64(td[2 * i])))
				mismatch++;
		ties += fin.ties;
		n += N;
	}
	console.log(
		`stage A ${label}: ${n} samples, false certifications ${falseCert}, finished ≠ f64 ${mismatch}, tie path ${ties} (${((100 * ties) / n).toFixed(4)}%)`,
	);
	if (falseCert || mismatch) fail(`stage A ${label}`);
	return falseCert;
}

// ---------- 3. stages B + C ----------

type Totals = {
	cases: number;
	samples: number;
	sampUnc: number;
	cols: number;
	colTies: number;
	falseCert: number;
	boundViol: number;
	maxRatioAz: number;
	maxRatioEl: number;
	mismatch: number;
};
const newTotals = (): Totals => ({
	cases: 0,
	samples: 0,
	sampUnc: 0,
	cols: 0,
	colTies: 0,
	falseCert: 0,
	boundViol: 0,
	maxRatioAz: 0,
	maxRatioEl: 0,
	mismatch: 0,
});

function checkCase(c: Case, tot: Totals, legacy: boolean) {
	const { prof, job, eyeH } = c;
	const n = prof.elevation.length;
	const ref = skylineDirsF64(prof, job, eyeH);
	if (legacy) {
		const old = legacyDirs(prof, { ...job, step: prof.step }, eyeH);
		if (!sameBits(old, ref))
			fail(`${c.name}: skylineDirsF64 ≠ the pre-move worker code`);
	}
	const g = { lat: job.lat, lon: job.lon, k: job.k, eyeH };
	const consts = packConsts(g);
	const az = packAzimuths(prof.i0, n, prof.step);
	const samp = emuStageB(
		packProfile(prof),
		az,
		consts,
		n,
		enuLump(job.lat, job.lon),
		enuLumpRel(job.lat, job.lon),
	);
	// flags are exact floats: 0, 1 = valid, 3 = valid + uncertain
	const sflags = samp;
	// tracked bounds against the f64 path's own intermediates
	const sky = new SkylineF64(prof, job, eyeH);
	for (let i = 0; i < n; i++) {
		tot.samples++;
		const f = sflags[8 * i + 6];
		if (!(f & SAMP_VALID) || f & SAMP_UNCERTAIN) {
			if (f & SAMP_UNCERTAIN) tot.sampUnc++;
			continue;
		}
		sky.sample(i);
		const a = (prof.i0 + i) * prof.step;
		const dAz = Math.abs(samp[8 * i] + samp[8 * i + 1] - (sky.az[i] - a));
		const dEl = Math.abs(samp[8 * i + 3] + samp[8 * i + 4] - sky.el[i]);
		const rAz = dAz / samp[8 * i + 2];
		const rEl = dEl / samp[8 * i + 5];
		tot.maxRatioAz = Math.max(tot.maxRatioAz, rAz);
		tot.maxRatioEl = Math.max(tot.maxRatioEl, rEl);
		if (rAz > 1 || rEl > 1) tot.boundViol++;
	}
	const cols = packColumns(prof.step, GPU_COLUMNS);
	const outC = emuStageC(samp, az, cols, consts, n, GPU_COLUMNS.length);
	const one = new Float32Array(3);
	for (let j = 0; j < GPU_COLUMNS.length; j++) {
		tot.cols++;
		const f = outC[4 * j + 3];
		if (!(f & FLAG_CERT)) {
			tot.colTies++;
			continue;
		}
		const kept = sky.column(GPU_COLUMNS[j], one, 0);
		if (f & FLAG_SKIP) {
			if (kept) tot.falseCert++;
			continue;
		}
		if (
			!kept ||
			bits32(one[0]) !== outC[4 * j] ||
			bits32(one[1]) !== outC[4 * j + 1] ||
			bits32(one[2]) !== outC[4 * j + 2]
		)
			tot.falseCert++;
	}
	const fin = finishStageC(prof, job, eyeH, outC);
	if (!sameBits(fin.dirs, ref)) tot.mismatch++;
	tot.cases++;
}

function report(label: string, t: Totals) {
	console.log(
		`stages B+C ${label}: ${t.cases} cases, ${t.samples} samples (uncertain ${t.sampUnc}), ${t.cols} columns; ` +
			`bound violations ${t.boundViol} (max |err|/bound az ${t.maxRatioAz.toExponential(2)}, el ${t.maxRatioEl.toExponential(2)}); ` +
			`false certifications ${t.falseCert}; finished ≠ f64 ${t.mismatch}; tie path ${t.colTies} columns (${((100 * t.colTies) / Math.max(1, t.cols)).toFixed(3)}%)`,
	);
}

// ---------- 6. DEM-derived cases ----------

type RealFile = {
	cases: {
		id: string;
		lat: number;
		lon: number;
		eyeH: number;
		k: number;
		step: number;
		/** base64 f32: the march's tan(elevation), distance (pairs) */
		td: string;
	}[];
};
const REAL = path.resolve(
	import.meta.dirname,
	"../../../../out/gpu/horizon-cert/real-cases.json",
);
function realCases(): { cases: Case[]; td: Float32Array[] } | null {
	if (!fs.existsSync(REAL)) return null;
	const f = JSON.parse(fs.readFileSync(REAL, "utf8")) as RealFile;
	const list = ALL_REAL ? f.cases : f.cases.slice(0, 4);
	const cases: Case[] = [];
	const tds: Float32Array[] = [];
	for (const c of list) {
		const b = Buffer.from(c.td, "base64");
		const td = new Float32Array(
			b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength),
		);
		const n = td.length / 2;
		tds.push(td);
		const fin = finishStageA(td, emuStageA(td, n), n);
		const distance = new Float32Array(n);
		for (let i = 0; i < n; i++) distance[i] = td[2 * i + 1];
		cases.push({
			name: c.id,
			prof: { step: c.step, i0: 0, elevation: fin.elevation, distance },
			job: { lat: c.lat, lon: c.lon, k: c.k },
			eyeH: c.eyeH,
		});
	}
	return { cases, td: tds };
}

// ---------- run ----------

checkStageA("random t");

const nSynth = MANY ? 48 : 10;
const synth = Array.from({ length: nSynth }, (_, i) => synthCase(1000 + i));
const tot = newTotals();
resetTieStats();
for (const c of synth) checkCase(c, tot, true);
report("synthetic", tot);
{
	const lr = Math.max(...synth.map((c) => lumpRatio(c)));
	console.log(
		`   f64-path ENU error / lump (reference: difference formulas in f64): max ${lr.toExponential(2)} (must be < 1)`,
	);
	if (!(lr < 1)) fail("the f64 path's ENU error exceeds its lump");
}
console.log(`   tie reasons: ${JSON.stringify(tieStats)}`);
if (tot.boundViol || tot.falseCert || tot.mismatch) fail("synthetic");

const real = realCases();
if (real) {
	const tr = newTotals();
	let aFalse = 0;
	let aTies = 0;
	let aN = 0;
	const perCase: string[] = [];
	let lr = 0;
	for (let i = 0; i < real.cases.length; i++) {
		const td = real.td[i];
		const n = td.length / 2;
		const outA = emuStageA(td, n);
		for (let s = 0; s < n; s++) {
			if (!(outA[2 * s + 1] & FLAG_CERT)) aTies++;
			else if (outA[2 * s] !== bits32(elevationF64(td[2 * s]))) aFalse++;
		}
		aN += n;
		const before = tr.colTies;
		checkCase(real.cases[i], tr, false);
		lr = Math.max(lr, lumpRatio(real.cases[i]));
		const ds = [...real.cases[i].prof.distance].sort((x, y) => x - y);
		perCase.push(
			`${real.cases[i].name} ${((100 * (tr.colTies - before)) / GPU_COLUMNS.length).toFixed(1)}% (median skyline distance ${ds[ds.length >> 1].toFixed(0)} m)`,
		);
	}
	console.log(
		`stage A DEM: ${aN} samples, false certifications ${aFalse}, tie path ${aTies} (${((100 * aTies) / aN).toFixed(4)}%)`,
	);
	report(`DEM (${real.cases.length} ground-truth eyes)`, tr);
	console.log(`   tie path per case: ${perCase.join("; ")}`);
	console.log(
		`   f64-path ENU error / lump: max ${lr.toExponential(2)} (must be < 1)`,
	);
	if (!(lr < 1)) fail("DEM: the f64 path's ENU error exceeds its lump");
	if (aFalse || tr.boundViol || tr.falseCert || tr.mismatch) fail("DEM cases");
} else
	console.log(
		"DEM cases: SKIP (no out/gpu/horizon-cert/real-cases.json; run scripts/gpu/horizon-cert-cases.ts)",
	);

// 4. perturbed division / sqrt
{
	const r = rng(99);
	setDivSqrtPerturbation(3, r);
	checkStageA("div/sqrt ±3 ULP");
	const tp = newTotals();
	for (const c of synth.slice(0, MANY ? 16 : 3)) checkCase(c, tp, false);
	report("div/sqrt ±3 ULP", tp);
	if (tp.boundViol || tp.falseCert || tp.mismatch) fail("perturbed");
	setDivSqrtPerturbation(0);
}

// 4b. a machine that flushes subnormals on every load and every result (WGSL allows it)
{
	setFlushSubnormals(true);
	checkStageA("flush-to-zero");
	const tf = newTotals();
	for (const c of synth.slice(0, MANY ? 16 : 3)) checkCase(c, tf, false);
	if (real) for (const c of real.cases.slice(0, 2)) checkCase(c, tf, false);
	report("flush-to-zero", tf);
	if (tf.boundViol || tf.falseCert || tf.mismatch) fail("flush-to-zero");
	setFlushSubnormals(false);
}

// 7. the per-call spot check (certified.ts): passes the emulation's own outputs, catches corrupted ones
{
	const td = stageACases()[0].subarray(0, 2 * 4000);
	const outA = emuStageA(td, 4000);
	const okA = spotCheckA(td, outA, 4000);
	const badA = outA.slice();
	for (let i = 0; i < 4000; i++)
		if (badA[2 * i + 1] & FLAG_CERT) badA[2 * i] ^= 1;
	const c = synth[0];
	const { outC } = emuSkylineDirs(c.prof, c.job, c.eyeH);
	const okC = spotCheckC(c.prof, c.job, c.eyeH, outC);
	const badC = outC.slice();
	for (let j = 0; j < GPU_COLUMNS.length; j++)
		if (badC[4 * j + 3] & FLAG_CERT && !(badC[4 * j + 3] & FLAG_SKIP))
			badC[4 * j + 2] ^= 1;
	const caughtA = typeof spotCheckA(td, badA, 4000) === "string";
	const caughtC = typeof spotCheckC(c.prof, c.job, c.eyeH, badC) === "string";
	console.log(
		`spot check: emulated outputs pass (A ${okA}, C ${okC} checked); corrupted certified outputs caught: A ${caughtA}, C ${caughtC}`,
	);
	if (
		typeof okA === "string" ||
		typeof okC === "string" ||
		!caughtA ||
		!caughtC
	)
		fail("per-call spot check");
}

// 5. teeth: an error the bound does not cover must be caught
{
	setFaultInjection(1e-9);
	const fa = (() => {
		let falseCert = 0;
		for (const td of stageACases()) {
			const N = td.length / 2;
			const outA = emuStageA(td, N);
			for (let i = 0; i < N; i++)
				if (
					outA[2 * i + 1] & FLAG_CERT &&
					outA[2 * i] !== bits32(elevationF64(td[2 * i]))
				)
					falseCert++;
		}
		return falseCert;
	})();
	const ts = newTotals();
	for (const c of synth.slice(0, 2)) checkCase(c, ts, false);
	setFaultInjection(0);
	console.log(
		`teeth (1e-9 relative fault outside the bound): stage A false certifications ${fa}, stages B+C ${ts.falseCert} (both must be > 0)`,
	);
	if (!(fa > 0 && ts.falseCert > 0))
		fail("teeth: injected faults were not caught");
}

console.log(
	`${failures ? "FAIL" : "PASS"} certified-f32 horizon check (${((performance.now() - t0) / 1000).toFixed(1)} s)`,
);
process.exit(failures ? 1 : 0);
