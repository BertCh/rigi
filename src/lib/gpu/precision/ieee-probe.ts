// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The strict-IEEE probe for certified-f32 GPU stages (precision decision P1): one small kernel per
// device that checks the f32 arithmetic the double-f32 error budgets (./df32.ts) assume. A stage that
// certifies f32 GPU results calls probeStrictIeee(device) first and runs its exact f64 path everywhere
// when the verdict is not ok.
//
//   const probe = await probeStrictIeee(device);   // cached per device; never rejects
//   if (!probe.ok) return f64Path();
//
// Checked on PROBE_N deterministic records (wide exponents, cancellations, tiny addends, near ties):
// - add, mul, fma (fused: one rounding), TwoSum, FastTwoSum and TwoProd bit for bit against the
//   emulation (a fast-math re-association or an unfused fma fails here);
// - f32 division and sqrt within PROBE_MAX_ULPS (4) of correctly rounded (WGSL: division 2.5 ULP; sqrt
//   inherits 1/inverseSqrt's accuracy, about 4.5 ULP, so a conforming device may fail here: that only
//   costs the f64 path);
// - extra records at magnitudes up to 2^24, exponents ±60, and subnormal operands / results, where both
//   IEEE gradual underflow and flush-to-zero (which WGSL allows) are accepted;
// - df32 add / mul / div / sqrt within their budgets against f64.
// It tests samples, and only its own shader module: fma fusion and flushing are decided per compiled
// shader, so a stage must also spot-check its own outputs (horizon: certified.ts spotCheckA / C, 64
// outputs per call against the emulation). A pass is evidence about the device, not a proof. The node check
// ieee-probe.check.ts shows the verifier rejects a re-associated TwoSum, an unfused fma and an
// 8-ULP division.
//
// Users: src/lib/gpu/horizon/certified.ts. Graph group "precision-probe" (app-graph manifest).
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import { pooledStorage, pooledUniform, withLease } from "#/lib/gpu/core/pool";
import {
	bits32,
	DF32_WGSL,
	ddAdd,
	ddDiv,
	ddMul,
	ddSqrt,
	div32,
	EPS_ADD,
	EPS_DIV,
	EPS_MUL,
	EPS_SQRT,
	fastTwoSum,
	flushSubnormals,
	fma32,
	fr,
	ftz32,
	MIN_NORMAL32,
	setFlushSubnormals,
	split,
	sqrt32,
	twoProd,
	twoSum,
	withExactDivSqrt,
} from "./df32";

/** Probe record sizes (f32): inputs a, b, c, xh, xl, yh, yl, 0; outputs see PROBE_WGSL. */
export const PROBE_IN = 8;
export const PROBE_OUT = 20;
export const PROBE_N = 4096;
/** ULP budget the bounds assume for the f32 division and sqrt (WGSL: 2.5 ULP division, ~4.5 ULP sqrt). */
export const PROBE_MAX_ULPS = 4;

/** Deterministic probe inputs: wide exponents, cancellations, near-ties for TwoSum / TwoProd. */
export function probeInputs(n = PROBE_N): Float32Array {
	let s = 0x9e3779b9;
	const rnd = () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	const num = (lo: number, hi: number) =>
		(rnd() < 0.5 ? -1 : 1) *
		(1 + rnd()) *
		2 ** Math.floor(lo + (hi - lo) * rnd());
	const f = Math.fround; // host-side values, never the emulated machine
	const out = new Float32Array(n * PROBE_IN);
	for (let i = 0; i < n; i++) {
		let a = f(num(-20, 20));
		let b = f(num(-20, 20));
		const kind = i % 8;
		if (kind === 1) b = f(-a * (1 + (rnd() - 0.5) * 2 ** -20)); // cancellation
		if (kind === 2) b = f(a * 2 ** -(10 + Math.floor(rnd() * 20))); // tiny addend
		if (kind === 3) a = f(1 + Math.floor(rnd() * 2 ** 23) * 2 ** -23);
		if (kind === 4) {
			// magnitudes up to 2^24 (ECEF-sized metres; integers where the ULP is 1 or 2)
			a = f((rnd() < 0.5 ? -1 : 1) * Math.floor(rnd() * 2 ** 24));
			b = f(num(18, 24));
		}
		if (kind === 5) {
			// wide exponents: products and quotients far from 1
			a = f(num(-60, 60));
			b = f(num(-60, 60));
		}
		if (kind === 6) a = f(num(-149, -127)); // a subnormal operand
		if (kind === 7) {
			// normal operands with subnormal sums / products
			a = f(num(-70, -64));
			b = f(num(-70, -64));
		}
		const c =
			kind === 7
				? f(-a * b * (1 + (rnd() - 0.5) * 2 ** -10))
				: f(-f(a * b) * (1 + (rnd() - 0.5) * 2 ** -22));
		const x = split(kind === 4 ? num(18, 24) : num(-10, 10));
		let y = split(kind === 4 ? num(-4, 24) : num(-10, 10));
		if (kind === 1) y = split(-(x[0] + x[1]) * (1 + (rnd() - 0.5) * 2 ** -30));
		out.set([a, b, c, x[0], x[1], y[0], y[1], 0], i * PROBE_IN);
	}
	return out;
}

/** What PROBE_WGSL writes, on the emulated machine. */
export function emuProbe(pin: Float32Array): Float32Array {
	const n = pin.length / PROBE_IN;
	const out = new Float32Array(n * PROBE_OUT);
	const tiny = fr(1e-9);
	for (let i = 0; i < n; i++) {
		const [a, b, c, xh, xl, yh, yl] = pin.subarray(i * PROBE_IN);
		const ts = twoSum(a, b);
		const tp = twoProd(a, b);
		const s = ddAdd(xh, xl, yh, yl);
		const m = ddMul(xh, xl, yh, yl);
		const q = ddDiv(xh, xl, yh, yl);
		const r = ddSqrt(Math.abs(xh), Math.abs(xl)); // WGSL abs(vec2) is per component
		const fs = fastTwoSum(a, fr(b * tiny));
		out.set(
			[
				fr(a + b),
				fr(a * b),
				fma32(a, b, c),
				div32(a, b),
				sqrt32(Math.abs(a)),
				ts[0],
				ts[1],
				tp[0],
				tp[1],
				s[0],
				s[1],
				m[0],
				m[1],
				q[0],
				q[1],
				r[0],
				r[1],
				fs[0],
				fs[1],
				0,
			],
			i * PROBE_OUT,
		);
	}
	return out;
}

/** ULPs between two f32 values on the ordered integer line (±0 coincide; crossing zero is fine). */
const ulpDistance = (a: number, b: number) => {
	if (a === b) return 0;
	if (!Number.isFinite(a) || !Number.isFinite(b))
		return Number.POSITIVE_INFINITY;
	const key = (v: number) => (v < 0 ? -bits32(-v) : bits32(Math.abs(v)));
	return Math.abs(key(a) - key(b));
};

export type ProbeVerdict = {
	ok: boolean;
	n: number;
	/** mismatching records per check */
	failures: Record<string, number>;
	/** worst observed error per check (ULP for div / sqrt, units of the budget for the df32 ops) */
	worst: Record<string, number>;
};

/**
 * Checks a device's probe output: correctly rounded add / mul, fused fma and exact error-free
 * transformations (bit for bit against the emulation), division / sqrt within PROBE_MAX_ULPS, and the
 * df32 add / mul / div / sqrt within their budgets against f64.
 */
export function verifyProbe(
	pin: Float32Array,
	pout: Float32Array,
): ProbeVerdict {
	const n = pin.length / PROBE_IN;
	const failures: Record<string, number> = {};
	const worst: Record<string, number> = {};
	const bad = (k: string) => {
		failures[k] = (failures[k] ?? 0) + 1;
	};
	const see = (k: string, v: number) => {
		worst[k] = Math.max(worst[k] ?? 0, v);
	};
	const exact = new Map<number, string>([
		[0, "add"],
		[1, "mul"],
		[2, "fma"],
		[5, "twoSum"],
		[6, "twoSum"],
		[7, "twoProd"],
		[8, "twoProd"],
		[17, "fastTwoSum"],
		[18, "fastTwoSum"],
	]);
	// two references: IEEE gradual underflow, and flush-to-zero (inputs and results), which WGSL allows
	const ref = withExactDivSqrt(() => emuProbe(pin));
	const was = flushSubnormals();
	setFlushSubnormals(true);
	const refFtz = withExactDivSqrt(() => emuProbe(pin.map(ftz32)));
	setFlushSubnormals(was);
	const f = Math.fround;
	const sub = (v: number) => v !== 0 && Math.abs(v) < MIN_NORMAL32;
	for (let i = 0; i < n; i++) {
		const o = i * PROBE_OUT;
		const inp = pin.subarray(i * PROBE_IN, (i + 1) * PROBE_IN);
		// a record touching subnormals (an input or an IEEE result): either behaviour is accepted
		const touchy = inp.some(sub) || ref.subarray(o, o + PROBE_OUT).some(sub);
		const same = (k: number, r: Float32Array) =>
			bits32(pout[o + k]) === bits32(r[o + k]);
		for (const [k, name] of exact)
			if (!same(k, ref) && !(touchy && same(k, refFtz))) bad(name);
		const [a, b, , xh, xl, yh, yl] = inp;
		const ulps = (k: number, r: number, rf: number) =>
			Math.min(
				ulpDistance(pout[o + k], r),
				touchy ? ulpDistance(pout[o + k], rf) : Number.POSITIVE_INFINITY,
			);
		const ud = ulps(3, f(a / b), ftz32(f(ftz32(a) / ftz32(b))));
		see("divUlp", ud);
		if (ud > PROBE_MAX_ULPS) bad("div");
		const us = ulps(
			4,
			f(Math.sqrt(Math.abs(a))),
			ftz32(f(Math.sqrt(Math.abs(ftz32(a))))),
		);
		see("sqrtUlp", us);
		if (us > PROBE_MAX_ULPS) bad("sqrt");
		if (touchy) continue; // relative df32 errors near the underflow threshold are not budgeted
		const x = xh + xl;
		const y = yh + yl;
		const rel = (k: number, r: number, eps: number, name: string) => {
			const v = pout[o + k] + pout[o + k + 1];
			const e = Math.abs(v - r) / Math.abs(r);
			see(name, e / eps);
			if (!(e <= eps + 2 ** -52)) bad(name);
		};
		rel(9, x + y, EPS_ADD, "ddAdd");
		rel(11, x * y, EPS_MUL, "ddMul");
		rel(13, x / y, EPS_DIV, "ddDiv");
		rel(15, Math.sqrt(Math.abs(xh) + Math.abs(xl)), EPS_SQRT, "ddSqrt");
	}
	return { ok: Object.keys(failures).length === 0, n, failures, worst };
}

// ---------- the kernel and the host ----------

export const PROBE_WGSL = /* wgsl */ `
struct U {
	n: u32,
	/** always 0 (opq) */
	zero: u32,
	_a: u32,
	_b: u32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> pin: array<f32>;
@group(0) @binding(2) var<storage, read_write> pout: array<f32>;
${DF32_WGSL}
@compute @workgroup_size(64, 1, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	ZERO = u.zero;
	let i = gid.x;
	if (i >= u.n) { return; }
	let b = ${PROBE_IN}u * i;
	let a = pin[b];
	let bb = pin[b + 1u];
	let c = pin[b + 2u];
	let x = vec2<f32>(pin[b + 3u], pin[b + 4u]);
	let y = vec2<f32>(pin[b + 5u], pin[b + 6u]);
	let o = ${PROBE_OUT}u * i;
	pout[o] = opq(a + bb);
	pout[o + 1u] = opq(a * bb);
	pout[o + 2u] = opq(fma(a, bb, c));
	pout[o + 3u] = opq(a / bb);
	pout[o + 4u] = opq(sqrt(abs(a)));
	let ts = twoSum(a, bb);
	pout[o + 5u] = ts.x;
	pout[o + 6u] = ts.y;
	let tp = twoProd(a, bb);
	pout[o + 7u] = tp.x;
	pout[o + 8u] = tp.y;
	let s = ddAdd(x, y);
	pout[o + 9u] = s.x;
	pout[o + 10u] = s.y;
	let m = ddMul(x, y);
	pout[o + 11u] = m.x;
	pout[o + 12u] = m.y;
	let q = ddDiv(x, y);
	pout[o + 13u] = q.x;
	pout[o + 14u] = q.y;
	let r = ddSqrt(abs(x));
	pout[o + 15u] = r.x;
	pout[o + 16u] = r.y;
	let fs = fastTwoSum(a, opq(bb * 1e-9));
	pout[o + 17u] = fs.x;
	pout[o + 18u] = fs.y;
	pout[o + 19u] = 0.0;
}
`;

const GROUP = "precision-probe";
const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;
const STORAGE = Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC;

export const K_IEEE_PROBE = defineKernel(
	"precision-ieee-probe",
	PROBE_WGSL,
	[
		["u", "uniform"],
		["pin", "read-only-storage"],
		["pout", "storage"],
	],
	{ group: GROUP, label: "precision-ieee-probe" },
);

export type IeeeProbe = ProbeVerdict & { ms: number; error?: string };
const probes = new WeakMap<Device, Promise<IeeeProbe>>();

/**
 * The device's verdict, computed once per device (one graph run, ~100 KB in and out). Resolves
 * { ok: false } on a failed check or a GPU error; never rejects.
 */
export function probeStrictIeee(device: Device): Promise<IeeeProbe> {
	let p = probes.get(device);
	if (!p) {
		p = runProbe(device).catch(
			(e): IeeeProbe => ({
				ok: false,
				n: 0,
				failures: {},
				worst: {},
				ms: 0,
				error: String(e),
			}),
		);
		probes.set(device, p);
	}
	return p;
}

async function runProbe(device: Device): Promise<IeeeProbe> {
	const t0 = performance.now();
	const pin = probeInputs();
	const n = pin.length / PROBE_IN;
	const pout = await withLease(GROUP, async () => {
		const { graph } = cachedGraph<{ n: number }>(
			device,
			GROUP,
			`probe${n}`,
			(g) => {
				const u = g.importBuffer("u", 16, undefined, UNIFORM);
				const pinH = g.importBuffer("pin", pin.byteLength);
				const out = g.transientBuffer("pout", n * PROBE_OUT * 4, STORAGE);
				g.addKernel({
					id: "probe",
					spec: K_IEEE_PROBE,
					bindings: { u, pin: pinH, pout: out },
					workgroups: (p) => [Math.ceil(p.n / 64)],
					writes: { pout: "full" },
				});
				g.readNode("read", [out]);
				return undefined;
			},
		);
		const words = new Uint32Array([n, 0, 0, 0]); // n, zero (opq), pad
		const { reads } = await graph.run(
			{ n },
			{
				buffers: {
					u: pooledUniform(device, `${GROUP}/u`, words),
					pin: pooledStorage(device, `${GROUP}/pin`, pin),
				},
			},
		);
		const [out] = reads.read ?? [];
		if (!out) throw new Error("probe: read node did not run");
		return new Float32Array(out, 0, n * PROBE_OUT);
	});
	return { ...verifyProbe(pin, pout), ms: performance.now() - t0 };
}
