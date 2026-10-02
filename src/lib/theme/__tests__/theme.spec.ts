// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAND, BRAND_LIGHT } from "#/brand/khipu";
import { withFlags } from "#/test/helpers";
import {
	applyTheme,
	resolveTheme,
	setThemeChoice,
	storedThemeChoice,
	THEME_EVENT,
	THEME_STORAGE_KEY,
} from "../index";

type Env = { stored?: string; webdriver?: boolean; osLight?: boolean };

function stubEnv(env: Env = {}) {
	const store = new Map<string, string>();
	if (env.stored !== undefined) store.set(THEME_STORAGE_KEY, env.stored);
	vi.stubGlobal("localStorage", {
		getItem: (k: string) => store.get(k) ?? null,
		setItem: (k: string, v: string) => void store.set(k, v),
		removeItem: (k: string) => void store.delete(k),
	});
	vi.stubGlobal("navigator", { webdriver: !!env.webdriver });
	vi.stubGlobal("matchMedia", () => ({ matches: !!env.osLight }));
	return store;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveTheme precedence", () => {
	it("defaults to dark, follows the OS", () => {
		stubEnv();
		expect(resolveTheme()).toBe("dark");
		stubEnv({ osLight: true });
		expect(resolveTheme()).toBe("light");
	});
	it("webdriver renders dark even when the OS is light", () => {
		stubEnv({ webdriver: true, osLight: true });
		expect(resolveTheme()).toBe("dark");
	});
	it("a saved choice beats webdriver and the OS", () => {
		stubEnv({ stored: "light", webdriver: true });
		expect(resolveTheme()).toBe("light");
		stubEnv({ stored: "dark", osLight: true });
		expect(resolveTheme()).toBe("dark");
	});
	it("the ?theme= flag beats everything", () => {
		stubEnv({ stored: "dark", osLight: false });
		withFlags({ theme: "light" });
		expect(resolveTheme()).toBe("light");
		stubEnv({ stored: "light", osLight: true, webdriver: true });
		withFlags({ theme: "dark" });
		expect(resolveTheme()).toBe("dark");
	});
	it("flag 'auto' falls through to the saved choice", () => {
		stubEnv({ stored: "light" });
		withFlags({ theme: "auto" });
		expect(resolveTheme()).toBe("light");
	});
	it("an invalid saved value is ignored", () => {
		stubEnv({ stored: "blue", osLight: true });
		expect(storedThemeChoice()).toBe("auto");
		expect(resolveTheme()).toBe("light");
	});
	it("a throwing matchMedia or storage still yields dark", () => {
		vi.stubGlobal("localStorage", {
			getItem: () => {
				throw new Error("blocked");
			},
		});
		vi.stubGlobal("navigator", { webdriver: false });
		vi.stubGlobal("matchMedia", () => {
			throw new Error("no media");
		});
		expect(storedThemeChoice()).toBe("auto");
		expect(resolveTheme()).toBe("dark");
	});
});

describe("setThemeChoice", () => {
	it("saves light/dark, forgets on auto, and dispatches the change event", () => {
		const store = stubEnv();
		const events: string[] = [];
		vi.stubGlobal("dispatchEvent", (e: Event) => {
			events.push(e.type);
			return true;
		});
		setThemeChoice("light");
		expect(store.get(THEME_STORAGE_KEY)).toBe("light");
		expect(storedThemeChoice()).toBe("light");
		setThemeChoice("auto");
		expect(store.has(THEME_STORAGE_KEY)).toBe(false);
		expect(events).toEqual([THEME_EVENT, THEME_EVENT]);
	});
	it("does not throw when storage is blocked", () => {
		vi.stubGlobal("localStorage", {
			setItem: () => {
				throw new Error("blocked");
			},
			removeItem: () => {
				throw new Error("blocked");
			},
		});
		vi.stubGlobal("dispatchEvent", () => true);
		expect(() => setThemeChoice("dark")).not.toThrow();
	});
});

describe("applyTheme", () => {
	function stubDocument() {
		const meta = {
			content: "",
			setAttribute: (_: string, v: string) => (meta.content = v),
		};
		const root = { dataset: {} as Record<string, string> };
		vi.stubGlobal("document", {
			documentElement: root,
			querySelector: (sel: string) =>
				sel === 'meta[name="theme-color"]' ? meta : null,
		});
		return { meta, root };
	}
	it("writes data-theme and the theme-color meta in the brand ink of that theme", () => {
		stubEnv();
		const { meta, root } = stubDocument();
		withFlags({ theme: "light" });
		expect(applyTheme()).toBe("light");
		expect(root.dataset.theme).toBe("light");
		expect(meta.content).toBe(BRAND_LIGHT.ink);
		withFlags({ theme: "dark" });
		expect(applyTheme()).toBe("dark");
		expect(root.dataset.theme).toBe("dark");
		expect(meta.content).toBe(BRAND.ink);
	});
	it("still returns the theme without a document", () => {
		stubEnv({ osLight: true });
		vi.stubGlobal("document", undefined);
		expect(applyTheme()).toBe("light");
	});
});
