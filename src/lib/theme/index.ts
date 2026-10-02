// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Light / dark theme state. The page theme is the data-theme attribute on <html>; src/styles.css re-inks
// the --rigi-* roles and swaps Tailwind's white and black under data-theme="light". Always-dark islands
// carry data-theme="dark" themselves. Precedence (mirrored by the boot script, flags/theme-boot.ts):
// ?theme= / __RIGI_FLAGS__, then the saved choice, then webdriver (dark), then the OS, then dark.

import { BRAND, BRAND_LIGHT } from "#/brand/khipu";
import { getFlag } from "#/lib/flags";
import { storageKey } from "#/lib/ontology/core/storage";

export type ThemeChoice = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = storageKey("theme");
export const THEME_EVENT = "themechange";

/** The saved choice ("auto" when none). */
export function storedThemeChoice(): ThemeChoice {
	try {
		const v = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
		return v === "light" || v === "dark" ? v : "auto";
	} catch {
		return "auto";
	}
}

/** Save a choice ("auto" forgets it) and tell subscribers. */
export function setThemeChoice(choice: ThemeChoice) {
	try {
		if (choice === "auto")
			globalThis.localStorage?.removeItem(THEME_STORAGE_KEY);
		else globalThis.localStorage?.setItem(THEME_STORAGE_KEY, choice);
	} catch {
		// storage blocked: the choice lasts until reload
	}
	globalThis.dispatchEvent?.(new Event(THEME_EVENT));
}

/** The theme in effect, by the precedence above. */
export function resolveTheme(): ResolvedTheme {
	const flag = getFlag("theme");
	if (flag !== "auto") return flag;
	const stored = storedThemeChoice();
	if (stored !== "auto") return stored;
	if (globalThis.navigator?.webdriver) return "dark";
	try {
		return globalThis.matchMedia("(prefers-color-scheme: light)").matches
			? "light"
			: "dark";
	} catch {
		return "dark";
	}
}

/** Write the resolved theme to <html data-theme> and the theme-color meta. Returns it. */
export function applyTheme(): ResolvedTheme {
	const theme = resolveTheme();
	if (typeof document === "undefined") return theme;
	document.documentElement.dataset.theme = theme;
	document
		.querySelector('meta[name="theme-color"]')
		?.setAttribute("content", theme === "light" ? BRAND_LIGHT.ink : BRAND.ink);
	return theme;
}
