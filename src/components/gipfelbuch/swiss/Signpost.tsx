// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import {
	type ReactNode,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { Hachure, PenLine, SketchPolyline, SketchRect } from "../notebook/Ink";
import type { Point } from "../notebook/sketch";

export interface SignpostProps {
	direction: "prev" | "next";
	/** Small caps line, e.g. "Vorher" / "Next". */
	kicker: string;
	/** The destination. */
	title: string;
	/** The distance, written right-aligned like a Wegweiser time, e.g. "1 Blatt". */
	subtitle?: string;
	/** Extra content below the subtitle. */
	children?: ReactNode;
	/** Trail category of the tip stripes: Wanderweg (yellow), Bergwanderweg (white-red-white, default), Alpinwanderweg (white-blue-white). */
	kind?: "hike" | "mountain" | "alpine";
	/** Standortfeld under the sign: where the reader stands now (S16). */
	here?: { name: string; detail?: string };
	className?: string;
}

/** Measured box of the sign (the drawing follows the text, so it is re-drawn when the text wraps). */
function useBox<T extends HTMLElement>(initial: [number, number]) {
	const ref = useRef<T | null>(null);
	const [box, setBox] = useState(initial);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const update = () => {
			const rect = element.getBoundingClientRect();
			if (rect.width > 0 && rect.height > 0)
				setBox([Math.round(rect.width), Math.round(rect.height)]);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return [ref, box] as const;
}

const TIP_STRIPE = {
	hike: null,
	mountain: "var(--gb-red)",
	alpine: "var(--gb-navy)",
} as const;

/**
 * A hand-drawn Wegweiser (S16): a pen-outlined arrow sign filled with yellow pencil hatch, its tip
 * striped per trail category, the destination in hand capitals and the distance right-aligned like
 * a walking time, with an optional Standortfeld plate under it. Presentational: callers wrap it in a
 * Link, so the link semantics stay with the caller.
 */
export function Signpost({
	direction,
	kicker,
	title,
	subtitle,
	children,
	kind = "mountain",
	here,
	className,
}: SignpostProps) {
	const next = direction === "next";
	const clip = useId().replace(/:/g, "");
	const [ref, [w, h]] = useBox<HTMLDivElement>([360, 76]);
	const tip = Math.min(44, h * 0.62);
	const seed = `wegweiser-${direction}-${title}`;
	// sign outline, pointing right; mirrored for prev
	const flip = (p: Point): Point => (next ? p : [w - p[0], p[1]]);
	const outline: Point[] = [
		[1.5, 2],
		[w - tip, 1.5],
		[w - 1.5, h / 2],
		[w - tip, h - 1.5],
		[1.5, h - 2],
	].map((p) => flip(p as Point));
	const shape = `${outline.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join("")}Z`;
	const stripe = TIP_STRIPE[kind];
	const tipX0 = next ? w - tip - 8 : 0;
	const tipW = tip + 8;
	return (
		<div className={`relative block ${className ?? ""}`}>
			<div ref={ref} className="relative">
				<svg
					className="pointer-events-none absolute inset-0 overflow-visible"
					width={w}
					height={h}
					viewBox={`0 0 ${w} ${h}`}
					aria-hidden="true"
				>
					<defs>
						<clipPath id={clip}>
							<path d={shape} />
						</clipPath>
					</defs>
					{/* yellow pencil: a pale wash under a 30 degree hatch */}
					<path
						d={shape}
						fill="color-mix(in srgb, var(--gb-sign-light) 55%, var(--gb-paper))"
					/>
					<Hachure
						d={shape}
						seed={`${seed}-hatch`}
						color="var(--gb-sign)"
						width={1.3}
						opacity={0.55}
						angle={-30}
						gap={4.2}
					/>
					{stripe ? (
						<g clipPath={`url(#${clip})`}>
							<rect
								x={tipX0}
								y={0}
								width={tipW}
								height={h}
								fill="var(--gb-paper)"
							/>
							<Hachure
								d={`M${tipX0} ${h / 3}h${tipW}v${h / 3}h${-tipW}Z`}
								seed={`${seed}-stripe`}
								color={stripe}
								width={1.6}
								opacity={0.9}
								angle={-30}
								gap={1.9}
							/>
						</g>
					) : null}
					{stripe ? (
						<PenLine
							from={[next ? tipX0 : tipW, 3]}
							to={[next ? tipX0 : tipW, h - 3]}
							seed={`${seed}-tipline`}
							width={0.9}
							opacity={0.8}
						/>
					) : null}
					<SketchPolyline
						points={outline}
						closed
						seed={`${seed}-outline`}
						color="ink"
						width={1.5}
						tolerance={1.1}
					/>
				</svg>
				<div
					className={`relative flex items-center gap-4 py-3 ${next ? "flex-row pl-4 text-left" : "flex-row-reverse pr-4 text-right"}`}
					style={next ? { paddingRight: tip + 14 } : { paddingLeft: tip + 14 }}
				>
					<div
						className={`flex min-w-0 flex-1 flex-col gap-0.5 ${next ? "items-start" : "items-end"}`}
					>
						<span className="nb-label text-[12px] leading-[14px] tracking-[0.12em] text-[var(--gb-ink)]">
							{kicker}
						</span>
						<span
							className="nb-label text-[19px] leading-[22px] text-[var(--gb-ink)]"
							style={{ fontWeight: 600, letterSpacing: "0.04em" }}
						>
							{title}
						</span>
						{children}
					</div>
					{subtitle ? (
						<span className="nb-num shrink-0 text-[15px] whitespace-nowrap text-[var(--gb-ink)]">
							{subtitle}
						</span>
					) : null}
				</div>
			</div>
			{here ? (
				<div className={`mt-1 flex ${next ? "justify-start" : "justify-end"}`}>
					<span className="relative inline-flex flex-col px-3 py-1">
						<svg
							className="pointer-events-none absolute inset-0 size-full overflow-visible [&_path]:[vector-effect:non-scaling-stroke]"
							viewBox="0 0 100 40"
							preserveAspectRatio="none"
							aria-hidden="true"
						>
							<rect width="100" height="40" fill="var(--gb-white)" />
							<SketchRect
								x={0}
								y={0}
								width={100}
								height={40}
								seed={`${seed}-standort`}
								penWidth={1}
								tolerance={0.6}
							/>
						</svg>
						<span className="nb-label relative text-[12px] leading-[14px] text-[var(--gb-ink)]">
							{here.name}
						</span>
						{here.detail ? (
							<span className="nb-num relative text-[11px] leading-[13px] italic text-[var(--gb-ink)]">
								{here.detail}
							</span>
						) : null}
					</span>
				</div>
			) : null}
		</div>
	);
}
