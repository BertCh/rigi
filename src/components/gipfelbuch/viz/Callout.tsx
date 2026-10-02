// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import { HandFrame, HandSideRule, HandStrike, HandUnderline } from "./hand";

/**
 * The notebook's voices (hand pass; Laws' "I notice / I wonder / it reminds me of"). Each tone keeps its
 * old key so pages need no change:
 * - note: "Note", in ink, a single underline under the title;
 * - lesson: the conclusion, in brown, the ONE boxed thing (a hand box with overshooting corners);
 * - warning: a trap, in red, a wavy pen mark down the side;
 * - result: in forest green, a double underline on the title;
 * - negative: a dead end, in pencil, the idea struck through (still readable) .
 */
const TONES = {
	note: { label: "Note", c: "var(--gb-ink)", ink: "ink" },
	lesson: { label: "In short", c: "var(--gb-contour, #95500c)", ink: "brown" },
	warning: { label: "Careful", c: "var(--gb-red, #bf2233)", ink: "red" },
	result: { label: "Result", c: "var(--gb-forest, #575e4e)", ink: "forest" },
	negative: {
		label: "Dead end",
		c: "var(--gb-pencil, #49423d)",
		ink: "pencil",
	},
} as const;

/** A hand note in one of the notebook's voices. tone: note | lesson | warning | result | negative. */
export function Callout({
	tone = "note",
	title,
	children,
	className,
}: {
	tone?: keyof typeof TONES;
	title?: string;
	children: ReactNode;
	className?: string;
}) {
	const t = TONES[tone];
	const seed = `callout-${tone}-${title ?? ""}`;
	const boxed = tone === "lesson";
	return (
		<aside
			className={cn(
				"relative my-8",
				boxed ? "mx-1 px-5 py-4" : "py-1 pr-4 pl-6",
				className,
			)}
		>
			{boxed && <HandFrame seed={seed} color={t.ink} width={1.7} />}
			{tone === "warning" && (
				<HandSideRule seed={seed} color="red" width={1.6} wavy />
			)}
			{tone === "negative" && (
				<HandSideRule
					seed={seed}
					color="pencil"
					width={1.2}
					dash="5 4"
					opacity={0.8}
				/>
			)}
			{(tone === "note" || tone === "result") && (
				<HandSideRule seed={seed} color={t.ink} width={1.2} opacity={0.5} />
			)}
			<p
				className="nb-hand mb-1.5 text-[22px] leading-[26px] font-bold"
				style={{ color: t.c }}
			>
				<span className="relative inline-block">
					{title ?? t.label}
					{tone === "negative" && (
						<HandStrike seed={seed} color="red" width={1.4} />
					)}
					{tone === "note" && (
						<HandUnderline
							seed={seed}
							color="ink"
							width={1.3}
							coverage={0.85}
							opacity={0.7}
							offset={-2}
						/>
					)}
					{tone === "result" && (
						<HandUnderline
							seed={seed}
							color="forest"
							width={2}
							coverage={1}
							double
							offset={-2}
						/>
					)}
				</span>
			</p>
			<div
				className={cn(
					"text-[16px] leading-[24px] [&_code]:bg-[var(--gb-paper-deep)] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px]",
					tone === "negative"
						? "text-[var(--gb-pencil,var(--gb-ink))]"
						: "text-[var(--gb-ink)]",
				)}
			>
				{children}
			</div>
		</aside>
	);
}
