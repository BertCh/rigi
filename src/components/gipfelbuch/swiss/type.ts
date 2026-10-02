// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

// The Gipfelbuch type programme: a 6px unit, a 24px baseline and seven sizes. See
// reports/gipfelbuch-field-notebook-design.md (sections 2 and 3). Not exported from ./index.ts;
// import it by path.

export const GB_UNIT = 6;
export const GB_LINE = 24;
export const TYPE_SCALE_PX = [11, 13, 16, 20, 24, 40, 56] as const;

/** Tailwind class strings per role. */
export const TYPE = {
	micro: "text-[11px] leading-[12px] gb-coord",
	kicker: "gb-caps text-[11px] leading-[12px]",
	caption: "text-[13px] leading-[18px] gb-secondary",
	body: "text-[16px] leading-[24px]",
	lead: "text-[18px] leading-[24px] sm:text-[20px] sm:leading-[30px]",
	h3: "text-[16px] leading-[24px] font-semibold",
	h2: "text-[20px] leading-[24px] sm:text-[24px] sm:leading-[30px] font-semibold",
	/** A Beat's claim headline: lettered (display-title is Architects Daughter in the hand pass). */
	claim:
		"display-title text-[20px] leading-[24px] sm:text-[24px] sm:leading-[30px] font-semibold",
	h1: "display-title text-[30px] leading-[36px] sm:text-[40px] sm:leading-[48px]",
	/** Sheet title (H1 only): big Architects Daughter lettering at the stat sizes. */
	display:
		"display-title text-[40px] leading-[48px] sm:text-[56px] sm:leading-[60px]",
	/** A hand note in the margin or under a figure (Architects Daughter): decisions, asides, the register line. */
	hand: "nb-hand text-[20px] leading-[24px]",
	/** A small hand label in running HTML (Shantell Sans, tabular hand figures). */
	handLabel: "nb-hand-small text-[13px] leading-[18px]",
	stat: "gb-num font-light text-[40px] leading-[48px] sm:text-[56px] sm:leading-[60px]",
} as const satisfies Record<string, string>;
