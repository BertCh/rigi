// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The relief field's height raster gathered on the GPU: look/relief/heights.ts rasterizeHeights
// (1024² heights sampled from the loaded DEM tiles, ~15 ms of CPU) as a WGSL kernel reading the DEM
// tiles that deck-webgpu's batched terrain already holds on the render device, feeding the relief
// graph's H input inside the SAME submission (no CPU raster, no upload of H, no readback).
//
//   plan (CPU, f64, metadata only: no height touches the CPU)
//     extent / node table / per-tile rows        → three small uploads (~2 KB + 1.5 KB + rows)
//   graph (look-relief group, cachedGraph; one shape per (res, row cap, unit cap, pool depths))
//     copy: the used tiles' layers of the two r32float height arrays → "th" (a transient buffer)
//     gather: H[texel] = the finest tile covering it, bilinear (RELIEF_HEIGHTS)
//     relief graph (buildReliefGraph(…, hIn = H), out = "texture") → field / gen textures
//
// Same scheme as rasterizeHeights (kept in step with it):
// - extent: the relief field's, centred AHEAD m along the 30°-snapped yaw (mirror of relief.ts
//   reliefHeights: RES / HALF / AHEAD), texel centres, row 0 = south;
// - Mercator lookup: frame.toGeo at 33 × 33 nodes (f64), bilinear in between; the nodes are stored
//   relative to the first node (f32, ≈ 1e-3 z14 px as the CPU's f32 mx / my), the per-tile origin
//   term ax / ay = (ox · 2^z − key) · S is f64 here;
// - tile choice: tiles sorted by zoom (stable) and the finest wins; rows are stored finest first
//   and the kernel takes the first containing tile (same winner, including equal-zoom duplicates);
//   each tile only tests the texels of its corner box (+1 texel), as the CPU loop does;
// - interpolation: dem/grid.ts sampleGrid (pixel-centred, clamped to the outer sample centres);
// - no data: HOLE (-1e6) where no tile covers; the tile heights are the very floats the CPU
//   path reads (TileMesh.heights is what the terrain uploaded).
// Differences from the CPU raster are f32 vs f64 arithmetic only (checked by
// scripts/gpu/relief-heights-check.mjs: emulateReliefHeights is this kernel's f32 twin).
//
// A build is only planned when every tile touching the extent is resident on `device`; otherwise
// planReliefHeights returns null and the caller keeps the CPU raster (compute-bridge.ts).
import { Buffer, type Device, Texture } from "@luma.gl/core";
import { latToTileY, lonToTileX, tileBounds } from "../../dem/tiles";
import type { EnuFrame } from "../../geodesy";
import type { HeightTile } from "../../look/relief/heights";
import { type ComputeGraph, cachedGraph } from "../core/graph";
import { pooledStorage, pooledUniform, withLease } from "../core/pool";
import { defineUniformBlock } from "../core/uniform-block";
import { defineKernel } from "./kernel";
import { reliefGradientShape } from "./relief";
import type { ReliefOutTextures } from "./relief-graph";
import {
	buildReliefGraph,
	type GradientShape,
	RELIEF_GRAPH_GROUP,
} from "./relief-graph";

// mirror of relief.ts / field.ts (keep in sync; the check compares the extent with reliefHeights)
const RES = 1024;
const HALF = 20000;
const AHEAD = 12000;
const HOLE = -1e6;
/** rasterizeHeights' Mercator lookup grid. */
const G = 32;
const NN = G + 1;
/** deck-webgpu/layers/batched-terrain.ts SMALL / BIG height-array layer sizes. */
const SMALL = 256;
const BIG = 512;
/** Gather buffer unit: one SMALL² layer of f32. A BIG layer is four units. */
const UNIT = SMALL * SMALL;
const UNIT_BYTES = UNIT * 4;
/** Tile row: 12 words (see the WGSL Tile struct). */
const ROW_WORDS = 12;

/** RELIEF_HEIGHTS `P` and `Tile` (the tile row is 12 scalar words, the same in storage and uniform layout). */
export const HEIGHTS_PARAMS = defineUniformBlock({
	res: "u32",
	nT: "u32",
	hole: "f32",
	pad: "u32",
});
export const TILE_ROW = defineUniformBlock({
	ax: "f32",
	ay: "f32",
	k: "f32",
	S: "u32",
	stride: "u32",
	off: "u32",
	i0: "i32",
	i1: "i32",
	j0: "i32",
	j1: "i32",
	p0: "u32",
	p1: "u32",
});

export const RELIEF_HEIGHTS = /* wgsl */ `
struct P { res: u32, nT: u32, hole: f32, pad: u32 };
struct Tile {
  ax: f32, ay: f32, k: f32,
  S: u32, stride: u32, off: u32,
  i0: i32, i1: i32, j0: i32, j1: i32,
  p0: u32, p1: u32,
};
@group(0) @binding(0) var<uniform> prm: P;
@group(0) @binding(1) var<storage, read> nodes: array<vec2<f32>>;
@group(0) @binding(2) var<storage, read> tiles: array<Tile>;
@group(0) @binding(3) var<storage, read> th: array<f32>;
@group(0) @binding(4) var<storage, read_write> H: array<f32>;

// dem/grid.ts sampleGrid on tile t at pixel coords (px, py)
fn sampleTile(t: Tile, px: f32, py: f32) -> f32 {
  let m = f32(t.S) - 1.0;
  let x = min(max(px - 0.5, 0.0), m);
  let y = min(max(py - 0.5, 0.0), m);
  let x0 = u32(floor(x));
  let y0 = u32(floor(y));
  let x1 = min(x0 + 1u, t.S - 1u);
  let y1 = min(y0 + 1u, t.S - 1u);
  let fx = x - f32(x0);
  let fy = y - f32(y0);
  let r0 = t.off + y0 * t.stride;
  let r1 = t.off + y1 * t.stride;
  let a = th[r0 + x0] * (1.0 - fx) + th[r0 + x1] * fx;
  let b = th[r1 + x0] * (1.0 - fx) + th[r1 + x1] * fx;
  return a * (1.0 - fy) + b * fy;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let res = prm.res;
  if (id.x >= res || id.y >= res) { return; }
  let fres = f32(res);
  // the Mercator lookup: bilinear in the 33 x 33 node table at the texel centre
  let v = ((f32(id.y) + 0.5) / fres) * 32.0;
  let u = ((f32(id.x) + 0.5) / fres) * 32.0;
  let cj = min(u32(floor(v)), 31u);
  let ci = min(u32(floor(u)), 31u);
  let fv = v - f32(cj);
  let fu = u - f32(ci);
  let k = cj * 33u + ci;
  let m = nodes[k] * ((1.0 - fu) * (1.0 - fv))
        + nodes[k + 1u] * (fu * (1.0 - fv))
        + nodes[k + 33u] * ((1.0 - fu) * fv)
        + nodes[k + 34u] * (fu * fv);
  let ii = i32(id.x);
  let jj = i32(id.y);
  var h = prm.hole;
  for (var q = 0u; q < prm.nT; q++) {
    let t = tiles[q];
    if (ii < t.i0 || ii > t.i1 || jj < t.j0 || jj > t.j1) { continue; }
    let tx = t.ax + m.x * t.k;
    let ty = t.ay + m.y * t.k;
    let s = f32(t.S);
    if (tx >= 0.0 && tx < s && ty >= 0.0 && ty < s) {
      h = sampleTile(t, tx, ty);
      break;
    }
  }
  H[id.y * res + id.x] = h;
}
`;

export const K_RELIEF_HEIGHTS = defineKernel(
	"relief-heights",
	RELIEF_HEIGHTS,
	[
		["prm", "uniform"],
		["nodes", "read-only-storage"],
		["tiles", "read-only-storage"],
		["th", "read-only-storage"],
		["H", "storage"],
	],
	{ group: "look-relief" },
);

/** Where a tile's heights live on the device (deck-webgpu BatchedTerrainCore.residentHeights). */
export type HeightResidency = {
	small: Texture;
	big: Texture;
	slotOf(tile: object): { layer: number; big: boolean } | null;
};

/** One tile's layer copied into the gather buffer. */
export type LayerCopy = { big: boolean; layer: number; byteOffset: number };

export type HeightsPlan = {
	res: number;
	extent: [number, number, number, number];
	px: number;
	/** 33 × 33 (x, y) f32 pairs: zoom-0 Mercator relative to the first node */
	nodes: Float32Array;
	/** ROW_WORDS words per tile, finest first (the kernel takes the first containing tile) */
	rows: ArrayBuffer;
	nRows: number;
	copies: LayerCopy[];
	/** gather buffer units (SMALL² f32) used */
	units: number;
	/** no-data value */
	hole: number;
};

const pow2 = (n: number, min: number) =>
	2 ** Math.ceil(Math.log2(Math.max(n, min)));

/**
 * The plan for the relief height raster of `tiles` / `frame` / `yawDeg` (same extent as
 * reliefHeights), or null when a tile that touches the extent is not resident in `resident` or the
 * gather would not fit the device's storage binding limit (the CPU raster is then used).
 */
export function planReliefHeights(
	device: Device,
	tiles: readonly HeightTile[],
	frame: EnuFrame,
	yawDeg: number | null,
	resident: HeightResidency,
): HeightsPlan | null {
	if (resident.small.device !== device || resident.big.device !== device)
		return null;
	const plan = planHeights(tiles, frame, yawDeg, (t) => {
		const s = resident.slotOf(t);
		return s ? { ...s, ok: true } : null;
	});
	if (!plan) return null;
	const limit =
		(device.limits as { maxStorageBufferBindingSize?: number })
			.maxStorageBufferBindingSize ?? 128 * 2 ** 20;
	if (pow2(plan.units, 16) * UNIT_BYTES > limit) return null;
	return plan;
}

/** The device-free part of planReliefHeights; `slotOf` = null aborts the plan (tile not resident). */
export function planHeights(
	tiles: readonly HeightTile[],
	frame: EnuFrame,
	yawDeg: number | null,
	slotOf: (t: HeightTile) => { layer: number; big: boolean } | null,
	res = RES,
): HeightsPlan | null {
	const a = ((yawDeg ?? 0) * Math.PI) / 180;
	const c =
		yawDeg == null ? [0, 0] : [Math.sin(a) * AHEAD, Math.cos(a) * AHEAD];
	const extent: HeightsPlan["extent"] = [
		c[0] - HALF,
		c[1] - HALF,
		c[0] + HALF,
		c[1] + HALF,
	];
	const [x0, y0, x1, y1] = extent;
	const px = (x1 - x0) / res;
	// zoom-0 Mercator at the 33 × 33 nodes, relative to the first node
	const nx = new Float64Array(NN * NN);
	const ny = new Float64Array(NN * NN);
	for (let j = 0; j < NN; j++)
		for (let i = 0; i < NN; i++) {
			const g = frame.toGeo(
				x0 + ((x1 - x0) * i) / G,
				y0 + ((y1 - y0) * j) / G,
				0,
			);
			nx[j * NN + i] = lonToTileX(g.lon, 0);
			ny[j * NN + i] = latToTileY(g.lat, 0);
		}
	const ox = nx[0];
	const oy = ny[0];
	const nodes = new Float32Array(NN * NN * 2);
	for (let q = 0; q < NN * NN; q++) {
		nodes[2 * q] = nx[q] - ox;
		nodes[2 * q + 1] = ny[q] - oy;
	}

	// rasterizeHeights' tile loop: ascending zoom (stable), texel box of the corners + 1
	type Row = {
		t: HeightTile;
		ax: number;
		ay: number;
		k: number;
		box: [number, number, number, number];
	};
	const rows: Row[] = [];
	const e = [0, 0, 0];
	for (const t of [...tiles].sort((p, q) => p.key.z - q.key.z)) {
		const b = tileBounds(t.key);
		let lx = Number.POSITIVE_INFINITY;
		let ly = Number.POSITIVE_INFINITY;
		let hx = Number.NEGATIVE_INFINITY;
		let hy = Number.NEGATIVE_INFINITY;
		for (const [lat, lon] of [
			[b.north, b.west],
			[b.north, b.east],
			[b.south, b.west],
			[b.south, b.east],
		]) {
			frame.fromGeo(lat, lon, 0, e);
			lx = Math.min(lx, e[0]);
			hx = Math.max(hx, e[0]);
			ly = Math.min(ly, e[1]);
			hy = Math.max(hy, e[1]);
		}
		const i0 = Math.max(0, Math.floor((lx - x0) / px) - 1);
		const i1 = Math.min(res - 1, Math.ceil((hx - x0) / px) + 1);
		const j0 = Math.max(0, Math.floor((ly - y0) / px) - 1);
		const j1 = Math.min(res - 1, Math.ceil((hy - y0) / px) + 1);
		if (i0 > i1 || j0 > j1) continue;
		const S = t.size;
		const s = 2 ** t.key.z;
		rows.push({
			t,
			ax: (ox * s - t.key.x) * S,
			ay: (oy * s - t.key.y) * S,
			k: s * S,
			box: [i0, i1, j0, j1],
		});
	}
	rows.reverse(); // finest first

	const buf = new ArrayBuffer(Math.max(1, rows.length) * ROW_WORDS * 4);
	const copies: LayerCopy[] = [];
	let units = 0;
	for (let r = 0; r < rows.length; r++) {
		const { t, ax, ay, k, box } = rows[r];
		const slot = slotOf(t);
		if (!slot) return null;
		const P = slot.big ? BIG : SMALL;
		if (t.size > P) return null;
		const byteOffset = units * UNIT_BYTES;
		copies.push({ big: slot.big, layer: slot.layer, byteOffset });
		units += slot.big ? (BIG * BIG) / UNIT : 1;
		new Uint8Array(buf, r * ROW_WORDS * 4, ROW_WORDS * 4).set(
			new Uint8Array(
				TILE_ROW.pack({
					ax,
					ay,
					k,
					S: t.size,
					stride: P, // row stride of the copied layer
					off: byteOffset / 4,
					i0: box[0],
					i1: box[1],
					j0: box[2],
					j1: box[3],
				}),
				0,
				ROW_WORDS * 4,
			),
		);
	}
	return {
		res,
		extent,
		px,
		nodes,
		rows: buf,
		nRows: rows.length,
		copies,
		units,
		hole: HOLE,
	};
}

/**
 * The kernel in f32 on the CPU: `layers[r]` = the f32 heights of row r's tile (size × size, the
 * stride is the tile's own here), same arithmetic and order as RELIEF_HEIGHTS (Math.fround after
 * every operation). For scripts/gpu/relief-heights-check.mjs.
 */
export function emulateReliefHeights(
	plan: HeightsPlan,
	heightsOf: (row: number) => Float32Array,
): Float32Array {
	const f = Math.fround;
	const { res, nodes, nRows } = plan;
	const dv = new DataView(plan.rows);
	const rows = Array.from({ length: nRows }, (_, r) => {
		const o = r * ROW_WORDS * 4;
		return {
			ax: dv.getFloat32(o, true),
			ay: dv.getFloat32(o + 4, true),
			k: dv.getFloat32(o + 8, true),
			S: dv.getUint32(o + 12, true),
			box: [24, 28, 32, 36].map((d) => dv.getInt32(o + d, true)),
			h: heightsOf(r),
		};
	});
	const out = new Float32Array(res * res);
	const fres = f(res);
	for (let j = 0; j < res; j++) {
		const v = f(f(f(j + 0.5) / fres) * 32);
		const cj = Math.min(Math.floor(v), 31);
		const fv = f(v - cj);
		for (let i = 0; i < res; i++) {
			const u = f(f(f(i + 0.5) / fres) * 32);
			const ci = Math.min(Math.floor(u), 31);
			const fu = f(u - ci);
			const k = cj * NN + ci;
			const w = [
				f(f(1 - fu) * f(1 - fv)),
				f(fu * f(1 - fv)),
				f(f(1 - fu) * fv),
				f(fu * fv),
			];
			const mc = (c: number) =>
				f(
					f(
						f(f(nodes[2 * k + c] * w[0]) + f(nodes[2 * (k + 1) + c] * w[1])) +
							f(nodes[2 * (k + NN) + c] * w[2]),
					) + f(nodes[2 * (k + NN + 1) + c] * w[3]),
				);
			const mx = mc(0);
			const my = mc(1);
			let h = plan.hole;
			for (const t of rows) {
				if (i < t.box[0] || i > t.box[1] || j < t.box[2] || j > t.box[3])
					continue;
				const tx = f(t.ax + f(mx * t.k));
				const ty = f(t.ay + f(my * t.k));
				if (tx >= 0 && tx < t.S && ty >= 0 && ty < t.S) {
					const m = t.S - 1;
					const x = Math.min(Math.max(f(tx - 0.5), 0), m);
					const y = Math.min(Math.max(f(ty - 0.5), 0), m);
					const x0 = Math.floor(x);
					const y0 = Math.floor(y);
					const x1 = Math.min(x0 + 1, m);
					const y1 = Math.min(y0 + 1, m);
					const fx = f(x - x0);
					const fy = f(y - y0);
					const g = (yy: number, xx: number) => t.h[yy * t.S + xx];
					const a = f(f(g(y0, x0) * f(1 - fx)) + f(g(y0, x1) * fx));
					const b = f(f(g(y1, x0) * f(1 - fx)) + f(g(y1, x1) * fx));
					h = f(f(a * f(1 - fy)) + f(b * fy));
					break;
				}
			}
			out[j * res + i] = h;
		}
	}
	return out;
}

// ---------- the graph ----------

type Params = { degenerate: boolean; copies: readonly LayerCopy[] };

const UNIFORM = Buffer.UNIFORM | Buffer.COPY_DST;

/** gather graph shape: row capacity, gather units, height-array depths */
type Shape = {
	res: number;
	rowsCap: number;
	unitsCap: number;
	smallDepth: number;
	bigDepth: number;
	/** the relief graph's gradient planes (ring radius, texel size; from the run's uniform words) */
	gradient: GradientShape;
};

function buildGatherGraph(
	g: ComputeGraph<Params>,
	s: Shape,
	reliefPrmBytes: number,
) {
	const prm = g.importBuffer("gh-prm", 16, undefined, UNIFORM);
	const nodes = g.importBuffer("gh-nodes", NN * NN * 8);
	const tiles = g.importBuffer("gh-tiles", s.rowsCap * ROW_WORDS * 4);
	const th = g.transientBuffer("gh-th", s.unitsCap * UNIT_BYTES);
	const H = g.transientBuffer("gh-H", s.res * s.res * 4);
	const arr = (id: string, size: number, depth: number) =>
		g.importTexture({
			id,
			format: "r32float",
			width: size,
			height: size,
			depth,
			dimension: "2d-array",
			usage: Texture.COPY_SRC,
		});
	const hs = arr("gh-small", SMALL, s.smallDepth);
	const hb = arr("gh-big", BIG, s.bigDepth);
	g.graph.addCopyPass({
		id: "gh-copy",
		resources: [
			{ texture: hs, usage: "copy-source" },
			{ texture: hb, usage: "copy-source" },
			{ buffer: th, usage: "copy-destination" },
		],
		compile: () => ({
			encode: ({ commandEncoder, getBuffer, getTexture, parameters }) => {
				const dst = getBuffer(th);
				for (const c of parameters.copies) {
					const P = c.big ? BIG : SMALL;
					commandEncoder.copyTextureToBuffer({
						sourceTexture: getTexture(c.big ? hb : hs),
						origin: [0, 0, c.layer],
						width: P,
						height: P,
						depthOrArrayLayers: 1,
						destinationBuffer: dst,
						byteOffset: c.byteOffset,
						bytesPerRow: P * 4,
						rowsPerImage: P,
					});
				}
			},
		}),
	});
	g.addKernel({
		id: "gh-gather",
		spec: K_RELIEF_HEIGHTS,
		bindings: { prm, nodes, tiles, th, H },
		workgroups: [Math.ceil(s.res / 16), Math.ceil(s.res / 16)],
	});
	buildReliefGraph(
		g,
		s.res,
		0,
		reliefPrmBytes,
		false,
		"texture",
		H,
		s.gradient,
	);
}

/** Last gather run (bench / tests). */
export const lastReliefHeightsRun: { hit?: boolean; nRows?: number } = {};

/**
 * reliefGraphToTextures with H gathered on the GPU from the resident DEM tiles of `plan`: one
 * submit, no H upload. `words` = reliefWords(res, px, sun). Same lease and output textures as
 * reliefGraphToTextures; rejects on any device error (the caller falls back to the CPU raster).
 */
export function reliefGraphToTexturesGpuHeights(
	device: Device,
	plan: HeightsPlan,
	resident: HeightResidency,
	words: ArrayBuffer,
	degenerate: boolean,
	out: ReliefOutTextures,
): Promise<void> {
	const { res } = plan;
	for (const t of [out.field, out.gen])
		if (
			t.device !== device ||
			t.format !== "rgba8unorm" ||
			t.width !== res ||
			t.height !== res
		)
			throw new Error("relief textures: not rgba8unorm res² on this device");
	return withLease("look-relief-graph", async () => {
		const rowsCap = pow2(plan.nRows, 16);
		const unitsCap = pow2(plan.units, 16);
		const shape: Shape = {
			res,
			rowsCap,
			unitsCap,
			smallDepth: resident.small.depth,
			bigDepth: resident.big.depth,
			gradient: reliefGradientShape(words),
		};
		const gp = pooledUniform(
			device,
			"look-relief-gh/prm",
			HEIGHTS_PARAMS.pack({ res, nT: plan.nRows, hole: plan.hole }),
		);
		const nodes = pooledStorage(device, "look-relief-gh/nodes", plan.nodes);
		const rowsBuf = new Uint8Array(rowsCap * ROW_WORDS * 4);
		rowsBuf.set(new Uint8Array(plan.rows));
		const tiles = pooledStorage(device, "look-relief-gh/tiles", rowsBuf);
		const rprm = pooledUniform(device, "look-relief-graph/prm", words);
		const key = `gh|${res}|r${rowsCap}|u${unitsCap}|d${shape.smallDepth}.${shape.bigDepth}|u${rprm.byteLength}|ra${shape.gradient.ra}|px${shape.gradient.px}`;
		const { graph, hit } = cachedGraph<Params, void>(
			device,
			RELIEF_GRAPH_GROUP,
			key,
			(g) => buildGatherGraph(g, shape, rprm.byteLength),
		);
		await graph.compileAsync();
		await graph.run(
			{ degenerate, copies: plan.copies },
			{
				buffers: {
					"gh-prm": gp,
					"gh-nodes": nodes,
					"gh-tiles": tiles,
					prm: rprm,
				},
				textures: {
					"gh-small": resident.small,
					"gh-big": resident.big,
					"field-tex": out.field,
					"gen-tex": out.gen,
				},
			},
		);
		lastReliefHeightsRun.hit = hit;
		lastReliefHeightsRun.nRows = plan.nRows;
	});
}
