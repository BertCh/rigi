// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Max-mip pyramid of a ring mosaic on the GPU (the GPU mip build): the twin of horizon-fast/mosaic.ts
// gridMips. The mosaic's heights are uploaded once into the march's storage page and the mips are
// built there, in place, so the CPU never builds (or uploads) the pyramid.
//
// Every cell is the max over an exact block of the level below (level 0: 4 x 4 pixels, edge blocks
// clipped; higher levels: 2 x 2 cells, edge blocks clipped), the same partition the CPU takes (its
// `min(pw - 1, a + 1)` clamp repeats a cell, which a max ignores). Max is order independent and the
// compare is the CPU's `v > mx` on the first element, so the f32 words are byte-identical to the CPU's
// (checked on Dawn by scripts/gpu/mosaic-mips-dawn.ts).
//
// One graph "mosaic-mips" (1 kernel, 2 imports: the per-level params uniform and the page), encoded once
// per (ring, level) into one command encoder. Levels of a ring are separate dispatches: WebGPU orders
// them (storage read-write barrier), each reads the cells the previous one wrote.
import { Buffer, type Device } from "@luma.gl/core";
import { cachedGraph } from "#/lib/gpu/core/graph";
import { defineKernel, submit } from "#/lib/gpu/core/kernel";
import { MIP_MAX_LEVEL, MIP_MIN_LEVEL } from "#/lib/horizon-fast/mosaic";
import { MOSAIC_MIP_P } from "./uniforms";

const MIP_WGSL = /* wgsl */ `
struct P {
	srcOff: u32,
	srcW: u32,
	srcH: u32,
	dstOff: u32,
	dstW: u32,
	dstH: u32,
	factor: u32,
	pad: u32,
}
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read_write> page: array<f32>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
	if (id.x >= p.dstW || id.y >= p.dstH) { return; }
	let x0 = id.x * p.factor;
	let y0 = id.y * p.factor;
	let x1 = min(p.srcW, x0 + p.factor);
	let y1 = min(p.srcH, y0 + p.factor);
	var mx = page[p.srcOff + y0 * p.srcW + x0];
	for (var y = y0; y < y1; y++) {
		let row = p.srcOff + y * p.srcW;
		for (var x = x0; x < x1; x++) {
			let v = page[row + x];
			if (v > mx) { mx = v; }
		}
	}
	page[p.dstOff + id.y * p.dstW + id.x] = mx;
}
`;

export const MOSAIC_MIP = defineKernel(
	"mosaic-mip",
	MIP_WGSL,
	[
		["p", "uniform"],
		["page", "storage"],
	],
	{ group: "mosaic-mips", label: "mosaic-mip" },
);

type Params = { workgroupsX: number; workgroupsY: number };

/** Pyramid dims of a W x H mosaic (the CPU buildMips defaults: levels 2 to 8). */
export function mipDims(
	width: number,
	height: number,
	minLevel = MIP_MIN_LEVEL,
	maxLevel = MIP_MAX_LEVEL,
) {
	const widths: number[] = [];
	const heights: number[] = [];
	for (let level = minLevel; level <= maxLevel; level++) {
		widths.push(Math.ceil(width / (1 << level)));
		heights.push(Math.ceil(height / (1 << level)));
	}
	return { minLevel, widths, heights };
}

export interface MipJob {
	/** f32 word offset of the mosaic's heights in the page */
	dataOff: number;
	width: number;
	height: number;
	minLevel: number;
	widths: number[];
	heights: number[];
	/** f32 word offset of each level in the page */
	mipOff: number[];
}

/**
 * Builds every job's mips inside `page` (its heights already written) and returns once the work is
 * submitted (queue order puts it before the march's reads). Call inside the "horizon" lease.
 */
export async function buildMipsGpu(
	device: Device,
	page: Buffer,
	jobs: MipJob[],
): Promise<void> {
	const { graph } = cachedGraph<Params>(
		device,
		"mosaic-mips",
		`pg${page.byteLength}`,
		(g) => {
			const p = g.importBuffer("p", 32, undefined, Buffer.UNIFORM);
			const pg = g.importBuffer(
				"page",
				page.byteLength,
				undefined,
				Buffer.STORAGE,
			);
			g.addKernel({
				id: "mip",
				spec: MOSAIC_MIP,
				bindings: { p, page: pg },
				workgroups: (q) => [q.workgroupsX, q.workgroupsY, 1],
			});
			return undefined;
		},
		2,
	);
	await graph.lease(async () => {
		if (!graph.isCompiled) await graph.compileAsync();
		const enc = device.createCommandEncoder({ id: "mosaic-mips" });
		const uniforms: Buffer[] = [];
		try {
			for (const job of jobs) {
				for (let i = 0; i < job.widths.length; i++) {
					const fromPixels = i === 0;
					const words = new Uint8Array(
						MOSAIC_MIP_P.pack({
							srcOff: fromPixels ? job.dataOff : job.mipOff[i - 1],
							srcW: fromPixels ? job.width : job.widths[i - 1],
							srcH: fromPixels ? job.height : job.heights[i - 1],
							dstOff: job.mipOff[i],
							dstW: job.widths[i],
							dstH: job.heights[i],
							factor: fromPixels ? 1 << job.minLevel : 2,
						}),
					);
					const u = device.createBuffer({
						id: `mosaic-mip-u${uniforms.length}`,
						usage: Buffer.UNIFORM | Buffer.COPY_DST,
						data: words,
					});
					uniforms.push(u);
					graph.encode(
						enc,
						{
							workgroupsX: Math.ceil(job.widths[i] / 8),
							workgroupsY: Math.ceil(job.heights[i] / 8),
						},
						{ p: u, page },
					);
				}
			}
			submit(device, enc);
		} finally {
			// destroy is deferred by WebGPU until the submitted work is done with them
			for (const u of uniforms) u.destroy();
		}
	});
}
