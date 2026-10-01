// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * The photo prep's result as a handle (WAG W1.1): the edge-map planes stay RESIDENT on the device
 * that computed them, and the CPU EdgeMap is a LAZY read.
 *
 *   const prep = await buildPhotoPrepAsync(img, 512, fg);   // ./index.ts
 *   const edge = await prep.cpu();      // GPU → CPU readback on first use (memoized); the EdgeMap
 *   const edge = prep.cpuSync();        // sync consumers: the memo, else the CPU reference (memoized)
 *   const r = pinResidentPlanes(device, edge);  // align: { coarse, fine, fg } buffers, or null
 *   try { …bind r.coarse… } finally { r?.release(); }
 *
 * ONE EdgeMap per prep. fitPriorSky rewrites `sky` / `skyCum` of the map it is given in place, so every
 * consumer must see the same object: cpu() and cpuSync() share one memo, and whichever materializes
 * first wins (a readback that lands after cpuSync computed the map is dropped). Both produce the same
 * planes bit for bit: the GPU planes equal the CPU reference by ./index.ts's exactness argument, and
 * the read applies the same runtime guards as the eager read did (nonce echoes, skyCum replay,
 * sampled CPU comparison).
 *
 * Residency. The GPU planes are buffers owned by the prep (never pool slots: nothing else writes them),
 * kept for the last MAX_RESIDENT preps per device (LRU). A prep leaves residency when it is evicted,
 * withdrawn (its read failed a guard or errored: its planes are not trusted) or its device is lost;
 * a prep whose map came from the CPU reference (cpuSync first, or a failed read) leaves residency
 * too, since its GPU planes were never read and checked, so only "gpu-read" maps are ever pinned;
 * its buffers are destroyed once nobody holds a pin (align pins them across its graph run, the read
 * pins them across the copy). After that, cpu() computes the CPU reference instead of reading, and
 * pinResidentPlanes returns null (align then uploads the CPU arrays as before).
 *
 * Align finds a prep by its map's `coarse` array (autoAlignAsync works on a shallow copy of the map,
 * so the object differs; the arrays are shared and never written after the prep). This file has no
 * luma runtime import (node check: ./resident.check.ts).
 */
import type { EdgeMap } from "#/lib/align";

/** The part of a luma Buffer residency needs. */
export type ResidentBuffer = { destroy(): void; readonly byteLength: number };
/** The part of a luma Device residency needs (luma sets `isLost` on loss and in destroy()). */
export type ResidentDevice = object & { readonly isLost?: boolean };

/** The prep's planes on the device: outputs (coarse, fine, sky, skyCum) and the fg input. */
export type ResidentPlanes<B extends ResidentBuffer = ResidentBuffer> = {
	coarse: B;
	fine: B;
	fg: B;
	sky: B;
	skyCum: B;
};

/** A pin on a prep's planes: valid until release() (call it exactly once). */
export type PinnedPlanes<B extends ResidentBuffer = ResidentBuffer> =
	ResidentPlanes<B> & { release(): void };

/** Preps kept resident per device (LRU); ≈ 5 planes × 4 B × w·h each (≈ 3.5 MB at 512 × 341). */
export const MAX_RESIDENT = 3;

export type PhotoPrepInit<
	D extends ResidentDevice = ResidentDevice,
	B extends ResidentBuffer = ResidentBuffer,
> = {
	w: number;
	h: number;
	/** the canvas RGBA bytes (becomes the map's `rgb`; never modified) */
	rgb: Uint8ClampedArray;
	/** the resampled foreground (becomes the map's `fg`; never modified) */
	fg: Float32Array;
	/** the CPU reference (align.ts edgeMapFromPixels on rgb / fg); must return a map with this rgb and fg */
	compute: () => EdgeMap;
	/** already materialized (the CPU path, or a read done eagerly) */
	map?: EdgeMap;
	/** the GPU half: absent = a CPU-only prep */
	gpu?: {
		device: D;
		planes: ResidentPlanes<B>;
		/** GPU → CPU: the map (rgb / fg = the arrays above); throws when a guard fails or the GPU errs */
		read: (planes: ResidentPlanes<B>) => Promise<EdgeMap>;
		/** called once when a read throws (before the CPU reference runs), e.g. to disable the device */
		onReadFailure?: (e: unknown) => void;
	};
};

/** How a prep's EdgeMap was produced. */
export type PrepSource = "gpu-read" | "cpu";

/** What the registries hold of a PhotoPrep (any device / buffer type). */
export type PrepHandle = {
	readonly materialized: EdgeMap | undefined;
	readonly source?: PrepSource;
	readonly resident: boolean;
	pin(device: object): PinnedPlanes | null;
	retire(): void;
};

// prep of an EdgeMap, by its `coarse` array (the map handed out; copies share the arrays)
const byCoarse = new WeakMap<Float32Array, PrepHandle>();
// resident preps per device, oldest first
const lru = new WeakMap<object, PrepHandle[]>();

export class PhotoPrep<
	D extends ResidentDevice = ResidentDevice,
	B extends ResidentBuffer = ResidentBuffer,
> {
	readonly w: number;
	readonly h: number;
	readonly rgb: Uint8ClampedArray;
	readonly fg: Float32Array;
	/** how the memo was produced (undefined until then) */
	source?: PrepSource;
	/** GPU → CPU reads started (0 or 1) and failed (tests, stats) */
	reads = 0;
	readFailures = 0;
	private readonly init: PhotoPrepInit<D, B>;
	private map?: EdgeMap;
	private pending?: Promise<EdgeMap>;
	private pins = 0;
	/** no new pins; buffers destroyed once pins reach 0 */
	private retired = false;
	private destroyed = false;

	constructor(init: PhotoPrepInit<D, B>) {
		this.init = init;
		this.w = init.w;
		this.h = init.h;
		this.rgb = init.rgb;
		this.fg = init.fg;
		if (init.map) this.adopt(init.map, "cpu");
		if (init.gpu) admit(init.gpu.device, this);
	}

	/** The device holding the planes (null: CPU-only). */
	get device(): D | null {
		return this.init.gpu?.device ?? null;
	}

	/** The planes are on the device and may be pinned. */
	get resident(): boolean {
		const g = this.init.gpu;
		return !!g && !this.retired && !g.device.isLost;
	}

	/** True once the GPU buffers are gone (evicted / withdrawn and unpinned). */
	get released(): boolean {
		return this.destroyed;
	}

	/** The EdgeMap if it was materialized already (no read, no compute). */
	get materialized(): EdgeMap | undefined {
		return this.map;
	}

	/** The EdgeMap: the memo, else the GPU read (resident), else the CPU reference. Never rejects. */
	cpu(): Promise<EdgeMap> {
		if (this.map) return Promise.resolve(this.map);
		this.pending ??= this.readOrCompute();
		return this.pending;
	}

	/** The EdgeMap now: the memo, else the CPU reference (same planes as the read). */
	cpuSync(): EdgeMap {
		return this.map ?? this.adopt(this.init.compute(), "cpu");
	}

	/**
	 * Pin the planes for a GPU job on `device` (null: not resident, or another device). The buffers
	 * stay alive until release(), even if the prep is evicted meanwhile.
	 */
	pin(device: object): PinnedPlanes<B> | null {
		const g = this.init.gpu;
		if (!g || device !== g.device || !this.resident) return null;
		this.pins++;
		let held = true;
		return {
			...g.planes,
			release: () => {
				if (!held) return;
				held = false;
				this.pins--;
				this.maybeDestroy();
			},
		};
	}

	/** Leave residency (LRU eviction, a failed guard, dispose): buffers go once unpinned. */
	retire() {
		if (!this.init.gpu || this.retired) return;
		this.retired = true;
		const list = lru.get(this.init.gpu.device);
		if (list) {
			const i = list.indexOf(this);
			if (i >= 0) list.splice(i, 1);
		}
		this.maybeDestroy();
	}

	private maybeDestroy() {
		if (!this.retired || this.pins > 0 || this.destroyed) return;
		this.destroyed = true;
		const p = this.init.gpu?.planes;
		if (p) for (const b of new Set(Object.values(p))) b.destroy();
	}

	private adopt(map: EdgeMap, source: PrepSource): EdgeMap {
		if (this.map) return this.map;
		this.map = map;
		this.source = source;
		byCoarse.set(map.coarse, this);
		// the CPU reference won over the GPU read: the planes were never verified, never bind them
		if (source === "cpu") this.retire();
		return map;
	}

	private async readOrCompute(): Promise<EdgeMap> {
		const g = this.init.gpu;
		const pinned = g ? this.pin(g.device) : null;
		if (g && pinned) {
			this.reads++;
			try {
				const m = await g.read(pinned);
				return this.adopt(m, "gpu-read");
			} catch (e) {
				this.readFailures++;
				// the planes failed a guard (or the GPU erred): never bind them again
				this.retire();
				g.onReadFailure?.(e);
			} finally {
				pinned.release();
			}
		}
		return this.cpuSync();
	}
}

function admit(device: ResidentDevice, prep: PrepHandle) {
	let list = lru.get(device);
	if (!list) {
		list = [];
		lru.set(device, list);
	}
	list.push(prep);
	while (list.length > MAX_RESIDENT) list[0].retire();
}

/** The prep `edge`'s planes came from (by its coarse array), or undefined. */
export function prepOf(edge: Pick<EdgeMap, "coarse">): PrepHandle | undefined {
	return byCoarse.get(edge.coarse);
}

/**
 * Pin the resident { coarse, fine, fg } of `edge` on `device` for a GPU job, or null (no resident
 * prep for this map on this device: the caller uploads the CPU arrays). The map must be the prep's
 * (or a copy sharing its coarse / fine / fg arrays).
 */
export function pinResidentPlanes(
	device: object,
	edge: Pick<EdgeMap, "coarse" | "fine" | "fg">,
): PinnedPlanes | null {
	const prep = byCoarse.get(edge.coarse);
	const m = prep?.materialized;
	if (!prep || !m || m.fine !== edge.fine || m.fg !== edge.fg) return null;
	// only planes whose CPU map came back through the (guarded) read
	if (prep.source !== "gpu-read") return null;
	return prep.pin(device);
}

/** Retire every resident prep of `device` (the device's GPU photo prep was turned off). */
export function retireResident(device: object) {
	for (const p of [...(lru.get(device) ?? [])]) p.retire();
}

/** Resident preps on `device` (tests, stats). */
export const residentCount = (device: object) => lru.get(device)?.length ?? 0;
