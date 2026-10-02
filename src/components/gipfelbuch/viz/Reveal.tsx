// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { ReactNode } from "react";
import { cn } from "#/lib/utils";
import { useInView } from "./hooks";

/**
 * Fade-and-rise on first view. The static state is the design (A1): useInView reports "on" at once
 * without IntersectionObserver, under reduced motion, under webdriver and before printing.
 */
export function Reveal({
	children,
	className,
	as: Tag = "div",
}: {
	children: ReactNode;
	className?: string;
	as?: "div" | "section";
}) {
	const [ref, on] = useInView();
	return (
		<Tag
			ref={ref}
			className={cn(
				"transition duration-1000 ease-out motion-reduce:transition-none print:translate-y-0 print:opacity-100",
				on ? "translate-none opacity-100" : "translate-y-6 opacity-0",
				className,
			)}
		>
			{children}
		</Tag>
	);
}
