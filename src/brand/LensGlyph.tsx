// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

/** A lens (circle) with one ridgeline stroke inside it. Inherits colour from the surrounding text. */
export function LensGlyph({
	size = 14,
	title,
	className,
}: {
	size?: number;
	title?: string;
	className?: string;
}) {
	return (
		// biome-ignore lint/a11y/noSvgWithoutTitle: the title is rendered conditionally; without one the glyph is aria-hidden
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.25}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={className}
			role={title ? "img" : undefined}
			aria-hidden={title ? undefined : true}
		>
			{title ? <title>{title}</title> : null}
			<circle cx="8" cy="8" r="6.75" />
			<polyline points="3.5,10.5 6,7 7.5,8.5 9.5,5.5 12.5,10.5" />
		</svg>
	);
}
