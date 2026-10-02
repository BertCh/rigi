// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU frustum cull + indirect draws for the batched terrain (WAG W1.5; on).
// Per pass (geometry, colour) a two-node ComputeGraph on the RENDER device, recorded on the pass's
// command encoder right before its render pass (GpuLayerCore.prepass):
//   cull     one invocation per resident tile: the conservative f32 twin of sphereInView → vis[i]
//   compact  one workgroup: per seg the visible count and first visible tile, the draw slots in the
//            CPU path's group order, the indexed indirect records, and a stable compaction of the
//            visible table rows into the slot's instance buffer
// BatchedTerrainCore.draw then issues CULL_SLOTS (at most the distinct segs) drawIndexedIndirect
// calls through luma's Model.setIndirectBuffer (luma #3328, vendored since rigi.2). The index buffer is the
// segs' gridMesh indices concatenated (firstIndex selects the seg; baseVertex = firstInstance = 0).
// No count is read back. WebGPU only; the CPU cull stays the path for WebGL, ?gpu=off,
// a custom `cull` hook, > CULL_SLOTS segs, and any failure here.
//
// Encoder ring: a host may record several passes of one kind before it submits (off-frame geometry
// renders, prewarm), so every prepass takes the next entry (uniform, instance and record buffers)
// of a ring that restarts when the device's command encoder changes (luma replaces it on submit).
// Buffers replaced while a recorded encoder may still use them are destroyed on the next encoder.
import { Buffer, type CommandEncoder, type Device } from "@luma.gl/core";
import { gridMesh } from "#/lib/deck/batched-terrain-grid";
import { ComputeGraph } from "#/lib/gpu/core/graph";
import { defineKernel } from "#/lib/gpu/core/kernel";
import type { CameraUniforms } from "../camera";
import {
	CAND_BYTES,
	COMPACT_WGSL,
	CULL_PARAMS_BYTES,
	CULL_SLOTS,
	CULL_WGSL,
	RECORD_WORDS,
} from "./terrain-cull.wgsl";
import {
	type CullCandidate,
	packCandidates,
	packCullParams,
} from "./terrain-cull-math";

const GROUP = "terrain-cull";
export const CULL_KERNEL = defineKernel(
	"terrain-cull",
	CULL_WGSL,
	[
		["prm", "uniform"],
		["cand", "read-only-storage"],
		["vis", "storage"],
	],
	{ group: GROUP, label: "terrain-cull" },
);
export const COMPACT_KERNEL = defineKernel(
	"terrain-compact",
	COMPACT_WGSL,
	[
		["prm", "uniform"],
		["cand", "read-only-storage"],
		["vis", "read-only-storage"],
		["segs", "read-only-storage"],
		["args", "storage"],
		["inst0", "storage"],
		["inst1", "storage"],
		["inst2", "storage"],
		["inst3", "storage"],
	],
	{ group: GROUP, label: "terrain-compact" },
);

const RECORD_BYTES = RECORD_WORDS * 4;
const U = {
	params: Buffer.UNIFORM | Buffer.COPY_DST,
	storage: Buffer.STORAGE | Buffer.COPY_DST,
	args: Buffer.INDIRECT | Buffer.STORAGE | Buffer.COPY_DST,
	inst: Buffer.VERTEX | Buffer.STORAGE | Buffer.COPY_DST,
};

type Params = { n: number };
type Entry = { params: Buffer; args: Buffer; inst: Buffer[] };

/** What BatchedTerrainCore.draw needs for one culled pass. */
export type CulledDraw = {
	/** the segs' indices concatenated (uint32) */
	index: Buffer;
	indexCount: number;
	/** CULL_SLOTS indexed records, RECORD_BYTES apart */
	args: Buffer;
	recordBytes: number;
	/** per draw slot, its instance (table row) buffer */
	inst: readonly Buffer[];
	/** draw slots that can be non-empty (distinct segs among the candidates) */
	slots: number;
};

export class TerrainGpuCull {
	/** seg value per seg index (append-only, ≤ CULL_SLOTS) */
	private segValues: number[] = [];
	private index: { buf: Buffer; count: number } | null = null;
	private segTable: Buffer | null = null;
	private cand: Buffer | null = null;
	private n = 0;
	private activeSlots = 0;
	private cap = 0;
	private graph: ComputeGraph<Params> | null = null;
	private ready = false;
	private compiling: Promise<void> | null = null;
	private ring: Entry[] = [];
	private ringEncoder: CommandEncoder | null = null;
	private ringNext = 0;
	private graveyard: { destroy(): void }[] = [];
	/** a compile or encode threw: callers stay on the CPU cull */
	failed = false;

	constructor(readonly device: Device) {}

	/**
	 * The resident tiles in tile-set order (BatchedTerrainCore's candidates for the CPU cull). False
	 * when the GPU path cannot take them (more distinct segs than CULL_SLOTS).
	 */
	setCandidates(
		tiles: readonly {
			sphere: CullCandidate["sphere"];
			row: number;
			seg: number;
		}[],
	) {
		const segs = [...this.segValues];
		for (const t of tiles) if (!segs.includes(t.seg)) segs.push(t.seg);
		if (segs.length > CULL_SLOTS) return false;
		if (segs.length !== this.segValues.length) {
			this.segValues = segs;
			this.buildIndex();
		}
		const cands: CullCandidate[] = tiles.map((t) => ({
			sphere: t.sphere,
			row: t.row,
			seg: this.segValues.indexOf(t.seg),
		}));
		this.activeSlots = new Set(cands.map((c) => c.seg)).size;
		this.n = cands.length;
		if (this.n > this.cap) this.grow(this.n);
		this.cand?.write(packCandidates(cands, this.cap));
		return true;
	}

	/** Index buffer (segs' gridMesh indices concatenated) and the seg table [count, first]. */
	private buildIndex() {
		const parts = this.segValues.map((s) => gridMesh(s).indices);
		const count = parts.reduce((a, p) => a + p.length, 0);
		const all = new Uint32Array(count);
		const table = new Uint32Array(CULL_SLOTS * 4);
		let o = 0;
		parts.forEach((p, k) => {
			all.set(p, o);
			table[k * 4] = p.length;
			table[k * 4 + 1] = o;
			o += p.length;
		});
		this.retire(this.index?.buf);
		this.index = {
			buf: this.device.createBuffer({
				id: "terrain-cull-index",
				data: all,
				usage: Buffer.INDEX | Buffer.COPY_DST,
			}),
			count,
		};
		this.segTable ??= this.device.createBuffer({
			id: "terrain-cull-segs",
			usage: U.storage,
			byteLength: table.byteLength,
		});
		this.segTable.write(table);
	}

	/** Room for `need` candidates: new candidate buffer, ring and graph (compiled async). */
	private grow(need: number) {
		let cap = Math.max(64, this.cap);
		while (cap < need) cap *= 2;
		this.cap = cap;
		this.retire(this.cand);
		this.cand = this.device.createBuffer({
			id: "terrain-cull-cand",
			usage: U.storage,
			byteLength: cap * CAND_BYTES,
		});
		for (const e of this.ring) this.retire(e.params, e.args, ...e.inst);
		this.ring = [];
		this.ringNext = 0;
		this.retire(this.graph);
		this.graph = null;
		this.ready = false;
		this.compiling = null;
	}

	private buildGraph(cap: number) {
		const g = new ComputeGraph<Params>(this.device, `terrain-cull-${cap}`);
		const prm = g.importBuffer("prm", CULL_PARAMS_BYTES, undefined, U.params);
		const cand = g.importBuffer("cand", cap * CAND_BYTES, undefined, U.storage);
		const segs = g.importBuffer("segs", CULL_SLOTS * 16, undefined, U.storage);
		const args = g.importBuffer(
			"args",
			CULL_SLOTS * RECORD_BYTES,
			undefined,
			U.args,
		);
		const inst = [0, 1, 2, 3].map((k) =>
			g.importBuffer(`inst${k}`, cap * 4, undefined, U.inst),
		);
		const vis = g.transientBuffer("vis", cap * 4);
		g.addKernel({
			id: "cull",
			spec: CULL_KERNEL,
			bindings: { prm, cand, vis },
			workgroups: (p) => [Math.max(1, Math.ceil(p.n / 64))],
			// every vis[i < n] is written; compact reads no other
			writes: { vis: "full" },
		});
		g.addKernel({
			id: "compact",
			spec: COMPACT_KERNEL,
			bindings: {
				prm,
				cand,
				vis,
				segs,
				args,
				inst0: inst[0],
				inst1: inst[1],
				inst2: inst[2],
				inst3: inst[3],
			},
			workgroups: [1],
		});
		return g;
	}

	/** Compile the graph for the current capacity in the background; true once it is usable. */
	private usable() {
		if (this.failed || !this.cap) return false;
		if (this.ready) return true;
		if (!this.compiling) {
			const cap = this.cap;
			const g = this.buildGraph(cap);
			this.graph = g;
			this.compiling = g.compileAsync().then(
				() => {
					if (this.graph === g) this.ready = true;
				},
				(e) => {
					if (this.graph !== g) return;
					console.warn("terrain GPU cull: compile failed, CPU cull", e);
					this.failed = true;
				},
			);
		}
		return false;
	}

	private entry(enc: CommandEncoder): Entry {
		if (enc !== this.ringEncoder) {
			this.ringEncoder = enc;
			this.ringNext = 0;
			for (const b of this.graveyard) b.destroy();
			this.graveyard = [];
		}
		let e = this.ring[this.ringNext];
		if (!e) {
			const i = this.ringNext;
			e = {
				params: this.device.createBuffer({
					id: `terrain-cull-prm-${i}`,
					usage: U.params,
					byteLength: CULL_PARAMS_BYTES,
				}),
				args: this.device.createBuffer({
					id: `terrain-cull-args-${i}`,
					usage: U.args,
					byteLength: CULL_SLOTS * RECORD_BYTES,
				}),
				inst: [0, 1, 2, 3].map((k) =>
					this.device.createBuffer({
						id: `terrain-cull-inst-${i}-${k}`,
						usage: U.inst,
						byteLength: this.cap * 4,
					}),
				),
			};
			this.ring.push(e);
		}
		this.ringNext++;
		return e;
	}

	/**
	 * Record the cull for one pass on `enc` (outside any render pass). Null: not ready yet (the
	 * graph compiles asynchronously), nothing to cull, or failed; the caller culls on the CPU.
	 */
	prepare(enc: CommandEncoder, camera: CameraUniforms): CulledDraw | null {
		if (!this.n || !this.index || !this.segTable || !this.cand) return null;
		if (!this.usable() || !this.graph) return null;
		try {
			const e = this.entry(enc);
			e.params.write(packCullParams(camera, this.n));
			this.graph.encode(
				enc,
				{ n: this.n },
				{
					prm: e.params,
					cand: this.cand,
					segs: this.segTable,
					args: e.args,
					inst0: e.inst[0],
					inst1: e.inst[1],
					inst2: e.inst[2],
					inst3: e.inst[3],
				},
			);
			return {
				index: this.index.buf,
				indexCount: this.index.count,
				args: e.args,
				recordBytes: RECORD_BYTES,
				inst: e.inst,
				slots: this.activeSlots,
			};
		} catch (err) {
			console.warn("terrain GPU cull: encode failed, CPU cull", err);
			this.failed = true;
			return null;
		}
	}

	/** Destroy once the encoder that may have recorded it is gone (the next prepare's encoder). */
	private retire(...objs: ({ destroy(): void } | null | undefined)[]) {
		for (const b of objs) if (b) this.graveyard.push(b);
	}

	destroy() {
		this.graph?.destroy();
		this.graph = null;
		for (const e of this.ring)
			for (const b of [e.params, e.args, ...e.inst]) b.destroy();
		this.ring = [];
		for (const b of this.graveyard) b.destroy();
		this.graveyard = [];
		this.index?.buf.destroy();
		this.segTable?.destroy();
		this.cand?.destroy();
		this.index = null;
		this.segTable = null;
		this.cand = null;
	}
}
