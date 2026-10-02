// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import { publicUrl } from "#/lib/public-url";
import { cn } from "#/lib/utils";

/** Bundled demo imagery (Niederhorn above Lake Thun). Names are stable; all paths live under public/demo. */
export const DEMO_IMAGES = {
	"demo-01": publicUrl("/demo/thumbs/demo-01.jpg"),
	"demo-02": publicUrl("/demo/thumbs/demo-02.jpg"),
	"demo-03": publicUrl("/demo/thumbs/demo-03.jpg"),
	"demo-04": publicUrl("/demo/thumbs/demo-04.jpg"),
	"demo-05": publicUrl("/demo/thumbs/demo-05.jpg"),
	hero: publicUrl("/demo/shots/hero.jpg"),
	drape: publicUrl("/demo/shots/drape.jpg"),
	overlay: publicUrl("/demo/shots/demo-01-overlay.jpg"),
} as const;
export type DemoName = keyof typeof DEMO_IMAGES;

/**
 * A demo photo or app screenshot, cover-cropped to `aspect` (CSS aspect-ratio, default 4/3). A pasted
 * print: square corners and never filtered.
 */
export function DemoImage({
	name,
	aspect = "4 / 3",
	alt = "",
	className,
}: {
	name: DemoName;
	aspect?: string;
	alt?: string;
	className?: string;
}) {
	return (
		<img
			src={DEMO_IMAGES[name]}
			alt={alt}
			loading="lazy"
			decoding="async"
			style={{ aspectRatio: aspect }}
			className={cn("w-full object-cover", className)}
		/>
	);
}
