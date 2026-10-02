// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Node check for the TextureArrayAtlas math (atlas-layout.ts), no GPU.
// Run: npx tsx src/lib/deck-webgpu/atlas-layout.check.ts
//   1. allocation: LayerAllocator hands out the same layers, in the same order, as the two pools it
//      replaces (HeightPool `free.pop() ?? next++`; ImageryArray's pre-filled descending free list
//      extended by each grow) over random alloc / release / grow sequences
//   2. growth: grownCapacity reproduces HeightPool.reserve (factor 1.5) and ImageryArray.grow
//      (+64 per call up to the device max), never shrinks, never passes max
//   3. grow copies: one region per mip, sizes halving to 1, every old layer; atlasBytes sums them
//   4. ancestor window: sampling the ancestor at offset + scale · uv (bilinear on pixel centres)
//      reproduces dem/grid.ts ancestorCrop bit for bit, for z gaps 0–4 and every child position;
//      offsets / scales are exact in f32
//   5. compaction: compactPlan moves every live layer to 0 … n−1 in order, its runs cover exactly
//      the live layers with no target overlap, capacity is the quantum-rounded count;
//      LayerAllocator.resetPacked continues at n; the runs, emulated as copies of layer contents
//      (every mip), put each live layer's texels at its new index
//   6. imagery tiers: imageryTierOf / encodeImageryLayer / decodeImageryLayer (the WGSL's decode in
//      terrain.ts) round-trip for every layer up to 2048 in both tiers, encodings are exact f32 and
//      never collide; the 256² tier's mip 2 vs the old upsampled-512² mip 3 (imgAvg), emulated with
//      a bilinear 2× upsample and box mips, differ by little (printed; the browser pass judges frames)
//   7. leases (texture-array-atlas.ts AtlasLease / TileLayerRef): the layer returns to the atlas
//      exactly once, when the last of tile + TileStore references goes, in either order; a tile ref
//      releases once; nothing returns to a destroyed atlas
//  11. imagery overflow (planImageryOverflow): the nearest `maxLayers` per tier keep layers, evictions
//      are exactly the resident tiles that lose, and the plan is stable under repeated application
//   9. lease-aware compaction (compactLeasedPlan): owner and lease layers disjoint, their count equals
//      the allocator's used(), minCapacity respected, every layer ends at a distinct index below the
//      new capacity, the remap applied to leases (AtlasLease.relocate) moves exactly the live ones,
//      and any bookkeeping mismatch yields null
//  10. near-first overflow (nearestWithin): the budget nearest by (distance, id), input order kept,
//      deterministic under ties, everything when it fits
//   8. spare meshes (deck/terrain-stream.ts spareEviction): the oldest go down to spareMeshes, then all
//      but the newest spareGpuLayers of the kept ones let go of their GPU heights
import { spareEviction } from "../deck/terrain-stream";
import { ancestorCrop } from "../dem/grid";
import type { TileKey } from "../dem/tiles";
import {
	ancestorWindow,
	atlasBytes,
	compactLeasedPlan,
	compactPlan,
	decodeImageryLayer,
	encodeImageryLayer,
	growCopies,
	grownCapacity,
	IMAGERY_SMALL_TIER_BASE,
	imageryTierOf,
	LayerAllocator,
	leaseFits,
	nearestWithin,
	planImageryOverflow,
} from "./atlas-layout";
import { AtlasLease, TileLayerRef } from "./texture-array-atlas";

let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.log(`FAIL ${msg}`);
};
let seed = 12345;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

// ---------- 1. allocation order ----------
{
	// old HeightPool
	for (let trial = 0; trial < 200; trial++) {
		const oldFree: number[] = [];
		let oldNext = 0;
		const a = new LayerAllocator(16);
		const live: number[] = [];
		for (let step = 0; step < 300; step++) {
			if (live.length && rand() < 0.45) {
				const i = Math.floor(rand() * live.length);
				const l = live.splice(i, 1)[0];
				oldFree.push(l);
				a.release(l);
			} else {
				const want = oldFree.pop() ?? oldNext++;
				const got = a.alloc();
				if (want !== got) {
					fail(
						`heightPool order trial ${trial} step ${step}: ${got} ≠ ${want}`,
					);
					break;
				}
				live.push(got);
			}
		}
	}
	// old ImageryArray: free = range(cap) descending; grow (only when free is empty) pushes
	// range(next - cap, cap); alloc = free.pop() (undefined = none)
	const range = (n: number, from = 0) =>
		Array.from({ length: n }, (_, i) => from + n - 1 - i);
	for (let trial = 0; trial < 200; trial++) {
		const max = 64 + Math.floor(rand() * 4) * 64 + Math.floor(rand() * 10);
		let oldCap = Math.min(64, max);
		const oldFree = range(oldCap);
		const a = new LayerAllocator(Math.min(64, max));
		const live: number[] = [];
		for (let step = 0; step < 600; step++) {
			if (oldFree.length !== a.available()) {
				fail(`imagery available trial ${trial} step ${step}`);
				break;
			}
			const r = rand();
			if (live.length && r < 0.3) {
				const l = live.splice(Math.floor(rand() * live.length), 1)[0];
				oldFree.push(l);
				a.release(l);
			} else if (r < 0.4 && !oldFree.length) {
				// grow (as sync does when nothing is free)
				const ok = oldCap < max;
				if (ok) {
					const next = Math.min(max, oldCap + 64);
					oldFree.push(...range(next - oldCap, oldCap));
					oldCap = next;
				}
				const cap = grownCapacity(a.capacity, a.capacity + 1, max, {
					chunk: 64,
				});
				if (ok !== (cap !== a.capacity) || cap !== oldCap) {
					fail(`imagery grow trial ${trial} step ${step}: ${cap} vs ${oldCap}`);
					break;
				}
				a.capacity = cap;
			} else {
				const want = oldFree.pop();
				const got = a.allocWithin();
				if (want !== got) {
					fail(`imagery order trial ${trial} step ${step}: ${got} ≠ ${want}`);
					break;
				}
				if (got !== undefined) live.push(got);
			}
		}
	}
}

// ---------- 2. growth ----------
{
	const oldReserve = (cap: number, need: number, max: number) => {
		if (need <= cap) return cap;
		const c = Math.min(max, Math.max(need, Math.ceil(cap * 1.5)));
		return c;
	};
	for (let i = 0; i < 20000; i++) {
		const max = [256, 2048][i & 1];
		const cap = 1 + Math.floor(rand() * max);
		const need = Math.floor(rand() * max * 1.5);
		const got = grownCapacity(cap, need, max, { factor: 1.5 });
		const want = oldReserve(cap, need, max);
		if (got !== want)
			fail(`factor grow ${cap} ${need} ${max}: ${got} ≠ ${want}`);
		const ch = grownCapacity(cap, need, max, { chunk: 64 });
		if (ch < cap || ch > Math.max(cap, max))
			fail(`chunk grow range ${cap} ${need} ${max}: ${ch}`);
		if (need > cap && cap < max && ch < Math.min(need, max))
			fail(`chunk grow short ${cap} ${need} ${max}: ${ch}`);
	}
	// the app's HeightPool sequence: 128 → 360 tiles → 540
	const seq = [grownCapacity(128, 360, 256, { factor: 1.5 })];
	if (seq[0] !== 256) fail(`core device 128→360 capped at 256, got ${seq[0]}`);
	if (grownCapacity(128, 360, 2048, { factor: 1.5 }) !== 360)
		fail("128→360 on 2048");
	if (grownCapacity(360, 361, 2048, { factor: 1.5 }) !== 540) fail("360→540");
}

// ---------- 3. grow copies ----------
{
	const c = growCopies(512, 10, 64);
	if (c.length !== 10) fail(`copies ${c.length}`);
	for (let m = 0; m < c.length; m++) {
		const s = 512 >> m;
		if (
			c[m].width !== s ||
			c[m].height !== s ||
			c[m].mipLevel !== m ||
			c[m].depthOrArrayLayers !== 64
		)
			fail(`copy mip ${m} ${JSON.stringify(c[m])}`);
	}
	const one = growCopies(256, 1, 128);
	if (one.length !== 1 || one[0].width !== 256) fail("single-mip copy");
	// 512² rgba8 with 10 mips: 4/3 of the base, to the texel
	const b = atlasBytes(512, 10, 1, 4);
	if (
		b !==
		4 *
			(512 * 512 +
				256 * 256 +
				128 * 128 +
				64 * 64 +
				32 * 32 +
				16 * 16 +
				64 +
				16 +
				4 +
				1)
	)
		fail(`atlasBytes ${b}`);
	if (atlasBytes(256, 1, 128, 4) !== 128 * 2 ** 18) fail("atlasBytes r32f");
}

// ---------- 4. ancestor window ----------
{
	// the window path: sample the ancestor (S², pixel-centred) at S · (offset + scale · uv)
	const viaWindow = (
		h: Float32Array,
		src: TileKey,
		key: TileKey,
		size: number,
	) => {
		const S = Math.round(Math.sqrt(h.length));
		const w = ancestorWindow(src, key);
		const m = S - 1;
		const out = new Float32Array(size * size);
		// the same expression order as ancestorCrop: ox + (i + 0.5) · f, f = S · scale / size
		const f = (S * w.scale) / size;
		const ox = w.offsetX * S - 0.5;
		const oy = w.offsetY * S - 0.5;
		for (let j = 0; j < size; j++) {
			const y = Math.min(Math.max(oy + (j + 0.5) * f, 0), m);
			const y0 = Math.floor(y);
			const fy = y - y0;
			const y1 = Math.min(y0 + 1, m);
			for (let i = 0; i < size; i++) {
				const x = Math.min(Math.max(ox + (i + 0.5) * f, 0), m);
				const x0 = Math.floor(x);
				const x1 = Math.min(x0 + 1, m);
				const fx = x - x0;
				const a = h[y0 * S + x0] * (1 - fx) + h[y0 * S + x1] * fx;
				const b = h[y1 * S + x0] * (1 - fx) + h[y1 * S + x1] * fx;
				out[j * size + i] = a * (1 - fy) + b * fy;
			}
		}
		return out;
	};
	let cases = 0;
	for (const S of [64, 256]) {
		const h = new Float32Array(S * S);
		for (let i = 0; i < h.length; i++)
			h[i] = 500 + 3000 * rand() + (i % S) * 0.37;
		const src: TileKey = { z: 9, x: 266, y: 179 };
		for (let gap = 0; gap <= 4; gap++) {
			const n = 2 ** gap;
			for (let dy = 0; dy < n; dy++)
				for (let dx = 0; dx < n; dx++) {
					const key = { z: src.z + gap, x: src.x * n + dx, y: src.y * n + dy };
					const w = ancestorWindow(src, key);
					if (
						Math.fround(w.offsetX) !== w.offsetX ||
						Math.fround(w.scale) !== w.scale
					)
						fail(`window not f32-exact ${JSON.stringify(w)}`);
					if (w.offsetX + w.scale > 1 || w.offsetY + w.scale > 1)
						fail(`window outside the ancestor ${JSON.stringify(w)}`);
					const crop = ancestorCrop(h, src, key, S);
					const win = viaWindow(h, src, key, S);
					cases++;
					let diff = 0;
					for (let i = 0; i < crop.length; i++) if (crop[i] !== win[i]) diff++;
					if (diff)
						fail(
							`window ≠ ancestorCrop S ${S} gap ${gap} (${dx},${dy}): ${diff} texels`,
						);
				}
		}
	}
	const id = ancestorWindow({ z: 12, x: 5, y: 7 }, { z: 12, x: 5, y: 7 });
	if (id.offsetX !== 0 || id.offsetY !== 0 || id.scale !== 1)
		fail("identity window");
	console.log(
		`ancestor window: ${cases} child tiles bit-equal to ancestorCrop`,
	);
}

// ---------- 5. compaction ----------
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the block scopes this section's consts so section names do not collide
{
	for (let trial = 0; trial < 300; trial++) {
		const cap = 1 + Math.floor(rand() * 300);
		const live = [...Array(cap).keys()].filter(() => rand() < 0.4);
		const quantum = 1 + Math.floor(rand() * 64);
		const plan = compactPlan(live, quantum);
		const sorted = [...live].sort((a, b) => a - b);
		sorted.forEach((l, i) => {
			if (plan.remap.get(l) !== i)
				fail(`compact trial ${trial}: ${l} → ${plan.remap.get(l)} ≠ ${i}`);
		});
		const covered: number[] = [];
		for (const r of plan.runs)
			for (let k = 0; k < r.count; k++) {
				if (plan.remap.get(r.from + k) !== r.to + k)
					fail(
						`compact trial ${trial}: run ${JSON.stringify(r)} off the remap`,
					);
				covered.push(r.from + k);
			}
		if (covered.join() !== sorted.join())
			fail(
				`compact trial ${trial}: runs cover ${covered.length} of ${sorted.length}`,
			);
		if (
			plan.capacity % quantum ||
			plan.capacity < sorted.length ||
			plan.capacity - sorted.length >= quantum
		)
			fail(
				`compact trial ${trial}: capacity ${plan.capacity} for ${sorted.length} / ${quantum}`,
			);
		const a = new LayerAllocator(plan.capacity);
		a.resetPacked(sorted.length);
		if (a.used() !== sorted.length || a.alloc() !== sorted.length)
			fail(`compact trial ${trial}: allocator after resetPacked`);
		// the copies themselves: layer contents (one tag per layer and mip) through the runs
		const mips = 1 + Math.floor(rand() * 4);
		const oldTex = [...Array(cap)].map((_, l) =>
			[...Array(mips)].map((_, m) => l * 16 + m),
		);
		const newTex: number[][] = [...Array(plan.capacity)].map(() =>
			Array(mips).fill(-1),
		);
		for (let m = 0; m < mips; m++)
			for (const r of plan.runs)
				for (let k = 0; k < r.count; k++)
					newTex[r.to + k][m] = oldTex[r.from + k][m];
		for (const l of sorted) {
			const to = plan.remap.get(l) ?? -1;
			for (let m = 0; m < mips; m++)
				if (newTex[to]?.[m] !== l * 16 + m)
					fail(`compact trial ${trial}: layer ${l} mip ${m} not at ${to}`);
		}
	}
	console.log("compaction: 300 trials");
}

// ---------- 6. imagery tiers ----------
{
	for (const [w, h, t] of [
		[256, 256, 256],
		[128, 256, 256],
		[257, 256, 512],
		[512, 512, 512],
		[1024, 1024, 512],
	] as const)
		if (imageryTierOf(w, h) !== t) fail(`tierOf ${w}×${h} ≠ ${t}`);
	const seen = new Set<number>();
	for (const tier of [256, 512] as const)
		for (let layer = 0; layer < 2048; layer++) {
			const e = encodeImageryLayer(tier, layer);
			if (Math.fround(e) !== e)
				fail(`encode ${tier}/${layer} not exact in f32`);
			if (seen.has(e)) fail(`encode ${tier}/${layer} collides`);
			seen.add(e);
			const d = decodeImageryLayer(Math.fround(e));
			if (d?.tier !== tier || d.layer !== layer)
				fail(`decode(encode(${tier}, ${layer})) = ${JSON.stringify(d)}`);
		}
	if (decodeImageryLayer(-1) !== null) fail("decode(-1) should be none");
	if (IMAGERY_SMALL_TIER_BASE <= 2048)
		fail("small tier base inside the 512² range");
	// imgAvg: native 256² box mip 2 vs bilinear-2×-upsampled 512² box mip 3 (both 64²)
	const N = 256;
	const src = new Float32Array(N * N);
	for (let y = 0; y < N; y++)
		for (let x = 0; x < N; x++)
			src[y * N + x] =
				0.5 +
				0.25 * Math.sin(x / 7 + y / 11) +
				0.15 * Math.sin(x / 2.3 - y / 3.1) +
				0.1 * (rand() - 0.5);
	const box = (img: Float32Array, n: number) => {
		const h = n / 2;
		const out = new Float32Array(h * h);
		for (let y = 0; y < h; y++)
			for (let x = 0; x < h; x++)
				out[y * h + x] =
					(img[2 * y * n + 2 * x] +
						img[2 * y * n + 2 * x + 1] +
						img[(2 * y + 1) * n + 2 * x] +
						img[(2 * y + 1) * n + 2 * x + 1]) /
					4;
		return out;
	};
	const up = new Float32Array(4 * N * N);
	const at = (x: number, y: number) =>
		src[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))];
	for (let y = 0; y < 2 * N; y++)
		for (let x = 0; x < 2 * N; x++) {
			const sx = (x + 0.5) / 2 - 0.5;
			const sy = (y + 0.5) / 2 - 0.5;
			const x0 = Math.floor(sx);
			const y0 = Math.floor(sy);
			const fx = sx - x0;
			const fy = sy - y0;
			up[y * 2 * N + x] =
				(1 - fy) * ((1 - fx) * at(x0, y0) + fx * at(x0 + 1, y0)) +
				fy * ((1 - fx) * at(x0, y0 + 1) + fx * at(x0 + 1, y0 + 1));
		}
	const native2 = box(box(src, N), N / 2);
	const up3 = box(box(box(up, 2 * N), N), N / 2);
	let max = 0;
	let sum = 0;
	for (let i = 0; i < native2.length; i++) {
		const d = Math.abs(native2[i] - up3[i]);
		max = Math.max(max, d);
		sum += d;
	}
	console.log(
		`imagery tiers: 4096 encodings; imgAvg 256-mip2 vs 512-mip3 |Δ| mean ${(sum / native2.length).toFixed(4)} max ${max.toFixed(4)} (of 1)`,
	);
	if (max > 0.03) fail(`imgAvg tiers differ by ${max}`);
}

// ---------- 7. leases ----------
{
	const released: number[] = [];
	const fake = (destroyed = false) =>
		({
			stats: { leases: 0 },
			leaseSet: new Set(),
			destroyed,
			release: (l: number) => released.push(l),
		}) as never;
	for (const order of ["tile-first", "store-first"] as const) {
		released.length = 0;
		const atlas = fake();
		const lease = new AtlasLease(atlas, 7);
		const ref = new TileLayerRef(lease);
		lease.retain(); // TileStore draws it
		const dropTile = () => {
			ref.release();
			ref.release(); // idempotent
		};
		const dropStore = () => lease.release();
		if (order === "tile-first") dropTile();
		else dropStore();
		if (released.length || !lease.live)
			fail(`lease ${order}: freed with a holder left`);
		if (order === "tile-first") dropStore();
		else dropTile();
		if (released.join() !== "7" || lease.live)
			fail(`lease ${order}: released ${JSON.stringify(released)}`);
		lease.release();
		if (released.length !== 1)
			fail(`lease ${order}: double release returned the layer twice`);
		if ((atlas as { stats: { leases: number } }).stats.leases !== 0)
			fail(
				`lease ${order}: stats.leases ${(atlas as { stats: { leases: number } }).stats.leases}`,
			);
	}
	released.length = 0;
	const dead = fake(true);
	const l2 = new AtlasLease(dead, 3);
	if (l2.live) fail("lease on a destroyed atlas is live");
	l2.release();
	if (released.length) fail("lease returned a layer to a destroyed atlas");
	// headroom: on a 256-layer device the leases stop 64 layers short of the limit
	if (!leaseFits(0, 256) || !leaseFits(191, 256) || leaseFits(192, 256))
		fail("leaseFits: 256-layer headroom is not 64");
	if (!leaseFits(1983, 2048) || leaseFits(1984, 2048))
		fail("leaseFits: 2048-layer headroom is not 64");
	if (leaseFits(12, 16) || !leaseFits(11, 16))
		fail("leaseFits: small-limit headroom is not a quarter");
	console.log(
		"leases: refcount, idempotent tile ref, destroyed atlas, layer headroom",
	);
}

// ---------- 8. spare meshes ----------
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the block scopes this section's consts so section names do not collide
{
	for (let trial = 0; trial < 500; trial++) {
		const n = Math.floor(rand() * 300);
		const candidates = [...Array(n).keys()]; // oldest first
		const spare = n + Math.floor(rand() * 20);
		const spareMeshes = Math.floor(rand() * 200);
		const spareGpu = Math.floor(rand() * 80);
		const { drop, unlease } = spareEviction(
			candidates,
			spare,
			spareMeshes,
			spareGpu,
		);
		const nDrop = Math.min(n, Math.max(0, spare - spareMeshes));
		const kept = n - nDrop;
		const nUnlease = Math.max(0, kept - spareGpu);
		if (drop.join() !== candidates.slice(0, nDrop).join())
			fail(`spare trial ${trial}: drop ${drop.length} ≠ oldest ${nDrop}`);
		if (unlease.join() !== candidates.slice(nDrop, nDrop + nUnlease).join())
			fail(
				`spare trial ${trial}: unlease ${unlease.length} ≠ ${nUnlease} after the dropped`,
			);
		if (kept - unlease.length > spareGpu)
			fail(
				`spare trial ${trial}: ${kept - unlease.length} leased spares > ${spareGpu}`,
			);
	}
	console.log("spare meshes: 500 trials");
}

// ---------- 9. lease-aware compaction ----------
{
	for (let trial = 0; trial < 300; trial++) {
		const quantum = [16, 128][Math.floor(rand() * 2)];
		const capacity = quantum * (1 + Math.floor(rand() * 5));
		const max = capacity + Math.floor(rand() * 3) * quantum;
		const a = new LayerAllocator(capacity);
		const held: number[] = [];
		for (let i = 0; i < capacity * 2; i++) {
			if (held.length && rand() < 0.45) {
				a.release(held.splice(Math.floor(rand() * held.length), 1)[0]);
			} else {
				const l = a.allocWithin();
				if (l !== undefined) held.push(l);
			}
		}
		const owner: number[] = [];
		const lease: number[] = [];
		for (const l of held) (rand() < 0.5 ? owner : lease).push(l);
		const plan = compactLeasedPlan(
			owner,
			lease,
			a.used(),
			quantum,
			quantum,
			capacity,
			max,
		);
		const wantCap = Math.max(
			Math.ceil(held.length / quantum) * quantum,
			quantum,
		);
		if (wantCap >= capacity) {
			if (plan)
				fail(`leased trial ${trial}: compacted without freeing a quantum`);
			continue;
		}
		if (!plan) {
			fail(
				`leased trial ${trial}: no plan though ${held.length} < ${capacity}`,
			);
			continue;
		}
		if (plan.capacity !== wantCap || plan.capacity < quantum)
			fail(`leased trial ${trial}: capacity ${plan.capacity} ≠ ${wantCap}`);
		const targets = new Set(plan.remap.values());
		if (plan.remap.size !== held.length || targets.size !== held.length)
			fail(`leased trial ${trial}: remap not one-to-one`);
		for (const t of targets)
			if (t < 0 || t >= held.length) fail(`leased trial ${trial}: target ${t}`);
		// the remap applied to real leases and the owner's layers: disjoint, all live layers
		const released: number[] = [];
		const atlas = {
			stats: { leases: 0 },
			leaseSet: new Set<AtlasLease>(),
			destroyed: false,
			release: (l: number) => released.push(l),
		};
		const leases = lease.map((l) => new AtlasLease(atlas as never, l));
		if (atlas.leaseSet.size !== lease.length) fail("lease set size");
		for (const l of leases) l.relocate(plan.remap.get(l.layer) as number);
		const after = [
			...owner.map((l) => plan.remap.get(l) as number),
			...leases.map((l) => l.layer),
		];
		if (new Set(after).size !== held.length)
			fail(`leased trial ${trial}: owner and lease layers collide after remap`);
		// releasing a lease after the move frees its new layer
		if (leases.length) {
			const k = Math.floor(rand() * leases.length);
			const want = plan.remap.get(lease[k]);
			leases[k].release();
			if (released.join() !== String(want))
				fail(`leased trial ${trial}: lease released ${released} not ${want}`);
			if (atlas.leaseSet.has(leases[k])) fail("released lease still in set");
		}
		// bookkeeping mismatches refuse
		if (
			compactLeasedPlan(
				owner,
				lease,
				a.used() + 1,
				quantum,
				quantum,
				capacity,
				max,
			)
		)
			fail(`leased trial ${trial}: compacted with an unknown holder`);
		if (owner.length && lease.length) {
			const clash = [...lease.slice(1), owner[0]];
			if (
				compactLeasedPlan(
					owner,
					clash,
					a.used(),
					quantum,
					quantum,
					capacity,
					max,
				)
			)
				fail(`leased trial ${trial}: compacted overlapping owner / lease`);
		}
	}
	// minCapacity above the quantum multiple is respected, and capped by maxLayers
	const p1 = compactLeasedPlan([0, 5], [9], 3, 16, 64, 128, 256);
	if (!p1 || p1.capacity !== 64) fail(`minCapacity: ${p1?.capacity}`);
	if (compactLeasedPlan([0], [1], 2, 16, 128, 128, 256))
		fail("minCapacity equal to capacity should not shrink");
	console.log(
		"lease-aware compaction: 300 trials, remap, minCapacity, refusals",
	);
}

// ---------- 10. near-first overflow ----------
// biome-ignore lint/complexity/noUselessLoneBlockStatements: the block scopes this section's consts so section names do not collide
{
	for (let trial = 0; trial < 200; trial++) {
		const n = Math.floor(rand() * 400);
		const tiles = Array.from({ length: n }, (_, i) => ({
			id: `t${Math.floor(rand() * 1000)}-${i}`,
			distance: Math.floor(rand() * 30), // many ties
		}));
		const budget = Math.floor(rand() * 300);
		const kept = nearestWithin(tiles, budget);
		const again = nearestWithin(tiles, budget);
		if (kept.length !== Math.min(n, budget)) fail(`near trial ${trial}: count`);
		if (kept.some((t, i) => t !== again[i]))
			fail(`near trial ${trial}: unstable`);
		const idx = kept.map((t) => tiles.indexOf(t));
		if (idx.some((v, i) => i && v <= idx[i - 1]))
			fail(`near trial ${trial}: input order lost`);
		if (n <= budget) {
			if (kept.some((t, i) => t !== tiles[i]))
				fail(`near trial ${trial}: changed`);
			continue;
		}
		const keptSet = new Set(kept);
		let far = -1;
		for (const t of kept) far = Math.max(far, t.distance);
		for (const t of tiles)
			if (!keptSet.has(t)) {
				if (t.distance < far) fail(`near trial ${trial}: nearer tile dropped`);
				if (
					t.distance === far &&
					kept.some((k) => k.distance === far && k.id > t.id)
				)
					fail(`near trial ${trial}: tie broke against id`);
			}
	}
	console.log("near-first overflow: 200 trials");
}

// ---------- 11. imagery overflow ----------
{
	let seed = 7;
	const rnd = () => {
		seed = (seed * 1664525 + 1013904223) >>> 0;
		return seed / 2 ** 32;
	};
	for (let trial = 0; trial < 200; trial++) {
		const max = 1 + Math.floor(rnd() * 8);
		const wanted = Array.from({ length: 20 }, (_, i) => ({
			id: `t${i}`,
			tier: rnd() < 0.5 ? (256 as const) : (512 as const),
			distance: Math.floor(rnd() * 6),
		}));
		let resident = new Map<string, 256 | 512>();
		for (const w of wanted) if (rnd() < 0.3) resident.set(w.id, w.tier);
		const plan = planImageryOverflow(wanted, resident, max);
		for (const tier of [256, 512] as const) {
			const n = wanted.filter((w) => w.tier === tier);
			const adm = n.filter((w) => plan.admit.has(w.id));
			if (adm.length !== Math.min(max, n.length))
				fail(`imagery trial ${trial}: tier ${tier} admitted ${adm.length}`);
			const far = Math.max(-1, ...adm.map((w) => w.distance));
			for (const w of n)
				if (!plan.admit.has(w.id) && w.distance < far)
					fail(`imagery trial ${trial}: nearer tile refused`);
		}
		for (const id of plan.evict)
			if (!resident.has(id) || plan.admit.has(id))
				fail(`imagery trial ${trial}: bad eviction ${id}`);
		// apply: evicted leave, admitted join; the same input again changes nothing
		resident = new Map(
			wanted.filter((w) => plan.admit.has(w.id)).map((w) => [w.id, w.tier]),
		);
		const again = planImageryOverflow(wanted, resident, max);
		if (
			again.evict.length ||
			[...again.admit].sort().join() !== [...plan.admit].sort().join()
		)
			fail(`imagery trial ${trial}: not stable`);
	}
	console.log("imagery overflow: 200 trials");
}

console.log(failures ? `FAIL (${failures})` : "PASS atlas-layout");
process.exit(failures ? 1 : 0);
