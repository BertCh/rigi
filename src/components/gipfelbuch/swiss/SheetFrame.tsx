// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";

export interface SheetFrameProps {
	children: ReactNode;
	/** Sheet number, e.g. "07". */
	sheet?: string;
	/** Total sheets, e.g. "19". */
	total?: string;
	/** Sheet title shown in the sheet block. */
	title?: string;
	/** LV95 corner labels (shown from sm up). Pass null to hide. */
	corners?: { east: string; north: string } | null;
	/** Imprint line in the bottom margin. */
	imprint?: string;
	/** Publication stand, e.g. "2026-10"; appended to the imprint as "Stand". */
	stand?: string;
	/** Edition, e.g. "2026"; appended to the imprint as "Ausgabe". */
	edition?: string;
	/** LK sheet-edge neighbour notes at mid-height of the left and right edges (sm up). */
	crossRefs?: { prev?: ReactNode; next?: ReactNode };
	className?: string;
}

/** Group digits in threes with thin spaces: "2627000" -> "2 627 000". */
export function formatLv95(value: string | number): string {
	return String(value)
		.replace(/\s/g, "")
		.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * An LV95 corner value written by hand (S14): italic hand figures in pencil, the leading 2 or 1
 * a size smaller, as on the old LK sheet ticks.
 */
function HandCoordinate({ value, axis }: { value: string; axis: "E" | "N" }) {
	const text = formatLv95(value);
	return (
		<span
			className="nb-num whitespace-nowrap text-[13px] leading-none italic"
			style={{ color: "var(--gb-pencil)" }}
		>
			<span className="nb-label mr-1 not-italic text-[11px]">{axis}</span>
			<span className="text-[10px]">{text.slice(0, 1)}</span>
			{text.slice(1)}
		</span>
	);
}

/**
 * Map-sheet identity without strokes, written by hand: the LV95 corner values in pencil (corners
 * only, no ticks along the edges), a hand-lettered Blatt number and a pencil imprint line (S30).
 */
export function SheetFrame({
	children,
	sheet,
	total,
	title,
	corners = null,
	imprint,
	stand,
	crossRefs,
	className,
}: SheetFrameProps) {
	let imprintLine = imprint;
	if (imprintLine && stand && !imprintLine.includes("Stand")) {
		imprintLine += ` · Stand ${stand}`;
	}
	return (
		<div
			className={`gb-swiss relative px-4 sm:px-0 ${className ?? ""}`}
			// A3: the frame persists across a concept-to-concept view transition (see theme.css).
			style={{ viewTransitionName: "gb-sheet" }}
		>
			{/* the soft grid is the sheet's ground (user, softer sheet: "keep the grid paper") */}
			<div
				// the geo spill around a hero photo runs past the sheet to the window edge, as on the landing
				className="nb-book relative mx-auto max-w-6xl sm:px-0"
			>
				<div className="relative sm:p-[22px]">
					{corners ? (
						<>
							<span className="absolute left-[30px] top-[6px] hidden bg-[var(--gb-paper)] px-1 sm:block">
								<HandCoordinate value={corners.east} axis="E" />
							</span>
							<span className="absolute bottom-[6px] right-[30px] hidden bg-[var(--gb-paper)] px-1 sm:block">
								<HandCoordinate value={corners.north} axis="N" />
							</span>
						</>
					) : null}
					{crossRefs?.prev ? (
						<span
							className="nb-hand absolute left-[10px] top-1/2 hidden -translate-y-1/2 rotate-180 whitespace-nowrap text-[16px] leading-none text-[var(--gb-pencil)] sm:block"
							style={{ writingMode: "vertical-rl" }}
						>
							{crossRefs.prev}
						</span>
					) : null}
					{crossRefs?.next ? (
						<span
							className="nb-hand absolute right-[10px] top-1/2 hidden -translate-y-1/2 whitespace-nowrap text-[16px] leading-none text-[var(--gb-pencil)] sm:block"
							style={{ writingMode: "vertical-rl" }}
						>
							{crossRefs.next}
						</span>
					) : null}
					<div className="relative">
						{sheet ? (
							<div
								className="absolute right-0 top-0 z-10 hidden flex-col items-center px-3 py-1.5 text-center sm:flex"
								style={{ background: "var(--gb-paper)" }}
							>
								<span className="nb-label mb-0.5 text-[12px] tracking-[0.14em]">
									Blatt
								</span>
								<span className="nb-num text-[24px] leading-none">
									<span className="mx-1 text-[var(--gb-red)]">{sheet}</span>
									{total ? (
										<span className="gb-secondary text-[16px]"> / {total}</span>
									) : null}
								</span>
								{title ? (
									<span className="nb-hand mt-0.5 max-w-[11rem] truncate text-[17px] leading-[20px]">
										{title}
									</span>
								) : null}
							</div>
						) : null}
						{children}
					</div>
					{imprintLine ? (
						<p
							className="nb-hand-small mt-3 text-left text-[12px] leading-snug sm:pb-0.5"
							style={{ color: "var(--gb-pencil)" }}
						>
							{imprintLine}
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
