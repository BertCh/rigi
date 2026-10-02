// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/**
 * An OSM length tag (`ele`, `prominence`) in metres, or undefined if unusable. The one parser for
 * OSM heights (geo/peaks.ts, upload/region.ts, geocam/lakes/levels.ts): "1234", "1234 m", "~1500",
 * "1234,5" (decimal comma), "4,810" and "1'234" / "1’234" (thousands separators: a comma or
 * apostrophe followed by exactly three digits), and feet as "3000 ft", "3000 feet" or "3000'".
 */
export function parseOsmMetres(v: unknown): number | undefined {
	if (typeof v !== "string") return undefined;
	const s = v
		.trim()
		.replace(/(?<=\d)[,'’](?=\d{3}(?!\d))/g, "")
		.replace(/,/g, ".");
	const m = s.match(/-?\d+(\.\d+)?/);
	if (!m) return undefined;
	let n = Number.parseFloat(m[0]);
	if (/ft|feet|foot|['’]/i.test(s.slice((m.index ?? 0) + m[0].length)))
		n *= 0.3048;
	return Number.isFinite(n) ? n : undefined;
}
