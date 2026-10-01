// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/look/haze-argmin.check.ts [grids]   (exits 1 on failure; CI fast tier: 400)
// Node check of the haze grid's GPU arg-min program (./haze-argmin.ts, ?hazeArgminGpu, default on),
// no GPU:
//  1. emulatePick (the program's integer min / candidate / rank logic exactly, its f32 tolerance via
//     Math.fround, the cand kernel's atomic slot order randomly permuted) → decodePick →
//     haze.ts gridCandidates gives the same cells as gridCandidates on the whole grid, on random
//     landscapes and adversarial grids: ties at the minimum and at the 256th candidate, more than 256
//     candidates (the GPU-gated selection), cells on the f32 neighbours of the f64 tolerance, NaN,
//     ±∞, ±0, subnormals, negative cells, all-NaN;
//  2. decodePick's per-call checks reject a tolerance below haze.ts's, a value outside [gMin, tol]
//     and a pick without the minimum (teeth of the runtime guard);
//  3. the program builds on a stub device (GPUProgramCompiler lowering, no GPU calls): the arena
//     layout the kernels address, our kernels lowered in order, and the select node the only node
//     gated, by a GPU indirect condition.
// Not covered (needs a browser with WebGPU): that the WGSL and luma's scalar kernels compute what
// emulatePick does (the browser runs: look-bench exact, bridge-check fit exact, per-call checks).
import type { Device } from "@luma.gl/core";
import { bits32, fromBits32, nextDown32, nextUp32 } from "../precision/df32";
import {
	GRID_CELLS,
	GRID_PICK_CAP,
	gridCandidates,
	gridTolerance,
} from "./haze";
import {
	buildArgminProgram,
	decodePick,
	emulatePick,
	PICK_ARENA_WORDS,
} from "./haze-argmin";
import { lcg } from "./haze-emulate";

const GRIDS = Number(process.argv[2] ?? 400);
let failed = 0;
const fail = (msg: string) => {
	failed++;
	console.log(`FAIL ${msg}`);
};
const rnd = lcg(20261001);
const shuffle = (n: number) => {
	const a = [...Array(n).keys()];
	for (let i = n - 1; i > 0; i--) {
		const j = Math.floor(rnd() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
};
const same = (a: number[], b: number[]) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

/** f32 neighbours of the f64 tolerance of `gMin`: the largest f32 ≤ T and the next ones. */
function aroundTolerance(gMin: number) {
	const T = gridTolerance(gMin);
	let f = Math.fround(T);
	if (f > T) f = nextDown32(f);
	return [nextDown32(f), f, nextUp32(f), nextUp32(nextUp32(f))];
}

function makeGrid(kind: number): Float32Array {
	const g = new Float32Array(GRID_CELLS);
	const scale = 10 ** (rnd() * 12 - 8);
	const flat = kind % 7 === 3;
	for (let k = 0; k < GRID_CELLS; k++) {
		const hk = Math.floor(k / (25 * 37));
		const a = Math.floor((k % (25 * 37)) / 37);
		const b = k % 37;
		const bowl =
			((a - 12) / 12) ** 2 + ((b - 18) / 18) ** 2 + 0.2 * ((hk - 2) / 3) ** 2;
		g[k] = scale * (flat ? 1 + 1e-5 * bowl * rnd() : 0.5 + bowl + 0.01 * rnd());
	}
	// adversarial sprinkles
	const sprinkle = (n: number, v: () => number) => {
		for (let i = 0; i < n; i++) g[Math.floor(rnd() * GRID_CELLS)] = v();
	};
	if (kind % 2 === 0) sprinkle(20, () => Number.NaN);
	if (kind % 3 === 0) sprinkle(10, () => Number.POSITIVE_INFINITY);
	if (kind % 5 === 0) sprinkle(5, () => (rnd() < 0.5 ? 0 : -0));
	if (kind % 11 === 0)
		sprinkle(5, () => fromBits32(1 + Math.floor(rnd() * 1000)));
	if (kind % 13 === 0) sprinkle(5, () => -scale * rnd());
	// ties at the minimum
	let gMin = Number.POSITIVE_INFINITY;
	for (const e of g) if (e < gMin) gMin = e;
	if (kind % 4 === 1) sprinkle(30, () => gMin);
	// cells on the tolerance's f32 neighbours (and many of them: past the cap)
	if (kind % 4 === 2) {
		const n = aroundTolerance(gMin);
		sprinkle(kind % 8 === 2 ? 600 : 40, () => n[Math.floor(rnd() * n.length)]);
	}
	// many ties around the 256th candidate
	if (kind % 6 === 5) {
		const v = Math.fround(gMin + Math.abs(gMin) * 5e-4);
		sprinkle(400, () => v);
	}
	return g;
}

// ---------- 1. the pick's candidates = the whole grid's ----------
let compared = 0;
let gated = 0;
let rejected = 0;
const run = (g: Float32Array, label: string) => {
	const want = gridCandidates(g);
	const [words, pairs] = emulatePick(g, shuffle);
	const count = new Uint32Array(words)[2];
	if (count > GRID_PICK_CAP) gated++;
	const pick = decodePick(words, pairs);
	compared++;
	if (!pick) {
		rejected++;
		fail(`${label}: decodePick rejected an emulated pick (count ${count})`);
		return;
	}
	const got = gridCandidates(pick);
	if (!same(got, want))
		fail(
			`${label}: candidates differ (count ${count}): ${got.length} [${got.slice(0, 6)}…] vs ${want.length} [${want.slice(0, 6)}…]`,
		);
};
for (let i = 0; i < GRIDS; i++) run(makeGrid(i), `grid ${i}`);
{
	const nan = new Float32Array(GRID_CELLS).fill(Number.NaN);
	run(nan, "all NaN");
	const one = new Float32Array(GRID_CELLS).fill(Number.NaN);
	one[1234] = 0.5;
	run(one, "one finite cell");
	const exact = new Float32Array(GRID_CELLS).fill(2);
	for (let k = 0; k < GRID_PICK_CAP; k++) exact[k * 7] = 1;
	run(exact, "exactly 256 at the minimum");
	exact[3] = 1;
	run(exact, "257 at the minimum");
	const zeros = new Float32Array(GRID_CELLS).fill(1);
	for (let k = 0; k < 300; k++) zeros[k * 11] = k % 2 ? -0 : 0;
	run(zeros, "300 ±0 minima");
}
console.log(
	`${failed ? "FAIL" : "ok  "} pick candidates = whole-grid candidates on ${compared} grids (${gated} past the cap: GPU-gated selection; ${rejected} rejected)`,
);

// ---------- 2. teeth of decodePick ----------
{
	const g = makeGrid(1);
	const [words, pairs] = emulatePick(g);
	const tamper = (edit: (f: Float32Array, p: Uint32Array) => void) => {
		const w = words.slice(0);
		const p = pairs.slice(0);
		edit(new Float32Array(w, 0, PICK_ARENA_WORDS), new Uint32Array(p));
		return decodePick(w, p);
	};
	const cases: [string, (f: Float32Array, p: Uint32Array) => void][] = [
		[
			"a tolerance below haze.ts's",
			(f) => {
				f[1] = nextDown32(Math.fround(gridTolerance(f[0])));
				if (f[1] >= gridTolerance(f[0])) f[1] = nextDown32(f[1]);
			},
		],
		["a value above the tolerance", (f, p) => (p[1] = bits32(f[1] * 2))],
		[
			"a pick without the minimum",
			(f, p) => {
				for (
					let i = 0;
					i < Math.min(new Uint32Array(words)[2], GRID_PICK_CAP);
					i++
				)
					if (fromBits32(p[2 * i + 1]) === f[0])
						p[2 * i + 1] = bits32(nextUp32(f[0]));
			},
		],
	];
	if (!decodePick(words, pairs)) fail("teeth: the untampered pick is rejected");
	for (const [label, edit] of cases) {
		if (tamper(edit)) fail(`teeth: decodePick accepts ${label}`);
		else console.log(`ok   decodePick rejects ${label}`);
	}
}

{
	// 3. the program's lowering on a stub device (building calls no device method)
	const device = {
		id: "stub",
		type: "webgpu",
		limits: { maxBufferSize: 1 << 28, maxStorageBufferBindingSize: 1 << 27 },
		features: new Set(),
	} as unknown as Device;
	try {
		const cg = buildArgminProgram<unknown>(device, "check", (g) =>
			g.transientBuffer("err", GRID_CELLS * 4),
		);
		const nodes = (
			cg.graph as unknown as {
				nodes: { id: string; condition?: { source: string; mode?: string } }[];
			}
		).nodes;
		const ids = nodes.map((n) => n.id);
		const gated = nodes.filter((n) => n.condition);
		const want = ["min", "tol", "clear-pick", "cand", "over", "select", "pick"];
		const order = want.map((id) => ids.indexOf(id));
		if (order.some((i, k) => i < 0 || (k > 0 && i <= order[k - 1])))
			fail(`program node order ${ids.join(",")}`);
		else if (
			gated.length !== 1 ||
			gated[0].id !== "select" ||
			gated[0].condition?.source !== "gpu" ||
			gated[0].condition?.mode !== "indirect"
		)
			fail(
				`program gates ${gated.map((n) => `${n.id}:${n.condition?.source}/${n.condition?.mode}`).join(",")}`,
			);
		else
			console.log(
				`ok   program lowers to ${ids.length} nodes; "select" is the only one, GPU-indirect gated`,
			);
	} catch (e) {
		fail(`program build: ${(e as Error).message}`);
	}
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
