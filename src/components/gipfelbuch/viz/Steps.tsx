// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import { PenArrow, SketchPath, StepNumber } from "../notebook/Ink";
import { useInView } from "./hooks";

export interface FlowNode {
	label: string;
	sub?: string;
	/** CSS colour (or ink name) for the node's circled number; defaults to the red pen. */
	color?: string;
}

/**
 * Pipeline of hand stations (a circled number and a lettered name, no boxes) joined by pen arrows. Horizontal from 560 px of
 * container width, vertical (arrows pointing down) below.
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
		<div ref={ref} className={cn("[container-type:inline-size]", className)}>
			<div className="flex flex-col items-stretch gap-0 [@container(min-width:560px)]:flex-row [@container(min-width:560px)]:flex-wrap [@container(min-width:560px)]:items-stretch [@container(min-width:560px)]:justify-center [@container(min-width:560px)]:gap-y-3">
				{nodes.map((n, i) => (
					<div
						key={n.label}
						className="flex flex-col items-stretch [@container(min-width:560px)]:flex-row [@container(min-width:560px)]:items-center"
					>
						<div
							className={cn(
								"flex min-w-[104px] items-start gap-2 px-2 py-2 transition duration-700 motion-reduce:transition-none [@container(min-width:560px)]:h-full",
								on
									? "translate-y-0 opacity-100"
									: "translate-y-3 opacity-0 print:translate-y-0 print:opacity-100",
							)}
							style={{ transitionDelay: `${i * 110}ms` }}
						>
							<StepNumber value={String(i + 1)} color={n.color ?? "red"} />
							<div className="min-w-0 pt-0.5">
								<div className="nb-hand text-[21px] leading-[24px] font-bold text-[var(--gb-ink)]">
									{n.label}
								</div>
								{n.sub && (
									<div className="mt-0.5 text-[13px] leading-[18px] text-[var(--gb-secondary,#4a545c)]">
										{n.sub}
									</div>
								)}
							</div>
						</div>
						{i < nodes.length - 1 && (
							<>
								<svg
									width="14"
									height="26"
									viewBox="0 0 14 26"
									className="mx-auto shrink-0 overflow-visible [@container(min-width:560px)]:hidden"
									aria-hidden="true"
								>
									<PenArrow
										seed={`flow-arrow-v-${n.label}`}
										from={[7, 1]}
										to={[7, 23]}
										bend={0.08}
										color={i === nodes.length - 2 ? "red" : "ink"}
										width={1.4}
									/>
								</svg>
								<svg
									width="30"
									height="14"
									viewBox="0 0 30 14"
									className="hidden shrink-0 overflow-visible [@container(min-width:560px)]:block"
									aria-hidden="true"
								>
									<PenArrow
										seed={`flow-arrow-${n.label}`}
										from={[1, 7]}
										to={[27, 7]}
										bend={0.12}
										color={i === nodes.length - 2 ? "red" : "ink"}
										width={1.4}
									/>
								</svg>
							</>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

export interface StepItem {
	title: string;
	body: ReactNode;
	/** Pitch column, right-aligned, e.g. "38 ms / ok". */
	grade?: string;
	/** Line style of the segment below the step: solid (default), dashed or dotted. */
	certainty?: "measured" | "approximate" | "open";
}

const CERTAINTY_DASH = {
	measured: undefined,
	approximate: "4 2",
	open: "0.8 5",
} as const;

/**
 * A route topo (SAC style) drawn by hand: a red pen route line down the left, a circled hand station
 * number per step and an optional grade at the right. The segment below a step is solid (measured),
 * dashed (approximate) or dotted (open); the last station is the summit register, circled in ink.
 */
export function Steps({
	steps,
	className,
}: {
	steps: StepItem[];
	className?: string;
}) {
	return (
		<ol className={cn("my-6 space-y-0", className)}>
			{steps.map((s, i) => {
				const last = i === steps.length - 1;
				return (
					<li
						key={s.title}
						className="relative grid grid-cols-[36px_minmax(0,1fr)] gap-x-3 pb-8 last:pb-0"
					>
						<div className="relative">
							{!last && (
								<svg
									viewBox="0 0 16 100"
									preserveAspectRatio="none"
									className="absolute top-[38px] -bottom-[2px] left-[10px] w-4 overflow-visible [&_path]:[vector-effect:non-scaling-stroke]"
									aria-hidden="true"
								>
									<SketchPath
										d="M8 0L8 100"
										seed={`steps-route-${s.title}`}
										color="var(--gb-red)"
										width={2}
										dash={CERTAINTY_DASH[s.certainty ?? "measured"]}
										passes={s.certainty === "open" ? 1 : 2}
										tolerance={1.1}
									/>
								</svg>
							)}
							<StepNumber value={String(i + 1)} color={last ? "ink" : "red"} />
						</div>
						<div className="min-w-0 pt-0.5">
							<div className="flex items-baseline justify-between gap-3">
								<h4 className="nb-hand text-[22px] leading-[28px] font-bold text-[var(--gb-ink)]">
									{s.title}
								</h4>
								{s.grade && (
									<span className="nb-num shrink-0 text-[13px] text-[var(--gb-secondary,#4a545c)]">
										{s.grade}
									</span>
								)}
							</div>
							<div className="text-[16px] leading-[24px] text-[var(--gb-ink)]">
								{s.body}
							</div>
						</div>
					</li>
				);
			})}
		</ol>
	);
}
