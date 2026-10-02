// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import { HandUnderline, seedUnit } from "./hand";

/**
 * Hand-lettered heading sizes: h2 is Caveat 700 with `font-size-adjust: ex-height 0.5` (theme.css),
 * which renders Caveat about 1.25x its nominal size, so 24/27 px nominal reads at about 30/34 px.
 */
const LETTERED =
	"text-[24px] leading-[32px] sm:text-[27px] sm:leading-[36px] font-bold text-[var(--gb-ink)]";

/**
 * A lettered heading with a partial marker underline (60–80 % of the title's width, seeded by the
 * title), red or brown by seed. Shared by Section and Beat.
 */
export function HandHeading({
	title,
	className,
	color,
}: {
	title: string;
	className?: string;
	/** Underline ink; default red or brown, chosen by the title's seed. */
	color?: string;
}) {
	const ink = color ?? (seedUnit(title, 11) < 0.6 ? "red" : "brown");
	return (
		<h2 className={cn(LETTERED, className)}>
			<span className="relative inline-block max-w-full pb-1">
				{title}
				<HandUnderline seed={`h-${title}`} color={ink} width={2.6} />
			</span>
		</h2>
	);
}

/** A kicker in hand block capitals, in the contour brown. */
export function HandKicker({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<p
			className={cn(
				"gb-caps text-[13px] leading-[18px] text-[var(--gb-contour,var(--accent))]",
				className,
			)}
		>
			{children}
		</p>
	);
}

/** A titled prose section. Body text gets editorial styling; use <p>, <ul>, <code>, <strong> freely inside. */
export function Section({
	title,
	kicker,
	children,
	className,
}: {
	title: string;
	kicker?: string;
	children: ReactNode;
	className?: string;
}) {
	// G9: sections are separated by space (two lines), not by a rule.
	return (
		<section className={cn("mt-12 first:mt-0", className)}>
			{kicker && <HandKicker className="mb-2">{kicker}</HandKicker>}
			<HandHeading title={title} />
			<div className={PROSE}>{children}</div>
		</section>
	);
}

export const PROSE =
	"mt-6 max-w-[66ch] space-y-6 text-[16px] leading-[24px] text-[var(--gb-ink)] [&_a]:text-[var(--gb-water,var(--accent))] [&_a]:underline-offset-2 hover:[&_a]:underline [&_code]:border-0 [&_code]:bg-[var(--gb-paper-deep)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[13px] [&_code]:text-[var(--gb-ink)] [&_em]:text-[var(--gb-ink)] [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-[var(--gb-ink)] [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_li::marker]:text-[var(--gb-contour,var(--accent))]";

/**
 * Big-number stat, e.g. <Stat value="0.43°" label="median horizon error" />. Group in a flex/grid, ideally
 * `grid-template-columns: repeat(auto-fit, minmax(110px, 1fr))`. The cell is its own size container, so the
 * numeral scales with the cell (26 to 40 px) and never wraps; `size="hero"` keeps the 56 px ledger numeral.
 * The value is written in hand figures over a short pencil stroke; the label is a hand note.
 */
export function Stat({
	value,
	label,
	className,
	size = "default",
}: {
	value: string;
	label: string;
	className?: string;
	size?: "default" | "hero";
}) {
	return (
		<div
			className={cn("min-w-[110px] [container-type:inline-size]", className)}
		>
			<div
				className={cn(
					"gb-num relative inline-block whitespace-nowrap text-[var(--gb-ink)]",
					size === "hero"
						? "text-[40px] leading-[48px] sm:text-[56px] sm:leading-[60px]"
						: "text-[clamp(26px,14cqi,40px)] leading-[1.2]",
				)}
			>
				{value}
				<HandUnderline
					seed={`stat-${label}`}
					color="pencil"
					width={1.2}
					coverage={0.9}
					opacity={0.55}
					offset={-4}
				/>
			</div>
			<div className="nb-hand gb-secondary mt-1.5 text-[19px] leading-[22px]">
				{label}
			</div>
		</div>
	);
}
