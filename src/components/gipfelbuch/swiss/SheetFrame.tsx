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
 * Map-sheet identity without strokes: LV95 corner labels, a typographic Blatt number and an imprint line.
 */
export function SheetFrame({
	children,
	sheet,
	total,
	title,
	corners = null,
	imprint,
	stand,
	edition,
	crossRefs,
	className,
}: SheetFrameProps) {
	let imprintLine = imprint;
	if (imprintLine && stand && !imprintLine.includes("Stand")) {
		imprintLine += `${edition ? ` · Ausgabe ${edition}` : ""} · Stand ${stand}`;
	}
	return (
		<div
			className={`gb-swiss relative px-4 sm:px-0 ${className ?? ""}`}
			// A3: the frame persists across a concept-to-concept view transition (see theme.css).
			style={{ viewTransitionName: "gb-sheet" }}
		>
			{/* the soft grid is the sheet's ground (user, softer sheet: "keep the grid paper") */}
			<div className="nb-book relative mx-auto max-w-6xl sm:px-0">
				<div className="relative sm:p-[22px]">
					{corners ? (
						<>
							<span
								className="gb-coord absolute left-[30px] top-[8px] hidden whitespace-nowrap bg-[var(--gb-paper)] px-1 text-[11px] leading-none sm:block"
								style={{ color: "var(--gb-secondary,#4a545c)" }}
							>
								{formatLv95(corners.east)}
							</span>
							<span
								className="gb-coord absolute bottom-[8px] right-[30px] hidden whitespace-nowrap bg-[var(--gb-paper)] px-1 text-[11px] leading-none sm:block"
								style={{ color: "var(--gb-secondary,#4a545c)" }}
							>
								{formatLv95(corners.north)}
							</span>
						</>
					) : null}
					{crossRefs?.prev ? (
						<span
							className="gb-caps absolute left-[10px] top-1/2 hidden -translate-y-1/2 rotate-180 whitespace-nowrap text-[11px] leading-none sm:block"
							style={{ writingMode: "vertical-rl" }}
						>
							{crossRefs.prev}
						</span>
					) : null}
					{crossRefs?.next ? (
						<span
							className="gb-caps absolute right-[10px] top-1/2 hidden -translate-y-1/2 whitespace-nowrap text-[11px] leading-none sm:block"
							style={{ writingMode: "vertical-rl" }}
						>
							{crossRefs.next}
						</span>
					) : null}
					<div className="relative">
						{sheet ? (
							<div
								className="gb-caps absolute right-0 top-0 z-10 hidden flex-col items-center px-3 py-1.5 text-center sm:flex"
								style={{ background: "var(--gb-paper)" }}
							>
								<span className="mb-0.5 text-[11px] tracking-[0.18em]">
									Blatt
								</span>
								<span
									className="gb-coord text-[20px] leading-none"
									style={{ fontWeight: 600, color: "var(--gb-ink)" }}
								>
									<span className="mx-1 text-[var(--gb-red)]">{sheet}</span>
									{total ? (
										<span className="gb-secondary"> / {total}</span>
									) : null}
								</span>
								{title ? (
									<span className="mt-0.5 max-w-[11rem] truncate text-[11px] tracking-[0.12em]">
										{title}
									</span>
								) : null}
							</div>
						) : null}
						{children}
					</div>
					{imprintLine ? (
						<p className="gb-caps gb-secondary mt-3 text-left text-[11px] leading-snug tracking-[0.14em] sm:pb-0.5">
							{imprintLine}
						</p>
					) : null}
				</div>
			</div>
		</div>
	);
}
