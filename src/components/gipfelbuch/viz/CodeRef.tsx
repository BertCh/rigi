// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { cn } from "#/lib/utils";
import { SketchPath } from "../notebook/Ink";
import { HandUnderline } from "./hand";

/**
 * A repo path: the path itself stays in print (mono, it must be exact), the rest is drawn by hand: a pen
 * glyph (a dog-eared page for reports/ and .md, angle brackets for code) and a pencil underline instead
 * of a chip.
 */
export function CodeRef({
	path,
	className,
	children,
}: {
	path: string;
	className?: string;
	children?: string;
}) {
	const doc = path.endsWith(".md") || path.startsWith("reports/");
	return (
		<span
			className={cn(
				"relative inline-flex max-w-full items-center gap-1.5 px-0.5 py-0.5 font-mono text-[12px] leading-none text-[var(--gb-ink)]",
				className,
			)}
			title={path}
		>
			<svg
				viewBox="0 0 12 14"
				className="h-3.5 w-3 shrink-0 overflow-visible"
				aria-hidden="true"
			>
				<SketchPath
					d={
						doc
							? "M2 1L7.5 1L10.5 4L10.5 13L2 13Z M7.5 1L7.5 4L10.5 4 M4 7L8.5 7 M4 9.6L8 9.6"
							: "M4.5 3L1 7L4.5 11 M7.5 3L11 7L7.5 11"
					}
					seed={`coderef-${doc ? "doc" : "code"}-${path}`}
					color="ink"
					width={1.1}
					passes={doc ? 2 : 1}
					tolerance={0.35}
				/>
			</svg>
			<span className="truncate">{children ?? path}</span>
			<HandUnderline
				seed={`coderef-${path}`}
				color="pencil"
				width={1}
				coverage={0.97}
				opacity={0.55}
				offset={-3}
			/>
		</span>
	);
}
