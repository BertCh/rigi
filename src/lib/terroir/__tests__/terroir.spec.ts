// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it } from "vitest";
import { seededRandom, uniform } from "#/test/helpers";
import {
	CONTOUR_INK,
	COVER_CLASSES,
	coverInfo,
	NAME_TYPO,
	peakTier,
} from "../classes";
import {
	HATCH_GLSL,
	HATCH_RAMP_DEG,
	HATCH_ROCK_DEG,
	HATCH_SCREE_DEG,
	HATCH_WGSL,
} from "../hatch";
import {
	HATCH_LK,
	lkhHachure,
	lkhHash,
	lkhOctave,
	lkhStroke,
	lkhStrokes,
} from "../hatch-lk";
import { inBBox, makeGrid, packCredit, packUrl } from "../pack";
import {
	patternCoverage,
	patternIntegral,
	patternStripe,
	TERROIR_PATTERN_PARAMS,
} from "../pattern";
import type { NameClass, TerroirPack } from "../types";

const NAME_CLASSES: NameClass[] = [
	"peak-major",
	"peak",
	"peak-minor",
	"ridge",
	"massif",
	"pass",
	"glacier",
	"lake",
	"river",
	"waterfall",
	"valley",
	"region",
	"city",
	"town",
	"village",
	"hamlet",
	"alp",
	"hut",
	"field",
	"lift",
	"other",
];

describe("cover classes", () => {
	it("are indexed by id with unique keys and valid colours", () => {
		expect(COVER_CLASSES).toHaveLength(15);
		COVER_CLASSES.forEach((c, i) => {
			expect(c.id).toBe(i);
			expect(c.color).toMatch(/^#[0-9a-f]{6}$/);
			expect(CONTOUR_INK[c.ink]).toBeDefined();
		});
		expect(new Set(COVER_CLASSES.map((c) => c.key)).size).toBe(15);
		expect(new Set(COVER_CLASSES.map((c) => c.label)).size).toBe(15);
	});
	it("follows the Swiss three-colour contour rule", () => {
		for (const k of ["glacier", "firn", "water"])
			expect(COVER_CLASSES.find((c) => c.key === k)?.ink).toBe("ice");
		for (const k of ["rock", "scree"])
			expect(COVER_CLASSES.find((c) => c.key === k)?.ink).toBe("rock");
	});
	it("coverInfo falls back to no-data for unknown ids", () => {
		expect(coverInfo(3).key).toBe("rock");
		expect(coverInfo(99).key).toBe("none");
		expect(coverInfo(-1).key).toBe("none");
	});
});

describe("name typography", () => {
	it("has a row for every NameClass", () => {
		expect(Object.keys(NAME_TYPO).sort()).toEqual([...NAME_CLASSES].sort());
	});
	it("has sane values per class", () => {
		for (const c of NAME_CLASSES) {
			const t = NAME_TYPO[c];
			expect(t.size).toBeGreaterThan(0);
			expect(t.nearReachM).toBeGreaterThan(0);
			expect(t.color).toMatch(/^#[0-9a-f]{6}$/);
			expect([100, 200, 300, 400, 500, 600, 700, 800, 900]).toContain(t.weight);
		}
	});
	it("ranks major peaks above minor ones for placement", () => {
		expect(NAME_TYPO["peak-major"].priority).toBeGreaterThan(
			NAME_TYPO.peak.priority,
		);
		expect(NAME_TYPO.peak.priority).toBeGreaterThan(
			NAME_TYPO["peak-minor"].priority,
		);
	});
});

describe("peakTier", () => {
	it("uses prominence thresholds 600 and 150 (inclusive)", () => {
		expect(peakTier(600, 1000)).toBe("peak-major");
		expect(peakTier(599.9, 4800)).toBe("peak");
		expect(peakTier(150, null)).toBe("peak");
		expect(peakTier(149.9, 4800)).toBe("peak-minor");
		expect(peakTier(0, null)).toBe("peak-minor");
	});
	it("falls back to elevation when prominence is unknown or not finite", () => {
		for (const p of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(peakTier(p, 3900)).toBe("peak-major");
			expect(peakTier(p, 3899)).toBe("peak");
			expect(peakTier(p, null)).toBe("peak");
		}
	});
});

describe("pack grid", () => {
	// 4 wide x 2 high over [0,0,4,2]; row 0 = north
	const classes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
	const grid = makeGrid([0, 0, 4, 2], 4, 2, classes);
	it("looks up cells with row 0 at the north edge", () => {
		expect(grid.at(1.9, 0.5)).toBe(1);
		expect(grid.at(1.9, 3.5)).toBe(4);
		expect(grid.at(0.1, 0.5)).toBe(5);
		expect(grid.at(0.1, 3.5)).toBe(8);
	});
	it("clamps the east and north edges into the last cell", () => {
		expect(grid.at(2, 4)).toBe(4);
		expect(grid.at(0, 0)).toBe(5);
	});
	it("returns 0 outside the bbox", () => {
		expect(grid.at(-0.001, 1)).toBe(0);
		expect(grid.at(2.001, 1)).toBe(0);
		expect(grid.at(1, -0.001)).toBe(0);
		expect(grid.at(1, 4.001)).toBe(0);
	});
	it("inBBox is inclusive on every edge", () => {
		expect(inBBox([0, 0, 4, 2], 0, 0)).toBe(true);
		expect(inBBox([0, 0, 4, 2], 2, 4)).toBe(true);
		expect(inBBox([0, 0, 4, 2], 2.0001, 4)).toBe(false);
	});
});

describe("pack helpers", () => {
	const pack = {
		v: 1,
		id: "niederhorn",
		name: "x",
		bbox: [0, 0, 1, 1],
		created: "2026-01-01",
		sources: [
			{ id: "a", label: "A", licence: "OGD", url: "u", credit: "swisstopo" },
			{
				id: "b",
				label: "B",
				licence: "ODbL",
				url: "u",
				credit: "OpenStreetMap",
			},
		],
		names: [],
		glaciers: [],
		cover: null,
		lithology: null,
	} as TerroirPack;
	it("joins every source credit, keeping sources separate", () => {
		expect(packCredit(pack)).toBe("swisstopo · OpenStreetMap");
		expect(packCredit({ ...pack, sources: [] })).toBe("");
	});
	it("resolves asset urls by loaded path, else pack id", () => {
		expect(packUrl(pack, "cover.png")).toBe("/terroir/niederhorn/cover.png");
		expect(
			packUrl({ ...pack, _path: "ch/bo" } as TerroirPack, "cover.png"),
		).toBe("/terroir/ch/bo/cover.png");
	});
});

describe("findPack", () => {
	it("picks the smallest overlapping bbox and tolerates a missing index", async () => {
		const { vi } = await import("vitest");
		vi.resetModules();
		const index = {
			v: 1,
			packs: [
				{ id: "big", name: "Big", bbox: [0, 0, 10, 10], path: "big" },
				{ id: "small", name: "Small", bbox: [4, 4, 6, 6], path: "small" },
			],
		};
		const fetchMock = vi.fn(async (url: string) => {
			if (url.endsWith("index.json"))
				return { ok: true, json: async () => index };
			const id = url.split("/")[2];
			return { ok: true, json: async () => ({ v: 1, id }) };
		});
		vi.stubGlobal("fetch", fetchMock);
		const mod = await import("../pack");
		expect((await mod.findPack(5, 5))?.id).toBe("small");
		expect((await mod.findPack(1, 1))?.id).toBe("big");
		expect(await mod.findPack(50, 50)).toBeNull();
		vi.resetModules();
		vi.stubGlobal("fetch", async () => {
			throw new Error("offline");
		});
		const mod2 = await import("../pack");
		expect(await mod2.findPack(5, 5)).toBeNull();
		vi.unstubAllGlobals();
	});
});

describe("pattern CPU mirror", () => {
	it("patternIntegral accumulates width per period", () => {
		expect(patternIntegral(0, 0.3)).toBe(0);
		expect(patternIntegral(0.2, 0.3)).toBeCloseTo(0.2, 12);
		expect(patternIntegral(0.7, 0.3)).toBeCloseTo(0.3, 12);
		expect(patternIntegral(3.5, 0.3)).toBeCloseTo(0.9 + 0.3, 12);
	});
	it("a wide footprint averages the stripe to its width", () => {
		for (const w of [0.1, 0.35, 0.6])
			for (let c = 0; c < 1; c += 0.13)
				expect(patternStripe(c, 20, w)).toBeCloseTo(w, 1);
	});
	it("a narrow footprint is fully inside or outside the pulse", () => {
		// pulse centred on integer phases: phase 0 is inside, phase 0.5 outside (width 0.2)
		expect(patternStripe(0, 0.001, 0.2)).toBeCloseTo(1, 6);
		expect(patternStripe(0.5, 0.001, 0.2)).toBeCloseTo(0, 6);
	});
	it("stays within [0, 1] for random inputs", () => {
		const rand = seededRandom(7);
		for (let i = 0; i < 500; i++) {
			const v = patternStripe(
				uniform(rand, -50, 50),
				uniform(rand, 0, 5),
				uniform(rand, 0, 1),
			);
			expect(v).toBeGreaterThanOrEqual(0);
			expect(v).toBeLessThanOrEqual(1);
			for (const kind of ["hatch", "dots"] as const) {
				const c = patternCoverage(
					kind,
					[uniform(rand, -100, 100), uniform(rand, -100, 100)],
					[uniform(rand, 0, 20), uniform(rand, 0, 20)],
					uniform(rand, 1, 40),
					uniform(rand, 0, 1),
					uniform(rand, 0, 6.28),
				);
				expect(c).toBeGreaterThanOrEqual(0);
				expect(c).toBeLessThanOrEqual(1);
			}
		}
	});
	it("zero width draws nothing", () => {
		expect(patternCoverage("hatch", [1, 2], [0.1, 0.1], 5, 0, 0.3)).toBe(0);
		expect(patternCoverage("dots", [1, 2], [0.1, 0.1], 5, -1, 0.3)).toBe(0);
	});
	it("rotating the field and the sample point together preserves coverage", () => {
		const a = 0.7;
		const p: [number, number] = [13.3, -4.1];
		const rot = (x: number, y: number): [number, number] => [
			x * Math.cos(a) - y * Math.sin(a),
			x * Math.sin(a) + y * Math.cos(a),
		];
		// hatch along x at angle 0 vs the same field rotated by a, sampled at the rotated point
		const base = patternCoverage("hatch", p, [0.01, 0.01], 5, 0.3, 0);
		const turned = patternCoverage("hatch", rot(...p), [0.01, 0.01], 5, 0.3, a);
		expect(turned).toBeCloseTo(base, 6);
	});
	it("a far-away footprint converges to the mean dot coverage", () => {
		const w = 0.45;
		const c = patternCoverage("dots", [3.2, 1.1], [500, 500], 6, w, 0);
		expect(c).toBeCloseTo(Math.PI * (w / 2) ** 2, 3);
	});
	it("class parameters are sensible", () => {
		const P = TERROIR_PATTERN_PARAMS;
		expect(P.rock.widthShade).toBeGreaterThan(P.rock.widthLit);
		for (const s of [P.scree.strength, P.rock.strength, P.glacier.strength]) {
			expect(s).toBeGreaterThan(0);
			expect(s).toBeLessThanOrEqual(1);
		}
	});
});

describe("slope hatch constants", () => {
	it("order the scree band below the rock threshold", () => {
		expect(HATCH_SCREE_DEG).toBeLessThan(HATCH_ROCK_DEG);
		expect(HATCH_RAMP_DEG).toBeGreaterThan(0);
	});
	it("bake the same numbers into GLSL and WGSL", () => {
		for (const n of [
			HATCH_ROCK_DEG,
			HATCH_ROCK_DEG + HATCH_RAMP_DEG,
			HATCH_SCREE_DEG,
		]) {
			expect(HATCH_GLSL).toContain(`${n}.0`);
			expect(HATCH_WGSL).toContain(`${n}.0`);
		}
		expect(HATCH_GLSL).not.toContain("NaN");
		expect(HATCH_WGSL).not.toContain("undefined");
	});
});

describe("Landeskarte hachure kernel", () => {
	it("hash is deterministic and in [0, 1)", () => {
		const rand = seededRandom(3);
		for (let i = 0; i < 300; i++) {
			const cx = Math.floor(uniform(rand, -1e4, 1e4));
			const cy = Math.floor(uniform(rand, -1e4, 1e4));
			const h = lkhHash(cx, cy, 11);
			expect(h).toBe(lkhHash(cx, cy, 11));
			expect(h).toBeGreaterThanOrEqual(0);
			expect(h).toBeLessThan(1);
		}
		expect(lkhHash(1, 2, 11)).not.toBe(lkhHash(1, 2, 12));
		expect(lkhHash(1, 2, 11)).not.toBe(lkhHash(2, 1, 11));
	});
	it("hash is roughly uniform", () => {
		let sum = 0;
		const n = 4000;
		for (let i = 0; i < n; i++) sum += lkhHash(i, i * 7 + 1, 11);
		expect(sum / n).toBeGreaterThan(0.47);
		expect(sum / n).toBeLessThan(0.53);
	});
	it("octave picks a power-of-two fine period and a blend weight in [0, 1)", () => {
		expect(lkhOctave(1, 1.5)).toEqual([1.5, 0]);
		expect(lkhOctave(3, 1.5)).toEqual([3, 0]);
		const [period, w] = lkhOctave(4.5, 1.5);
		expect(period).toBe(3);
		expect(w).toBeCloseTo(Math.log2(3) - 1, 12);
		const rand = seededRandom(5);
		for (let i = 0; i < 200; i++) {
			const [pp, ww] = lkhOctave(uniform(rand, 0.1, 500), 1.5);
			expect(pp).toBeGreaterThanOrEqual(1.5);
			expect(ww).toBeGreaterThanOrEqual(0);
			expect(ww).toBeLessThan(1);
			expect(Math.log2(pp / 1.5) % 1).toBe(0);
		}
	});
	it("strokes are bounded in [0, 1], and keepP 0 drops everything", () => {
		const rand = seededRandom(9);
		for (let i = 0; i < 400; i++) {
			const x = uniform(rand, -500, 500);
			const y = uniform(rand, -500, 500);
			const fall = uniform(rand, 0, 6.28);
			const s = lkhStroke(x, y, fall, 4, 1, 1, 0.7, 11);
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThanOrEqual(1);
			expect(lkhStroke(x, y, fall, 4, 1, 1, 0, 11)).toBe(0);
			const m = lkhStrokes(x, y, fall, 3.5, 2, 0.9, 0.7, 11);
			expect(m).toBeGreaterThanOrEqual(0);
			expect(m).toBeLessThanOrEqual(1 + 1e-12);
		}
	});
	it("a stroke runs along the fall line and is absent half a period away", () => {
		const period = 4;
		const fall = 0; // fall line = +x, so strokes are lines of constant y
		let inked = 0;
		for (let x = 0; x < 40; x += 0.5)
			if (lkhStroke(x, 0.01, fall, period, 1, 1, 1, 11) > 0.5) inked++;
		expect(inked).toBeGreaterThan(20);
		for (let x = 0; x < 40; x += 0.5)
			expect(lkhStroke(x, period / 2, fall, period, 1, 1, 1, 11)).toBe(0);
	});
	it("hachure is bounded, and darker on the shadow side than the lit side overall", () => {
		let shade = 0;
		let lit = 0;
		for (let i = 0; i < 40; i++)
			for (let j = 0; j < 40; j++) {
				const x = i * 0.9;
				const y = j * 0.9;
				const a = lkhHachure(x, y, 0.4, 1, 0);
				const b = lkhHachure(x, y, 0.4, 1, 1);
				expect(a).toBeGreaterThanOrEqual(0);
				expect(b).toBeGreaterThanOrEqual(0);
				shade += a;
				lit += b;
			}
		expect(shade).toBeGreaterThan(lit);
	});
	it("constants are positive and the lit ramp is ordered", () => {
		expect(HATCH_LK.LIT_LO).toBeLessThan(HATCH_LK.LIT_HI);
		expect(HATCH_LK.PERIOD_SHADE_PX).toBeLessThan(HATCH_LK.PERIOD_LIT_PX);
		expect(HATCH_LK.KEEP).toBeGreaterThan(0);
		expect(HATCH_LK.KEEP).toBeLessThanOrEqual(1);
	});
});
