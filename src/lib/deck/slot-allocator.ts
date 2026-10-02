// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Index allocator with a free list and a hard limit (the device's array layer cap). Past the
// limit `alloc` returns -1 instead of handing out an index the texture cannot hold, so the
// caller never has to drop (and leak) an index it already took (CR-45).

export class SlotAllocator {
	private free: number[] = [];
	private next = 0;
	/** @param limit indices handed out are < limit (Infinity = unbounded) */
	constructor(readonly limit = Number.POSITIVE_INFINITY) {}

	/** Indices currently handed out. */
	get used() {
		return this.next - this.free.length;
	}

	/** A free index (recycled first), or -1 when `limit` indices are already in use. */
	alloc(): number {
		const i = this.free.pop();
		if (i !== undefined) return i;
		if (this.next >= this.limit) return -1;
		return this.next++;
	}

	release(i: number) {
		this.free.push(i);
	}
}
