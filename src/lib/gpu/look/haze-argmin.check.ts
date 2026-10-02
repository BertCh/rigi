// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// npx tsx src/lib/gpu/look/haze-argmin.check.ts [grids]   (exits 1 on failure; CI fast tier: 400)
// Node check of the haze grid's GPU arg-min program (./haze-argmin.ts, the GPU arg-min, default on),
// no GPU:
//  1. emulatePick (the program's integer min / candidate / rank logic exactly, its f32 tolerance via
//     Math.fround, the cand kernel's atomic slot order randomly permuted) → decodePick →
//     haze.ts gridCandidates gives the same cells as gridCandidates on the whole grid, on random
//     landscapes and adversarial grids: ties at the minimum and at the 256th candidate, more than 256
//     candidates (the GPU-gated selection), cells on the f32 neighbours of the f64 tolerance, NaN,
//     ±∞, ±0, subnormals, negative cells, all-NaN;
//  2. decodePick's per-call checks reject a tolerance below haze.ts's, a value outside [gMin, tol]
//     a pick without the minimum, and an over-cap pick out of rank order (teeth of the runtime guard);
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
import { createHazeGridFixtures, namedHazeGrids } from "./haze-argmin.fixtures";

const GRIDS = Number(process.argv[2] ?? 400);
let failed = 0;
const fail = (msg: string) => {
	failed++;
	console.log(`FAIL ${msg}`);
};
const { shuffle, makeGrid } = createHazeGridFixtures();
const same = (a: number[], b: number[]) =>
	a.length === b.length && a.every((v, i) => v === b[i]);

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
for (const [label, g] of namedHazeGrids()) run(g, label);
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
	// past the cap: a gated selection that did not run leaves the cand kernel's slot order
	const g = new Float32Array(GRID_CELLS).fill(1);
	const [words, pairs] = emulatePick(g);
	if (new Uint32Array(words)[2] <= GRID_PICK_CAP || !decodePick(words, pairs))
		fail("teeth: the all-tie grid's pick is not an accepted over-cap pick");
	const p = new Uint32Array(pairs.slice(0));
	const q = new Uint32Array(p.length);
	for (let i = 0; i < GRID_PICK_CAP; i++) {
		q[2 * i] = p[2 * (GRID_PICK_CAP - 1 - i)];
		q[2 * i + 1] = p[2 * (GRID_PICK_CAP - 1 - i) + 1];
	}
	if (decodePick(words, q.buffer))
		fail("teeth: decodePick accepts an over-cap pick out of rank order");
	else
		console.log(
			"ok   decodePick rejects an over-cap pick out of rank order (selection skipped)",
		);
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
