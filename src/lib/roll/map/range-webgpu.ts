// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// WebGPU twin of the roll drape's range-map hand-off (RangeHandOff in ./backend.ts; the WebGL2 one is
// ./range-gpu.ts): the geometry source's target goes into its range-atlas cell on the GPU and only the
// COARSE-pooled grid the CPU cull needs (1/64 of the texels) is read back, instead of a full readback,
// the unpack, rangeMapFrom, a writeData re-upload and the CPU max-pool.
//
// The target is WebGpuGeometrySource's (layers/geometry-source.ts, targets.ts): rgba32float, row 0 =
// top already, .w = range, 0 = sky. Sky (w = 0) lands as +0 in the cell and the grid, the same value
// rangeMapFrom(unpack(...)) gives it (unpack makes a non-positive w +Infinity, rangeMapFrom turns that
// into 0). The rule is range-handoff-reference.ts's, on bit patterns: keep 0 < r < +Infinity, else +0.
//
// Two core graphs (cachedGraph group "range-handoff", keyed by the texture shapes), both over the
// sampled target:
//   copy    kernel "range-copy" (one thread per texel) writes the fixed-up words into a pooled storage
//           buffer with rows padded to 256 B, then a copy node (copyBufferToTexture) puts them into the
//           cell [x, y] w x h of the atlas. No storage-texture write: DrapeAtlas creates `range` with
//           luma's default usage (sampled | copy-src | copy-dst | render), which has no STORAGE bit,
//           and a buffer -> texture copy needs only COPY_DST. copyInto is synchronous: the graph is
//           compiled and submitted inside the call (ComputeGraph.runNow), nothing awaits.
//   pool    kernel "range-pool" (one thread per coarse cell, COARSE^2 texelFetches, max over the
//           u32 bit patterns of the kept texels: float order = bit order for positive finite floats)
//           into a pooled storage buffer; one read node copies the grid (plus a nonce word) to the
//           readback ring. A run whose commands did not execute leaves another nonce: null result.
// Neither kernel does float arithmetic on a texel, so the cell texels and the grid equal the CPU
// reference byte for byte (denormals included).
import { Buffer, type Device, Texture } from "@luma.gl/core";
import {
	importSampledTexture,
	textureShapeKey,
} from "#/lib/deck-webgpu/graph-texture";
import {
	type ComputeGraph,
	cachedGraph,
	type GraphRange,
} from "#/lib/gpu/core/graph";
import { defineKernel, kernelAsync } from "#/lib/gpu/core/kernel";
import { acquire, pooledUniform, releasePool } from "#/lib/gpu/core/pool";
import { defineUniformBlock } from "#/lib/gpu/core/uniform-block";
import type { RangeHandOff } from "./backend";
import { COARSE, type CoarseRange } from "./drape-atlas";
import { RANGE_KEEP_LIMIT_BITS } from "./range-handoff-reference";

const GROUP = "range-handoff";
const POOL = "range-handoff";
const COPY_WG = 8;
const POOL_WG = 64;
/** Rows of a buffer -> texture copy are padded to this many bytes (WebGPU bytesPerRow rule). */
const ROW_ALIGN = 256;

/** `src` texel .w (bits) as the range-map word: kept when 0 < r < +Infinity, else +0. */
const FIXUP = /* wgsl */ `
fn keepBits(b: u32) -> u32 {
	return select(0u, b, b > 0u && b < ${RANGE_KEEP_LIMIT_BITS}u);
}
fn rangeWord(src: texture_2d<f32>, x: u32, y: u32) -> u32 {
	return keepBits(bitcast<u32>(textureLoad(src, vec2<i32>(i32(x), i32(y)), 0).w));
}`;

export const RANGE_COPY_WGSL = /* wgsl */ `
struct P { w: u32, h: u32, rowWords: u32, pad: u32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> rows: array<u32>;
${FIXUP}
@compute @workgroup_size(${COPY_WG}, ${COPY_WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	if (id.x >= prm.w || id.y >= prm.h) { return; }
	rows[id.y * prm.rowWords + id.x] = rangeWord(src, id.x, id.y);
}
`;

// out[0] = nonce, out[1 + cy * cw + cx] = the block's max word
export const RANGE_POOL_WGSL = /* wgsl */ `
struct P { w: u32, h: u32, cw: u32, ch: u32, nonce: u32 };
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> outp: array<u32>;
${FIXUP}
@compute @workgroup_size(${POOL_WG})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let i = id.x;
	if (i == 0u) { outp[0] = prm.nonce; }
	if (i >= prm.cw * prm.ch) { return; }
	let x0 = (i % prm.cw) * ${COARSE}u;
	let y0 = (i / prm.cw) * ${COARSE}u;
	let x1 = min(x0 + ${COARSE}u, prm.w);
	let y1 = min(y0 + ${COARSE}u, prm.h);
	var m = 0u;
	for (var y = y0; y < y1; y++) {
		for (var x = x0; x < x1; x++) {
			m = max(m, rangeWord(src, x, y));
		}
	}
	outp[1u + i] = m;
}
`;

const COPY_SPEC = defineKernel(
	"range-copy",
	RANGE_COPY_WGSL,
	[
		["prm", "uniform"],
		["src", "texture"],
		["rows", "storage"],
	],
	{ group: GROUP },
);
const POOL_SPEC = defineKernel(
	"range-pool",
	RANGE_POOL_WGSL,
	[
		["prm", "uniform"],
		["src", "texture"],
		["outp", "storage"],
	],
	{ group: GROUP },
);

const COPY_PRM = defineUniformBlock({
	w: "u32",
	h: "u32",
	rowWords: "u32",
	pad: "u32",
});
const POOL_PRM = defineUniformBlock({
	w: "u32",
	h: "u32",
	cw: "u32",
	ch: "u32",
	nonce: "u32",
});

const MIN_BYTES = 16;
const OUT_USAGE = Buffer.STORAGE | Buffer.COPY_SRC | Buffer.COPY_DST;
const POOL_READ = "range-pool-read";

type CopyRun = { x: number; y: number; w: number; h: number; rowBytes: number };

/** kernel (target -> padded rows buffer), then rows -> atlas cell. */
function buildCopyGraph(
	g: ComputeGraph<CopyRun>,
	src: Texture,
	atlas: Texture,
) {
	const srcHandle = importSampledTexture(g, "src", src);
	const atlasHandle = g.importTexture({
		id: "atlas",
		format: atlas.format,
		dimension: atlas.dimension,
		width: atlas.width,
		height: atlas.height,
		depth: atlas.depth,
		mipLevels: atlas.mipLevels,
		samples: atlas.samples,
		usage: Texture.COPY_DST,
	});
	const rows = g.importBuffer("rows", MIN_BYTES);
	g.addKernel({
		id: "copy",
		spec: COPY_SPEC,
		bindings: {
			prm: g.importBuffer(
				"prm",
				COPY_PRM.byteLength,
				undefined,
				Buffer.UNIFORM,
			),
			src: srcHandle,
			rows: { buffer: rows, size: (p) => p.rowBytes * p.h },
		},
		workgroups: (p) => [Math.ceil(p.w / COPY_WG), Math.ceil(p.h / COPY_WG)],
	});
	g.addCopyPass({
		id: "to-atlas",
		dependsOn: ["copy"],
		resources: [
			{ buffer: rows, usage: "copy-source" },
			{ texture: atlasHandle, usage: "copy-destination" },
		],
		compile: () => ({
			encode: ({ commandEncoder, getBuffer, getTexture, parameters }) =>
				commandEncoder.copyBufferToTexture({
					sourceBuffer: getBuffer(rows),
					destinationTexture: getTexture(atlasHandle),
					origin: [parameters.x, parameters.y, 0],
					bytesPerRow: parameters.rowBytes,
					rowsPerImage: parameters.h,
					size: [parameters.w, parameters.h, 1],
				}),
		}),
	});
}

type PoolRun = { w: number; h: number; cells: number };

function buildPoolGraph(g: ComputeGraph<PoolRun>, src: Texture) {
	const out = g.importBuffer("outp", MIN_BYTES);
	const range = (): GraphRange<PoolRun> => ({
		buffer: out,
		size: (p) => (1 + p.cells) * 4,
	});
	g.addKernel({
		id: "pool",
		spec: POOL_SPEC,
		bindings: {
			prm: g.importBuffer(
				"prm",
				POOL_PRM.byteLength,
				undefined,
				Buffer.UNIFORM,
			),
			src: importSampledTexture(g, "src", src),
			outp: range(),
		},
		// thread 0 writes the nonce even when there are no cells
		workgroups: (p) => [Math.ceil((p.cells + 1) / POOL_WG)],
	});
	g.readNode(POOL_READ, [range()]);
}

export class RangeGpuWebGpu implements RangeHandOff {
	private building: Promise<void> | null = null;
	private built = false;
	private broken = false;
	private destroyed = false;
	private nonce = 0;

	constructor(readonly device: Device) {}

	private get usable() {
		return (
			!this.broken &&
			!this.destroyed &&
			this.device.type === "webgpu" &&
			!this.device.isLost
		);
	}

	/** Usable now (a WebGPU device that isn't lost, pipelines built); starts the build on first call. */
	get ok() {
		if (!this.usable) return false;
		void this.build();
		return this.built;
	}

	/** Resolves once the pipelines are built (or failed: `ok` then stays false). */
	async whenReady(): Promise<void> {
		if (!this.usable) return;
		await this.build();
	}

	private build(): Promise<void> {
		this.building ??= (async () => {
			try {
				await Promise.all([
					kernelAsync(this.device, COPY_SPEC),
					kernelAsync(this.device, POOL_SPEC),
				]);
				this.built = true;
			} catch (e) {
				console.warn("[range-webgpu]", e);
				this.broken = true;
			}
		})();
		return this.building;
	}

	/**
	 * rangeMapFrom(src) into `atlas` (the DrapeAtlas `range` r32float texture) at cell [x, y] of size
	 * w x h. Synchronous: recorded and submitted before it returns; false = nothing written.
	 */
	copyInto(
		atlas: Texture,
		[x, y]: [number, number],
		src: Texture,
		w: number,
		h: number,
	): boolean {
		if (!this.ok || atlas.format !== "r32float") return false;
		if (src.width !== w || src.height !== h || w < 1 || h < 1) return false;
		if (x < 0 || y < 0 || x + w > atlas.width || y + h > atlas.height)
			return false;
		const device = this.device;
		try {
			const { graph } = cachedGraph<CopyRun, void>(
				device,
				GROUP,
				`copy:${textureShapeKey(src)}>${textureShapeKey(atlas)}`,
				(g) => buildCopyGraph(g, src, atlas),
				4,
			);
			const rowBytes = Math.ceil((w * 4) / ROW_ALIGN) * ROW_ALIGN;
			const slot = `${POOL}/copy`;
			const run: CopyRun = { x, y, w, h, rowBytes };
			const buffers = {
				prm: pooledUniform(
					device,
					`${slot}/prm`,
					COPY_PRM.pack({ w, h, rowWords: rowBytes / 4, pad: 0 }),
				),
				rows: acquire(device, `${slot}/rows`, rowBytes * h, OUT_USAGE),
			};
			// compile + encode + submit happen synchronously in runNow; the promise only has the
			// (empty) reads, so a failure after the submit can only be reported
			graph
				.runNow(run, { buffers, textures: { src, atlas } })
				.catch((e) => console.warn("[range-webgpu] copy failed", e));
			return true;
		} catch (e) {
			console.warn("[range-webgpu] copy failed", e);
			return false;
		}
	}

	/**
	 * coarsen(rangeMapFrom(src).data, w, h) on the GPU; only the ceil(w / COARSE) x ceil(h / COARSE)
	 * grid (plus a nonce word) is read back. null = not usable / lost / cancelled / bad nonce.
	 */
	async coarse(
		src: Texture,
		w: number,
		h: number,
		cancelled: () => boolean = () => false,
	): Promise<{ grid: CoarseRange; mainMs: number; bytes: number } | null> {
		if (!this.ok || src.width !== w || src.height !== h || w < 1 || h < 1)
			return null;
		const device = this.device;
		const t0 = performance.now();
		const cw = Math.ceil(w / COARSE);
		const ch = Math.ceil(h / COARSE);
		const cells = cw * ch;
		try {
			const graphOf = () =>
				cachedGraph<PoolRun, void>(
					device,
					GROUP,
					`pool:${textureShapeKey(src)}`,
					(g) => buildPoolGraph(g, src),
					4,
				).graph;
			const first = graphOf();
			if (!first.isCompiled) await first.compileAsync();
			if (this.destroyed || device.isLost || cancelled()) return null;
			// nothing awaits between the slot writes and the submit inside runNow
			const graph = graphOf();
			this.nonce = (this.nonce % 0x7ffffffe) + 1;
			const nonce = this.nonce;
			const slot = `${POOL}/pool`;
			const buffers = {
				prm: pooledUniform(
					device,
					`${slot}/prm`,
					POOL_PRM.pack({ w, h, cw, ch, nonce }),
				),
				outp: acquire(device, `${slot}/out`, (1 + cells) * 4, OUT_USAGE),
			};
			const { reads } = await graph.runNow(
				{ w, h, cells },
				{ buffers, textures: { src } },
			);
			if (this.destroyed || device.isLost || cancelled()) return null;
			const raw = reads[POOL_READ][0];
			const words = new Uint32Array(raw, 0, 1 + cells);
			if (words[0] !== nonce) {
				console.warn("[range-webgpu] pool nonce mismatch, CPU path");
				return null;
			}
			const data = new Float32Array(raw.slice(4, 4 + cells * 4));
			return {
				grid: { width: cw, height: ch, data },
				mainMs: performance.now() - t0,
				bytes: (1 + cells) * 4,
			};
		} catch (e) {
			console.warn("[range-webgpu] coarse failed, CPU path", e);
			return null;
		}
	}

	destroy() {
		if (this.destroyed) return;
		this.destroyed = true;
		if (!this.device.isLost) releasePool(this.device, `${POOL}/`);
	}
}
