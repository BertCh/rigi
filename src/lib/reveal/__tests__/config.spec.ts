// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "#/lib/ontology/core/storage";
import { withFlags } from "#/test/helpers";
import {
	DEFAULT_REVEAL,
	EASE,
	equalise,
	fieldAt,
	frontAt,
	hexToLinear,
	presetById,
	REVEAL_MODE,
	REVEAL_PRESETS,
	type RevealPresetId,
} from "../config";

const KEY = storageKey("reveal");
const FOCUS: [number, number, number, number] = [0.5, 0.5, 0.5, 0.5];

describe("preset table", () => {
	it("ids, modes and presets are the same set; modes are 0..n-1 and unique", () => {
		const ids = REVEAL_PRESETS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(Object.keys(REVEAL_MODE).sort()).toEqual([...ids].sort());
		const modes = Object.values(REVEAL_MODE).sort((a, b) => a - b);
		expect(modes).toEqual(modes.map((_, i) => i));
	});
	it("presets are sane and name a known easing", () => {
		for (const p of REVEAL_PRESETS) {
			expect(p.color, p.id).toMatch(/^#[0-9a-f]{6}$/);
			expect(p.duration, p.id).toBeGreaterThan(0);
			expect(p.soft, p.id).toBeGreaterThan(0);
			expect(p.glowWidth, p.id).toBeGreaterThan(0);
			expect(p.grain, p.id).toBeGreaterThanOrEqual(0);
			expect(EASE[p.easing], p.id).toBeTypeOf("function");
			expect(p.label.length).toBeGreaterThan(0);
			expect(p.blurb.length).toBeGreaterThan(0);
		}
	});
	it("the default config names a real preset", () => {
		expect(DEFAULT_REVEAL.preset in REVEAL_MODE).toBe(true);
		expect(presetById(DEFAULT_REVEAL.preset).id).toBe(DEFAULT_REVEAL.preset);
	});
	it("presetById falls back to the first preset", () => {
		expect(presetById("nope" as RevealPresetId)).toBe(REVEAL_PRESETS[0]);
		expect(presetById("tide").id).toBe("tide");
	});
});

describe("EASE", () => {
	it("fixes 0 and 1 and is monotone", () => {
		for (const [name, f] of Object.entries(EASE)) {
			expect(f(0), name).toBeCloseTo(0, 12);
			expect(f(1), name).toBeCloseTo(1, 12);
			let prev = -1;
			for (let t = 0; t <= 1; t += 0.01) {
				const y = f(t);
				expect(y, name).toBeGreaterThanOrEqual(prev - 1e-12);
				prev = y;
			}
		}
	});
	it("known midpoints", () => {
		expect(EASE.outCubic(0.5)).toBeCloseTo(0.875, 12);
		expect(EASE.inOutCubic(0.5)).toBeCloseTo(0.5, 12);
		expect(EASE.outQuart(0.5)).toBeCloseTo(0.9375, 12);
		expect(EASE.outExpo(0.5)).toBeCloseTo(1 - 2 ** -5, 12);
	});
	it("the out-eases lead the linear ramp", () => {
		for (const f of [EASE.outCubic, EASE.outQuart, EASE.outExpo])
			expect(f(0.3)).toBeGreaterThan(0.3);
	});
});

describe("fieldAt", () => {
	it("bloom (default branch) is the normalised distance", () => {
		expect(fieldAt(0, 0.1, 0.9, 0.37, 0.8, FOCUS, 1.5, false)).toBe(0.37);
	});
	it("reverse flips the field", () => {
		for (const mode of Object.values(REVEAL_MODE)) {
			const a = fieldAt(mode, 0.3, 0.4, 0.2, 0.6, FOCUS, 1.5, false);
			const b = fieldAt(mode, 0.3, 0.4, 0.2, 0.6, FOCUS, 1.5, true);
			expect(a + b, `mode ${mode}`).toBeCloseTo(1, 12);
		}
	});
	it("alpenglow reaches high ground first (higher tE = earlier = lower f)", () => {
		const hi = fieldAt(REVEAL_MODE.alpenglow, 0, 0, 0.5, 0.9, FOCUS, 1, false);
		const lo = fieldAt(REVEAL_MODE.alpenglow, 0, 0, 0.5, 0.1, FOCUS, 1, false);
		expect(hi).toBeLessThan(lo);
	});
	it("tide floods from low ground up", () => {
		const hi = fieldAt(REVEAL_MODE.tide, 0, 0, 0.5, 0.9, FOCUS, 1, false);
		const lo = fieldAt(REVEAL_MODE.tide, 0, 0, 0.5, 0.1, FOCUS, 1, false);
		expect(lo).toBeLessThan(hi);
	});
	it("shockwave is 0 at its focus and grows with distance, capped at 1", () => {
		const m = REVEAL_MODE.shockwave;
		expect(fieldAt(m, 0.5, 0.5, 0.5, 0.5, FOCUS, 1.5, false)).toBe(0);
		const near = fieldAt(m, 0.6, 0.5, 0.5, 0.5, FOCUS, 1.5, false);
		const far = fieldAt(m, 1, 1, 1, 1, FOCUS, 1.5, false);
		expect(near).toBeGreaterThan(0);
		expect(far).toBeGreaterThan(near);
		expect(fieldAt(m, 100, 100, 5, 5, FOCUS, 1.5, false)).toBe(1);
	});
	it("terraces step with elevation band", () => {
		const m = REVEAL_MODE.terraces;
		const f = (tE: number) => fieldAt(m, 0, 0, 0, tE, FOCUS, 1, false);
		// within a band (tE in [k/8, (k+1)/8)) tD = 0 gives the same value
		expect(f(0.01)).toBe(f(0.12));
		expect(f(0.13)).toBeGreaterThan(f(0.12));
		expect(f(0.99)).toBeLessThanOrEqual(1);
	});
	it("sunsweep sweeps along the screen's u axis", () => {
		const m = REVEAL_MODE.sunsweep;
		expect(fieldAt(m, 0.9, 0, 0, 0.5, FOCUS, 1, false)).toBeGreaterThan(
			fieldAt(m, 0.1, 0, 0, 0.5, FOCUS, 1, false),
		);
	});
});

describe("equalise", () => {
	const Q = [0.2, 0.4, 0.6, 0.8] as const;
	it("maps the window ends to 0 and 1", () => {
		expect(equalise(0, 0, Q, 1)).toBeCloseTo(0, 12);
		expect(equalise(1, 0, Q, 1)).toBeCloseTo(1, 12);
	});
	it("is the identity for uniformly distributed samples", () => {
		for (const x of [0.05, 0.3, 0.5, 0.77, 0.95])
			expect(equalise(x, 0, Q, 1)).toBeCloseTo(x, 12);
	});
	it("spends equal output on equal-area quantile bins (65 % area-equalised)", () => {
		// data crowded near 0: quantiles at 0.01..0.04 over a 0..1 window
		const q = [0.01, 0.02, 0.03, 0.04] as const;
		const atQ = [0.01, 0.02, 0.03, 0.04].map((x) => equalise(x, 0, q, 1));
		// each 20 % area bin gets 0.65 * 0.2 of output plus a tiny linear share
		expect(atQ[0]).toBeCloseTo(0.35 * 0.01 + 0.65 * 0.2, 9);
		expect(atQ[3]).toBeCloseTo(0.35 * 0.04 + 0.65 * 0.8, 9);
	});
	it("is monotone and bounded", () => {
		const q = [0.1, 0.15, 0.5, 0.9] as const;
		let prev = -1;
		for (let x = 0; x <= 1; x += 0.01) {
			const y = equalise(x, 0, q, 1);
			expect(y).toBeGreaterThanOrEqual(prev - 1e-12);
			expect(y).toBeLessThanOrEqual(1 + 1e-12);
			prev = y;
		}
	});
	it("survives degenerate (equal) quantiles", () => {
		for (const x of [0, 0.5, 1])
			expect(Number.isFinite(equalise(x, 0, [0.5, 0.5, 0.5, 0.5], 1))).toBe(
				true,
			);
	});
});

describe("frontAt", () => {
	it("starts fully behind the field and ends fully past it", () => {
		for (const [soft, grain] of [
			[0.1, 0.08],
			[0.02, 0],
		]) {
			expect(frontAt(0, soft, grain)).toBeCloseTo(-(soft + grain / 2), 12);
			expect(frontAt(1, soft, grain)).toBeCloseTo(1 + soft + grain / 2, 12);
		}
	});
	it("is linear in progress", () => {
		const mid = frontAt(0.5, 0.1, 0.1);
		expect((frontAt(0, 0.1, 0.1) + frontAt(1, 0.1, 0.1)) / 2).toBeCloseTo(
			mid,
			12,
		);
	});
});

describe("hexToLinear", () => {
	it("known answers", () => {
		expect(hexToLinear("#000000")).toEqual([0, 0, 0]);
		const w = hexToLinear("#ffffff");
		for (const c of w) expect(c).toBeCloseTo(1, 12);
		const g = hexToLinear("#808080");
		expect(g[0]).toBeCloseTo(0.21586, 4);
		// channel order
		const r = hexToLinear("#ff0000");
		expect(r[0]).toBeCloseTo(1, 12);
		expect(r[1]).toBe(0);
	});
});

// ---- persistence (module state is cached, so each test loads a fresh copy) ----

function fakeStorage(initial?: string) {
	const store = new Map<string, string>();
	if (initial !== undefined) store.set(KEY, initial);
	return {
		store,
		getItem: vi.fn((k: string) => store.get(k) ?? null),
		setItem: vi.fn((k: string, v: string) => void store.set(k, v)),
	};
}

async function load(storage: ReturnType<typeof fakeStorage> | null) {
	vi.resetModules();
	if (storage) vi.stubGlobal("localStorage", storage);
	return import("../config");
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("persisted config", () => {
	it("starts from DEFAULT_REVEAL with empty or throwing storage", async () => {
		const m1 = await load(fakeStorage());
		expect(m1.getRevealConfig()).toEqual(m1.DEFAULT_REVEAL);
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
		});
		vi.resetModules();
		const m2 = await import("../config");
		expect(m2.getRevealConfig()).toEqual(m2.DEFAULT_REVEAL);
		expect(() => m2.setRevealConfig({ glow: 2 })).not.toThrow();
		expect(m2.getRevealConfig().glow).toBe(2);
	});
	it("merges stored JSON over defaults and ignores corrupt or unknown presets", async () => {
		const ok = await load(
			fakeStorage(JSON.stringify({ preset: "tide", glow: 0.5 })),
		);
		expect(ok.getRevealConfig()).toEqual({
			...ok.DEFAULT_REVEAL,
			preset: "tide",
			glow: 0.5,
		});
		const badPreset = await load(
			fakeStorage(JSON.stringify({ preset: "disco" })),
		);
		expect(badPreset.getRevealConfig().preset).toBe(
			badPreset.DEFAULT_REVEAL.preset,
		);
		const corrupt = await load(fakeStorage("{oops"));
		expect(corrupt.getRevealConfig()).toEqual(corrupt.DEFAULT_REVEAL);
	});
	it("setRevealConfig persists the patch and notifies", async () => {
		const st = fakeStorage();
		const m = await load(st);
		m.setRevealConfig({ preset: "stardust", reverse: true });
		expect(m.getRevealConfig()).toMatchObject({
			preset: "stardust",
			reverse: true,
		});
		expect(JSON.parse(st.store.get(KEY) ?? "null")).toMatchObject({
			preset: "stardust",
			reverse: true,
		});
	});
	it("?reveal=off disables on-load play without saving it", async () => {
		withFlags({ reveal: "off" });
		const st = fakeStorage();
		const m = await load(st);
		expect(m.getRevealConfig().onLoad).toBe(false);
		m.setRevealConfig({ glow: 0.3 });
		const saved = JSON.parse(st.store.get(KEY) ?? "null");
		expect(saved.glow).toBe(0.3);
		// the URL override is not written back: the saved value stays the stored one
		expect(saved.onLoad).toBe(true);
	});
	it("?reveal=<preset> forces that preset on, over storage", async () => {
		withFlags({ reveal: "shockwave" });
		const m = await load(
			fakeStorage(JSON.stringify({ preset: "tide", onLoad: false })),
		);
		expect(m.getRevealConfig()).toMatchObject({
			preset: "shockwave",
			onLoad: true,
		});
	});
	it("an unknown ?reveal= value changes nothing", async () => {
		withFlags({ reveal: "nonsense" });
		const m = await load(fakeStorage());
		expect(m.getRevealConfig()).toEqual(m.DEFAULT_REVEAL);
	});
});
