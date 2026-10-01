// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Unit check of the splat depth sort (sync path): npx tsx scripts/nearfield/splat-sort-test.ts
import {
	SplatSorter,
	sortSplatsByDepth,
} from "../../src/lib/nearfield/splat-sort";

const n = 1_000_000;
const p = new Float32Array(3 * n);
for (let i = 0; i < 3 * n; i++) p[i] = (Math.random() - 0.5) * 100;
// camera at z=+60 looking down -z: view z = pz - 60 → row (0,0,1,-60)
const row = [0, 0, 1, -60] as const;
const out = new Uint32Array(n);
const t0 = performance.now();
const k = sortSplatsByDepth(p, n, row, out);
const ms = performance.now() - t0;
let ok = true;
let inv = 0;
for (let i = 1; i < k; i++)
	if (p[3 * out[i] + 2] < p[3 * out[i - 1] + 2] - 100 / 65535 - 1e-6) inv++;
if (inv) ok = false;
if (k !== n) ok = false;
// camera inside the cloud: half the points behind the camera are dropped
const k2 = sortSplatsByDepth(p, n, [0, 0, 1, 0], out);
if (Math.abs(k2 - n / 2) > n * 0.01) ok = false;
const s = new SplatSorter(p, n, { worker: false });
let cbCount = -1;
s.sort(row, new Uint32Array(n), (r) => (cbCount = r.count));
if (cbCount !== n) ok = false;
console.log(
	JSON.stringify({
		ok,
		n,
		kept: k,
		inversions: inv,
		behindDropped: n - k2,
		ms: +ms.toFixed(1),
		usingWorker: s.usingWorker,
	}),
);
process.exit(ok ? 0 : 1);
