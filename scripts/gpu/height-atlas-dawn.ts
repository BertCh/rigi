// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Height-atlas compaction on Dawn (WAG perf-vram): a real r32float TextureArrayAtlas with a mix of
// AtlasLeases and owner layers, a distinct raster per layer, about half released, then
// compactLeased: every live layer reads back byte-identical at its remapped index, the capacity
// shrank (never below the floor), every lease was re-pointed, a lease released afterwards frees its
// NEW layer, and growing again keeps the contents. Refusals: a leased write in flight, an owner
// list that does not add up, compact() on an atlas with leases. Second part: a "core" device with no
// requiredLimits has maxTextureArrayLayers 256 (the near-first overflow case), and nearestWithin
// keeps the nearest 256 of 300 synthetic tiles.
//   DAWN_DIR=/path/with/webgpu@0.3.0 npx tsx scripts/gpu/height-atlas-dawn.ts
// Prints SKIP and exits 0 when DAWN_DIR is unset.
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Device, Texture } from "@luma.gl/core";
import { nearestWithin } from "../../src/lib/deck-webgpu/atlas-layout";
import {
	AtlasLease,
	TextureArrayAtlas,
} from "../../src/lib/deck-webgpu/texture-array-atlas";
import { submit } from "../../src/lib/gpu/core/queue";

const dawnDir = process.env.DAWN_DIR;
if (!dawnDir) {
	console.log("SKIP height-atlas-dawn: DAWN_DIR is not set");
	process.exit(0);
}
const { create, globals } = await import(
	pathToFileURL(path.join(dawnDir, "node_modules/webgpu/index.js")).href
);
Object.assign(globalThis, globals);
const gpu = create([]); // keep the instance referenced
Object.defineProperty(globalThis, "navigator", {
	value: { gpu, userAgent: "node" },
	configurable: true,
});
const { webgpuAdapter } = await import("@luma.gl/webgpu");
const { Buffer: LumaBuffer } = await import("@luma.gl/core");

const makeDevice = (id: string) =>
	webgpuAdapter.create({
		id,
		featureLevel: "core",
	} as never) as Promise<Device>;

let failures = 0;
const fail = (msg: string) => {
	failures++;
	console.log(`FAIL ${msg}`);
};
let seed = 20261001;
const rand = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

const SIZE = 64;
const QUANTUM = 16;
const device = await makeDevice("height-atlas-dawn");
const limit = (device.limits as { maxTextureArrayLayers?: number })
	.maxTextureArrayLayers;
console.log(`device limits.maxTextureArrayLayers ${limit}`);

async function readLayer(texture: Texture, layer: number) {
	const buf = device.createBuffer({
		id: "readback",
		usage: LumaBuffer.COPY_DST | LumaBuffer.MAP_READ,
		byteLength: SIZE * SIZE * 4,
	});
	const enc = device.createCommandEncoder({ id: "readback" });
	enc.copyTextureToBuffer({
		sourceTexture: texture,
		origin: [0, 0, layer],
		width: SIZE,
		height: SIZE,
		depthOrArrayLayers: 1,
		destinationBuffer: buf,
		byteOffset: 0,
		bytesPerRow: SIZE * 4,
		rowsPerImage: SIZE,
	});
	submit(device, enc);
	const bytes = new Uint8Array(await buf.readAsync());
	buf.destroy();
	return bytes;
}

const raster = (tag: number) => {
	const r = new Float32Array(SIZE * SIZE);
	for (let i = 0; i < r.length; i++) r[i] = tag * 10000 + i;
	return r;
};
const same = (a: Uint8Array, b: Float32Array) => {
	const e = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
	if (a.length !== e.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== e[i]) return false;
	return true;
};

const atlas = new TextureArrayAtlas(device, {
	id: "height-atlas-dawn",
	format: "r32float",
	size: SIZE,
	usage: 0x07, // SAMPLE | COPY_DST | COPY_SRC
	capacity: QUANTUM,
	maxLayers: 256,
	grow: { factor: 1.5 },
});

// 100 layers, half leases, each with its own raster
const N = 100;
atlas.reserve(N);
type Held = {
	tag: number;
	data: Float32Array;
	lease?: AtlasLease;
	layer: number;
};
const held: Held[] = [];
for (let tag = 0; tag < N; tag++) {
	const layer = atlas.alloc();
	const data = raster(tag + 1);
	atlas.writeRaster(layer, data, SIZE);
	held.push({
		tag,
		data,
		layer,
		lease: rand() < 0.5 ? new AtlasLease(atlas, layer) : undefined,
	});
}
const startCapacity = atlas.capacity;
// release about half, spread over both kinds
let live = held.filter((h) => {
	if (rand() < 0.55) {
		if (h.lease) h.lease.release();
		else atlas.release(h.layer);
		return false;
	}
	return true;
});
const ownerLayers = () => live.filter((h) => !h.lease).map((h) => h.layer);
console.log(
	`${live.length} live layers of ${N} (${live.filter((h) => h.lease).length} leased), capacity ${startCapacity}`,
);

// refusals first: nothing may move
const v0 = atlas.version;
if (atlas.compact(ownerLayers(), QUANTUM) !== null)
	fail("compact() ran on an atlas with leases");
if (atlas.compactLeased(ownerLayers().slice(1), QUANTUM, QUANTUM) !== null)
	fail("compactLeased ran with a layer unaccounted for");
(atlas as unknown as { pendingLeased: number }).pendingLeased = 1;
if (atlas.compactLeased(ownerLayers(), QUANTUM, QUANTUM) !== null)
	fail("compactLeased ran with a leased write in flight");
(atlas as unknown as { pendingLeased: number }).pendingLeased = 0;
if (atlas.version !== v0) fail("a refused compaction re-created the texture");

const before = new Map(live.map((h) => [h, h.lease ? h.lease.layer : h.layer]));
const remap = atlas.compactLeased(ownerLayers(), QUANTUM, QUANTUM);
if (!remap) {
	fail("compactLeased refused a consistent atlas");
	process.exit(1);
}
const wantCap = Math.max(QUANTUM, Math.ceil(live.length / QUANTUM) * QUANTUM);
if (atlas.capacity !== wantCap || atlas.capacity >= startCapacity)
	fail(`capacity ${startCapacity} -> ${atlas.capacity}, wanted ${wantCap}`);
if (atlas.version !== v0 + 1) fail("texture was not re-created once");
if (atlas.texture.depth !== atlas.capacity)
	fail(`texture depth ${atlas.texture.depth} ≠ capacity ${atlas.capacity}`);
if (atlas.used() !== live.length) fail(`used() ${atlas.used()}`);
for (const h of live) {
	const old = before.get(h) as number;
	const now = remap.get(old) as number;
	if (h.lease) {
		if (h.lease.layer !== now) fail(`lease ${h.tag} not re-pointed`);
	} else h.layer = now;
}
const layersNow = new Set(live.map((h) => (h.lease ? h.lease.layer : h.layer)));
if (layersNow.size !== live.length) fail("two live layers share an index");
for (const l of layersNow)
	if (l >= live.length) fail(`layer ${l} not packed below ${live.length}`);

async function verify(label: string) {
	let bad = 0;
	for (const h of live) {
		const layer = h.lease ? h.lease.layer : h.layer;
		if (!same(await readLayer(atlas.texture, layer), h.data)) bad++;
	}
	if (bad) fail(`${label}: ${bad} of ${live.length} layers differ`);
	else console.log(`${label}: ${live.length} layers byte-identical`);
}
await verify("after compactLeased");

// releasing a lease after the move frees its NEW layer
const leased = live.filter((h) => h.lease);
if (leased.length) {
	const h = leased[0];
	const newLayer = (h.lease as AtlasLease).layer;
	(h.lease as AtlasLease).release();
	live = live.filter((x) => x !== h);
	if (atlas.alloc() !== newLayer)
		fail("released lease did not free its new layer");
	atlas.release(newLayer);
}

// grow again: contents hold
atlas.reserve(atlas.capacity + 20);
await verify("after growing again");

// a second compaction after the grow works on the packed books
const remap2 = atlas.compactLeased(ownerLayers(), QUANTUM, QUANTUM);
if (live.length && atlas.capacity - live.length >= QUANTUM && !remap2)
	fail("second compaction refused");
if (remap2) {
	for (const h of live) if (!h.lease) h.layer = remap2.get(h.layer) as number;
	await verify("after a second compaction");
}
atlas.destroy();

// near-first overflow on a 256-layer device
const core = await makeDevice("height-atlas-dawn-core");
const coreLayers = (core.limits as { maxTextureArrayLayers?: number })
	.maxTextureArrayLayers;
if (coreLayers !== 256) fail(`core device maxTextureArrayLayers ${coreLayers}`);
const tiles = Array.from({ length: 300 }, (_, i) => ({
	id: `tile-${i}`,
	distance: Math.floor(rand() * 50) + (i % 7) * 0.001,
}));
const kept = nearestWithin(tiles, coreLayers ?? 256);
const sorted = [...tiles].sort(
	(a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1),
);
const nearest = new Set(sorted.slice(0, 256));
if (kept.length !== 256 || kept.some((t) => !nearest.has(t)))
	fail("nearestWithin did not keep the nearest 256 of 300");
if (kept.some((t, i) => i && tiles.indexOf(t) <= tiles.indexOf(kept[i - 1])))
	fail("nearestWithin lost the input order");
console.log(
	`nearestWithin: ${kept.length} of ${tiles.length} kept on a ${coreLayers}-layer device`,
);

core.destroy();
device.destroy();
console.log(failures ? `FAIL (${failures})` : "PASS height-atlas-dawn");
process.exit(failures ? 1 : 0);
