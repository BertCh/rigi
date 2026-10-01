// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WP-F self-check (CPU, offline): npx tsx src/lib/concord/occl/occl.check.ts [--live]
//  1. LZW decoder vs a reference TIFF-LZW encoder (random, repetitive, KwKwK, width switches, clear codes)
//  2. synthetic tiled COGs (LZW / Deflate / none, predictor 1 / 2 / 3, 2 levels, BigTIFF) → readWindow exact
//  3. LV95 formulas vs the swisstopo worked example; inverse round trip; ENU→LV95 affine vs exact
//  4. occluder: synthetic DSM box — hit range, near skip, under-terrain stop, parity when off
//  --live: one real swissSURFACE3D/swissALTI3D load (IMG_7018 GT position, 700 m).
import { deflateSync } from "node:zlib";
import { EnuFrame } from "../../geodesy";
import type { CameraX } from "../core";
import { IDENTITY_INTRINSICS } from "../core";
import { enuToLv95Affine, loadNearDsm, type NearDsm } from "./ndsm";
import {
	type GeomBuffer,
	objectHitRange,
	occludedBy,
	occluderRange,
} from "./occluder";
import {
	lv95ToWgs84,
	lzwDecode,
	openCog,
	type RangeFetcher,
	readWindow,
	wgs84ToLv95,
} from "./swiss-cog";

let fails = 0;
const ok = (cond: boolean, msg: string) => {
	console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
	if (!cond) fails++;
};

// ---------------------------------------------------------------- 1. LZW

/** Reference TIFF LZW encoder (MSB-first, early change, clear at table full). */
function lzwEncode(data: Uint8Array): Uint8Array {
	const out: number[] = [];
	let acc = 0;
	let nb = 0;
	let width = 9;
	const put = (c: number) => {
		acc = (acc << width) | c;
		nb += width;
		while (nb >= 8) {
			out.push((acc >>> (nb - 8)) & 255);
			nb -= 8;
		}
		acc &= (1 << nb) - 1;
	};
	let dict = new Map<string, number>();
	let next = 258;
	const has = (x: string) => x.length === 1 || dict.has(x);
	const codeOf = (x: string) =>
		x.length === 1 ? x.charCodeAt(0) : (dict.get(x) as number);
	put(256);
	let w = "";
	for (let i = 0; i < data.length; i++) {
		const c = String.fromCharCode(data[i]);
		const wc = w + c;
		if (has(wc)) {
			w = wc;
			continue;
		}
		put(codeOf(w));
		dict.set(wc, next++);
		// the decoder's table lags one code behind: switching at next == 2^width here is TIFF's early change there
		if (next >= 1 << width && width < 12) width++;
		if (next >= 4094) {
			put(256);
			dict = new Map();
			next = 258;
			width = 9;
		}
		w = c;
	}
	if (w) put(codeOf(w));
	put(257);
	if (nb > 0) out.push((acc << (8 - nb)) & 255);
	return Uint8Array.from(out);
}

{
	let seed = 12345;
	const rnd = () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
	const cases: [string, Uint8Array][] = [
		["random 20k", Uint8Array.from({ length: 20000 }, () => (rnd() * 256) | 0)],
		[
			"runs (KwKwK)",
			Uint8Array.from({ length: 30000 }, (_, i) => (i >> 9) & 3),
		],
		[
			"float32 terrain",
			new Uint8Array(
				Float32Array.from({ length: 16384 }, (_, i) =>
					Math.round(1200 + 30 * Math.sin(i / 50) + rnd() * 2),
				).buffer,
			),
		],
		["tiny", Uint8Array.from([7, 7, 7, 7, 7, 1])],
	];
	for (const [name, d] of cases) {
		const dec = lzwDecode(lzwEncode(d), d.length);
		let bad = 0;
		for (let i = 0; i < d.length; i++) if (dec[i] !== d[i]) bad++;
		ok(bad === 0, `LZW round trip ${name} (${d.length} B, ${bad} mismatches)`);
	}
}

// ---------------------------------------------------------------- 2. synthetic COG

type Enc = { comp: 1 | 5 | 8; pred: 1 | 2 | 3; big: boolean };

/** Build a 2-level tiled float32 (or int16 for predictor 2) GeoTIFF in memory, overview IFD first. */
function buildTiff(
	levels: { w: number; h: number; data: Float32Array }[],
	tile: number,
	enc: Enc,
): Uint8Array {
	const bps = enc.pred === 2 ? 16 : 32;
	const fmt = enc.pred === 2 ? 2 : 3;
	const chunks: Uint8Array[] = [];
	const ifds: { tags: [number, number, number[]][]; tiles: Uint8Array[] }[] =
		[];
	for (const [li, L] of levels.entries()) {
		const tiles: Uint8Array[] = [];
		const nx = Math.ceil(L.w / tile);
		const ny = Math.ceil(L.h / tile);
		for (let ty = 0; ty < ny; ty++)
			for (let tx = 0; tx < nx; tx++) {
				const raw = new Uint8Array(tile * tile * (bps / 8));
				const dv = new DataView(raw.buffer);
				const vals = new Float64Array(tile * tile);
				for (let r = 0; r < tile; r++)
					for (let c = 0; c < tile; c++) {
						const x = tx * tile + c;
						const y = ty * tile + r;
						vals[r * tile + c] = x < L.w && y < L.h ? L.data[y * L.w + x] : 0;
					}
				if (enc.pred === 2) {
					for (let r = 0; r < tile; r++)
						for (let c = tile - 1; c >= 0; c--) {
							const v = Math.round(vals[r * tile + c]);
							const p = c ? Math.round(vals[r * tile + c - 1]) : 0;
							dv.setInt16((r * tile + c) * 2, c ? v - p : v, true);
						}
				} else if (enc.pred === 3) {
					// float predictor: per row, byte planes MSB first, then byte-wise horizontal differencing
					for (let r = 0; r < tile; r++) {
						const row = new Uint8Array(tile * 4);
						const tmp = new DataView(new ArrayBuffer(4));
						for (let c = 0; c < tile; c++) {
							tmp.setFloat32(0, vals[r * tile + c], false); // big-endian bytes
							for (let k = 0; k < 4; k++) row[k * tile + c] = tmp.getUint8(k);
						}
						for (let i = row.length - 1; i > 0; i--)
							row[i] = (row[i] - row[i - 1]) & 255;
						raw.set(row, r * tile * 4);
					}
				} else {
					for (let i = 0; i < tile * tile; i++)
						dv.setFloat32(i * 4, vals[i], true);
				}
				tiles.push(
					enc.comp === 5
						? lzwEncode(raw)
						: enc.comp === 8
							? new Uint8Array(deflateSync(raw))
							: raw,
				);
			}
		const tags: [number, number, number[]][] = [
			[254, 4, [li ? 1 : 0]],
			[256, 3, [L.w]],
			[257, 3, [L.h]],
			[258, 3, [bps]],
			[259, 3, [enc.comp]],
			[262, 3, [1]],
			[277, 3, [1]],
			[317, 3, [enc.pred]],
			[322, 3, [tile]],
			[323, 3, [tile]],
			[324, enc.big ? 16 : 4, tiles.map(() => 0)],
			[325, enc.big ? 16 : 4, tiles.map((t) => t.length)],
			[339, 3, [fmt]],
		];
		if (li === 0) {
			tags.push([33550, 12, [2, 2, 0]]);
			tags.push([33922, 12, [0, 0, 0, 2600000, 1200000, 0]]);
		}
		ifds.push({ tags: tags.sort((a, b) => a[0] - b[0]), tiles });
	}
	// layout: header | IFDs (+ out-of-line arrays) | tile data (smallest level first)
	const big = enc.big;
	const hdrLen = big ? 16 : 8;
	const es = big ? 20 : 12;
	const sz: Record<number, number> = { 3: 2, 4: 4, 12: 8, 16: 8 };
	const ifdLen = (t: [number, number, number[]][]) => {
		let n = (big ? 8 : 2) + t.length * es + (big ? 8 : 4);
		for (const [, ty, v] of t)
			if (sz[ty] * v.length > (big ? 8 : 4)) n += sz[ty] * v.length;
		return n;
	};
	const ifdOff: number[] = [];
	let off = hdrLen;
	for (const f of ifds) {
		ifdOff.push(off);
		off += ifdLen(f.tags);
	}
	for (const f of [...ifds].reverse()) {
		const offs = f.tags.find((t) => t[0] === 324) as [number, number, number[]];
		for (const [k, t] of f.tiles.entries()) {
			offs[2][k] = off;
			chunks.push(t);
			off += t.length;
		}
	}
	const buf = new Uint8Array(off);
	const dv = new DataView(buf.buffer);
	buf[0] = 0x49;
	buf[1] = 0x49;
	dv.setUint16(2, big ? 43 : 42, true);
	if (big) {
		dv.setUint16(4, 8, true);
		dv.setBigUint64(8, BigInt(ifdOff[0]), true);
	} else dv.setUint32(4, ifdOff[0], true);
	const wr = (o: number, ty: number, v: number) =>
		ty === 3
			? dv.setUint16(o, v, true)
			: ty === 4
				? dv.setUint32(o, v, true)
				: ty === 16
					? dv.setBigUint64(o, BigInt(v), true)
					: dv.setFloat64(o, v, true);
	for (const [fi, f] of ifds.entries()) {
		let p = ifdOff[fi];
		if (big) dv.setBigUint64(p, BigInt(f.tags.length), true);
		else dv.setUint16(p, f.tags.length, true);
		p += big ? 8 : 2;
		let extra = p + f.tags.length * es + (big ? 8 : 4);
		for (const [tag, ty, v] of f.tags) {
			dv.setUint16(p, tag, true);
			dv.setUint16(p + 2, ty, true);
			if (big) dv.setBigUint64(p + 4, BigInt(v.length), true);
			else dv.setUint32(p + 4, v.length, true);
			const vo = p + (big ? 12 : 8);
			if (sz[ty] * v.length > (big ? 8 : 4)) {
				if (big) dv.setBigUint64(vo, BigInt(extra), true);
				else dv.setUint32(vo, extra, true);
				for (const [k, x] of v.entries()) wr(extra + k * sz[ty], ty, x);
				extra += sz[ty] * v.length;
			} else for (const [k, x] of v.entries()) wr(vo + k * sz[ty], ty, x);
			p += es;
		}
		const nextIfd = fi + 1 < ifds.length ? ifdOff[fi + 1] : 0;
		if (big) dv.setBigUint64(p, BigInt(nextIfd), true);
		else dv.setUint32(p, nextIfd, true);
	}
	let o = ifdOff[ifds.length - 1] + ifdLen(ifds[ifds.length - 1].tags);
	for (const c of chunks) {
		buf.set(c, o);
		o += c.length;
	}
	return buf;
}

{
	const W = 100;
	const H = 70;
	const full = Float32Array.from(
		{ length: W * H },
		(_, i) => 1000 + ((i % W) * 3.25 - Math.floor(i / W) * 1.5),
	);
	const ov = Float32Array.from(
		{ length: 50 * 35 },
		(_, i) => full[Math.floor(i / 50) * 2 * W + (i % 50) * 2],
	);
	const encs: Enc[] = [
		{ comp: 5, pred: 1, big: false },
		{ comp: 8, pred: 1, big: false },
		{ comp: 1, pred: 1, big: true },
		{ comp: 8, pred: 3, big: false },
		{ comp: 5, pred: 3, big: true },
		{ comp: 5, pred: 2, big: false },
	];
	for (const enc of encs) {
		const src = enc.pred === 2 ? full.map((v) => Math.round(v)) : full;
		const src1 = enc.pred === 2 ? ov.map((v) => Math.round(v)) : ov;
		const file = buildTiff(
			[
				{ w: W, h: H, data: src },
				{ w: 50, h: 35, data: src1 },
			],
			32,
			enc,
		);
		let reqs = 0;
		const mem: RangeFetcher = async (_u, a, b) => {
			reqs++;
			return file.slice(a, Math.min(b + 1, file.length));
		};
		const hdr = await openCog("mem://t", mem);
		const win = await readWindow(hdr, 0, 17, 9, 60, 50, mem);
		let bad = 0;
		for (let j = 0; j < 50; j++)
			for (let i = 0; i < 60; i++)
				if (Math.abs(win[j * 60 + i] - src[(j + 9) * W + i + 17]) > 1e-3) bad++;
		const w1 = await readWindow(hdr, 1, 0, 0, 50, 35, mem);
		let bad1 = 0;
		for (let k = 0; k < w1.length; k++)
			if (Math.abs(w1[k] - src1[k]) > 1e-3) bad1++;
		ok(
			bad === 0 &&
				bad1 === 0 &&
				hdr.levels.length === 2 &&
				hdr.levels[1].resX === 4 &&
				hdr.originX === 2600000 &&
				hdr.originY === 1200000,
			`COG comp=${enc.comp} pred=${enc.pred}${enc.big ? " BigTIFF" : ""}: window ${bad}, overview ${bad1} mismatches, ${reqs} requests, res ${hdr.levels.map((l) => l.resX).join("/")}`,
		);
	}
}

// ---------------------------------------------------------------- 3. LV95

{
	// swisstopo "Approximate formulas" worked example: 46°02'38.87"N 8°43'49.79"E → 2 699 999.76 / 1 099 999.97
	const lat = 46 + 2 / 60 + 38.87 / 3600;
	const lon = 8 + 43 / 60 + 49.79 / 3600;
	const [E, N] = wgs84ToLv95(lat, lon);
	ok(
		Math.abs(E - 2699999.76) < 0.05 && Math.abs(N - 1099999.97) < 0.05,
		`LV95 worked example: ${E.toFixed(2)}, ${N.toFixed(2)}`,
	);
	const [la, lo] = lv95ToWgs84(E, N);
	const err = Math.hypot((la - lat) * 111e3, (lo - lon) * 77e3);
	ok(err < 1, `LV95 inverse round trip ${err.toFixed(3)} m`);
	// affine ENU→LV95 vs exact at 3 km
	const frame = new EnuFrame(46.7197, 7.7014, 0);
	const aff = enuToLv95Affine(frame);
	let worst = 0;
	for (const [e, n] of [
		[3000, 0],
		[-3000, 0],
		[0, 3000],
		[2121, -2121],
		[-2121, 2121],
	]) {
		const g = frame.toGeo(e, n, 0);
		const [Ex, Nx] = wgs84ToLv95(g.lat, g.lon);
		const [Ea, Na] = aff.map(e, n);
		worst = Math.max(worst, Math.hypot(Ex - Ea, Nx - Na));
	}
	ok(worst < 0.1, `ENU→LV95 affine vs exact at 3 km: ${worst.toFixed(3)} m`);
}

// ---------------------------------------------------------------- 4. occluder

function synthDsm(): NearDsm {
	const res = 2;
	const half = 200;
	const w = 2 * half + 1;
	const dsm = new Float32Array(w * w);
	const dtm = new Float32Array(w * w);
	const e0 = -half * res;
	const n0 = half * res;
	for (let j = 0; j < w; j++)
		for (let i = 0; i < w; i++) {
			const e = e0 + i * res;
			const n = n0 - j * res;
			const k = j * w + i;
			// ground rises 1:10 beyond 300 m north; hut 20 m tall at n∈[100,110], e∈[-10,10]; tree at 6 m east
			const g = n > 300 ? (n - 300) * 0.1 : 0;
			dtm[k] = g;
			dsm[k] = g;
			if (n >= 100 && n <= 110 && e >= -10 && e <= 10) dsm[k] = g + 20;
			if (Math.hypot(e - 6, n) < 3) dsm[k] = g + 15;
			if (n >= 330 && n <= 340 && e >= 150 && e <= 170) dsm[k] = g + 10; // hut behind a crest
		}
	return {
		frame: new EnuFrame(46.7, 7.7, 0),
		res,
		dsm,
		dtm,
		w,
		h: w,
		epoch: { dsm: 2024, dtm: 2025 },
		e0,
		n0,
		radiusM: 400,
		stats: {
			requests: 0,
			bytes: 0,
			stacRequests: 0,
			stacBytes: 0,
			ms: 0,
			fetchMs: 0,
			tiles: 0,
			dtmRes: 2,
		},
		years: { dsm: [2024], dtm: [2025] },
	};
}

{
	const d = synthDsm();
	const eye: [number, number, number] = [0, 0, 1.6];
	const north: [number, number, number] = [0, 1, 0];
	const h = objectHitRange(d, eye, north, 1e4);
	ok(
		Math.abs(h - 100) <= d.res,
		`hut due north: hit ${h.toFixed(2)} m (expect 100 ± one 2 m cell: bilinear edge)`,
	);
	const up = Math.sin((20 * Math.PI) / 180);
	const hUp = objectHitRange(d, eye, [0, Math.cos(Math.asin(up)), up], 1e4);
	ok(!Number.isFinite(hUp), `ray over the hut (20° up): ${hUp}`);
	const hShort = objectHitRange(d, eye, north, 90);
	ok(!Number.isFinite(hShort), "hit beyond maxT (terrain range 90 m) ignored");
	const east: [number, number, number] = [1, 0, 0];
	const hNear = objectHitRange(d, eye, east, 1e4);
	ok(
		!Number.isFinite(hNear),
		`tree 3–9 m east skipped by nearSkip 15 m: ${hNear}`,
	);
	const hNear0 = objectHitRange(d, eye, east, 1e4, { nearSkipM: 0 });
	ok(
		Math.abs(hNear0 - 3) < 1.2,
		`nearSkip 0 sees the tree at ${hNear0.toFixed(2)} m`,
	);
	// ray that dives into the rising ground before the hut behind the crest: no object
	const dir = [155, 335, 30 - 1.6];
	const L = Math.hypot(...dir);
	const hCrest = objectHitRange(
		d,
		eye,
		[dir[0] / L, dir[1] / L, dir[2] / L] as [number, number, number],
		1e4,
	);
	ok(
		!Number.isFinite(hCrest),
		`hut hidden under the terrain line not reported: ${hCrest}`,
	);

	// photo grid: parity when off, people, objects
	const cam: CameraX = {
		pose: { yaw: 0, pitch: 0, roll: 0, vfov: 30 },
		eye: [0, 0, 1.6],
		aspect: 4 / 3,
		intr: { ...IDENTITY_INTRINSICS },
	};
	const gw = 40;
	const gh = 30;
	const g: GeomBuffer = {
		w: gw,
		h: gh,
		xyz: new Float32Array(gw * gh * 3),
		range: Float32Array.from({ length: gw * gh }, (_, k) =>
			k < gw * 10 ? 0 : 200 + (k % 7),
		),
		sky: Uint8Array.from({ length: gw * gh }, (_, k) => (k < gw * 10 ? 1 : 0)),
	};
	const off = occluderRange(g, cam, null);
	let parity = 0;
	for (let k = 0; k < off.length; k++) {
		const want = g.sky[k] ? Number.POSITIVE_INFINITY : g.range[k];
		if (off[k] !== want) parity++;
		if (!g.sky[k] && occludedBy(g.range[k], off[k])) parity++;
	}
	ok(
		parity === 0,
		"dsm=null: occluder range == DEM range, nothing dims (parity when off)",
	);
	const people = new Uint8Array(gw * gh);
	people[gw * 20 + 5] = 255;
	const objects = new Float32Array(gw * gh);
	objects[gw * 20 + 6] = 12;
	const on = occluderRange(g, cam, d, objects, people);
	const kc = gw * 15 + gw / 2; // just below the horizon, looking north at the hut
	ok(
		on[gw * 20 + 5] === 0 && on[gw * 20 + 6] === 12,
		"people → 0 m, objects → their range",
	);
	ok(
		on[kc] < 110 && occludedBy(g.range[kc], on[kc]),
		`centre-row pixel occluded by the hut at ${on[kc].toFixed(1)} m (terrain ${g.range[kc]} m)`,
	);
	const t0 = performance.now();
	const big: GeomBuffer = {
		w: 320,
		h: 240,
		xyz: new Float32Array(320 * 240 * 3),
		range: new Float32Array(320 * 240).fill(390),
		sky: new Uint8Array(320 * 240),
	};
	occluderRange(big, cam, d);
	console.log(
		`info  occluderRange 320×240 on the synthetic DSM: ${(performance.now() - t0).toFixed(0)} ms`,
	);
}

// ---------------------------------------------------------------- live (optional)

if (process.argv.includes("--live")) {
	const d = await loadNearDsm(46.71966944444445, 7.701388888888889, 700, 2, {
		maxBytes: Number.POSITIVE_INFINITY,
	});
	ok(!!d, "live: IMG_7018 position resolves (inside CH)");
	if (d) {
		let n = 0;
		let obj = 0;
		for (let k = 0; k < d.dsm.length; k++) {
			const v = d.dsm[k] - d.dtm[k];
			if (!Number.isFinite(v)) continue;
			n++;
			if (v >= 2.5) obj++;
		}
		console.log(
			`info  live: ${d.stats.tiles} tiles, ${(d.stats.bytes / 1e6).toFixed(2)} MB, ${d.stats.ms.toFixed(0)} ms, years ${JSON.stringify(d.years)}, nDSM≥2.5 m on ${((100 * obj) / n).toFixed(1)}% of ${n} cells`,
		);
		ok(n > 0.5 * d.w * d.h * (Math.PI / 4), "live: grid mostly filled");
	}
	const outside = await loadNearDsm(44.4585, -70.8607, 700, 2);
	ok(outside === null, "live: a US position returns null without fetching");
}

console.log(fails ? `\n${fails} FAILED` : "\nall checks passed");
process.exit(fails ? 1 : 0);
