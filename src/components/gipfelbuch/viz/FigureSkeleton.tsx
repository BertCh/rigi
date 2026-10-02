// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { cn } from "#/lib/utils";

/**
 * The placeholder of a figure whose data is still loading: a paper-deep ground of the figure's aspect
 * (so the page does not jump when the photo arrives) with a gentle pulse, still under reduced motion.
 * A failed fetch (`failedId`) stops the pulse and says so by hand instead of waiting for ever.
 */
export function FigureSkeleton({
	aspect = 4 / 3,
	failedId,
	className,
}: {
	/** Width / height. */
	aspect?: number;
	/** The id that could not be loaded: replaces the pulse with a hand note. */
	failedId?: string | null;
	className?: string;
}) {
	return (
		<div
			role={failedId ? "status" : undefined}
			aria-busy={failedId ? undefined : true}
			className={cn(
				"flex w-full items-center justify-center bg-[var(--gb-paper-deep,#e6e1d6)]",
				!failedId && "animate-pulse motion-reduce:animate-none",
				className,
			)}
			style={{ aspectRatio: String(aspect) }}
		>
			{failedId && (
				<p className="nb-hand px-3 text-center text-[19px] leading-[23px] text-[var(--gb-secondary,#4a545c)]">
					Couldn't load {failedId}
				</p>
			)}
		</div>
	);
}
