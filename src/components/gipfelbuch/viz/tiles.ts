// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// Pure helpers behind the multi-image tiles (Trio, Gallery) so their class choice and verdict
// vocabulary can be specced without a DOM. Spec: reports/gipfelbuch.md

/**
 * What a Gallery tile says about its photo (one meaning per word):
 * - `result`: the solver accepted it (a pose was shown).
 * - `failure`: the solver refused or rejected it (no pose shown).
 * - `caution`: solved, but the tile shows the thing that went wrong or is hard.
 * - `neutral`: no verdict on this figure.
 */
export type GalleryTone = "result" | "failure" | "caution" | "neutral";

/** The caps tag under a tile, by tone (`neutral` has none). */
export const TONE_TAG: Record<
	GalleryTone,
	{ text: string; color: string } | null
> = {
	result: { text: "result", color: "var(--gb-forest)" },
	failure: { text: "failure", color: "var(--gb-red)" },
	// NB brown: warm and apart from the failure red, but 6:1 on paper (the signal amber is about 2:1)
	caution: { text: "check", color: "var(--gb-contour)" },
	neutral: null,
};

/** The glyph in front of a caps tag. */
export function toneGlyph(tone: GalleryTone): string {
	if (tone === "result") return "✓ ";
	if (tone === "caution") return "! ";
	return "✗ ";
}

/**
 * The circled hand word drawn on a tile. `result` has none; `failure` says "rejected" or the page's
 * word; `caution` says the page's word, falling back to "check"; `neutral` has none.
 */
export function galleryVerdict(
	tone: GalleryTone,
	word?: string,
): { text: string; color: string } | undefined {
	if (tone === "failure")
		return { text: word ?? "rejected", color: "var(--gb-red)" };
	if (tone === "caution")
		return { text: word ?? "check", color: "var(--gb-contour)" };
	return undefined;
}

/**
 * Tailwind classes for a Trio. On sm and up every step spans two rows of the parent grid (visual,
 * then text) through subgrid, so the visuals of one row share a band and the titles start on one line.
 * Row tracks are implicit (`auto`), so a four-up Trio wrapping to two columns needs no row template.
 */
export function trioClasses(stepCount: number): {
	grid: string;
	step: string;
	visual: string;
	text: string;
} {
	return {
		grid: [
			// one column on a phone; the row gap only matters there (sm rows are the subgrid's own)
			"grid gap-4 sm:gap-y-0",
			stepCount >= 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3",
		].join(" "),
		step: "flex flex-col sm:row-span-2 sm:grid sm:grid-rows-subgrid sm:pb-4",
		visual: "overflow-hidden sm:self-end",
		text: "mt-3",
	};
}
