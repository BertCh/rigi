// Node emulation check of the GPU sky prep (src/lib/gpu/sky/prep*.ts), no GPU, no browser:
// the shader's u32 soft-float (prep-ref.ts) against native f64 / the CPU functions of sky/core.ts,
// compared with Object.is (and bit patterns) on every element.
//
//   npx tsx scripts/gpu/sky-prep-check.ts [--quick] [--photos N]
//
// Sections: 1 primitives vs native f64 (random, crafted ties, wide exponent gaps); 2 normalise vs
// core.normalise over f32 values; 3 the whole chain vs core rgbPlanes → resamplePlanes → normalise on
// synthetic images (noise, ramps, saturated, black/white) and real photos (public/photos, decoded with
// @napi-rs/canvas at the app's working size). Exit 1 on the first mismatch class.
import fs from "node:fs";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
	addF,
	axisTapsF64,
	constsTable,
	divF,
	fromF32,
	fromF64,
	mulF,
	normOne,
	prepRef,
	type SoftF,
	subF,
	toF32,
} from "../../src/lib/gpu/sky/prep-ref";
import {
	modelSize,
	normalise,
	resamplePlanes,
	rgbPlanes,
	workingSize,
} from "../../src/lib/sky/core";

const argv = process.argv.slice(2);
const QUICK = argv.includes("--quick");
const pi = argv.indexOf("--photos");
const MAX_PHOTOS = pi >= 0 ? Number(argv[pi + 1]) : 99;
const ROOT = path.resolve(import.meta.dirname, "../..");

let seed = 0x9e3779b9;
const rnd = () => {
	// xorshift32
	seed ^= seed << 13;
	seed >>>= 0;
	seed ^= seed >>> 17;
	seed ^= seed << 5;
	seed >>>= 0;
	return seed / 4294967296;
};
const ru = () => (rnd() * 4294967296) >>> 0;

const f64 = new Float64Array(1);
const w64 = new Uint32Array(f64.buffer);
const f32 = new Float32Array(1);
const w32 = new Uint32Array(f32.buffer);
const toSoft = (v: number): SoftF => {
	f64[0] = v;
	return fromF64(w64[0], w64[1]);
};
/** SoftF → the f64 it denotes (exact: M·2^e with M < 2^53; e kept in normal range by the tests) */
const toNum = (a: SoftF) => (a.h * 4294967296 + a.l) * 2 ** a.e;
const bits32 = (x: number) => {
	f32[0] = x;
	return w32[0];
};

let fails = 0;
const fail = (what: string, ...rest: unknown[]) => {
	fails++;
	if (fails < 30) console.error("MISMATCH", what, ...rest);
};
let checks = 0;
const eq = (what: string, got: number, want: number, ...ctx: unknown[]) => {
	checks++;
	if (!Object.is(got, want)) fail(what, got, want, ...ctx);
};

// random positive f64 with a controlled exponent window
const rf = (lo: number, hi: number) => {
	f64[0] = 0;
	w64[0] = ru();
	w64[1] =
		((1023 + lo + Math.floor(rnd() * (hi - lo + 1))) << 20) | (ru() & 0xfffff);
	return f64[0];
};
const rf32 = (lo: number, hi: number) => {
	w32[0] =
		((127 + lo + Math.floor(rnd() * (hi - lo + 1))) << 23) | (ru() & 0x7fffff);
	return f32[0];
};

// ───────────────── 1. primitives ─────────────────
const N = QUICK ? 200_000 : 3_000_000;
console.log(`1. primitives, ${N} random cases each`);
for (let i = 0; i < N; i++) {
	// products of f64 weights by f32 values (the resample's term)
	const w = rf(-30, 2);
	const s = rf32(-9, 0);
	eq("mul", toNum(mulF(toSoft(w), fromF32(bits32(s)))), w * s, w, s);
	// full 53x53 products (normalise)
	const a = rf(-3, 3);
	const b = rf(-3, 3);
	eq("mul53", toNum(mulF(toSoft(a), toSoft(b))), a * b, a, b);
	// sums, mixed magnitudes and wide gaps
	const x = rf(-20, 3);
	const y = rf(-60, 3);
	eq("add", toNum(addF(toSoft(x), toSoft(y))), x + y, x, y);
	// differences, close (Sterbenz), medium and far
	const u = rf(-2, 2);
	const v =
		i % 3 === 0
			? u * (0.5 + rnd())
			: i % 3 === 1
				? u * (1 - rnd() * 2 ** -rnd() * 30)
				: u * rnd() ** 8;
	if (v > 0 && v <= u)
		eq("sub", toNum(subF(toSoft(u), toSoft(v))), u - v, u, v);
	// quotients
	const p = rf(-10, 10);
	const q = rf(0, 12);
	eq("div", toNum(divF(toSoft(p), toSoft(q))), p / q, p, q);
	// f32 rounding of an f64
	const r = rf(-30, 30);
	const rb = toF32(toSoft(r));
	f32[0] = r;
	eq("f32", rb, w32[0], r);
}

// crafted: f64 values whose low 29 mantissa bits sit at / next to a tie, for the f32 round
for (let i = 0; i < (QUICK ? 50_000 : 500_000); i++) {
	w64[1] = ((1023 + Math.floor(rnd() * 40) - 20) << 20) | (ru() & 0xfffff);
	const tie = 1 << 28;
	w64[0] = (((ru() >>> 29) << 29) | (tie + (Math.floor(rnd() * 3) - 1))) >>> 0;
	const r = f64[0];
	f32[0] = r;
	eq("f32tie", toF32(toSoft(r)), w32[0], r);
}
// crafted: exact ties in sums (equal-magnitude operands, half-ulp partner) and exact quotients
for (let i = 0; i < (QUICK ? 50_000 : 500_000); i++) {
	const x = rf(-3, 3);
	f64[0] = x;
	const ulp = 2 ** (((w64[1] >>> 20) & 0x7ff) - 1075);
	const y =
		ulp *
		(0.5 + (Math.floor(rnd() * 5) - 2) * 2 ** -30) *
		(rnd() < 0.5 ? 1 : 2 ** Math.floor(rnd() * 3));
	eq("add-tie", toNum(addF(toSoft(x), toSoft(y))), x + y, x, y);
	if (y < x) eq("sub-tie", toNum(subF(toSoft(x), toSoft(y))), x - y, x, y);
	const d = rf(0, 8);
	const k = 1 + Math.floor(rnd() * 1000);
	eq("div-exact", toNum(divF(toSoft(d * k), toSoft(d))), (d * k) / d, d, k);
}

// crafted: products landing exactly on the half-ulp with (p0 != 0) and without (exact tie) lower bits
for (let n = 0; n < (QUICK ? 20_000 : 200_000); n++) {
	const i = 2 ** 25 + Math.floor(rnd() * 2 ** 25);
	const j = Math.ceil(2 ** 51 / i);
	const a = (2 ** 52 + i) / 2 ** 52;
	const b = (2 ** 52 + j) / 2 ** 52;
	eq("mul-halfplus", toNum(mulF(toSoft(a), toSoft(b))), a * b, a, b);
	const k = 1 + Math.floor(rnd() * 50);
	const a2 =
		(2 ** 52 +
			2 ** k +
			(rnd() < 0.5 ? 0 : 2 ** (k + 1) * Math.floor(rnd() * 4))) /
		2 ** 52;
	const b2 = (2 ** 52 + 2 ** (51 - k)) / 2 ** 52;
	eq("mul-tie", toNum(mulF(toSoft(a2), toSoft(b2))), a2 * b2, a2, b2);
}

// ───────────────── 2. normalise ─────────────────
console.log("2. normalise vs core.normalise");
{
	const NN = QUICK ? 300_000 : 6_000_000;
	const k = constsTable([0, 0], [0, 0]);
	const xs = new Float32Array(NN);
	for (let i = 0; i < NN; i++) {
		// all f32 in 0..1 (uniform over bit patterns => log-uniform values), plus u8/255 and windows near the means
		xs[i] =
			i % 4 === 0
				? Math.fround(Math.floor(rnd() * 256) / 255)
				: i % 4 === 1
					? Math.fround(
							[0.485, 0.456, 0.406][i % 3] * (1 + (rnd() - 0.5) * 1e-3),
						)
					: rf32(-12, -1);
	}
	for (let c = 0; c < 3; c++) {
		const want = normalise(
			(() => {
				const pl = new Float32Array(3 * NN);
				pl.set(xs, c * NN);
				return pl;
			})(),
			NN,
		).subarray(c * NN, (c + 1) * NN);
		for (let i = 0; i < NN; i++)
			eq(
				"normalise",
				f32FromBits(normOne(bits32(xs[i]), k, c)),
				want[i],
				c,
				xs[i],
			);
	}
	// every byte/255 and its neighbours, exhaustively
	for (let c = 0; c < 3; c++)
		for (let d = 0; d < 256; d++)
			for (const dx of [-1, 0, 1]) {
				const x = Math.fround(d / 255);
				w32[0] = (bits32(x) + dx) >>> 0;
				const xv = f32[0];
				if (!(xv >= 0 && xv <= 1)) continue;
				const pl = new Float32Array(3);
				pl[c] = xv;
				eq(
					"normalise-u8",
					f32FromBits(normOne(bits32(xv), k, c)),
					normalise(pl, 1)[c],
					c,
					xv,
				);
			}
}
function f32FromBits(b: number) {
	w32[0] = b;
	return f32[0];
}

// ───────────────── 3. the whole chain ─────────────────
console.log("3. chain vs core.rgbPlanes → resamplePlanes → normalise");
function chain(
	name: string,
	rgba: Uint8Array,
	W: number,
	H: number,
	longSide: number,
) {
	const { width: lw, height: lh } = modelSize(W, H, longSide);
	if (lw > W || lh > H) {
		console.log(
			`   ${name}: skipped (upsampling ${W}x${H} -> ${lw}x${lh}: CPU path)`,
		);
		return;
	}
	const rgb = resamplePlanes(
		rgbPlanes({ width: W, height: H, data: rgba }),
		W,
		H,
		3,
		lw,
		lh,
	);
	const inp = normalise(rgb, lw * lh);
	const t0 = performance.now();
	const got = prepRef(rgba, W, H, lw, lh);
	let bad = 0;
	for (let i = 0; i < rgb.length; i++) {
		checks += 2;
		if (
			!Object.is(f32FromBits(got.lo[i]), rgb[i]) ||
			got.lo[i] !== bits32(rgb[i])
		)
			bad++;
		if (
			!Object.is(f32FromBits(got.inp[i]), inp[i]) ||
			got.inp[i] !== bits32(inp[i])
		)
			bad++;
	}
	if (bad)
		fail(`chain ${name} ${W}x${H}->${lw}x${lh}`, `${bad} elements differ`);
	console.log(
		`   ${name}: ${W}x${H} -> ${lw}x${lh} ${bad ? "FAIL" : "ok"} (${Math.round(performance.now() - t0)} ms emulated)`,
	);
}
const synth = (
	W: number,
	H: number,
	f: (x: number, y: number, c: number) => number,
) => {
	const a = new Uint8Array(4 * W * H);
	for (let y = 0; y < H; y++)
		for (let x = 0; x < W; x++)
			for (let c = 0; c < 4; c++)
				a[4 * (y * W + x) + c] = c === 3 ? 255 : f(x, y, c) & 255;
	return a;
};
const sizes: [number, number, number][] = [
	[1024, 683, 512],
	[683, 1024, 512],
	[1000, 667, 512],
	[777, 1031, 512],
	[1024, 768, 384],
	[600, 450, 512],
	[513, 512, 512],
	[1024, 1024, 512],
];
for (const [W, H, ls] of sizes) {
	chain(
		"noise",
		synth(W, H, () => Math.floor(rnd() * 256)),
		W,
		H,
		ls,
	);
	if (QUICK) continue;
	chain(
		"ramp",
		synth(W, H, (x, y, c) => (x * 255) / W + c * y),
		W,
		H,
		ls,
	);
	chain(
		"sat",
		synth(W, H, (x, y) => (((x >> 3) + (y >> 3)) % 2 ? 255 : 0)),
		W,
		H,
		ls,
	);
	chain(
		"white",
		synth(W, H, () => 255),
		W,
		H,
		ls,
	);
	chain(
		"black",
		synth(W, H, () => 0),
		W,
		H,
		ls,
	);
}
{
	const dir = path.join(ROOT, "public/photos");
	const files = fs.existsSync(dir)
		? fs
				.readdirSync(dir)
				.filter((f) => /\.jpe?g$/i.test(f))
				.sort()
		: [];
	let n = 0;
	for (const f of files) {
		if (n++ >= MAX_PHOTOS) break;
		const img = await loadImage(path.join(dir, f));
		const { width: W, height: H } = workingSize(img.width, img.height, 1024);
		const cv = createCanvas(W, H);
		const ctx = cv.getContext("2d");
		ctx.drawImage(img, 0, 0, W, H);
		const px = ctx.getImageData(0, 0, W, H).data;
		chain(
			f,
			new Uint8Array(px.buffer, px.byteOffset, px.byteLength),
			W,
			H,
			512,
		);
		if (!QUICK)
			chain(
				`${f}@384`,
				new Uint8Array(px.buffer, px.byteOffset, px.byteLength),
				W,
				H,
				384,
			);
	}
	if (!files.length)
		console.log("   (no public/photos: real-photo section skipped)");
}
// the tap tables themselves: same tap lists as core's loops (spot check of the table builder)
{
	const t = axisTapsF64(1024, 512);
	if (t.table[1] !== 2) fail("taps 1024->512 count", t.table[1]);
}

console.log(`${checks} comparisons, ${fails} mismatches`);
process.exit(fails ? 1 : 0);
