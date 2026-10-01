// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check of the shared certified-f32 arithmetic (./df32.ts) and the strict-IEEE probe's verifier
// (./ieee-probe.ts), on the emulated f32 machine. Exits 1 on any failure.
//
//   npx tsx src/lib/gpu/precision/ieee-probe.check.ts
//
// 1. df32 add / mul / div / sqrt stay within their budgets (EPS_*) against f64 on 200 000 random
//    operand pairs (wide exponents, cancellations), with correctly rounded and with ±3 ULP division /
//    sqrt.
// 2. The verifier accepts the emulated machine (also with ±3 ULP division / sqrt, and with subnormals
//    flushed on load and on every result) and rejects a machine
//    whose TwoSum is re-associated away, whose fma rounds twice, or whose division is off by 8 ULP.
import {
	bits32,
	ddAdd,
	ddDiv,
	ddMul,
	ddSqrt,
	EPS_ADD,
	EPS_DIV,
	EPS_MUL,
	EPS_SQRT,
	fromBits32,
	ftz32,
	setDivSqrtPerturbation,
	setFlushSubnormals,
	split,
} from "./df32";
import {
	emuProbe,
	PROBE_IN,
	PROBE_OUT,
	probeInputs,
	verifyProbe,
} from "./ieee-probe";

let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.log(`FAIL ${msg}`);
};

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

// ---------- 1. df32 budgets ----------

function budgets(label: string, seed: number) {
	const r = rng(seed);
	const num = (lo: number, hi: number) =>
		(r() < 0.5 ? -1 : 1) * (1 + r()) * 2 ** Math.floor(lo + (hi - lo) * r());
	const worst = { add: 0, mul: 0, div: 0, sqrt: 0 };
	for (let i = 0; i < 200_000; i++) {
		const x = split(num(-12, 12));
		const y =
			i % 3 === 0
				? split(-(x[0] + x[1]) * (1 + (r() - 0.5) * 2 ** -(8 + (i % 30))))
				: split(num(-12, 12));
		const X = x[0] + x[1];
		const Y = y[0] + y[1];
		// exact cancellation must give exactly 0 (any error is then unbounded relative to 0)
		const rel = (z: number[], ref: number) =>
			ref === 0
				? z[0] + z[1] === 0
					? 0
					: Number.POSITIVE_INFINITY
				: Math.abs(z[0] + z[1] - ref) / Math.abs(ref);
		// f64 references are within 2^-53 relative (operands are ≤ 48-bit, exponents moderate)
		worst.add = Math.max(
			worst.add,
			rel(ddAdd(x[0], x[1], y[0], y[1]), X + Y) / EPS_ADD,
		);
		worst.mul = Math.max(
			worst.mul,
			rel(ddMul(x[0], x[1], y[0], y[1]), X * Y) / EPS_MUL,
		);
		worst.div = Math.max(
			worst.div,
			rel(ddDiv(x[0], x[1], y[0], y[1]), X / Y) / EPS_DIV,
		);
		const ax = [Math.abs(x[0]), Math.abs(x[1])];
		worst.sqrt = Math.max(
			worst.sqrt,
			rel(ddSqrt(ax[0], ax[1]), Math.sqrt(ax[0] + ax[1])) / EPS_SQRT,
		);
	}
	const slack = 1 + 2 ** -52 / EPS_ADD; // the f64 reference's own rounding
	const ok = Object.values(worst).every((v) => v <= slack);
	console.log(
		`df32 budgets ${label}: worst error / budget add ${worst.add.toFixed(3)}, mul ${worst.mul.toFixed(3)}, div ${worst.div.toFixed(3)}, sqrt ${worst.sqrt.toFixed(3)} (must be ≤ 1)`,
	);
	if (!ok) fail(`df32 budgets ${label}`);
}

budgets("(correctly rounded div / sqrt)", 11);
setDivSqrtPerturbation(3, rng(12));
budgets("(div / sqrt ±3 ULP)", 13);
setDivSqrtPerturbation(0);

// ---------- 2. the probe verifier ----------

{
	const pin = probeInputs();
	const good = verifyProbe(pin, emuProbe(pin));
	setDivSqrtPerturbation(3, rng(5));
	const shaky = verifyProbe(pin, emuProbe(pin));
	setDivSqrtPerturbation(0);
	// a machine that flushes subnormals (inputs on load, results), as WGSL allows
	setFlushSubnormals(true);
	const ftz = verifyProbe(pin, emuProbe(pin.map(ftz32)));
	setFlushSubnormals(false);
	const broken = (patch: (o: Float32Array, i: number) => void) => {
		const out = emuProbe(pin);
		for (let i = 0; i < out.length / PROBE_OUT; i++) patch(out, i);
		return verifyProbe(pin, out).ok;
	};
	const reassoc = broken((o, i) => {
		o[i * PROBE_OUT + 6] = 0; // TwoSum's error term folded away (fast math)
	});
	const unfused = broken((o, i) => {
		const [a, b, c] = pin.subarray(i * PROBE_IN, i * PROBE_IN + 3);
		o[i * PROBE_OUT + 2] = Math.fround(Math.fround(a * b) + c); // rounded twice
	});
	const sloppyDiv = broken((o, i) => {
		const k = i * PROBE_OUT + 3;
		o[k] = fromBits32(bits32(o[k]) + 8);
	});
	const fmt = (w: Record<string, number>) =>
		JSON.stringify(w, (_, v) =>
			typeof v === "number" ? Number(v.toPrecision(3)) : v,
		);
	console.log(
		`probe verifier (${good.n} records): emulated machine ${good.ok ? "accepted" : "REJECTED"}, ±3 ULP div/sqrt ${shaky.ok ? "accepted" : "REJECTED"} (worst ${fmt(shaky.worst)}), flush-to-zero ${ftz.ok ? "accepted" : "REJECTED"}; ` +
			`re-associated TwoSum ${reassoc ? "ACCEPTED" : "rejected"}, unfused fma ${unfused ? "ACCEPTED" : "rejected"}, 8-ULP division ${sloppyDiv ? "ACCEPTED" : "rejected"}`,
	);
	if (!good.ok || !shaky.ok || !ftz.ok || reassoc || unfused || sloppyDiv)
		fail(
			`probe verifier ${JSON.stringify(good.failures)} ${JSON.stringify(shaky.failures)} ${JSON.stringify(ftz.failures)}`,
		);
}

console.log(`${failures ? "FAIL" : "PASS"} strict-IEEE probe / df32 check`);
process.exit(failures ? 1 : 0);
