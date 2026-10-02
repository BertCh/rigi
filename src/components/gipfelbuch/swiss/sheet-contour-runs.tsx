// Rigi
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: Copyright (c) Rigi contributors

import type { SheetContourKey, SheetData } from "./useSheet";

/** Tanaka style per class: lit faces lighter and thinner, shaded faces darker and thicker (px, non-scaling). */
const STYLE: Record<
	SheetContourKey,
	{ width: number; opacity: number; rock: boolean }
> = {
	m0: { width: 0.4, opacity: 0.32, rock: false },
	m1: { width: 0.55, opacity: 0.52, rock: false },
	m2: { width: 0.8, opacity: 0.78, rock: false },
	i0: { width: 0.8, opacity: 0.55, rock: false },
	i1: { width: 1.1, opacity: 0.78, rock: false },
	i2: { width: 1.5, opacity: 0.95, rock: false },
	r0: { width: 0.8, opacity: 0.6, rock: true },
	r1: { width: 1.1, opacity: 0.8, rock: true },
	r2: { width: 1.5, opacity: 0.95, rock: true },
};
const ORDER = Object.keys(STYLE) as SheetContourKey[];

/**
 * Contours as nine merged paths: brown on earth, ink black in rock (LK), lit/middle/shaded widths and tones from the
 * baked aspect classes. `weight` scales the widths for quiet backgrounds.
 */
export function SheetContourRuns({
	sheet,
	weight = 1,
}: {
	sheet: SheetData;
	weight?: number;
}) {
	return (
		<g fill="none" strokeLinejoin="round" strokeLinecap="round">
			{ORDER.map((key) => {
				const s = STYLE[key];
				const d = sheet.contours.runs[key];
				if (!d) return null;
				return (
					<path
						key={key}
						d={d}
						stroke={s.rock ? "var(--gb-ink)" : "var(--gb-contour)"}
						strokeWidth={s.width * weight}
						opacity={s.opacity}
						vectorEffect="non-scaling-stroke"
					/>
				);
			})}
		</g>
	);
}
