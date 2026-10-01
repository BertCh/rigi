// GPU back-to-front sort of Gaussian splats, on the RENDER device (deck-webgpu/layers/splats.ts
// option `sortBackend: "gpu"`). Replaces the worker round trip of nearfield/splat-sort.ts: the depth
// keys are computed from the splat storage buffer the draw already reads, a stable two-pass radix
// sort writes the order buffer the splat vertex shader indexes, and nothing comes back to the CPU.
//
//   const sorter = new GpuSplatSorter(device, dataBuffer, orderBuffer, count);
//   sorter.sort(row);   // records + submits its own encoder; the queue orders it before any
//                       // frame submit that comes later, so the draw being encoded sees the new order
//   sorter.destroy();
//
// Key identity with the worker (details and the proof sketch in ./README.md): the keys are the same
// formula (16-bit, farthest = 0, `min(65535, trunc((maxD - d) * 65535 / span))`) in f32 instead of
// f64, and the sort is stable with the index tie-break, which is what the worker's counting sort
// does. So: same order wherever the keys agree; keys can differ by 1 at bin edges (not provably
// zero in WGSL).
//
// The order buffer holds ALL `count` splats: those at or behind the camera plane (the worker drops
// them) are given the key 65536 and sort to the end (ascending index among themselves), where the
// vertex shader's `clip.w < nearW` cull discards them. The caller therefore always draws `count`
// instances; there is no kept-count readback.
import type { Binding, Buffer, Device } from "@luma.gl/core";
import {
	type BindKind,
	type DispatchCall,
	defineKernel,
	dispatchAll,
	type Kernel,
	kernel,
	submit,
} from "../core/kernel";
import { clear, range } from "../core/pool";
import {
	DEPTH_WGSL,
	DIGITS,
	KEYS_WGSL,
	RADIX_BITS,
	SCAN_DIGIT_WGSL,
	SCAN_TOTALS_WGSL,
	SCATTER_WGSL,
	TILE,
	TILE_WGSL,
} from "./splat-sort.wgsl";

const GROUP = "splat-sort";
/** GPUBufferUsage bits (as deck-webgpu/layers/splats.ts). */
const STORAGE = 0x0080;
const COPY_DST = 0x0008;
const UNIFORM = 0x0040;

const U: [string, BindKind] = ["p", "uniform"];
const DEPTH = defineKernel(
	"splatsort-depth",
	DEPTH_WGSL,
	[
		U,
		["splatData", "read-only-storage"],
		["depth", "storage"],
		["mm", "storage"],
	],
	{ group: GROUP },
);
const KEYS = defineKernel(
	"splatsort-keys",
	KEYS_WGSL,
	[
		U,
		["depth", "read-only-storage"],
		["mm", "read-only-storage"],
		["keys", "storage"],
	],
	{ group: GROUP },
);
const tileSpec = (pass: 0 | 1) =>
	defineKernel(
		`splatsort-tile${pass}`,
		TILE_WGSL,
		[
			U,
			["keys", "read-only-storage"],
			["inIdx", "read-only-storage"],
			["rank", "storage"],
			["hist", "storage"],
		],
		{
			group: GROUP,
			constants: { SHIFT: pass * RADIX_BITS, FIRST: pass === 0 ? 1 : 0 },
		},
	);
const scatterSpec = (pass: 0 | 1) =>
	defineKernel(
		`splatsort-scatter${pass}`,
		SCATTER_WGSL,
		[
			U,
			["keys", "read-only-storage"],
			["inIdx", "read-only-storage"],
			["rank", "read-only-storage"],
			["hist", "read-only-storage"],
			["base", "read-only-storage"],
			["outIdx", "storage"],
		],
		{
			group: GROUP,
			constants: { SHIFT: pass * RADIX_BITS, FIRST: pass === 0 ? 1 : 0 },
		},
	);
const TILE0 = tileSpec(0);
const TILE1 = tileSpec(1);
const SCATTER0 = scatterSpec(0);
const SCATTER1 = scatterSpec(1);
const SCAN_DIGIT = defineKernel(
	"splatsort-scan-digit",
	SCAN_DIGIT_WGSL,
	[U, ["hist", "storage"], ["base", "storage"]],
	{ group: GROUP },
);
const SCAN_TOTALS = defineKernel(
	"splatsort-scan-totals",
	SCAN_TOTALS_WGSL,
	[U, ["base", "storage"]],
	{ group: GROUP },
);

export type GpuSplatSortStats = {
	sorts: number;
	/** CPU time to encode + submit the last sort (ms); the GPU time is not measured here. */
	lastEncodeMs: number;
};

/** True when `device` can run the sort (WebGPU, workgroup storage ≥ 3 KB, ≥ 6 storage buffers). */
export function gpuSplatSortSupported(device: Device): boolean {
	return (
		device.type === "webgpu" &&
		!device.isLost &&
		device.limits.maxStorageBuffersPerShaderStage >= 7 &&
		device.limits.maxComputeInvocationsPerWorkgroup >= TILE &&
		device.limits.maxComputeWorkgroupStorageSize >= (TILE + DIGITS) * 4
	);
}

export class GpuSplatSorter {
	readonly stats: GpuSplatSortStats = { sorts: 0, lastEncodeMs: 0 };
	private readonly blocks: number;
	private readonly params: Buffer;
	private readonly depth: Buffer;
	private readonly mm: Buffer;
	private readonly keys: Buffer;
	private readonly rank: Buffer;
	private readonly tmp: Buffer;
	private readonly hist: Buffer;
	private readonly base: Buffer;
	private readonly owned: Buffer[];
	private readonly ks: Kernel[];

	/**
	 * @param data the splat storage buffer (3 × vec4<u32> per splat, position at word 0 of each
	 *   splat: deck-webgpu/layers/splats.ts SPLAT_WORDS), read only
	 * @param order the order buffer (count × u32, STORAGE): written with the sorted indices
	 */
	constructor(
		readonly device: Device,
		private readonly data: Buffer,
		private readonly order: Buffer,
		readonly count: number,
	) {
		this.blocks = Math.max(1, Math.ceil(count / TILE));
		const n4 = Math.max(16, count * 4);
		const mk = (id: string, bytes: number, usage = STORAGE) =>
			device.createBuffer({
				id: `splatsort-${id}`,
				byteLength: Math.max(16, bytes),
				usage: usage | COPY_DST,
			});
		this.params = mk("params", 32, UNIFORM);
		this.depth = mk("depth", n4);
		this.mm = mk("mm", 8);
		this.keys = mk("keys", n4);
		this.rank = mk("rank", n4);
		this.tmp = mk("tmp", n4);
		this.hist = mk("hist", DIGITS * this.blocks * 4);
		this.base = mk("base", DIGITS * 4);
		this.owned = [
			this.params,
			this.depth,
			this.mm,
			this.keys,
			this.rank,
			this.tmp,
			this.hist,
			this.base,
		];
		this.ks = [
			DEPTH,
			KEYS,
			TILE0,
			SCATTER0,
			TILE1,
			SCATTER1,
			SCAN_DIGIT,
			SCAN_TOTALS,
		].map((s) => kernel(device, s));
	}

	/**
	 * Sort by the depth row (worker DepthRow: view z = a x + b y + c z + d, camera looks down -z;
	 * depth = -z, kept when > 0) and write the order buffer. One submit, no readback.
	 */
	sort(row: readonly [number, number, number, number]): void {
		const t0 = performance.now();
		const { device, blocks, count } = this;
		const w = new ArrayBuffer(32);
		const fl = new Float32Array(w);
		const u = new Uint32Array(w);
		fl.set(row, 0);
		fl[4] = 0; // near: the worker's default and what SplatsCore uses; depth keys need near >= 0
		u[5] = count;
		u[6] = blocks;
		this.params.write(new Uint8Array(w));
		const [
			kDepth,
			kKeys,
			kTile0,
			kScatter0,
			kTile1,
			kScatter1,
			kScanDigit,
			kScanTotals,
		] = this.ks;
		const enc = device.createCommandEncoder({ id: "splatsort" });
		clear(enc, this.mm);
		const p = this.params;
		const bytes = count * 4;
		const pass = (
			kTile: Kernel,
			kScatter: Kernel,
			inIdx: Binding,
			outIdx: Binding,
		): DispatchCall[] => [
			{
				k: kTile,
				bindings: {
					p,
					keys: this.keys,
					inIdx,
					rank: this.rank,
					hist: this.hist,
				},
				x: blocks,
			},
			{
				k: kScanDigit,
				bindings: { p, hist: this.hist, base: this.base },
				x: DIGITS,
			},
			{ k: kScanTotals, bindings: { p, base: this.base }, x: 1 },
			{
				k: kScatter,
				bindings: {
					p,
					keys: this.keys,
					inIdx,
					rank: this.rank,
					hist: this.hist,
					base: this.base,
					outIdx,
				},
				x: blocks,
			},
		];
		dispatchAll(
			enc,
			[
				{
					k: kDepth,
					bindings: { p, splatData: this.data, depth: this.depth, mm: this.mm },
					x: blocks,
				},
				{
					k: kKeys,
					bindings: { p, depth: this.depth, mm: this.mm, keys: this.keys },
					x: blocks,
				},
				// pass 0 reads the identity (FIRST) into tmp; pass 1 reads tmp into the order buffer
				...pass(
					kTile0,
					kScatter0,
					range(this.order, bytes),
					range(this.tmp, bytes),
				),
				...pass(
					kTile1,
					kScatter1,
					range(this.tmp, bytes),
					range(this.order, bytes),
				),
			],
			"splatsort",
		);
		submit(device, enc);
		this.stats.sorts++;
		this.stats.lastEncodeMs = performance.now() - t0;
	}

	destroy(): void {
		for (const b of this.owned) b.destroy();
	}
}
