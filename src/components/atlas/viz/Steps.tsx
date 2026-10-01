import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import { useInView } from "./hooks";

export interface FlowNode {
	label: string;
	sub?: string;
	/** CSS colour for the node's dot; defaults to the page accent. */
	color?: string;
}

/**
 * Horizontal pipeline of boxes joined by animated arrows (wraps on phones).
 *   <Flow nodes={[{label:"EXIF", sub:"GPS + lens"},{label:"Solve"},{label:"Overlay"}]} />
 */
export function Flow({
	nodes,
	className,
}: {
	nodes: FlowNode[];
	className?: string;
}) {
	const [ref, on] = useInView();
	return (
		<div
			ref={ref}
			className={cn(
				"flex flex-wrap items-stretch justify-center gap-y-3",
				className,
			)}
		>
			{nodes.map((n, i) => (
				<div key={n.label} className="flex items-center">
					<div
						className={cn(
							"min-w-[104px] rounded-xl bg-white/[0.05] px-3.5 py-2.5 ring-1 ring-white/10 transition duration-700 motion-reduce:transition-none",
							on ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
						)}
						style={{ transitionDelay: `${i * 110}ms` }}
					>
						<div className="flex items-center gap-2 text-[13px] font-semibold text-[var(--rigi-paper)]">
							<span
								className="size-1.5 rounded-full"
								style={{ background: n.color ?? "var(--accent)" }}
							/>
							{n.label}
						</div>
						{n.sub && (
							<div className="mt-0.5 text-[11.5px] leading-snug text-white/45">
								{n.sub}
							</div>
						)}
					</div>
					{i < nodes.length - 1 && (
						<svg
							width="34"
							height="12"
							viewBox="0 0 34 12"
							className="mx-0.5 shrink-0 text-[var(--accent)]"
							aria-hidden="true"
						>
							<path
								d="M1 6 H27"
								stroke="currentColor"
								strokeWidth="1.4"
								strokeDasharray="3 3"
								opacity="0.8"
							>
								<animate
									attributeName="stroke-dashoffset"
									from="12"
									to="0"
									dur="1.4s"
									repeatCount="indefinite"
								/>
							</path>
							<path
								d="M25 2 L32 6 L25 10"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.4"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					)}
				</div>
			))}
		</div>
	);
}

/** Numbered vertical steps with a hairline spine. Children of each step are free-form. */
export function Steps({
	steps,
	className,
}: {
	steps: { title: string; body: ReactNode }[];
	className?: string;
}) {
	return (
		<ol className={cn("my-7 space-y-0", className)}>
			{steps.map((s, i) => (
				<li key={s.title} className="relative flex gap-4 pb-6 last:pb-0">
					{i < steps.length - 1 && (
						<span
							className="absolute top-8 bottom-0 left-[13px] w-px bg-white/10"
							aria-hidden="true"
						/>
					)}
					<span className="z-10 grid size-7 shrink-0 place-items-center rounded-full bg-[var(--rigi-ink)] font-mono text-[11px] text-[var(--accent)] ring-1 ring-[var(--accent)]/60">
						{i + 1}
					</span>
					<div className="min-w-0 pt-0.5">
						<h4 className="text-[14.5px] font-semibold text-[var(--rigi-paper)]">
							{s.title}
						</h4>
						<div className="mt-1 text-[14px] leading-relaxed text-white/62">
							{s.body}
						</div>
					</div>
				</li>
			))}
		</ol>
	);
}
