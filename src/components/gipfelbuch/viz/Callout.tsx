// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import { SketchPath } from "../notebook/Ink";

const TONES = {
	note: { label: "Note", c: "var(--gb-water, var(--accent))" },
	lesson: { label: "Lesson", c: "var(--rigi-lesson)" },
	warning: { label: "Trap", c: "var(--rigi-trap)" },
	result: { label: "Result", c: "var(--rigi-result)" },
	negative: { label: "Negative result", c: "var(--rigi-negative)" },
} as const;

/** Margin note: a faint wash of the tone colour, a tone-coloured pen rule down the left edge and a small-caps label. tone: note | lesson | warning | result | negative. */
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
	return (
		<aside
			className={cn("relative my-6 py-3 pr-5 pl-4", className)}
			// the paper takes a faint wash of the tone, so a trap reads apart from a result at a glance
			style={{ background: `color-mix(in oklab, ${t.c} 7%, transparent)` }}
		>
			<svg
				viewBox="0 0 6 100"
				preserveAspectRatio="none"
				className="absolute top-1 bottom-1 left-0 w-1.5 overflow-visible [&_path]:[vector-effect:non-scaling-stroke]"
				aria-hidden="true"
			>
				<SketchPath
					d="M3 0L3 100"
					seed={`callout-${tone}-${title ?? ""}`}
					color={t.c}
					width={2}
					passes={1}
					tolerance={1.2}
				/>
			</svg>
			<p
				className="gb-caps mb-1 text-[11px] tracking-[0.16em]"
				style={{ color: t.c }}
			>
				{title ?? t.label}
			</p>
			<div className="text-[16px] leading-[24px] text-[var(--gb-ink)] [&_code]:bg-[var(--gb-paper-deep)] [&_code]:px-1 [&_code]:font-mono [&_code]:text-[13px]">
				{children}
			</div>
		</aside>
	);
}
