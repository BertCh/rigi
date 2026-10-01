// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Packed base-grid slots of the batched terrain (layers/batched-terrain.ts TileStore, WAG W1.6).
// Each tile's base grid is 2·(G+1)² vec4 (G = baseCells(z): 64 on z ≤ 9, 32 elsewhere). Before,
// every tile row reserved the largest slot (G = 64, 132 KiB); in the photo view ~97 % of the tiles
// are G = 32 (34 KiB), so the fixed slots wasted ~70 % of a ~47 MiB storage buffer. Now each tile
// gets a slot of its own size at a vec4 offset, which the shader reads from the tile's table row
// (t2.w) instead of computing row · slot. Same data, same reads: the frames do not change.
//
// The allocator is a bump pointer plus one free list per slot size (a released slot is reused by
// the next tile of the same size; with the bump region full, a larger hole is split). When a tile
// doesn't fit, the owner re-packs every live slot
// from offset 0 (and grows the buffer when the live total exceeds it) and rewrites them, which is
// what a row grow already did before. Pure, node-checked by base-slots.check.ts.

/** vec4s of a base grid with G cells per side: (base, up) per node, (G + 1)² nodes. */
export const baseSlotVec4 = (G: number) => 2 * (G + 1) * (G + 1);

/** Live share of the capacity above which a re-pack also grows the buffer (headroom). */
export const PACK_FILL = 0.85;

/**
 * The capacity (vec4) after a re-pack that must hold `need` vec4: unchanged while need ≤
 * PACK_FILL · capacity, else max(⌈need / PACK_FILL⌉, ⌈1.5 · capacity⌉) capped at `max` (the old
 * row growth, 1.5×, plus headroom: a re-pack that leaves the buffer nearly full would only be
 * followed by another one on the next swap of tiles of different sizes).
 */
export function packedCapacity(capacity: number, need: number, max: number) {
	if (need <= capacity * PACK_FILL) return capacity;
	return Math.min(
		max,
		Math.max(Math.ceil(need / PACK_FILL), Math.ceil(capacity * 1.5)),
	);
}

export class BaseSlotAllocator {
	private top = 0;
	private free = new Map<number, number[]>();
	constructor(public capacity: number) {}

	/** An offset (vec4) for a slot of `size` vec4, or undefined when it doesn't fit. */
	alloc(size: number): number | undefined {
		const list = this.free.get(size);
		const reused = list?.pop();
		if (reused !== undefined) return reused;
		if (this.top + size > this.capacity) {
			// the smallest larger free hole: take its start, keep the remainder as a hole
			let best = 0;
			for (const [s, l] of this.free)
				if (s > size && l.length && (!best || s < best)) best = s;
			if (!best) return undefined;
			const o = this.free.get(best)?.pop() as number;
			this.release(o + size, best - size);
			return o;
		}
		const o = this.top;
		this.top += size;
		return o;
	}

	release(offset: number, size: number) {
		let list = this.free.get(size);
		if (!list) {
			list = [];
			this.free.set(size, list);
		}
		list.push(offset);
	}

	/** Forget every slot (a re-pack follows), optionally with a new capacity. */
	reset(capacity = this.capacity) {
		this.capacity = capacity;
		this.top = 0;
		this.free.clear();
	}

	/** vec4s below the bump pointer (live slots plus free-listed holes). */
	get used() {
		return this.top;
	}
}

/** A slot as placeSlots sees it: its size and its offset (−1 = none / past the device limit). */
export type PlacedSlot = { size: number; base: number };

/**
 * Give every slot in `fresh` (a subset of `all`, base −1) an offset. When one doesn't fit, re-pack
 * every slot of `all` from 0 in iteration order, at packedCapacity(…, live total, max); slots that
 * still don't fit (the live total is past `max`) keep base −1 and the caller drops them.
 * `repacked`: every offset may have changed (rewrite all slots); `capacity`: re-create the buffer
 * when it differs from the allocator's capacity before the call.
 */
export function placeSlots(
	alloc: BaseSlotAllocator,
	all: Iterable<PlacedSlot>,
	fresh: Iterable<PlacedSlot>,
	max: number,
): { repacked: boolean; capacity: number } {
	let fits = true;
	for (const s of fresh) {
		const o = alloc.alloc(s.size);
		if (o === undefined) {
			fits = false;
			break;
		}
		s.base = o;
	}
	if (fits) return { repacked: false, capacity: alloc.capacity };
	const slots = [...all];
	let need = 0;
	for (const s of slots) need += s.size;
	alloc.reset(packedCapacity(alloc.capacity, need, max));
	for (const s of slots) s.base = alloc.alloc(s.size) ?? -1;
	return { repacked: true, capacity: alloc.capacity };
}
