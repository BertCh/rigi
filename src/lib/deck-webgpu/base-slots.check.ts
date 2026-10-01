// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the packed base-grid slots (base-slots.ts, WAG W1.6), no GPU.
// Run: npx tsx src/lib/deck-webgpu/base-slots.check.ts
//   1. sizes: baseSlotVec4(64) is the old fixed slot (2·(BASE_MAX+1)²), baseSlotVec4(32) the small one
//   2. random TileStore-like sync sequences (tiles of G 32 / 64 come and go, as pans do): after every
//      placeSlots, every live slot lies inside the capacity, no two live slots overlap, offsets are
//      integers exact in f32 (the shader reads them from the f32 table row), nothing passes max
//   3. capacity: never shrinks, re-packs only when a fresh slot didn't fit, grows like the old rows
//      (1.5×, at least need / PACK_FILL), and the packed buffer is far below the old fixed-slot layout
import { BASE_MAX } from "../deck/batched-terrain-grid";
import {
	BaseSlotAllocator,
	baseSlotVec4,
	type PlacedSlot,
	packedCapacity,
	placeSlots,
} from "./base-slots";

let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.log(`FAIL ${msg}`);
};
let seed = 777;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

// ---------- 1. sizes ----------
if (baseSlotVec4(BASE_MAX) !== 2 * (BASE_MAX + 1) * (BASE_MAX + 1))
	fail("baseSlotVec4(BASE_MAX) is not the old fixed slot");
if (baseSlotVec4(32) !== 2178) fail("baseSlotVec4(32)");

// ---------- 2 + 3. random sync sequences ----------
const SMALL = baseSlotVec4(32);
const BIG = baseSlotVec4(64);
let repacks = 0;
let inPlace = 0;
let syncs = 0;
let worstRatio = 0;
for (let trial = 0; trial < 300; trial++) {
	const max = trial % 7 === 0 ? 400 * SMALL : 2 ** 24;
	const alloc = new BaseSlotAllocator(128 * SMALL);
	const live = new Map<number, PlacedSlot>();
	let nextId = 0;
	let cap = alloc.capacity;
	let peak = 0;
	for (let step = 0; step < 40; step++) {
		// drop some tiles (a pan), release their slots
		for (const [id, s] of live)
			if (rand() < 0.25) {
				live.delete(id);
				if (s.base >= 0) alloc.release(s.base, s.size);
			}
		// fresh tiles: ~3 % G = 64 (the photo view's mix), a burst now and then
		const n = Math.floor(rand() * (step === 0 ? 380 : 120));
		const fresh: PlacedSlot[] = [];
		for (let k = 0; k < n; k++) {
			const s = { size: rand() < 0.03 ? BIG : SMALL, base: -1 };
			live.set(nextId++, s);
			fresh.push(s);
		}
		const before = alloc.capacity;
		const r = placeSlots(alloc, live.values(), fresh, max);
		syncs++;
		if (r.repacked) repacks++;
		if (r.repacked && r.capacity === before) inPlace++;
		if (r.capacity < before) fail(`capacity shrank ${before} → ${r.capacity}`);
		if (r.capacity > max) fail(`capacity ${r.capacity} past max ${max}`);
		if (!r.repacked && r.capacity !== before)
			fail("capacity changed without a re-pack");
		if (r.capacity !== before) {
			let need = 0;
			for (const s of live.values()) need += s.size;
			if (r.capacity !== packedCapacity(before, need, max))
				fail("grown capacity is not packedCapacity");
		}
		cap = r.capacity;
		// overflowed slots (past max) are dropped by the caller
		for (const [id, s] of live)
			if (s.base < 0) {
				if (max === 2 ** 24) fail("a slot overflowed below max");
				live.delete(id);
			}
		const spans = [...live.values()]
			.map((s) => [s.base, s.base + s.size] as const)
			.sort((a, b) => a[0] - b[0]);
		for (let i = 0; i < spans.length; i++) {
			const [a, b] = spans[i];
			if (!Number.isInteger(a) || Math.fround(a) !== a)
				fail(`offset ${a} not f32-exact`);
			if (a < 0 || b > cap) fail(`slot [${a}, ${b}) outside capacity ${cap}`);
			if (i && spans[i - 1][1] > a)
				fail(`slots overlap at ${a} (prev ends ${spans[i - 1][1]})`);
		}
		// the old layout held at least the peak live tile count in fixed G = 64 slots
		peak = Math.max(peak, live.size);
		if (peak > 50) worstRatio = Math.max(worstRatio, cap / (peak * BIG));
	}
}
console.log(
	`random syncs: ${syncs}, re-packs ${repacks} (${inPlace} without a grow); worst packed capacity / (peak live tiles × old fixed slot) = ${worstRatio.toFixed(3)}`,
);
if (worstRatio > 0.75)
	fail(`packed capacity not below the old layout (${worstRatio})`);

// the capacity rule itself
if (packedCapacity(100, 85, 1000) !== 100) fail("packedCapacity: fits");
if (packedCapacity(100, 90, 1000) !== 150) fail("packedCapacity: headroom");
if (packedCapacity(100, 120, 1000) !== 150) fail("packedCapacity: 1.5×");
if (packedCapacity(100, 340, 1000) !== 400) fail("packedCapacity: need");
if (packedCapacity(100, 400, 300) !== 300) fail("packedCapacity: max");

console.log(failures ? `FAIL (${failures})` : "PASS base-slots");
process.exit(failures ? 1 : 0);
