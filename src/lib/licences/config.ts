// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Opt-in switches for the licence work (roadmap N2). Every default reproduces the app as it was.
// Read from (first hit wins): the page flag (src/lib/flags: URL, main thread only), a Vite env var
// (VITE_*, baked at build time), then a Node env var (scripts under tsx). Workers see neither the
// page query nor, usually, the env: they get the defaults.
import { type FlagName, flagSet, getFlag } from "#/lib/flags";

type Env = Record<string, string | undefined>;

function viteEnv(): Env {
	try {
		return ((import.meta as { env?: Env }).env ?? {}) as Env;
	} catch {
		return {};
	}
}

function nodeEnv(): Env {
	const p = (globalThis as { process?: { env?: Env } }).process;
	return p?.env ?? {};
}

/** The flag if set → VITE_<envName> → <envName> (Node). Empty strings count as unset. */
export function readSetting(
	flag: FlagName | null,
	envName: string,
): string | undefined {
	if (flag && flagSet(flag)) return String(getFlag(flag));
	const v = viteEnv()[`VITE_${envName}`] ?? nodeEnv()[envName];
	return v ? v : undefined;
}

/** `?attrib=full` / VITE_ATTRIBUTION=full: per-source attribution in the UI and PNG export footer. */
export const attributionMode = (): "classic" | "full" =>
	readSetting("attrib", "ATTRIBUTION") === "full" ? "full" : "classic";

/** `?osmextract=on` / VITE_OSM_EXTRACT=1: answer covered peak queries from public/osm extracts. */
export const osmExtractEnabled = (): boolean => {
	const v = readSetting("osmextract", "OSM_EXTRACT");
	return v === "1" || v === "true" || v === "on";
};
