// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Benchmark + accuracy of src/lib/horizon-fast against geo/horizon.ts
 * computeHorizon on the img/ photos.
 *
 *   npx tsx scripts/horizon-fast-bench.ts [IMG_7053 ...]
 *
 * Env: POOL (workers, default 8), BRUTE_RANDOM (random azimuths per photo
 * checked by brute force, default 36), BRUTE_DIFF (max disagreeing azimuths
 * checked, default 40), HF_OUT (output dir).
 *
 * Writes $HF_OUT/bench.json and bench.md.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TERRAIN_LEVELS, validateTile } from "../src/lib/dem";
import { computeHorizon } from "../src/lib/geo/horizon";
import { viewPeaks } from "../src/lib/geo/peaks";
import { readPhotoMeta } from "../src/lib/geo/photo-meta";
import { loadTerrain } from "../src/lib/geo/terrain";
import {
	DEG,
	destination,
	distanceBearing,
	EARTH_R,
	REFRACTION_K,
} from "../src/lib/geodesy";
import {
	computeHorizonFast,
	computeHorizonFastCompat,
	type Eye,
	mosaicsFromSampler,
	peakVisibilityFast,
} from "../src/lib/horizon-fast/march";
import {
	buildMosaics,
	type Mosaic,
	mosaicFor,
	mosaicHeight,
	TileStore,
} from "../src/lib/horizon-fast/mosaic";
import {
	mosaicHeightAt,
	type PeakVisibility,
	snapPeaks,
} from "../src/lib/horizon-fast/visibility";
import { HF_OUT, mapterhornNode } from "./horizon-fast-io";
import { prepare } from "./lib/horizon-fast/engine";
import { nodeWorkers } from "./lib/horizon-fast/node";
import { HorizonPool } from "./lib/horizon-fast/pool";
import {
	imagePixelSize,
	listPhotos,
	loadTerrariumTileNode,
} from "./lib/node-io";
import { fetchPeaks } from "./lib/overpass";
import { eyeHeight } from "./lib/pipeline-node";

const POOL = Number(process.env.POOL ?? 8);
const BRUTE_RANDOM = Number(process.env.BRUTE_RANDOM ?? 36);
const BRUTE_DIFF = Number(process.env.BRUTE_DIFF ?? 40);
const MAX_D = 150_000;

type HeightFn = (lat: number, lon: number, d: number) => number;

/** Exact great-circle march at a tiny step: the reference. */
function brute(h: HeightFn, eye: Eye, az: number, maxD = MAX_D) {
	const inv2R = (1 - REFRACTION_K) / (2 * EARTH_R);
	let best = Number.NEGATIVE_INFINITY;
	let bestD = 0;
	for (let d = 20; d <= maxD; d += Math.max(0.5, 2.5e-5 * d)) {
		const p = destination(eye.lat, eye.lon, az, d);
		const v = h(p.lat, p.lon, d);
		if (!(v > -1000)) continue;
		const t = (v - eye.h) / d - d * inv2R;
		if (t > best) {
			best = t;
			bestD = d;
		}
	}
	return { el: Math.atan(best) / DEG, d: bestD };
}

function stats(xs: number[]) {
	if (!xs.length) return { median: 0, p95: 0, max: 0, n: 0 };
	const s = [...xs].sort((a, b) => a - b);
	const q = (f: number) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
	return { median: q(0.5), p95: q(0.95), max: s[s.length - 1], n: s.length };
}

const absDiff = (a: Float32Array, b: Float32Array) =>
	Array.from(a, (v, i) => Math.abs(v - b[i]));

/** Brute-force check of two profiles at random and at disagreeing azimuths. */
function bruteCheck(
	h: HeightFn,
	eye: Eye,
	step: number,
	a: Float32Array,
	b: Float32Array | undefined,
	seed: number,
) {
	let rnd = seed;
	const rand = () => {
		rnd = (rnd * 1103515245 + 12345) % 2147483648;
		return rnd / 2147483648;
	};
	const n = a.length;
	const errA: number[] = [];
	const errB: number[] = [];
	for (let k = 0; k < BRUTE_RANDOM; k++) {
		const i = Math.floor(rand() * n);
		const ref = brute(h, eye, i * step).el;
		errA.push(Math.abs(a[i] - ref));
		if (b) errB.push(Math.abs(b[i] - ref));
	}
	let aCloser = 0;
	let bCloser = 0;
	let ties = 0;
	const diffErrA: number[] = [];
	const diffErrB: number[] = [];
	if (b) {
		const idx: number[] = [];
		for (let i = 0; i < n; i++) if (Math.abs(a[i] - b[i]) > 0.05) idx.push(i);
		const pick =
			idx.length <= BRUTE_DIFF
				? idx
				: Array.from(
						{ length: BRUTE_DIFF },
						(_, k) => idx[Math.floor((k * idx.length) / BRUTE_DIFF)],
					);
		for (const i of pick) {
			const ref = brute(h, eye, i * step).el;
			const ea = Math.abs(a[i] - ref);
			const eb = Math.abs(b[i] - ref);
			diffErrA.push(ea);
			diffErrB.push(eb);
			if (Math.abs(ea - eb) < 0.005) ties++;
			else if (ea < eb) aCloser++;
			else bCloser++;
		}
		return {
			random: { a: stats(errA), b: stats(errB) },
			disagree: {
				count: idx.length,
				checked: pick.length,
				aCloser,
				bCloser,
				ties,
				a: stats(diffErrA),
				b: stats(diffErrB),
			},
		};
	}
	return { random: { a: stats(errA) } };
}

/** Synthetic Terrarium corruption on a real tile: does validateTile fix it? */
async function validationSelfTest() {
	const k = { z: 12, x: 2137, y: 1447 };
	const clean = await mapterhornNode.load(k);
	if (!clean) return undefined;
	const T = 512;
	const out: Record<string, unknown> = {};
	const cases: [string, (h: Float32Array) => void][] = [
		["none (real cliffs only)", () => {}],
		[
			"60 isolated pixels +256",
			(h) => {
				for (let n = 0; n < 60; n++)
					h[((n * 7919) % (T * T - 2 * T)) + T] += 256;
			},
		],
		[
			"40×40 block +256",
			(h) => {
				for (let y = 200; y < 240; y++)
					for (let x = 100; x < 140; x++) h[y * T + x] += 256;
			},
		],
		[
			"6 px stripe −256",
			(h) => {
				for (let y = 0; y < T; y++)
					for (let x = 300; x < 306; x++) h[y * T + x] -= 256;
			},
		],
	];
	for (const [name, corrupt] of cases) {
		const h = Float32Array.from(clean);
		validateTile(h, T); // clean reference after its own (no-op) validation
		const ref = Float32Array.from(h);
		corrupt(h);
		const v = validateTile(h, T);
		let maxErr = 0;
		let bad = 0;
		for (let i = 0; i < h.length; i++) {
			const e = Math.abs(h[i] - ref[i]);
			if (e > 1) bad++;
			maxErr = Math.max(maxErr, e);
		}
		out[name] = { ...v, wrongPixelsAfter: bad, maxErrAfter: maxErr };
	}
	return out;
}

function peakAgreement(
	base: { id: string; visible: boolean }[],
	fast: PeakVisibility[],
) {
	const m = new Map(fast.map((p) => [p.peak.id as string, p]));
	const c = {
		both: 0,
		neither: 0,
		baseOnly: 0,
		fastOnly: 0,
		marginalDisagree: 0,
		n: 0,
	};
	for (const b of base) {
		const f = m.get(b.id);
		if (!f) continue;
		c.n++;
		if (b.visible && f.visible) c.both++;
		else if (!b.visible && !f.visible) c.neither++;
		else {
			if (b.visible) c.baseOnly++;
			else c.fastOnly++;
			if (Math.abs(f.elevation - f.occluderElevation) < 0.1)
				c.marginalDisagree++;
		}
	}
	return { ...c, agreement: c.n ? (c.both + c.neither) / c.n : 1 };
}

async function main() {
	fs.mkdirSync(HF_OUT, { recursive: true });
	const photos = listPhotos(process.argv.slice(2));
	const pool = new HorizonPool(nodeWorkers(POOL));
	const awsTiles = new Map<string, Float32Array>();
	const mh = new TileStore(mapterhornNode);
	let lastEye: Eye | undefined;
	const rows = [];
	const selfTest = await validationSelfTest();
	console.log("validation self-test", JSON.stringify(selfTest, null, 1));

	for (const { name, heic } of photos) {
		const meta = await readPhotoMeta(
			fs.readFileSync(heic),
			imagePixelSize(heic),
		);
		if (meta.lat === undefined || meta.lon === undefined) continue;
		const { lat, lon } = meta;
		const terrain = await loadTerrain(
			lat,
			lon,
			loadTerrariumTileNode,
			TERRAIN_LEVELS,
			awsTiles,
		);
		const ground = terrain.sample(lon, lat, TERRAIN_LEVELS[0].z);
		const eyeH = eyeHeight(meta.altitude, ground);
		const eye: Eye = { lat, lon, h: eyeH };
		if (
			lastEye &&
			distanceBearing(lastEye.lat, lastEye.lon, lat, lon).distance > 20_000
		)
			mh.clear();
		lastEye = eye;

		// Baseline (AWS 256 px, z13/z11/z10, step 0.004·d).
		let t = performance.now();
		const base = computeHorizon(terrain, lat, lon, eyeH);
		const baseMs = performance.now() - t;

		// Drop-in on the same sampler (includes the tile → mosaic copy); best of 2.
		let awsMs = Number.POSITIVE_INFINITY;
		let fastAws = computeHorizonFastCompat(terrain, lat, lon, eyeH);
		for (let r = 0; r < 2; r++) {
			t = performance.now();
			fastAws = computeHorizonFastCompat(terrain, lat, lon, eyeH);
			awsMs = Math.min(awsMs, performance.now() - t);
		}
		const awsMosaics = mosaicsFromSampler(terrain, lat, lon, MAX_D);
		const noSkip = computeHorizonFast(awsMosaics, eye, { mipSkip: false });

		// Mapterhorn 512 px, default rings (z15/z13/z12/z11/z10). The eye rule
		// must use the DEM that is marched: the lidar ridge tops sit tens of
		// metres above the AWS ones, which would bury an AWS-derived eye.
		const prep = await prepare(mh, eye);
		const groundMh = mh.heightAt(lon, lat, prep.spans[0].z);
		const eyeMhH = eyeHeight(meta.altitude, groundMh);
		const eyeMh: Eye = { lat, lon, h: eyeMhH };
		let mhMosaicMs = Number.POSITIVE_INFINITY;
		let mhMarchMs = Number.POSITIVE_INFINITY;
		let mhMosaics: Mosaic[] = [];
		let fastMh = computeHorizonFast(
			buildMosaics(lat, lon, mh, prep.spans, { mips: true }),
			eyeMh,
		);
		for (let r = 0; r < 2; r++) {
			t = performance.now();
			mhMosaics = buildMosaics(lat, lon, mh, prep.spans, { mips: true });
			const t1 = performance.now();
			fastMh = computeHorizonFast(mhMosaics, eyeMh);
			mhMosaicMs = Math.min(mhMosaicMs, t1 - t);
			mhMarchMs = Math.min(mhMarchMs, performance.now() - t1);
		}
		let poolMs = Number.POSITIVE_INFINITY;
		let pool002Ms = Number.POSITIVE_INFINITY;
		const peaks = await fetchPeaks(lat, lon, 80_000);
		let poolR = await pool.compute(mh, eyeMh, { osmPeaks: peaks });
		for (let r = 0; r < 2; r++) {
			poolR = await pool.compute(mh, eyeMh, { osmPeaks: peaks });
			poolMs = Math.min(poolMs, poolR.timings.totalMs);
			const r2 = await pool.compute(mh, eyeMh, { step: 0.02 });
			pool002Ms = Math.min(pool002Ms, r2.timings.totalMs);
		}
		const poolDiff = stats(absDiff(poolR.elevation, fastMh.elevation)).max;

		// Accuracy.
		const dAws = stats(absDiff(fastAws.elevation, base.elevation));
		const dMh = stats(absDiff(fastMh.elevation, base.elevation));
		const dSkip = stats(absDiff(fastAws.elevation, noSkip.elevation));
		const awsH: HeightFn = (la, lo, d) => terrain.sampleAt(lo, la, d);
		const mhH: HeightFn = (la, lo, d) =>
			mosaicHeight(mosaicFor(mhMosaics, d), lo, la);
		const seed =
			name.split("").reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 1e6;
		const bruteAws = bruteCheck(
			awsH,
			eye,
			base.step,
			fastAws.elevation,
			base.elevation,
			seed,
		);
		const bruteMh = bruteCheck(
			mhH,
			eyeMh,
			base.step,
			fastMh.elevation,
			undefined,
			seed,
		);
		// Where fast-MH and baseline disagree, what does a brute march on the
		// Mapterhorn data say? (DEM change, not algorithm.)
		const bruteMhVsBase = bruteCheck(
			mhH,
			eyeMh,
			base.step,
			fastMh.elevation,
			base.elevation,
			seed + 1,
		);

		// Peaks.
		const baseViews = viewPeaks(peaks, terrain, lat, lon, eyeH);
		const snappedAws = snapPeaks(
			peaks,
			mosaicHeightAt(awsMosaics),
			(d) => mosaicFor(awsMosaics, d).cellMeters,
			eye,
			{ maxDistance: MAX_D },
		);
		t = performance.now();
		const visAws = peakVisibilityFast(awsMosaics, eye, snappedAws);
		const peaksAwsMs = performance.now() - t;
		const baseFlags = baseViews.map((v) => ({
			id: v.peak.id,
			visible: v.visible,
		}));
		const agreeAws = peakAgreement(baseFlags, visAws);
		const agreeMh = peakAgreement(baseFlags, poolR.peaks ?? []);
		const mhPeaks = poolR.peaks ?? [];

		const row = {
			name,
			eye: +eyeH.toFixed(1),
			eyeMh: +eyeMhH.toFixed(1),
			groundAws: +ground.toFixed(1),
			groundMh: +groundMh.toFixed(1),
			baselineMs: Math.round(baseMs),
			fastAwsMs: Math.round(awsMs),
			fastAwsMarchMs: Math.round(fastAws.stats.ms),
			mhLoadMs: Math.round(prep.loadMs),
			mhMosaicMs: Math.round(mhMosaicMs),
			mhMarchMs: Math.round(mhMarchMs),
			mhSingleMs: Math.round(mhMosaicMs + mhMarchMs),
			mhPoolMs: Math.round(poolMs),
			mhPool002Ms: Math.round(pool002Ms),
			poolVsSingleMaxDiff: poolDiff,
			samples: {
				baselineApprox: 7200 * 1270,
				aws: fastAws.stats.samples,
				awsNoSkip: noSkip.stats.samples,
				mh: fastMh.stats.samples,
				mhSkips: fastMh.stats.skips,
			},
			mipSkipVsNoSkip: dSkip,
			deltaAwsVsBaseline: dAws,
			deltaMhVsBaseline: dMh,
			bruteAws,
			bruteMh,
			bruteMhVsBase,
			ridges: {
				baseline: base.ridges.reduce((a, r) => a + r.length, 0),
				aws: fastAws.ridges.reduce((a, r) => a + r.length, 0),
				mh: fastMh.ridges.reduce((a, r) => a + r.length, 0),
			},
			peaks: {
				osm: peaks.length,
				baselineViews: baseViews.length,
				baselineVisible: baseViews.filter((v) => v.visible).length,
				awsVisible: visAws.filter((v) => v.visible).length,
				mhVisible: mhPeaks.filter((v) => v.visible).length,
				mhMarginal: mhPeaks.filter((v) => v.marginal).length,
				mhOnSkyline: mhPeaks.filter((v) => v.onSkyline).length,
				mhSnapped: mhPeaks.filter((v) => v.snapped).length,
				peaksAwsMs: Math.round(peaksAwsMs),
				agreeAws,
				agreeMh,
			},
			mhTilesRepaired: [...mh.validation.values()].filter((v) => v.repaired)
				.length,
		};
		rows.push(row);
		console.log(
			`${name} base ${row.baselineMs}ms | aws ${row.fastAwsMs}ms (${(baseMs / awsMs).toFixed(1)}×) Δ med ${dAws.median.toFixed(4)} p95 ${dAws.p95.toFixed(4)} max ${dAws.max.toFixed(3)} | mh single ${row.mhSingleMs}ms pool ${row.mhPoolMs}ms (0.02°: ${row.mhPool002Ms}ms) Δ med ${dMh.median.toFixed(3)} p95 ${dMh.p95.toFixed(3)} | brute aws: fast ${bruteAws.random.a.p95.toFixed(4)} base ${bruteAws.random.b?.p95.toFixed(4)} disagree ${bruteAws.disagree?.aCloser}/${bruteAws.disagree?.bCloser}/${bruteAws.disagree?.ties} | peaks agree aws ${(agreeAws.agreement * 100).toFixed(0)}% mh ${(agreeMh.agreement * 100).toFixed(0)}%`,
		);
	}
	pool.terminate();
	const env = {
		date: new Date().toISOString(),
		node: process.version,
		cpus: os.cpus().length,
		cpu: os.cpus()[0]?.model,
		loadavg: os.loadavg(),
		pool: POOL,
	};
	fs.writeFileSync(
		path.join(HF_OUT, "bench.json"),
		JSON.stringify({ env, selfTest, rows }, null, 1),
	);
	fs.writeFileSync(path.join(HF_OUT, "bench.md"), markdown(env, rows));
	console.log(`wrote ${path.join(HF_OUT, "bench.md")}`);
}

// biome-ignore lint/suspicious/noExplicitAny: report rows
function markdown(env: Record<string, unknown>, rows: any[]) {
	const f = (x: number, d = 3) => x.toFixed(d);
	const lines = [
		`# horizon-fast benchmark (${env.date})`,
		"",
		`node ${env.node}, ${env.cpus}× ${env.cpu}, loadavg ${(env.loadavg as number[]).map((x) => x.toFixed(1)).join(" ")}, pool ${env.pool}`,
		"",
		"Times are best-of-2 (baseline: 1 run), tiles already decoded. Δ = |elevation difference| in degrees over 7200 azimuths.",
		"",
		"| photo | eye AWS / MH m | baseline ms | fast AWS ms (×) | MH mosaic+march ms | MH pool ms (×) | MH pool 0.02° ms | Δ AWS med / p95 / max | Δ MH med / p95 / max |",
		"|---|---|---|---|---|---|---|---|---|",
	];
	for (const r of rows)
		lines.push(
			`| ${r.name} | ${r.eye} / ${r.eyeMh} | ${r.baselineMs} | ${r.fastAwsMs} (${f(r.baselineMs / r.fastAwsMs, 0)}×) | ${r.mhMosaicMs}+${r.mhMarchMs} | ${r.mhPoolMs} (${f(r.baselineMs / r.mhPoolMs, 0)}×) | ${r.mhPool002Ms} | ${f(r.deltaAwsVsBaseline.median, 4)} / ${f(r.deltaAwsVsBaseline.p95)} / ${f(r.deltaAwsVsBaseline.max)} | ${f(r.deltaMhVsBaseline.median)} / ${f(r.deltaMhVsBaseline.p95)} / ${f(r.deltaMhVsBaseline.max)} |`,
		);
	lines.push(
		"",
		"## Brute-force reference (exact great circle, step max(0.5 m, 2.5e-5·d))",
		"",
		"| photo | AWS random: fast p95 / max | AWS random: baseline p95 / max | AWS >0.05° disagreements: n (checked) fast closer / baseline closer / tie | MH random: fast p95 / max | MH-vs-baseline >0.05°: n, fast-MH err p95 |",
		"|---|---|---|---|---|---|",
	);
	for (const r of rows) {
		const a = r.bruteAws;
		lines.push(
			`| ${r.name} | ${f(a.random.a.p95, 4)} / ${f(a.random.a.max, 4)} | ${f(a.random.b.p95, 4)} / ${f(a.random.b.max, 4)} | ${a.disagree.count} (${a.disagree.checked}) ${a.disagree.aCloser} / ${a.disagree.bCloser} / ${a.disagree.ties} | ${f(r.bruteMh.random.a.p95, 4)} / ${f(r.bruteMh.random.a.max, 4)} | ${r.bruteMhVsBase.disagree.count}, ${f(r.bruteMhVsBase.disagree.a.p95, 4)} |`,
		);
	}
	lines.push(
		"",
		"## Peak visibility vs baseline viewPeaks",
		"",
		"| photo | peaks | base visible | fast AWS visible | agree AWS | fast MH visible (marginal, on skyline, snapped) | agree MH | disagreements within 0.1° (AWS / MH) |",
		"|---|---|---|---|---|---|---|---|",
	);
	for (const r of rows) {
		const p = r.peaks;
		lines.push(
			`| ${r.name} | ${p.baselineViews} | ${p.baselineVisible} | ${p.awsVisible} | ${f(p.agreeAws.agreement * 100, 1)}% | ${p.mhVisible} (${p.mhMarginal}, ${p.mhOnSkyline}, ${p.mhSnapped}) | ${f(p.agreeMh.agreement * 100, 1)}% | ${p.agreeAws.marginalDisagree}/${p.agreeAws.baseOnly + p.agreeAws.fastOnly} · ${p.agreeMh.marginalDisagree}/${p.agreeMh.baseOnly + p.agreeMh.fastOnly} |`,
		);
	}
	return `${lines.join("\n")}\n`;
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
