// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Renderer } from "#/lib/renderer";
import {
	DEFAULT_REVEAL,
	type RevealConfig,
	type RevealUniforms,
} from "../config";
import { RevealController, type RevealFrame } from "../controller";

// A stub engine: terrain is a ramp (range and height grow with v), one visible labelled peak.
function makeEngine(
	opts: { ready?: boolean; withReveal?: boolean; sparse?: boolean } = {},
) {
	const setReveal = vi.fn<(u: RevealUniforms | null) => void>();
	const engine = {
		setReveal: opts.withReveal === false ? undefined : setReveal,
		readback: vi.fn(async () => opts.ready ?? true),
		aspect: 1.5,
		pose: { yaw: 30, pitch: 0, roll: 0, vfov: 40 },
		eyeAlt: 1200,
		settings: { mode: "overlay", nearFade: 100 },
		sampleAt: (u: number, v: number) =>
			opts.sparse
				? null
				: {
						lat: 0,
						lon: 0,
						h: 800 + 2000 * (1 - v),
						range: 500 + 20000 * (1 - v) * (1 - v) + u,
						world: [0, 0, 0],
					},
		isForeground: (u: number) => u > 0.95,
		peakLabels: () => [
			{
				name: "P",
				ele: 2800,
				u: 0.4,
				v: 0.3,
				distKm: 6,
				rank: 1,
				visible: true,
				world: [0, 0, 0],
			},
		],
	} as unknown as Renderer;
	return { engine, setReveal };
}

let rafQueue: FrameRequestCallback[] = [];
let now = 0;
beforeEach(() => {
	rafQueue = [];
	now = 0;
	vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
		rafQueue.push(cb);
		return rafQueue.length;
	});
	vi.stubGlobal("cancelAnimationFrame", () => {});
	vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
	rafQueue = [];
});

const runFrame = () => {
	const cb = rafQueue.shift();
	cb?.(now);
};
const cfg: RevealConfig = { ...DEFAULT_REVEAL, duration: 1 } as RevealConfig;

describe("RevealController", () => {
	it("reports whether the engine supports reveals; unsupported engines no-op", async () => {
		const { engine } = makeEngine({ withReveal: false });
		const c = new RevealController(engine);
		expect(c.supported).toBe(false);
		await c.play(cfg);
		await c.seek(cfg, 0.5);
		c.hold(cfg);
		expect(rafQueue).toHaveLength(0);
	});
	it("hold hides the overlay (a = 0) and gives labels an infinitely negative front", () => {
		const { engine, setReveal } = makeEngine();
		const frames: (RevealFrame | null)[] = [];
		const c = new RevealController(engine, (f) => frames.push(f));
		c.hold(cfg);
		expect(setReveal).toHaveBeenCalledTimes(1);
		const u = setReveal.mock.calls[0][0] as RevealUniforms;
		expect(u.a[0]).toBe(0);
		expect(frames[0]?.p).toBe(Number.NEGATIVE_INFINITY);
		expect(frames[0]?.fieldOf(0.5, 0.5, 1000, 1000)).toBe(0);
	});
	it("ray basis follows the pose: F is the forward axis (yaw 30 means east-north-east)", () => {
		const { engine, setReveal } = makeEngine();
		new RevealController(engine).hold(cfg);
		const u = setReveal.mock.calls[0][0] as RevealUniforms;
		expect(u.F[0]).toBeCloseTo(Math.sin((30 * Math.PI) / 180), 9);
		expect(u.F[1]).toBeCloseTo(Math.cos((30 * Math.PI) / 180), 9);
		expect(Math.hypot(...u.F)).toBeCloseTo(1, 9);
	});
	it("play measures windows from the geometry, animates with the front moving forward, then clears", async () => {
		const { engine, setReveal } = makeEngine();
		const frames: (RevealFrame | null)[] = [];
		const c = new RevealController(engine, (f) => frames.push(f));
		const done = c.play(cfg);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		// the first rAF is queued after readback
		expect(rafQueue.length).toBe(1);
		const fronts: number[] = [];
		for (const t of [100, 400, 800]) {
			now = t;
			runFrame();
			const f = frames[frames.length - 1];
			expect(f).not.toBeNull();
			fronts.push(f?.p ?? Number.NaN);
		}
		for (let i = 1; i < fronts.length; i++)
			expect(fronts[i]).toBeGreaterThan(fronts[i - 1]);
		const mid = setReveal.mock.calls[
			setReveal.mock.calls.length - 1
		][0] as RevealUniforms;
		// measured windows: distance window in log metres inside the sampled range, focus on the peak
		expect(mid.win[0]).toBeGreaterThan(Math.log(100));
		expect(mid.win[1]).toBeGreaterThan(mid.win[0]);
		expect(mid.win[3]).toBeGreaterThan(mid.win[2]);
		expect(mid.focus[0]).toBeCloseTo(0.4, 9);
		expect(mid.focus[1]).toBeCloseTo(0.7, 9);
		// completes: setReveal(null) and a null frame, promise resolves
		now = 2000;
		runFrame();
		await done;
		expect(setReveal.mock.calls[setReveal.mock.calls.length - 1][0]).toBeNull();
		expect(frames[frames.length - 1]).toBeNull();
	});
	it("a newer play supersedes the running one", async () => {
		const { engine, setReveal } = makeEngine();
		const c = new RevealController(engine);
		const first = c.play(cfg);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		c.hold(cfg); // bumps the run id
		runFrame(); // the stale tick sees run !== this.run and resolves
		await first;
		const nulls = setReveal.mock.calls.filter((a) => a[0] === null).length;
		expect(nulls).toBe(0);
	});
	it("play stops quietly when the readback fails", async () => {
		const { engine, setReveal } = makeEngine({ ready: false });
		await new RevealController(engine).play(cfg);
		expect(rafQueue).toHaveLength(0);
		// only the hold from play's start
		expect(setReveal).toHaveBeenCalledTimes(1);
	});
	it("a sparse geometry buffer falls back to the default windows", async () => {
		const { engine, setReveal } = makeEngine({ sparse: true });
		const c = new RevealController(engine);
		void c.play(cfg);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		now = 100;
		runFrame();
		const u = setReveal.mock.calls[
			setReveal.mock.calls.length - 1
		][0] as RevealUniforms;
		expect(u.win[0]).toBeCloseTo(Math.log(300), 9);
		expect(u.win[1]).toBeCloseTo(Math.log(60000), 9);
		expect(u.win[2]).toBe(1200 - 1500);
	});
	it("seek freezes a frame at progress k, and null or >= 1 ends the reveal", async () => {
		const { engine, setReveal } = makeEngine();
		const frames: (RevealFrame | null)[] = [];
		const c = new RevealController(engine, (f) => frames.push(f));
		await c.seek(cfg, 0.5);
		const u = setReveal.mock.calls[
			setReveal.mock.calls.length - 1
		][0] as RevealUniforms;
		expect(u.a[0]).toBeGreaterThan(0);
		expect(u.a[0]).toBeLessThan(1);
		const f1 = frames[frames.length - 1];
		await c.seek(cfg, 0.9);
		const f2 = frames[frames.length - 1];
		expect((f2?.p ?? 0) > (f1?.p ?? 0)).toBe(true);
		// a labelled point: the field is a number and differs across the image
		const a = f2?.fieldOf(0.1, 0.5, 1000, 900) ?? Number.NaN;
		const b = f2?.fieldOf(0.9, 0.5, 40000, 2800) ?? Number.NaN;
		expect(Number.isFinite(a) && Number.isFinite(b)).toBe(true);
		expect(a).not.toBe(b);
		expect(f2?.fieldOf(0.5, 0.5, 1000, null)).toBeTypeOf("number");
		await c.seek(cfg, null);
		expect(setReveal.mock.calls[setReveal.mock.calls.length - 1][0]).toBeNull();
		expect(frames[frames.length - 1]).toBeNull();
		await c.seek(cfg, 1);
		expect(frames[frames.length - 1]).toBeNull();
	});
	it("stop clears the reveal and dispose bumps the run so a pending tick resolves", async () => {
		const { engine, setReveal } = makeEngine();
		const frames: (RevealFrame | null)[] = [];
		const c = new RevealController(engine, (f) => frames.push(f));
		c.stop();
		expect(setReveal).toHaveBeenLastCalledWith(null);
		expect(frames[frames.length - 1]).toBeNull();
		const p = c.play(cfg);
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
		c.dispose();
		runFrame();
		await p;
	});
	it("reverse flips the shader flag and the cfg colour overrides the preset glow", () => {
		const { engine, setReveal } = makeEngine();
		const c = new RevealController(engine);
		c.hold({ ...cfg, reverse: true, color: "#ff0000" } as RevealConfig);
		const u = setReveal.mock.calls[0][0] as RevealUniforms;
		expect(u.a[3]).toBe(2);
		expect(u.glow[0]).toBeGreaterThan(u.glow[1]);
		c.hold({ ...cfg, reverse: false } as RevealConfig);
		expect((setReveal.mock.calls[1][0] as RevealUniforms).a[3]).toBe(1);
	});
});
