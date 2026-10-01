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
import { ancestorCrop } from "../dem/grid";
import type { TileKey } from "../dem/tiles";
import {
	ancestorWindow,
	atlasBytes,
	growCopies,
	grownCapacity,
	LayerAllocator,
} from "./atlas-layout";

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

console.log(failures ? `FAIL (${failures})` : "PASS atlas-layout");
process.exit(failures ? 1 : 0);
