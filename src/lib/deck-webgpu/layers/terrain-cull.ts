// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// GPU frustum cull + indirect draws for the batched terrain (WAG W1.5; on).
// Per pass (geometry, colour) a ComputeGraph on the RENDER device, recorded on the pass's command
// encoder right before its render pass (GpuLayerCore.prepass):
//   cull     one invocation per candidate slot: the conservative f32 twin of sphereInView, written as
//            one flag array per draw slot (vis && seg == slot)
//   compact  one luma GPUCompaction per draw slot (the draw slot IS the seg's index in the seg
//            table): a stable scan + scatter of the candidates' table rows into the slot's instance
//            buffer, with the accepted count landing in word 1 (instanceCount) of the slot's indirect
//            record
// The record's other words (indexCount, firstIndex, baseVertex 0, firstInstance 0) are static per seg
// set and written from the CPU when it changes. Draw order is the seg table's order (first seen),
// not the CPU path's first-visible-tile order: the terrain is opaque and depth tested, so only early
// depth rejection could differ.
// BatchedTerrainCore.draw then issues one drawIndexedIndirect per seg (at most CULL_SLOTS) through
// luma's Model.setIndirectBuffer (luma #3328, vendored since rigi.2). The index buffer is the
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
import { GPUCompaction } from "#/lib/gpu/core/luma";
import type { CameraUniforms } from "../camera";
import {
	CAND_BYTES,
	CULL_PARAMS_BYTES,
	CULL_SLOTS,
	cullWgsl,
	RECORD_WORDS,
} from "./terrain-cull.wgsl";
import {
	type CullCandidate,
	packCandidates,
	packCullParams,
} from "./terrain-cull-math";

const GROUP = "terrain-cull";
const CULL_LAYOUT: [string, "uniform" | "read-only-storage" | "storage"][] = [
	["prm", "uniform"],
	["cand", "read-only-storage"],
	["flags", "storage"],
];
const cullKernels = new Map<number, ReturnType<typeof defineKernel>>();
/** The cull kernel for a candidate capacity (the capacity is a WGSL constant). */
export function cullKernel(capacity: number) {
	let k = cullKernels.get(capacity);
	if (!k) {
		k = defineKernel(
			`terrain-cull-${capacity}`,
			cullWgsl(capacity),
			CULL_LAYOUT,
			{ group: GROUP, label: `terrain-cull-${capacity}` },
		);
		cullKernels.set(capacity, k);
	}
	return k;
}
/** The smallest capacity's kernel (the node check and wgsl-compile). */
export const CULL_KERNEL = cullKernel(64);

const RECORD_BYTES = RECORD_WORDS * 4;
const U = {
	params: Buffer.UNIFORM | Buffer.COPY_DST,
	storage: Buffer.STORAGE | Buffer.COPY_DST,
	// COPY_SRC: the Dawn script reads the records and instance lists back
	args: Buffer.INDIRECT | Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC,
	inst: Buffer.VERTEX | Buffer.STORAGE | Buffer.COPY_DST | Buffer.COPY_SRC,
};

type Params = { n: number };
type Entry = {
	params: Buffer;
	args: Buffer;
	inst: Buffer[];
	/** the seg-set generation whose static record words `args` holds */
	records: number;
};

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
	private cand: Buffer | null = null;
	private rows: Buffer | null = null;
	/** records' static words (indexCount, 0, firstIndex, 0, 0 per seg), CULL_SLOTS records */
	private recordWords = new Uint32Array(CULL_SLOTS * RECORD_WORDS);
	private recordGeneration = 0;
	private n = 0;
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
			this.recordGeneration++;
			// one compaction per seg: the graph is rebuilt for the new seg count (CPU cull meanwhile)
			this.dropGraph();
		}
		const cands: CullCandidate[] = tiles.map((t) => ({
			sphere: t.sphere,
			row: t.row,
			seg: this.segValues.indexOf(t.seg),
		}));
		this.n = cands.length;
		if (this.n > this.cap) this.grow(this.n);
		this.cand?.write(packCandidates(cands, this.cap));
		const rowWords = new Uint32Array(this.cap);
		cands.forEach((c, i) => {
			rowWords[i] = c.row;
		});
		this.rows?.write(rowWords);
		return true;
	}

	/** Index buffer (segs' gridMesh indices concatenated) and the records' static words. */
	private buildIndex() {
		const parts = this.segValues.map((s) => gridMesh(s).indices);
		const count = parts.reduce((a, p) => a + p.length, 0);
		const all = new Uint32Array(count);
		let o = 0;
		parts.forEach((p, k) => {
			all.set(p, o);
			this.recordWords[k * RECORD_WORDS] = p.length;
			this.recordWords[k * RECORD_WORDS + 2] = o;
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
	}

	/** Room for `need` candidates: new candidate buffer, ring and graph (compiled async). */
	private grow(need: number) {
		let cap = Math.max(64, this.cap);
		while (cap < need) cap *= 2;
		this.cap = cap;
		this.retire(this.cand, this.rows);
		this.cand = this.device.createBuffer({
			id: "terrain-cull-cand",
			usage: U.storage,
			byteLength: cap * CAND_BYTES,
		});
		this.rows = this.device.createBuffer({
			id: "terrain-cull-rows",
			usage: U.storage,
			byteLength: cap * 4,
		});
		for (const e of this.ring) this.retire(e.params, e.args, ...e.inst);
		this.ring = [];
		this.ringNext = 0;
		this.dropGraph();
	}

	private dropGraph() {
		this.retire(this.graph);
		this.graph = null;
		this.ready = false;
		this.compiling = null;
	}

	private buildGraph(cap: number, slots: number) {
		const g = new ComputeGraph<Params>(this.device, `terrain-cull-${cap}`);
		const prm = g.importBuffer("prm", CULL_PARAMS_BYTES, undefined, U.params);
		const cand = g.importBuffer("cand", cap * CAND_BYTES, undefined, U.storage);
		const rows = g.importBuffer("rows", cap * 4, undefined, U.storage);
		const args = g.importBuffer(
			"args",
			CULL_SLOTS * RECORD_BYTES,
			undefined,
			U.args,
		);
		const inst = [0, 1, 2, 3].map((k) =>
			g.importBuffer(`inst${k}`, cap * 4, undefined, U.inst),
		);
		const flags = g.transientBuffer("flags", CULL_SLOTS * cap * 4);
		g.addKernel({
			id: "cull",
			spec: cullKernel(cap),
			bindings: { prm, cand, flags },
			workgroups: [Math.ceil(cap / 64)],
			// every flag of every slot is written (zero past n)
			writes: { flags: "full" },
		});
		const rowsView = g.view(rows, "uint32", cap);
		for (let k = 0; k < slots; k++)
			g.add(
				new GPUCompaction({
					id: `terrain-cull-compact${k}`,
					input: rowsView,
					flags: g.view(flags, "uint32", cap, k * cap * 4),
					output: g.view(inst[k], "uint32", cap),
					// word 1 of the slot's record: instanceCount
					count: g.view(args, "uint32", 1, (k * RECORD_WORDS + 1) * 4),
				}),
				{ uses: [rows, flags] },
			);
		return g;
	}

	/** Compile the graph for the current capacity in the background; true once it is usable. */
	private usable() {
		if (this.failed || !this.cap) return false;
		if (this.ready) return true;
		if (!this.compiling) {
			const cap = this.cap;
			const g = this.buildGraph(cap, this.segValues.length);
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
				records: -1,
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
		if (e.records !== this.recordGeneration) {
			e.args.write(this.recordWords);
			e.records = this.recordGeneration;
		}
		return e;
	}

	/**
	 * Record the cull for one pass on `enc` (outside any render pass). Null: not ready yet (the
	 * graph compiles asynchronously), nothing to cull, or failed; the caller culls on the CPU.
	 */
	prepare(enc: CommandEncoder, camera: CameraUniforms): CulledDraw | null {
		if (!this.n || !this.index || !this.cand || !this.rows) return null;
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
					rows: this.rows,
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
				slots: this.segValues.length,
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
		this.cand?.destroy();
		this.rows?.destroy();
		this.index = null;
		this.cand = null;
		this.rows = null;
	}
}
