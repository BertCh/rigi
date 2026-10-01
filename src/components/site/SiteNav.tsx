// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { Link } from "@tanstack/react-router";
import { RigiMark } from "#/brand/RigiMark";
import { cn } from "#/lib/utils";

/** Page chrome shared by the marketing pages: theme tokens on <main> plus the top bar. */
export const SITE_THEME =
	"min-h-dvh bg-[var(--rigi-ink)] text-[var(--rigi-paper)]";

export function SiteNav({ active }: { active?: "library" | "atlas" }) {
	const item = (on: boolean) =>
		cn(
			"rounded-lg px-2.5 py-1.5 text-xs font-medium transition",
			on
				? "bg-white/8 text-[var(--rigi-paper)]"
				: "text-white/55 hover:text-[var(--rigi-paper)]",
		);
	return (
		<nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 pt-6 sm:px-8">
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
				<Link to="/atlas" className={item(active === "atlas")}>
					Atlas
				</Link>
			</div>
		</nav>
	);
}
