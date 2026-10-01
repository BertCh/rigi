// Exact u32 emulation of the sky prep's float64 chain (sky/core.ts resamplePlanes + normalise), and
// the CPU-side tables the GPU kernels (prep.wgsl.ts) read. WGSL has no f64, and the CPU path is an
// f64 chain stored through f32 (see the file header of prep.wgsl.ts for the argument), so the kernels
// carry a small soft-float: values are positive magnitudes M·2^e with M a 53-bit integer in two u32
// words (h: top 21 bits, l: low 32), 2^52 ≤ M < 2^53, or zero (h = l = 0). Every function here is
// written with u32 operations only (`>>> 0` after each wrap, shifts by < 32, carries by compare), in
// the same order as the WGSL functions of the same name, so the node check
// (scripts/gpu/sky-prep-check.ts) exercises the algorithm the shader runs. JS and WGSL shift
// operators agree: the count is taken modulo 32, which both versions rely on nowhere (every shift is
// guarded to 0..31).

export interface SoftF {
	h: number;
	l: number;
	e: number;
}

const U = (x: number) => x >>> 0;
const ZERO = (): SoftF => ({ h: 0, l: 0, e: 0 });
const isZero = (a: SoftF) => (a.h | a.l) === 0;

/** a·b as [lo, hi] u32 words, from 16-bit limbs (WGSL has no mulhi). */
export function mulFull(a: number, b: number): [number, number] {
	const a0 = a & 0xffff;
	const a1 = a >>> 16;
	const b0 = b & 0xffff;
	const b1 = b >>> 16;
	const p00 = U(Math.imul(a0, b0));
	const p01 = U(Math.imul(a0, b1));
	const p10 = U(Math.imul(a1, b0));
	const p11 = U(Math.imul(a1, b1));
	const mid = U((p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff));
	const lo = U(((mid & 0xffff) << 16) | (p00 & 0xffff));
	const hi = U(p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16));
	return [lo, hi];
}

/** Round-to-nearest-even increment of a 53-bit mantissa (renormalises a carry out of bit 52). */
function inc(h: number, l: number, e: number): SoftF {
	l = U(l + 1);
	if (l === 0) h = U(h + 1);
	if (h === 0x200000) return { h: 0x100000, l: 0, e: e + 1 };
	return { h, l, e };
}

/** IEEE f32 bits (positive, normal; zero and subnormals read as zero) → SoftF. */
export function fromF32(bits: number): SoftF {
	if ((bits & 0x7fffffff) < 0x00800000) return ZERO();
	const m24 = U((bits & 0x7fffff) | 0x800000);
	const f = (bits >>> 23) & 0xff;
	return { h: m24 >>> 3, l: U(m24 << 29), e: f - 150 - 29 };
}

/** IEEE f64 words (positive, normal; zero reads as zero) → SoftF. */
export function fromF64(lo: number, hi: number): SoftF {
	const f = (hi >>> 20) & 0x7ff;
	if (f === 0) return ZERO();
	return { h: U((hi & 0xfffff) | 0x100000), l: U(lo), e: f - 1075 };
}

/** fl64(a·b) */
export function mulF(a: SoftF, b: SoftF): SoftF {
	if (isZero(a) || isZero(b)) return ZERO();
	const ll = mulFull(a.l, b.l);
	const lh = mulFull(a.l, b.h);
	const hl = mulFull(a.h, b.l);
	const hh = mulFull(a.h, b.h);
	const p0 = ll[0];
	let p1 = U(ll[1] + lh[0]);
	let c1 = p1 < ll[1] ? 1 : 0;
	const p1b = U(p1 + hl[0]);
	c1 += p1b < p1 ? 1 : 0;
	p1 = p1b;
	let p2 = U(lh[1] + hl[1]);
	let c2 = p2 < lh[1] ? 1 : 0;
	let t = U(p2 + hh[0]);
	c2 += t < p2 ? 1 : 0;
	p2 = t;
	t = U(p2 + c1);
	c2 += t < p2 ? 1 : 0;
	p2 = t;
	const p3 = U(hh[1] + c2);
	// P = Ma·Mb in [2^104, 2^106): bit 105 is p3 bit 9
	const top = (p3 >>> 9) & 1;
	const sh1 = 20 + top;
	const l = U((p1 >>> sh1) | (p2 << (32 - sh1)));
	const h = U((p2 >>> sh1) | (p3 << (32 - sh1)));
	const rem = p1 & ((1 << sh1) - 1);
	const half = 1 << (sh1 - 1);
	const e = a.e + b.e + 52 + top;
	const up = rem > half || (rem === half && (p0 !== 0 || (l & 1) === 1));
	return up ? inc(h, l, e) : { h, l, e };
}

/** (lo, hi) >> d with the lost bits ORed into bit 0 (d ≥ 0, any size). */
function shrSticky(lo: number, hi: number, d: number): [number, number] {
	if (d === 0) return [lo, hi];
	if (d >= 64) return [(lo | hi) !== 0 ? 1 : 0, 0];
	if (d >= 32) {
		const k = d - 32;
		const nl = k === 0 ? hi : hi >>> k;
		const lost = lo !== 0 || (hi & ((1 << k) - 1)) !== 0 ? 1 : 0;
		return [U(nl | lost), 0];
	}
	const nl = U((lo >>> d) | (hi << (32 - d)));
	const lost = (lo & ((1 << d) - 1)) !== 0 ? 1 : 0;
	return [U(nl | lost), hi >>> d];
}

/** (lo, hi) << k, 0 ≤ k < 64 */
function shl64(lo: number, hi: number, k: number): [number, number] {
	if (k === 0) return [lo, hi];
	if (k >= 32) return [0, U(lo << (k - 32))];
	return [U(lo << k), U((hi << k) | (lo >>> (32 - k)))];
}

/**
 * fl64(a + b), or fl64(a − b) when `sub` (needs a ≥ b). Three guard bits (guard, round, sticky), the
 * classic IEEE add/sub: the smaller operand is shifted right with its lost bits ORed into bit 0.
 */
function addSub(a: SoftF, b: SoftF, sub: boolean): SoftF {
	if (isZero(b)) return a;
	if (isZero(a)) return b; // add only (a ≥ b in a subtraction)
	if (a.e < b.e) [a, b] = [b, a]; // add only
	const d = a.e - b.e;
	const xl = U(a.l << 3);
	const xh = U((a.h << 3) | (a.l >>> 29));
	const y0l = U(b.l << 3);
	const y0h = U((b.h << 3) | (b.l >>> 29));
	const [yl, yh] = shrSticky(y0l, y0h, d);
	let sl: number;
	let sh: number;
	if (sub) {
		sl = U(xl - yl);
		sh = U(xh - yh - (xl < yl ? 1 : 0));
	} else {
		sl = U(xl + yl);
		sh = U(xh + yh + (sl < xl ? 1 : 0));
	}
	let e = a.e;
	if (sub) {
		if ((sl | sh) === 0) return ZERO();
		const lz = sh !== 0 ? Math.clz32(sh) : 32 + Math.clz32(sl);
		const k = lz - 8; // lead bit to 55
		[sl, sh] = shl64(sl, sh, k);
		e -= k;
	} else if ((sh >>> 24) & 1) {
		const lost = sl & 1;
		sl = U((sl >>> 1) | (sh << 31) | lost);
		sh >>>= 1;
		e += 1;
	}
	const l = U((sl >>> 3) | (sh << 29));
	const h = sh >>> 3;
	const low3 = sl & 7;
	const up = low3 > 4 || (low3 === 4 && (l & 1) === 1);
	return up ? inc(h, l, e) : { h, l, e };
}
export const addF = (a: SoftF, b: SoftF) => addSub(a, b, false);
export const subF = (a: SoftF, b: SoftF) => addSub(a, b, true);

/** fl64(a / b): 55-bit restoring division, remainder as sticky. */
export function divF(a: SoftF, b: SoftF): SoftF {
	if (isZero(a)) return ZERO();
	let rl = a.l;
	let rh = a.h;
	let ql = 0;
	let qh = 0;
	for (let i = 0; i < 55; i++) {
		const ge = rh > b.h || (rh === b.h && rl >= b.l);
		if (ge) {
			const nl = U(rl - b.l);
			rh = U(rh - b.h - (rl < b.l ? 1 : 0));
			rl = nl;
		}
		qh = U((qh << 1) | (ql >>> 31));
		ql = U((ql << 1) | (ge ? 1 : 0));
		rh = U((rh << 1) | (rl >>> 31));
		rl = U(rl << 1);
	}
	const sticky = (rl | rh) !== 0;
	const g = (qh >>> 22) & 1 ? 2 : 1; // Q = floor(ρ·2^54) has 55 or 54 bits
	const l = U((ql >>> g) | (qh << (32 - g)));
	const h = qh >>> g;
	const rbits = ql & ((1 << g) - 1);
	const half = 1 << (g - 1);
	const e = a.e - b.e - 54 + g;
	const up = rbits > half || (rbits === half && (sticky || (l & 1) === 1));
	return up ? inc(h, l, e) : { h, l, e };
}

/** fround of a positive SoftF as f32 bits (round-to-nearest-even; NaN bits if out of f32's normal range). */
export function toF32(a: SoftF): number {
	if (isZero(a)) return 0;
	const low29 = a.l & 0x1fffffff;
	let m24 = U((a.h << 3) | (a.l >>> 29));
	const half = 1 << 28;
	if (low29 > half || (low29 === half && (m24 & 1) === 1)) m24 = U(m24 + 1);
	let e = a.e + 29;
	if (m24 === 0x1000000) {
		m24 = 0x800000;
		e += 1;
	}
	const f = e + 23 + 127;
	if (f < 1 || f > 254) return 0x7fc00000;
	return U((f << 23) | (m24 & 0x7fffff));
}

// ───────────────────────────── CPU-side tables ─────────────────────────────

/** f64 → [lo, hi] words */
export function f64Words(v: number): [number, number] {
	const f = new Float64Array([v]);
	const u = new Uint32Array(f.buffer);
	return [u[0], u[1]]; // little-endian, as every browser JS engine
}

/**
 * The taps of sky/core.ts resampleAxis for ONE axis (n → m, n ≥ m): output j reads
 * i = floor(j·scale) … min(n, ceil(j·scale + scale)) − 1 with the weight min(b, i+1) − max(a, i), all
 * f64 exactly as the CPU computes them. n = m (scale 1: the CPU's bilinear branch with f = 0, which
 * returns src[j] exactly) is one tap of weight 1. Table: (start, count) per output, then taps as
 * (index, w lo, w hi).
 */
export function axisTapsF64(n: number, m: number) {
	if (n < m) throw new Error("axisTapsF64: upsampling is not supported");
	const scale = n / m;
	const per: number[][] = [];
	for (let j = 0; j < m; j++) {
		const t: number[] = [];
		if (scale > 1) {
			const a = j * scale;
			const b = a + scale;
			const i0 = Math.floor(a);
			const i1 = Math.min(n, Math.ceil(b));
			for (let i = i0; i < i1; i++)
				t.push(i, ...f64Words(Math.min(b, i + 1) - Math.max(a, i)));
		} else t.push(j, ...f64Words(1));
		per.push(t);
	}
	const table = new Uint32Array(2 * m + per.reduce((s, t) => s + t.length, 0));
	let at = 2 * m;
	per.forEach((t, j) => {
		table[2 * j] = at;
		table[2 * j + 1] = t.length / 3;
		table.set(t, at);
		at += t.length;
	});
	const [scaleLo, scaleHi] = f64Words(scale > 1 ? scale : 1);
	return { table, scaleLo, scaleHi };
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/**
 * Constants word table: [scaleH lo, hi, scaleV lo, hi, (mean_c lo, hi) ×3, (1/std_c lo, hi) ×3], the
 * f64 values the CPU's normalise uses (`1 / STD[c]` is computed in f64 here, as there).
 */
export function constsTable(
	hScale: [number, number],
	vScale: [number, number],
): Uint32Array {
	const t: number[] = [...hScale, ...vScale];
	for (const m of MEAN) t.push(...f64Words(m));
	for (const s of STD) t.push(...f64Words(1 / s));
	return new Uint32Array(t);
}

// ───────────────────── reference kernels (the WGSL, on the CPU) ─────────────────────

/** One weighted-sum output: toF32(divF(Σ w·s, scale)) over the taps `table[start..]`, s read by `src`. */
function tapSum(
	table: Uint32Array,
	j: number,
	scale: SoftF,
	src: (i: number) => number,
): number {
	const start = table[2 * j];
	const count = table[2 * j + 1];
	let acc = ZERO();
	for (let t = 0; t < count; t++) {
		const o = start + 3 * t;
		const w = fromF64(table[o + 1], table[o + 2]);
		acc = addF(acc, mulF(w, fromF32(src(table[o]))));
	}
	return toF32(divF(acc, scale));
}

const f32Bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0];

/**
 * The prep chain on the CPU in the shader's arithmetic: RGBA bytes (W×H) → { rgbLo planar f32 bits,
 * model input normalised f32 bits } at lw × lh. Mirrors K_PREP_H, K_PREP_V and K_PREP_NORM.
 */
export function prepRef(
	rgba: Uint8Array | Uint8ClampedArray,
	W: number,
	H: number,
	lw: number,
	lh: number,
) {
	const ax = axisTapsF64(W, lw);
	const ay = axisTapsF64(H, lh);
	const k = constsTable([ax.scaleLo, ax.scaleHi], [ay.scaleLo, ay.scaleHi]);
	const sH = fromF64(k[0], k[1]);
	const sV = fromF64(k[2], k[3]);
	const lut = new Uint32Array(256);
	for (let d = 0; d < 256; d++) lut[d] = f32Bits(d / 255);
	const n = lw * lh;
	const tmp = new Uint32Array(3 * H * lw);
	for (let c = 0; c < 3; c++)
		for (let y = 0; y < H; y++)
			for (let j = 0; j < lw; j++)
				tmp[(c * H + y) * lw + j] = tapSum(
					ax.table,
					j,
					sH,
					(i) => lut[rgba[4 * (y * W + i) + c]],
				);
	const lo = new Uint32Array(3 * n);
	for (let c = 0; c < 3; c++)
		for (let j = 0; j < lh; j++)
			for (let x = 0; x < lw; x++)
				lo[(c * lh + j) * lw + x] = tapSum(
					ay.table,
					j,
					sV,
					(i) => tmp[(c * H + i) * lw + x],
				);
	const inp = new Uint32Array(3 * n);
	for (let idx = 0; idx < 3 * n; idx++) {
		const c = Math.floor(idx / n);
		inp[idx] = normOne(lo[idx], k, c);
	}
	return { lo, inp };
}

/** (x − mean_c) · (1/std_c) → f32 bits, x an f32 in 0..1 (bits). */
export function normOne(xbits: number, k: Uint32Array, c: number): number {
	const x = fromF32(xbits);
	const m = fromF64(k[4 + 2 * c], k[5 + 2 * c]);
	const s = fromF64(k[10 + 2 * c], k[11 + 2 * c]);
	let mag: SoftF;
	let neg = false;
	if (isZero(x)) {
		mag = m;
		neg = true;
	} else if (
		x.e > m.e ||
		(x.e === m.e && (x.h > m.h || (x.h === m.h && x.l >= m.l)))
	) {
		mag = subF(x, m);
	} else {
		mag = subF(m, x);
		neg = true;
	}
	const bits = toF32(mulF(mag, s));
	return bits !== 0 && neg ? U(bits | 0x80000000) : bits;
}
