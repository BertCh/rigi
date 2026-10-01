// Node check (no GPU, no browser) of the GPU splat sort's identity with the worker's counting sort:
//   npx tsx scripts/gpu/splat-sort-check.ts
// 1. radix == worker: for the worker's EXACT keys (f64 formula), the tiled stable radix order
//    (src/lib/gpu/splat-sort/cpu.ts radixOrderTiled, the WGSL kernels step for step) equals the
//    worker's order (sortSplatsByDepth) element for element, ties included, plus the dropped splats
//    last in ascending index. Cases force masses of equal keys (quantised positions, planes, one
//    key, n around tile multiples, dropped splats).
// 2. f32 keys vs the worker's f64 keys: how often and by how much they differ (the WGSL arithmetic
//    cannot be proven bit-equal to the worker's f64), and that the resulting order is still
//    back-to-front up to two key bins.

import {
	radixOrderTiled,
	splatKeysF32,
} from "../../src/lib/gpu/splat-sort/cpu";
import { SortBackendState } from "../../src/lib/gpu/splat-sort/fallback";
import {
	type DepthRow,
	sortSplatsByDepth,
} from "../../src/lib/nearfield/splat-sort.worker";

let seed = 12345;
const rnd = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 4294967296;
};
let fails = 0;
const check = (ok: boolean, msg: string) => {
	if (!ok) {
		fails++;
		console.error("FAIL", msg);
	}
};

/** The worker's key formula (f64), reproduced for the keys the worker sorts by. */
function workerKeys(pos: Float32Array, n: number, row: DepthRow) {
	const [a, b, c, d] = row;
	const depth = new Float32Array(n);
	let minD = Infinity;
	let maxD = -Infinity;
	for (let i = 0; i < n; i++) {
		const dist = -(
			a * pos[3 * i] +
			b * pos[3 * i + 1] +
			c * pos[3 * i + 2] +
			d
		);
		if (dist > 0) {
			depth[i] = dist;
			// as the worker: the range comes from the unrounded f64 dist, the key from the f32 depth
			minD = Math.min(minD, dist);
			maxD = Math.max(maxD, dist);
		} else depth[i] = -1;
	}
	const k = maxD - minD > 0 ? 65535 / (maxD - minD) : 0;
	const keys = new Uint32Array(n);
	for (let i = 0; i < n; i++)
		keys[i] =
			depth[i] < 0 ? 65536 : Math.min(65535, ((maxD - depth[i]) * k) | 0);
	return { keys, depth };
}

type Gen = (i: number) => [number, number, number];
const gens: Record<string, Gen> = {
	random: () => [rnd() * 40 - 20, rnd() * 40 - 20, rnd() * 40 - 20],
	// z on 8 planes: huge tie classes
	planes: () => [rnd() * 40 - 20, rnd() * 40 - 20, Math.floor(rnd() * 8)],
	// a lattice: ties in both key and exact depth
	lattice: (i) => [i % 7, (i >> 3) % 5, (i >> 6) % 3],
	// all splats identical
	same: () => [1.5, -2.25, 3],
	// a few distinct depths only, forced equal keys
	few: () => [Math.floor(rnd() * 3) * 10, 0, Math.floor(rnd() * 2) * 10],
};
const rows: DepthRow[] = [
	[0, 0, 1, 0], // view z = z: splats with z > 0 are dropped
	[0, 0, 1, -25], // looks down -z from z = 25: all kept
	[0.3, -0.5, 0.81, -14.2],
	[1, 0, 0, 30],
];
const sizes = [1, 2, 255, 256, 257, 511, 512, 513, 1000, 4097, 20000];

let cases = 0;
let ties = 0;
let f32KeyDiff = 0;
let f32Total = 0;
let maxKeyDelta = 0;
for (const [name, gen] of Object.entries(gens))
	for (const n of sizes)
		for (const row of rows) {
			const pos = new Float32Array(3 * n);
			for (let i = 0; i < n; i++) pos.set(gen(i), 3 * i);
			const out = new Uint32Array(n);
			const kept = sortSplatsByDepth(pos, n, row, out);
			const { keys, depth } = workerKeys(pos, n, row);
			const order = radixOrderTiled(keys, n);
			const tag = `${name} n=${n} row=${row}`;
			cases++;
			let same = true;
			for (let i = 0; i < kept; i++) if (order[i] !== out[i]) same = false;
			check(same, `${tag}: radix order != worker order`);
			// dropped splats: last, ascending index
			let prev = -1;
			let tailOk = true;
			for (let i = kept; i < n; i++) {
				if (keys[order[i]] !== 65536 || order[i] <= prev) tailOk = false;
				prev = order[i];
			}
			check(tailOk, `${tag}: dropped splats not last / not index-ascending`);
			for (let i = 1; i < kept; i++)
				if (keys[order[i]] === keys[order[i - 1]]) ties++;
			// f32 keys
			const g = splatKeysF32(pos, n, row);
			check(g.kept === kept, `${tag}: f32 kept ${g.kept} != ${kept}`);
			let gd = 0;
			for (let i = 0; i < n; i++) {
				if (g.keys[i] === 65536 || keys[i] === 65536) {
					// the f32 depth may flip a splat within a few ulp of the plane; count it
					if (g.keys[i] !== keys[i]) gd++;
					continue;
				}
				const dk = Math.abs(g.keys[i] - keys[i]);
				if (dk) gd++;
				maxKeyDelta = Math.max(maxKeyDelta, dk);
			}
			f32KeyDiff += gd;
			f32Total += n;
			// the f32 order is back to front up to 2 key bins of depth
			const go = radixOrderTiled(g.keys, n);
			let maxD = 0;
			let minD = Infinity;
			for (let i = 0; i < n; i++)
				if (depth[i] > 0) {
					maxD = Math.max(maxD, depth[i]);
					minD = Math.min(minD, depth[i]);
				}
			const bin = (maxD - minD) / 65535;
			let ok = true;
			for (let i = 1; i < g.kept; i++)
				if (depth[go[i]] > depth[go[i - 1]] + 3 * bin + 1e-6 * maxD) ok = false;
			check(ok, `${tag}: f32 order not back-to-front within 3 bins`);
		}
console.log(
	`cases ${cases}, adjacent equal-key pairs in worker order ${ties}; f32 keys differ from the worker's f64 keys on ${f32KeyDiff}/${f32Total} splats (${((100 * f32KeyDiff) / f32Total).toFixed(4)}%), max |dkey| ${maxKeyDelta}`,
);
// 3. fallback state machine (src/lib/gpu/splat-sort/fallback.ts): one-way, idempotent, one warning,
//    rejections of watched promises (compile / validation) and a device-lost style direct fail all
//    switch exactly once with the first reason.
async function fallbackTests() {
	const mk = (initial: "gpu" | "worker") => {
		const log = { switches: [] as string[], warns: [] as string[] };
		const st = new SortBackendState(
			initial,
			(r) => log.switches.push(r),
			(m) => log.warns.push(m),
		);
		return { st, log };
	};
	let { st, log } = mk("gpu");
	check(st.backend === "gpu" && st.reason === null, "fallback: initial gpu");
	st.watch(Promise.resolve(), "validation");
	await new Promise((r) => setTimeout(r, 0));
	check(st.backend === "gpu", "fallback: resolved promise must not switch");
	st.watch(Promise.reject(new Error("compile boom")), "pipeline");
	await new Promise((r) => setTimeout(r, 0));
	check(
		st.backend === "worker" && st.reason === "pipeline: compile boom",
		"fallback: rejection switches with its reason",
	);
	check(st.fail("device lost") === false, "fallback: second fail ignored");
	check(
		log.switches.length === 1 && log.warns.length === 1,
		"fallback: exactly one switch and one warning",
	);
	check(st.reason === "pipeline: compile boom", "fallback: first reason kept");
	({ st, log } = mk("gpu"));
	check(
		st.fail("device lost") === true && st.reason === "device lost",
		"fallback: direct fail",
	);
	st.watch(Promise.reject("str"), "validation");
	await new Promise((r) => setTimeout(r, 0));
	check(
		log.switches.length === 1,
		"fallback: late rejection after switch ignored",
	);
	({ st, log } = mk("worker"));
	check(
		st.fail("x") === false && log.switches.length === 0,
		"fallback: worker-initial never switches",
	);
}
await fallbackTests();
if (fails) {
	console.error(`${fails} FAILED`);
	process.exit(1);
}
console.log(
	"OK: stable radix == worker order on identical keys (ties included); fallback state machine",
);
