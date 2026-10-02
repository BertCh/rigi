// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storageKey } from "#/lib/ontology/core/storage";
import { flagOverride, flagSet, getFlag } from "../index";
import { THEME_BOOT_SCRIPT } from "../theme-boot";

const setUrl = (search: string) =>
	window.history.pushState({}, "", `/photo/x${search}`);

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => setUrl(""));

describe("getFlag from the page URL", () => {
	it("reads the current location.search, live", () => {
		setUrl("?renderer=deck&concord=occl");
		expect(getFlag("renderer")).toBe("deck");
		expect(getFlag("concord")).toEqual(["occl"]);
		expect(flagSet("renderer")).toBe(true);
		expect(flagSet("gpu")).toBe(false);
		setUrl("?renderer=webgpu");
		expect(getFlag("renderer")).toBe("webgpu");
		expect(getFlag("concord")).toEqual([]);
	});
	it("falls back to defaults for bad URL values", () => {
		setUrl("?renderer=banana");
		expect(getFlag("renderer")).toBe("auto");
		expect(flagSet("renderer")).toBe(true);
	});
	it("lets a per-realm override beat the URL", () => {
		setUrl("?gpu=off");
		(globalThis as { __RIGI_FLAGS__?: Record<string, string> }).__RIGI_FLAGS__ =
			{ gpu: "on" };
		expect(getFlag("gpu")).toBe("on");
		expect(flagOverride("gpu")).toBe("on");
	});
});

describe("THEME_BOOT_SCRIPT", () => {
	const run = () => {
		new Function(THEME_BOOT_SCRIPT)();
		return document.documentElement.dataset.theme;
	};
	const media = (light: boolean) =>
		vi.stubGlobal("matchMedia", (q: string) => ({
			matches: light && q.includes("light"),
		}));
	beforeEach(() => {
		document.documentElement.removeAttribute("data-theme");
		localStorage.clear();
		vi.stubGlobal("navigator", { ...navigator, webdriver: false });
	});
	it("is a single self-invoking function", () => {
		expect(THEME_BOOT_SCRIPT.startsWith("(function(){")).toBe(true);
		expect(THEME_BOOT_SCRIPT.endsWith("})();")).toBe(true);
	});
	it("prefers ?theme= over everything", () => {
		media(true);
		localStorage.setItem(storageKey("theme"), "dark");
		setUrl("?theme=LIGHT");
		expect(run()).toBe("light");
		setUrl("?theme=dark");
		expect(run()).toBe("dark");
	});
	it("lets __RIGI_FLAGS__.theme beat the URL", () => {
		setUrl("?theme=light");
		(globalThis as { __RIGI_FLAGS__?: Record<string, string> }).__RIGI_FLAGS__ =
			{ theme: "dark" };
		expect(run()).toBe("dark");
	});
	it("ignores theme=auto and unknown values, then uses OS preference", () => {
		media(true);
		setUrl("?theme=auto");
		expect(run()).toBe("light");
		setUrl("?theme=purple");
		expect(run()).toBe("light");
		media(false);
		expect(run()).toBe("dark");
	});
	it("uses the saved choice before the OS", () => {
		media(true);
		localStorage.setItem(storageKey("theme"), "dark");
		expect(run()).toBe("dark");
	});
	it("renders dark under webdriver unless told otherwise", () => {
		media(true);
		vi.stubGlobal("navigator", { webdriver: true });
		expect(run()).toBe("dark");
		setUrl("?theme=light");
		expect(run()).toBe("light");
	});
	it("defaults to dark when matchMedia is missing", () => {
		vi.stubGlobal("matchMedia", undefined);
		expect(run()).toBe("dark");
	});
});
