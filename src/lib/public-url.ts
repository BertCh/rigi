// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * Vite's base ("/" in dev, "/rigi/" on GitHub Pages), always ending in "/". Read through a cast so the
 * module also loads in node scripts, where import.meta.env is undefined.
 */
export function publicBase(): string {
	const base = (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL;
	if (!base) return "/";
	return base.endsWith("/") ? base : `${base}/`;
}

/** The URL a file under public/ is served at: publicUrl("/demo/how/scene.json") → "/rigi/demo/how/scene.json". */
export function publicUrl(path: string): string {
	return publicBase() + path.replace(/^\/+/, "");
}
