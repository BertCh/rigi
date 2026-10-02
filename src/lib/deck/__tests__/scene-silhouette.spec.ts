// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import type { EdgeMap } from "../../align";
import { eyeAltitude } from "../../geo/eye-rule";
import { EnuFrame } from "../../geodesy";
import {
	pendingPrograms,
	reviveDevice,
	watchContextLoss,
} from "../device-lost";
import {
	localElevRange,
	nearFadeFor,
	type Peak,
	placePeakLabels,
	type SnappedPeak,
	snapPeaksNear,
} from "../scene";
import {
	rangeIsBlank,
	redrawIfBlank,
	SIL_GROUP,
	SIL_MARGIN,
	scoreFromMask,
	silGroups,
	silhouetteThresholds,
	silMaskWords,
	silNonce,
} from "../silhouette-mask";
import type { TerrainSet, TileMesh } from "../terrain-data";

describe("eyeAltitude / nearFadeFor", () => {
	it("eyeAltitude: GPS altitude unless underground, else DEM + 1.8", () => {
		expect(eyeAltitude(1500, 1000)).toBe(1500);
		expect(eyeAltitude(1000, 1000)).toBeCloseTo(1001.6);
		expect(eyeAltitude(null, 1000)).toBeCloseTo(1001.8);
		expect(eyeAltitude(undefined, 0)).toBeCloseTo(1.8);
	});

	it("nearFadeFor clamps 3x accuracy to [30, 200] in 10s", () => {
		expect(nearFadeFor(undefined)).toBe(60);
		expect(nearFadeFor(1)).toBe(30);
		expect(nearFadeFor(500)).toBe(200);
		expect(nearFadeFor(14)).toBe(40);
	});
});

const frame = new EnuFrame(46.68, 7.85, 0);
const mkTile = (over: Partial<TileMesh>): TileMesh =>
	({
		id: "t",
		key: { z: 10, x: 0, y: 0 },
		distance: 100,
		size: 4,
		sourceZ: 10,
		focus: true,
		seg: 1,
		...over,
	}) as TileMesh;

describe("localElevRange", () => {
	const set = (tiles: TileMesh[]) => ({ tiles }) as unknown as TerrainSet;

	it("defaults when nothing qualifies", () => {
		expect(localElevRange(set([]))).toEqual([400, 4200]);
		expect(
			localElevRange(
				set([
					mkTile({ distance: 30_000, heights: new Float32Array(16).fill(1) }),
				]),
			),
		).toEqual([400, 4200]);
	});

	it("uses focus tiles within 25 km and near tiles within 3 km, and a 500 m minimum span", () => {
		const h1 = new Float32Array(16).fill(1000);
		h1[0] = 900;
		const near = mkTile({ distance: 2000, focus: false, heights: h1 });
		const far = mkTile({
			distance: 20_000,
			focus: false,
			heights: new Float32Array(16).fill(4000),
		});
		const focus = mkTile({
			distance: 10_000,
			focus: true,
			heights: new Float32Array(16).fill(1100),
		});
		const [lo, hi] = localElevRange(set([near, far, focus]));
		expect(lo).toBe(900);
		expect(hi).toBe(1400); // 900 + 500 minimum
		const [, hi2] = localElevRange(
			set([mkTile({ heights: new Float32Array(16).fill(5000) }), near]),
		);
		expect(hi2).toBe(5000);
	});

	it("reads heightStats of a GPU-decoded tile", () => {
		const t = mkTile({
			heights: undefined,
			heightStats: { lo: 0, hi: 0, lo7: 700, hi7: 2200 } as never,
		});
		expect(localElevRange(set([t]))).toEqual([700, 2200]);
	});
});

describe("snapPeaksNear / placePeakLabels", () => {
	const pose = { yaw: 0, pitch: 0, roll: 0, vfov: 40 };
	const eye: [number, number, number] = [0, 0, 1000];
	const north = (m: number) => 46.68 + m / 111_320;
	const terrainFor = (h: number | undefined) => {
		const terrain = {
			frame,
			localMax: vi.fn((la: number, lo: number) =>
				h === undefined ? undefined : { lat: la, lon: lo, h },
			),
		};
		return terrain as unknown as TerrainSet & {
			localMax: ReturnType<typeof vi.fn>;
		};
	};
	const peak = (name: string, dN: number, ele = 2000): Peak => ({
		name,
		lat: north(dN),
		lon: 7.85,
		ele,
		prominence: 300,
	});
	const at = { lat: 46.68, lon: 7.85 };

	it("snaps in-frame peaks, skips too near / too far / outside the frame, and caches", () => {
		const t = terrainFor(2100);
		const peaks = [
			peak("ahead", 3000),
			peak("tooNear", 50),
			peak("tooFar", 200_000),
			{ ...peak("behind", -3000) },
		];
		const cache = new Map<Peak, SnappedPeak | null>();
		const out = snapPeaksNear(t, peaks, at, pose, eye, 1.5, cache);
		expect(out.map((p) => p.name)).toEqual(["ahead"]);
		expect(cache.get(peaks[1])).toBeNull();
		expect(cache.get(peaks[2])).toBeNull();
		expect(cache.has(peaks[3])).toBe(false); // may come into view later
		// a second call does not re-snap
		const calls = t.localMax.mock.calls.length;
		snapPeaksNear(t, peaks, at, pose, eye, 1.5, cache);
		expect(t.localMax.mock.calls.length).toBe(calls);
		// snapped height ends up in ENU z
		expect(out[0].position[2]).toBeCloseTo(
			2100 - (0.87 * 3000 * 3000) / (2 * 6.371e6),
			-1,
		);
	});

	it("snap radius is min(250, 60 + dist*0.004)", () => {
		const t = terrainFor(2000);
		snapPeaksNear(t, [peak("p", 3000)], at, pose, eye, 1.5, new Map());
		expect(t.localMax.mock.calls[0][2]).toBeCloseTo(72, 0);
		const t2 = terrainFor(2000);
		snapPeaksNear(
			t2,
			[peak("q", 3000)],
			at,
			pose,
			eye,
			1.5,
			new Map(),
			(_p, r) => ({ lat: 46.7, lon: 7.85, h: r }),
		);
		expect(t2.localMax).not.toHaveBeenCalled();
	});

	it("unknown snap is retried; a non-finite snap is cached as null", () => {
		const cache = new Map<Peak, SnappedPeak | null>();
		const p = peak("p", 3000);
		expect(
			snapPeaksNear(terrainFor(undefined), [p], at, pose, eye, 1.5, cache),
		).toEqual([]);
		expect(cache.has(p)).toBe(false);
		snapPeaksNear(
			terrainFor(Number.NEGATIVE_INFINITY),
			[p],
			at,
			pose,
			eye,
			1.5,
			cache,
		);
		expect(cache.get(p)).toBeNull();
	});

	it("placePeakLabels keeps visible in-frame peaks, ranks by prominence/elevation and declutters", () => {
		const mk = (
			name: string,
			e: number,
			n: number,
			ele: number,
			prom: number,
		): SnappedPeak => ({
			name,
			ele,
			prominence: prom,
			position: [e, n, 1000 + (ele - 1000) * 0.1],
		});
		const a = mk("A", 0, 3000, 3000, 500);
		const b = mk("B", 20, 3000, 2000, 100); // overlaps A in the frame
		const c = mk("C", 1500, 3000, 2500, 400);
		const hidden = mk("H", -200, 3000, 4000, 900);
		const behind = mk("Z", 0, -3000, 4000, 900);
		const vis = new Map<SnappedPeak, boolean>([
			[a, true],
			[b, true],
			[c, true],
			[hidden, false],
			[behind, true],
		]);
		const all = placePeakLabels(
			[a, b, c, hidden, behind],
			vis,
			pose,
			eye,
			1.5,
			{ declutter: false },
		);
		expect(all.map((l) => l.name).sort()).toEqual(["A", "B", "C"]);
		expect(all.map((l) => l.name)).not.toContain("H");
		expect(all.map((l) => l.name)).not.toContain("Z");
		for (const l of all) {
			expect(l.u).toBeGreaterThanOrEqual(0);
			expect(l.u).toBeLessThanOrEqual(1);
			expect(l.distKm).toBeGreaterThan(2.9);
		}
		for (let i = 1; i < all.length; i++)
			expect(all[i - 1].rank).toBeGreaterThanOrEqual(all[i].rank);
		const dec = placePeakLabels([a, b, c], vis, pose, eye, 1.5);
		expect(dec.map((l) => l.name)).toContain("A");
		expect(dec.map((l) => l.name)).not.toContain("B"); // A outranks and overlaps B
		const one = placePeakLabels([a, b, c], vis, pose, eye, 1.5, { max: 1 });
		expect(one.length).toBe(1);
	});
});

describe("silhouette-mask", () => {
	it("thresholds are float32 values bracketing the exact ones", () => {
		const t = silhouetteThresholds();
		for (const v of Object.values(t)) expect(Math.fround(v)).toBe(v);
		expect(t.khi).toBeGreaterThan(Math.exp(0.5));
		expect(t.klo).toBeLessThan(Math.exp(0.5));
		expect(t.zlo).toBeLessThan(Math.exp(-0.5));
		expect(t.zhi).toBeGreaterThan(Math.exp(-0.5));
		expect(t.fhi / t.flo).toBeCloseTo((1 + SIL_MARGIN) / (1 - SIL_MARGIN), 4);
		expect(t.rmax).toBe(25000);
	});

	it("layout helpers", () => {
		expect(silGroups(96)).toBe(1);
		expect(silGroups(97)).toBe(2);
		expect(silGroups(384)).toBe(4);
		expect(silMaskWords(384, 288)).toBe(4 * 288 * 4);
	});

	it("silNonce is never zero and wraps below 16 bits", () => {
		const seen = new Set<number>();
		for (let i = 0; i < 70_000; i++) {
			const n = silNonce();
			expect(n).toBeGreaterThan(0);
			expect(n).toBeLessThan(0x10000);
			seen.add(n);
		}
		expect(seen.size).toBeGreaterThan(60_000);
	});

	it("rangeIsBlank: only Infinity / <= 0 / NaN count as blank", () => {
		expect(
			rangeIsBlank(
				new Float32Array([0, Number.POSITIVE_INFINITY, -1, Number.NaN]),
			),
		).toBe(true);
		expect(rangeIsBlank(new Float32Array([0, 5]))).toBe(false);
		expect(rangeIsBlank(new Float32Array(0))).toBe(true);
	});

	it("redrawIfBlank redraws only a blank render", async () => {
		const render = vi.fn(async () => {});
		const pose = { yaw: 0, pitch: 0, roll: 0, vfov: 30 };
		expect(
			await redrawIfBlank({ range: new Float32Array([0]), render }, pose),
		).toBe(true);
		expect(render).toHaveBeenCalledWith(pose);
		expect(
			await redrawIfBlank({ range: new Float32Array([10]), render }, pose),
		).toBe(false);
		expect(render).toHaveBeenCalledTimes(1);
	});

	describe("scoreFromMask", () => {
		const W = 96;
		const H = 40;
		const G = silGroups(W);
		const edge = (fg: number, coarse: number): EdgeMap =>
			({
				w: W,
				h: H,
				fg: new Float32Array(W * H).fill(fg),
				coarse: new Float32Array(W * H).fill(coarse),
			}) as unknown as EdgeMap;
		const nonce = 77;
		function mask(setBits: [number, number][], positive = 5) {
			const words = new Uint32Array(G * H * 4);
			for (let j = 0; j < G * H; j++)
				words[j * 4 + 3] = ((nonce << 16) | (positive << 8)) >>> 0;
			for (const [x, y] of setBits) {
				const g = Math.floor(x / SIL_GROUP);
				const k = Math.floor((x % SIL_GROUP) / 32);
				words[(y * G + g) * 4 + k] |= 1 << (x % 32);
			}
			return words;
		}
		const pts = (n: number): [number, number][] =>
			Array.from({ length: n }, (_, i) => [i + 3, 5]);

		it("averages the coarse values of set bits when more than 30 pass", () => {
			expect(
				scoreFromMask(mask(pts(40)), 0, W, H, edge(0, 0.5), nonce),
			).toBeCloseTo(0.5);
		});

		it("scores 0 when 30 or fewer pass; skips foreground cells", () => {
			expect(scoreFromMask(mask(pts(30)), 0, W, H, edge(0, 0.5), nonce)).toBe(
				0,
			);
			expect(scoreFromMask(mask(pts(60)), 0, W, H, edge(0.9, 0.5), nonce)).toBe(
				0,
			);
		});

		it("ignores the border rows (only 1 <= y <= H-2 counts)", () => {
			const bits: [number, number][] = [...pts(40)].map(([x]) => [x, 0]);
			expect(scoreFromMask(mask(bits), 0, W, H, edge(0, 0.5), nonce)).toBe(0);
		});

		it("null for a wrong nonce, an undecided pixel, or no positive-range texel", () => {
			expect(
				scoreFromMask(mask(pts(40)), 0, W, H, edge(0, 0.5), nonce + 1),
			).toBeNull();
			const m = mask(pts(40));
			m[3] |= 1; // one undecided
			expect(scoreFromMask(m, 0, W, H, edge(0, 0.5), nonce)).toBeNull();
			expect(
				scoreFromMask(mask(pts(40), 0), 0, W, H, edge(0, 0.5), nonce),
			).toBeNull();
		});

		it("reads from a base offset (several poses packed in one buffer)", () => {
			const one = mask(pts(40));
			const both = new Uint32Array(one.length * 2);
			both.set(one, one.length);
			expect(
				scoreFromMask(both, one.length, W, H, edge(0, 0.25), nonce),
			).toBeCloseTo(0.25);
		});
	});
});

describe("device-lost", () => {
	it("watchContextLoss prevents default on loss, reports restore, unsubscribes", () => {
		const canvas = new EventTarget() as unknown as HTMLCanvasElement;
		const h = { onLost: vi.fn(), onRestored: vi.fn() };
		const off = watchContextLoss(canvas, h);
		const ev = new Event("webglcontextlost", { cancelable: true });
		canvas.dispatchEvent(ev);
		expect(ev.defaultPrevented).toBe(true);
		expect(h.onLost).toHaveBeenCalledTimes(1);
		canvas.dispatchEvent(new Event("webglcontextrestored"));
		expect(h.onRestored).toHaveBeenCalledTimes(1);
		off();
		canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
		canvas.dispatchEvent(new Event("webglcontextrestored"));
		expect(h.onLost).toHaveBeenCalledTimes(1);
		expect(h.onRestored).toHaveBeenCalledTimes(1);
	});

	function fakeDevice(lost: boolean) {
		const state = {
			cache: { "2884": "stale", bad: 1 } as Record<string, unknown>,
			program: {},
			stateStack: [{}, {}],
			enable: true,
		};
		const gl = {
			isContextLost: () => lost,
			getParameter: (p: number) => `fresh${p}`,
			getExtension: (n: string) => (n === "gone" ? null : { n }),
			lumaState: state,
		};
		const dev = {
			gl,
			lost: Promise.resolve("old"),
			_isLost: true,
			_lossWasRequested: true,
			_moduleData: { x: {} },
			extensions: { a: {}, gone: {}, off: null } as Record<string, unknown>,
		};
		return { dev, state };
	}

	it("reviveDevice refuses a still-lost context and non-WebGL devices", () => {
		expect(reviveDevice(fakeDevice(true).dev as never)).toBe(false);
		expect(reviveDevice({} as never)).toBe(false);
	});

	it("reviveDevice resets the caches of the dead context", () => {
		const { dev, state } = fakeDevice(false);
		const oldLost = dev.lost;
		expect(reviveDevice(dev as never)).toBe(true);
		expect(dev.lost).not.toBe(oldLost);
		expect(dev._isLost).toBe(false);
		expect(dev._lossWasRequested).toBe(false);
		expect(dev._moduleData).toEqual({});
		expect(state.cache).toEqual({ "2884": "fresh2884" }); // non-integer keys dropped
		expect(state.enable).toBe(true);
		expect(state.program).toBeNull();
		expect(state.stateStack.length).toBe(0);
		expect(dev.extensions.a).toEqual({ n: "a" });
		expect(dev.extensions.gone).toBeNull();
		expect(dev.extensions.off).toBeNull();
	});

	it("pendingPrograms counts pipelines still linking", () => {
		const mk = (s: string[]) => ({
			_moduleData: {
				"@luma.gl/core": {
					defaultPipelineFactory: {
						_sharedRenderPipelineCache: Object.fromEntries(
							s.map((x, i) => [i, { resource: { linkStatus: x } }]),
						),
					},
				},
			},
		});
		expect(
			pendingPrograms(mk(["pending", "success", "pending"]) as never),
		).toBe(2);
		expect(pendingPrograms({} as never)).toBe(0);
	});
});
