// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import { TYPE } from "../swiss/type";
import { HandSideRule, HandUnderline, seedUnit } from "./hand";
import { useInView } from "./hooks";

/** Provenance roles: Aufnahme (source), Revision (measuring stage), Stich (renderer). */
export interface FigureImprint {
	aufnahme?: string;
	revision?: string;
	stich?: string;
}

const formatImprint = (imprint: FigureImprint) =>
	[
		imprint.aufnahme && `Aufnahme ${imprint.aufnahme}`,
		imprint.revision && `Revision ${imprint.revision}`,
		imprint.stich && `Stich ${imprint.stich}`,
	]
		.filter(Boolean)
		.join(" · ");

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
}) {
	const [ref, on] = useInView();
	const lettering = number ?? label;
	const seed = `fig-${lettering ?? ""}-${typeof caption === "string" ? caption.slice(0, 24) : ""}`;
	return (
		<figure
			ref={ref}
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
					(well || plate) && "bg-[var(--gb-paper-deep,transparent)]",
					well && pad && "p-6",
					plate && "px-4 py-6 sm:px-6",
				)}
			>
				{children}
			</div>
			{(caption || source || imprint) && (
				<figcaption className="mt-3 px-0.5">
					<div className="flex items-baseline gap-3">
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
						how to read it →
					</p>
					{reading}
				</div>
			)}
		</figure>
	);
}
