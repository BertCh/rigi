// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { DEG } from "#/lib/geodesy";
import { seededRandom } from "#/test/helpers";
import { type CameraX, IDENTITY_INTRINSICS, projectX } from "../../core";
import {
	buildGeomBuffer,
	chamferAt,
	consistencyFilter,
	defaultDemSigmaM,
	extractCues,
	focal1600,
	lakesFromOverpass,
	type MatchedCue,
	maskEdges,
	matchEdgeCues,
	mirrorAxis,
	occludingContourCues,
	orientedDT,
	photoEdgesFromRGBA,
	shoreDistance,
	stitchRings,
	thinEdges,
	waterCuesX,
} from "../index";

const W = 400;
const H = 300;
const cam: CameraX = {
	pose: { yaw: 0, pitch: 0, roll: 0, vfov: 45 },
	eye: [0, 0, 0],
	aspect: W / H,
	intr: { ...IDENTITY_INTRINSICS },
};
const T = Math.tan(22.5 * DEG);
const vOfTan = (t: number) => 0.5 - t / T / 2;
const frame = { alt0: 0, rEff: Number.POSITIVE_INFINITY };

/** Box-filtered horizontal step image: `top` above the row, `bottom` below. */
const stepImage = (
	rowOf: (x: number) => number,
	w: number,
	h: number,
	top: number,
	bottom: number,
) => {
	const d = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const a = Math.max(0, Math.min(1, y + 0.5 - rowOf(x) + 0.5));
			const i = (y * w + x) * 4;
			d[i] = d[i + 1] = d[i + 2] = top * (1 - a) + bottom * a;
			d[i + 3] = 255;
		}
	return d;
};

// plane 10 m below the eye, a 60 m block at n in [1000, 1050], plateau 400 m beyond 3 km
const blockHeight = (_e: number, n: number) =>
	n >= 1000 && n <= 1050 ? 60 : n > 3000 ? 400 : -10;
// the block's top edge photographed 3 px lower than predicted (1600x1200, built once: it is slow)
let blockEdgesMemo: ReturnType<typeof photoEdgesFromRGBA> | undefined;
const blockEdges = () => {
	const Wp = 1600;
	const Hp = 1200;
	const rowTrue = vOfTan(60 / 1000) * Hp + 3;
	blockEdgesMemo ??= photoEdgesFromRGBA(
		stepImage(() => rowTrue, Wp, Hp, 200, 90),
		Wp,
		Hp,
	);
	return blockEdgesMemo;
};
vi.setConfig({ testTimeout: 30_000 });

const geom = buildGeomBuffer(cam, W, H, blockHeight, { frame });

describe("focal1600", () => {
	it("matches the pinhole formula and scales with fScale", () => {
		const f = focal1600(cam);
		expect(f).toBeCloseTo(600 / T, 6);
		expect(
			focal1600({ ...cam, intr: { ...cam.intr, fScale: 1.1 } }),
		).toBeCloseTo(f * 1.1, 6);
	});
	it("uses the short side for portrait frames", () => {
		const portrait = { ...cam, aspect: 0.75 };
		expect(focal1600(portrait)).toBeCloseTo(800 / T, 6);
	});
});

describe("defaultDemSigmaM", () => {
	it("grows linearly with distance", () => {
		expect(defaultDemSigmaM(0)).toBe(3);
		expect(defaultDemSigmaM(1000)).toBeCloseTo(4, 12);
	});
});

describe("buildGeomBuffer", () => {
	it("hits the ground plane at the geometric distance and reprojects to the pixel", () => {
		let maxRel = 0;
		let maxPx = 0;
		let n = 0;
		for (let y = 200; y < H; y += 7)
			for (let x = 3; x < W; x += 11) {
				const k = y * W + x;
				if (Math.abs(geom.xyz[3 * k + 2] + 10) > 1e-3) continue;
				n++;
				const t = (0.5 - (y + 0.5) / H) * 2 * T;
				const dTrue = 10 / -t;
				maxRel = Math.max(
					maxRel,
					Math.abs(geom.xyz[3 * k + 1] - dTrue) / dTrue,
				);
				const p = projectX(cam, [geom.xyz[3 * k], geom.xyz[3 * k + 1], -10]);
				expect(p).not.toBeNull();
				if (p)
					maxPx = Math.max(
						maxPx,
						Math.hypot(
							(p.u - (x + 0.5) / W) * 1600,
							(p.v - (y + 0.5) / H) * 1200,
						),
					);
			}
		expect(n).toBeGreaterThan(100);
		expect(maxRel).toBeLessThan(5e-3);
		expect(maxPx).toBeLessThan(0.3);
	});

	it("marks rays above the horizon as sky with infinite range and NaN xyz", () => {
		const k = 5 * W + 200; // top row
		expect(geom.sky[k]).toBe(1);
		expect(geom.range[k]).toBe(Number.POSITIVE_INFINITY);
		expect(Number.isNaN(geom.xyz[3 * k])).toBe(true);
	});

	it("range equals 3-D distance to xyz for non-sky pixels", () => {
		for (const [x, y] of [
			[50, 250],
			[200, 290],
			[350, 270],
		]) {
			const k = y * W + x;
			expect(geom.sky[k]).toBe(0);
			const d = Math.hypot(
				geom.xyz[3 * k],
				geom.xyz[3 * k + 1],
				geom.xyz[3 * k + 2],
			);
			expect(geom.range[k]).toBeCloseTo(d, 1);
		}
	});

	it("is all sky over a void (NaN heights)", () => {
		const g = buildGeomBuffer(cam, 20, 15, () => Number.NaN);
		expect(g.sky.every((s) => s === 1)).toBe(true);
	});

	it("cast() agrees with the buffer at a pixel centre and returns null on sky", () => {
		expect(geom.cast).toBeDefined();
		const x = 200;
		const y = 280;
		const hit = geom.cast?.((x + 0.5) / W, (y + 0.5) / H);
		const k = y * W + x;
		expect(hit).not.toBeNull();
		expect(hit?.range).toBeCloseTo(geom.range[k], -1);
		expect(geom.cast?.(0.5, 0.01)).toBeNull();
	});

	it("rotates with yaw: a wall to the east is hit when yawing east", () => {
		const east = { ...cam, pose: { ...cam.pose, yaw: 90 } };
		const g = buildGeomBuffer(east, 40, 30, (e) => (e > 500 ? 1000 : -10), {
			azStepDeg: 0.1,
		});
		const k = 15 * 40 + 20;
		expect(g.sky[k]).toBe(0);
		expect(g.xyz[3 * k]).toBeGreaterThan(400);
		expect(Math.abs(g.xyz[3 * k + 1])).toBeLessThan(80);
	});
});

describe("occludingContourCues", () => {
	const cues = occludingContourCues(geom, cam, { stepPx: 16 });

	it("places the block's top edge at its true image row with an upward normal", () => {
		const vTrue = vOfTan(60 / 1000);
		expect(cues.length).toBeGreaterThan(10);
		const errs = cues
			.map((c) => Math.abs(c.v - vTrue) * 1200)
			.sort((a, b) => a - b);
		expect(errs[errs.length >> 1]).toBeLessThan(1);
		for (const c of cues) {
			expect(c.kind).toBe("edge");
			if (c.kind === "edge") expect(c.nv).toBeLessThan(-0.9);
		}
	});

	it("reports cue depth and a sigma that is at least one pixel", () => {
		for (const c of cues) {
			if (c.kind !== "edge") continue;
			expect(c.depthM).toBeGreaterThan(900);
			expect(c.depthM).toBeLessThan(1500);
			expect(c.sigmaPx).toBeGreaterThanOrEqual(1);
			expect(c.source).toBe("contour");
		}
	});

	it("finds nothing on a flat plane", () => {
		const g = buildGeomBuffer(cam, W, H, () => -10, { frame });
		expect(occludingContourCues(g, cam)).toEqual([]);
	});

	it("drops contours shorter than minLenPx", () => {
		expect(occludingContourCues(geom, cam, { minLenPx: 5000 })).toEqual([]);
	});

	it("a coarser stepPx yields fewer samples", () => {
		const fine = occludingContourCues(geom, cam, { stepPx: 8 });
		const coarse = occludingContourCues(geom, cam, { stepPx: 32 });
		expect(coarse.length).toBeLessThan(fine.length);
	});
});

describe("photoEdgesFromRGBA", () => {
	it("gives a horizontal edge a vertical normal pointing dark to bright", () => {
		const w = 40;
		const h = 40;
		const e = photoEdgesFromRGBA(
			stepImage(() => 20, w, h, 50, 200),
			w,
			h,
		);
		const k = 20 * w + 20;
		expect(e.mag[k]).toBeGreaterThan(0.05);
		expect(Math.cos(e.ori[k])).toBeCloseTo(0, 1);
		expect(Math.sin(e.ori[k])).toBeGreaterThan(0.9); // y down: dark above, bright below
		expect(e.mag[5 * w + 20]).toBeLessThan(1e-3);
	});

	it("flips orientation when polarity flips", () => {
		const w = 40;
		const h = 40;
		const e = photoEdgesFromRGBA(
			stepImage(() => 20, w, h, 200, 50),
			w,
			h,
		);
		expect(Math.sin(e.ori[20 * w + 20])).toBeLessThan(-0.9);
	});

	it("is zero on a flat image", () => {
		const e = photoEdgesFromRGBA(
			new Uint8ClampedArray(30 * 30 * 4).fill(128),
			30,
			30,
		);
		expect(Math.max(...e.mag)).toBeLessThan(1e-6);
	});
});

describe("matchEdgeCues", () => {
	it("measures a 3 px vertical offset as a +3 px residual with confidence", () => {
		const cues = occludingContourCues(geom, cam, { stepPx: 16 });
		const edges = blockEdges();
		const m = matchEdgeCues(cues, edges, { searchPx: 12 });
		expect(m.length).toBeGreaterThan(0.8 * cues.length);
		const res = m.map((c) => c.residualPx).sort((a, b) => a - b);
		expect(Math.abs(res[res.length >> 1] - 3)).toBeLessThan(0.5);
		expect(m[0].conf).toBeGreaterThan(0.3);
	});

	it("returns no matches on a featureless photo", () => {
		const cues = occludingContourCues(geom, cam, { stepPx: 16 });
		const edges = photoEdgesFromRGBA(
			new Uint8ClampedArray(1600 * 1200 * 4).fill(100),
			1600,
			1200,
		);
		expect(matchEdgeCues(cues, edges).length).toBe(0);
	});

	it("maskEdges removes matches under the foreground mask", () => {
		const cues = occludingContourCues(geom, cam, { stepPx: 16 });
		const edges = maskEdges(
			blockEdges(),
			{ width: 2, height: 1, data: [255, 0] },
			255,
		);
		const mm = matchEdgeCues(cues, edges);
		expect(mm.length).toBeGreaterThan(0);
		expect(mm.every((c) => c.u > 0.5)).toBe(true);
	});
});

describe("thinEdges / orientedDT / chamferAt", () => {
	it("chamfer distance equals brute-force distance to the nearest same-orientation edge point", () => {
		const Wp = 80;
		const Hp = 60;
		const rnd = seededRandom(7);
		const mag = new Float32Array(Wp * Hp);
		const ori = new Float32Array(Wp * Hp);
		for (let i = 0; i < 25; i++) {
			const x = 3 + Math.floor(rnd() * (Wp - 6));
			const y = 3 + Math.floor(rnd() * (Hp - 6));
			mag[y * Wp + x] = 1;
			ori[y * Wp + x] = rnd() < 0.5 ? 0 : Math.PI / 2;
		}
		const te = thinEdges({ w: Wp, h: Hp, mag, ori }, { thresh: 0.5 });
		expect(te.x.length).toBeGreaterThan(0);
		const dt = orientedDT(te, { bins: 12, truncPx: 40 });
		let maxErr = 0;
		for (let y = 0; y < Hp; y += 3)
			for (let x = 0; x < Wp; x += 3)
				for (const o of [0, Math.PI / 2]) {
					let best = Number.POSITIVE_INFINITY;
					for (let i = 0; i < te.x.length; i++) {
						let d = Math.abs((te.ori[i] - o) % Math.PI);
						if (d > Math.PI / 2) d = Math.PI - d;
						if (d > 0.1) continue;
						best = Math.min(
							best,
							Math.hypot(Math.floor(te.x[i]) - x, Math.floor(te.y[i]) - y),
						);
					}
					maxErr = Math.max(
						maxErr,
						Math.abs(Math.min(best, 40) - chamferAt(dt, x, y, o, 5)),
					);
				}
		expect(maxErr).toBeLessThan(0.15);
	});
});

describe("consistencyFilter", () => {
	const mk = (
		u: number,
		v: number,
		residualPx: number,
		depthM = 1000,
	): MatchedCue => ({
		kind: "edge",
		u,
		v,
		nu: 0,
		nv: -1,
		world: [0, 1000, 0],
		depthM,
		sigmaPx: 1,
		source: "contour",
		residualPx,
		conf: 1,
	});

	it("keeps a smooth run of residuals and drops an isolated outlier and an orphan", () => {
		const run = [0, 1, 2, 3, 4].map((i) =>
			mk(0.3 + i * 0.005, 0.5, 2 + 0.1 * i),
		);
		const outlier = mk(0.31, 0.5, 9);
		const orphan = mk(0.9, 0.1, 2);
		const out = consistencyFilter([...run, outlier, orphan], 4 / 3);
		expect(out).toEqual(expect.arrayContaining(run));
		expect(out).not.toContain(outlier);
		expect(out).not.toContain(orphan);
	});

	it("ignores neighbours at very different depth", () => {
		const a = mk(0.5, 0.5, 1, 500);
		const b = mk(0.505, 0.5, 1, 5000);
		const c = mk(0.51, 0.5, 1, 5000);
		expect(consistencyFilter([a, b, c], 1.5, { minNb: 2 })).not.toContain(a);
	});
});

describe("extractCues", () => {
	it("keeps most predicted contours on a matching photo and inflates sigma by confidence", () => {
		const edges = blockEdges();
		const r = extractCues({ geom, cam, edges }, { contour: { stepPx: 16 } });
		expect(r.stats.predicted).toBeGreaterThan(5);
		expect(r.stats.kept).toBeGreaterThan(0.8 * r.stats.predicted);
		expect(r.stats.water).toBe(0);
		for (const c of r.cues) expect(c.sigmaPx).toBeGreaterThan(1);
	});

	it("keeps nothing when the photo has no edges", () => {
		const edges = photoEdgesFromRGBA(
			new Uint8ClampedArray(160 * 120 * 4).fill(90),
			160,
			120,
		);
		const r = extractCues({ geom, cam, edges });
		expect(r.cues).toEqual([]);
		expect(r.stats.kept).toBe(0);
	});
});

describe("water cues", () => {
	const hW = (_e: number, n: number) =>
		n <= 2000 ? -10 : -10 + (n - 2000) * 0.2;
	const camW: CameraX = { ...cam, aspect: 800 / 600 };
	const gW = buildGeomBuffer(camW, 800, 600, hW, { frame });
	const lake = {
		polygon: [
			[-5000, -100],
			[5000, -100],
			[5000, 2000],
			[-5000, 2000],
		] as [number, number][],
		levelM: -10,
	};
	const vTrue = vOfTan(-10 / 2000);
	const Wp = 1600;
	const Hp = 1200;
	const edges = photoEdgesFromRGBA(
		stepImage(() => vTrue * Hp + 2, Wp, Hp, 80, 190),
		Wp,
		Hp,
	);
	const r = waterCuesX(gW, camW, [lake], null, { edges });

	it("predicts the waterline at the true image row", () => {
		expect(r.predicted.length).toBeGreaterThan(5);
		for (const p of r.predicted)
			expect(Math.abs(p.v - vTrue) * 1200).toBeLessThan(1);
	});

	it("level cues measure the 2 px offset and detect water-below polarity", () => {
		const lv = r.cues.filter((c) => c.kind === "level");
		expect(lv.length).toBeGreaterThan(0);
		const res = lv.map((c) => c.residualPx).sort((a, b) => a - b);
		expect(Math.abs(res[res.length >> 1] + 2)).toBeLessThan(0.6);
		expect(r.polarity).toBe(1);
	});

	it("shore cues have near-zero signed distance at the predicted shore", () => {
		const sh = r.cues.filter((c) => c.kind === "shore");
		expect(sh.length).toBeGreaterThan(0);
		for (const c of sh)
			if (c.kind === "shore")
				expect(Math.abs(c.shoreDist(c.world[0], c.world[1]))).toBeLessThan(5);
	});

	it("shoreDistance is negative inside the lake and positive outside", () => {
		const sdf = shoreDistance(lake);
		expect(sdf(0, 1000)).toBeLessThan(-900);
		expect(sdf(0, 2100)).toBeGreaterThan(90);
	});

	it("produces no cues when no lake is in view", () => {
		const far = {
			...lake,
			polygon: lake.polygon.map(([e, n]) => [e + 1e6, n] as [number, number]),
		};
		const out = waterCuesX(gW, camW, [far], null, { edges });
		expect(out.cues).toEqual([]);
	});
});

describe("OSM lake assembly", () => {
	const a = { lat: 0, lon: 0 };
	const b = { lat: 0, lon: 0.01 };
	const c = { lat: 0.01, lon: 0.01 };
	const d = { lat: 0.01, lon: 0 };

	it("stitchRings joins split ways into one closed ring", () => {
		const rings = stitchRings([
			[a, b],
			[c, b],
			[c, d, a],
		]);
		expect(rings).toHaveLength(1);
		expect(rings[0]).toHaveLength(5);
		expect(rings[0][0]).toEqual(rings[0][rings[0].length - 1]);
	});

	it("lakesFromOverpass projects a relation to a lake polygon", () => {
		const lakes = lakesFromOverpass(
			[
				{
					type: "relation",
					id: 1,
					tags: { natural: "water", name: "X" },
					members: [
						{ role: "outer", geometry: [a, b] },
						{ role: "outer", geometry: [c, b] },
						{ role: "outer", geometry: [c, d, a] },
					],
				},
			],
			(lat, lon) => [lon * 111000, lat * 111000],
		);
		expect(lakes).toHaveLength(1);
		const xs = lakes[0].polygon.map((p) => p[0]);
		expect(Math.max(...xs)).toBeCloseTo(1110, 0);
	});
});

describe("mirrorAxis", () => {
	it("recovers the symmetry row of a reflected column profile", () => {
		const w = 20;
		const h = 120;
		const lum = new Float32Array(w * h);
		const axis = 60.25;
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const d = Math.abs(y + 0.5 - axis);
				lum[y * w + x] = 0.5 + 0.3 * Math.sin(d * 0.9) * Math.exp(-d / 30);
			}
		const m = mirrorAxis(lum, w, h, 10, 50, 70, 10);
		expect(m).toBeTruthy();
		expect(Math.abs((m?.y ?? 0) + 0.5 - axis)).toBeLessThanOrEqual(0.5);
		expect(m?.ncc).toBeGreaterThan(0.85);
	});
});
