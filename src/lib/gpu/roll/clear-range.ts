// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The roll map's clear-air range grid on the GPU. The haze fit and the exposure gains only ever use
// the photo's range map decimated to <= 256 px on the long side (roll/map/drape-clear.ts
// decimateRange: nearest sample at stride `step`, non-finite -> 0, row 0 = top), so instead of reading
// the whole geometry target back (w x h x 16 B texels, or 4 B per pixel after an unpack) this samples
// the target at the stride positions on the GPU and reads back only the W x H grid (plus a nonce word).
//
// The target is WebGpuGeometrySource's (rgba32float, row 0 = top, .w = range, 0 = sky). The rule is
// the old chain's (unpack: r > 0 ? r : +Inf; then setRange: finite ? r : 0), stated on bit patterns
// as in roll/map/range-handoff-reference.ts: keep 0 < r < +Infinity, else +0. No float arithmetic is
// done on a texel, so the grid equals the CPU decimation byte for byte (denormals included).
//
// One core graph (cachedGraph group "roll-clear-range", keyed by the target's shape): kernel
// "clear-range" (one thread per grid cell) into a pooled storage buffer, one read node.
import { Buffer, type Device, type Texture } from "@luma.gl/core";
import {
	importSampledTexture,
	textureShapeKey,
} from "#/lib/deck-webgpu/graph-texture";
import { cachedGraph, type GraphRange } from "../core/graph";
import { defineKernel } from "../core/kernel";
import { acquire, pooledUniform } from "../core/pool";
import { defineUniformBlock } from "../core/uniform-block";

const GROUP = "roll-clear-range";
const POOL = "roll-clear-range";
const WG = 64;
const READ = "clear-range-read";
const MIN_BYTES = 16;
const OUT_USAGE = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;
/** +Infinity's bits: the first word that is no longer a finite positive range. */
const KEEP_LIMIT_BITS = 0x7f800000;

// out[0] = nonce, out[1 + y * gw + x] = the kept word of texel (x * step, y * step)
export const CLEAR_RANGE_WGSL = /* wgsl */ `
struct P { gw: u32, gh: u32, step: u32, nonce: u32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<u32>;
@compute @workgroup_size(${WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let i = id.x;
	if (i == 0u) { outp[0] = prm.nonce; }
	if (i >= prm.gw * prm.gh) { return; }
	let x = (i % prm.gw) * prm.step;
	let y = (i / prm.gw) * prm.step;
	let b = bitcast<u32>(textureLoad(src, vec2<i32>(i32(x), i32(y)), 0).w);
	outp[1u + i] = select(0u, b, b > 0u && b < ${KEEP_LIMIT_BITS}u);
}
`;

const SPEC = defineKernel(
	"clear-range",
	CLEAR_RANGE_WGSL,
	[
		["prm", "uniform"],
		["src", "texture"],
		["outp", "storage"],
	],
	{ group: GROUP },
);
const PRM = defineUniformBlock({
	gw: "u32",
	gh: "u32",
	step: "u32",
	nonce: "u32",
});

type Run = { cells: number; gw: number; gh: number };

let nonce = 0;

/**
 * The geometry target `src` (w x h, rgba32float, .w = range) sampled at every `step`-th texel:
 * a floor(w / step) x floor(h / step) grid, row 0 = top, byte-equal to drape-clear's decimateRange
 * of the unpacked range map. Reads back only the grid (+ one nonce word); null = failed / lost /
 * a run whose commands did not execute.
 */
export async function readClearRangeGrid(
	device: Device,
	src: Texture,
	step: number,
): Promise<{ w: number; h: number; data: Float32Array; bytes: number } | null> {
	const gw = Math.floor(src.width / step);
	const gh = Math.floor(src.height / step);
	if (gw < 1 || gh < 1 || device.type !== "webgpu" || device.isLost)
		return null;
	const cells = gw * gh;
	try {
		const { graph } = cachedGraph<Run, void>(
			device,
			GROUP,
			textureShapeKey(src),
			(g) => {
				const out = g.importBuffer("outp", MIN_BYTES);
				const range = (): GraphRange<Run> => ({
					buffer: out,
					size: (p) => (1 + p.cells) * 4,
				});
				g.addKernel({
					id: "clear-range",
					spec: SPEC,
					bindings: {
						prm: g.importBuffer(
							"prm",
							PRM.byteLength,
							undefined,
							Buffer.UNIFORM,
						),
						src: importSampledTexture(g, "src", src),
						outp: range(),
					},
					workgroups: (p) => [Math.ceil((p.cells + 1) / WG)],
				});
				g.readNode(READ, [range()]);
			},
			4,
		);
		nonce = (nonce % 0x7ffffffe) + 1;
		const mine = nonce;
		const slot = `${POOL}/grid`;
		const buffers = {
			prm: pooledUniform(
				device,
				`${slot}/prm`,
				PRM.pack({ gw, gh, step, nonce: mine }),
			),
			outp: acquire(device, `${slot}/out`, (1 + cells) * 4, OUT_USAGE),
		};
		const { reads } = await graph.runNow(
			{ cells, gw, gh },
			{ buffers, textures: { src } },
		);
		const raw = reads[READ][0];
		if (new Uint32Array(raw, 0, 1)[0] !== mine) return null;
		return {
			w: gw,
			h: gh,
			data: new Float32Array(raw.slice(4, 4 + cells * 4)),
			bytes: (1 + cells) * 4,
		};
	} catch (e) {
		console.warn("[roll-clear-range] failed, full readback", e);
		return null;
	}
}
