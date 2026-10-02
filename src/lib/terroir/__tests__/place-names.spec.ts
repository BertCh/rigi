// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Engine-aware terroir placement against a stub renderer: a flat ground plane seen from 1.5 km up.
import { describe, expect, it, vi } from "vitest";
import { unprojectDir } from "#/lib/camera";
import { EnuFrame } from "#/lib/geodesy";
import type { Renderer } from "#/lib/renderer";
import type { PeakLabel, Sample } from "#/lib/settings";
import { CLASSIC } from "#/lib/style/defaults";
import { mergeStyle } from "#/lib/style/schema";
import { groundAt } from "../labels/ground";
import { peakLabelRects, placeNames } from "../labels/placeNames";
import { makeGrid } from "../pack";
import type { NameClass, TerroirName, TerroirPack } from "../types";
import type { TerroirCtx } from "../ui/context";
import { projectGeo } from "../ui/project";

const LAT0 = 46.7;
const LON0 = 7.8;
const GROUND_ENU = 20; // ground plane height above the frame origin (origin h = 1000, ground 1020 MSL)
const frame = new EnuFrame(LAT0, LON0, 1000);
const M_LAT = 1 / 111320;
const M_LON = 1 / (111320 * Math.cos((LAT0 * Math.PI) / 180));

function makeEngine(
	opts: {
		pose?: { yaw: number; pitch: number; roll: number; vfov: number };
		peaks?: PeakLabel[];
		hideBelowV?: number;
		ready?: boolean;
	} = {},
) {
	const pose = opts.pose ?? { yaw: 0, pitch: -20, roll: 0, vfov: 50 };
	const eye = { x: 0, y: 0, z: GROUND_ENU + 1500 };
	const aspect = 1.5;
	const sampleAt = vi.fn((u: number, v: number): Sample | null => {
		const d = unprojectDir(pose, aspect, u, v);
		if (d[2] >= -1e-6) return null;
		const t = (GROUND_ENU - eye.z) / d[2];
		const w: [number, number, number] = [
			eye.x + d[0] * t,
			eye.y + d[1] * t,
			GROUND_ENU,
		];
		const g = frame.toGeo(w[0], w[1], w[2]);
		// a "near wall": everything below opts.hideBelowV reads as much nearer terrain
		const range = opts.hideBelowV != null && v > opts.hideBelowV ? 50 : t;
		return { lat: g.lat, lon: g.lon, h: 1020, range, world: w };
	});
	const engine = {
		aspect,
		pose,
		frame,
		eye,
		demAtCamera: 1020,
		geometryReady: () => opts.ready ?? true,
		sampleAt,
		isForeground: () => false,
		peakLabels: () => opts.peaks ?? [],
	} as unknown as Renderer;
	return { engine, sampleAt };
}

const at = (northM: number, eastM = 0) => ({
	lat: LAT0 + northM * M_LAT,
	lon: LON0 + eastM * M_LON,
});

const name = (
	text: string,
	cls: NameClass,
	northM: number,
	eastM = 0,
	extra: Partial<TerroirName> = {},
): TerroirName => ({
	name: text,
	cls,
	...at(northM, eastM),
	ele: 1020,
	lang: null,
	status: null,
	src: "swissnames3d",
	...extra,
});

const packOf = (names: TerroirName[]) =>
	({
		v: 1,
		id: "t",
		name: "t",
		bbox: [7, 46, 8.5, 47.5],
		names,
	}) as unknown as TerroirPack;

const W = 900;
const H = 600;
const styleOf = (over: object = {}) =>
	mergeStyle(CLASSIC, {
		terroir: {
			names: { on: true, reach: "all", language: "local", maxLabels: 20 },
		},
		...over,
	} as never);

const ctxOf = (
	engine: Renderer,
	pack: TerroirPack | null,
	over: Partial<TerroirCtx> = {},
): TerroirCtx => ({
	engine,
	pack,
	cover: null,
	style: styleOf(),
	mode: "overlay",
	w: W,
	h: H,
	frame: 1,
	uncertain: false,
	takenAt: null,
	stageEl: null,
	...over,
});

describe("projectGeo", () => {
	const { engine } = makeEngine();
	it("projects a point ahead onto the stage, centred horizontally, and reports range", () => {
		const p = at(3000);
		const q = projectGeo(engine, p.lat, p.lon, 1020, W, H);
		expect(q).not.toBeNull();
		expect(q?.x).toBeCloseTo(W / 2, 0);
		expect(q?.dist).toBeCloseTo(Math.hypot(3000, 1500 - 0), -1);
		expect(q?.visible).toBe(true);
	});
	it("returns null behind the camera and off the image beyond the margin", () => {
		const b = at(-3000);
		expect(projectGeo(engine, b.lat, b.lon, 1020, W, H)).toBeNull();
		const side = at(3000, 6000);
		expect(projectGeo(engine, side.lat, side.lon, 1020, W, H)).toBeNull();
		// a wide margin lets the same point through
		expect(
			projectGeo(engine, side.lat, side.lon, 1020, W, H, { margin: 5 }),
		).not.toBeNull();
	});
	it("liftM raises the point on screen", () => {
		const p = at(3000);
		const a = projectGeo(engine, p.lat, p.lon, 1020, W, H);
		const b = projectGeo(engine, p.lat, p.lon, 1020, W, H, { liftM: 200 });
		expect((b?.y ?? 0) < (a?.y ?? 0)).toBe(true);
	});
	it("flags a point hidden when nearer terrain is in front of it", () => {
		const walled = makeEngine({ hideBelowV: 0 }).engine;
		const p = at(3000);
		expect(projectGeo(walled, p.lat, p.lon, 1020, W, H)?.visible).toBe(false);
		expect(
			projectGeo(walled, p.lat, p.lon, 1020, W, H, { occlusionTolM: 1e9 })
				?.visible,
		).toBe(true);
	});
});

describe("groundAt", () => {
	it("recovers the ground height of a visible point and caches it per engine", () => {
		const { engine, sampleAt } = makeEngine();
		const p = at(3000);
		const z = groundAt(engine, p.lat, p.lon, W, H);
		expect(z).not.toBeNull();
		expect(Math.abs((z ?? 0) - 1020)).toBeLessThanOrEqual(60);
		const calls = sampleAt.mock.calls.length;
		expect(groundAt(engine, p.lat, p.lon, W, H)).toBe(z);
		expect(sampleAt.mock.calls.length).toBe(calls);
	});
	it("is null when the point is off screen or hidden", () => {
		const { engine } = makeEngine();
		const behind = at(-3000);
		expect(groundAt(engine, behind.lat, behind.lon, W, H)).toBeNull();
		const walled = makeEngine({ hideBelowV: 0 }).engine;
		const p = at(3000);
		expect(groundAt(walled, p.lat, p.lon, W, H)).toBeNull();
	});
});

describe("placeNames", () => {
	const names = [
		name("Chaletalp", "alp", 2500, -400),
		name("Hüttli", "hut", 3500, 600),
		name("Sattel", "pass", 4500, -800),
		name("Chrinne", "valley", 3000, 0, { ele: null }),
		name("Dörfli", "village", 5000, 900),
		name("Behind", "hamlet", -3000, 0),
	];
	const { engine } = makeEngine();

	it("returns nothing without a pack or before the geometry is ready", () => {
		expect(
			placeNames(ctxOf(engine, null), { prev: new Set() }, [], "t"),
		).toEqual([]);
		const notReady = makeEngine({ ready: false }).engine;
		expect(
			placeNames(ctxOf(notReady, packOf(names)), { prev: new Set() }, [], "t"),
		).toEqual([]);
	});
	it("places visible names inside the stage without overlapping, and drops the one behind", () => {
		const state = { prev: new Set<string>() };
		const items = placeNames(ctxOf(engine, packOf(names)), state, [], "t");
		const texts = items.map((i) => i.text);
		expect(texts).toContain("Chaletalp");
		expect(texts).toContain("Hüttli");
		expect(texts).not.toContain("Behind");
		for (const it of items) {
			expect(it.rect.x0).toBeGreaterThanOrEqual(0);
			expect(it.rect.x1).toBeLessThanOrEqual(W);
			expect(it.rect.y0).toBeGreaterThanOrEqual(0);
			expect(it.rect.y1).toBeLessThanOrEqual(H);
			expect(it.opacity).toBeGreaterThan(0);
			expect(it.distKm).toBeGreaterThan(0);
		}
		for (let i = 0; i < items.length; i++)
			for (let j = i + 1; j < items.length; j++) {
				const a = items[i].rect;
				const b = items[j].rect;
				expect(a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1).toBe(
					false,
				);
			}
		// hysteresis memory: the placed ids are remembered
		expect([...state.prev].sort()).toEqual(items.map((i) => i.id).sort());
		// glyph classes carry a glyph, text classes do not
		expect(items.find((i) => i.text === "Hüttli")?.glyph?.kind).toBe("hut");
		expect(items.find((i) => i.text === "Chaletalp")?.glyph).toBeUndefined();
	});
	it("honours maxLabels and a zero cap", () => {
		const two = placeNames(
			ctxOf(engine, packOf(names), {
				style: styleOf({
					terroir: {
						names: { on: true, reach: "all", language: "local", maxLabels: 2 },
					},
				}),
			}),
			{ prev: new Set() },
			[],
			"t",
		);
		expect(two).toHaveLength(2);
		const none = placeNames(
			ctxOf(engine, packOf(names), {
				style: styleOf({
					terroir: {
						names: { on: true, reach: "all", language: "local", maxLabels: 0 },
					},
				}),
			}),
			{ prev: new Set() },
			[],
			"t",
		);
		expect(none).toEqual([]);
	});
	it("reach 'near' drops a village beyond 15 km and keeps one inside", () => {
		const far = [
			name("Ferndorf", "village", 20000),
			name("Nahdorf", "village", 6000),
		];
		const style = styleOf({
			terroir: {
				names: { on: true, reach: "near", language: "local", maxLabels: 20 },
			},
		});
		const out = placeNames(
			ctxOf(engine, packOf(far), { style }),
			{ prev: new Set() },
			[],
			"t",
		);
		expect(out.map((i) => i.text)).toEqual(["Nahdorf"]);
	});
	it("an obstacle rect blocks the labels under it", () => {
		const free = placeNames(
			ctxOf(engine, packOf([names[0]])),
			{ prev: new Set() },
			[],
			"t",
		);
		expect(free).toHaveLength(1);
		const wall = { x0: 0, y0: 0, x1: W, y1: H };
		expect(
			placeNames(
				ctxOf(engine, packOf([names[0]])),
				{ prev: new Set() },
				[wall],
				"t",
			),
		).toEqual([]);
	});
	it("drops a name the engine already labels as a peak", () => {
		const p = at(3500);
		const peak: PeakLabel = {
			name: "Hochstock",
			ele: 1020,
			u: 0.5,
			v: 0.5,
			distKm: 3.5,
			rank: 1,
			visible: true,
			world: frame.fromGeo(p.lat, p.lon, 1020) as [number, number, number],
		};
		const eng = makeEngine({ peaks: [peak] }).engine;
		const pk = packOf([
			name("Hochstock", "peak", 3500),
			name("Andersberg", "peak", 3500, 1500),
		]);
		const out = placeNames(ctxOf(eng, pk), { prev: new Set() }, [], "t");
		expect(out.map((i) => i.text)).toEqual(["Andersberg"]);
	});
	it("a usual-language alt adds a second line only under local+usual", () => {
		const n = packOf([name("Biel", "town", 3000, 0, { alt: "Bienne" })]);
		const plain = placeNames(ctxOf(engine, n), { prev: new Set() }, [], "t");
		expect(plain[0].alt).toBeUndefined();
		const style = styleOf({
			terroir: {
				names: {
					on: true,
					reach: "all",
					language: "local+usual",
					maxLabels: 20,
				},
			},
		});
		const both = placeNames(
			ctxOf(engine, n, { style }),
			{ prev: new Set() },
			[],
			"t",
		);
		expect(both[0].alt).toBe("Bienne");
		expect(both[0].rect.y1 - both[0].rect.y0).toBeGreaterThan(
			plain[0].rect.y1 - plain[0].rect.y0,
		);
	});
	it("uncertainty softens opacity when the style asks for it", () => {
		const n = packOf([name("Ferner", "town", 12000)]);
		const base = placeNames(ctxOf(engine, n), { prev: new Set() }, [], "t")[0];
		const soft = placeNames(
			ctxOf(engine, n, {
				uncertain: true,
				style: styleOf({
					terroir: {
						uncertainty: true,
						names: { on: true, reach: "all", language: "local", maxLabels: 20 },
					},
				}),
			}),
			{ prev: new Set() },
			[],
			"t",
		)[0];
		expect(soft.opacity).toBeLessThan(base.opacity);
	});
	it("names a big lake on its visible water surface (cover cluster)", () => {
		const lake = name("Seeli", "lake", 3000, 0, { ele: 1020, areaKm2: 5 });
		const glacier = name("Gletscher", "glacier", 4000, 0, {
			ele: 1020,
			areaKm2: 5,
		});
		const cover = makeGrid(
			[7, 46, 8.5, 47.5],
			2,
			2,
			Uint8Array.from([12, 12, 12, 12]),
		);
		const out = placeNames(
			ctxOf(engine, packOf([lake, glacier]), { cover }),
			{ prev: new Set() },
			[],
			"t",
		);
		expect(out.map((i) => i.text)).toContain("Seeli");
		// no ice cover under the glacier: it is skipped
		expect(out.map((i) => i.text)).not.toContain("Gletscher");
	});
	it("places a line feature's name along a projected path", () => {
		const line = Array.from({ length: 12 }, (_, k) => {
			const q = at(2000 + k * 250, -500 + k * 90);
			return [q.lon, q.lat] as [number, number];
		});
		const river = name("Ürbe", "river", 2000, 0, { ele: null, line });
		const out = placeNames(
			ctxOf(engine, packOf([river])),
			{ prev: new Set() },
			[],
			"pfx",
		);
		expect(out).toHaveLength(1);
		expect(out[0].path?.startsWith("pfx-0|M")).toBe(true);
	});
});

describe("peakLabelRects", () => {
	it("is empty without a root or origin, and converts DOM rects to origin-relative", () => {
		expect(peakLabelRects(null, null)).toEqual([]);
		const box = (l: number, t: number, w: number, h: number) => ({
			getBoundingClientRect: () => ({
				left: l,
				top: t,
				right: l + w,
				bottom: t + h,
				width: w,
				height: h,
			}),
		});
		const root = {
			querySelectorAll: () => [box(110, 220, 40, 12), box(0, 0, 0, 0)],
		} as unknown as ParentNode;
		const origin = { left: 100, top: 200 } as DOMRect;
		expect(peakLabelRects(root, origin)).toEqual([
			{ x0: 10, y0: 20, x1: 50, y1: 32 },
		]);
	});
});
