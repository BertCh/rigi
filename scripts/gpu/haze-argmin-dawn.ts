// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The haze grid's GPU arg-min program (src/lib/gpu/look/haze-argmin.ts, a luma GPUProgram) on a real
// luma WebGPU device in node (Dawn): synthetic grids imported as the `err` buffer (instead of the
// K_HZ_GRID kernel) go through the compiled program and the read-back words are compared with
// emulatePick (the CPU twin of haze-argmin.check.ts), on both sides of the GPUConditionalOperation
// indirect gate (count <= GRID_PICK_CAP: select skipped; count > GRID_PICK_CAP: select ran).
//
//   (mkdir /tmp/dawn && cd /tmp/dawn && npm i webgpu@0.3.0)   # not an app dependency
//   DAWN_DIR=/tmp/dawn npx tsx scripts/gpu/haze-argmin-dawn.ts [grids]
//
// Per case: arena words gMin bits and count exact; tol bits exact (else reported: it only has to be
// >= gridTolerance(gMin), decodePick checks that); decodePick accepts; the over word equals count > cap;
// the pick pairs equal emulatePick's (as a set under the cap, in rank order past it); gridCandidates
// of the pick gives the same cells, with the same err bits, as on the whole grid. Prints the
// compilation's lowering decisions. SKIP (exit 0) without DAWN_DIR; exit 1 on any mismatch.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device } from "@luma.gl/core";
import { attachWebGPUDevice } from "../../src/lib/gpu/core/luma";
import { COMPUTE_FEATURES } from "../../src/lib/gpu/device";
import {
	GRID_CELLS,
	GRID_PICK_CAP,
	gridCandidates,
} from "../../src/lib/gpu/look/haze";
import {
	buildArgminProgram,
	decodePick,
	emulatePick,
	PICK_WORDS,
} from "../../src/lib/gpu/look/haze-argmin";
import {
	createHazeGridFixtures,
	namedHazeGrids,
} from "../../src/lib/gpu/look/haze-argmin.fixtures";

const dir = process.env.DAWN_DIR;
if (!dir) {
	console.log("SKIP haze-argmin-dawn: DAWN_DIR not set");
	process.exit(0);
}
const GRIDS = Number(process.argv[2] ?? 64);
const { create, globals } = await import(
	pathToFileURL(path.join(dir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
// keep the instance referenced: Dawn drops pipelines of a collected instance
const gpu = create([]);
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const adapter = await gpu.requestAdapter();
if (!adapter) {
	console.log("SKIP haze-argmin-dawn: no adapter");
	process.exit(0);
}
const device = await attachWebGPUDevice(
	await adapter.requestDevice({
		requiredFeatures: COMPUTE_FEATURES.filter((f) => adapter.features.has(f)),
	}),
	{ id: "haze-argmin-dawn" },
	true,
);
console.log(`adapter ${JSON.stringify(adapter.info ?? {})}`);

let failed = 0;
const fail = (message: string) => {
	failed++;
	console.log(`FAIL ${message}`);
};

type Prm = undefined;
let lowering:
	| Parameters<NonNullable<Parameters<typeof buildArgminProgram>[3]>>[0]
	| null = null;
const graph = buildArgminProgram<Prm>(
	device as Device,
	"haze-argmin-dawn",
	(g) => g.importBuffer("err", GRID_CELLS * 4),
	(c) => {
		lowering = c;
	},
);
await graph.compileAsync();
const report = (
	lowering as unknown as {
		lowering: {
			decisions: { operationId: string; lowering: string; reason: string }[];
			nodes: { id: string }[];
		};
	}
).lowering;
console.log("lowering decisions:");
for (const d of report.decisions)
	console.log(`  ${d.operationId.padEnd(10)} ${d.lowering}  (${d.reason})`);
const conditional = report.decisions.find((d) => d.lowering.includes("gate"));
if (conditional?.lowering !== "gpu-indirect-gate")
	fail(
		`conditional lowering is ${conditional?.lowering}, not gpu-indirect-gate`,
	);
const gatedNodes = (
	graph.graph as unknown as {
		nodes: { id: string; condition?: { source: string; mode?: string } }[];
	}
).nodes.filter((n) => n.condition);
console.log(
	`conditional mode: ${gatedNodes.map((n) => `${n.id}: ${n.condition?.source}/${n.condition?.mode}`).join(", ")}`,
);
if (
	gatedNodes.length !== 1 ||
	gatedNodes[0].condition?.source !== "gpu" ||
	gatedNodes[0].condition?.mode !== "indirect"
)
	fail("select is not the one GPU-indirect gated node");

const { shuffle, makeGrid } = createHazeGridFixtures();
const errBuffer = device.createBuffer({
	id: "err",
	usage: 0x80 | 0x04 | 0x08, // STORAGE | COPY_SRC | COPY_DST
	byteLength: GRID_CELLS * 4,
});
const u32 = (b: ArrayBuffer | Float32Array) =>
	b instanceof Float32Array
		? new Uint32Array(b.buffer, b.byteOffset, b.length)
		: new Uint32Array(b);
const same = (a: ArrayLike<number>, b: ArrayLike<number>) =>
	a.length === b.length && Array.from(a).every((v, i) => v === b[i]);

let verbose = false;
let compared = 0;
let under = 0;
let over = 0;
let tolDiffers = 0;
let gateSeen = 0;
let zeroSignDiffers = 0;
let skippedProven = 0;
async function runCase(g: Float32Array, label: string) {
	errBuffer.write(g);
	const { reads } = await graph.run(undefined, { buffers: { err: errBuffer } });
	const [words, pairs] = reads.pick;
	const [wantWords, wantPairs] = emulatePick(g, shuffle);
	const gw = u32(words);
	const ww = u32(wantWords);
	compared++;
	const count = gw[PICK_WORDS.count];
	const branch = count > GRID_PICK_CAP ? "select" : "cand-only";
	if (count > GRID_PICK_CAP) over++;
	else under++;
	// -0 and +0 tie on the order key, so which of them the tree keeps depends on the reduction order:
	// bit-exact except for the sign of a zero minimum (the CPU compares them equal)
	const gMinZero =
		(gw[PICK_WORDS.gMin] | ww[PICK_WORDS.gMin]) << 1 === 0 &&
		gw[PICK_WORDS.gMin] !== ww[PICK_WORDS.gMin];
	if (gMinZero) zeroSignDiffers++;
	if (gw[PICK_WORDS.gMin] !== ww[PICK_WORDS.gMin] && !gMinZero)
		fail(`${label}: gMin bits ${gw[0].toString(16)} vs ${ww[0].toString(16)}`);
	if (count !== ww[PICK_WORDS.count])
		fail(`${label}: count ${count} vs ${ww[PICK_WORDS.count]}`);
	if (gw[PICK_WORDS.over] !== ww[PICK_WORDS.over])
		fail(
			`${label}: over word ${gw[PICK_WORDS.over]} vs ${ww[PICK_WORDS.over]}`,
		);
	else gateSeen += gw[PICK_WORDS.over];
	if (gw[PICK_WORDS.tol] !== ww[PICK_WORDS.tol]) tolDiffers++;
	const pick = decodePick(words, pairs);
	const wantPick = decodePick(wantWords, wantPairs);
	if (!wantPick) {
		// the emulation itself is rejected (an infinite minimum): the GPU must not be accepted either
		if (pick)
			fail(`${label}: decodePick accepts where the emulation is rejected`);
		console.log(`  ${label}: rejected on both (emulation too), count ${count}`);
		return;
	}
	if (!pick) {
		fail(
			`${label}: decodePick rejects the GPU pick (count ${count}, tol bits ${gw[PICK_WORDS.tol].toString(16)} vs ${ww[PICK_WORDS.tol].toString(16)})`,
		);
		return;
	}
	// pairs: past the cap in rank order, exactly emulatePick's; under it as a set (atomic slot order)
	const n = Math.min(count, GRID_PICK_CAP);
	const gp = u32(pairs);
	const wp = u32(wantPairs);
	const pairList = (p: Uint32Array) =>
		Array.from({ length: n }, (_, i) => [p[2 * i], p[2 * i + 1]] as const);
	const gl = pairList(gp);
	const wl = pairList(wp);
	if (count > GRID_PICK_CAP) {
		if (!same(gp.subarray(0, 2 * n), wp.subarray(0, 2 * n)))
			fail(`${label}: over-cap pairs differ from the rank-ordered emulation`);
	} else {
		// select skipped: the pairs keep the cand kernel's atomic slot order, so a pick that is NOT in
		// (err, index) rank order proves the gated selection did not rewrite it
		const f = new Float32Array(gp.buffer, gp.byteOffset, gp.length);
		let ranked = true;
		for (let i = 1; i < n; i++)
			ranked &&=
				f[2 * i - 1] < f[2 * i + 1] ||
				(f[2 * i - 1] === f[2 * i + 1] && gp[2 * i - 2] < gp[2 * i]);
		if (n > 1 && !ranked) skippedProven++;
		const key = (a: readonly [number, number]) => a[0];
		if (
			!same(
				gl.sort((a, b) => key(a) - key(b)).flat(),
				wl.sort((a, b) => key(a) - key(b)).flat(),
			)
		)
			fail(`${label}: pick pairs differ as a set`);
	}
	// the CPU's candidates from the pick = from the whole grid, with the same err bits
	const got = gridCandidates(pick);
	const want = gridCandidates(g);
	const gb = u32(g);
	const errBitsOf = (i: number) => gb[i];
	if (!same(got, want)) fail(`${label}: gridCandidates idx differ`);
	else {
		const pe = new Uint32Array(pick.err.buffer);
		const pi = new Map<number, number>();
		for (let i = 0; i < pick.idx.length; i++) pi.set(pick.idx[i], pe[i]);
		for (const k of got)
			if (pi.get(k) !== errBitsOf(k))
				fail(`${label}: err bits of candidate ${k} differ`);
	}
	if (verbose) console.log(`  ${label}: count ${count}, ${branch}`);
}

for (let i = 0; i < GRIDS; i++) await runCase(makeGrid(i), `grid ${i}`);
verbose = true;
console.log("named and adversarial grids (count, branch that ran):");
for (const [label, g] of namedHazeGrids()) await runCase(g, label);
{
	const inf = new Float32Array(GRID_CELLS).fill(Number.POSITIVE_INFINITY);
	await runCase(inf, "all +inf");
	inf[77] = 3;
	await runCase(inf, "+inf with one finite cell");
	const tie = new Float32Array(GRID_CELLS).fill(1);
	await runCase(tie, "all ties (past the cap)");
	const negZero = new Float32Array(GRID_CELLS).fill(-0);
	await runCase(negZero, "all -0 (ties with +0)");
	const mixed = new Float32Array(GRID_CELLS).fill(Number.NaN);
	mixed[5] = -0;
	mixed[9] = 0;
	mixed[11] = Number.POSITIVE_INFINITY;
	await runCase(mixed, "NaN, -0, +0, +inf only");
	const neg = new Float32Array(GRID_CELLS).fill(Number.NaN);
	neg[3] = Number.NEGATIVE_INFINITY;
	neg[4] = 1;
	await runCase(neg, "-inf minimum (tolerance NaN)");
}
console.log(
	`${failed ? "FAIL" : "ok  "} ${compared} grids: ${under} at or under the cap (select gated off; ${skippedProven} of them provably so: pairs not in rank order), ${over} past it (select ran; ${gateSeen} over words = 1); tol bits differ from the f32 emulation on ${tolDiffers}, zero-minimum sign differs on ${zeroSignDiffers}`,
);
if (!under || !over) fail("both gate branches were not exercised");
errBuffer.destroy();
graph.destroy();
process.exit(failed ? 1 : 0);
