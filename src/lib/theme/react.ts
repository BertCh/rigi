// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useFlag } from "#/lib/flags/react";
import {
	applyTheme,
	type ResolvedTheme,
	resolveTheme,
	setThemeChoice,
	storedThemeChoice,
	THEME_EVENT,
	type ThemeChoice,
} from "./index";

function subscribe(onChange: () => void) {
	const media = globalThis.matchMedia?.("(prefers-color-scheme: light)");
	media?.addEventListener("change", onChange);
	globalThis.addEventListener("storage", onChange);
	globalThis.addEventListener(THEME_EVENT, onChange);
	return () => {
		media?.removeEventListener("change", onChange);
		globalThis.removeEventListener("storage", onChange);
		globalThis.removeEventListener(THEME_EVENT, onChange);
	};
}

/**
 * The theme: `choice` is what the user picked (a ?theme= flag shows as that value), `resolved` what is on
 * screen. Server render and hydration see "auto" / "dark"; the boot script has already set the real one.
 */
export function useTheme(): {
	choice: ThemeChoice;
	resolved: ResolvedTheme;
	setChoice: (choice: ThemeChoice) => void;
} {
	const flag = useFlag("theme"); // re-render when ?theme= changes
	const stored = useSyncExternalStore(
		subscribe,
		storedThemeChoice,
		(): ThemeChoice => "auto",
	);
	const resolved = useSyncExternalStore(
		subscribe,
		resolveTheme,
		(): ResolvedTheme => "dark",
	);
	const setChoice = useCallback((c: ThemeChoice) => setThemeChoice(c), []);
	return { choice: flag !== "auto" ? flag : stored, resolved, setChoice };
}

/** Mount once in the root: keeps <html data-theme> and theme-color in step with the choice, the OS and ?theme=. */
export function ThemeSync(): null {
	const { resolved } = useTheme();
	// biome-ignore lint/correctness/useExhaustiveDependencies: resolved is the trigger; applyTheme re-reads it
	useEffect(() => {
		applyTheme();
	}, [resolved]);
	return null;
}
