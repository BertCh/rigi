// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { RigiMark } from "#/brand/RigiMark";
import { cn } from "#/lib/utils";
import { ThemeToggle } from "./ThemeToggle";

/** Page chrome shared by the marketing pages: theme tokens on <main> plus the top bar. */
export const SITE_THEME =
	"min-h-dvh bg-[var(--rigi-ink)] text-[var(--rigi-paper)]";

/**
 * `variant="paper"` is for Gipfelbuch routes: a paper ground with ink text, independent of the
 * site theme (the Gipfelbuch sheet is always paper). Default is the site ground.
 */
export function SiteNav({
	active,
	variant = "site",
}: {
	active?: "library" | "gipfelbuch";
	variant?: "site" | "paper";
}) {
	const paper = variant === "paper";
	const item = (on: boolean) =>
		cn(
			"rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
			paper
				? on
					? "bg-[var(--khipu-lk)]/8 text-[var(--khipu-lk)]"
					: "text-[var(--khipu-lk)]/60 hover:text-[var(--khipu-lk)]"
				: on
					? "bg-white/8 text-[var(--rigi-paper)]"
					: "text-white/55 hover:text-[var(--rigi-paper)]",
		);
	return (
		<nav
			className={cn(
				"mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 pt-6 sm:px-8",
				paper && "bg-[var(--khipu-w)] pb-4 text-[var(--khipu-lk)]",
			)}
		>
			<Link to="/" className="flex items-center gap-2.5">
				<RigiMark className="size-7" />
				<span className="text-[17px] font-semibold tracking-[-0.01em]">
					Rigi
				</span>
			</Link>
			<div className="flex items-center gap-1">
				<a href="/#how" className={item(false)}>
					How it works
				</a>
				<Link to="/library" className={item(active === "library")}>
					My library
				</Link>
				<Link to="/gipfelbuch" className={item(active === "gipfelbuch")}>
					Gipfelbuch
				</Link>
				<ThemeToggle
					className={
						paper
							? "text-[var(--khipu-lk)]/60 hover:text-[var(--khipu-lk)]"
							: undefined
					}
				/>
			</div>
		</nav>
	);
}
