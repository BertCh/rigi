// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import { TYPE } from "../swiss/type";

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
			{kicker && (
				<p
					className={`${TYPE.kicker} mb-3 text-[var(--gb-contour,var(--accent))]`}
				>
					{kicker}
				</p>
			)}
			<h2 className={`${TYPE.h2} text-[var(--gb-ink)]`}>{title}</h2>
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
					"gb-num font-light whitespace-nowrap text-[var(--gb-ink)]",
					size === "hero"
						? "text-[40px] leading-[48px] sm:text-[56px] sm:leading-[60px]"
						: "text-[clamp(26px,14cqi,40px)] leading-[1.2]",
				)}
			>
				{value}
			</div>
			<div className={`${TYPE.kicker} gb-secondary mt-1.5`}>{label}</div>
		</div>
	);
}
