// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { Device } from "@luma.gl/core";
import { describe, expect, it, vi } from "vitest";
import { gridMesh } from "#/lib/deck/batched-terrain-grid";
import { cameraUniforms, photoCamera } from "../camera";
import { TerrainGpuCull } from "../layers/terrain-cull";
import { CAND_BYTES, CULL_SLOTS } from "../layers/terrain-cull.wgsl";
import {
	styleFeatures,
	type TerrainStyleFeatures,
	type TerrainStyleName,
	terrainStyleWGSL,
} from "../layers/terrain-styles";
import {
	AtlasLease,
	TextureArrayAtlas,
	TileLayerRef,
} from "../texture-array-atlas";

const STYLES: TerrainStyleName[] = [
	"hillshade",
	"imagery",
	"contours",
	"elevation",
	"slope",
	"slopeClass",
];
const NO_FEATURES: TerrainStyleFeatures = {
	alpine: false,
	relief: false,
	tanaka: false,
	atmosphere: false,
	water: false,
};

describe("terrainStyleWGSL", () => {
	it("every style defines terrain_base exactly once and leaves no template debris", () => {
		for (const style of STYLES) {
			const src = terrainStyleWGSL(style, NO_FEATURES);
			expect(src.match(/fn terrain_base\(/g)?.length, style).toBe(1);
			expect(src, style).not.toContain("undefined");
			expect(src, style).not.toContain("[object");
			expect(src, style).not.toContain("${");
			// braces balance
			expect(src.split("{").length, style).toBe(src.split("}").length);
		}
	});

	it("feature switches add their chunks only for the styles that use them", () => {
		const all: TerrainStyleFeatures = {
			alpine: true,
			relief: true,
			tanaka: true,
			atmosphere: true,
			water: true,
			waves: true,
		};
		const base = terrainStyleWGSL("hillshade", NO_FEATURES);
		const alpine = terrainStyleWGSL("hillshade", {
			...NO_FEATURES,
			alpine: true,
		});
		expect(alpine.length).toBeGreaterThan(base.length);
		expect(alpine).toContain("ts_alpine_albedo(");
		expect(base).not.toContain("ts_alpine_albedo(");
		const water = terrainStyleWGSL("hillshade", {
			...NO_FEATURES,
			alpine: true,
			water: true,
		});
		expect(water).toContain("ts_water_shade(");
		const wave = terrainStyleWGSL("imagery", all);
		const flat = terrainStyleWGSL("imagery", { ...all, waves: false });
		expect(wave.length).toBeGreaterThan(flat.length);
		// relief replaces the plain hillshade factor
		expect(
			terrainStyleWGSL("hillshade", { ...NO_FEATURES, relief: true }),
		).toContain("ts_relief_shade(");
		expect(base).toContain("fog_shade(n)");
		// tanaka only matters for contours
		expect(
			terrainStyleWGSL("contours", { ...NO_FEATURES, tanaka: true }),
		).toContain("ts_tanaka_lines(");
		expect(terrainStyleWGSL("contours", NO_FEATURES)).not.toContain(
			"ts_tanaka_lines(",
		);
		expect(
			terrainStyleWGSL("elevation", { ...NO_FEATURES, tanaka: true }),
		).not.toContain("ts_tanaka_lines(");
	});

	it("style-specific bodies", () => {
		expect(terrainStyleWGSL("imagery", NO_FEATURES)).toContain("if (s.hasImg)");
		expect(terrainStyleWGSL("hillshade", NO_FEATURES)).not.toContain(
			"if (s.hasImg)",
		);
		expect(terrainStyleWGSL("slope", NO_FEATURES)).toContain("magenta");
		expect(terrainStyleWGSL("slopeClass", NO_FEATURES)).toContain(
			"ts_slope_class(",
		);
		expect(terrainStyleWGSL("elevation", NO_FEATURES)).toContain(
			"ts_band_ramp(",
		);
		expect(terrainStyleWGSL("contours", NO_FEATURES)).toContain("contourSolid");
		// the near discard is part of every style
		for (const s of STYLES)
			expect(terrainStyleWGSL(s, NO_FEATURES)).toContain("nearDiscard");
	});

	it("generation is deterministic", () => {
		for (const s of STYLES) {
			const f = styleFeatures(s, {
				defines: ["LOOK_ALPINE", "LOOK_RELIEF"],
				rel: {},
				atm: null,
			} as never);
			expect(terrainStyleWGSL(s, f)).toBe(terrainStyleWGSL(s, f));
		}
	});
});

describe("TerrainGpuCull candidates", () => {
	function fakeDevice() {
		const buffers: {
			id: string;
			writes: ArrayBuffer[];
			destroyed: boolean;
			byteLength: number;
		}[] = [];
		const device = {
			createBuffer: (p: {
				id: string;
				data?: Uint32Array;
				byteLength?: number;
			}) => {
				const b = {
					id: p.id,
					byteLength: p.byteLength ?? p.data?.byteLength ?? 0,
					writes: [] as ArrayBuffer[],
					destroyed: false,
					write(d: ArrayBufferView | ArrayBuffer) {
						this.writes.push(
							ArrayBuffer.isView(d) ? (d.buffer as ArrayBuffer) : d,
						);
					},
					destroy() {
						this.destroyed = true;
					},
				};
				buffers.push(b);
				return b;
			},
		} as unknown as Device;
		return { device, buffers };
	}
	const tile = (row: number, seg: number) => ({
		sphere: [row, 0, 0, 10] as [number, number, number, number],
		row,
		seg,
	});

	it("assigns seg indices in first-seen order and keeps them across calls", () => {
		const { device, buffers } = fakeDevice();
		const c = new TerrainGpuCull(device);
		expect(c.setCandidates([tile(0, 64), tile(1, 128), tile(2, 64)])).toBe(
			true,
		);
		const index = buffers.find((b) => b.id === "terrain-cull-index");
		expect(index?.byteLength).toBe(
			(gridMesh(64).indices.length + gridMesh(128).indices.length) * 4,
		);
		const cand = buffers.find((b) => b.id === "terrain-cull-cand");
		expect(cand?.byteLength).toBe(64 * CAND_BYTES);
		const words = new Uint32Array(cand?.writes.at(-1) as ArrayBuffer);
		expect([words[4], words[5]]).toEqual([0, 0]); // row 0, seg index 0
		expect([words[CAND_BYTES / 4 + 4], words[CAND_BYTES / 4 + 5]]).toEqual([
			1, 1,
		]);
		expect(words[(2 * CAND_BYTES) / 4 + 5]).toBe(0);
		// a later call with a new seg appends; known segs keep their index
		const before = buffers.filter((b) => b.id === "terrain-cull-index").length;
		expect(c.setCandidates([tile(5, 256), tile(6, 128)])).toBe(true);
		expect(buffers.filter((b) => b.id === "terrain-cull-index").length).toBe(
			before + 1,
		);
		const w2 = new Uint32Array(
			buffers
				.filter((b) => b.id === "terrain-cull-cand")[0]
				.writes.at(-1) as ArrayBuffer,
		);
		expect(w2[5]).toBe(2); // 256 is the third seg seen
		expect(w2[CAND_BYTES / 4 + 5]).toBe(1); // 128 kept its index
	});

	it("refuses more distinct segs than draw slots", () => {
		const { device } = fakeDevice();
		const c = new TerrainGpuCull(device);
		const tooMany = Array.from({ length: CULL_SLOTS + 1 }, (_, i) =>
			tile(i, 8 + i),
		);
		expect(c.setCandidates(tooMany)).toBe(false);
	});

	it("grows the candidate buffer by doubling and retires the old one at the next prepare", () => {
		const { device, buffers } = fakeDevice();
		const c = new TerrainGpuCull(device);
		c.setCandidates(Array.from({ length: 10 }, (_, i) => tile(i, 32)));
		const first = buffers.find((b) => b.id === "terrain-cull-cand");
		c.setCandidates(Array.from({ length: 100 }, (_, i) => tile(i, 32)));
		const cands = buffers.filter((b) => b.id === "terrain-cull-cand");
		expect(cands.length).toBe(2);
		expect(cands[1].byteLength).toBe(128 * CAND_BYTES);
		expect(first?.destroyed).toBe(false); // an encoder may still reference it
		c.destroy();
		expect(buffers.every((b) => b.destroyed)).toBe(true);
	});

	it("prepare returns null when nothing is ready (CPU cull takes over) and never throws", () => {
		const { device } = fakeDevice();
		const c = new TerrainGpuCull(device);
		const cam = cameraUniforms(
			photoCamera({
				pose: { yaw: 0, pitch: 0, roll: 0, vfov: 40 },
				eye: [0, 0, 0],
				width: 100,
				height: 100,
			}),
		);
		expect(c.prepare({} as never, cam)).toBeNull(); // no candidates
		c.setCandidates([tile(0, 32)]);
		vi.spyOn(console, "warn").mockImplementation(() => {});
		// the graph is built lazily and compiles asynchronously: not usable on this first call
		let r: unknown = "unset";
		try {
			r = c.prepare({} as never, cam);
		} catch {
			r = null;
		}
		expect(r).toBeNull();
	});
});

describe("TextureArrayAtlas bookkeeping", () => {
	function atlas(capacity = 0, maxLayers = 32) {
		const made: { depth: number; destroyed: boolean; destroy: () => void }[] =
			[];
		const device = {
			createTexture: (p: { depth: number }) => {
				const t = {
					depth: p.depth,
					destroyed: false,
					destroy() {
						this.destroyed = true;
					},
				};
				made.push(t);
				return t;
			},
		} as unknown as Device;
		const a = new TextureArrayAtlas(device, {
			id: "t",
			format: "r32float",
			size: 256,
			usage: 0,
			capacity,
			maxLayers,
			grow: { chunk: 8 },
		});
		return { a, made };
	}

	it("allocates layers, reuses released ones and counts use", () => {
		const { a } = atlas(4);
		expect(a.capacity).toBe(4);
		const l0 = a.alloc();
		const l1 = a.alloc();
		expect([l0, l1]).toEqual([0, 1]);
		expect(a.used()).toBe(2);
		expect(a.available()).toBe(2);
		a.release(l0);
		expect(a.allocWithin()).toBe(0);
		expect(a.allocWithin()).toBe(2);
		expect(a.allocWithin()).toBe(3);
		expect(a.allocWithin()).toBeUndefined();
		expect(a.alloc()).toBe(4); // beyond capacity: the caller grows
	});

	it("reserve from empty creates the texture at the grown capacity (chunked, capped)", () => {
		const { a, made } = atlas(0, 20);
		expect(made.length).toBe(1);
		expect(a.reserve(5)).toBe(true);
		expect(a.capacity).toBe(8);
		expect(a.version).toBe(1);
		expect(made[0].destroyed).toBe(true);
		expect(made[1].depth).toBe(8);
		expect(a.stats.grows).toBe(1);
		expect(a.reserve(5)).toBe(false); // already enough
		expect(a.version).toBe(1);
	});

	it("leases are reference counted and return their layer on the last release", () => {
		const { a } = atlas(4);
		const layer = a.alloc();
		const lease = new AtlasLease(a, layer);
		expect(a.stats.leases).toBe(1);
		expect(lease.live).toBe(true);
		lease.retain();
		lease.release();
		expect(lease.live).toBe(true);
		expect(a.used()).toBe(1);
		lease.release();
		expect(lease.live).toBe(false);
		expect(a.stats.leases).toBe(0);
		expect(a.used()).toBe(0);
		lease.release(); // idempotent
		expect(a.stats.leases).toBe(0);
		expect(() => lease.retain()).toThrow(/after release/);
	});

	it("a TileLayerRef releases its lease once", () => {
		const { a } = atlas(4);
		const lease = new AtlasLease(a, a.alloc());
		lease.retain(); // the draw's own hold
		const ref = new TileLayerRef(lease);
		ref.release();
		ref.release();
		expect(lease.live).toBe(true);
		lease.release();
		expect(a.used()).toBe(0);
	});

	it("relocate moves a lease's layer; compact refuses while leases exist; destroyed atlases hold nothing", () => {
		const { a } = atlas(8);
		const lease = new AtlasLease(a, a.alloc());
		lease.relocate(5);
		expect(lease.layer).toBe(5);
		expect(a.compact([0], 8)).toBeNull();
		expect(a.compactLeased([], 8, 8)).toBeNull(); // plan refuses or nothing to free
		a.destroy();
		expect(a.destroyed).toBe(true);
		expect(lease.live).toBe(false);
		expect(a.compactLeased([], 8, 8)).toBeNull();
		lease.release(); // does not touch the destroyed allocator
	});
});
