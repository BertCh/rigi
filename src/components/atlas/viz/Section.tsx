// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

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
	return (
		<section className={cn("mt-14 first:mt-0", className)}>
			{kicker && (
				<p className="mb-2 font-mono text-[10.5px] tracking-[0.18em] text-[var(--accent)] uppercase">
					{kicker}
				</p>
			)}
			<h2 className="display-title text-[1.65rem] leading-tight font-bold tracking-[-0.01em] text-[var(--rigi-paper)]">
				{title}
			</h2>
			<div className={PROSE}>{children}</div>
		</section>
	);
}

export const PROSE =
	"mt-4 space-y-4 text-[15.5px] leading-[1.75] text-white/68 [&_a]:text-[var(--accent)] [&_a]:underline-offset-2 hover:[&_a]:underline [&_code]:rounded [&_code]:border-0 [&_code]:bg-white/8 [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[12.5px] [&_code]:text-white/80 [&_em]:text-white/85 [&_li]:pl-1 [&_strong]:font-semibold [&_strong]:text-[var(--rigi-paper)] [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_li::marker]:text-[var(--accent)]";

/** Big-number stat, e.g. <Stat value="0.43°" label="median horizon error" />. Group in a flex/grid. */
export function Stat({
	value,
	label,
	className,
}: {
	value: string;
	label: string;
	className?: string;
}) {
	return (
		<div className={cn("min-w-[120px]", className)}>
			<div className="display-title text-[2.2rem] leading-none font-bold text-[var(--accent)]">
				{value}
			</div>
			<div className="mt-1.5 text-[12px] leading-snug text-white/50">
				{label}
			</div>
		</div>
	);
}
