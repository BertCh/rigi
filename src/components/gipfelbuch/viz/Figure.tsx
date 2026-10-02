// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { CSSProperties, ReactNode } from "react";
import { cn } from "#/lib/utils";
import { TYPE } from "../swiss/type";
import { type GroundPalette, type GroundSurface, groundVars } from "./ground";
import { HandSideRule, HandUnderline, seedUnit } from "./hand";
import { useInView } from "./hooks";

/** Provenance: Aufnahme (the source, with id and date). Only the source is printed. */
export interface FigureImprint {
	aufnahme?: string;
	revision?: string;
	stich?: string;
}

const formatImprint = (imprint: FigureImprint) =>
	imprint.aufnahme ? `Aufnahme ${imprint.aufnahme}` : "";

/**
 * A drawing on the sheet, separated by space: no fill, no padding, no outline. Hand pass: "Fig. n" (the
 * `number`, else the `label`) is lettered by hand at the figure's top-left, and the caption is a hand
 * note under it (Caveat), not a typeset line. Fades in on first view. `bleed` lets it span wider than
 * prose. `well` gives an interactive figure the paper-deep ground, where the ground carries state.
 */
export function Figure({
	children,
	caption,
	label,
	className,
	bleed,
	plate = false,
	pad = true,
	well = false,
	source,
	reading,
	number,
	imprint,
	printCaption = false,
	pinned,
	ground,
	surface = "paper",
}: {
	children: ReactNode;
	caption?: ReactNode;
	label?: string;
	className?: string;
	bleed?: boolean;
	pad?: boolean;
	/** Paper-deep ground plus padding, for interactive figures (default off). `pad` applies only with `well`. */
	well?: boolean;
	/**
	 * KR3: the hero's plate, a paper-deep ground across the full sheet track (as the Tafel's), so a
	 * spilled photo (`RealPhoto bleed`) or a hillshade sits on its own ground. Implies `bleed`.
	 */
	plate?: boolean;
	/** Run, photo or report id the figure was made from. */
	source?: string;
	/** A "how to read" key, as on the back of a Dear Data card. */
	reading?: ReactNode;
	/** Figure number, shown in place of the label. */
	number?: string;
	/** Siegfried imprint (F2): provenance as one micro line under the caption. */
	imprint?: FigureImprint;
	/** Set a long, dense caption in the body hand (Playpen) instead of the Caveat note hand. */
	printCaption?: boolean;
	/** The demo photo the figure is fixed on ("demo-10"): a small hand chip "demo-10 · pinned" before the caption. */
	pinned?: string;
	/**
	 * Grammar §3: the photo whose tones the ground takes ("demo-09", or a palette). Sets the `--fig-*`
	 * vars (wash, sky, terrain and horizon inks, halo) on the figure; the plate and well read `--fig-wash`.
	 * The photo itself is never filtered. Without it the vars are unset and every reader falls back.
	 */
	ground?: string | GroundPalette;
	/** The ground the vars are computed for: the paper sheet (default) or a dark plate island. */
	surface?: GroundSurface;
}) {
	const [ref, on] = useInView();
	const lettering = number ?? label;
	const seed = `fig-${lettering ?? ""}-${typeof caption === "string" ? caption.slice(0, 24) : ""}`;
	const vars = ground
		? (groundVars(ground, surface) as CSSProperties)
		: undefined;
	return (
		<figure
			ref={ref}
			style={vars}
			data-ground={
				vars ? (typeof ground === "string" ? ground : "custom") : undefined
			}
			className={cn(
				"my-12 transition duration-1000 ease-out motion-reduce:transition-none print:translate-y-0 print:opacity-100",
				on
					? "translate-none opacity-100"
					: "translate-y-5 opacity-0 print:translate-y-0 print:opacity-100",
				// R1 (reports/gipfelbuch-regression-2026-10-01.md): figures use the wide track. The prose
				// column is ConceptPage's columns 3-8 (6 cols, 24 px gaps); columns 9-12 add 66.667% + 16px
				// of it, columns 1-2 add 33.333% + 8px. Prose and MarginNote keep their own widths.
				"lg:mr-[calc(-66.667%-16px)]",
				(bleed || plate) && "lg:ml-[calc(-33.333%-8px)]",
				className,
			)}
		>
			{lettering && (
				<p
					className="nb-hand mb-2 inline-block origin-bottom-left px-0.5 text-[22px] leading-[26px] font-bold text-[var(--gb-ink)]"
					style={{ rotate: `${(seedUnit(seed) - 0.7) * 2.4}deg` }}
				>
					<span className="relative inline-block">
						{/^(fig|abb|tab|taf)/i.test(lettering)
							? lettering
							: `Fig. ${lettering}`}
						<HandUnderline
							seed={seed}
							color="red"
							width={1.8}
							coverage={0.92}
							offset={-3}
						/>
					</span>
				</p>
			)}
			<div
				className={cn(
					"relative",
					(well || plate) &&
						"bg-[var(--fig-wash,var(--gb-paper-deep,transparent))] print:bg-transparent",
					well && pad && "p-6",
					plate && "px-4 py-6 sm:px-6",
				)}
			>
				{children}
			</div>
			{(caption || source || imprint || pinned) && (
				<figcaption className="mt-3 px-0.5">
					<div className="flex items-baseline gap-3">
						{pinned && (
							<span className="nb-hand relative shrink-0 px-1.5 text-[17px] leading-[22px] text-[var(--gb-secondary,#4a545c)]">
								{pinned}
								<HandUnderline
									seed={`${seed}-pinned`}
									color="pencil"
									width={1.2}
									coverage={1}
									offset={-2}
								/>
							</span>
						)}
						{caption && (
							<span
								className={cn(
									"min-w-0 max-w-[72ch] text-[var(--gb-pencil,var(--gb-ink))]",
									printCaption
										? "text-[14px] leading-[20px]"
										: "nb-hand text-[20px] leading-[24px]",
								)}
							>
								{caption}
							</span>
						)}
						{source && (
							<span
								className={`${TYPE.micro} ml-auto shrink-0 pl-3 text-right`}
							>
								{source}
							</span>
						)}
					</div>
					{imprint && (
						<p className={`${TYPE.micro} gb-secondary mt-1.5`}>
							{formatImprint(imprint)}
						</p>
					)}
				</figcaption>
			)}
			{reading && (
				<div className="relative mt-4 py-1 pl-5 text-[14px] leading-[20px] text-[var(--gb-ink)]">
					<HandSideRule seed={`${seed}-reading`} color="pencil" width={1.4} />
					<p className="nb-hand mb-0.5 text-[20px] leading-[24px] text-[var(--gb-contour,var(--gb-ink))]">
						How to read it
					</p>
					{reading}
				</div>
			)}
		</figure>
	);
}
