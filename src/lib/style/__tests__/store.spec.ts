// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { describe, expect, it, vi } from "vitest";
import { presetStyle } from "../presets";
import {
	createStyleStore,
	DEFAULT_STYLE_STATE,
	parseStoredState,
	STYLE_STORAGE_KEY,
	serializeState,
	urlPreset,
} from "../store";

function memoryStorage(initial: Record<string, string> = {}) {
	const m = new Map(Object.entries(initial));
	return {
		m,
		getItem: (k: string) => m.get(k) ?? null,
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
	};
}

describe("parseStoredState", () => {
	it("falls back to the default look for missing, corrupt or unversioned data", () => {
		for (const raw of [
			null,
			undefined,
			"",
			"{not json",
			"[]",
			"3",
			"null",
			JSON.stringify({ preset: "night", overrides: {} }),
			JSON.stringify({ v: 2, preset: "night", overrides: {} }),
			JSON.stringify({ v: 1, preset: "three", overrides: {} }),
		])
			expect(parseStoredState(raw)).toEqual(DEFAULT_STYLE_STATE);
	});
	it("reads a valid state and prunes invalid overrides", () => {
		const raw = JSON.stringify({
			v: 1,
			preset: "night",
			overrides: { terrain: { ambient: 0.3, direct: "x" }, junk: 1 },
		});
		expect(parseStoredState(raw)).toEqual({
			preset: "night",
			overrides: { terrain: { ambient: 0.3 } },
		});
	});
	it("round-trips through serializeState", () => {
		const s = {
			preset: "classic" as const,
			overrides: { terrain: { ambient: 0.3 } },
		};
		expect(parseStoredState(serializeState(s))).toEqual(s);
	});
});

describe("urlPreset", () => {
	it("reads ?style= for known presets only", () => {
		expect(urlPreset("?style=night")).toBe("night");
		expect(urlPreset("?a=1&style=topo-ink")).toBe("topo-ink");
		expect(urlPreset("?style=bogus")).toBeNull();
		expect(urlPreset("?other=night")).toBeNull();
		expect(urlPreset("")).toBeNull();
		expect(urlPreset(null)).toBeNull();
	});
});

describe("createStyleStore", () => {
	it("defaults to the Landeskarte (swiss) look", () => {
		const store = createStyleStore();
		expect(store.getState()).toEqual({ preset: "swiss", overrides: {} });
		expect(store.getStyle()).toBe(presetStyle("swiss"));
		expect(store.urlOverride).toBe(false);
	});
	it("loads from storage", () => {
		const storage = memoryStorage({
			[STYLE_STORAGE_KEY]: JSON.stringify({
				v: 1,
				preset: "night",
				overrides: {},
			}),
		});
		expect(createStyleStore({ storage }).getState().preset).toBe("night");
	});
	it("survives a throwing storage", () => {
		const storage = {
			getItem: () => {
				throw new Error("blocked");
			},
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		};
		const store = createStyleStore({ storage });
		expect(store.getState()).toEqual(DEFAULT_STYLE_STATE);
		expect(() => store.setPreset("night")).not.toThrow();
		expect(store.getState().preset).toBe("night");
	});
	it("persists changes and removes the key when back at the default", () => {
		const storage = memoryStorage();
		const store = createStyleStore({ storage });
		store.setPreset("night");
		store.flush();
		expect(JSON.parse(storage.m.get(STYLE_STORAGE_KEY) ?? "null")).toEqual({
			v: 1,
			preset: "night",
			overrides: {},
		});
		store.setPreset("swiss");
		store.flush();
		expect(storage.m.has(STYLE_STORAGE_KEY)).toBe(false);
	});
	it("debounces persistence: one trailing write, flushed on dispose", () => {
		vi.useFakeTimers();
		try {
			const storage = memoryStorage();
			const store = createStyleStore({ storage });
			store.setPreset("night");
			store.patch({ terrain: { ambient: 0.4 } });
			expect(storage.m.has(STYLE_STORAGE_KEY)).toBe(false);
			expect(store.getStyle().terrain.ambient).toBe(0.4);
			vi.advanceTimersByTime(300);
			expect(JSON.parse(storage.m.get(STYLE_STORAGE_KEY) ?? "")).toMatchObject({
				preset: "night",
			});
			store.setPreset("minimal");
			store.dispose();
			expect(JSON.parse(storage.m.get(STYLE_STORAGE_KEY) ?? "")).toMatchObject({
				preset: "minimal",
			});
		} finally {
			vi.useRealTimers();
		}
	});
	it("?style= wins over storage, is never saved and edits stay in memory", () => {
		const storage = memoryStorage({
			[STYLE_STORAGE_KEY]: JSON.stringify({
				v: 1,
				preset: "night",
				overrides: {},
			}),
		});
		const store = createStyleStore({ storage, search: "?style=minimal" });
		expect(store.urlOverride).toBe(true);
		expect(store.getState().preset).toBe("minimal");
		store.patch({ terrain: { ambient: 0.4 } });
		expect(store.getStyle().terrain.ambient).toBe(0.4);
		expect(JSON.parse(storage.m.get(STYLE_STORAGE_KEY) ?? "")).toMatchObject({
			preset: "night",
		});
	});
	it("setState validates its input", () => {
		const store = createStyleStore();
		store.setState({
			preset: "bogus" as never,
			overrides: { terrain: { ambient: 99, bogus: 1 } } as never,
		});
		expect(store.getState()).toEqual({
			preset: "swiss",
			overrides: { terrain: { ambient: 2 } },
		});
	});
	it("notifies subscribers only on real changes and stops after unsubscribe", () => {
		const store = createStyleStore();
		const cb = vi.fn();
		const off = store.subscribe(cb);
		store.setPreset("night");
		expect(cb).toHaveBeenCalledTimes(1);
		store.setPreset("night");
		expect(cb).toHaveBeenCalledTimes(1);
		off();
		store.setPreset("classic");
		expect(cb).toHaveBeenCalledTimes(1);
	});
	it("patch keeps overrides diff-only and drops a value set back to the preset's own", () => {
		const store = createStyleStore();
		const swissAmbient = presetStyle("swiss").terrain.ambient;
		store.patch({ terrain: { ambient: 0.123 } });
		expect(store.getState().overrides).toEqual({ terrain: { ambient: 0.123 } });
		store.patch({ terrain: { ambient: swissAmbient } });
		expect(store.getState().overrides).toEqual({});
	});
	it("patch switching a union variant replaces the node", () => {
		const store = createStyleStore({ search: "?style=classic" });
		store.patch({
			terrain: { sun: { mode: "azel", azimuthDeg: 5, elevationDeg: 40 } },
		});
		store.patch({ terrain: { sun: { mode: "fixed", dir: [0, 0, 1] } } });
		expect(store.getStyle().terrain.sun).toEqual({
			mode: "fixed",
			dir: [0, 0, 1],
		});
	});
	it("setPreset keeps overrides; resetOverrides drops them", () => {
		const store = createStyleStore();
		store.patch({ terrain: { ambient: 0.2 } });
		store.setPreset("night");
		expect(store.getStyle().terrain.ambient).toBe(0.2);
		store.resetOverrides();
		expect(store.getState()).toEqual({ preset: "night", overrides: {} });
	});
	it("follows cross-tab changes unless ?style= is active", () => {
		let push: (v: string | null) => void = () => {};
		const onExternalChange = (_k: string, cb: (v: string | null) => void) => {
			push = cb;
			return () => {};
		};
		const store = createStyleStore({ onExternalChange });
		const cb = vi.fn();
		store.subscribe(cb);
		push(JSON.stringify({ v: 1, preset: "night", overrides: {} }));
		expect(store.getState().preset).toBe("night");
		expect(cb).toHaveBeenCalledTimes(1);
		push(null);
		expect(store.getState()).toEqual(DEFAULT_STYLE_STATE);

		let called = false;
		createStyleStore({
			search: "?style=night",
			onExternalChange: () => {
				called = true;
				return () => {};
			},
		});
		expect(called).toBe(false);
	});
	it("dispose clears listeners", () => {
		const store = createStyleStore();
		const cb = vi.fn();
		store.subscribe(cb);
		store.dispose();
		store.setPreset("night");
		expect(cb).not.toHaveBeenCalled();
	});
});
