import type { ReactNode } from "react";
import { cn } from "#/lib/utils";

const TONES = {
	note: { label: "Note", c: "var(--accent)" },
	lesson: { label: "Lesson", c: "var(--rigi-lesson)" },
	warning: { label: "Trap", c: "var(--rigi-trap)" },
	result: { label: "Result", c: "var(--rigi-result)" },
	negative: { label: "Negative result", c: "var(--rigi-negative)" },
} as const;

/** Margin-rule callout. tone: note | lesson | warning | result | negative. */
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
			className={cn(
				"my-7 rounded-r-xl border-l-2 bg-white/[0.035] py-3.5 pr-5 pl-5",
				className,
			)}
			style={{ borderColor: t.c }}
		>
			<p
				className="mb-1 font-mono text-[10.5px] tracking-[0.16em] uppercase"
				style={{ color: t.c }}
			>
				{title ?? t.label}
			</p>
			<div className="text-[14.5px] leading-relaxed text-white/72 [&_code]:rounded [&_code]:bg-white/8 [&_code]:px-1 [&_code]:font-mono [&_code]:text-[12.5px]">
				{children}
			</div>
		</aside>
	);
}
