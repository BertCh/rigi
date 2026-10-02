// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node-only guard for mosaic-mips.ts: its pyramid shape (mipDims) equals the CPU pyramid's for odd
// sizes, and the kernel's block rule (clipped k x k blocks of the level below, `v > mx` on the first
// element) written out on the CPU reproduces gridMips byte for byte. The GPU bytes themselves are
// compared on Dawn by scripts/gpu/mosaic-mips-dawn.ts.
import { gridMips } from "#/lib/horizon-fast/mosaic";
import { mipDims } from "./mosaic-mips";

let failures = 0;
const check = (ok: boolean, what: string) => {
	if (!ok) {
		failures++;
		console.error(`FAIL ${what}`);
	}
};

/** The WGSL kernel's loop, level by level. */
function kernelModel(d: Float32Array, W: number, H: number) {
	const dims = mipDims(W, H);
	const levels: Float32Array[] = [];
	for (let i = 0; i < dims.widths.length; i++) {
		const src = i === 0 ? d : levels[i - 1];
		const sw = i === 0 ? W : dims.widths[i - 1];
		const sh = i === 0 ? H : dims.heights[i - 1];
		const f = i === 0 ? 1 << dims.minLevel : 2;
		const out = new Float32Array(dims.widths[i] * dims.heights[i]);
		for (let y = 0; y < dims.heights[i]; y++)
			for (let x = 0; x < dims.widths[i]; x++) {
				const x1 = Math.min(sw, x * f + f);
				const y1 = Math.min(sh, y * f + f);
				let mx = src[y * f * sw + x * f];
				for (let yy = y * f; yy < y1; yy++)
					for (let xx = x * f; xx < x1; xx++) {
						const v = src[yy * sw + xx];
						if (v > mx) mx = v;
					}
				out[y * dims.widths[i] + x] = mx;
			}
		levels.push(out);
	}
	return { dims, levels };
}

let seed = 7;
for (const [W, H] of [
	[1, 1],
	[7, 5],
	[259, 131],
	[513, 1025],
	[1024, 768],
]) {
	const d = new Float32Array(W * H);
	for (let i = 0; i < d.length; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		d[i] = (seed % 4000) - 500 + (i % 5 === 0 ? 0 : 0.5);
	}
	const cpu = gridMips(d, W, H);
	const { dims, levels } = kernelModel(d, W, H);
	check(
		cpu.widths.join() === dims.widths.join() &&
			cpu.heights.join() === dims.heights.join() &&
			cpu.minLevel === dims.minLevel,
		`${W}x${H} shape`,
	);
	cpu.mips.forEach((m, i) => {
		const same =
			m.length === levels[i].length && m.every((v, j) => v === levels[i][j]);
		check(same, `${W}x${H} level ${i}`);
	});
}
if (failures) process.exit(1);
console.log("mosaic-mips.check: ok");
